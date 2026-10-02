// The process layer: the Claude session's process tree and the sockets it holds, read from `ps`
// and `lsof` on macOS, `ss` (or /proc) on Linux. Pure parsers and argv builders; register.tsx runs
// them. Everything here is read-only and needs no privileges for the user's own processes.

export const PS_ARGV = ['ps', '-x', '-o', 'pid=,ppid=,tty=,args='] as const

export type Proc = { pid: number; ppid: number; tty: string; cmd: string; args: string }

const base = (path: string) => path.slice(path.lastIndexOf('/') + 1)

export function procsIn(ps: string): Proc[] {
  return ps
    .split('\n')
    .map(line => {
      const [pid = '', ppid = '', tty = '', argv0 = '', ...rest] = line.trim().split(/\s+/)
      return { pid: Number(pid), ppid: Number(ppid), tty, cmd: base(argv0), args: rest.join(' ') }
    })
    .filter(p => p.pid > 0 && p.cmd !== '')
}

/** `claude` with a terminal, and not one of the daemon's helpers: how redline counts sessions. */
export const isSession = (p: Proc) =>
  p.cmd === 'claude' && p.tty !== '??' && p.tty !== '?' && p.tty !== '' && !p.args.startsWith('daemon') && !p.args.startsWith('bg-')

export type Session = { pid: number; tty: string; cwd: string; isWorking: boolean }

export function sessionsIn(ps: string): Session[] {
  const procs = procsIn(ps)
  const caffeinated = new Set(procs.filter(p => p.cmd === 'caffeinate').map(p => p.ppid))
  return procs
    .filter(isSession)
    .map(p => ({ pid: p.pid, tty: p.tty, cwd: '', isWorking: caffeinated.has(p.pid) }))
    .sort((a, b) => a.tty.localeCompare(b.tty) || a.pid - b.pid)
}

/** The session `pid` runs under: itself or its nearest session ancestor; 0 for none. */
export function sessionOf(ps: string, pid: number): number {
  const procs = new Map(procsIn(ps).map(p => [p.pid, p]))
  for (let p = procs.get(pid), hops = 0; p && hops < 64; p = procs.get(p.ppid), hops++) {
    if (isSession(p)) return p.pid
  }
  return 0
}

/** `root` and every process beneath it, with each one's command name. */
export function treeOf(ps: string, root: number): Map<number, string> {
  const procs = procsIn(ps)
  const children = new Map<number, Proc[]>()
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p])
  const out = new Map<number, string>()
  const self = procs.find(p => p.pid === root)
  if (!self) return out
  const queue = [self]
  while (queue.length) {
    const p = queue.shift()!
    if (out.has(p.pid)) continue
    out.set(p.pid, p.cmd)
    for (const c of children.get(p.pid) ?? []) queue.push(c)
  }
  return out
}

/** Working directories of `pids`, in lsof's field format: `p<pid>`, then `n<path>`. */
export const lsofCwdArgv = (pids: readonly number[]) => ['lsof', '-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')]

export function cwdsIn(lsof: string): Map<number, string> {
  const cwds = new Map<number, string>()
  let pid = 0
  for (const line of lsof.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid) cwds.set(pid, line.slice(1))
  }
  return cwds
}

/** One socket a process holds. Bytes are -1 where the source does not count them. */
export type Socket = {
  pid: number
  proto: 'tcp' | 'udp'
  local: string
  localPort: number
  remote: string
  remotePort: number
  state: string // ESTABLISHED, LISTEN, SYN_SENT, ...; '' for UDP
  bytesIn: number
  bytesOut: number
}

export const socketKey = (s: Socket) => `${s.pid} ${s.proto} ${s.local}:${s.localPort}>${s.remote}:${s.remotePort}`

/** A host as the trace spells it: a mapped IPv4 as dotted, and the wildcards (`*`, `0.0.0.0`, `::`) as ''. */
function cleanHost(host: string): string {
  if (host === '*' || host === '0.0.0.0' || host === '::' || host === '') return ''
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host)
  return m ? m[1]! : host
}

