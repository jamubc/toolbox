import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { Pixels } from '../hooks/canvas'
import { anycastOf, formatIp, inPrefix, isLocal, normalizeHost, parseIp } from '../hooks/geo'
import { greatCircle, render, subsolarPoint } from '../hooks/globe'
import { isLand } from '../hooks/land'
import { Live } from '../hooks/model'
import { eventLine } from '../hooks/pane'
import { adler32, crc32, deflate, encodePng } from '../hooks/png'
import { countersInNettop, sessionOf, sessionsIn, socketsInLsof, socketsInProc, socketsInSs, treeOf } from '../hooks/procs'
import { decide, matchesPattern, parseSubject, verdict, withRule, type Rule } from '../hooks/rules'
import { hostsInCommand, intentOf } from '../hooks/tools'
import { arcsFor, eventsAt, fromJsonl, newEvent, openReplay, stepReplay, summarize, toJsonl } from '../hooks/trace'

// A `ps -x -o pid=,ppid=,tty=,args=` table: two sessions, one mid-turn, with a shell and an MCP
// server beneath the first, plus the daemon, which does not count.
const PS = `
61627     1 ??       /Users/jam/.local/bin/claude daemon run --json-path /Users/jam/.claude/daemon.json
94901 86963 ttys001  claude --resume c1bdb8b8
94950 94901 ttys001  /bin/zsh -c curl https://api.github.com/repos
94960 94901 ttys001  node /Users/jam/mcp/server.js
94970 94960 ttys001  /usr/bin/python3 helper.py
15621 15520 ttys010  claude
19785 15621 ttys010  caffeinate -i -t 300
25341     1 ??       /opt/homebrew/bin/python3 server.py
`
const SH = `70001\n${PS}70001 94901 ttys001  ps -x -o pid=,ppid=,tty=,args=\n`

const LSOF = [
  'p94901', 'f12', 'PTCP', 'n192.168.1.20:52345->160.79.104.10:443', 'TST=ESTABLISHED',
  'f13', 'PTCP', 'n*:3000', 'TST=LISTEN',
  'f14', 'PTCP', 'n192.168.1.20:3000->203.0.113.9:40000', 'TST=ESTABLISHED',
  'p94950', 'f5', 'PTCP', 'n192.168.1.20:52400->140.82.112.6:443', 'TST=ESTABLISHED',
  'p94960', 'f9', 'PUDP', 'n192.168.1.20:60000->8.8.8.8:53',
].join('\n')

const SS = [
  'tcp   ESTAB 0 0 192.168.1.20:52345 160.79.104.10:443 users:(("claude",pid=94901,fd=12))',
  '\t cubic wscale:7,7 bytes_sent:1200 bytes_acked:1200 bytes_received:34000 segs_out:40',
  'tcp   ESTAB 0 0 [::ffff:192.168.1.20]:52400 [::ffff:140.82.112.6]:443 users:(("curl",pid=94950,fd=5))',
  '\t cubic bytes_acked:300 bytes_received:5000',
  'tcp   ESTAB 0 0 10.0.0.5:4000 10.0.0.9:5000 users:(("other",pid=1,fd=3))',
  'udp   UNCONN 0 0 0.0.0.0:5353 0.0.0.0:* users:(("node",pid=94960,fd=9))',
].join('\n')

const NETTOP = [
  'time,,interface,state,bytes_in,bytes_out',
  '12:00:00.000000,claude.94901,,,34000,1200',
  '12:00:00.000000,tcp4 192.168.1.20:52345<->160.79.104.10:443,en0,Established,34000,1200',
].join('\n')

const PROC = [
  'P 94901',
  'socket:[12345]',
  'P 94950',
  'socket:[777]',
  'TABLE',
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
  '   0: 1401A8C0:CC79 0A684FA0:01BB 01 00000000:00000000 00:00000000 00000000  501        0 12345 1 0 0 10 0',
  '   1: 1401A8C0:CC90 0670528C:01BB 01 00000000:00000000 00:00000000 00000000  501        0 777 1 0 0 10 0',
  '   2: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  501        0 999 1 0 0 10 0',
].join('\n')

const owner = { sessionPid: 94901, session: 'this session', cmd: 'claude' }
const ownerOf = (pid: number) => (pid === 94901 || pid === 94950 || pid === 94960 ? { ...owner, cmd: pid === 94901 ? 'claude' : pid === 94950 ? 'curl' : 'node' } : undefined)

