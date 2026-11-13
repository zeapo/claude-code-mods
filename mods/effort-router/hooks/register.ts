import { atom, read, update } from 'claude-code'
import type { PluginOptions, Register } from 'claude-code'

import type { Mode, Pin, Stats } from '../types'

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
type Effort = (typeof EFFORTS)[number]

/** What a mode asks of the main loop. An empty model keeps the session's. */
type Route = { effort: Effort; model: string }

/** The manifest's `userConfig` values, read once per load. */
type Settings = {
  routes: Record<Mode, Route>
  /** Only a session whose model id contains this is routed; empty: all. */
  routedModel: string
  classifierModel: string
  classifierTimeoutMs: number
  /** Whether an implementation message is handed to the implementer agent. */
  delegate: boolean
  implementer: Route
}

const textOf = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback

const effortOf = (value: unknown, fallback: Effort): Effort =>
  EFFORTS.find(level => level === value) ?? fallback

// The engine fills in the manifest's defaults; the fallbacks here repeat them
// for a value it let through that the mod cannot use (a blank model name).
const settingsOf = (options: PluginOptions): Settings => {
  const timeout = options.classifier_timeout_ms

  return {
    routes: {
      chat: {
        effort: effortOf(options.chat_effort, 'low'),
        model: textOf(options.chat_model, ''),
      },
      impl: {
        effort: effortOf(options.impl_effort, 'high'),
        model: textOf(options.impl_model, ''),
      },
    },
    routedModel: textOf(options.routed_model, ''),
    classifierModel: textOf(options.classifier_model, 'haiku'),
    classifierTimeoutMs:
      typeof timeout === 'number' && timeout > 0 ? timeout : 2500,
    delegate: options.delegate !== false,
    implementer: {
      effort: effortOf(options.implementer_effort, 'high'),
      model: textOf(options.implementer_model, 'opus'),
    },
  }
}

// A new session starts in `impl`, so a classifier that never answers leaves
// the main loop at the implementation effort rather than the chat one.
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

const IMPLEMENTER_PROMPT = `You implement a code change that another agent has already analysed and planned. That agent sees only your final message, so it has to stand on its own.

Work from the brief you were given. Read the code you are about to change and the code around it before editing, and follow the conventions already in the repository. Keep the change to what the brief asks for: no extra refactors, features, or files beyond it.

If the brief conflicts with what you find in the code, or the plan cannot work as written, stop and report what you found instead of improvising a different design. The planner has context you do not, and a wrong guess costs more than a question.

Verify before you report: run the tests, type-check, or build step that covers the change, and read the output. If you could not verify something, say so.

End with a short report: what you changed (files and the gist of each edit), what you ran and its result, and anything left undone or uncertain. State failures plainly, with the relevant output.`

const implementerDescription = ({ model, effort }: Route): string =>
  `Implements a planned code change. Use for every code or file modification once the plan is clear; give it the goal, the files and constraints, and how to verify. Runs on ${model} at ${effort} effort; pass effort xhigh for a hard change and medium for a mechanical one.`

const implNote = (main: Route, { model, effort }: Route): string =>
  `[effort-router] This message was routed as implementation work. You are the orchestrator, running at ${main.effort} effort: analyse the request, read the code involved, and settle a short plan. Then delegate the code changes to the \`effort-router:implementer\` agent (model ${model}, ${effort} effort by default). Pass effort "xhigh" on the Agent call for a hard change and "medium" for a mechanical one, and run independent parts as parallel agents. The implementer starts with no context, so its brief carries the goal, the files and constraints, and how to verify. Afterwards review the diff yourself and run the checks before reporting. A change of a few lines that you have already located is quicker to make yourself.`

/** An approval or a nudge with no content of its own. */
const ACK =
  /^(ok(ay)?|oui|yes|yep|go|vas[- ]y|allons[- ]y|continue[zr]?|d'accord|parfait|merci|top|nickel|ça marche|c'est bon|go ahead|do it|fais[- ]le|lgtm)[\s.,!]*$/i

