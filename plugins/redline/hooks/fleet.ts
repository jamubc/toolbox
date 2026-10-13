// The other Claude sessions on this machine, and which of them need you. Two sources: what
// `claude agents --json` lists (every interactive session, busy or idle), and the heartbeat each
// session running redline writes to the shared store (exact state: working, waiting on you and
// for what, idle since when, context, cost, gear). Pure functions: the wiring is in register.tsx.

import type { RedlineBeat } from '../types'


/** A heartbeat older than this is a session that has gone. */
export const STALE_MS = 3 * 60_000
/** An idle session that finished its turn within this long is shown as done, not idle. */
export const DONE_MS = 10 * 60_000

export type Agent = { sessionId: string; pid: number | null; cwd: string; name: string; status: 'busy' | 'idle' | 'waiting' | '' }

/** The interactive sessions in what `claude agents --json` printed; nothing for anything else. */
export function agentsIn(json: string): Agent[] {
  let rows: unknown
  try {
    rows = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  const out: Agent[] = []
  for (const row of rows as Record<string, unknown>[]) {
    if (!row || typeof row !== 'object' || row.kind !== 'interactive' || typeof row.sessionId !== 'string') continue
    const status = row.status === 'busy' || row.status === 'idle' || row.status === 'waiting' ? row.status : ''
    out.push({
      sessionId: row.sessionId,
      pid: typeof row.pid === 'number' ? row.pid : null,
      cwd: typeof row.cwd === 'string' ? row.cwd : '',
      name: typeof row.name === 'string' ? row.name : '',
      status,
    })
  }
  return out
}

export type RowState = 'waiting' | 'working' | 'done' | 'idle'

export type Row = {
  id: string
  folder: string
  name: string
  state: RowState
  /** What it waits for, or '' */
  waitingFor: string
  /** How long it has been in this state, in ms; null when unknown. */
  forMs: number | null
  isThis: boolean
  beat: RedlineBeat | null
}

export const folder = (cwd: string) => cwd.slice(cwd.lastIndexOf('/') + 1) || cwd || '?'

const ORDER: Record<RowState, number> = { waiting: 0, working: 1, done: 2, idle: 3 }

/** Every session, merged from the two sources, those that need you first. */
export function fleet(agents: readonly Agent[], beats: readonly RedlineBeat[], selfId: string, now: number): Row[] {
  const fresh = new Map(beats.filter(b => now - b.at < STALE_MS).map(b => [b.id, b]))
  const rows = new Map<string, Row>()
  for (const a of agents) {
    const beat = fresh.get(a.sessionId) ?? null
    rows.set(a.sessionId, rowFor(a.sessionId, a.cwd, a.name, beat, a.status, selfId, now))
  }
  for (const b of fresh.values()) {
    if (!rows.has(b.id)) rows.set(b.id, rowFor(b.id, b.cwd, '', b, '', selfId, now))
  }
  // The session that has waited on you longest comes first; among the rest, the most recent change.
  const byTime = (x: Row, y: Row) => (x.forMs === null || y.forMs === null ? 0 : x.state === 'waiting' ? y.forMs - x.forMs : x.forMs - y.forMs)
  return [...rows.values()].sort((x, y) => ORDER[x.state] - ORDER[y.state] || byTime(x, y) || x.folder.localeCompare(y.folder))
}

function rowFor(id: string, cwd: string, name: string, beat: RedlineBeat | null, status: Agent['status'], selfId: string, now: number): Row {
  const base = { id, folder: folder(beat?.cwd || cwd), name, isThis: id === selfId, beat }
  if (beat) {
    const forMs = now - beat.since
    if (beat.state === 'waiting') return { ...base, state: 'waiting', waitingFor: beat.waitingFor, forMs }
    if (beat.state === 'working') return { ...base, state: 'working', waitingFor: '', forMs }
    return { ...base, state: beat.turns > 0 && forMs < DONE_MS ? 'done' : 'idle', waitingFor: '', forMs }
  }
  if (status === 'waiting') return { ...base, state: 'waiting', waitingFor: 'you', forMs: null }
  if (status === 'busy') return { ...base, state: 'working', waitingFor: '', forMs: null }
  return { ...base, state: 'idle', waitingFor: '', forMs: null }
}

/** The counts the band shows, this session left out. */
export function tally(rows: readonly Row[]): { needYou: number; working: number } {
  const others = rows.filter(r => !r.isThis)
  return { needYou: others.filter(r => r.state === 'waiting').length, working: others.filter(r => r.state === 'working').length }
}
