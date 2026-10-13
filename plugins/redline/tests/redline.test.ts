import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { clock } from '../hooks/limiter'
import { AGENTS } from './fleet.test'

const RESET = '2026-10-13T20:00:00.000Z'
const NOW = Date.parse('2026-10-13T16:00:00.000Z') // four hours into the five-hour window
const AT_RESET = clock(Date.parse(RESET), NOW) // the reset on the wall clock, in this machine's zone

// What `$.session.usage()` answers: the status line's figures, itemized.
const usageAt = (five: number, week = 31, context = 44, resetsAt = RESET) => ({
  startedAt: 0,
  context: { window: 200000, tokens: 88000, percent: context },
  rateLimits: [
    { kind: 'five_hour', percentUsed: five, resetsAt },
    { kind: 'seven_day', percentUsed: week },
  ],
  cost: { usd: 1.2 },
})

type World = { toasts: string[]; steps: any[]; spawns: any[]; stored: Record<string, unknown>; checks: Array<'allow' | 'ask' | 'deny'> }

/** Stubs the engine beneath the mod. Call before the test's first use of `$`. */
function engine(on: On, usage = usageAt(62)): World & { clock: ReturnType<typeof mock.clock> } {
  const world: World = { toasts: [], steps: [], spawns: [], stored: {}, checks: ['allow'] }
  const clock = mock.clock(on, { now: NOW })
  // The store, as the mod sees it: one JSON map shared by every session on the machine.
  on('store.get', (_$, e) => ({ value: world.stored[e.key] }))
  on('store.set', (_$, e) => {
    world.stored[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    delete world.stored[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(world.stored) }))
  on('process.run', ($, e) => ({ value: { exitCode: 0, stdout: e.argv[1] === 'agents' ? AGENTS : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.usage', () => ({ value: usage }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.id', () => ({ value: 'sess-me' }))
  on('session.cwd', () => ({ value: '/Users/jam/Documents/github/jamubc/toolbox' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'redline' } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.blit', () => ({ value: {} }))
  on('ui.render', ($, e) => $.ui.resolve(e).Box({}))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }) as any)
  on('turn.step', async function* (_$, e) {
    world.steps.push(e)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } as any
  })
  on('agent.spawn', (_$, e) => {
    world.spawns.push(e)
    return { model: e.model ?? e.parentModel, agentId: 'a1' }
  })
  on('tool.check', () => ({ decision: world.checks[0]! }))
  on('tool.call', () => ({ result: 'ran' }) as any)
  return { ...world, clock }
}

async function boot($: Engine, clock: ReturnType<typeof mock.clock>) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
  await clock.settle()
}

const run = ($: Engine, args = '') =>
  $.command.run({ command: 'redline', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as any)

const band = (surface: 'terminal' | 'desktop', bodyColumns = 120) =>
  ({
    plugin: 'redline',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  }) as any

const pane = (surface: 'terminal' | 'desktop', bodyColumns = 80) =>
  ({
    plugin: 'redline',
    surface,
    component: 'Pane',
    requestId: 'redline',
    props: { title: 'Redline', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  }) as any

const step = ($: Engine, index = 0) => {
  const stream = $.turn.step({ turnId: 't1', index, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 } as any)
  return (async () => {
    for await (const _ of stream) {
      // drain
    }
    return stream.result
  })()
}

describe('the band', () => {
  test('is one line above the prompt with the windows, the context and the other sessions', async ($, on) => {
    const w = engine(on)
    await boot($, w.clock)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount(band(surface))
      expect(await ui.find({ type: 'Text', text: /5h 62%/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /7d 31%/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /ctx 44%/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /1 working/ })).toBeDefined()
      expect(await ui.find({ type: 'Raster' } as any)).toBeUndefined()
      await ui.unmount()
    }
  })

  test('steps aside while the pane is open, and when there is a survey', async ($, on) => {
    const w = engine(on)
    await boot($, w.clock)
    await run($)
    const ui = await $.ui.mount(band('terminal'))
    expect(await ui.find({ type: 'Text', text: /5h/ })).toBeUndefined()
    await ui.unmount()
    await run($)
    const survey = await $.ui.mount({ ...band('terminal'), props: { ...band('terminal').props, hasSurvey: true } })
    expect(await survey.find({ type: 'Text', text: /5h/ })).toBeUndefined()
    await survey.unmount()
  })

  test('with "only when it matters" it is blank until a window nears its redline', { options: { band: 'only when it matters' } }, async ($, on) => {
    const w = engine(on, usageAt(30))
    await boot($, w.clock)
    const quiet = await $.ui.mount(band('terminal'))
    expect(await quiet.find({ type: 'Text', text: /5h/ })).toBeUndefined()
    await quiet.unmount()
    await $.session.measure({ ...usageAt(70), changed: ['rateLimits'] } as any)
    const loud = await $.ui.mount(band('terminal'))
    expect(await loud.find({ type: 'Text', text: /5h 70%/ })).toBeDefined()
    await loud.unmount()
  })

  test('"never" leaves the band alone', { options: { band: 'never' } }, async ($, on) => {
    const w = engine(on)
    await boot($, w.clock)
    const ui = await $.ui.mount(band('terminal'))
    expect(await ui.find({ type: 'Text', text: /5h/ })).toBeUndefined()
    await ui.unmount()
  })
})

describe('the limiter', () => {
  test('sends a request on the session model under the redline', async ($, on) => {
    const w = engine(on)
    await boot($, w.clock)
    await step($)
    expect(w.steps[0].model).toBe('claude-opus-5-5')
    expect(w.steps[0].effort).toBe('high')
  })

  test('shifts the request to Sonnet once the five-hour window is at the redline, and says so once', async ($, on) => {
    const w = engine(on, usageAt(62))
    await boot($, w.clock)
    await $.session.measure({ ...usageAt(80), changed: ['rateLimits'] } as any)
    expect(w.toasts).toEqual([`shifted down to Sonnet 5.5 until ${AT_RESET}: 5h window at 80%`])
    await step($)
    expect(w.steps[0].model).toBe('claude-sonnet-5-5')
    expect(w.steps[0].effort).toBe('high')
    const ui = await $.ui.mount(band('terminal'))
    expect(await ui.find({ type: 'Text', text: /⇣ Sonnet 5\.5/ })).toBeDefined()
    await ui.unmount()

    // Subagents spawned while shifted go to Sonnet too.
    await $.agent.spawn({ tool_use_id: 'x', prompt: 'look', description: 'look', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false } as any)
    expect(w.spawns[0].model).toBe('claude-sonnet-5-5')
  })

  test('the shift option chooses what changes, and the model option where to', { options: { shift: 'Sonnet and lower effort', redlineAt: 50, model: 'claude-haiku-5-5' } }, async ($, on) => {
    const w = engine(on, usageAt(55))
    await boot($, w.clock)
    await step($)
    expect(w.steps[0].model).toBe('claude-haiku-5-5')
    expect(w.steps[0].effort).toBe('low')
    expect(w.toasts).toEqual([])
    const ui = await $.ui.mount(band('terminal'))
    expect(await ui.find({ type: 'Text', text: /⇣ Haiku 5\.5 · low effort/ })).toBeDefined()
    await ui.unmount()
  })

  test('"warn only" changes nothing and still says where the needle is', { options: { shift: 'warn only' } }, async ($, on) => {
    const w = engine(on, usageAt(62))
    await boot($, w.clock)
    await $.session.measure({ ...usageAt(90), changed: ['rateLimits'] } as any)
    expect(w.toasts).toEqual(['5h window at 90%: past the redline'])
    await step($)
    expect(w.steps[0].model).toBe('claude-opus-5-5')
    const ui = await $.ui.mount(band('terminal'))
    expect(await ui.find({ type: 'Text', text: /⇣ past the redline/ })).toBeDefined()
    await ui.unmount()
  })

  test('lifts itself once the window resets', async ($, on) => {
    const soon = new Date(NOW + 30_000).toISOString()
    const w = engine(on, usageAt(90, 31, 44, soon))
    await boot($, w.clock)
    await step($)
    expect(w.steps[0].model).toBe('claude-sonnet-5-5')
    await w.clock.advance(40_000)
    expect(w.toasts).toContain('back in gear')
    await step($, 1)
    expect(w.steps[1].model).toBe('claude-opus-5-5')
  })

  test('/redline shift, lift and auto take the lever by hand', async ($, on) => {
    const w = engine(on, usageAt(62))
    await boot($, w.clock)
    expect((await run($, 'shift')).text).toMatch(new RegExp(`^Shifted down to Sonnet 5.5 until ${AT_RESET}`))
    await step($)
    expect(w.steps[0].model).toBe('claude-sonnet-5-5')
    expect((await run($, 'auto')).text).toBe('Automatic again: in gear.')
    await step($, 1)
    expect(w.steps[1].model).toBe('claude-opus-5-5')

    await $.session.measure({ ...usageAt(85), changed: ['rateLimits'] } as any)
    expect((await run($, 'lift')).text).toMatch(new RegExp(`^Limiter lifted until ${AT_RESET}`))
    await step($, 2)
    expect(w.steps[2].model).toBe('claude-opus-5-5')
    expect((await run($, 'auto')).text).toBe('Automatic again: shifted, 5h window at 85%.')
    expect((await run($, 'what')).text).toMatch(/^Usage:/)
  })
})

describe('the fleet', () => {
  test('/redline opens the dash with the dials, the readouts, the limiter and every session', async ($, on) => {
    const w = engine(on)
    await boot($, w.clock)
    expect(await run($)).toEqual({})
    const ui = await $.ui.mount(pane('terminal'))
    expect(await ui.find({ type: 'Raster', key: 'dash' } as any)).toBeDefined()
    expect(await ui.find({ type: 'Text', text: new RegExp(`resets ${AT_RESET} · 4h left`) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: / 62%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\$1\.20 this session/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /in gear · shifts at 80% of 5h, 90% of 7d/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'shift' } as any)).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /● fennec +working/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /toolbox.*this one/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /○ jam +idle/ })).toBeDefined()
    await ui.unmount()

    const words = await $.ui.mount(pane('desktop'))
    expect(await words.find({ type: 'Raster' } as any)).toBeUndefined()
    expect(await words.find({ type: 'Text', text: /Sessions/ })).toBeDefined()
    await words.unmount()
    expect(await run($)).toEqual({})
  })

  test('writes its heartbeat for the other sessions, and says when it waits on you', async ($, on) => {
    const w = engine(on)
    await boot($, w.clock)
    expect(w.stored['session:sess-me']).toMatchObject({ id: 'sess-me', state: 'idle', cwd: '/Users/jam/Documents/github/jamubc/toolbox', context: 44, usd: 1.2, model: 'claude-opus-5-5', isShifted: false })

    await $.turn.start({ text: 'go', turnId: 't1' })
    await w.clock.settle()
    expect(w.stored['session:sess-me']).toMatchObject({ state: 'working' })

    // A permission prompt: the check answers `ask`, and until the tool call goes through the heartbeat says what for.
    w.checks[0] = 'ask'
    await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'call-1' } as any)
    await w.clock.settle()
    expect(w.stored['session:sess-me']).toMatchObject({ state: 'waiting', waitingFor: 'approve Bash' })
    await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'call-1' } as any)
    await w.clock.settle()
    expect(w.stored['session:sess-me']).toMatchObject({ state: 'working' })

    await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 10, isAborted: false, usage: {} } as any)
    await w.clock.settle()
    expect(w.stored['session:sess-me']).toMatchObject({ state: 'idle', turns: 1 })
  })

  test('the pane shows a session that needs you first, from its heartbeat', async ($, on) => {
    const w = engine(on)
    await boot($, w.clock)
    w.stored['session:sess-fennec'] = {
      id: 'sess-fennec', cwd: '/Users/jam/Documents/tools/fennec', state: 'waiting', waitingFor: 'approve Bash', since: NOW - 120_000, at: NOW, turns: 3, context: 61, usd: 0.4, model: 'claude-opus-5-5', isShifted: true,
    }
    await w.clock.advance(5000)
    const above = await $.ui.mount(band('terminal'))
    expect(await above.find({ type: 'Text', text: /1 session needs you/ })).toBeDefined()
    await above.unmount()
    await run($)
    const ui = await $.ui.mount(pane('terminal'))
    const first = await ui.find({ type: 'Text', text: /needs you · approve Bash · 2m · ctx 61% · \$0\.40 · ⇣/ })
    expect(first).toBeDefined()
    await ui.unmount()
  })
})
