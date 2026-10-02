// orbit: a globe of everything your Claude session talks to. Three capture layers feed one
// trace: tool calls seen before they run (and blocked by your rules), the sockets of the
// session's process tree, and an optional local proxy for the commands and MCP servers the
// session starts. The pane draws the globe (pixels where the terminal can, half-blocks
// elsewhere), the log, and a replay of any saved trace.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { OrbitAsk, OrbitCapabilities, OrbitEvent, OrbitHome, OrbitReplay, OrbitRule, OrbitSession } from '../types'
import { Pixels } from './canvas'
import { type GeoAnswer, formatIp, parseIp, placeOf } from './geo'
import { type Scene, render } from './globe'
import { Live, type Owner } from './model'
import { type Actions, type GlobeBox, type Table, drawAsk, drawPane, folder } from './pane'
import { encodePng } from './png'
import {
  PS_ARGV, SS_ARGV, countersInNettop, cwdsIn, lsofCwdArgv, lsofNetArgv, nettopArgv, procWalkArgv, sessionOf, sessionsIn,
  socketsInLsof, socketsInProc, socketsInSs, treeOf, type Socket, type Counter,
} from './procs'
import { type Mode, MODES, type Rule, decide, describeRule, parseSubject, verdict, withRule, withoutRule } from './rules'
import { intentOf, isTraced } from './tools'
import { type Replay, type TraceEvent, arcsFor, eventsAt, fromJsonl, openReplay, stepReplay, summarize, toJsonl } from './trace'

const PANE = 'orbit'
const ASK_PANE = 'orbit-ask'
const FRAME_MS = 100
const IMAGE_EVERY = 3 // image frames every third tick
const POLL_MS = 2000
const GEO_MS = 2500
const FLUSH_MS = 3000
const LOG_MS = 10000
const ASK_MS = 8000
const CELL_W = 9 // pixels per cell in image mode
const CELL_H = 18
const DENIES_BEFORE_FALLBACK = 3

type Options = {
  location?: string
  enforcement?: string
  picture?: string
  geoDatabase?: string
  asnDatabase?: string
  proxy?: boolean
  fadeSeconds?: number
  autoLog?: boolean
  statusLine?: boolean
  node?: string
}

const events = atom({ plugin: 'orbit', key: 'events' } as const, [] as OrbitEvent[])
const rules = atom({ plugin: 'orbit', key: 'rules' } as const, [] as OrbitRule[])
const mode = atom({ plugin: 'orbit', key: 'mode' } as const, 'denylist' as Mode)
const scope = atom({ plugin: 'orbit', key: 'scope' } as const, 'session' as 'session' | 'all')
const sessions = atom({ plugin: 'orbit', key: 'sessions' } as const, [] as OrbitSession[])
const home = atom({ plugin: 'orbit', key: 'home' } as const, { lat: 0, lon: 0, label: '', source: 'none' } as OrbitHome)
const selectedId = atom({ plugin: 'orbit', key: 'selectedId' } as const, '')
const capabilities = atom({ plugin: 'orbit', key: 'capabilities' } as const, {
  platform: '', tools: true, sockets: '', bytes: '', node: false, geo: 'missing', geoNote: '', proxy: 'off', proxyPort: 0, self: 0,
} as OrbitCapabilities)
const replayState = atom({ plugin: 'orbit', key: 'replay' } as const, null as OrbitReplay | null)
const spin = atom({ plugin: 'orbit', key: 'spin' } as const, null as number | null)
const isPaneOpen = atom({ plugin: 'orbit', key: 'isPaneOpen' } as const, false)
const ask = atom({ plugin: 'orbit', key: 'ask' } as const, null as OrbitAsk | null)
const renderer = atom({ plugin: 'orbit', key: 'renderer' } as const, 'cells' as 'image' | 'cells')

type View = { requestId: string; columns: number; rows: number; renderer: 'image' | 'cells' }

// What only this process has: all of it starts over on a hot reload, and `session.start` refills it.
const live = new Live()
let options: Options = {}
let views: View[] = []
let tick = 0
let self = 0
let owner: Owner = { sessionPid: 0, session: 'this session', cmd: 'claude' }
let ownerByPid = new Map<number, Owner>()
let caps: OrbitCapabilities = { platform: '', tools: true, sockets: '', bytes: '', node: false, geo: 'missing', geoNote: '', proxy: 'off', proxyPort: 0, self: 0 }
let currentScope: 'session' | 'all' = 'session'
let currentMode: Mode = 'denylist'
let currentRules: Rule[] = []
let currentHome: OrbitHome = { lat: 0, lon: 0, label: '', source: 'none' }
let currentSpin: number | null = null
let currentSelected = ''
let currentRenderer: 'image' | 'cells' = 'cells'
let replay: Replay | null = null
let lastReplayWrite = 0
let generatingUntil = 0
let isPolling = false
let isLookingUp = false
let lastFrameAt = 0
let lastFrameTime = 0
let lastLogAt = 0
let imageDenies = 0
let pendingAsk: { resolve: (answer: 'allow' | 'deny') => void } | null = null
let sessionId = ''
let homeDir = ''
let geoFiles = { geo: '', asn: '' }
let nodeBin = 'node'
let proxy: { stop: () => void; logFile: string; lines: number; size: number; port: number; saved: ProxyEnv } | null = null
let fadeMs = 25000
let lastStatus = ''

const now = () => Date.now()
const orbitDir = () => `${homeDir}/.claude/orbit`

