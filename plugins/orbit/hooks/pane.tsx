// The pane: the globe, the badge, the legend, the event log, the replay scrubber, and the
// capability line. Pure drawing from a model; the actions call back into register.tsx.

import type { Elements, RenderSurface } from 'claude-code'

/** The terminal's element table; the other surfaces' tables share Box, Text and Button, which is all they get here. */
export type Table = Elements['terminal']

import { hex } from './canvas'
import { HOME, INBOUND, OUTBOUND, BLOCKED } from './globe'
import type { Mode, Rule } from './rules'
import { describeRule } from './rules'
import type { OrbitAsk, OrbitCapabilities, OrbitHome, OrbitReplay, OrbitSession } from '../types'
import { type TraceEvent, type Summary, formatBytes, sessionColor } from './trace'

export type GlobeBox = { columns: number; rows: number; renderer: 'image' | 'cells'; cells: string; png: string }

export type PaneModel = {
  surface: RenderSurface
  bodyColumns: number
  viewportRows: number
  events: readonly TraceEvent[]
  summary: Summary
  scope: 'session' | 'all'
  mode: Mode
  rules: readonly Rule[]
  home: OrbitHome
  selectedId: string
  capabilities: OrbitCapabilities
  replay: OrbitReplay | null
  sessions: readonly OrbitSession[]
  globe: GlobeBox | null
  isGenerating: boolean
  spin: number | null
}

export type Actions = {
  setScope: (scope: 'session' | 'all') => void
  select: (id: string) => void
  spin: (delta: number | null) => void
  replayToggle: () => void
  replaySeek: (direction: -1 | 1) => void
  replaySpeed: () => void
  replayClose: () => void
  downloadGeo: (level: 'city' | 'country') => void
  exportTrace: () => void
  block: (subject: string) => void
  allow: (subject: string) => void
  unrule: (rule: Rule) => void
  clear: () => void
}

const DIM = 0x8a8f98

export const folder = (cwd: string) => cwd.slice(cwd.lastIndexOf('/') + 1) || cwd || '?'

const clock = (t: number) => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

const layerGlyph = (e: TraceEvent) => (e.status === 'blocked' ? '✕' : e.layer === 'tool' ? '⚙' : e.layer === 'socket' ? '⇄' : e.layer === 'proxy' ? '⇶' : '≋')

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s.padEnd(n))

/** One line of the log: time, layer, what, where, who, bytes. */
export function eventLine(e: TraceEvent, width: number, isAll: boolean): string {
  const what = e.tool ? e.tool.replace(/^mcp__(.+?)__.*$/, 'mcp:$1') : e.cmd || e.layer
  const where = e.host || e.ip || e.summary
  const org = e.place?.org ?? ''
  const country = e.place?.country ?? ''
  const anycast = e.place?.isAnycast ? '~' : ''
  const direction = e.direction === 'in' ? '←' : '→'
  const bytes = e.bytesIn > 0 || e.bytesOut > 0 ? `↓${formatBytes(e.bytesIn)} ↑${formatBytes(e.bytesOut)}` : e.status === 'open' ? '…' : ''
  const session = isAll ? pad(e.session, 14) + ' ' : ''
  const head = `${clock(e.t)} ${layerGlyph(e)} ${session}${pad(what, 10)} ${direction} `
  const tail = ` ${pad(anycast + country, 3)} ${bytes}`
  const room = Math.max(8, width - head.length - tail.length - (org ? Math.min(org.length, 18) + 1 : 0))
  return `${head}${pad(where, room)}${org ? ' ' + pad(org, Math.min(org.length, 18)) : ''}${tail}`
}

