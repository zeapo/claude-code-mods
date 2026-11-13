import { expect, test } from 'claude-code/testing'

import type { TurnStepInput, TurnStepResult } from 'claude-code'

const STEP: TurnStepInput = {
  turnId: 't1',
  index: 0,
  model: 'claude-fable-5-2',
  effort: 'high',
  messageCount: 1,
}

// The fields the mod reads of a step's answer; the engine's has more.
const ANSWER = {
  turnId: 't1',
  index: 0,
  answer: '',
  toolUses: [],
} as unknown as TurnStepResult

// A test states only what the person types: the engine stamps the rest.
const route = (args?: string) => ({ command: 'route', args }) as never

// The engine stamps the origin of a prompt; a test states the person's Enter.
const typed = (text: string) =>
  ({ text, origin: { kind: 'composer' }, wait: false }) as never

// The band above the prompt, as the engine asks the mod to draw its row.
const BAND = {
  plugin: 'effort-router',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

// The surfaces the engine raises `AbovePrompt` on.
const BAND_SURFACES = ['terminal', 'desktop', 'mobile'] as const

// The parts of a mounted drawing these tests read.
type Found = { text: string; props: Record<string, unknown> }
type Drawing = {
  find: (query: { type: string; text?: RegExp }) => Promise<Found | undefined>
  findAll: (query: { type: string; text?: RegExp }) => Promise<Found[]>
}

// The band's row whole: its outermost Text holds every part.
const rowOf = async (ui: Drawing) => (await ui.find({ type: 'Text' }))?.text

// The innermost Text showing these words, with its own props.
const partOf = async (ui: Drawing, text: RegExp) =>
  (await ui.findAll({ type: 'Text', text })).at(-1)

const USAGE = {
  input_tokens: 1,
  output_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

test('the main loop on Fable runs at the mode effort', async ($, on) => {
  const sent: (TurnStepInput['effort'] | undefined)[] = []
  on('command.register', () => ({ value: { command: 'route' } }))
  on('agent.register', () => ({ value: { agent: 'effort-router:implementer' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // Stands for the engine: records the effort the request would go out with.
  on('turn.step', async function* (_, e) {
    sent.push(e.effort)

    return ANSWER
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // A new session starts in impl: a low request is raised to high.
  for await (const _ of $.turn.step({ ...STEP, effort: 'low' })) void _

  await $.command.run(route('chat'))
  for await (const _ of $.turn.step(STEP)) void _

  await $.command.run(route('impl'))
  for await (const _ of $.turn.step({ ...STEP, effort: 'low' })) void _

  expect(sent.slice(-3)).toEqual(['high', 'low', 'high'])
})

test('other loops, models and raised levels are left alone', async ($, on) => {
  const sent: (TurnStepInput['effort'] | undefined)[] = []
  on('command.register', () => ({ value: { command: 'route' } }))
  on('turn.step', async function* (_, e) {
    sent.push(e.effort)

    return ANSWER
  })

  await $.command.run(route('chat'))

  // A subagent's loop, an Opus session, and a level the person raised.
  for await (const _ of $.turn.step({ ...STEP, agentId: 'a1' })) void _
  for await (const _ of $.turn.step({ ...STEP, model: 'claude-opus-5-5' }))
    void _
  for await (const _ of $.turn.step({ ...STEP, effort: 'xhigh' })) void _

  expect(sent).toEqual(['high', 'high', 'xhigh'])
})

test('/route reports the mode and pins it', async ($, on) => {
  on('command.register', () => ({ value: { command: 'route' } }))

  const pinned = await $.command.run(route('chat'))
  expect(pinned.text).toContain('Mode: chat (main loop at low effort), pinned.')

  const auto = await $.command.run(route('auto'))
  expect(auto.text).toContain('Mode: chat (main loop at low effort), chosen per message.')
})

test('a message is classified and an implementation gets the note', async ($, on) => {
  const asked: string[] = []
  let entered: { text: string; context?: readonly string[]; kind?: string } | undefined
  on('command.register', () => ({ value: { command: 'route' } }))
  on('session.messages', () => ({ value: [] }))
  on('clock.now', () => ({ value: 1000 }))
  on('model.complete', (_, e) => {
    asked.push(e.prompt)

    return {
      value: {
        isAnswered: true,
        text: /refactor/.test(e.prompt) ? 'impl' : 'chat',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }
  })
  on('prompt.submit', (_, e) => {
    entered = { text: e.text, context: e.context, kind: e.origin?.kind }

    return { text: e.text, context: e.context }
  })

  await $.command.run(route('chat'))
  await $.command.run(route('auto'))

  await $.prompt.submit(typed('refactor the parser into two modules'))
  expect(entered?.kind).toBe('composer')
  expect(asked.length).toBe(1)
  expect(entered?.context?.[0]).toContain('effort-router:implementer')

  await $.prompt.submit(typed('why is the sky blue?'))
  expect(asked.length).toBe(2)
  expect(entered?.context).toBeUndefined()
})

test('a classifier that times out keeps the mode in force', async ($, on) => {
  let context: readonly string[] | undefined
  on('command.register', () => ({ value: { command: 'route' } }))
  on('session.messages', () => ({ value: [] }))
  on('clock.now', () => ({ value: 1000 }))
  on('model.complete', () => ({
    value: {
      isAnswered: false,
      reason: 'aborted',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  }))
  on('prompt.submit', (_, e) => {
    context = e.context

    return { text: e.text, context: e.context }
  })

  // A new session is in impl, and stays there when the classifier is cut.
  await $.prompt.submit(typed('what does this function do?'))
  expect(context?.[0]).toContain('effort-router:implementer')

  const shown = await $.command.run(route())
  expect(shown.text).toContain('1 timed out')
})

test('a bare approval in impl makes no classifier call', async ($, on) => {
  let calls = 0
  on('command.register', () => ({ value: { command: 'route' } }))
  on('model.complete', () => {
    calls += 1

    return { value: { isAnswered: false, reason: 'empty-reply' } as never }
  })
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))

  await $.prompt.submit(typed('ok vas-y'))
  await $.prompt.submit(typed('Continue.'))

  expect(calls).toBe(0)
})

test(
  'each mode runs with its configured effort and model',
  { options: { chat_effort: 'medium', chat_model: 'sonnet', impl_effort: 'xhigh' } },
  async ($, on) => {
    const sent: string[] = []
    on('command.register', () => ({ value: { command: 'route' } }))
    on('turn.step', async function* (_, e) {
      sent.push(`${e.model} ${e.effort}`)

      return ANSWER
    })

    const chat = await $.command.run(route('chat'))
    expect(chat.text).toContain('Mode: chat (main loop on sonnet at medium effort), pinned.')
    for await (const _ of $.turn.step(STEP)) void _

    // An empty impl model keeps the session's.
    await $.command.run(route('impl'))
    for await (const _ of $.turn.step(STEP)) void _

    // A level the person raised stays, and the mode's model still applies.
    await $.command.run(route('chat'))
    for await (const _ of $.turn.step({ ...STEP, effort: 'max' })) void _

    expect(sent).toEqual([
      'sonnet medium',
      'claude-fable-5-2 xhigh',
      'sonnet max',
    ])
  },
)

test(
  'an empty routed model routes every session model',
  { options: { routed_model: '' } },
  async ($, on) => {
    const sent: (TurnStepInput['effort'] | undefined)[] = []
    on('command.register', () => ({ value: { command: 'route' } }))
    on('turn.step', async function* (_, e) {
      sent.push(e.effort)

      return ANSWER
    })

    await $.command.run(route('chat'))
    for await (const _ of $.turn.step({ ...STEP, model: 'claude-opus-5-5' }))
      void _

    expect(sent).toEqual(['low'])
  },
)

test(
  'the implementer is registered with its configured model and effort',
  { options: { implementer_model: 'sonnet', implementer_effort: 'medium' } },
  async ($, on) => {
    const specs: { name: string; model?: string; effort?: string | number }[] = []
    let context: readonly string[] | undefined
    on('command.register', () => ({ value: { command: 'route' } }))
    on('agent.register', (_, e) => {
      specs.push({ name: e.name, model: e.model, effort: e.effort })

      return { value: { agent: `effort-router:${e.name}` } }
    })
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('prompt.submit', (_, e) => {
      context = e.context

      return { text: e.text, context: e.context }
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    expect(specs).toEqual([{ name: 'implementer', model: 'sonnet', effort: 'medium' }])

    await $.command.run(route('impl'))
    await $.prompt.submit(typed('add a retry to the fetch'))
    expect(context?.[0]).toContain('(model sonnet, medium effort by default)')
  },
)

test(
  'with delegation off, no agent is registered and no note is added',
  { options: { delegate: false } },
  async ($, on) => {
    let registered = 0
    let context: readonly string[] | undefined
    on('command.register', () => ({ value: { command: 'route' } }))
    on('agent.register', () => {
      registered += 1

      return { value: { agent: 'effort-router:implementer' } }
    })
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('prompt.submit', (_, e) => {
      context = e.context

      return { text: e.text, context: e.context }
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.command.run(route('impl'))
    await $.prompt.submit(typed('add a retry to the fetch'))

    expect(registered).toBe(0)
    expect(context).toBeUndefined()
  },
)

test('the band shows the mode and how haiku routed the message, on every surface', async ($, on) => {
  let now = 0
  on('command.register', () => ({ value: { command: 'route' } }))
  on('session.messages', () => ({ value: [] }))
  // Each read is 1840 ms after the one before: the call took 1840 ms.
  on('clock.now', () => ({ value: (now += 1840) }))
  // Markup around the word is read past.
  on('model.complete', () => ({
    value: { isAnswered: true, text: '**chat** 0.92', usage: USAGE },
  }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))

  // Before any message: the initial mode, nothing routed yet.
  const before = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await rowOf(before)).toBe('● impl · high')

  await $.prompt.submit(typed('pourquoi il y a une icone d’alerte ?'))

  // The write redrew the row already on screen.
  expect(await rowOf(before)).toBe('● chat · low · haiku: chat 0.92 in 1840 ms')
  await before.unmount()

  for (const surface of BAND_SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await rowOf(ui)).toBe('● chat · low · haiku: chat 0.92 in 1840 ms')
    const mode = await partOf(ui, /● chat/)
    expect(mode?.props).toMatchObject({ color: 'planMode', weight: 'bold' })
    expect((await partOf(ui, /haiku/))?.props.dimColor).toBe(true)
    await ui.unmount()
  }

  const shown = await $.command.run(route())
  expect(shown.text).toContain('Last message: haiku: chat 0.92 in 1840 ms.')
})

test('a timeout is recorded, and the band and /route say so', async ($, on) => {
  let now = 0
  const written: unknown[] = []
  on('command.register', () => ({ value: { command: 'route' } }))
  on('state.set', (_, e, next) => {
    if (e.key === 'last') {
      written.push(e.value)
    }

    return next(e)
  })
  on('session.messages', () => ({ value: [] }))
  on('clock.now', () => ({ value: (now += 6000) }))
  on('model.complete', () => ({
    value: { isAnswered: false, reason: 'aborted', usage: USAGE },
  }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))

  await $.prompt.submit(typed('je viens d’installer effort-router, peux tu vérifier ?'))

  expect(written).toEqual([
    { shape: 'last-2', value: { how: 'timeout', ms: 6000, kept: 'impl' } },
  ])

  for (const surface of BAND_SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await rowOf(ui)).toBe(
      '● impl · high · classifier timed out (6000 ms), kept impl',
    )
    const last = await partOf(ui, /timed out/)
    expect(last?.text).toBe('classifier timed out (6000 ms), kept impl')
    // The mode was not decided: the words stand out from the dim ones.
    expect(last?.props.color).toBe('warning')
    expect(last?.props.dimColor).toBeUndefined()
    await ui.unmount()
  }

  const shown = await $.command.run(route())
  expect(shown.text).toContain('1 timed out')
  expect(shown.text).toContain('Last message: classifier timed out (6000 ms), kept impl.')
})

test('a failed call names what went wrong', async ($, on) => {
  const replies = [
    { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE },
    { isAnswered: false, reason: 'empty-reply', usage: USAGE },
    { isAnswered: true, text: 'This message asks a question about the mod.', usage: USAGE },
  ]
  const seen: string[] = []
  on('command.register', () => ({ value: { command: 'route' } }))
  on('session.messages', () => ({ value: [] }))
  on('clock.now', () => ({ value: 1000 }))
  on('model.complete', () => ({ value: replies.shift() as never }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))

  for (const text of ['one', 'two', 'three']) {
    await $.prompt.submit(typed(text))
    seen.push((await $.command.run(route())).text?.split('\n')[2] ?? '')
  }

  expect(seen).toEqual([
    'Last message: classifier failed: api-error 529 overloaded, kept impl.',
    'Last message: classifier failed: empty-reply, kept impl.',
    'Last message: classifier failed: unreadable answer "This message asks a question about the m", kept impl.',
  ])
})

test('the band yields to a survey', async ($, on) => {
  on('command.register', () => ({ value: { command: 'route' } }))

  const ui = await $.ui.mount({
    ...BAND,
    surface: 'terminal',
    props: { ...BAND.props, hasSurvey: true },
  })

  expect(await ui.keepsBeneath()).toBe(true)
  expect(await ui.find({ type: 'Text', text: /impl/ })).toBeUndefined()
  await ui.unmount()
})

test('a pinned mode says so once', async ($, on) => {
  on('command.register', () => ({ value: { command: 'route' } }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))

  await $.command.run(route('chat'))
  await $.prompt.submit(typed('explain the parser'))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await rowOf(ui)).toBe('● chat · low (pinned)')

  // The pin lifted, the band still says how that message was routed.
  await $.command.run(route('auto'))
  expect(await rowOf(ui)).toBe('● chat · low · pinned')
  await ui.unmount()
})

test('a last message an earlier version stored is declined', async ($, on) => {
  // What the version before the confidence wrote stays through the reload,
  // under its tag: a classifier record with no confidence.
  on('state.get', ($, e, next) =>
    e.key === 'last'
      ? {
          value: {
            value: { shape: 'last-1', value: { how: 'classifier', mode: 'chat', ms: 1840 } },
            version: 1,
          },
        }
      : next(e),
  )

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await rowOf(ui)).toBe('● impl · high')
  await ui.unmount()
})

test('a confident answer switches the mode and shows its confidence', async ($, on) => {
  let context: readonly string[] | undefined
  on('command.register', () => ({ value: { command: 'route' } }))
  on('session.messages', () => ({ value: [] }))
  on('clock.now', () => ({ value: 1000 }))
  on('model.complete', () => ({
    value: { isAnswered: true, text: 'impl 0.8', usage: USAGE },
  }))
  on('prompt.submit', (_, e) => {
    context = e.context

    return { text: e.text, context: e.context }
  })

  await $.command.run(route('chat'))
  await $.command.run(route('auto'))
  await $.prompt.submit(typed('add a retry to the fetch'))

  expect(context?.[0]).toContain('effort-router:implementer')
  const shown = await $.command.run(route())
  expect(shown.text).toContain('Mode: impl (main loop at high effort), chosen per message.')
  expect(shown.text).toContain('Last message: haiku: impl 0.80 in 0 ms.')
  expect(shown.text).toContain('0 unsure')
})

test('an answer below the minimum confidence keeps the mode in force', async ($, on) => {
  let now = 0
  let context: readonly string[] | undefined
  const written: unknown[] = []
  on('command.register', () => ({ value: { command: 'route' } }))
  on('state.set', (_, e, next) => {
    if (e.key === 'last') {
      written.push(e.value)
    }

    return next(e)
  })
  on('session.messages', () => ({ value: [] }))
  on('clock.now', () => ({ value: (now += 1840) }))
  on('model.complete', () => ({
    value: { isAnswered: true, text: 'chat 0.55', usage: USAGE },
  }))
  on('prompt.submit', (_, e) => {
    context = e.context

    return { text: e.text, context: e.context }
  })

  // A new session is in impl, and stays there on an unsure chat.
  await $.prompt.submit(typed('et si on regardait le parser ?'))

  expect(context?.[0]).toContain('effort-router:implementer')
  expect(written).toEqual([
    {
      shape: 'last-2',
      value: { how: 'unsure', mode: 'chat', confidence: 0.55, ms: 1840, kept: 'impl' },
    },
  ])

  for (const surface of BAND_SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await rowOf(ui)).toBe(
      '● impl · high · haiku unsure: chat 0.55 < 0.6, kept impl',
    )
    const last = await partOf(ui, /unsure/)
    expect(last?.text).toBe('haiku unsure: chat 0.55 < 0.6, kept impl')
    // The mode was not decided: the words stand out from the dim ones.
    expect(last?.props.color).toBe('warning')
    expect(last?.props.dimColor).toBeUndefined()
    await ui.unmount()
  }

  const shown = await $.command.run(route())
  expect(shown.text).toContain('Mode: impl (main loop at high effort), chosen per message.')
  // The call answered in time: its duration counts with the others.
  expect(shown.text).toContain('1 classifier calls: median 1840 ms')
  expect(shown.text).toContain('0 failed, 1 unsure,')
  expect(shown.text).toContain('Last message: haiku unsure: chat 0.55 < 0.6, kept impl.')
  expect(shown.text).toContain('classifier haiku (6000 ms, minimum confidence 0.6)')
})

test('a one-word answer with no confidence still routes', async ($, on) => {
  on('command.register', () => ({ value: { command: 'route' } }))
  on('session.messages', () => ({ value: [] }))
  on('clock.now', () => ({ value: 1000 }))
  on('model.complete', () => ({
    value: { isAnswered: true, text: 'chat', usage: USAGE },
  }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))

  await $.prompt.submit(typed('why is the sky blue?'))

  const shown = await $.command.run(route())
  expect(shown.text).toContain('Mode: chat (main loop at low effort), chosen per message.')
  expect(shown.text).toContain('Last message: haiku: chat 1.00 in 0 ms.')
})

test(
  'a minimum confidence of 0 accepts every answer',
  { options: { classifier_min_confidence: 0 } },
  async ($, on) => {
    on('command.register', () => ({ value: { command: 'route' } }))
    on('session.messages', () => ({ value: [] }))
    on('clock.now', () => ({ value: 1000 }))
    on('model.complete', () => ({
      value: { isAnswered: true, text: 'chat 0.1', usage: USAGE },
    }))
    on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))

    await $.prompt.submit(typed('hmm, the parser'))

    const shown = await $.command.run(route())
    expect(shown.text).toContain('Mode: chat (main loop at low effort), chosen per message.')
    expect(shown.text).toContain('Last message: haiku: chat 0.10 in 0 ms.')
    expect(shown.text).toContain('(6000 ms, minimum confidence 0)')
  },
)

test('a confidence is read with a comma, a leading point or as a percentage', async ($, on) => {
  const replies = ['`chat` 0,9', 'impl: 90%', 'chat .9', '**impl** (confidence 1)']
  const seen: (string | undefined)[] = []
  on('command.register', () => ({ value: { command: 'route' } }))
  on('session.messages', () => ({ value: [] }))
  on('clock.now', () => ({ value: 1000 }))
  on('model.complete', () => ({
    value: { isAnswered: true, text: replies.shift() ?? '', usage: USAGE },
  }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))

  for (const text of ['one', 'two', 'three', 'four']) {
    await $.prompt.submit(typed(text))
    seen.push((await $.command.run(route())).text?.split('\n')[2])
  }

  expect(seen).toEqual([
    'Last message: haiku: chat 0.90 in 0 ms.',
    'Last message: haiku: impl 0.90 in 0 ms.',
    'Last message: haiku: chat 0.90 in 0 ms.',
    'Last message: haiku: impl 1.00 in 0 ms.',
  ])
})
