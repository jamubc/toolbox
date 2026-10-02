// The trace: one event per thing a session reached, from whichever layer saw it, with the
// correlation between layers, the JSONL it exports to, and the arcs a moment of it draws.

import type { Arc, LatLon } from './globe'
import { BLOCKED, INBOUND, OUTBOUND, SESSION_COLORS } from './globe'
import type { Place } from './geo'

export type Layer = 'tool' | 'socket' | 'proxy' | 'stream'

export type Status = 'open' | 'closed' | 'done' | 'blocked' | 'asked' | 'failed'

export type TraceEvent = {
  id: string
  /** ms since the epoch when it began. */
  t: number
  /** ms since the epoch of the last byte or change. */
  last: number
  /** The session's pid; 0 when unknown. */
  sessionPid: number
  /** The session's label: the folder and terminal it runs in. */
  session: string
  layer: Layer
  /** The tool that caused it, when known: WebFetch, Bash, mcp__server__tool... */
  tool: string
  /** What the call said: the URL, the query, the command; or the socket's peer. */
  summary: string
  host: string
  ip: string
  port: number
  direction: 'out' | 'in'
  bytesIn: number
  bytesOut: number
  place: Place | null
  status: Status
  /** The process holding the socket. */
  pid: number
  cmd: string
  /** The id of the event in another layer this one was matched to. */
  linked: string
  /** Why it was blocked or what the rule was. */
  note: string
}

export const MAX_EVENTS = 600

let counter = 0
export const nextId = (t: number) => `${t.toString(36)}-${(counter++ % 46656).toString(36)}`

export function newEvent(fields: Partial<TraceEvent> & { t: number; layer: Layer }): TraceEvent {
  return {
    id: nextId(fields.t),
    last: fields.t,
    sessionPid: 0,
    session: '',
    tool: '',
    summary: '',
    host: '',
    ip: '',
    port: 0,
    direction: 'out',
    bytesIn: 0,
    bytesOut: 0,
    place: null,
    status: 'open',
    pid: 0,
    cmd: '',
    linked: '',
    note: '',
    ...fields,
  }
}

/** Keeps the newest events; the oldest finished ones go first. */
export function bounded(events: readonly TraceEvent[]): TraceEvent[] {
  if (events.length <= MAX_EVENTS) return [...events]
  const open = events.filter(e => e.status === 'open')
  const rest = events.filter(e => e.status !== 'open').slice(-(MAX_EVENTS - open.length))
  return [...rest, ...open].sort((a, b) => a.t - b.t)
}

const CORRELATE_MS = 4000

/**
 * Matches a socket event to the tool call that caused it: the newest tool event of the same
 * session within the window that names a host and has no socket yet (or names this host).
 * A Bash command's sockets belong to its child processes and a WebFetch's to Claude Code
 * itself, so the socket's owner has to fit the tool; Anthropic's own addresses never match a
 * call to anyone else.
 */
export function correlate(events: readonly TraceEvent[], socket: TraceEvent): { tool: TraceEvent; host: string } | null {
  const isAnthropicAddress = socket.place?.anycast === 'Anthropic'
  const isMainProcess = socket.pid === socket.sessionPid
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (socket.t - e.t > CORRELATE_MS * 3) break
    if (e.layer !== 'tool' || e.sessionPid !== socket.sessionPid) continue
    if (e.status === 'blocked') continue
    if (socket.t < e.t - 500 || (e.status !== 'open' && socket.t - e.last > CORRELATE_MS)) continue
    if (e.host === '' || e.host.startsWith('mcp:') || e.host === 'web search') continue
    if (e.linked !== '' && e.ip !== socket.ip) continue
    if (e.tool === 'Bash' && isMainProcess) continue
    if ((e.tool === 'WebFetch' || e.tool === 'WebSearch') && !isMainProcess) continue
    if (isAnthropicAddress && !/anthropic|claude/i.test(e.host)) continue
    return { tool: e, host: e.host }
  }
  return null
}

export function toJsonl(events: readonly TraceEvent[]): string {
  return events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '')
}

export function fromJsonl(text: string): TraceEvent[] {
  const out: TraceEvent[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const raw = JSON.parse(line) as Partial<TraceEvent>
      if (typeof raw.t !== 'number' || typeof raw.layer !== 'string') continue
      out.push({ ...newEvent({ t: raw.t, layer: raw.layer as Layer }), ...raw, id: raw.id ?? nextId(raw.t) })
    } catch {
      // a torn line
    }
  }
  return out.sort((a, b) => a.t - b.t)
}

export type Summary = { countries: string[]; orgs: string[]; hosts: string[]; bytesIn: number; bytesOut: number; blocked: number; sessions: number }