export function detailLines(e: TraceEvent): string[] {
  const lines = [`${layerGlyph(e)} ${e.summary || e.host || e.ip}`]
  const where = [e.host, e.ip && e.ip !== e.host ? `${e.ip}${e.port ? ':' + e.port : ''}` : ''].filter(Boolean).join(' = ')
  if (where) lines.push(where)
  if (e.place) {
    const place = [e.place.city, e.place.country].filter(Boolean).join(', ')
    const org = e.place.org ? ` · ${e.place.org}` : ''
    const note = e.place.isAnycast ? ` · anycast/CDN (${e.place.anycast || 'edge'}): place unreliable` : ''
    if (place || org || note) lines.push(`${place || 'place unknown'}${org}${note}`)
  }
  lines.push(`${e.direction === 'in' ? 'inbound' : 'outbound'} · ${e.status} · ↓${formatBytes(e.bytesIn)} ↑${formatBytes(e.bytesOut)} · pid ${e.pid}${e.cmd ? ' ' + e.cmd : ''} · ${e.session || 'this session'}`)
  if (e.note) lines.push(e.note)
  if (e.linked) lines.push(`matched to ${e.layer === 'tool' ? 'a socket' : 'a tool call'} (${e.linked})`)
  return lines
}

function capabilityLine(c: OrbitCapabilities): string {
  const parts = [
    'tools ✓',
    c.sockets ? `sockets ✓ ${c.sockets}` : 'sockets ✗',
    c.bytes ? `bytes ✓ ${c.bytes}` : 'bytes ✗',
    c.geo === 'ready' ? 'geo ✓' : c.geo === 'downloading' ? 'geo ⇣' : `geo ✗`,
    c.proxy === 'on' ? `proxy ✓ :${c.proxyPort}` : c.proxy === 'starting' ? 'proxy …' : c.proxy === 'error' ? 'proxy ✗' : 'proxy off',
  ]
  return parts.join(' · ')
}

