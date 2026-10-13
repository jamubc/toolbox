import { describe, expect, test } from 'claude-code/testing'

import { LENGTH, clock, gearFor, modelWords, paceOf, shiftFor, shiftWords, span, spawnModel, stepChange, windowNow } from '../hooks/limiter'

const NOW = Date.parse('2026-10-13T12:00:00.000Z')
const config = { redlineAt: 80, weeklyRedlineAt: 90, shift: 'sonnet' as const, model: 'claude-sonnet-5-5' }
const to = (shift: 'sonnet' | 'effort' | 'both' | 'warn', model = 'claude-sonnet-5-5') => ({ shift, model })
const auto = { mode: 'auto' as const }
const usage = (five: number | null, week: number | null, resetsAt: number | null = NOW + 3600_000) => ({
  fiveHour: five === null ? null : { percent: five, resetsAt },
  sevenDay: week === null ? null : { percent: week, resetsAt: NOW + 2 * 86_400_000 },
  context: null,
})

describe('the gear', () => {
  test('is in gear under the redline and shifted at it', () => {
    expect(gearFor(usage(79, 10), config, auto, NOW).isShifted).toBe(false)
    const shifted = gearFor(usage(80, 10), config, auto, NOW)
    expect(shifted.isShifted).toBe(true)
    expect(shifted.reason).toBe('5h window at 80%')
    expect(shifted.until).toBe(NOW + 3600_000)
  })

  test('the weekly window has its own redline', () => {
    const shifted = gearFor(usage(10, 91), config, auto, NOW)
    expect(shifted.isShifted).toBe(true)
    expect(shifted.reason).toBe('7d window at 91%')
    expect(gearFor(usage(10, 89), config, auto, NOW).isShifted).toBe(false)
  })

  test('a window that has reset no longer counts', () => {
    expect(gearFor(usage(95, 10, NOW - 1), config, auto, NOW).isShifted).toBe(false)
    expect(windowNow({ percent: 95, resetsAt: NOW - 1 }, NOW)).toBe(null)
    expect(windowNow({ percent: 95, resetsAt: null }, NOW)?.percent).toBe(95)
  })

  test('no reading at all stays in gear', () => {
    expect(gearFor(usage(null, null), config, auto, NOW).isShifted).toBe(false)
  })

  test('a hand on the lever wins until its time passes', () => {
    const lifted = gearFor(usage(95, 10), config, { mode: 'lift', until: NOW + 100 }, NOW)
    expect(lifted.isShifted).toBe(false)
    expect(lifted.reason).toBe('lifted by hand')
    expect(gearFor(usage(95, 10), config, { mode: 'lift', until: NOW + 100 }, NOW + 100).isShifted).toBe(true)
    expect(gearFor(usage(5, 10), config, { mode: 'shift', until: null }, NOW).isShifted).toBe(true)
  })
})

describe('what a shift changes', () => {
  const step = { model: 'claude-opus-5-5', effort: 'high' as const }

  test('Sonnet swaps the model, by its full id, and leaves effort alone', () => {
    expect(stepChange(step, to('sonnet'))).toEqual({ model: 'claude-sonnet-5-5' })
    expect(stepChange({ model: 'claude-sonnet-5-5', effort: 'high' }, to('sonnet'))).toBe(null)
    expect(stepChange({ model: 'haiku', effort: 'high' }, to('sonnet'))).toBe(null)
    expect(stepChange(step, to('sonnet', 'claude-haiku-5-5'))).toEqual({ model: 'claude-haiku-5-5' })
    expect(stepChange({ model: 'claude-haiku-5-5', effort: 'high' }, to('sonnet', 'claude-haiku-5-5'))).toBe(null)
  })

  test('low effort lowers the effort and leaves the model alone', () => {
    expect(stepChange(step, to('effort'))).toEqual({ effort: 'low' })
    expect(stepChange({ model: 'claude-opus-5-5', effort: 'low' }, to('effort'))).toBe(null)
    expect(stepChange({ model: 'claude-opus-5-5' }, to('effort'))).toBe(null) // a model without effort
  })

  test('both does both, and warn does nothing', () => {
    expect(stepChange(step, to('both'))).toEqual({ model: 'claude-sonnet-5-5', effort: 'low' })
    expect(stepChange(step, to('warn'))).toBe(null)
  })

  test('a subagent goes to Sonnet unless it was already cheap', () => {
    expect(spawnModel({ parentModel: 'claude-opus-5-5' }, to('sonnet'))).toBe('claude-sonnet-5-5')
    expect(spawnModel({ model: 'haiku', parentModel: 'claude-opus-5-5' }, to('sonnet'))).toBe(null)
    expect(spawnModel({ parentModel: 'claude-sonnet-5-5' }, to('both'))).toBe(null)
    expect(spawnModel({ parentModel: 'claude-opus-5-5' }, to('effort'))).toBe(null)
  })

  test('the option labels map to a shift, and an unknown one switches to Sonnet', () => {
    expect(shiftFor('lower effort')).toBe('effort')
    expect(shiftFor('Sonnet and lower effort')).toBe('both')
    expect(shiftFor('warn only')).toBe('warn')
    expect(shiftFor(undefined)).toBe('sonnet')
  })

  test('a model id reads as a short name', () => {
    expect(modelWords('claude-sonnet-5-5')).toBe('Sonnet 5.5')
    expect(modelWords('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(modelWords('claude-opus-5')).toBe('Opus 5')
    expect(modelWords('my-gateway-model')).toBe('my-gateway-model')
    expect(shiftWords(to('both'))).toBe('Sonnet 5.5 · low effort')
    expect(shiftWords(to('sonnet', 'claude-haiku-5-5'))).toBe('Haiku 5.5')
  })
})

describe('pace', () => {
  test('a window spent faster than the clock runs out before it resets', () => {
    // 4 hours into the 5h window, 90% used: at this pace it empties in about 27 minutes.
    const tank = { percent: 90, resetsAt: NOW + 3600_000 }
    const pace = paceOf(tank, LENGTH.fiveHour, NOW)
    expect(pace?.runsOutAt).toBeGreaterThan(NOW)
    expect(pace?.runsOutAt).toBeLessThan(NOW + 3600_000)
    expect(Math.round(pace!.perHour)).toBe(23)
  })

  test('a window spent slower than the clock lasts', () => {
    expect(paceOf({ percent: 20, resetsAt: NOW + 3600_000 }, LENGTH.fiveHour, NOW)?.runsOutAt).toBe(null)
  })

  test('too early in the window, or without a reset time, there is no pace', () => {
    expect(paceOf({ percent: 5, resetsAt: NOW + LENGTH.fiveHour - 1000 }, LENGTH.fiveHour, NOW)).toBe(null)
    expect(paceOf({ percent: 50, resetsAt: null }, LENGTH.fiveHour, NOW)).toBe(null)
    expect(paceOf(null, LENGTH.fiveHour, NOW)).toBe(null)
  })
})

describe('words', () => {
  test('a time today is a clock, another day gets its weekday', () => {
    const at = new Date(NOW)
    at.setHours(14, 10, 0, 0)
    expect(clock(at.getTime(), NOW)).toBe('14:10')
    expect(clock(at.getTime() + 2 * 86_400_000, NOW)).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) 14:10$/)
  })

  test('spans read in minutes, hours and days', () => {
    expect(span(48 * 60_000)).toBe('48m')
    expect(span(108 * 60_000)).toBe('1h 48m')
    expect(span(2 * 3600_000)).toBe('2h')
    expect(span(51 * 3600_000)).toBe('2d 3h')
  })
})