/** Splits `host:port`, with `[v6]:port` and lsof's `*:port`. */
export function splitAddress(text: string): { host: string; port: number } {
  const m = /^\[?([^\]]*?)\]?:(\d+|\*)$/.exec(text.trim())
  if (!m) return { host: cleanHost(text.trim()), port: 0 }
  return { host: cleanHost(m[1]!), port: m[2] === '*' ? 0 : Number(m[2]) }
}

/** macOS and Linux both: internet sockets of `pids`, one record per line in lsof's -F format. */
export const lsofNetArgv = (pids: readonly number[]) => ['lsof', '-nP', '-i', '-a', '-p', pids.join(','), '-FpPnT']

/** Parses `lsof -FpPnT`: `p<pid>`, then per file `P<proto>`, `n<local>-><remote>`, `TST=<state>`. */
export function socketsInLsof(text: string): Socket[] {
  const out: Socket[] = []
  let pid = 0
  let proto: 'tcp' | 'udp' = 'tcp'
  let current: Socket | null = null
  for (const line of text.split('\n')) {
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') pid = Number(value)
    else if (tag === 'P') proto = value.toUpperCase() === 'UDP' ? 'udp' : 'tcp'
    else if (tag === 'n') {
      const [localText = '', remoteText = ''] = value.split('->')
      const local = splitAddress(localText)
      const remote = splitAddress(remoteText)
      current = { pid, proto, local: local.host, localPort: local.port, remote: remote.host, remotePort: remote.port, state: '', bytesIn: -1, bytesOut: -1 }
      out.push(current)
    } else if (tag === 'T' && current && value.startsWith('ST=')) current.state = value.slice(3)
  }
  return out
}

/** Linux: every TCP and UDP socket with its owner and TCP byte counters, two lines each. */
export const SS_ARGV = ['ss', '-tunpiH'] as const

/** Parses `ss -tunpiH` for the sockets `pids` hold. */
export function socketsInSs(text: string, pids: ReadonlySet<number>): Socket[] {
  const out: Socket[] = []
  let current: Socket | null = null
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    if (/^\s/.test(raw) && current) {
      const sent = /bytes_acked:(\d+)/.exec(raw) ?? /bytes_sent:(\d+)/.exec(raw)
      const received = /bytes_received:(\d+)/.exec(raw)
      if (sent) current.bytesOut = Number(sent[1])
      if (received) current.bytesIn = Number(received[1])
      continue
    }
    current = null
    const cols = raw.trim().split(/\s+/)
    if (cols.length < 6) continue
    const proto = cols[0] === 'udp' ? 'udp' : 'tcp'
    const pidMatch = /pid=(\d+)/.exec(raw)
    if (!pidMatch) continue
    const pid = Number(pidMatch[1])
    if (!pids.has(pid)) continue
    const local = splitAddress(cols[4]!)
    const remote = splitAddress(cols[5]!)
    const state = cols[1] === 'ESTAB' ? 'ESTABLISHED' : cols[1] === 'UNCONN' ? '' : cols[1]!.replace('-', '_')
    current = { pid, proto, local: local.host, localPort: local.port, remote: remote.host, remotePort: remote.port, state, bytesIn: -1, bytesOut: -1 }
    out.push(current)
  }
  return out
}

/**
 * Linux without `ss`: the socket inodes each process holds, then the kernel's tables. One `sh`
 * so a single run reads it all; the script takes the pids as its arguments.
 */
export const procWalkArgv = (pids: readonly number[]) => [
  'sh',
  '-c',
  'for p in "$@"; do echo "P $p"; ls -l /proc/$p/fd 2>/dev/null | grep -o "socket:\\[[0-9]*\\]"; done; echo TABLE; cat /proc/net/tcp /proc/net/tcp6 /proc/net/udp /proc/net/udp6 2>/dev/null',
  'orbit',
  ...pids.map(String),
]

const TCP_STATES: Record<string, string> = {
  '01': 'ESTABLISHED', '02': 'SYN_SENT', '03': 'SYN_RECV', '04': 'FIN_WAIT1', '05': 'FIN_WAIT2', '06': 'TIME_WAIT',
  '07': 'CLOSE', '08': 'CLOSE_WAIT', '09': 'LAST_ACK', '0A': 'LISTEN', '0B': 'CLOSING',
}

