import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Mode, Pin, Stats } from '../types'

/** The effort the main loop runs at in each mode. */
const EFFORT: Record<Mode, 'low' | 'high'> = { chat: 'low', impl: 'high' }

/** The classifier: a small fast model, bounded by the clock. */
const CLASSIFIER_MODEL = 'haiku'
const CLASSIFIER_TIMEOUT_MS = 2500

// A new session starts in `impl`, so a classifier that never answers leaves
// the main loop at high effort rather than low.
const INITIAL_MODE: Mode = 'impl'
const NO_STATS: Stats = { samples: [], timeouts: 0, failures: 0, skipped: 0 }

const modeAtom = atom({ plugin: 'effort-router', key: 'mode' } as const, INITIAL_MODE)
const pinAtom = atom({ plugin: 'effort-router', key: 'pin' } as const, 'auto' as Pin)
const statsAtom = atom({ plugin: 'effort-router', key: 'stats' } as const, NO_STATS)

const CLASSIFIER_SYSTEM = `You route messages in a coding assistant session. Decide which mode the user's new message calls for.

impl: the user wants code or files changed now. They ask to implement, fix, refactor, add, write, build or apply something, to continue or adjust a change in progress, or they approve a change the assistant just offered to make.

chat: everything else. Questions, explanations, comparisons, brainstorming, planning without asking for the change to be made, looking at results.

A short follow-up that does not clearly change the kind of work keeps the current mode. An approval ("ok", "go ahead", "vas-y") takes the mode of what the assistant just offered: impl if it offered to make a change, otherwise the current mode.

The message may be in French or English. Answer with one word: impl or chat.`

const IMPL_NOTE = `[effort-router] This message was routed as implementation work. You are the orchestrator, running at high effort: analyse the request, read the code involved, and settle a short plan. Then delegate the code changes to the \`effort-router:implementer\` agent (Opus 5.5, high effort by default), which costs less per task than this model. Pass effort "xhigh" on the Agent call for a hard change and "medium" for a mechanical one, and run independent parts as parallel agents. The implementer starts with no context, so its brief carries the goal, the files and constraints, and how to verify. Afterwards review the diff yourself and run the checks before reporting. A change of a few lines that you have already located is quicker to make yourself.`

/** An approval or a nudge with no content of its own. */
const ACK =
  /^(ok(ay)?|oui|yes|yep|go|vas[- ]y|allons[- ]y|continue[zr]?|d'accord|parfait|merci|top|nickel|ça marche|c'est bon|go ahead|do it|fais[- ]le|lgtm)[\s.,!]*$/i

const clip = (text: string, head: number, tail: number): string =>
  text.length <= head + tail
    ? text
    : `${text.slice(0, head)}\n[...]\n${text.slice(-tail)}`

