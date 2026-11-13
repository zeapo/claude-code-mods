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
  on('session.model', () => ({ value: 'claude-fable-5-2' }))
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
  on('session.model', () => ({ value: 'claude-fable-5-2' }))
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
  on('session.model', () => ({ value: 'claude-fable-5-2' }))

  const pinned = await $.command.run(route('chat'))
  expect(pinned.text).toContain('Mode: chat (main loop at low effort), pinned.')

  const auto = await $.command.run(route('auto'))
  expect(auto.text).toContain('Mode: chat (main loop at low effort), chosen per message.')
})

test('a message is classified and an implementation gets the note', async ($, on) => {
  const asked: string[] = []
  let entered: { text: string; context?: readonly string[]; kind?: string } | undefined
  on('command.register', () => ({ value: { command: 'route' } }))
  on('session.model', () => ({ value: 'claude-fable-5-2' }))
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
  on('session.model', () => ({ value: 'claude-fable-5-2' }))
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
  on('session.model', () => ({ value: 'claude-fable-5-2' }))
  on('model.complete', () => {
    calls += 1

    return { value: { isAnswered: false, reason: 'empty-reply' } as never }
  })
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))

  await $.prompt.submit(typed('vas-y'))
  await $.prompt.submit(typed('Continue.'))

  expect(calls).toBe(0)
})

test(
  'each mode runs at its configured main effort',
  { options: { chat_main_effort: 'medium', design_main_effort: 'high', impl_main_effort: 'xhigh' } },
  async ($, on) => {
    const sent: string[] = []
    on('command.register', () => ({ value: { command: 'route' } }))
    on('session.model', () => ({ value: 'claude-fable-5-2' }))
    on('turn.step', async function* (_, e) {
      sent.push(`${e.model} ${e.effort}`)

      return ANSWER
    })

    const chat = await $.command.run(route('chat'))
    expect(chat.text).toContain('Mode: chat (main loop at medium effort), pinned.')
    for await (const _ of $.turn.step(STEP)) void _

    await $.command.run(route('design'))
    for await (const _ of $.turn.step(STEP)) void _

    await $.command.run(route('impl'))
    for await (const _ of $.turn.step(STEP)) void _

    // A level the person raised stays.
    await $.command.run(route('chat'))
    for await (const _ of $.turn.step({ ...STEP, effort: 'max' })) void _

    expect(sent).toEqual([
      'claude-fable-5-2 medium',
      'claude-fable-5-2 high',
      'claude-fable-5-2 xhigh',
      'claude-fable-5-2 max',
    ])
  },
)

test(
  'the main loop keeps its model in every mode',
  { options: { main_model: '', sub_model: 'haiku' } },
  async ($, on) => {
    const models: string[] = []
    on('command.register', () => ({ value: { command: 'route' } }))
    on('session.model', () => ({ value: 'fable[1m]' }))
    on('turn.step', async function* (_, e) {
      models.push(e.model)

      return ANSWER
    })

    for (const mode of ['chat', 'design', 'impl'] as const) {
      await $.command.run(route(mode))
      for await (const _ of $.turn.step(STEP)) void _
      for await (const _ of $.turn.step({ ...STEP, model: 'claude-opus-5-5' }))
        void _
    }

    expect(models).toEqual([
      'claude-fable-5-2',
      'claude-opus-5-5',
      'claude-fable-5-2',
      'claude-opus-5-5',
      'claude-fable-5-2',
      'claude-opus-5-5',
    ])
  },
)

