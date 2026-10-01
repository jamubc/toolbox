import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Canvas } from '../hooks/canvas'
import { LARGE, Needle, SCALE, SMALL, gauge, stageFor } from '../hooks/gauge'
import { cwdsIn, sessionOf, sessionsIn } from '../hooks/sessions'

// A real `ps -x -o pid=,ppid=,tty=,args=` table: five sessions in terminals, one mid-turn (its
// caffeinate child), plus the daemon and its helpers, which do not count.
const PS = `
61627     1 ??       /Users/jam/.local/bin/claude daemon run --json-path /Users/jam/.claude/daemon.json
61684 61627 ??       claude bg-pty-host --bg-pty-host /tmp/cc-daemon-501/spare.pty.sock 200 50
90900 90889 ttys023  claude bg-spare --bg-spare /tmp/cc-daemon-501/spare.claim.sock
94901 86963 ttys001  claude --resume c1bdb8b8-49b7-450a-8b5a-9538e6680657
38136 38034 ttys005  claude -r
15621 15520 ttys010  claude
19785 15621 ttys010  caffeinate -i -t 300
33697 33395 ttys039  claude -r
80793 80644 ttys040  claude
25341     1 ??       /opt/homebrew/bin/python3 server.py
`

const LSOF = ['p94901', 'fcwd', 'n/Users/jam/OpenCAD', 'p15621', 'fcwd', 'n/Users/jam/terminal-toys', 'p80793', 'fcwd', 'n/Users/jam/jamcli'].join('\n')

// What `sh -c 'echo $$; exec ps …'` prints when this session is the one on ttys010.
const SH = `70001\n${PS}70001 15621 ttys010  ps -x -o pid=,ppid=,tty=,args=\n`

const text = (cv: Canvas) => Array.from({ length: cv.rows }, (_, r) => cv.line(r)).join('\n')

/** Stubs the engine beneath the mod. Call before the test's first use of `$`. */
function engine(on: On, statuses: (string | undefined)[] = []) {
  const clock = mock.clock(on)
  on('process.run', ($, e) => {
    const stdout = e.argv[0] === 'ps' ? PS : e.argv[0] === 'lsof' ? LSOF : e.argv[0] === 'sh' ? SH : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'redline' } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.blit', () => ({ value: {} }))
  on('ui.render', ($, e) => $.ui.resolve(e).Box({}))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  return clock
}

async function boot($: Engine, clock: ReturnType<typeof mock.clock>) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
  await clock.settle()
}