function hexAddress(text: string): { host: string; port: number } {
  const [hexIp = '', hexPort = '0'] = text.split(':')
  const port = parseInt(hexPort, 16)
  if (hexIp.length === 8) {
    const n = parseInt(hexIp, 16)
    return { host: `${n & 0xff}.${(n >> 8) & 0xff}.${(n >> 16) & 0xff}.${(n >>> 24) & 0xff}`, port }
  }
  // Four little-endian 32-bit words
  const words: string[] = []
  for (let i = 0; i < 4; i++) {
    const w = hexIp.slice(i * 8, i * 8 + 8)
    const bytes = [w.slice(6, 8), w.slice(4, 6), w.slice(2, 4), w.slice(0, 2)]
    words.push(bytes[0]! + bytes[1]!, bytes[2]! + bytes[3]!)
  }
  const v6 = words.map(w => parseInt(w, 16).toString(16)).join(':')
  const mapped = /^0:0:0:0:0:ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(v6)
  if (mapped) {
    const hi = parseInt(mapped[1]!, 16)
    const lo = parseInt(mapped[2]!, 16)
    return { host: `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`, port }
  }
  return { host: v6, port }
}

export function socketsInProc(text: string): Socket[] {
  const [owners = '', table = ''] = text.split('\nTABLE\n')
  const inodeOwner = new Map<number, number>()
  let pid = 0
  for (const line of owners.split('\n')) {
    if (line.startsWith('P ')) pid = Number(line.slice(2))
    else {
      const m = /socket:\[(\d+)\]/.exec(line)
      if (m && pid) inodeOwner.set(Number(m[1]), pid)
    }
  }
  const out: Socket[] = []
  let proto: 'tcp' | 'udp' = 'tcp'
  for (const line of table.split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols[0] === 'sl') {
      // Each table starts with its header; udp tables follow the tcp ones and have no state column meaning
      continue
    }
    if (cols.length < 10) continue
    const inode = Number(cols[9])
    const owner = inodeOwner.get(inode)
    if (!owner) continue
    const local = hexAddress(cols[1]!)
    const remote = hexAddress(cols[2]!)
    const state = TCP_STATES[cols[3]!] ?? ''
    proto = state === '' || cols[3] === '07' ? 'udp' : 'tcp'
    out.push({ pid: owner, proto, local: local.host, localPort: local.port, remote: remote.host, remotePort: remote.port, state: proto === 'udp' ? '' : state, bytesIn: -1, bytesOut: -1 })
  }
  return out
}

/** macOS: bytes per connection from nettop, one sample, CSV, raw numbers. */
export const nettopArgv = (pids: readonly number[]) => ['nettop', '-x', '-L', '1', '-J', 'bytes_in,bytes_out', ...pids.flatMap(p => ['-p', String(p)])]

export type Counter = { local: string; localPort: number; remote: string; remotePort: number; bytesIn: number; bytesOut: number }

/**
 * Parses nettop's CSV: a header naming the columns, process rows (`claude.123`), and beneath each
 * its connection rows (`tcp4 10.0.0.2:51234<->1.2.3.4:443`).
 */
export function countersInNettop(text: string): Counter[] {
  const lines = text.split('\n').filter(l => l.trim() !== '')
  const header = lines.find(l => l.includes('bytes_in'))
  if (!header) return []
  const cols = header.split(',')
  const inAt = cols.indexOf('bytes_in')
  const outAt = cols.indexOf('bytes_out')
  const out: Counter[] = []
  for (const line of lines) {
    const cells = line.split(',')
    const name = cells.find(c => c.includes('<->'))
    if (!name) continue
    const m = /(\S+)<->(\S+)/.exec(name)
    if (!m) continue
    const local = splitAddress(m[1]!)
    const remote = splitAddress(m[2]!)
    out.push({ local: local.host, localPort: local.port, remote: remote.host, remotePort: remote.port, bytesIn: Number(cells[inAt]) || 0, bytesOut: Number(cells[outAt]) || 0 })
  }
  return out
}

/** Whether a socket reaches beyond this machine: connected, to an address that is not its own. */
export const isRemote = (s: Socket): boolean => s.remote !== '' && s.remotePort !== 0 && s.state !== 'LISTEN'
