// The fuel dials: a shallow arc with F at full (left) and E at empty (right), a red reserve at
// the E end. Same dial library and palette as the tach. Each dial reads how much of its tank is
// used: the plan's five-hour or seven-day rate-limit window, or this session's context.

import type { SessionRateLimit } from 'claude-code'

import type { RedlineTank, RedlineUsage } from '../types'
import type { Canvas } from './canvas'
import { dial, shallow } from './dial'
import { Dots } from './dots'
import { DIAL, DIAL_DIM, HUB, LARGE, NEEDLE, RED_C, SMALL, TICK, tachDots, type Reading } from './gauge'

/** How much of each tank is used, 0 to 1; null while that tank has no reading. */
export type Tanks = { fiveHour: number | null; sevenDay: number | null; context: number | null }

export type FuelFace = { cols: number; rows: number; big: boolean }

/** Beside the tach in the band: 4 rows, a label but no F/E letters. */
export const MINI: FuelFace = { cols: 11, rows: 4, big: false }
/** Under the tach in the pane: 6 rows, labelled F and E. */
export const BIG: FuelFace = { cols: 15, rows: 6, big: true }

const GAP = 2
export const BAND_COLS = SMALL.cols + GAP + 3 * MINI.cols + 2 * GAP

/** How the pane fits the three big dials into `columns`: as many to a row as fit, 1 to 3. */
export type PaneLayout = { perRow: number; cols: number; rows: number }

export function paneLayout(columns: number): PaneLayout {
  const perRow = Math.max(1, Math.min(3, Math.floor((columns + GAP) / (BIG.cols + GAP))))
  const lines = Math.ceil(3 / perRow)
  return {
    perRow,
    cols: Math.max(LARGE.cols, perRow * BIG.cols + (perRow - 1) * GAP),
    rows: LARGE.rows + lines * (BIG.rows + 1),
  }
}

/** The pane at its widest: the three dials in one row under the tach. */
export const WIDE = paneLayout(Infinity)
/** The tallest the pane's dash gets: one dial to a row. */
export const TALL = paneLayout(0)

const FROM = (150 / 180) * Math.PI
const SWEEP = (120 / 180) * Math.PI
const RESERVE = 0.85 // the red band starts here, as a fraction of the tank used

export function fuelDial(face: FuelFace, frac: number | null, label: string): Dots {
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
      count: face.big ? 8 : 6,
      majorEvery: face.big ? 4 : 3,
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
          inner: face.big ? 4 : 2.5,
          tail: face.big ? 2.5 : 0,
          width: face.big ? 1.4 : 1.0,
          hub: { color: HUB },
        },
  })

  dots.text(0, Math.round(face.cols / 2 - label.length / 2), label, dim ? DIAL_DIM : TICK)
  if (face.big) {
    dots.text(face.rows - 2, 0, 'F', dim ? DIAL_DIM : TICK)
    dots.text(face.rows - 2, face.cols - 1, 'E', dim ? DIAL_DIM : RED_C)
  }
  return dots
}

const LABELS = ['5H', '7D', 'CTX'] as const

const dialsFor = (face: FuelFace, tanks: Tanks): Dots[] =>
  [tanks.fiveHour, tanks.sevenDay, tanks.context].map((frac, i) => fuelDial(face, frac, LABELS[i]!))

/** The band's dash: the tach with the three small dials beside it. */
export function bandCanvas(reading: Reading, tanks: Tanks): Canvas {
  const out = new Dots(BAND_COLS, SMALL.rows)
  out.blit(tachDots(SMALL, reading), 0, 0)
  dialsFor(MINI, tanks).forEach((panel, i) => out.blit(panel, 0, SMALL.cols + GAP + i * (MINI.cols + GAP)))
  return out.toCanvas()
}

/** The pane's dash: the tach with the three big dials under it, `layout.perRow` to a row, centered. */
export function paneCanvas(reading: Reading, tanks: Tanks, layout: PaneLayout = WIDE): Canvas {
  const out = new Dots(layout.cols, layout.rows)
  out.blit(tachDots(LARGE, reading), 0, Math.floor((layout.cols - LARGE.cols) / 2))
  const rowCols = layout.perRow * BIG.cols + (layout.perRow - 1) * GAP
  const left = Math.floor((layout.cols - rowCols) / 2)
  dialsFor(BIG, tanks).forEach((panel, i) => {
    const line = Math.floor(i / layout.perRow)
    const slot = i % layout.perRow
    out.blit(panel, LARGE.rows + 1 + line * (BIG.rows + 1), left + slot * (BIG.cols + GAP))
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