const run = ($: Engine, args = '') =>
  $.command.run({ command: 'redline', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as any)

const band = (surface: 'terminal' | 'desktop') =>
  ({
    plugin: 'redline',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  }) as any

const pane = (surface: 'terminal' | 'desktop') =>
  ({
    plugin: 'redline',
    surface,
    component: 'Pane',
    requestId: 'redline',
    props: { title: 'Redline', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  }) as any

describe('census', () => {
  test('finds terminal sessions and the ones mid-turn', async () => {
    const found = sessionsIn(PS)
    expect(found.map(s => s.tty)).toEqual(['ttys001', 'ttys005', 'ttys010', 'ttys039', 'ttys040'])
    expect(found.filter(s => s.isWorking).map(s => s.pid)).toEqual([15621])
    expect(sessionsIn('')).toEqual([])
  })

  test('reads working directories from lsof', async () => {
    expect(cwdsIn(LSOF).get(15621)).toBe('/Users/jam/terminal-toys')
    expect(cwdsIn(LSOF).has(38136)).toBe(false)
  })

  test('finds the session a process runs under', async () => {
    expect(sessionOf(SH, 70001)).toBe(15621)
    expect(sessionOf(SH, 25341)).toBe(0)
  })
})

describe('gauge', () => {
  test('names each stage from where it starts', async () => {
    const names = [0, 1, 2, 3, 6, 9, 12, 13, 17, 18, 21, 24, 25, 99].map(n => stageFor(n).name)
    expect(names).toEqual([
      'Napping', 'Idling', 'Idling', 'Cruising', 'Spooling up', 'Boost building', 'Boost building',
      'Under pressure…', 'Under pressure…', 'Redline', 'Overboost', 'Overboost', 'Blown', 'Blown',
    ])
  })

  test('draws both dials in braille, the needle moving with the count', async () => {
    for (const face of [SMALL, LARGE]) {
      const low = gauge(face, { needle: 0, isNapping: false, isVenting: false, t: 0 })
      const high = gauge(face, { needle: 20, isNapping: false, isVenting: false, t: 0 })
      expect([low.rows, low.cols]).toEqual([face.rows, face.cols])
      expect(text(low)).toMatch(/[⠁-⣿]/)
      expect(text(high)).not.toBe(text(low))
    }
    expect(text(gauge(LARGE, { needle: 0, isNapping: false, isVenting: false, t: 0 }))).toContain('CLAUDES')
  })

  test('snores while napping and vents steam when blown', async () => {
    const snore = text(gauge(SMALL, { needle: 0, isNapping: true, isVenting: false, t: 1.9 }))
    expect(snore).toMatch(/Z[\s\S]*z/) // rising from the bottom: small z low, big Z high
    expect(text(gauge(SMALL, { needle: SCALE, isNapping: false, isVenting: true, t: 0.2 }))).toMatch(/[▓▒░]/)
  })

  test('the needle overshoots a new count, settles on it, and never passes the pin', async () => {
    const needle = new Needle()
    let peak = 0
    for (let i = 0; i < 60; i++) peak = Math.max(peak, needle.step(10, 0.1))
    expect(peak).toBeGreaterThan(10)
    expect(Math.abs(needle.value - 10)).toBeLessThan(0.5)

    let highest = 0
    for (let i = 0; i < 100; i++) highest = Math.max(highest, needle.step(40, 0.1))
    expect(highest).toBeLessThanOrEqual(SCALE)
    expect(needle.value).toBeGreaterThan(SCALE - 3) // pressed against the pin
  })
})

describe('mod', () => {
  test('keeps off the status line by default', async ($, on) => {
    const statuses: (string | undefined)[] = []
    await boot($, engine(on, statuses))
    expect(statuses.filter(s => s !== undefined)).toEqual([])
  })

  test('puts the stage and the count on the status line once switched on', { options: { statusLine: true } }, async ($, on) => {
    const statuses: (string | undefined)[] = []
    await boot($, engine(on, statuses))
    expect(statuses).toContain('Idling · 1/5')
  })

  test('draws the gauge above the prompt, beside its stage', async ($, on) => {
    await boot($, engine(on))
    const ui = await $.ui.mount(band('terminal'))
    expect(await ui.find({ type: 'Raster', key: 'gauge' } as any)).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Idling/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 working · 5 sessions/ })).toBeDefined()
    await ui.unmount()

    const words = await $.ui.mount(band('desktop'))
    expect(await words.find({ type: 'Text', text: /Idling · 1 working/ })).toBeDefined()
    await words.unmount()
  })

  test('previews a count, then follows the sessions again', { options: { statusLine: true } }, async ($, on) => {
    const statuses: (string | undefined)[] = []
    await boot($, engine(on, statuses))
    expect((await run($, '25')).text).toMatch(/Blown/)
    expect(statuses.at(-1)).toBe('Blown · preview')
    const ui = await $.ui.mount(band('terminal'))
    expect(await ui.find({ type: 'Text', text: /Blown/ })).toBeDefined()
    await ui.unmount()

    await run($, 'live')
    expect(statuses.at(-1)).toBe('Idling · 1/5')
  })

  test('/redline opens a pane listing every session, and the band steps aside', async ($, on) => {
    await boot($, engine(on))
    expect((await run($)).text).toMatch(/opened/)

    const ui = await $.ui.mount(pane('terminal'))
    expect(await ui.find({ type: 'Raster', key: 'gauge' } as any)).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /● ttys010 +terminal-toys {2}\(this one\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /○ ttys001 +OpenCAD/ })).toBeDefined()
    await ui.unmount()

    const above = await $.ui.mount(band('terminal'))
    expect(await above.find({ type: 'Raster', key: 'gauge' } as any)).toBeUndefined()
    await above.unmount()

    expect((await run($)).text).toMatch(/closed/)
  })
})