test(
  'an empty main model routes every session model',
  { options: { main_model: '' } },
  async ($, on) => {
    const sent: (TurnStepInput['effort'] | undefined)[] = []
    on('command.register', () => ({ value: { command: 'route' } }))
    on('session.model', () => ({ value: 'claude-fable-5-2' }))
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
  'the implementer is registered with the sub model and the impl sub effort',
  { options: { sub_model: 'sonnet', impl_sub_effort: 'medium' } },
  async ($, on) => {
    const specs: { name: string; model?: string; effort?: string | number }[] = []
    let context: readonly string[] | undefined
    on('command.register', () => ({ value: { command: 'route' } }))
    on('session.model', () => ({ value: 'claude-fable-5-2' }))
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

    const shown = await $.command.run(route())
    expect(shown.text).toContain(
      'Settings: main fable (chat low, design xhigh, impl high); implementer on sonnet at medium effort; classifier haiku (6000 ms, minimum confidence 0.6). Change them in /config.',
    )
  },
)

test(
  'an empty sub model leaves the implementer on the subagent default',
  { options: { sub_model: '' } },
  async ($, on) => {
    const specs: Record<string, unknown>[] = []
    on('command.register', () => ({ value: { command: 'route' } }))
    on('session.model', () => ({ value: 'claude-fable-5-2' }))
    on('agent.register', (_, e) => {
      specs.push({ ...e })

      return { value: { agent: `effort-router:${e.name}` } }
    })
    on('session.start', (_, e) => ({ cwd: e.cwd }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    expect(specs.length).toBe(1)
    expect('model' in (specs[0] ?? {})).toBe(false)
    expect(specs[0]?.effort).toBe('high')
    expect(specs[0]?.description).toContain(
      "Runs on the session's subagent model at high effort",
    )

    const shown = await $.command.run(route())
    expect(shown.text).toContain(
      "implementer on the session's subagent model at high effort;",
    )
  },
)

test('/route shows the settings', async ($, on) => {
  on('command.register', () => ({ value: { command: 'route' } }))
  on('session.model', () => ({ value: 'claude-fable-5-2' }))

  const shown = await $.command.run(route())
  expect(shown.text?.split('\n').at(-2)).toBe(
    'Settings: main fable (chat low, design xhigh, impl high); implementer on opus at high effort; classifier haiku (6000 ms, minimum confidence 0.6). Change them in /config.',
  )
})

// What the Agent tool hands `agent.spawn`, less what the engine fills.
const SPAWN = {
  tool_use_id: 'tu1',
  prompt: 'Find the parser.',
  description: 'find parser',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-fable-5-2',
  background: false,
  fork: false,
} as const

test('other subagents keep their own model and effort', async ($, on) => {
  const calls: unknown[] = []
  const spawns: unknown[] = []
  on('command.register', () => ({ value: { command: 'route' } }))
  on('session.model', () => ({ value: 'claude-fable-5-2' }))
  // Both stand for the engine: they record what reaches it.
  on('tool.call', { tool: 'Agent' }, (_, e) => {
    calls.push({ type: e.subagent_type, model: e.model, effort: e.effort })

    return { result: {} as never }
  })
  on('agent.spawn', (_, e) => {
    spawns.push({ type: e.subagentType, model: e.model })

    return { model: e.model ?? e.parentModel, agentId: 'a1' }
  })

  for (const mode of ['chat', 'design', 'impl'] as const) {
    await $.command.run(route(mode))
    await $.tool.call({ tool: 'Agent', description: 'find parser', prompt: 'Find the parser.', subagent_type: 'Explore' })
    await $.tool.call({ tool: 'Agent', description: 'review', prompt: 'Review.', model: 'haiku', effort: 'low' })
    await $.agent.spawn(SPAWN)
    await $.agent.spawn({ ...SPAWN, subagentType: 'general-purpose', model: 'sonnet' })
  }

  expect(calls).toEqual(
    Array(3)
      .fill([
        { type: 'Explore', model: undefined, effort: undefined },
        { type: undefined, model: 'haiku', effort: 'low' },
      ])
      .flat(),
  )
  expect(spawns).toEqual(
    Array(3)
      .fill([
        { type: 'Explore', model: undefined },
        { type: 'general-purpose', model: 'sonnet' },
      ])
      .flat(),
  )
})

test(
  'with delegation off, no agent is registered and no note is added',
  { options: { delegate: false } },
  async ($, on) => {
    let registered = 0
    let context: readonly string[] | undefined
    on('command.register', () => ({ value: { command: 'route' } }))
    on('session.model', () => ({ value: 'claude-fable-5-2' }))
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

test('the band shows the mode and how the classifier routed the message, on every surface', async ($, on) => {
  let now = 0
  on('command.register', () => ({ value: { command: 'route' } }))
  on('session.model', () => ({ value: 'claude-fable-5-2' }))
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
  expect(await rowOf(before)).toBe('● chat · low · classifier: chat 0.92 in 1840 ms')
  await before.unmount()

  for (const surface of BAND_SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await rowOf(ui)).toBe('● chat · low · classifier: chat 0.92 in 1840 ms')
    const mode = await partOf(ui, /● chat/)
    expect(mode?.props).toMatchObject({ color: 'planMode', weight: 'bold' })
    expect((await partOf(ui, /classifier:/))?.props.dimColor).toBe(true)
    await ui.unmount()
  }

  const shown = await $.command.run(route())
  expect(shown.text).toContain('Last message: classifier: chat 0.92 in 1840 ms.')
})

test(
  'with verbose off the band leaves out how the message was routed',
  { options: { verbose: false } },
  async ($, on) => {
    on('command.register', () => ({ value: { command: 'route' } }))
    on('session.model', () => ({ value: 'claude-fable-5-2' }))
    on('session.messages', () => ({ value: [] }))
    on('clock.now', () => ({ value: 0 }))
    // An unsure answer would otherwise show in the warning colour.
    on('model.complete', () => ({
      value: { isAnswered: true, text: 'chat 0.55', usage: USAGE },
    }))
    on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))

    await $.prompt.submit(typed('et sinon ?'))

    for (const surface of BAND_SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })

      expect(await rowOf(ui)).toBe('● impl · high')
      await ui.unmount()
    }

    // The report still says it.
    const shown = await $.command.run(route())
    expect(shown.text).toContain('Last message: classifier unsure: chat 0.55 < 0.6, kept impl.')
  },
)