async function run($: EngineInterface, argv: readonly string[], timeoutMs = 8000): Promise<string> {
  try {
    const res = await $.process.run(argv, { timeoutMs })
    return res.stdout
  } catch {
    return ''
  }
}

async function has($: EngineInterface, command: string): Promise<boolean> {
  const out = await run($, ['sh', '-c', `command -v "$1"`, 'orbit', command], 4000)
  return out.trim() !== ''
}

/** The shell prints its pid, then `exec`s `ps` under that same pid, so the table holds the way up. */
async function findSelf($: EngineInterface): Promise<number> {
  const sh = await run($, ['sh', '-c', `echo $$; exec ${PS_ARGV.join(' ')}`], 5000)
  const [pid = '', ...table] = sh.split('\n')
  return sessionOf(table.join('\n'), Number(pid))
}

function parseLocation(text: string): OrbitHome | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*(.*)$/.exec(text)
  if (!m) return null
  const lat = Number(m[1])
  const lon = Number(m[2])
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null
  return { lat, lon, label: m[3]!.trim(), source: 'config' }
}

async function setCaps($: EngineInterface, fields: Partial<OrbitCapabilities>): Promise<void> {
  caps = { ...caps, ...fields }
  await update($, capabilities, () => caps)
}

async function checkCapabilities($: EngineInterface): Promise<void> {
  const platform = (await run($, ['uname', '-s'], 4000)).trim() || 'unknown'
  const isMac = platform === 'Darwin'
  const [lsof, ss, nettop, node] = await Promise.all([has($, 'lsof'), has($, 'ss'), has($, 'nettop'), has($, nodeBin)])
  let sockets = ''
  if (isMac) sockets = lsof ? 'lsof' : ''
  else sockets = ss ? 'ss' : (await $.fs.exists('/proc/net/tcp')) ? 'proc' : lsof ? 'lsof' : ''
  const bytes = isMac ? (nettop ? 'nettop' : '') : ss ? 'ss' : ''
  if (self === 0) self = await findSelf($)
  owner = { sessionPid: self, session: 'this session', cmd: 'claude' }
  await setCaps($, { platform, sockets, bytes, node, self })
  await checkGeo($)
}

async function checkGeo($: EngineInterface): Promise<void> {
  const geoPath = options.geoDatabase || `${orbitDir()}/geo/dbip-city-lite.mmdb`
  const countryPath = `${orbitDir()}/geo/dbip-country-lite.mmdb`
  const asnPath = options.asnDatabase || `${orbitDir()}/geo/dbip-asn-lite.mmdb`
  const found = (await $.fs.exists(geoPath)) ? geoPath : !options.geoDatabase && (await $.fs.exists(countryPath)) ? countryPath : ''
  geoFiles = { geo: found, asn: (await $.fs.exists(asnPath)) ? asnPath : '' }
  if (!caps.node) await setCaps($, { geo: 'no-node', geoNote: '' })
  else if (found) await setCaps($, { geo: 'ready', geoNote: found.endsWith('country-lite.mmdb') ? 'country level' : '' })
  else await setCaps($, { geo: 'missing', geoNote: options.geoDatabase ? `${options.geoDatabase} not found.` : '' })
}

function labelOf(pid: number, all: readonly OrbitSession[]): string {
  if (pid === self) return 'this session'
  const s = all.find(x => x.pid === pid)
  return s ? `${folder(s.cwd)} ${s.tty}` : `pid ${pid}`
}

async function poll($: EngineInterface): Promise<void> {
  if (isPolling) return
  isPolling = true
  try {
    const ps = await run($, PS_ARGV, 5000)
    if (ps === '') return
    if (self === 0) {
      self = await findSelf($)
      owner = { sessionPid: self, session: 'this session', cmd: 'claude' }
      await setCaps($, { self })
    }
    let all: OrbitSession[] = []
    let roots = [self]
    if (currentScope === 'all') {
      all = sessionsIn(ps)
      if (self && !all.some(s => s.pid === self)) all.push({ pid: self, tty: '', cwd: '', isWorking: false })
      if (all.length) {
        const cwds = caps.platform === 'Darwin'
          ? cwdsIn(await run($, lsofCwdArgv(all.map(s => s.pid)), 5000))
          : new Map((await run($, ['sh', '-c', 'for p in "$@"; do echo "$p $(readlink /proc/$p/cwd 2>/dev/null)"; done', 'orbit', ...all.map(s => String(s.pid))], 5000))
              .split('\n').map(l => l.split(' ')).filter(p => p.length === 2).map(p => [Number(p[0]), p[1]!] as const))
        all = all.map(s => ({ ...s, cwd: cwds.get(s.pid) ?? '' }))
      }
      roots = all.map(s => s.pid)
      const before = await read($, sessions)
      if (JSON.stringify(before) !== JSON.stringify(all)) await update($, sessions, () => all)
    }
    const next = new Map<number, Owner>()
    for (const root of roots) {
      if (!root) continue
      const label = labelOf(root, all)
      for (const [pid, cmd] of treeOf(ps, root)) next.set(pid, { sessionPid: root, session: label, cmd })
    }
    ownerByPid = next
    const pids = [...ownerByPid.keys()]
    if (pids.length === 0 || caps.sockets === '') return
    let sockets: Socket[] = []
    if (caps.sockets === 'lsof') sockets = socketsInLsof(await run($, lsofNetArgv(pids), 8000))
    else if (caps.sockets === 'ss') sockets = socketsInSs(await run($, SS_ARGV, 8000), new Set(pids))
    else if (caps.sockets === 'proc') sockets = socketsInProc(await run($, procWalkArgv(pids), 8000))
    let counters: Counter[] = []
    if (caps.bytes === 'nettop' && sockets.some(s => s.remote !== '')) counters = countersInNettop(await run($, nettopArgv(pids), 8000))
    live.observeSockets(sockets, pid => ownerByPid.get(pid), now(), counters)
    if (proxy) await readProxyLog($)
  } catch (err) {
    $.ui.log(`orbit: poll failed: ${(err as Error).message}`, { to: 'debug' })
  } finally {
    isPolling = false
  }
}