describe('addresses', () => {
  test('parses, formats and classifies v4 and v6 addresses', async () => {
    expect(formatIp(parseIp('192.168.1.20')!)).toBe('192.168.1.20')
    expect(formatIp(parseIp('::ffff:140.82.112.6')!)).toBe('140.82.112.6')
    expect(formatIp(parseIp('2606:4700::6810:84e5')!)).toBe('2606:4700::6810:84e5')
    expect(parseIp('999.1.1.1')).toBeNull()
    expect(parseIp('not an address')).toBeNull()
    expect(isLocal(parseIp('127.0.0.1')!)).toBe(true)
    expect(isLocal(parseIp('10.1.2.3')!)).toBe(true)
    expect(isLocal(parseIp('fe80::1')!)).toBe(true)
    expect(isLocal(parseIp('140.82.112.6')!)).toBe(false)
    expect(inPrefix(parseIp('104.18.3.2')!, '104.16.0.0/13')).toBe(true)
    expect(inPrefix(parseIp('104.32.0.1')!, '104.16.0.0/13')).toBe(false)
    expect(anycastOf(parseIp('160.79.104.10')!)).toBe('Anthropic')
    expect(anycastOf(parseIp('104.18.3.2')!)).toBe('Cloudflare')
    expect(anycastOf(parseIp('2606:4700::1')!)).toBe('Cloudflare')
    expect(anycastOf(parseIp('140.82.112.6')!)).toBe('')
    expect(normalizeHost('API.GitHub.com:443')).toBe('api.github.com')
    expect(normalizeHost('[2606:4700::1]:443')).toBe('2606:4700::1')
  })
})

describe('tool layer', () => {
  test('reads the hosts a tool call reaches', async () => {
    expect(intentOf({ tool: 'WebFetch', url: 'https://docs.anthropic.com/en/docs', prompt: 'x' })).toMatchObject({ kind: 'host', hosts: ['docs.anthropic.com'] })
    expect(intentOf({ tool: 'WebSearch', query: 'terminal globes' })).toMatchObject({ kind: 'search', hosts: [] })
    expect(intentOf({ tool: 'mcp__github__get_me' })).toMatchObject({ kind: 'mcp', server: 'github' })
    expect(intentOf({ tool: 'Read', file_path: '/x' }).kind).toBe('none')
    expect(intentOf({ tool: 'Bash', command: 'ls -la' })).toMatchObject({ kind: 'host', hosts: [] })
  })

  test('finds hosts in shell commands, each once', async () => {
    expect(hostsInCommand('curl -sS https://api.github.com/repos | jq . && curl http://api.github.com/x')).toEqual(['api.github.com'])
    expect(hostsInCommand('git clone git@github.com:jamubc/toolbox.git')).toEqual(['github.com'])
    expect(hostsInCommand('ssh -p 2222 deploy@build.example.net uptime')).toEqual(['build.example.net'])
    expect(hostsInCommand('pip install requests --index-url https://pypi.org/simple')).toEqual(['pypi.org'])
    expect(hostsInCommand('nc 203.0.113.9 4000 < file')).toEqual(['203.0.113.9'])
    expect(hostsInCommand('curl http://localhost:3000/health')).toEqual([])
    expect(hostsInCommand('echo hello world')).toEqual([])
  })
})