export function summarize(events: readonly TraceEvent[]): Summary {
  const countries = new Set<string>()
  const orgs = new Set<string>()
  const hosts = new Set<string>()
  const sessions = new Set<number>()
  let bytesIn = 0
  let bytesOut = 0
  let blocked = 0
  for (const e of events) {
    if (e.place?.country) countries.add(e.place.country)
    if (e.place?.org) orgs.add(e.place.org)
    if (e.host) hosts.add(e.host)
    else if (e.ip) hosts.add(e.ip)
    if (e.sessionPid) sessions.add(e.sessionPid)
    bytesIn += Math.max(0, e.bytesIn)
    bytesOut += Math.max(0, e.bytesOut)
    if (e.status === 'blocked') blocked++
  }
  return { countries: [...countries].sort(), orgs: [...orgs].sort(), hosts: [...hosts].sort(), bytesIn, bytesOut, blocked, sessions: sessions.size }
}

export function formatBytes(n: number): string {
  if (n < 0) return '–'
  if (n < 1024) return `${n}b`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)}k`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}G`
}

export type ArcOptions = {
  now: number
  fadeMs: number
  home: LatLon
  /** Color each session apart (observe-all) instead of by direction. */
  bySession: boolean
  selectedId: string
  /** Events whose Anthropic stream is generating now pulse. */
  isGenerating: boolean
}

/** A stable color per session pid in observe-all mode. */
export function sessionColor(sessionPid: number, sessionPids: readonly number[]): number {
  const i = sessionPids.indexOf(sessionPid)
  return SESSION_COLORS[(i < 0 ? 0 : i) % SESSION_COLORS.length]!
}

export const isAnthropic = (e: TraceEvent): boolean => /anthropic/i.test(e.host) || /anthropic/i.test(e.place?.anycast ?? '') || e.layer === 'stream'

/** The arcs a moment of the trace draws: every placed event still within its fade. */
export function arcsFor(events: readonly TraceEvent[], options: ArcOptions): Arc[] {
  const sessionPids = [...new Set(events.map(e => e.sessionPid))].sort((a, b) => a - b)
  const out: Arc[] = []
  for (const e of events) {
    if (!e.place || (e.place.lat === 0 && e.place.lon === 0)) continue
    if (e.t > options.now) continue
    const isLive = e.status === 'open' && e.t <= options.now
    const age = options.now - (isLive ? Math.max(e.last, options.now - 1) : e.last)
    if (!isLive && age > options.fadeMs) continue
    const fade = isLive ? 1 : 1 - age / options.fadeMs
    const bytes = Math.max(0, e.bytesIn) + Math.max(0, e.bytesOut)
    const weight = Math.min(1, Math.log10(bytes + 1) / 6)
    const recent = options.now - e.last < 1500
    const breathing = isLive && (recent || (options.isGenerating && isAnthropic(e)))
    const color = e.status === 'blocked' ? BLOCKED : options.bySession ? sessionColor(e.sessionPid, sessionPids) : e.direction === 'in' ? INBOUND : OUTBOUND
    const to = { lat: e.place.lat, lon: e.place.lon }
    out.push({
      from: e.direction === 'in' ? to : options.home,
      to: e.direction === 'in' ? options.home : to,
      color,
      strength: Math.max(0.15, Math.min(1, fade * (0.55 + 0.45 * weight) + (breathing ? 0.25 * Math.sin((options.now % 1000) / 1000 * 2 * Math.PI) : 0))),
      progress: e.status === 'blocked' ? 0.35 : Math.min(1, (options.now - e.t) / 700),
      pulse: breathing ? ((options.now % 1200) / 1200) : -1,
      thickness: weight > 0.75 ? 3 : weight > 0.4 ? 2 : 1,
      isDashed: e.status === 'blocked' || (options.bySession && e.direction === 'in'),
      isSelected: e.id === options.selectedId,
    })
  }
  return out
}

/** A replay of a recorded trace: a position on its timeline, moving at `speed` while playing. */
export type Replay = {
  file: string
  events: TraceEvent[]
  start: number
  end: number
  position: number
  speed: number
  isPlaying: boolean
}

export function openReplay(file: string, events: TraceEvent[]): Replay | null {
  if (events.length === 0) return null
  const start = events[0]!.t - 1000
  const end = Math.max(...events.map(e => Math.max(e.t, e.last))) + 5000
  return { file, events, start, end, position: start, speed: 4, isPlaying: true }
}

/** The replay `dtMs` later: the position advances while playing and stops at the end. */
export function stepReplay(r: Replay, dtMs: number): Replay {
  if (!r.isPlaying) return r
  const position = Math.min(r.end, r.position + dtMs * r.speed)
  return { ...r, position, isPlaying: position < r.end }
}

/** Events as they stood at `position`: begun by then, with their later changes hidden. */
export function eventsAt(r: Replay, position: number): TraceEvent[] {
  return r.events
    .filter(e => e.t <= position)
    .map(e => (e.last > position ? { ...e, last: position, status: 'open' as Status } : e))
}

export function scrubber(r: Replay, width: number): string {
  const n = Math.max(4, width)
  const at = Math.round(((r.position - r.start) / Math.max(1, r.end - r.start)) * (n - 1))
  return Array.from({ length: n }, (_, i) => (i < at ? '━' : i === at ? '●' : '─')).join('')
}
