import { describe, expect, test } from 'claude-code/testing'

import type { Canvas } from '../hooks/canvas'
import { NEEDLE, RED_C, SMALL, DIAL_DIM } from '../hooks/gauge'
import { BIG, BAND_COLS, MINI, PANE_COLS, PANE_ROWS, bandCanvas, fracOf, fuelDial, paneCanvas, tankFrac, usageFrom } from '../hooks/fuel'

const text = (cv: Canvas) => Array.from({ length: cv.rows }, (_, r) => cv.line(r)).join('\n')

/** The foreground colors of every cell, once per cell. */
const colors = (cv: Canvas) => {
  const out: number[] = []
  for (let i = 1; i < cv.cells.length; i += 3) out.push(cv.cells[i]!)
  return out
}

const has = (cv: Canvas, color: number) => colors(cv).includes(color)

/** Foreground colors of the cells in columns [c0, c1), for looking at one dial alone. */
const regionColors = (cv: Canvas, c0: number, c1: number) => {
  const out: number[] = []
  for (let r = 0; r < cv.rows; r++) for (let c = c0; c < c1; c++) out.push(cv.cells[(r * cv.cols + c) * 3 + 1]!)
  return out
}

const RESET = '2026-10-02T20:00:00.000Z'

describe('fuel dials', () => {
  test('a big dial wears its label and F and E ends', () => {
    const big = text(fuelDial(BIG, 0.4, '5H').toCanvas())
    expect(big).toContain('5H')
    expect(big).toContain('F')
    expect(big).toContain('E')
  })

  test('the needle travels as the tank is used', () => {
    const shots = [0, 0.5, 1].map(frac => text(fuelDial(BIG, frac, '5H').toCanvas()))
    expect(new Set(shots).size).toBe(3)
  })

  test('the needle turns red in the reserve, and a dial with no reading shows no needle', () => {
    expect(has(fuelDial(BIG, 0.4, '5H').toCanvas(), NEEDLE)).toBe(true)
    expect(has(fuelDial(BIG, 0.9, '5H').toCanvas(), NEEDLE)).toBe(false)
    expect(has(fuelDial(BIG, 0.9, '5H').toCanvas(), RED_C)).toBe(true)

    const dark = fuelDial(BIG, null, '5H')
    expect(has(dark.toCanvas(), NEEDLE)).toBe(false)
    expect(has(dark.toCanvas(), RED_C)).toBe(false)
    expect(has(dark.toCanvas(), DIAL_DIM)).toBe(true)
    expect(text(dark.toCanvas())).toContain('5H')
    expect(text(fuelDial(BIG, null, '5H').toCanvas())).toBe(text(dark.toCanvas()))
  })

  test('a tank reads its percent, clamped, and empties when its window resets', () => {
    const reset = Date.parse(RESET)
    expect(tankFrac({ percent: 42, resetsAt: null }, 0)).toBe(0.42)
    expect(tankFrac({ percent: 120, resetsAt: null }, 0)).toBe(1)
    expect(tankFrac({ percent: 71, resetsAt: reset }, reset - 1)).toBe(0.71)
    expect(tankFrac({ percent: 71, resetsAt: reset }, reset + 1)).toBe(0)
    expect(tankFrac(null, 0)).toBe(null)
    expect(fracOf(55)).toBe(0.55)
    expect(fracOf(120)).toBe(1)
    expect(fracOf(null)).toBe(null)
  })

  test('reads the two plan windows and the context from a measurement', () => {
    const usage = usageFrom(
      [
        { kind: 'five_hour', percentUsed: 42, resetsAt: RESET },
        { kind: 'seven_day', percentUsed: 71 },
        { kind: 'spend_limit', percentUsed: 3 },
      ],
      55,
    )
    expect(usage.fiveHour).toEqual({ percent: 42, resetsAt: Date.parse(RESET) })
    expect(usage.sevenDay).toEqual({ percent: 71, resetsAt: null })
    expect(usage.context).toBe(55)
    expect(usageFrom([], null)).toEqual({ fiveHour: null, sevenDay: null, context: null })
  })
})

describe('the fuel dash', () => {
  const reading = { needle: 6, isNapping: false, isVenting: false, t: 0 }
  const tanks = { fiveHour: 0.42, sevenDay: 0.71, context: 0.55 }

  test('the band puts the three small dials beside the tach', () => {
    const cv = bandCanvas(reading, tanks)
    expect([cv.rows, cv.cols]).toEqual([SMALL.rows, BAND_COLS])
    const s = text(cv)
    expect(s).toContain('5H')
    expect(s).toContain('7D')
    expect(s).toContain('CTX')
  })

  test('the pane stacks the three big dials under the tach', () => {
    const cv = paneCanvas({ ...reading, needle: 14 }, tanks)
    expect([cv.rows, cv.cols]).toEqual([PANE_ROWS, PANE_COLS])
    const s = text(cv)
    expect(s).toContain('CLAUDES')
    expect(s).toContain('5H')
    expect(s).toContain('CTX')
  })

  test('a band without readings still shows the three dim dials', () => {
    const cv = bandCanvas(reading, { fiveHour: null, sevenDay: null, context: null })
    const s = text(cv)
    expect(s).toContain('5H')
    expect(s).toContain('7D')
    expect(s).toContain('CTX')
    const fuel = regionColors(cv, SMALL.cols + 2, BAND_COLS)
    expect(fuel.includes(NEEDLE)).toBe(false)
    expect(fuel.includes(DIAL_DIM)).toBe(true)
  })
})
