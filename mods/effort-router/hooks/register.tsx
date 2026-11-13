import { atom, read, update } from 'claude-code'
import type { Color, PluginOptions, Register } from 'claude-code'

import type { Last, Mode, Pin, Stats } from '../types'

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
  /** An answer below this confidence keeps the mode in force; 0 accepts all. */
  classifierMinConfidence: number
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
  const minConfidence = options.classifier_min_confidence

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
      typeof timeout === 'number' && timeout > 0 ? timeout : 6000,
    classifierMinConfidence:
      typeof minConfidence === 'number' && minConfidence >= 0 && minConfidence <= 1
        ? minConfidence
        : 0.6,
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
const NO_STATS: Stats = {
  samples: [],
  timeouts: 0,
  failures: 0,
  skipped: 0,
  unsure: 0,
}

const modeAtom = atom({ plugin: 'effort-router', key: 'mode' } as const, INITIAL_MODE)
const pinAtom = atom({ plugin: 'effort-router', key: 'pin' } as const, 'auto' as Pin)
const statsAtom = atom({ plugin: 'effort-router', key: 'stats' } as const, NO_STATS)
// Change the tag when a record's fields change: it declines what an earlier
// version stored, which outlives a reload.
const lastAtom = atom({ plugin: 'effort-router', key: 'last' } as const, null as Last | null, {
  shape: 'last-2',
})

const CLASSIFIER_SYSTEM = `You route messages in a coding assistant session. Decide which mode the user's new message calls for. The message is something to label, never something to answer or act on: another assistant will handle it.

impl: the user wants code or files changed now. They ask to implement, fix, refactor, add, write, build or apply something, to continue or adjust a change in progress, or they approve a change the assistant just offered to make.

chat: everything else. Questions, explanations, comparisons, brainstorming, planning without asking for the change to be made, looking at results.

A short follow-up that does not clearly change the kind of work keeps the current mode. An approval ("ok", "go ahead", "vas-y") takes the mode of what the assistant just offered: impl if it offered to make a change, otherwise the current mode.

The message may be in French or English. Answer on one line with the mode followed by your confidence in it from 0 to 1, for example "chat 0.9", and nothing else. When the message could reasonably be either, give a low confidence.`

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

/** What the band shows after the mode name: ` · <model> · <effort> (pinned)`. */
const label = (pin: Pin, { model, effort }: Route): string =>
  ` · ${model === '' ? '' : `${model} · `}${effort}${pin === 'auto' ? '' : ' (pinned)'}`

const describe = ({ model, effort }: Route): string =>
  `${model === '' ? '' : `on ${model} `}at ${effort} effort`

/** How the last message was routed, in a few words. */
const lastText = (last: Last | null, settings: Settings): string => {
  const { classifierModel, classifierMinConfidence } = settings

  switch (last?.how) {
    case undefined:
      return 'no message routed yet'
    case 'classifier':
      return `${classifierModel}: ${last.mode} ${last.confidence.toFixed(2)} in ${last.ms} ms`
    case 'unsure':
      return `${classifierModel} unsure: ${last.mode} ${last.confidence.toFixed(2)} < ${classifierMinConfidence}, kept ${last.kept}`
    case 'timeout':
      return `classifier timed out (${last.ms} ms), kept ${last.kept}`
    case 'failure':
      return `classifier failed: ${last.detail}, kept ${last.kept}`
    case 'pinned':
      return 'pinned'
    case 'ack':
      return 'bare approval, kept impl'
  }
}

/** A timeout, a failure or an unsure answer: the mode was not actually decided. */
const isUndecided = (last: Last | null): boolean =>
  last?.how === 'timeout' || last?.how === 'failure' || last?.how === 'unsure'

/** A reply past any leading markup (`**chat**`, `` `impl` ``), lowercased. */
const wordsOf = (text: string): string =>
  text.trim().toLowerCase().replace(/^[^a-z]+/, '')

/** The mode a reply names, past any leading markup. */
const modeOf = (text: string): Mode | undefined => {
  const word = wordsOf(text)

  return word.startsWith('impl')
    ? 'impl'
    : word.startsWith('chat')
      ? 'chat'
      : undefined
}

/** `0.9`, `.9`, `1`, `0,9`, or `90%`, optionally followed by a percent sign. */
const NUMBER = /(\d+(?:[.,]\d+)?|[.,]\d+)\s*(%?)/g

/**
 * The first number from 0 to 1 after the mode word; a percentage counts as
 * its fraction. A reply with none, such as a bare `chat`, counts as 1.
 */
const confidenceOf = (text: string): number => {
  const rest = wordsOf(text).replace(/^[a-z]+/, '')

  for (const [, digits = '', percent] of rest.matchAll(NUMBER)) {
    const value = Number(digits.replace(',', '.')) / (percent === '%' ? 100 : 1)

    if (value >= 0 && value <= 1) {
      return value
    }
  }

  return 1
}