const clip = (text: string, head: number, tail: number): string =>
  text.length <= head + tail
    ? text
    : `${text.slice(0, head)}\n[...]\n${text.slice(-tail)}`

const quantile = (sorted: readonly number[], q: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0

const label = (mode: Mode, pin: Pin, { model, effort }: Route): string =>
  `route: ${mode} · ${model === '' ? '' : `${model} · `}${effort}${pin === 'auto' ? '' : ' (pinned)'}`

const describe = ({ model, effort }: Route): string =>
  `${model === '' ? '' : `on ${model} `}at ${effort} effort`

const report = (mode: Mode, pin: Pin, stats: Stats, settings: Settings): string => {
  const sorted = [...stats.samples].sort((a, b) => a - b)
  const timing =
    sorted.length === 0
      ? 'no classifier call yet'
      : `${sorted.length} classifier calls: median ${quantile(sorted, 0.5)} ms, ` +
        `p90 ${quantile(sorted, 0.9)} ms, max ${sorted.at(-1)} ms`
  const { routes, implementer } = settings

  return [
    `Mode: ${mode} (main loop ${describe(routes[mode])}), ${pin === 'auto' ? 'chosen per message' : 'pinned'}.`,
    `${timing}; ${stats.timeouts} timed out, ${stats.failures} failed, ${stats.skipped} messages routed without a call.`,
    `Settings: chat ${describe(routes.chat)}, impl ${describe(routes.impl)}; ` +
      `classifier ${settings.classifierModel} (${settings.classifierTimeoutMs} ms); ` +
      (settings.delegate
        ? `implementer ${describe(implementer)}`
        : 'no delegation') +
      `; routing ${settings.routedModel === '' ? 'every session model' : `session models matching "${settings.routedModel}"`}. Change them in /config.`,
    'Usage: /route auto | chat | impl',
  ].join('\n')
}

export const register: Register = (on, options) => {
  const settings = settingsOf(options)
  const { routes } = settings

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'route',
      description: 'Show or pin the effort-router mode (chat or impl)',
      argumentHint: '[auto|chat|impl]',
    })

    if (settings.delegate) {
      await $.agent.register({
        name: 'implementer',
        description: implementerDescription(settings.implementer),
        prompt: IMPLEMENTER_PROMPT,
        model: settings.implementer.model,
        effort: settings.implementer.effort,
      })
    }

    const mode = await read($, modeAtom)
    $.ui.status(label(mode, await read($, pinAtom), routes[mode]))

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
    $.ui.status(label(mode, pin, routes[mode]))

    return { text: report(mode, pin, await read($, statsAtom), settings) }
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
        model: settings.classifierModel,
        system: CLASSIFIER_SYSTEM,
        prompt: [
          `<current_mode>${current}</current_mode>`,
          `<assistant_last_words>${lastAnswer ? lastAnswer.text.slice(-600) : ''}</assistant_last_words>`,
          `<new_message>${clip(text, 1500, 500)}</new_message>`,
        ].join('\n'),
        effort: 'low',
        maxTokens: 512,
        timeoutMs: settings.classifierTimeoutMs,
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

    $.ui.status(label(mode, pin, routes[mode]))

    return mode === 'impl' && settings.delegate
      ? next({
          ...e,
          context: [
            ...(e.context ?? []),
            implNote(routes.impl, settings.implementer),
          ],
        })
      : next(e)
  })

  // Each request of the main loop on a routed session model runs with the
  // mode's model and effort. A subagent's loop keeps its own, and so does a
  // session on any other model. An effort the person raised past high
  // (ultrathink, /effort xhigh) is left alone, as is a model without effort.
  on('turn.step', async function* ($, e, next) {
    const isRouted =
      e.agentId === undefined && e.model.includes(settings.routedModel)

    if (!isRouted) {
      return yield* next(e)
    }

    const { model, effort } = routes[await read($, modeAtom)]
    const isEffortRouted =
      e.effort === 'low' || e.effort === 'medium' || e.effort === 'high'

    return yield* next({
      ...e,
      model: model === '' ? e.model : model,
      effort: isEffortRouted ? effort : e.effort,
    })
  })
}
