// The three dials on the dash: the plan's five-hour and seven-day windows, and this session's
// context. Each is a shallow arc with F at the left and E at the right, a red reserve at the E
// end, drawn in braille with the dial library. The plan windows drain, so their needles swing
// from F to E as the window is used; the context fills, so its dial reads E to F.

import type { SessionRateLimit } from 'claude-code'

import type { RedlineTank, RedlineUsage } from '../types'
import type { Canvas } from './canvas'
import { dial, shallow } from './dial'
import { Dots } from './dots'

export const DIAL = 0x6c6c6c
export const DIAL_DIM = 0x4a4a4a
export const TICK = 0xd0d0d0
export const AMBER_C = 0xffaf00
export const RED_C = 0xff3b30
export const NEEDLE = 0xff875f
export const HUB = 0xeeeeee

/** The needle's scale: a tank's fill in 0-1 is drawn at `frac * SCALE`. */
export const SCALE = 25

/**
 * A damped spring: a needle swings to a new reading with a little overshoot and settles on it,
 * never past the pin at `SCALE` or below 0.
 */
export class Needle {
  value = 0
  private velocity = 0

  /** Moves `dt` seconds toward `target`; returns where the needle reads now. */
  step(target: number, dt: number): number {
    const goal = Math.max(0, Math.min(target, SCALE))
    this.velocity += (18 * (goal - this.value) - 5 * this.velocity) * dt
    this.value += this.velocity * dt
    if (this.value > SCALE) {
      this.value = SCALE
      this.velocity = -Math.abs(this.velocity) * 0.6
    }
    if (this.value < 0) {
      this.value = 0
      this.velocity = Math.abs(this.velocity) * 0.3
    }
    return this.value
  }
}

/** How much of each tank is used, 0 to 1; null while that tank has no reading. */
export type Tanks = { fiveHour: number | null; sevenDay: number | null; context: number | null }

export type FuelFace = { cols: number; rows: number }

/** One dial in the pane: 6 rows, labelled F and E. */
export const BIG: FuelFace = { cols: 15, rows: 6 }

const GAP = 2
const FROM = (150 / 180) * Math.PI
const SWEEP = (120 / 180) * Math.PI
const RESERVE = 0.85 // the red band starts here, as a fraction of the tank used

/**
 * `fills` is for a tank that fills as it is used, the context: it reads E at the left and F at the
 * red end. The plan windows drain, F at the left and E at the red end. Either way the needle
 * swings right, into the red, as the tank is used.
 */
export function fuelDial(face: FuelFace, frac: number | null, label: string, fills = false): Dots {
  const dots = new Dots(face.cols, face.rows)
  const dim = frac === null
  const reserve = (t: number) => t >= RESERVE
  dial(dots, {
    dial: shallow(face.cols, face.rows, FROM, SWEEP),
    arc: {
      colorAt: t => (dim ? DIAL_DIM : reserve(t) ? RED_C : DIAL),
      widthAt: t => (!dim && reserve(t) ? 1 : 0),
    },
    ticks: {
      count: 8,
      majorEvery: 4,
      length: 2,
      majorLength: 3,
      rank: 2,
      colorAt: t => (dim ? DIAL_DIM : reserve(t) ? RED_C : TICK),
    },
    needle: dim
      ? undefined
      : {
          t: frac,
          color: reserve(frac) ? RED_C : NEEDLE,
          inner: 4,
          tail: 2.5,
          width: 1.4,
          hub: { color: HUB },
        },
  })

  dots.text(0, Math.round(face.cols / 2 - label.length / 2), label, dim ? DIAL_DIM : TICK)
  const [start, end] = fills ? ['E', 'F'] : ['F', 'E']
  dots.text(face.rows - 2, 0, start, dim ? DIAL_DIM : TICK)
  dots.text(face.rows - 2, face.cols - 1, end, dim ? DIAL_DIM : RED_C)
  return dots
}

export const LABELS = ['5H', '7D', 'CTX'] as const

/** How the dash fits the three dials into `columns`: as many to a row as fit, 1 to 3. */
export type DashLayout = { perRow: number; cols: number; rows: number }

export function dashLayout(columns: number): DashLayout {
  const perRow = Math.max(1, Math.min(3, Math.floor((columns + GAP) / (BIG.cols + GAP))))
  const lines = Math.ceil(3 / perRow)
  return { perRow, cols: perRow * BIG.cols + (perRow - 1) * GAP, rows: lines * BIG.rows + (lines - 1) }
}

/** The dash at its widest: the three dials in one row. */
export const WIDE = dashLayout(Infinity)

/** The dash: the three dials, `layout.perRow` to a row, each row centered. */
export function dashCanvas(tanks: Tanks, layout: DashLayout = WIDE): Canvas {
  const out = new Dots(layout.cols, layout.rows)
  const dials = [tanks.fiveHour, tanks.sevenDay, tanks.context].map((frac, i) => fuelDial(BIG, frac, LABELS[i]!, i === 2))
  dials.forEach((panel, i) => {
    const line = Math.floor(i / layout.perRow)
    const inLine = Math.min(layout.perRow, dials.length - line * layout.perRow)
    const left = Math.floor((layout.cols - (inLine * BIG.cols + (inLine - 1) * GAP)) / 2)
    out.blit(panel, line * (BIG.rows + 1), left + (i % layout.perRow) * (BIG.cols + GAP))
  })
  return out.toCanvas()
}

/** A tank's fill from its last reading: emptied once its reset time has passed. */
export function tankFrac(tank: RedlineTank | null, now: number): number | null {
  if (tank === null) return null
  if (tank.resetsAt !== null && now >= tank.resetsAt) return 0
  return Math.max(0, Math.min(1, tank.percent / 100))
}

/** A bare percentage, clamped, as a fill; null stays null. */
export const fracOf = (percent: number | null): number | null => (percent === null ? null : Math.max(0, Math.min(1, percent / 100)))

/** Where each tank sits now, from the last figures: the plan windows empty once they reset. */
export function tanksNow(usage: RedlineUsage, now: number): Tanks {
  return { fiveHour: tankFrac(usage.fiveHour, now), sevenDay: tankFrac(usage.sevenDay, now), context: fracOf(usage.context) }
}

/** The two plan windows and the context, from what a measurement reported. */
export function usageFrom(rateLimits: readonly SessionRateLimit[], contextPercent: number | null): RedlineUsage {
  const tank = (kind: string): RedlineTank | null => {
    const limit = rateLimits.find(l => l.kind === kind)
    if (!limit) return null
    const parsed = limit.resetsAt === undefined ? NaN : Date.parse(limit.resetsAt)
    return { percent: limit.percentUsed, resetsAt: Number.isFinite(parsed) ? parsed : null }
  }
  return { fiveHour: tank('five_hour'), sevenDay: tank('seven_day'), context: contextPercent }
}
