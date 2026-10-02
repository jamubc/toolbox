// The live trace: what the layers report, folded into events. No `$` here; register.tsx feeds
// it what the host said and writes what changed to the state.

import { type Place, UNKNOWN_PLACE, anycastOf, formatIp, isLocal, orgOfHost, parseIp, placeOf, type GeoAnswer } from './geo'
import type { Counter, Socket } from './procs'
import { isRemote, socketKey } from './procs'
import type { Intent } from './tools'
import { type TraceEvent, bounded, correlate, newEvent } from './trace'

export type Owner = { sessionPid: number; session: string; cmd: string }

/** Anthropic's API is anycast; with no database its arc lands at the company's home, and says so. */
const ANTHROPIC_FALLBACK: Place = { lat: 37.77, lon: -122.42, country: 'US', city: 'San Francisco (anycast, drawn at HQ)', org: 'Anthropic', isAnycast: true, anycast: 'Anthropic' }

export class Live {
  events: TraceEvent[] = []
  /** Socket key → event id, for the sockets seen at the last poll. */
  flows = new Map<string, string>()
  /** Proxy connection id → event id. */
  proxyFlows = new Map<number, string>()
  /** pid → the ports it listens on, to tell inbound connections. */
  listening = new Map<number, Set<number>>()
  /** ip → its place, once looked up; UNKNOWN_PLACE when the database had nothing. */
  geo = new Map<string, Place>()
  pendingIps = new Set<string>()
  /** Whether anything changed since the state was last written. */
  isDirty = false
  /** How many events were added since the last write (for the status line). */
  private byId = new Map<string, TraceEvent>()

  load(events: readonly TraceEvent[]): void {
    this.events = [...events]
    this.byId = new Map(this.events.map(e => [e.id, e]))
    for (const e of this.events) if (e.ip && e.place) this.geo.set(e.ip, e.place)
  }

  get(id: string): TraceEvent | undefined {
    return this.byId.get(id)
  }

  private add(e: TraceEvent): TraceEvent {
    this.events.push(e)
    this.byId.set(e.id, e)
    if (this.events.length > 700) {
      this.events = bounded(this.events)
      this.byId = new Map(this.events.map(x => [x.id, x]))
    }
    this.isDirty = true
    return e
  }

  patch(id: string, fields: Partial<TraceEvent>): TraceEvent | undefined {
    const e = this.byId.get(id)
    if (!e) return undefined
    const next = { ...e, ...fields }
    this.events[this.events.indexOf(e)] = next
    this.byId.set(id, next)
    this.isDirty = true
    return next
  }

  /** A tool call about to run: one event per host it names, or one for the server or search. */
  recordTool(intent: Intent, owner: Owner, now: number, status: TraceEvent['status'], note = ''): TraceEvent[] {
    const base = { t: now, layer: 'tool' as const, tool: intent.tool, summary: intent.summary, status, note, sessionPid: owner.sessionPid, session: owner.session, pid: owner.sessionPid, cmd: owner.cmd }
    const hosts = intent.kind === 'host' ? intent.hosts : []
    if (hosts.length === 0) {
      const host = intent.kind === 'mcp' ? `mcp:${intent.server}` : intent.kind === 'search' ? 'web search' : ''
      const place = intent.kind === 'none' ? null : { ...UNKNOWN_PLACE, org: intent.kind === 'search' ? 'Anthropic (search)' : '' }
      return [this.add(newEvent({ ...base, host, place }))]
    }
    return hosts.map(host => {
      const ip = parseIp(host)
      const known = ip ? this.geo.get(formatIp(ip)) : undefined
      const org = orgOfHost(host)
      const place = known ?? (org === 'Anthropic' ? ANTHROPIC_FALLBACK : { ...UNKNOWN_PLACE, org, isAnycast: false })
      const e = this.add(newEvent({ ...base, host, ip: ip ? formatIp(ip) : '', place }))
      if (ip && !known && !isLocal(ip)) this.pendingIps.add(formatIp(ip))
      return e
    })
  }

  finishTool(ids: readonly string[], now: number, isError: boolean, bytesIn: number): void {
    for (const id of ids) {
      const e = this.byId.get(id)
      if (!e || e.status === 'blocked') continue
      this.patch(id, { status: isError ? 'failed' : 'done', last: now, bytesIn: Math.max(e.bytesIn, bytesIn) })
    }
  }