describe('process layer', () => {
  test('finds sessions, this session, and the tree beneath it', async () => {
    expect(sessionsIn(PS).map(s => s.pid)).toEqual([94901, 15621])
    expect(sessionsIn(PS).find(s => s.pid === 15621)?.isWorking).toBe(true)
    expect(sessionOf(SH, 70001)).toBe(94901)
    expect([...treeOf(PS, 94901).keys()]).toEqual([94901, 94950, 94960, 94970])
    expect(treeOf(PS, 94901).get(94960)).toBe('node')
    expect(treeOf(PS, 404).size).toBe(0)
  })

  test('parses lsof, ss and /proc sockets', async () => {
    const lsof = socketsInLsof(LSOF)
    expect(lsof.map(s => `${s.pid} ${s.proto} ${s.remote}:${s.remotePort} ${s.state}`)).toEqual([
      '94901 tcp 160.79.104.10:443 ESTABLISHED',
      '94901 tcp :0 LISTEN',
      '94901 tcp 203.0.113.9:40000 ESTABLISHED',
      '94950 tcp 140.82.112.6:443 ESTABLISHED',
      '94960 udp 8.8.8.8:53 ',
    ])
    const ss = socketsInSs(SS, new Set([94901, 94950, 94960]))
    expect(ss.map(s => `${s.pid} ${s.remote}:${s.remotePort} ${s.bytesIn}/${s.bytesOut}`)).toEqual(['94901 160.79.104.10:443 34000/1200', '94950 140.82.112.6:443 5000/300', '94960 :0 -1/-1'])
    const proc = socketsInProc(PROC)
    expect(proc.map(s => `${s.pid} ${s.local}:${s.localPort}>${s.remote}:${s.remotePort} ${s.state}`)).toEqual([
      '94901 192.168.1.20:52345>160.79.104.10:443 ESTABLISHED',
      '94950 192.168.1.20:52368>140.82.112.6:443 ESTABLISHED',
    ])
    expect(countersInNettop(NETTOP)).toEqual([{ local: '192.168.1.20', localPort: 52345, remote: '160.79.104.10', remotePort: 443, bytesIn: 34000, bytesOut: 1200 }])
    expect(countersInNettop('')).toEqual([])
  })

  test('folds sockets into events: open, inbound, correlated, counted, then closed', async () => {
    const live = new Live()
    const t0 = 1_700_000_000_000
    const [fetched] = live.recordTool(intentOf({ tool: 'Bash', command: 'curl https://api.github.com/repos' }), owner, t0, 'open')
    live.observeSockets(socketsInLsof(LSOF), ownerOf, t0 + 500, countersInNettop(NETTOP))
    const sockets = live.events.filter(e => e.layer === 'socket')
    expect(sockets.map(e => `${e.ip}:${e.port} ${e.direction}`)).toEqual(['160.79.104.10:443 out', '203.0.113.9:40000 in', '140.82.112.6:443 out', '8.8.8.8:53 out'])
    const anthropic = sockets[0]!
    expect(anthropic.host).toBe('api.anthropic.com')
    expect(anthropic.place?.anycast).toBe('Anthropic')
    expect(anthropic.bytesIn).toBe(34000)
    const github = sockets[2]!
    expect(github.host).toBe('api.github.com')
    expect(github.linked).toBe(fetched!.id)
    expect(live.get(fetched!.id)?.ip).toBe('140.82.112.6')
    expect([...live.pendingIps]).toContain('140.82.112.6')
    live.applyGeo([{ ip: '140.82.112.6', country: 'US', city: 'Ashburn', lat: 39.04, lon: -77.49, org: 'GitHub' }])
    expect(live.get(github.id)?.place).toMatchObject({ country: 'US', city: 'Ashburn', org: 'GitHub' })
    expect(live.get(fetched!.id)?.place?.country).toBe('US')
    live.observeSockets([], ownerOf, t0 + 3000)
    expect(live.get(github.id)?.status).toBe('closed')
    expect(summarize(live.events).countries).toEqual(['US'])
  })

  test('reads the proxy log into events with their peer address and bytes', async () => {
    const live = new Live()
    live.observeProxy(
      [
        '{"t":1,"type":"open","id":7,"host":"registry.npmjs.org","port":443,"method":"CONNECT","scheme":"tls"}',
        '{"t":2,"type":"ip","id":7,"ip":"104.16.1.1"}',
        '{"t":3,"type":"close","id":7,"host":"registry.npmjs.org","port":443,"bytesIn":9000,"bytesOut":400,"ms":120}',
        'garbage',
      ],
      owner,
      5,
    )
    expect(live.events).toHaveLength(1)
    expect(live.events[0]).toMatchObject({ layer: 'proxy', host: 'registry.npmjs.org', ip: '104.16.1.1', status: 'closed', bytesIn: 9000, bytesOut: 400 })
    expect(live.events[0]!.place?.org).toBe('npm')
  })
})

