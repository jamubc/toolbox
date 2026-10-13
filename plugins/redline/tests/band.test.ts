import { describe, expect, test } from 'claude-code/testing'

import { bandLine, bandSegments, matters, toneFor } from '../hooks/band'
import type { Row } from '../hooks/fleet'

const NOW = 1_800_000_000_000
const row = (state: Row['state'], isThis = false): Row => ({ id: state, folder: state, name: '', state, waitingFor: state === 'waiting' ? 'approve Bash' : '', forMs: null, isThis, beat: null })
const input = (over: Partial<Parameters<typeof bandSegments>[0]> = {}) => ({
  usage: { fiveHour: { percent: 62, resetsAt: NOW + 3600_000 }, sevenDay: { percent: 31, resetsAt: null }, context: 44 },
  gear: { isShifted: false, reason: '', until: null },
  shift: { shift: 'sonnet' as const, model: 'claude-sonnet-5-5' },
  redlineAt: 80,
  weeklyRedlineAt: 90,
  rows: [],
  now: NOW,
  ...over,
})

describe('the band', () => {
  test('is one line: the windows, the context, and who needs you', () => {
    const segments = bandSegments(input({ rows: [row('working', true), row('waiting'), row('working'), row('idle')] }))
    expect(bandLine(segments, 200)).toBe('5h 62%  ·  7d 31%  ·  ctx 44%  ·  1 session needs you  ·  1 working')
  })

  test('leads with the gear while shifted', () => {
    const segments = bandSegments(input({ gear: { isShifted: true, reason: '5h window at 84%', until: null }, shift: { shift: 'both', model: 'claude-sonnet-5-5' } }))
    expect(segments[0]).toEqual({ text: '⇣ Sonnet 5.5 · low effort', tone: 'red' })
  })

  test('says nothing it has no reading for', () => {
    expect(bandSegments(input({ usage: { fiveHour: null, sevenDay: null, context: null } }))).toEqual([])
    expect(bandLine(bandSegments(input({ usage: { fiveHour: null, sevenDay: null, context: 12 } })), 80)).toBe('ctx 12%')
  })

  test('a window that has reset is dropped from the line', () => {
    const segments = bandSegments(input({ usage: { fiveHour: { percent: 62, resetsAt: NOW - 1 }, sevenDay: null, context: null } }))
    expect(segments).toEqual([])
  })

  test('a percent reads dim, then amber within twenty points of the redline, then red', () => {
    expect(toneFor(59, 80)).toBe('dim')
    expect(toneFor(60, 80)).toBe('amber')
    expect(toneFor(80, 80)).toBe('red')
  })

  test('matters only with a gear, a session that needs you, or a tank near its redline', () => {
    const calm = { fiveHour: { percent: 40, resetsAt: null }, sevenDay: { percent: 31, resetsAt: null }, context: 44 }
    expect(matters(bandSegments(input({ usage: calm })))).toBe(false)
    expect(matters(bandSegments(input({ usage: calm, rows: [row('waiting')] })))).toBe(true)
    expect(matters(bandSegments(input({ usage: { fiveHour: { percent: 70, resetsAt: null }, sevenDay: null, context: null } })))).toBe(true)
    expect(matters(bandSegments(input({ usage: calm, gear: { isShifted: true, reason: '', until: null } })))).toBe(true)
  })

  test('a narrow band is cut with an ellipsis', () => {
    expect(bandLine(bandSegments(input()), 12)).toBe('5h 62%  ·  …')
  })
})
