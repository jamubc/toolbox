// The one line above the prompt: the gear when shifted, the windows, the context, and who
// needs you. Each piece is a segment with a tone; the renderer colors them. Pure.

import type { RedlineUsage } from '../types'
import type { Row } from './fleet'
import { tally } from './fleet'
import { type Gear, type LimiterConfig, shiftWords, windowNow } from './limiter'

export type Tone = 'dim' | 'plain' | 'amber' | 'red'
export type Segment = { text: string; tone: Tone }

export type BandInput = {
  usage: RedlineUsage
  gear: Gear
  shift: Pick<LimiterConfig, 'shift' | 'model'>
  redlineAt: number
  weeklyRedlineAt: number
  rows: readonly Row[]
  now: number
}

/** The tone a percent reads in, against its redline: red at it, amber within 20 points of it. */
export function toneFor(percent: number, redlineAt: number): Tone {
  if (percent >= redlineAt) return 'red'
  if (percent >= redlineAt - 20) return 'amber'
  return 'dim'
}

export const CONTEXT_REDLINE = 85

/** The band's segments, in order; empty when there is nothing to say. */
export function bandSegments(input: BandInput): Segment[] {
  const out: Segment[] = []
  if (input.gear.isShifted) out.push({ text: `⇣ ${shiftWords(input.shift)}`, tone: 'red' })
  const five = windowNow(input.usage.fiveHour, input.now)
  if (five) out.push({ text: `5h ${Math.round(five.percent)}%`, tone: toneFor(five.percent, input.redlineAt) })
  const week = windowNow(input.usage.sevenDay, input.now)
  if (week) out.push({ text: `7d ${Math.round(week.percent)}%`, tone: toneFor(week.percent, input.weeklyRedlineAt) })
  if (input.usage.context !== null) {
    out.push({ text: `ctx ${Math.round(input.usage.context)}%`, tone: toneFor(input.usage.context, CONTEXT_REDLINE) })
  }
  const { needYou, working } = tally(input.rows)
  if (needYou) out.push({ text: needYou === 1 ? '1 session needs you' : `${needYou} sessions need you`, tone: 'red' })
  if (working) out.push({ text: `${working} working`, tone: 'dim' })
  return out
}

/** True when the band has something worth a line: the gear, a session that needs you, or a tank near its redline. */
export function matters(segments: readonly Segment[]): boolean {
  return segments.some(s => s.tone === 'red' || s.tone === 'amber')
}

/** The segments as one line, cut to `columns`. */
export function bandLine(segments: readonly Segment[], columns: number): string {
  const line = segments.map(s => s.text).join('  ·  ')
  return line.length <= columns ? line : `${line.slice(0, Math.max(0, columns - 1))}…`
}