describe('rules', () => {
  const rules: Rule[] = [
    { kind: 'host', pattern: 'example.com', action: 'deny', at: 1 },
    { kind: 'host', pattern: 'ok.example.com', action: 'allow', at: 2 },
    { kind: 'host', pattern: '*.cdn.net', action: 'deny', at: 3 },
    { kind: 'mcp', pattern: 'github', action: 'deny', at: 4 },
  ]

  test('matches domains, subdomains, globs and the most specific rule', async () => {
    expect(matchesPattern('example.com', 'api.example.com')).toBe(true)
    expect(matchesPattern('example.com', 'notexample.com')).toBe(false)
    expect(matchesPattern('*.cdn.net', 'a.b.cdn.net')).toBe(true)
    expect(matchesPattern('*', 'anything')).toBe(true)
    expect(parseSubject('mcp:github')).toEqual({ kind: 'mcp', pattern: 'github' })
    expect(parseSubject('tool:WebSearch')).toEqual({ kind: 'tool', pattern: 'WebSearch' })
    expect(parseSubject('Example.COM')).toEqual({ kind: 'host', pattern: 'example.com' })
    const fetch = (url: string) => intentOf({ tool: 'WebFetch', url, prompt: '' })
    expect(verdict(decide(rules, 'denylist', fetch('https://api.example.com/')))?.action).toBe('deny')
    expect(verdict(decide(rules, 'denylist', fetch('https://ok.example.com/')))).toBeUndefined()
    expect(verdict(decide(rules, 'denylist', fetch('https://x.cdn.net/')))?.action).toBe('deny')
    expect(verdict(decide(rules, 'denylist', intentOf({ tool: 'mcp__github__get_me' })))?.action).toBe('deny')
    expect(verdict(decide(rules, 'off', fetch('https://api.example.com/')))).toBeUndefined()
    expect(verdict(decide(rules, 'allowlist', fetch('https://other.org/')))?.action).toBe('deny')
    expect(verdict(decide(rules, 'allowlist', fetch('https://ok.example.com/')))).toBeUndefined()
    expect(verdict(decide(rules, 'ask', fetch('https://other.org/')))?.action).toBe('ask')
    expect(verdict(decide([], 'ask', intentOf({ tool: 'Bash', command: 'ls' })))).toBeUndefined()
    expect(withRule(rules, { kind: 'host', pattern: 'example.com', action: 'allow', at: 9 }).filter(r => r.pattern === 'example.com')).toHaveLength(1)
  })
})