test('a timeout is recorded, and the band and /route say so', async ($, on) => {
  let now = 0
  const written: unknown[] = []
  on('command.register', () => ({ value: { command: 'route' } }))
  on('session.model', () => ({ value: 'claude-fable-5-2' }))
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
  on('session.model', () => ({ value: 'claude-fable-5-2' }))
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
  on('session.model', () => ({ value: 'claude-fable-5-2' }))

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
  on('session.model', () => ({ value: 'claude-fable-5-2' }))
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
  on('session.model', () => ({ value: 'claude-fable-5-2' }))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await rowOf(ui)).toBe('● impl · high')
  await ui.unmount()
})

test('a confident answer switches the mode and shows its confidence', async ($, on) => {
  let context: readonly string[] | undefined
  on('command.register', () => ({ value: { command: 'route' } }))
  on('session.model', () => ({ value: 'claude-fable-5-2' }))
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
  expect(shown.text).toContain('Last message: classifier: impl 0.80 in 0 ms.')
  expect(shown.text).toContain('0 unsure')
})

test('an answer below the minimum confidence keeps the mode in force', async ($, on) => {
  let now = 0
  let context: readonly string[] | undefined
  const written: unknown[] = []
  on('command.register', () => ({ value: { command: 'route' } }))
  on('session.model', () => ({ value: 'claude-fable-5-2' }))
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
      '● impl · high · classifier unsure: chat 0.55 < 0.6, kept impl',
    )
    const last = await partOf(ui, /unsure/)
    expect(last?.text).toBe('classifier unsure: chat 0.55 < 0.6, kept impl')
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
  expect(shown.text).toContain('Last message: classifier unsure: chat 0.55 < 0.6, kept impl.')
  expect(shown.text).toContain('classifier haiku (6000 ms, minimum confidence 0.6)')
})

test('a one-word answer with no confidence still routes', async ($, on) => {
  on('command.register', () => ({ value: { command: 'route' } }))
  on('session.model', () => ({ value: 'claude-fable-5-2' }))
  on('session.messages', () => ({ value: [] }))
  on('clock.now', () => ({ value: 1000 }))
  on('model.complete', () => ({
    value: { isAnswered: true, text: 'chat', usage: USAGE },
  }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))

  await $.prompt.submit(typed('why is the sky blue?'))

  const shown = await $.command.run(route())
  expect(shown.text).toContain('Mode: chat (main loop at low effort), chosen per message.')
  expect(shown.text).toContain('Last message: classifier: chat 1.00 in 0 ms.')
})