async function lookupPending($: EngineInterface): Promise<void> {
  if (isLookingUp || caps.geo !== 'ready' || !geoFiles.geo) return
  const ips = live.takePending(40)
  if (ips.length === 0) return
  isLookingUp = true
  try {
    const out = await run($, [nodeBin, `${$.plugin.root}/geo/geoip.mjs`, 'lookup', geoFiles.geo, geoFiles.asn || '-', ...ips], 20000)
    const answers: GeoAnswer[] = []
    for (const line of out.split('\n')) {
      if (line.trim() === '') continue
      try {
        answers.push(JSON.parse(line))
      } catch {}
    }
    if (answers.length === 0) {
      for (const ip of ips) live.pendingIps.add(ip)
      return
    }
    live.applyGeo(answers)
  } finally {
    isLookingUp = false
  }
}

async function flush($: EngineInterface): Promise<void> {
  if (!live.isDirty) return
  live.isDirty = false
  await update($, events, () => live.events.slice(-600))
  if (options.statusLine) {
    const s = summarize(live.events.filter(e => currentScope === 'all' || e.sessionPid === self || e.sessionPid === 0))
    const text = `orbit · ${s.hosts.length} host${s.hosts.length === 1 ? '' : 's'} · ${s.countries.length} ${s.countries.length === 1 ? 'country' : 'countries'}${s.blocked ? ` · ${s.blocked} blocked` : ''}`
    if (text !== lastStatus) {
      lastStatus = text
      $.ui.status(text)
    }
  }
  if (options.autoLog !== false && homeDir && sessionId && now() - lastLogAt > LOG_MS) {
    lastLogAt = now()
    await $.fs.write(`${orbitDir()}/traces/${sessionId}.jsonl`, toJsonl(live.events)).catch(() => {})
  }
}

const visibleEvents = (): TraceEvent[] => (currentScope === 'all' ? live.events : live.events.filter(e => e.sessionPid === self || e.sessionPid === 0))

function sceneFor(view: View, t: number, arcsAt: number, shown: readonly TraceEvent[]): Scene {
  const isImage = view.renderer === 'image'
  const width = isImage ? view.columns * CELL_W : view.columns
  const height = isImage ? view.rows * CELL_H : view.rows * 2
  const hasHome = currentHome.source !== 'none'
  const homePoint = { lat: currentHome.lat, lon: currentHome.lon }
  const arcs = hasHome ? arcsFor(shown, { now: arcsAt, fadeMs, home: homePoint, bySession: currentScope === 'all', selectedId: currentSelected, isGenerating: t < generatingUntil }) : []
  const dots = hasHome ? [] : shown.filter(e => e.place && (e.place.lat || e.place.lon)).map(e => ({ lat: e.place!.lat, lon: e.place!.lon, color: 0xffa726, ring: -1 }))
  return {
    width,
    height,
    center: { lat: Math.max(-70, Math.min(70, hasHome ? currentHome.lat : 20)), lon: (hasHome ? currentHome.lon : -30) + (currentSpin ?? 0) },
    time: t,
    home: hasHome ? homePoint : null,
    arcs,
    dots,
    isQuantized: !isImage,
    hasGrid: true,
  }
}

function paint(view: View, scene: Scene): { cells?: string; png?: string } {
  const px = render(scene)
  if (view.renderer === 'image') return { png: encodePng(px.toRgba(0x000000), scene.width, scene.height).toBase64() }
  return { cells: px.toCells() }
}

async function frame($: EngineInterface): Promise<void> {
  tick += 1
  const t = now()
  const dt = lastFrameTime ? t - lastFrameTime : FRAME_MS
  lastFrameTime = t
  if (replay) {
    const stepped = stepReplay(replay, dt)
    if (stepped !== replay) {
      replay = stepped
      if (t - lastReplayWrite > 400 || !replay.isPlaying) {
        lastReplayWrite = t
        await update($, replayState, () => summaryOf(replay!))
      }
    }
  }
  if (views.length === 0) return
  const shown = replay ? eventsAt(replay, replay.position) : visibleEvents()
  const arcsAt = replay ? replay.position : t
  const isAnimating = (replay?.isPlaying ?? false) || t < generatingUntil || shown.some(e => e.status === 'open' || arcsAt - e.last < fadeMs)
  if (!isAnimating && t - lastFrameAt < 2000) return
  lastFrameAt = t
  await Promise.all(
    views.map(async view => {
      if (view.renderer === 'image' && tick % IMAGE_EVERY !== 0) return
      const scene = sceneFor(view, t, arcsAt, shown)
      const painted = paint(view, scene)
      const res = await $.ui.blit(
        painted.png !== undefined
          ? { requestId: view.requestId, key: 'globe', source: { png: painted.png } }
          : { requestId: view.requestId, key: 'globe', cells: painted.cells! },
      )
      if (res.deny === undefined) {
        if (view.renderer === 'image') imageDenies = 0
        return
      }
      if (/mount/i.test(res.deny)) {
        views = views.filter(v => v !== view)
        return
      }
      if (view.renderer === 'image') {
        $.ui.log(`orbit: image frame refused: ${res.deny}`, { to: 'debug' })
        imageDenies += 1
        if (imageDenies >= DENIES_BEFORE_FALLBACK) {
          imageDenies = 0
          currentRenderer = 'cells'
          views = views.filter(v => v !== view)
          await update($, renderer, () => 'cells')
          $.ui.toast('This terminal cannot show the globe as pixels; drawing it in colored blocks instead.')
        }
      }
    }),
  )
}

