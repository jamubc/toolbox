import { describe, expect, test } from 'claude-code/testing'

import type { Canvas } from '../hooks/canvas'
import { BIG, DIAL_DIM, NEEDLE, Needle, RED_C, SCALE, WIDE, dashCanvas, dashLayout, fracOf, fuelDial, tankFrac, tanksNow, usageFrom } from '../hooks/fuel'

const text = (cv: Canvas) => Array.from({ length: cv.rows }, (_, r) => cv.line(r)).join('\n')

/** The foreground colors of every cell, once per cell. */
const colors = (cv: Canvas) => {
  const out: number[] = []
  for (let i = 1; i < cv.cells.length; i += 3) out.push(cv.cells[i]!)
  return out
}
const has = (cv: Canvas, color: number) => colors(cv).includes(color)

const RESET = '2026-10-02T20:00:00.000Z'

describe('a dial', () => {
  test('wears its label and F and E ends, in braille', () => {
    const big = text(fuelDial(BIG, 0.4, '5H').toCanvas())
    expect(big).toContain('5H')
    expect(big).toMatch(/[⠁-⣿]/)
    expect(big).toContain('F')
    expect(big).toContain('E')
  })

  test('the context fills, so its dial reads E to F; the plan windows drain, F to E', () => {
    const ends = (cv: { rows: number; line(r: number): string }) => cv.line(cv.rows - 2).trim()
    expect(ends(fuelDial(BIG, 0.4, 'CTX', true).toCanvas())).toMatch(/^E.*F$/)
    expect(ends(fuelDial(BIG, 0.4, '5H').toCanvas())).toMatch(/^F.*E$/)
  })

  test('the needle travels as the tank is used, and turns red in the reserve', () => {
    const shots = [0, 0.5, 1].map(frac => text(fuelDial(BIG, frac, '5H').toCanvas()))
    expect(new Set(shots).size).toBe(3)
    expect(has(fuelDial(BIG, 0.4, '5H').toCanvas(), NEEDLE)).toBe(true)
    expect(has(fuelDial(BIG, 0.9, '5H').toCanvas(), NEEDLE)).toBe(false)
    expect(has(fuelDial(BIG, 0.9, '5H').toCanvas(), RED_C)).toBe(true)
  })

  test('a dial with no reading is dim and has no needle', () => {
    const dark = fuelDial(BIG, null, '5H').toCanvas()
    expect(has(dark, NEEDLE)).toBe(false)
    expect(has(dark, RED_C)).toBe(false)
    expect(has(dark, DIAL_DIM)).toBe(true)
    expect(text(dark)).toContain('5H')
  })

  test('the needle springs to a reading and never passes the pin', () => {
    const needle = new Needle()
    let peak = 0
    for (let i = 0; i < 60; i++) peak = Math.max(peak, needle.step(10, 0.1))
    expect(peak).toBeGreaterThan(10)
    expect(Math.abs(needle.value - 10)).toBeLessThan(0.5)
    let highest = 0
    for (let i = 0; i < 100; i++) highest = Math.max(highest, needle.step(SCALE + 10, 0.1))
    expect(highest).toBeLessThanOrEqual(SCALE)
  })
})

describe('the dash', () => {
  const tanks = { fiveHour: 0.42, sevenDay: 0.71, context: 0.55 }

  test('puts the three dials in a row, and stacks them when narrow', () => {
    expect(dashLayout(WIDE.cols).perRow).toBe(3)
    expect(dashLayout(WIDE.cols - 1).perRow).toBe(2)
    expect(dashLayout(2 * BIG.cols + 1).perRow).toBe(1)
    for (const columns of [WIDE.cols, 2 * BIG.cols + 2, BIG.cols]) {
      const layout = dashLayout(columns)
      const cv = dashCanvas(tanks, layout)
      expect([cv.rows, cv.cols]).toEqual([layout.rows, layout.cols])
      for (const label of ['5H', '7D', 'CTX']) expect(text(cv)).toContain(label)
    }
  })
})

describe('readings', () => {
  test('a tank reads its percent, clamped, and empties when its window resets', () => {
    const reset = Date.parse(RESET)
    expect(tankFrac({ percent: 42, resetsAt: null }, 0)).toBe(0.42)
    expect(tankFrac({ percent: 120, resetsAt: null }, 0)).toBe(1)
    expect(tankFrac({ percent: 71, resetsAt: reset }, reset - 1)).toBe(0.71)
    expect(tankFrac({ percent: 71, resetsAt: reset }, reset + 1)).toBe(0)
    expect(tankFrac(null, 0)).toBe(null)
    expect(fracOf(55)).toBe(0.55)
    expect(fracOf(null)).toBe(null)
    expect(tanksNow({ fiveHour: { percent: 42, resetsAt: null }, sevenDay: null, context: 10 }, 0)).toEqual({ fiveHour: 0.42, sevenDay: null, context: 0.1 })
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