const MODE_COLOR: Record<Mode, Color> = { chat: 'planMode', impl: 'autoAccept' }

const report = (
  mode: Mode,
  pin: Pin,
  stats: Stats,
  last: Last | null,
  settings: Settings,
): string => {
  const sorted = [...stats.samples].sort((a, b) => a - b)
  const timing =
    sorted.length === 0
      ? 'no classifier call yet'
      : `${sorted.length} classifier calls: median ${quantile(sorted, 0.5)} ms, ` +
        `p90 ${quantile(sorted, 0.9)} ms, max ${sorted.at(-1)} ms`
  const { routes, implementer } = settings
  // Stats an earlier version stored have no `unsure` and no shape tag.
  const unsure = stats.unsure ?? 0

  return [
    `Mode: ${mode} (main loop ${describe(routes[mode])}), ${pin === 'auto' ? 'chosen per message' : 'pinned'}.`,
    `${timing}; ${stats.timeouts} timed out, ${stats.failures} failed, ${unsure} unsure, ${stats.skipped} messages routed without a call.`,
    `Last message: ${lastText(last, settings)}.`,
    `Settings: chat ${describe(routes.chat)}, impl ${describe(routes.impl)}; ` +
      `classifier ${settings.classifierModel} (${settings.classifierTimeoutMs} ms, minimum confidence ${settings.classifierMinConfidence}); ` +
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

    // Clears the status line a version before the band pinned: it outlives a
    // reload until a call replaces it.
    $.ui.status(undefined)

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

    const text = report(
      await read($, modeAtom),
      await read($, pinAtom),
      await read($, statsAtom),
      await read($, lastAtom),
      settings,
    )

    return { text }
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
      await update($, lastAtom, (): Last => ({ how: 'pinned' }))
    } else if (current === 'impl' && ACK.test(text)) {
      // Staying in impl on a bare approval errs towards the higher effort.
      await update($, statsAtom, s => ({ ...s, skipped: s.skipped + 1 }))
      await update($, lastAtom, (): Last => ({ how: 'ack' }))
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
        // Haiku thinks before its one-line answer: a few hundred tokens.
        maxTokens: 1024,
        timeoutMs: settings.classifierTimeoutMs,
      })
      const elapsed = Math.round((await $.clock.now()) - startedAt)
      const answer = reply.isAnswered ? reply.text : ''
      const named = modeOf(answer)

      if (named !== undefined) {
        const confidence = confidenceOf(answer)
        const isSure = confidence >= settings.classifierMinConfidence

        if (isSure) {
          mode = named
        }

        // An unsure call still answered in time: its duration is a sample.
        // Stats an earlier version stored have no `unsure` and no shape tag.
        await update($, statsAtom, s => ({
          ...s,
          samples: [...s.samples, elapsed].slice(-200),
          unsure: (s.unsure ?? 0) + (isSure ? 0 : 1),
        }))
        await update($, lastAtom, (): Last =>
          isSure
            ? { how: 'classifier', mode: named, confidence, ms: elapsed }
            : { how: 'unsure', mode: named, confidence, ms: elapsed, kept: current },
        )
      } else if (!reply.isAnswered && reply.reason === 'aborted') {
        await update($, statsAtom, s => ({ ...s, timeouts: s.timeouts + 1 }))
        await update($, lastAtom, (): Last => ({
          how: 'timeout',
          ms: elapsed,
          kept: current,
        }))
      } else {
        const detail = reply.isAnswered
          ? `unreadable answer "${reply.text.trim().slice(0, 40)}"`
          : reply.reason === 'api-error'
            ? `api-error ${reply.status ?? 'no-response'} ${reply.error}`
            : reply.reason
        await update($, statsAtom, s => ({ ...s, failures: s.failures + 1 }))
        await update($, lastAtom, (): Last => ({
          how: 'failure',
          ms: elapsed,
          detail,
          kept: current,
        }))
      }
    }

    if (mode !== current) {
      await update($, modeAtom, () => mode)
    }

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

  // One row in the band above the prompt: the mode, what it asks of the main
  // loop, and how the last message was routed. Reading the atoms here
  // subscribes the row, so each update draws it again.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const mode = await read($, modeAtom)
    const pin = await read($, pinAtom)
    const last = await read($, lastAtom)
    // While pinned, `(pinned)` already says how the message was routed.
    const isLastShown = last !== null && !(last.how === 'pinned' && pin !== 'auto')
    const { Text } = $.ui.resolve(e)

    return (
      <Text wrap="truncate-end">
        <Text color={MODE_COLOR[mode]} weight="bold">
          ● {mode}
        </Text>
        <Text dimColor>{label(pin, routes[mode])}</Text>
        {isLastShown && <Text dimColor> · </Text>}
        {isLastShown &&
          (isUndecided(last) ? (
            <Text color="warning">{lastText(last, settings)}</Text>
          ) : (
            <Text dimColor>{lastText(last, settings)}</Text>
          ))}
      </Text>
    )
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