const summaryOf = (r: Replay): OrbitReplay => ({ file: r.file, count: r.events.length, start: r.start, end: r.end, position: r.position, speed: r.speed, isPlaying: r.isPlaying })

async function pickRenderer($: EngineInterface): Promise<'image' | 'cells'> {
  if (options.picture === 'image') return 'image'
  if (options.picture === 'blocks') return 'cells'
  const isRelayed = (await $.env.get('TMUX')) !== undefined || (await $.env.get('SSH_CONNECTION')) !== undefined || (await $.env.get('SSH_TTY')) !== undefined
  if (isRelayed) return 'cells'
  const term = (await $.env.get('TERM')) ?? ''
  const program = ((await $.env.get('TERM_PROGRAM')) ?? '').toLowerCase()
  const isKitty = (await $.env.get('KITTY_WINDOW_ID')) !== undefined
  return isKitty || term.includes('kitty') || term.includes('ghostty') || program === 'ghostty' ? 'image' : 'cells'
}

async function saveRules($: EngineInterface, next: Rule[]): Promise<void> {
  currentRules = next
  await $.store.set('rules', next)
  await update($, rules, () => next)
}

async function setHome($: EngineInterface, next: OrbitHome): Promise<void> {
  currentHome = next
  await update($, home, () => next)
  if (next.source === 'lookup') await $.store.set('home', next)
}

async function askUser($: EngineInterface, subject: { kind: 'host' | 'mcp'; subject: string }, tool: string, summary: string): Promise<'allow' | 'deny'> {
  if (pendingAsk) return 'deny'
  const question: OrbitAsk = { id: `${now()}`, tool, kind: subject.kind, subject: subject.subject, summary }
  await update($, ask, () => question)
  const opened = await $.ui.open({ id: ASK_PANE, title: 'orbit: allow this connection?', focus: true, closeOnEscape: true, holdToasts: true, rows: 7 })
  if (!opened.isPlaced) $.ui.toast(`orbit: ${tool} wants ${subject.subject}: widen the terminal to answer, or it is denied in 8 s.`)
  const answer = await new Promise<'allow' | 'deny'>(resolve => {
    pendingAsk = { resolve }
    $.clock.after(ASK_MS, () => resolve('deny'))
  })
  pendingAsk = null
  await update($, ask, () => null)
  await $.ui.close({ id: ASK_PANE }).catch(() => {})
  return answer
}

async function readProxyLog($: EngineInterface): Promise<void> {
  if (!proxy) return
  let text = ''
  try {
    text = await $.fs.read(proxy.logFile)
  } catch {
    return
  }
  if (text.length < proxy.size) proxy.lines = 0 // the helper emptied it
  proxy.size = text.length
  const lines = text.split('\n').filter(l => l.trim() !== '')
  const fresh = lines.slice(proxy.lines)
  proxy.lines = lines.length
  if (fresh.length) live.observeProxy(fresh, owner, now())
}

type ProxyEnv = { HTTPS_PROXY?: string; HTTP_PROXY?: string; https_proxy?: string; http_proxy?: string }

/** Points the children started from now on at the local proxy; the names are spelled out so the validator lists them. */
async function applyProxyEnv($: EngineInterface, url: string): Promise<void> {
  await $.env.set('HTTPS_PROXY', url)
  await $.env.set('HTTP_PROXY', url)
  await $.env.set('https_proxy', url)
  await $.env.set('http_proxy', url)
}

async function restoreProxyEnv($: EngineInterface, saved: ProxyEnv): Promise<void> {
  await $.env.set('HTTPS_PROXY', saved.HTTPS_PROXY)
  await $.env.set('HTTP_PROXY', saved.HTTP_PROXY)
  await $.env.set('https_proxy', saved.https_proxy)
  await $.env.set('http_proxy', saved.http_proxy)
}