test(
  'a minimum confidence of 0 accepts every answer',
  { options: { classifier_min_confidence: 0 } },
  async ($, on) => {
    on('command.register', () => ({ value: { command: 'route' } }))
    on('session.model', () => ({ value: 'claude-fable-5-2' }))
    on('session.messages', () => ({ value: [] }))
    on('clock.now', () => ({ value: 1000 }))
    on('model.complete', () => ({
      value: { isAnswered: true, text: 'chat 0.1', usage: USAGE },
    }))
    on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))

    await $.prompt.submit(typed('hmm, the parser'))

    const shown = await $.command.run(route())
    expect(shown.text).toContain('Mode: chat (main loop at low effort), chosen per message.')
    expect(shown.text).toContain('Last message: classifier: chat 0.10 in 0 ms.')
    expect(shown.text).toContain('(6000 ms, minimum confidence 0)')
  },
)

test('a confidence is read with a comma, a leading point or as a percentage', async ($, on) => {
  const replies = ['`chat` 0,9', 'impl: 90%', 'chat .9', '**impl** (confidence 1)']
  const seen: (string | undefined)[] = []
  on('command.register', () => ({ value: { command: 'route' } }))
  on('session.model', () => ({ value: 'claude-fable-5-2' }))
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
    'Last message: classifier: chat 0.90 in 0 ms.',
    'Last message: classifier: impl 0.90 in 0 ms.',
    'Last message: classifier: chat 0.90 in 0 ms.',
    'Last message: classifier: impl 1.00 in 0 ms.',
  ])
})

test('a design answer runs the main loop at the design effort with no note', async ($, on) => {
  const sent: (TurnStepInput['effort'] | undefined)[] = []
  let context: readonly string[] | undefined = ['unset']
  on('command.register', () => ({ value: { command: 'route' } }))
  on('session.model', () => ({ value: 'claude-fable-5-2' }))
  on('session.messages', () => ({ value: [] }))
  on('clock.now', () => ({ value: 1000 }))
  on('model.complete', () => ({
    value: { isAnswered: true, text: 'design 0.9', usage: USAGE },
  }))
  on('prompt.submit', (_, e) => {
    context = e.context

    return { text: e.text, context: e.context }
  })
  on('turn.step', async function* (_, e) {
    sent.push(e.effort)

    return ANSWER
  })

  await $.prompt.submit(typed('how should we split the parser? compare two approaches'))
  for await (const _ of $.turn.step(STEP)) void _

  expect(context).toBeUndefined()
  expect(sent).toEqual(['xhigh'])
  const shown = await $.command.run(route())
  expect(shown.text).toContain('Mode: design (main loop at xhigh effort), chosen per message.')
  expect(shown.text).toContain('Last message: classifier: design 0.90 in 0 ms.')
})

test('/route design pins it and the band shows it', async ($, on) => {
  on('command.register', () => ({ value: { command: 'route' } }))
  on('session.model', () => ({ value: 'claude-fable-5-2' }))

  const pinned = await $.command.run(route('design'))
  expect(pinned.text).toContain('Mode: design (main loop at xhigh effort), pinned.')
  expect(pinned.text).toContain('Usage: /route auto | chat | design | impl')

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await rowOf(ui)).toBe('● design · xhigh (pinned)')
  const mode = await partOf(ui, /● design/)
  expect(mode?.props).toMatchObject({ color: 'claude', weight: 'bold' })
  await ui.unmount()
})

test(
  'design runs at its configured main effort on the session model',
  { options: { design_main_effort: 'medium' } },
  async ($, on) => {
    const sent: string[] = []
    on('command.register', () => ({ value: { command: 'route' } }))
    on('session.model', () => ({ value: 'claude-fable-5-2' }))
    on('turn.step', async function* (_, e) {
      sent.push(`${e.model} ${e.effort}`)

      return ANSWER
    })

    const shown = await $.command.run(route('design'))
    expect(shown.text).toContain('Mode: design (main loop at medium effort), pinned.')
    for await (const _ of $.turn.step(STEP)) void _

    expect(sent).toEqual(['claude-fable-5-2 medium'])
  },
)

