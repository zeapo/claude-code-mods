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

test('the main loop on Fable runs at the mode effort', async ($, on) => {
  const sent: (TurnStepInput['effort'] | undefined)[] = []
  on('command.register', () => ({ value: { command: 'route' } }))
  on('ui.status', () => ({ value: undefined }))
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
  on('ui.status', () => ({ value: undefined }))
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
  on('ui.status', () => ({ value: undefined }))

  const pinned = await $.command.run(route('chat'))
  expect(pinned.text).toContain('Mode: chat (main loop at low effort), pinned.')

  const auto = await $.command.run(route('auto'))
  expect(auto.text).toContain('Mode: chat (main loop at low effort), chosen per message.')
})

test('a message is classified and an implementation gets the note', async ($, on) => {
  const asked: string[] = []
  let entered: { text: string; context?: readonly string[]; kind?: string } | undefined
  on('command.register', () => ({ value: { command: 'route' } }))
  on('ui.status', () => ({ value: undefined }))
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
  on('ui.status', () => ({ value: undefined }))
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
  on('ui.status', () => ({ value: undefined }))
  on('model.complete', () => {
    calls += 1

    return { value: { isAnswered: false, reason: 'empty-reply' } as never }
  })
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))

  await $.prompt.submit(typed('ok vas-y'))
  await $.prompt.submit(typed('Continue.'))

  expect(calls).toBe(0)
})