async function startProxy($: EngineInterface): Promise<void> {
  if (proxy || !caps.node) {
    if (!caps.node) await setCaps($, { proxy: 'error' })
    return
  }
  const logFile = `${orbitDir()}/proxy-${sessionId || 'session'}.jsonl`
  await $.fs.write(logFile, '')
  const saved = {
    HTTPS_PROXY: await $.env.get('HTTPS_PROXY'),
    HTTP_PROXY: await $.env.get('HTTP_PROXY'),
    https_proxy: await $.env.get('https_proxy'),
    http_proxy: await $.env.get('http_proxy'),
  }
  const upstream = saved.HTTPS_PROXY ?? saved.https_proxy ?? ''
  await setCaps($, { proxy: 'starting' })
  const child = $.process.spawn({ argv: [nodeBin, `${$.plugin.root}/proxy/proxy.mjs`, logFile], env: upstream ? { ORBIT_UPSTREAM_PROXY: upstream } : {} })
  const state = { stop: () => void child.return(undefined as never), logFile, lines: 0, size: 0, port: 0, saved }
  proxy = state
  void (async () => {
    let buffer = ''
    try {
      for await (const chunk of child) {
        if (chunk.stream !== 'stdout') continue
        buffer += chunk.text
        const at = buffer.indexOf('\n')
        if (at < 0) continue
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        try {
          const msg = JSON.parse(line)
          if (msg.type === 'ready' && proxy === state) {
            state.port = Number(msg.port)
            const url = `http://127.0.0.1:${state.port}`
            await applyProxyEnv($, url)
            await setCaps($, { proxy: 'on', proxyPort: state.port })
          }
        } catch {}
      }
    } catch (err) {
      $.ui.log(`orbit: proxy helper: ${(err as Error).message}`, { to: 'debug' })
    }
    if (proxy === state) {
      proxy = null
      await setCaps($, { proxy: 'error', proxyPort: 0 })
      await restoreProxyEnv($, saved)
    }
  })()
}

async function stopProxy($: EngineInterface): Promise<void> {
  if (!proxy) return
  const state = proxy
  proxy = null
  state.stop()
  await restoreProxyEnv($, state.saved)
  await setCaps($, { proxy: 'off', proxyPort: 0 })
}

async function downloadGeo($: EngineInterface, level: 'city' | 'country'): Promise<string> {
  if (!caps.node) return 'The geo helper needs Node.js: install node or set its path in /config → Node path.'
  if (caps.geo === 'downloading') return 'Already downloading.'
  const dir = `${orbitDir()}/geo`
  await setCaps($, { geo: 'downloading', geoNote: 'starting…' })
  const child = $.process.spawn({ argv: [nodeBin, `${$.plugin.root}/geo/geoip.mjs`, 'download', dir, level] })
  void (async () => {
    let buffer = ''
    let error = ''
    try {
      for await (const chunk of child) {
        if (chunk.stream !== 'stdout') continue
        buffer += chunk.text
        let at = buffer.indexOf('\n')
        while (at >= 0) {
          const line = buffer.slice(0, at)
          buffer = buffer.slice(at + 1)
          at = buffer.indexOf('\n')
          try {
            const msg = JSON.parse(line)
            if (msg.type === 'progress') await setCaps($, { geoNote: `${msg.name}: ${Math.round(msg.bytes / 1048576)} MB${msg.total ? ` of ${Math.round(msg.total / 1048576)}` : ''}` })
            else if (msg.type === 'done') await setCaps($, { geoNote: `${msg.name} ${msg.month} ready` })
            else if (msg.type === 'error') error = String(msg.error)
          } catch {}
        }
      }
    } catch (err) {
      error = (err as Error).message
    }
    await checkGeo($)
    if (caps.geo === 'ready') {
      $.ui.toast('orbit: geo database ready; placing connections.')
      for (const e of live.events) if (e.ip && (!e.place || (!e.place.lat && !e.place.lon))) live.pendingIps.add(e.ip)
    } else {
      await setCaps($, { geo: 'error', geoNote: error || 'download failed' })
      $.ui.toast(`orbit: geo download failed: ${error || 'no file'}`)
    }
  })()
  return `Downloading DB-IP Lite (${level}) and ASN Lite into ${dir}; the pane shows progress. Licensed CC BY 4.0 by db-ip.com.`
}

async function locate($: EngineInterface): Promise<string> {
  try {
    if (caps.geo === 'ready' && geoFiles.geo) {
      const res = await $.http.fetch('https://api.ipify.org?format=json')
      const ipText = String(JSON.parse(res.text).ip ?? '')
      const ip = parseIp(ipText)
      if (!ip) return 'Could not read your public address from api.ipify.org.'
      const out = await run($, [nodeBin, `${$.plugin.root}/geo/geoip.mjs`, 'lookup', geoFiles.geo, geoFiles.asn || '-', formatIp(ip)], 20000)
      const answer = JSON.parse(out.split('\n').find(l => l.trim()) ?? '{}') as GeoAnswer
      const place = placeOf(answer, ip)
      if (!place.lat && !place.lon) return `Your address ${formatIp(ip)} is not in the database; set /config → Your location by hand.`
      await setHome($, { lat: place.lat, lon: place.lon, label: [place.city, place.country].filter(Boolean).join(', '), source: 'lookup' })
      return `Home set to ${currentHome.label} (${place.lat}, ${place.lon}) from your public address, looked up offline. Saved for next time.`
    }
    const res = await $.http.fetch('https://ipinfo.io/json')
    const info = JSON.parse(res.text) as { loc?: string; city?: string; country?: string }
    const parsed = parseLocation(info.loc ?? '')
    if (!parsed) return 'ipinfo.io gave no location; set /config → Your location by hand.'
    await setHome($, { ...parsed, label: [info.city, info.country].filter(Boolean).join(', '), source: 'lookup' })
    return `Home set to ${currentHome.label} (${parsed.lat}, ${parsed.lon}) by one lookup at ipinfo.io (no database yet). Saved for next time.`
  } catch (err) {
    return `Lookup failed: ${(err as Error).message}`
  }
}