  /** The sockets of one poll: new ones open events, missing ones close theirs, counters update bytes. */
  observeSockets(sockets: readonly Socket[], ownerOf: (pid: number) => Owner | undefined, now: number, counters: readonly Counter[] = []): void {
    this.listening.clear()
    for (const s of sockets) {
      if (s.state === 'LISTEN' || (s.proto === 'udp' && s.remote === '')) {
        const ports = this.listening.get(s.pid) ?? new Set<number>()
        ports.add(s.localPort)
        this.listening.set(s.pid, ports)
      }
    }
    const byCounter = new Map(counters.map(c => [`${c.local}:${c.localPort}>${c.remote}:${c.remotePort}`, c]))
    const seen = new Set<string>()
    for (const s of sockets) {
      if (!isRemote(s)) continue
      const ip = parseIp(s.remote)
      if (!ip || isLocal(ip)) continue
      const owner = ownerOf(s.pid)
      if (!owner) continue
      const key = socketKey(s)
      seen.add(key)
      const ipText = formatIp(ip)
      const counter = byCounter.get(`${s.local}:${s.localPort}>${s.remote}:${s.remotePort}`)
      const bytesIn = counter ? counter.bytesIn : s.bytesIn
      const bytesOut = counter ? counter.bytesOut : s.bytesOut
      const existingId = this.flows.get(key)
      const existing = existingId ? this.byId.get(existingId) : undefined
      if (existing) {
        if ((bytesIn >= 0 && bytesIn !== existing.bytesIn) || (bytesOut >= 0 && bytesOut !== existing.bytesOut)) {
          this.patch(existing.id, { bytesIn: Math.max(bytesIn, existing.bytesIn), bytesOut: Math.max(bytesOut, existing.bytesOut), last: now })
        } else if (s.state === 'ESTABLISHED' && existing.status === 'open') {
          // No counters here: a long-lived connection still counts as alive.
        }
        continue
      }
      const isInbound = this.listening.get(s.pid)?.has(s.localPort) === true
      const place = this.geo.get(ipText) ?? null
      const e = this.add(
        newEvent({
          t: now,
          layer: 'socket',
          sessionPid: owner.sessionPid,
          session: owner.session,
          pid: s.pid,
          cmd: owner.cmd,
          ip: ipText,
          port: s.remotePort,
          direction: isInbound ? 'in' : 'out',
          bytesIn: Math.max(0, bytesIn),
          bytesOut: Math.max(0, bytesOut),
          summary: `${owner.cmd} ${s.proto} ${isInbound ? '←' : '→'} ${ipText}:${s.remotePort}`,
          place: place ?? (anycastOf(ip) ? { ...UNKNOWN_PLACE, isAnycast: true, anycast: anycastOf(ip), org: anycastOf(ip) } : null),
        }),
      )
      this.flows.set(key, e.id)
      if (!place) this.pendingIps.add(ipText)
      const match = correlate(this.events, e)
      if (match) {
        this.patch(e.id, { host: match.host, tool: match.tool.tool, linked: match.tool.id, place: place ?? e.place ?? match.tool.place })
        const toolPlace = place ?? match.tool.place
        this.patch(match.tool.id, { linked: e.id, ip: ipText, port: s.remotePort, place: toolPlace, last: now })
      } else if (anycastOf(ip) === 'Anthropic') {
        this.patch(e.id, { host: 'api.anthropic.com', place: place ?? ANTHROPIC_FALLBACK })
      }
    }
    for (const [key, id] of [...this.flows]) {
      if (seen.has(key)) continue
      this.flows.delete(key)
      const e = this.byId.get(id)
      if (e && e.status === 'open') {
        this.patch(id, { status: 'closed', last: now })
        if (e.linked) {
          const tool = this.byId.get(e.linked)
          if (tool && tool.layer === 'tool' && tool.status === 'open') this.patch(tool.id, { bytesIn: Math.max(tool.bytesIn, e.bytesIn), bytesOut: Math.max(tool.bytesOut, e.bytesOut) })
        }
      }
    }
  }