test('an unsure design answer keeps the mode in force', async ($, on) => {
  let context: readonly string[] | undefined
  on('command.register', () => ({ value: { command: 'route' } }))
  on('session.model', () => ({ value: 'claude-fable-5-2' }))
  on('session.messages', () => ({ value: [] }))
  on('clock.now', () => ({ value: 1000 }))
  on('model.complete', () => ({
    value: { isAnswered: true, text: 'design 0.4', usage: USAGE },
  }))
  on('prompt.submit', (_, e) => {
    context = e.context

    return { text: e.text, context: e.context }
  })

  await $.prompt.submit(typed('et pour le cache ?'))

  expect(context?.[0]).toContain('effort-router:implementer')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await rowOf(ui)).toBe(
    '● impl · high · classifier unsure: design 0.40 < 0.6, kept impl',
  )
  await ui.unmount()
})

test('design raises a session at high to xhigh and leaves xhigh and max alone', async ($, on) => {
  const sent: (TurnStepInput['effort'] | undefined)[] = []
  on('command.register', () => ({ value: { command: 'route' } }))
  on('session.model', () => ({ value: 'claude-fable-5-2' }))
  on('turn.step', async function* (_, e) {
    sent.push(e.effort)

    return ANSWER
  })

  await $.command.run(route('design'))
  for (const effort of ['high', 'xhigh', 'max'] as const) {
    for await (const _ of $.turn.step({ ...STEP, effort })) void _
  }

  expect(sent).toEqual(['xhigh', 'xhigh', 'max'])
})

test('the band shows what the main loop last ran with', async ($, on) => {
  const written: unknown[] = []
  on('command.register', () => ({ value: { command: 'route' } }))
  on('session.model', () => ({ value: 'claude-fable-5-2' }))
  on('state.set', (_, e, next) => {
    if (e.key === 'sent') {
      written.push(e.value)
    }

    return next(e)
  })
  on('turn.step', async function* (_, e) {
    return { ...ANSWER, index: e.index }
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const before = await $.command.run(route())
  expect(before.text).toContain('Main loop has not run yet.')

  // A turn of three steps writes once.
  for (let index = 0; index < 3; index += 1) {
    for await (const _ of $.turn.step({ ...STEP, index })) void _
  }
  expect(written).toEqual([{ mode: 'impl', model: 'claude-fable-5-2', effort: 'high' }])
  expect(await rowOf(ui)).toBe('● impl · fable-5-2 · high')

  // An effort the person raised shows as it went out.
  for await (const _ of $.turn.step({ ...STEP, effort: 'max' })) void _
  expect(await rowOf(ui)).toBe('● impl · fable-5-2 · max')
  const shown = await $.command.run(route())
  expect(shown.text).toContain('Main loop last ran on claude-fable-5-2 at max effort.')

  // Another mode shows its route until its first request.
  await $.command.run(route('chat'))
  expect(await rowOf(ui)).toBe('● chat · low (pinned)')
  for await (const _ of $.turn.step(STEP)) void _
  expect(await rowOf(ui)).toBe('● chat · fable-5-2 · low (pinned)')
  await ui.unmount()
})

// What a model switch hands its hook, less the envelope the engine stamps.
const SWITCH = {
  requested_model: 'fable',
  source: 'command',
  context_tokens: 0,
  prompt_cache_warm: false,
  cache_ttl: '5m',
  estimated_cache_write_usd: 0,
  pricing: 'catalog',
} as const

test('a session on a model that is not routed is left alone and says so', async ($, on) => {
  let calls = 0
  let context: readonly string[] | undefined = ['unset']
  const written: string[] = []
  on('command.register', () => ({ value: { command: 'route' } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('state.set', (_, e, next) => {
    written.push(e.key)

    return next(e)
  })
  on('session.messages', () => ({ value: [] }))
  on('clock.now', () => ({ value: 1000 }))
  on('model.complete', () => {
    calls += 1

    return { value: { isAnswered: true, text: 'chat 0.9', usage: USAGE } }
  })
  on('prompt.submit', (_, e) => {
    context = e.context

    return { text: e.text, context: e.context }
  })

  // A new session is in impl: on a routed model it would get the note.
  await $.prompt.submit(typed('add a retry to the fetch'))
  expect(calls).toBe(0)
  expect(context).toBeUndefined()
  expect(written).toEqual([])

  for (const surface of BAND_SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await rowOf(ui)).toBe('○ not routed · opus-5-5 · only models matching "fable"')
    const row = await partOf(ui, /not routed/)
    expect(row?.props.dimColor).toBe(true)
    expect(row?.props.color).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /●/ })).toBeUndefined()
    await ui.unmount()
  }

  const shown = await $.command.run(route())
  expect(shown.text?.split('\n')[0]).toBe(
    'Not routed: this session runs on claude-opus-5-5, and only models matching "fable" are routed. Its messages go through untouched.',
  )
  expect(shown.text).toContain('Mode: impl (main loop at high effort), chosen per message.')
  expect(shown.text).toContain('Last message: no message routed yet.')

  // A pin is recorded, and said to wait for a routed model.
  const pinned = await $.command.run(route('chat'))
  expect(pinned.text).toContain(
    'Mode: chat (main loop at low effort), pinned; the pin takes effect only on a routed model.',
  )
  expect(written).toEqual(['pin', 'mode'])
})

test('a switch to a routed model draws the band again and routes', async ($, on) => {
  let model = 'claude-opus-5-5'
  let calls = 0
  on('command.register', () => ({ value: { command: 'route' } }))
  on('session.model', () => ({ value: model }))
  on('session.messages', () => ({ value: [] }))
  on('clock.now', () => ({ value: 1000 }))
  on('model.complete', () => {
    calls += 1

    return { value: { isAnswered: true, text: 'chat 0.9', usage: USAGE } }
  })
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  // No settings hook: the switch's chain ends here.
  on('classic.PostModelSwitch', () => ({}))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await rowOf(ui)).toBe('○ not routed · opus-5-5 · only models matching "fable"')

  // `/model fable`: the session now answers with the alias `/model` shows.
  model = 'fable'
  await $.classic.PostModelSwitch({
    ...SWITCH,
    from_model: 'claude-opus-5-5',
    to_model: 'claude-fable-5-2',
  })
  expect(await rowOf(ui)).toBe('● impl · high')

  await $.prompt.submit(typed('why is the sky blue?'))
  expect(calls).toBe(1)
  expect(await rowOf(ui)).toBe('● chat · low · classifier: chat 0.90 in 0 ms')
  await ui.unmount()

  const shown = await $.command.run(route())
  expect(shown.text?.split('\n')[0]).toBe(
    'Mode: chat (main loop at low effort), chosen per message.',
  )
})