function actionsFor($: EngineInterface): Actions {
  return {
    setScope: s => void setScope($, s),
    select: id => {
      currentSelected = currentSelected === id ? '' : id
      void update($, selectedId, () => currentSelected)
    },
    spin: delta => {
      currentSpin = delta === null ? null : (currentSpin ?? 0) + delta
      void update($, spin, () => currentSpin)
    },
    replayToggle: () => {
      if (!replay) return
      replay = { ...replay, isPlaying: !replay.isPlaying, position: replay.position >= replay.end ? replay.start : replay.position }
      void update($, replayState, () => summaryOf(replay!))
    },
    replaySeek: direction => {
      if (!replay) return
      const step = (replay.end - replay.start) / 20
      replay = { ...replay, position: Math.max(replay.start, Math.min(replay.end, replay.position + direction * step)) }
      void update($, replayState, () => summaryOf(replay!))
    },
    replaySpeed: () => {
      if (!replay) return
      replay = { ...replay, speed: replay.speed >= 16 ? 1 : replay.speed * 2 }
      void update($, replayState, () => summaryOf(replay!))
    },
    replayClose: () => {
      replay = null
      void update($, replayState, () => null)
    },
    downloadGeo: level => void downloadGeo($, level).then(text => $.ui.toast(text)),
    exportTrace: () => void exportTrace($, '').then(text => $.ui.toast(text)),
    block: subject => void addRule($, subject, 'deny').then(text => $.ui.toast(text)),
    allow: subject => void addRule($, subject, 'allow').then(text => $.ui.toast(text)),
    unrule: rule => void saveRules($, withoutRule(currentRules, rule.kind, rule.pattern)).then(() => $.ui.toast(`Removed: ${describeRule(rule)}`)),
    clear: () => {
      live.load([])
      live.flows.clear()
      live.isDirty = true
      void flush($)
    },
  }
}

async function setScope($: EngineInterface, s: 'session' | 'all'): Promise<void> {
  currentScope = s
  await update($, scope, () => s)
  void poll($)
}

async function addRule($: EngineInterface, subjectText: string, action: 'allow' | 'deny'): Promise<string> {
  const parsed = parseSubject(subjectText)
  if (!parsed) return 'Name a host (example.com, *.example.com, 1.2.3.4), mcp:<server> or tool:<Tool>.'
  const rule: Rule = { kind: parsed.kind, pattern: parsed.pattern, action, at: now() }
  await saveRules($, withRule(currentRules, rule))
  const hint = currentMode === 'off' ? ' Enforcement is off: set /config → Enforcement or /orbit mode denylist to apply it.' : ''
  return `${action === 'deny' ? 'Blocking' : 'Allowing'} ${rule.kind}:${rule.pattern}.${hint}`
}