  /** The proxy helper's log lines since the last read. */
  observeProxy(lines: readonly string[], owner: Owner, now: number): void {
    for (const line of lines) {
      let entry: any
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (entry.type === 'open') {
        const host = String(entry.host ?? '')
        const ipParsed = parseIp(host)
        const ipText = ipParsed ? formatIp(ipParsed) : ''
        const org = orgOfHost(host)
        const e = this.add(
          newEvent({
            t: Number(entry.t) || now,
            layer: 'proxy',
            sessionPid: owner.sessionPid,
            session: owner.session,
            host: ipParsed ? '' : host,
            ip: ipText,
            port: Number(entry.port) || 0,
            summary: `${entry.method ?? 'CONNECT'} ${host}:${entry.port ?? ''}`,
            place: org === 'Anthropic' ? ANTHROPIC_FALLBACK : org ? { ...UNKNOWN_PLACE, org } : null,
          }),
        )
        this.proxyFlows.set(Number(entry.id), e.id)
        if (ipText && !this.geo.has(ipText)) this.pendingIps.add(ipText)
        const match = correlate(this.events, e)
        if (match) this.patch(match.tool.id, { linked: e.id, last: now })
      } else if (entry.type === 'close') {
        const id = this.proxyFlows.get(Number(entry.id))
        if (!id) continue
        this.proxyFlows.delete(Number(entry.id))
        this.patch(id, { status: entry.error ? 'failed' : 'closed', last: Number(entry.t) || now, bytesIn: Number(entry.bytesIn) || 0, bytesOut: Number(entry.bytesOut) || 0, note: entry.error ? String(entry.error) : '' })
      } else if (entry.type === 'ip') {
        const id = this.proxyFlows.get(Number(entry.id))
        const ipParsed = parseIp(String(entry.ip ?? ''))
        if (!id || !ipParsed) continue
        const ipText = formatIp(ipParsed)
        this.patch(id, { ip: ipText, place: this.geo.get(ipText) ?? this.byId.get(id)?.place ?? null })
        if (!this.geo.has(ipText)) this.pendingIps.add(ipText)
      }
    }
  }

  /** The Anthropic stream, seen from the turn itself when no socket source can see it. */
  recordStream(owner: Owner, host: string, now: number): TraceEvent {
    const open = this.events.findLast(e => e.layer === 'stream' && e.status === 'open' && e.sessionPid === owner.sessionPid)
    if (open) {
      this.patch(open.id, { last: now })
      return open
    }
    return this.add(newEvent({ t: now, layer: 'stream', host, summary: 'model request', sessionPid: owner.sessionPid, session: owner.session, pid: owner.sessionPid, cmd: owner.cmd, place: ANTHROPIC_FALLBACK }))
  }

  closeStream(owner: Owner, now: number, bytesIn: number): void {
    const open = this.events.findLast(e => e.layer === 'stream' && e.status === 'open' && e.sessionPid === owner.sessionPid)
    if (open) this.patch(open.id, { status: 'done', last: now, bytesIn: open.bytesIn + bytesIn })
  }

  /** Takes the addresses waiting for a lookup, at most `n`. */
  takePending(n = 40): string[] {
    const out = [...this.pendingIps].slice(0, n)
    for (const ip of out) this.pendingIps.delete(ip)
    return out
  }

  /** Applies the geo helper's answers to every event at those addresses. */
  applyGeo(answers: readonly GeoAnswer[]): void {
    for (const a of answers) {
      const ip = parseIp(a.ip)
      if (!ip) continue
      const place = placeOf(a, ip)
      this.geo.set(formatIp(ip), place)
      for (const e of this.events) {
        if (e.ip !== formatIp(ip)) continue
        const org = place.org || e.place?.org || orgOfHost(e.host)
        const isAnthropic = /anthropic/i.test(org) || /anthropic/i.test(e.host)
        const merged: Place = {
          ...place,
          org,
          isAnycast: place.isAnycast || isAnthropic,
          anycast: place.anycast || (isAnthropic ? 'Anthropic' : ''),
          lat: place.lat || e.place?.lat || 0,
          lon: place.lon || e.place?.lon || 0,
          city: place.city || e.place?.city || '',
          country: place.country || e.place?.country || '',
        }
        this.patch(e.id, { place: merged })
      }
    }
  }
}