describe('globe', () => {
  test('knows land from sea', async () => {
    expect(isLand(39, -98)).toBe(true)
    expect(isLand(48.85, 2.35)).toBe(true)
    expect(isLand(-25, 134)).toBe(true)
    expect(isLand(30, -40)).toBe(false)
    expect(isLand(0, -150)).toBe(false)
  })

  test('puts the sun where the season and the hour say', async () => {
    const june = subsolarPoint(Date.UTC(2026, 5, 21, 12, 0, 0))
    expect(june.lat).toBeGreaterThan(22)
    expect(Math.abs(june.lon)).toBeLessThan(6)
    const december = subsolarPoint(Date.UTC(2026, 11, 21, 0, 0, 0))
    expect(december.lat).toBeLessThan(-22)
    expect(Math.abs(Math.abs(december.lon) - 180)).toBeLessThan(6)
  })

  test('great circles start and end where asked', async () => {
    const points = greatCircle({ lat: 49.28, lon: -123.12 }, { lat: 35.68, lon: 139.69 }, 20)
    expect(points).toHaveLength(20)
    expect(Math.abs(points[0]!.lat - 49.28)).toBeLessThan(0.01)
    expect(Math.abs(points[19]!.lon - 139.69)).toBeLessThan(0.01)
    expect(Math.max(...points.map(p => p.lat))).toBeGreaterThan(50) // over the Aleutians
  })

  test('renders half-block cells and a valid PNG', async () => {
    const home = { lat: 49.28, lon: -123.12 }
    const scene = {
      width: 40, height: 40, center: home, time: Date.UTC(2026, 5, 21, 20, 0, 0), home,
      arcs: [{ from: home, to: { lat: 37.77, lon: -122.42 }, color: 0xffa726, strength: 1, progress: 1, pulse: 0.5, thickness: 2, isDashed: false, isSelected: false }],
      dots: [], isQuantized: true, hasGrid: true,
    }
    const px = render(scene)
    expect(px.get(20, 20)).toBeGreaterThanOrEqual(0) // the center is on the sphere
    expect(px.get(0, 0)).toBe(-1) // the corner is space
    const cells = Uint8Array.fromBase64(px.toCells())
    expect(cells.length).toBe(40 * 20 * 3 * 4)
    const words = new Uint32Array(cells.buffer)
    expect(words[(10 * 40 + 20) * 3]).toBe(0x2580)
    const png = encodePng(px.toRgba(), 40, 40)
    expect(Array.from(png.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(png.length).toBeLessThan(40 * 40 * 4)
  })

  test('deflate carries its checksums', async () => {
    const data = new Uint8Array(3000).map((_, i) => (i * 7) & 0xff)
    expect(deflate(data).length).toBeLessThan(data.length)
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
    expect(adler32(new TextEncoder().encode('Wikipedia'))).toBe(0x11e60398)
    const empty = new Pixels(2, 2)
    expect(empty.toCells().length).toBeGreaterThan(0)
  })
})

describe('trace', () => {
  const home = { lat: 49.28, lon: -123.12 }
  const place = { lat: 39.04, lon: -77.49, country: 'US', city: 'Ashburn', org: 'GitHub', isAnycast: false, anycast: '' }

  test('draws arcs for placed events, fading after they close', async () => {
    const t0 = 1_700_000_000_000
    const open = newEvent({ t: t0, layer: 'socket', host: 'api.github.com', ip: '140.82.112.6', place, status: 'open', bytesIn: 50000 })
    const closed = { ...open, id: 'x', status: 'closed' as const, last: t0 + 1000 }
    const unplaced = newEvent({ t: t0, layer: 'tool', host: 'nowhere.test', place: null })
    const options = { now: t0 + 2000, fadeMs: 10000, home, bySession: false, selectedId: 'x', isGenerating: false }
    const arcs = arcsFor([open, closed, unplaced], options)
    expect(arcs).toHaveLength(2)
    expect(arcs[0]!.from).toEqual(home)
    expect(arcs[0]!.pulse).toBe(-1)
    expect(arcs[1]!.isSelected).toBe(true)
    expect(arcs[1]!.strength).toBeLessThan(arcs[0]!.strength)
    expect(arcsFor([closed], { ...options, now: t0 + 20000 })).toHaveLength(0)
    const inbound = arcsFor([{ ...open, direction: 'in' }], options)[0]!
    expect(inbound.to).toEqual(home)
  })

  test('round-trips JSONL and replays it in time', async () => {
    const t0 = 1_700_000_000_000
    const a = newEvent({ t: t0, layer: 'tool', host: 'a.test', status: 'done', last: t0 + 500 })
    const b = newEvent({ t: t0 + 4000, layer: 'socket', ip: '1.2.3.4', status: 'closed', last: t0 + 6000, place })
    const text = toJsonl([a, b])
    expect(text.split('\n').filter(Boolean)).toHaveLength(2)
    const back = fromJsonl(text + 'not json\n')
    expect(back.map(e => e.id)).toEqual([a.id, b.id])
    const replay = openReplay('/x/trace.jsonl', back)!
    expect(replay.start).toBe(t0 - 1000)
    expect(eventsAt(replay, t0 + 100)).toHaveLength(1)
    expect(eventsAt(replay, t0 + 5000)[1]!.status).toBe('open') // b is still going at that moment
    const later = stepReplay(replay, 1000) // 1 s at 4×
    expect(later.position).toBe(replay.start + 4000)
    expect(stepReplay({ ...replay, position: replay.end - 1 }, 1000).isPlaying).toBe(false)
    expect(fromJsonl('')).toEqual([])
  })

  test('writes a log line that fits its width', async () => {
    const e = newEvent({ t: 1_700_000_000_000, layer: 'socket', tool: 'WebFetch', host: 'api.github.com', ip: '140.82.112.6', place, bytesIn: 51200, bytesOut: 800, status: 'closed' })
    const line = eventLine(e, 80, false)
    expect(line).toContain('api.github.com')
    expect(line).toContain('GitHub')
    expect(line).toContain('US')
    expect(line).toContain('↓50k')
    expect(line.length).toBeLessThanOrEqual(80)
  })
})

/** Stubs the engine beneath the mod on a Mac with lsof and no geo database. */
function engine(on: On, calls: string[][] = []) {
  const clock = mock.clock(on)
  mock.store(on, {})
  mock.env(on, { HOME: '/Users/jam', TERM: 'xterm-256color' })
  on('process.run', ($, e) => {
    calls.push([...e.argv])
    const argv0 = e.argv[0]
    let stdout = ''
    if (argv0 === 'ps') stdout = PS
    else if (argv0 === 'sh' && e.argv[2]?.startsWith('echo $$')) stdout = SH
    else if (argv0 === 'sh' && e.argv[2]?.includes('command -v')) stdout = e.argv[4] === 'lsof' ? '/usr/sbin/lsof\n' : e.argv[4] === 'node' ? '/usr/local/bin/node\n' : ''
    else if (argv0 === 'uname') stdout = 'Darwin\n'
    else if (argv0 === 'lsof' && e.argv.includes('-i')) stdout = LSOF
    else if (argv0 === 'nettop') stdout = NETTOP
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'test-session' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'orbit' } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.blit', () => ({ value: {} }))
  on('ui.render', ($, e) => $.ui.resolve(e).Box({}))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  return clock
}

const boot = async ($: Engine, clock: ReturnType<typeof mock.clock>) => {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
  await clock.settle()
}

const run = ($: Engine, args = '') => $.command.run({ command: 'orbit', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as any)

const pane = (surface: 'terminal' | 'desktop') =>
  ({
    plugin: 'orbit',
    surface,
    component: 'Pane',
    requestId: 'orbit',
    props: { title: 'Orbit', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    viewport: { columns: 160, rows: 48, isFullscreen: true },
  }) as any

describe('mod', () => {
  test('opens the pane with /orbit and draws the globe and the trace', async ($, on) => {
    const clock = engine(on)
    await boot($, clock)
    expect((await run($)).text).toBe('Orbit opened.')
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount(pane(surface))
      expect(await ui.find({ type: 'Text', text: /talked to/ })).toBeDefined()
      if (surface === 'terminal') expect(await ui.find({ key: 'globe' })).toBeDefined()
      await ui.unmount()
    }
    expect((await run($)).text).toBe('Orbit closed.')
  })

  test('blocks a fetch to a blocked host before it runs, and logs it', async ($, on) => {
    const clock = engine(on)
    await boot($, clock)
    expect((await run($, 'block example.com')).text).toContain('Blocking host:example.com')
    expect((await run($, 'rules')).text).toContain('block host:example.com')
    const ran = await $.tool.call({ tool: 'WebFetch', url: 'https://api.example.com/x', prompt: 'read' } as any)
    expect(ran.deny).toContain('orbit blocked')
    const ui = await $.ui.mount(pane('terminal'))
    expect(await ui.find({ type: 'Button', text: /api\.example\.com/ })).toBeDefined()
    await ui.unmount()
    expect((await run($, 'unblock example.com')).text).toContain('Removed')
  })

  test('lets other hosts through, and allowlist mode blocks what is not allowed', async ($, on) => {
    const clock = engine(on)
    let reached = 0
    on('tool.call', { tool: 'WebFetch' }, () => {
      reached++
      return { result: { bytes: 10, code: 200, codeText: 'OK', result: 'ok', durationMs: 1, url: 'https://ok.test/' } } as any
    })
    await boot($, clock)
    const ran = await $.tool.call({ tool: 'WebFetch', url: 'https://ok.test/', prompt: 'read' } as any)
    expect(ran.deny).toBeUndefined()
    expect(reached).toBe(1)
    await run($, 'mode allowlist')
    const denied = await $.tool.call({ tool: 'WebFetch', url: 'https://ok.test/', prompt: 'read' } as any)
    expect(denied.deny).toContain('not on the allow list')
    await run($, 'allow ok.test')
    const allowed = await $.tool.call({ tool: 'WebFetch', url: 'https://ok.test/', prompt: 'read' } as any)
    expect(allowed.deny).toBeUndefined()
    expect(reached).toBe(2)
  })

  test('reports its capabilities from ps, uname and lsof', async ($, on) => {
    const calls: string[][] = []
    const clock = engine(on, calls)
    await boot($, clock)
    const report = (await run($, 'check')).text
    expect(report).toContain('Platform: Darwin')
    expect(report).toContain('sockets via lsof')
    expect(report).toContain('no database')
    expect(calls.some(c => c[0] === 'lsof' && c.includes('-i'))).toBe(true)
  })
})