async function exportTrace($: EngineInterface, pathText: string): Promise<string> {
  const path = pathText || `${orbitDir()}/traces/${sessionId || 'trace'}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
  const shown = visibleEvents()
  await $.fs.write(path, toJsonl(shown))
  return `Wrote ${shown.length} events to ${path}`
}

async function openReplayFile($: EngineInterface, pathText: string): Promise<string> {
  const dir = `${orbitDir()}/traces`
  if (pathText === '') {
    let files: { name: string; mtimeMs: number }[] = []
    try {
      files = (await $.fs.list(dir)).filter(f => f.name.endsWith('.jsonl')).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 10)
    } catch {}
    if (files.length === 0) return `No traces in ${dir} yet. Traces are written there while the session runs (/config → Write the trace).`
    return `Traces in ${dir}:\n${files.map(f => `  ${f.name}`).join('\n')}\n/orbit replay <name> plays one.`
  }
  const path = pathText.includes('/') ? pathText : `${dir}/${pathText}`
  let text = ''
  try {
    text = await $.fs.read(path)
  } catch (err) {
    return `Cannot read ${path}: ${(err as Error).message}`
  }
  const loaded = openReplay(path, fromJsonl(text))
  if (!loaded) return `${path} holds no events.`
  replay = loaded
  await update($, replayState, () => summaryOf(loaded))
  if (!(await read($, isPaneOpen))) {
    await $.ui.open({ id: PANE, title: 'Orbit' })
    await update($, isPaneOpen, () => true)
  }
  return `Replaying ${loaded.events.length} events from ${path} at ${loaded.speed}×.`
}

async function checkReport($: EngineInterface): Promise<string> {
  await checkCapabilities($)
  const c = caps
  const lines = [
    `Platform: ${c.platform}${c.self ? ` · this session is pid ${c.self}` : ' · could not find this session in ps'}`,
    `1. Tool layer: on (tool.call hook) · enforcement ${currentMode} · ${currentRules.length} rule${currentRules.length === 1 ? '' : 's'}`,
    `2. Process layer: ${c.sockets ? `on, sockets via ${c.sockets}` : 'off: no lsof/ss/proc source found'}${c.bytes ? ` · bytes via ${c.bytes}` : ' · no byte counts'}`,
    `3. Proxy layer: ${c.proxy === 'on' ? `on at 127.0.0.1:${c.proxyPort}` : c.proxy === 'error' ? 'failed to start' : 'off (/config → Proxy layer, or /orbit proxy on)'}`,
    `Geo: ${c.geo === 'ready' ? `ready (${geoFiles.geo}${geoFiles.asn ? ' + ASN' : ', no ASN db'})` : c.geo === 'no-node' ? 'needs Node.js' : c.geo === 'downloading' ? `downloading ${c.geoNote}` : 'no database: /orbit geodb'}`,
    `Home: ${currentHome.source === 'none' ? 'unset (/config → Your location, or /orbit locate)' : `${currentHome.label || ''} ${currentHome.lat}, ${currentHome.lon} (${currentHome.source})`}`,
    `Picture: ${currentRenderer === 'image' ? 'real pixels' : 'colored blocks'}`,
  ]
  return lines.join('\n')
}

export const register: Register = (on, opts) => {
  options = (opts ?? {}) as Options
  fadeMs = Math.max(2, Number(options.fadeSeconds) || 25) * 1000
  nodeBin = options.node || 'node'
  currentMode = MODES.includes(options.enforcement as Mode) ? (options.enforcement as Mode) : 'denylist'

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (!options.statusLine) $.ui.status(undefined)
    await $.command.register({
      name: 'orbit',
      description: 'A globe of what this session talks to. /orbit (pane), all|session, block|allow|unblock <host|mcp:server>, rules, mode <off|denylist|allowlist|ask>, export, replay, locate, home <lat,lon>, geodb, proxy on|off, check, clear',
    })
    homeDir = (await $.env.get('HOME')) ?? ''
    sessionId = await $.session.id().catch(() => '')

    live.load(await read($, events))
    const stored = (await $.store.get('rules')) as Rule[] | undefined
    currentRules = Array.isArray(stored) ? stored : []
    await update($, rules, () => currentRules)
    await update($, mode, () => currentMode)
    currentScope = await read($, scope)
    currentSpin = await read($, spin)
    currentSelected = await read($, selectedId)
    const configured = parseLocation(options.location ?? '')
    const remembered = (await $.store.get('home')) as OrbitHome | undefined
    currentHome = configured ?? (remembered && remembered.source === 'lookup' ? remembered : { lat: 0, lon: 0, label: '', source: 'none' })
    await update($, home, () => currentHome)
    currentRenderer = e.surface === 'terminal' ? await pickRenderer($) : 'cells'
    await update($, renderer, () => currentRenderer)
    const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
    await update($, isPaneOpen, () => isOpen)
    await update($, ask, () => null)
    replay = null
    await update($, replayState, () => null)

    if (e.isInteractive) {
      void (async () => {
        await checkCapabilities($)
        if (options.proxy) await startProxy($)
        await poll($)
      })().catch(err => $.ui.log(`orbit: start: ${(err as Error).message}`, { to: 'debug' }))
      $.clock.every(FRAME_MS, () => void frame($).catch(() => {}))
      $.clock.every(POLL_MS, () => void poll($).catch(() => {}))
      $.clock.every(GEO_MS, () => void lookupPending($).catch(() => {}))
      $.clock.every(FLUSH_MS, () => void flush($).catch(() => {}))
    }
    return result
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (!isTraced(tool)) return next(e)
    const intent = intentOf(e as any)
    if (intent.kind === 'none') return next(e)
    const decisions = decide(currentRules, currentMode, intent)
    let v = verdict(decisions)
    if (v?.action === 'ask' && (v.kind === 'host' || v.kind === 'mcp')) {
      const answer = await askUser($, { kind: v.kind, subject: v.subject }, tool, intent.summary)
      v = answer === 'deny' ? { ...v, action: 'deny' } : undefined
    }
    if (v?.action === 'deny') {
      const why = v.rule ? describeRule(v.rule) : currentMode === 'allowlist' ? `not on the allow list (${v.kind}:${v.subject})` : `denied when asked (${v.kind}:${v.subject})`
      live.recordTool(intent, owner, now(), 'blocked', why)
      void flush($)
      return { deny: `orbit blocked this call: ${why}. /orbit allow ${v.kind}:${v.subject} lets it through.` }
    }
    const recorded = live.recordTool(intent, owner, now(), 'open')
    void flush($)
    const ran = await next(e)
    const bytes = ran.deny === undefined && typeof ran.text === 'string' ? ran.text.length : 0
    live.finishTool(recorded.map(r => r.id), now(), ran.deny !== undefined || ran.isError === true, bytes)
    return ran
  })

  on('turn.step', async function* ($, e, next) {
    const sees = caps.sockets === '' || caps.sockets === 'proc'
    const host = (() => {
      try {
        return new URL(String((e as any).baseUrl ?? '')).hostname
      } catch {
        return 'api.anthropic.com'
      }
    })()
    if (sees) live.recordStream(owner, host, now())
    generatingUntil = now() + 2000
    let bytes = 0
    try {
      for await (const chunk of next(e)) {
        generatingUntil = now() + 1500
        if (chunk.kind === 'text') bytes += chunk.text.length
        yield chunk
      }
    } finally {
      generatingUntil = now() + 300
      if (sees) live.closeStream(owner, now(), bytes)
    }
  })

  on('command.run', { command: 'orbit' }, async ($, e) => {
    const [word = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ')
    switch (word) {
      case '': {
        if (await read($, isPaneOpen)) {
          await $.ui.close({ id: PANE })
          return { text: 'Orbit closed.' }
        }
        const opened = await $.ui.open({ id: PANE, title: 'Orbit' })
        await update($, isPaneOpen, () => true)
        return { text: opened.isPlaced ? 'Orbit opened.' : 'Orbit opened; widen the terminal to see it.' }
      }
      case 'all':
      case 'session':
        await setScope($, word)
        return { text: word === 'all' ? 'Observing every Claude session on this machine.' : 'Observing this session only.' }
      case 'block':
        return { text: await addRule($, arg, 'deny') }
      case 'allow':
        return { text: await addRule($, arg, 'allow') }
      case 'unblock':
      case 'unrule': {
        const parsed = parseSubject(arg)
        if (!parsed) return { text: 'Name the rule: /orbit unblock example.com' }
        await saveRules($, withoutRule(currentRules, parsed.kind, parsed.pattern))
        return { text: `Removed any rule for ${parsed.kind}:${parsed.pattern}.` }
      }
      case 'rules':
        return { text: currentRules.length ? `Enforcement: ${currentMode}\n${currentRules.map(r => `  ${describeRule(r)}`).join('\n')}` : `Enforcement: ${currentMode}. No rules yet: /orbit block <host|mcp:server|tool:Tool>.` }
      case 'mode': {
        if (!MODES.includes(arg as Mode)) return { text: `Modes: ${MODES.join(', ')}. Currently ${currentMode}.` }
        currentMode = arg as Mode
        await update($, mode, () => currentMode)
        return { text: `Enforcement: ${currentMode}${currentMode === 'ask' ? ' (a dialog asks about each new host; 8 seconds, then deny)' : ''}. /config → Enforcement sets the default.` }
      }
      case 'export':
        return { text: await exportTrace($, arg) }
      case 'replay':
        if (arg === 'off' || arg === 'close') {
          replay = null
          await update($, replayState, () => null)
          return { text: 'Replay closed; live again.' }
        }
        return { text: await openReplayFile($, arg) }
      case 'locate':
        return { text: await locate($) }
      case 'home': {
        const parsed = parseLocation(arg)
        if (!parsed) return { text: 'Give a latitude and longitude: /orbit home 49.28,-123.12 Vancouver' }
        await setHome($, { ...parsed, source: 'lookup' })
        return { text: `Home set to ${parsed.lat}, ${parsed.lon}${parsed.label ? ` (${parsed.label})` : ''}. Saved for next time; /config → Your location overrides it.` }
      }
      case 'geodb':
        return { text: await downloadGeo($, arg === 'country' ? 'country' : 'city') }
      case 'proxy':
        if (arg === 'on') {
          await startProxy($)
          return { text: caps.node ? 'Starting the local proxy; commands and MCP servers started from now on go through it.' : 'The proxy helper needs Node.js.' }
        }
        if (arg === 'off') {
          await stopProxy($)
          return { text: 'Proxy stopped; HTTPS_PROXY restored.' }
        }
        return { text: `Proxy is ${caps.proxy}${caps.proxyPort ? ` on 127.0.0.1:${caps.proxyPort}` : ''}. /orbit proxy on|off.` }
      case 'check':
        return { text: await checkReport($) }
      case 'clear':
        actionsFor($).clear()
        return { text: 'Trace cleared.' }
      default:
        return { text: 'Usage: /orbit · all | session · block|allow|unblock <host|mcp:server|tool:Tool> · rules · mode <off|denylist|allowlist|ask> · export [path] · replay [file|off] · locate · home <lat,lon> · geodb [country] · proxy on|off · check · clear' }
    }
  })

  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) {
      await update($, isPaneOpen, () => false)
      views = views.filter(v => v.requestId !== PANE)
    }
    if (e.id === ASK_PANE) pendingAsk?.resolve('deny')
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [shownEvents, currentRules_, m, s, h, sel, c, r, all, rend, sp] = await Promise.all([
      read($, events), read($, rules), read($, mode), read($, scope), read($, home), read($, selectedId), read($, capabilities), read($, replayState), read($, sessions), read($, renderer), read($, spin),
    ])
    void currentRules_
    const listed = replay ? eventsAt(replay, replay.position) : s === 'all' ? shownEvents : shownEvents.filter(ev => ev.sessionPid === c.self || ev.sessionPid === 0)
    let globe: GlobeBox | null = null
    if (e.surface === 'terminal') {
      const width = e.props.bodyColumns
      const sideBySide = width >= 96
      const columns = Math.max(16, Math.min(sideBySide ? 48 : width - 2, 64))
      const rows = Math.max(8, Math.round(columns / 2))
      const view: View = { requestId: PANE, columns, rows, renderer: rend }
      views = [...views.filter(v => v.requestId !== PANE), view]
      const scene = sceneFor(view, now(), replay ? replay.position : now(), listed as TraceEvent[])
      const painted = paint(view, scene)
      globe = { columns, rows, renderer: rend, cells: painted.cells ?? '', png: painted.png ?? '' }
      lastFrameAt = now()
    }
    return drawPane($.ui.resolve(e) as Table, {
      surface: e.surface,
      bodyColumns: e.props.bodyColumns,
      viewportRows: e.viewport?.rows ?? 40,
      events: listed as TraceEvent[],
      summary: summarize(listed as TraceEvent[]),
      scope: s,
      mode: m,
      rules: currentRules,
      home: h,
      selectedId: sel,
      capabilities: c,
      replay: r,
      sessions: all,
      globe,
      isGenerating: now() < generatingUntil,
      spin: sp,
    }, actionsFor($))
  })

  on('ui.render', { component: 'Pane', requestId: ASK_PANE }, async ($, e) => {
    const question = await read($, ask)
    const { Text } = $.ui.resolve(e)
    if (!question) return <Text dimColor>Nothing to ask.</Text>
    return drawAsk($.ui.resolve(e) as Table, question, (answer, isAlways) => {
      if (isAlways) void saveRules($, withRule(currentRules, { kind: question.kind, pattern: question.subject, action: answer, at: now() }))
      pendingAsk?.resolve(answer)
    })
  })
}