const quantile = (sorted: readonly number[], q: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0

const label = (mode: Mode, pin: Pin): string =>
  `route: ${mode} · ${EFFORT[mode]}${pin === 'auto' ? '' : ' (pinned)'}`

const report = (mode: Mode, pin: Pin, stats: Stats): string => {
  const sorted = [...stats.samples].sort((a, b) => a - b)
  const timing =
    sorted.length === 0
      ? 'no classifier call yet'
      : `${sorted.length} classifier calls: median ${quantile(sorted, 0.5)} ms, ` +
        `p90 ${quantile(sorted, 0.9)} ms, max ${sorted.at(-1)} ms`

  return [
    `Mode: ${mode} (main loop at ${EFFORT[mode]} effort), ${pin === 'auto' ? 'chosen per message' : 'pinned'}.`,
    `${timing}; ${stats.timeouts} timed out, ${stats.failures} failed, ${stats.skipped} messages routed without a call.`,
    'Usage: /route auto | chat | impl',
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'route',
      description: 'Show or pin the effort-router mode (chat or impl)',
      argumentHint: '[auto|chat|impl]',
    })
    $.ui.status(label(await read($, modeAtom), await read($, pinAtom)))

    return next(e)
  })

  on('command.run', { command: 'route' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()

    if (arg === 'auto' || arg === 'chat' || arg === 'impl') {
      await update($, pinAtom, () => arg)

      if (arg !== 'auto') {
        await update($, modeAtom, () => arg)
      }
    }

    const mode = await read($, modeAtom)
    const pin = await read($, pinAtom)
    $.ui.status(label(mode, pin))

    return { text: report(mode, pin, await read($, statsAtom)) }
  })

  on('prompt.submit', async ($, e, next) => {
    const from = e.origin?.kind
    const isFromPerson =
      from === 'composer' || from === 'bridge' || from === 'sdk'
    const text = e.text.trim()

    // A slash command, a notification or an empty prompt keeps the mode in
    // force and gets no note: it is not the person stating new work.
    if (!isFromPerson || e.command !== undefined || e.isMeta || text === '') {
      return next(e)
    }

    const current = await read($, modeAtom)
    const pin = await read($, pinAtom)
    let mode: Mode = current

    if (pin !== 'auto') {
      mode = pin
      await update($, statsAtom, s => ({ ...s, skipped: s.skipped + 1 }))
    } else if (current === 'impl' && ACK.test(text)) {
      // Staying in impl on a bare approval errs towards the higher effort.
      await update($, statsAtom, s => ({ ...s, skipped: s.skipped + 1 }))
    } else {
      const history = await $.session.messages()
      const lastAnswer = Array.isArray(history)
        ? history.findLast(m => m.role === 'assistant' && m.text !== '')
        : undefined
      const startedAt = await $.clock.now()
      const reply = await $.model.complete({
        model: CLASSIFIER_MODEL,
        system: CLASSIFIER_SYSTEM,
        prompt: [
          `<current_mode>${current}</current_mode>`,
          `<assistant_last_words>${lastAnswer ? lastAnswer.text.slice(-600) : ''}</assistant_last_words>`,
          `<new_message>${clip(text, 1500, 500)}</new_message>`,
        ].join('\n'),
        effort: 'low',
        maxTokens: 512,
        timeoutMs: CLASSIFIER_TIMEOUT_MS,
      })
      const elapsed = Math.round((await $.clock.now()) - startedAt)
      const word = reply.isAnswered ? reply.text.trim().toLowerCase() : ''
      const named: Mode | undefined = word.startsWith('impl')
        ? 'impl'
        : word.startsWith('chat')
          ? 'chat'
          : undefined

      if (named !== undefined) {
        mode = named
        await update($, statsAtom, s => ({
          ...s,
          samples: [...s.samples, elapsed].slice(-200),
        }))
      } else if (!reply.isAnswered && reply.reason === 'aborted') {
        await update($, statsAtom, s => ({ ...s, timeouts: s.timeouts + 1 }))
      } else {
        await update($, statsAtom, s => ({ ...s, failures: s.failures + 1 }))
      }
    }

    if (mode !== current) {
      await update($, modeAtom, () => mode)
    }

    $.ui.status(label(mode, pin))

    return mode === 'impl'
      ? next({ ...e, context: [...(e.context ?? []), IMPL_NOTE] })
      : next(e)
  })

  // Each request of the main loop on a Fable model runs at the mode's effort.
  // A subagent's loop keeps its own, any other model its session level, and a
  // level raised past high (ultrathink, /effort xhigh) is left alone.
  on('turn.step', async function* ($, e, next) {
    const isRouted =
      e.agentId === undefined &&
      e.model.includes('fable') &&
      (e.effort === 'low' || e.effort === 'medium' || e.effort === 'high')

    if (!isRouted) {
      return yield* next(e)
    }

    const effort = EFFORT[await read($, modeAtom)]

    return yield* next(effort === e.effort ? e : { ...e, effort })
  })
}