test(
  'a main model written as a full id matches the alias the session shows',
  { options: { main_model: 'claude-fable-5-2' } },
  async ($, on) => {
    let context: readonly string[] | undefined
    on('command.register', () => ({ value: { command: 'route' } }))
    on('session.model', () => ({ value: 'fable[1m]' }))
    on('prompt.submit', (_, e) => {
      context = e.context

      return { text: e.text, context: e.context }
    })

    // A bare approval in impl: routed, so it gets the note with no call.
    await $.prompt.submit(typed('vas-y'))
    expect(context?.[0]).toContain('effort-router:implementer')

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await rowOf(ui)).toBe('● impl · high · bare approval, kept impl')
    await ui.unmount()
  },
)

test(
  'an empty main model routes a session on any model',
  { options: { main_model: '' } },
  async ($, on) => {
    let calls = 0
    let context: readonly string[] | undefined
    on('command.register', () => ({ value: { command: 'route' } }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('session.messages', () => ({ value: [] }))
    on('clock.now', () => ({ value: 1000 }))
    on('model.complete', () => {
      calls += 1

      return { value: { isAnswered: true, text: 'impl 0.9', usage: USAGE } }
    })
    on('prompt.submit', (_, e) => {
      context = e.context

      return { text: e.text, context: e.context }
    })

    await $.prompt.submit(typed('add a retry to the fetch'))
    expect(calls).toBe(1)
    expect(context?.[0]).toContain('effort-router:implementer')

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await rowOf(ui)).toBe('● impl · high · classifier: impl 0.90 in 0 ms')
    await ui.unmount()

    const shown = await $.command.run(route())
    expect(shown.text?.split('\n')[0]).toBe(
      'Mode: impl (main loop at high effort), chosen per message.',
    )
    expect(shown.text).toContain('Settings: main any model (chat low, design xhigh, impl high);')
  },
)
