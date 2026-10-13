// The rev limiter: where the redline sits on each plan window, whether the needle is past it,
// and what to do about a model request when it is. Pure functions: the wiring is in register.tsx.

import type { RedlineTank, RedlineUsage } from '../types'

/** What the limiter does to a request once it is engaged. */
export type Shift = 'effort' | 'sonnet' | 'both' | 'warn'

export type LimiterConfig = {
  /** Percent of the five-hour window used at which the limiter engages. */
  redlineAt: number
  /** Percent of the seven-day window used at which the limiter engages. */
  weeklyRedlineAt: number
  shift: Shift
  /** The full id of the model a shift sends requests to; an alias is refused by the engine. */
  model: string
}

export const DEFAULT_MODEL = 'claude-sonnet-5-5'

/** A model id as a short name: `claude-sonnet-5-5` reads Sonnet 5.5. */
export function modelWords(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/i.exec(id)
  if (!m) return id
  const family = m[1]![0]!.toUpperCase() + m[1]!.slice(1)
  return m[3] === undefined ? `${family} ${m[2]}` : `${family} ${m[2]}.${m[3]}`
}

/** The person's say over the automatic limiter: `shift` holds it on, `lift` holds it off, until `until`. */
export type Manual = { mode: 'auto' } | { mode: 'shift' | 'lift'; until: number | null }

export type Gear = { isShifted: boolean; reason: string; until: number | null }

export const SHIFT_OPTIONS = {
  'switch to Sonnet': 'sonnet',
  'lower effort': 'effort',
  'Sonnet and lower effort': 'both',
  'warn only': 'warn',
} as const satisfies Record<string, Shift>

/** The `shift` option's label as the manifest lists it, to what it means; an unknown label switches to Sonnet. */
export function shiftFor(label: unknown): Shift {
  return (SHIFT_OPTIONS as Record<string, Shift>)[String(label)] ?? 'sonnet'
}

export const LENGTH = { fiveHour: 5 * 3600_000, sevenDay: 7 * 86_400_000 } as const

/** A window's reading as it stands now: empty once its reset time has passed. */
export function windowNow(tank: RedlineTank | null, now: number): RedlineTank | null {
  if (tank === null) return null
  if (tank.resetsAt !== null && now >= tank.resetsAt) return null
  return tank
}

/**
 * Whether the limiter is engaged now: by hand (`manual`), or because a window is at or past
 * its redline. `until` is when the engaging window resets, so the pane can say when it lifts.
 */
export function gearFor(usage: RedlineUsage, config: LimiterConfig, manual: Manual, now: number): Gear {
  if (manual.mode !== 'auto' && (manual.until === null || now < manual.until)) {
    return manual.mode === 'shift'
      ? { isShifted: true, reason: 'shifted by hand', until: manual.until }
      : { isShifted: false, reason: 'lifted by hand', until: manual.until }
  }
  const five = windowNow(usage.fiveHour, now)
  if (five && five.percent >= config.redlineAt) {
    return { isShifted: true, reason: `5h window at ${Math.round(five.percent)}%`, until: five.resetsAt }
  }
  const week = windowNow(usage.sevenDay, now)
  if (week && week.percent >= config.weeklyRedlineAt) {
    return { isShifted: true, reason: `7d window at ${Math.round(week.percent)}%`, until: week.resetsAt }
  }
  return { isShifted: false, reason: '', until: null }
}

const CHEAP = /haiku|sonnet/i

/** True for a model the limiter would not shift any lower: the one it shifts to, or any Sonnet or Haiku. */
export const isCheap = (model: string | undefined, to: string) => model !== undefined && (model === to || CHEAP.test(model))

/** What to rewrite on a model request while shifted: nothing when the request is already there. */
export function stepChange(e: { model: string; effort?: string | number }, config: Pick<LimiterConfig, 'shift' | 'model'>): { model?: string; effort?: 'low' } | null {
  const { shift, model } = config
  const change: { model?: string; effort?: 'low' } = {}
  if ((shift === 'sonnet' || shift === 'both') && !isCheap(e.model, model)) change.model = model
  if ((shift === 'effort' || shift === 'both') && e.effort !== undefined && e.effort !== 'low') change.effort = 'low'
  return Object.keys(change).length ? change : null
}

/** The model a subagent spawned while shifted should run on: null leaves the spawn alone. */
export function spawnModel(e: { model?: string; parentModel: string }, config: Pick<LimiterConfig, 'shift' | 'model'>): string | null {
  if (config.shift !== 'sonnet' && config.shift !== 'both') return null
  if (isCheap(e.model ?? e.parentModel, config.model)) return null
  return config.model
}

/** The words for a shift, as the band and the pane say it. */
export function shiftWords(config: Pick<LimiterConfig, 'shift' | 'model'>): string {
  switch (config.shift) {
    case 'sonnet': return modelWords(config.model)
    case 'effort': return 'low effort'
    case 'both': return `${modelWords(config.model)} · low effort`
    case 'warn': return 'past the redline'
  }
}

export type Pace = {
  /** When the window runs out at the pace so far; null when it lasts to the reset, or there is no pace yet. */
  runsOutAt: number | null
  /** Percent used per hour so far. */
  perHour: number
}

/** How a window is being spent: from its reset time and length, when it started, and how fast it is going. */
export function paceOf(tank: RedlineTank | null, length: number, now: number): Pace | null {
  if (tank === null || tank.resetsAt === null) return null
  const startedAt = tank.resetsAt - length
  const elapsed = now - startedAt
  if (elapsed < length * 0.02 || tank.percent <= 0) return null // too early to say
  const perMs = tank.percent / elapsed
  const runsOutAt = now + (100 - tank.percent) / perMs
  return { runsOutAt: runsOutAt < tank.resetsAt ? runsOutAt : null, perHour: perMs * 3600_000 }
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** A time of day, with the weekday when it is not today's: `14:10`, `Thu 09:00`. */
export function clock(at: number, now: number): string {
  const d = new Date(at)
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const today = new Date(now)
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  return sameDay ? hhmm : `${DAYS[d.getDay()]} ${hhmm}`
}

/** A span in words: `48m`, `1h 48m`, `2d 3h`. */
export function span(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}