function badge(m: PaneModel): string {
  const s = m.summary
  const who = m.scope === 'all' ? `${s.sessions} session${s.sessions === 1 ? '' : 's'} talked to` : 'this session talked to'
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : (word.endsWith('y') ? 'ies' : 's').replace('yies', 'ies')}`
  const countries = `${s.countries.length} ${s.countries.length === 1 ? 'country' : 'countries'}`
  return `${who} ${countries} · ${n(s.orgs.length, 'org')} · ${n(s.hosts.length, 'host')} · ↓${formatBytes(s.bytesIn)} ↑${formatBytes(s.bytesOut)}${s.blocked ? ` · ${s.blocked} blocked` : ''}`
}

export function drawPane(ui: Table, m: PaneModel, a: Actions) {
  const { Box, Text, Button } = ui
  const width = Math.max(30, m.bodyColumns)
  const isAll = m.scope === 'all'
  const sessionPids = [...new Set(m.events.map(ev => ev.sessionPid))].sort((x, y) => x - y)
  const selected = m.events.find(ev => ev.id === m.selectedId)

  const header = (
    <Box flexDirection="row" gap={1} flexWrap="wrap">
      <Button key="scope-session" plain dimColor={isAll} onPress={() => a.setScope('session')}>{isAll ? 'session' : '● session'}</Button>
      <Button key="scope-all" plain dimColor={!isAll} onPress={() => a.setScope('all')}>{isAll ? '● all sessions' : 'all sessions'}</Button>
      <Text dimColor>│</Text>
      <Button key="spin-left" plain onPress={() => a.spin(-20)}>◀</Button>
      <Button key="spin-home" plain dimColor={m.spin === null} onPress={() => a.spin(null)}>⌂</Button>
      <Button key="spin-right" plain onPress={() => a.spin(20)}>▶</Button>
      <Text dimColor>│</Text>
      <Button key="export" plain onPress={a.exportTrace}>export</Button>
      <Button key="clear" plain dimColor onPress={a.clear}>clear</Button>
      <Text dimColor>│ {m.mode === 'off' ? 'watching' : `enforcing: ${m.mode}`}</Text>
    </Box>
  )

  const legend = isAll ? (
    <Box flexDirection="column">
      {sessionPids.map(pid => {
        const s = m.sessions.find(x => x.pid === pid)
        const label = m.events.find(ev => ev.sessionPid === pid)?.session || (s ? `${folder(s.cwd)} ${s.tty}` : `pid ${pid}`)
        return <Text color={hex(sessionColor(pid, sessionPids))} wrap="truncate">{`━ ${label}${pid === m.capabilities.self ? ' (this one)' : ''}`}</Text>
      })}
      <Text dimColor>dashed: inbound</Text>
    </Box>
  ) : (
    <Box flexDirection="row" gap={2}>
      <Text color={hex(OUTBOUND)}>━ out</Text>
      <Text color={hex(INBOUND)}>━ in</Text>
      <Text color={hex(BLOCKED)}>╌ blocked</Text>
      <Text color={hex(HOME)}>● you</Text>
    </Box>
  )

  const homeLine =
    m.home.source === 'none' ? (
      <Text color="#ffa726" wrap="wrap">No home yet: set it in /config → Where you are, or /orbit locate (one public-IP lookup).</Text>
    ) : (
      <Text dimColor wrap="truncate">{`you: ${m.home.label || `${m.home.lat.toFixed(2)}, ${m.home.lon.toFixed(2)}`}${m.home.source === 'lookup' ? ' (from your public IP)' : ''}`}</Text>
    )

  const geoLine =
    m.capabilities.geo === 'ready' ? null : m.capabilities.geo === 'downloading' ? (
      <Text color="#4dd0e1" wrap="wrap">{`Downloading the geo database… ${m.capabilities.geoNote}`}</Text>
    ) : m.capabilities.geo === 'no-node' ? (
      <Text color="#ffa726" wrap="wrap">Places need Node.js for the geo helper: install node, or set its path in /config.</Text>
    ) : (
      <Box flexDirection="column">
        <Text color="#ffa726" wrap="wrap">{`No geo database: connections cannot be placed on the globe yet.${m.capabilities.geoNote ? ' ' + m.capabilities.geoNote : ''}`}</Text>
        <Box flexDirection="row" gap={1}>
          <Button key="geo-city" variant="primary" onPress={() => a.downloadGeo('city')}>Download DB-IP city (~130 MB)</Button>
          <Button key="geo-country" onPress={() => a.downloadGeo('country')}>country only (~10 MB)</Button>
        </Box>
      </Box>
    )

  const replay = m.replay ? (
    <Box flexDirection="column">
      <Text color="#ba68c8" wrap="truncate">{`replay ${m.replay.file.slice(m.replay.file.lastIndexOf('/') + 1)} · ${m.replay.count} events · ${clock(m.replay.position)}`}</Text>
      <Box flexDirection="row" gap={1}>
        <Button key="rp-back" plain onPress={() => a.replaySeek(-1)}>⏮</Button>
        <Button key="rp-toggle" plain onPress={a.replayToggle}>{m.replay.isPlaying ? '⏸' : '▶'}</Button>
        <Button key="rp-fwd" plain onPress={() => a.replaySeek(1)}>⏭</Button>
        <Button key="rp-speed" plain onPress={a.replaySpeed}>{`${m.replay.speed}×`}</Button>
        <Text color="#ba68c8">{scrub(m.replay, Math.max(8, Math.min(width - 24, 60)))}</Text>
        <Button key="rp-close" plain dimColor onPress={a.replayClose}>close</Button>
      </Box>
    </Box>
  ) : null

  const side = (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Text bold wrap="wrap">{badge(m)}</Text>
      {m.isGenerating && <Text color={hex(OUTBOUND)}>≋ Anthropic stream breathing…</Text>}
      {legend}
      {homeLine}
      {geoLine}
      <Text dimColor wrap="wrap">{capabilityLine(m.capabilities)}</Text>
    </Box>
  )

  let globe: any = null
  if (m.surface === 'terminal' && m.globe) {
    const { Raster, Image } = ui
    globe =
      m.globe.renderer === 'image' ? (
        <Image key="globe" source={{ png: m.globe.png }} columns={m.globe.columns} rows={m.globe.rows} alt="the globe" />
      ) : (
        <Raster key="globe" columns={m.globe.columns} rows={m.globe.rows} cells={m.globe.cells} />
      )
  } else if (m.surface !== 'terminal') {
    globe = <Text dimColor wrap="wrap">The globe draws in the terminal; here is the trace.</Text>
  }

  const sideBySide = m.globe !== null && width >= m.globe.columns + 44
  const globeRows = m.globe ? m.globe.rows : 1
  const used = 2 + (sideBySide ? Math.max(globeRows, 8) : globeRows + 8) + (m.replay ? 2 : 0) + (selected ? 5 : 0) + 2
  const room = Math.max(3, m.viewportRows - used)
  const listed = [...m.events].sort((x, y) => y.t - x.t).slice(0, room)

  const log = (
    <Box flexDirection="column">
      {listed.length === 0 && <Text dimColor>Nothing yet: tool calls, sockets of this session's processes and proxied connections will appear here.</Text>}
      {listed.map(ev => (
        <Button key={`ev:${ev.id}`} plain dimColor={ev.id !== m.selectedId && ev.status !== 'open'} onPress={() => a.select(ev.id)}>
          {eventLine(ev, width - 1, isAll)}
        </Button>
      ))}
    </Box>
  )

  const detail = selected ? (
    <Box flexDirection="column" paddingX={1} borderStyle="round" borderDimColor>
      {detailLines(selected).map(line => (
        <Text wrap="truncate">{line}</Text>
      ))}
      <Box flexDirection="row" gap={1}>
        {(selected.host || selected.ip) && selected.status !== 'blocked' && (
          <Button key="detail-block" plain onPress={() => a.block(selected.host && !selected.host.startsWith('mcp:') ? selected.host : selected.ip)}>block this host</Button>
        )}
        {selected.host.startsWith('mcp:') && <Button key="detail-block-mcp" plain onPress={() => a.block(selected.host)}>block this server</Button>}
        {selected.status === 'blocked' && <Button key="detail-allow" plain onPress={() => a.allow(selected.note.replace(/^.*?(host|mcp|tool):/, '$1:'))}>allow it</Button>}
        <Button key="detail-close" plain dimColor onPress={() => a.select('')}>close</Button>
      </Box>
    </Box>
  ) : null

  const rules =
    m.rules.length > 0 ? (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Text dimColor>rules:</Text>
        {m.rules.slice(0, 8).map(r => (
          <Button key={`rule:${r.kind}:${r.pattern}`} plain dimColor onPress={() => a.unrule(r)}>{`${describeRule(r)} ✕`}</Button>
        ))}
        {m.rules.length > 8 && <Text dimColor>{`+${m.rules.length - 8} more (/orbit rules)`}</Text>}
      </Box>
    ) : null

  return (
    <Box flexDirection="column">
      {header}
      {sideBySide ? (
        <Box flexDirection="row">
          {globe}
          {side}
        </Box>
      ) : (
        <Box flexDirection="column">
          {globe}
          {side}
        </Box>
      )}
      {replay}
      {detail}
      {rules}
      {log}
    </Box>
  )
}

function scrub(r: OrbitReplay, width: number): string {
  const at = Math.round(((r.position - r.start) / Math.max(1, r.end - r.start)) * (width - 1))
  return Array.from({ length: width }, (_, i) => (i < at ? '━' : i === at ? '●' : '─')).join('')
}

export function drawAsk(ui: Table, ask: OrbitAsk, answer: (verdict: 'allow' | 'deny', isAlways: boolean) => void) {
  const { Box, Text, Button } = ui
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="#ffa726">{`${ask.tool} wants to reach ${ask.kind === 'mcp' ? 'MCP server' : ''} ${ask.subject}`}</Text>
      <Text dimColor wrap="truncate">{ask.summary}</Text>
      <Text dimColor>No answer in 8 seconds denies it.</Text>
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Button key="ask-allow" hotkey="1" variant="primary" autoFocus onPress={() => answer('allow', false)}>Allow once</Button>
        <Button key="ask-allow-always" hotkey="2" onPress={() => answer('allow', true)}>Always allow</Button>
        <Button key="ask-deny" hotkey="3" onPress={() => answer('deny', false)}>Deny</Button>
        <Button key="ask-deny-always" hotkey="4" onPress={() => answer('deny', true)}>Always deny</Button>
      </Box>
    </Box>
  )
}

export const DIM_COLOR = hex(DIM)
