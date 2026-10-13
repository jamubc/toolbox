import { describe, expect, test } from 'claude-code/testing'

import type { RedlineBeat } from '../types'
import { DONE_MS, STALE_MS, agentsIn, fleet, tally } from '../hooks/fleet'

const NOW = 1_800_000_000_000

// What `claude agents --json` prints: background runs, which do not count, and interactive sessions.
export const AGENTS = JSON.stringify([
  { id: 'c87e1e86', cwd: '/Users/jam/open-grok-build', kind: 'background', startedAt: 1, sessionId: 'c87e1e86-aaaa', name: 'old-run', state: 'blocked' },
  { pid: 83418, cwd: '/Users/jam', kind: 'interactive', startedAt: 2, sessionId: 'sess-jam', name: 'jam-c0', status: 'idle' },
  { pid: 84570, cwd: '/Users/jam/Documents/tools/fennec', kind: 'interactive', startedAt: 3, sessionId: 'sess-fennec', name: 'fennec-8c', status: 'busy' },
  { pid: 2902, cwd: '/Users/jam/Documents/github/jamubc/toolbox', kind: 'interactive', startedAt: 4, sessionId: 'sess-me', name: 'toolbox-83', status: 'busy' },
])

const beat = (over: Partial<RedlineBeat>): RedlineBeat => ({
  id: 'sess-x',
  cwd: '/x',
  state: 'idle',
  waitingFor: '',
  since: NOW,
  at: NOW,
  turns: 1,
  context: 40,
  usd: 1.2,
  model: 'claude-opus-5-5',
  isShifted: false,
  ...over,
})

describe('the listing', () => {
  test('keeps the interactive sessions with their status', () => {
    const found = agentsIn(AGENTS)
    expect(found.map(a => a.name)).toEqual(['jam-c0', 'fennec-8c', 'toolbox-83'])
    expect(found.map(a => a.status)).toEqual(['idle', 'busy', 'busy'])
    expect(found[0]?.pid).toBe(83418)
  })

  test('shrugs at anything that is not a list of sessions', () => {
    expect(agentsIn('')).toEqual([])
    expect(agentsIn('{}')).toEqual([])
    expect(agentsIn('[1, null, {"kind":"interactive"}]')).toEqual([])
  })
})

describe('the fleet', () => {
  const agents = agentsIn(AGENTS)

  test('reads a session with no heartbeat from its listed status', () => {
    const rows = fleet(agents, [], 'sess-me', NOW)
    expect(rows.map(r => [r.folder, r.state])).toEqual([
      ['fennec', 'working'],
      ['toolbox', 'working'],
      ['jam', 'idle'],
    ])
    expect(rows.find(r => r.id === 'sess-me')?.isThis).toBe(true)
  })

  test('a heartbeat says exactly what a session waits for, and the one waiting longest sorts first', () => {
    const beats = [
      beat({ id: 'sess-fennec', cwd: '/Users/jam/Documents/tools/fennec', state: 'waiting', waitingFor: 'approve Bash', since: NOW - 120_000 }),
      beat({ id: 'sess-jam', cwd: '/Users/jam', state: 'waiting', waitingFor: 'a question', since: NOW - 300_000 }),
    ]
    const rows = fleet(agents, beats, 'sess-me', NOW)
    expect(rows[0]).toMatchObject({ folder: 'jam', state: 'waiting', waitingFor: 'a question', forMs: 300_000 })
    expect(rows[1]).toMatchObject({ folder: 'fennec', state: 'waiting', waitingFor: 'approve Bash', forMs: 120_000 })
    expect(tally(rows)).toEqual({ needYou: 2, working: 0 })
  })

  test('an idle session that just finished a turn is done, a long-idle one is idle, a fresh one is idle', () => {
    const beats = [
      beat({ id: 'sess-jam', cwd: '/Users/jam', state: 'idle', since: NOW - DONE_MS + 1000 }),
      beat({ id: 'sess-fennec', cwd: '/Users/jam/Documents/tools/fennec', state: 'idle', since: NOW - DONE_MS - 1000 }),
      beat({ id: 'sess-me', cwd: '/Users/jam/Documents/github/jamubc/toolbox', state: 'idle', turns: 0, since: NOW - 1000 }),
    ]
    const rows = fleet(agents, beats, 'sess-me', NOW)
    expect(rows.map(r => [r.folder, r.state])).toEqual([
      ['jam', 'done'],
      ['toolbox', 'idle'],
      ['fennec', 'idle'],
    ])
  })

  test('a stale heartbeat is ignored, and a fresh one lists a session the listing missed', () => {
    const beats = [
      beat({ id: 'sess-gone', cwd: '/gone', state: 'working', at: NOW - STALE_MS - 1 }),
      beat({ id: 'sess-desktop', cwd: '/Users/jam/desk', state: 'working', since: NOW - 5000 }),
    ]
    const rows = fleet(agents, beats, 'sess-me', NOW)
    expect(rows.map(r => r.folder)).toContain('desk')
    expect(rows.map(r => r.folder)).not.toContain('gone')
    expect(tally(rows)).toEqual({ needYou: 0, working: 2 })
  })
})
