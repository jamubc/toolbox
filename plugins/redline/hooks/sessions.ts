// The Claude sessions running in your terminals, and which of them are mid-turn.

export type Session = { pid: number; tty: string; isWorking: boolean; cwd: string }

/** Working directories of `pids`, in lsof's field format: `p<pid>`, then `n<path>`. */
export const lsofArgv = (pids: readonly number[]) => ['lsof', '-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')]

type Proc = { pid: number; ppid: number; tty: string; cmd: string; arg1: string }

const base = (path: string) => path.slice(path.lastIndexOf('/') + 1)

function procsIn(ps: string): Proc[] {
  return ps
    .split('\n')
    .map(line => {
      const [pid = '', ppid = '', tty = '', argv0 = '', arg1 = ''] = line.trim().split(/\s+/)
      return { pid: Number(pid), ppid: Number(ppid), tty, cmd: base(argv0), arg1 }
    })
    .filter(p => p.pid > 0 && p.cmd !== '')
}

/** `claude` with a terminal, and not one of the daemon's helpers. */
const isSession = (p: Proc) =>
  p.cmd === 'claude' && p.tty !== '??' && p.tty !== '?' && p.arg1 !== 'daemon' && !p.arg1.startsWith('bg-')

/**
 * The sessions in `ps` output, ordered by terminal. A session is working while it has a
 * `caffeinate` child, which Claude Code holds on macOS through a turn.
 */
export function sessionsIn(ps: string): Session[] {
  const procs = procsIn(ps)
  const caffeinated = new Set(procs.filter(p => p.cmd === 'caffeinate').map(p => p.ppid))
  return procs
    .filter(isSession)
    .map(p => ({ pid: p.pid, tty: p.tty, isWorking: caffeinated.has(p.pid), cwd: '' }))
    .sort((a, b) => a.tty.localeCompare(b.tty) || a.pid - b.pid)
}

/** The session `pid` runs under: itself or its nearest session ancestor; 0 for none. */
/**
 * This session, from the table `SELF_ARGV` printed: the session its own row runs under. Every
 * redline polls with the same `ps` at the same moment, so the lookup asks with a format of its own,
 * and only another session looking itself up in the same instant makes it ambiguous: then 0, and
 * the next poll asks again.
 */
export const SELF_ARGV = ['ps', '-x', '-o', 'pid=,ppid=,tty=,command='] as const

export function selfIn(ps: string): number {
  const signature = SELF_ARGV.join(' ')
  const ours = ps.split('\n').filter(line => line.trimEnd().endsWith(signature)).map(line => Number(line.trim().split(/\s+/)[0]))
  const found = new Set(ours.map(pid => sessionOf(ps, pid)).filter(pid => pid > 0))
  return found.size === 1 ? [...found][0]! : 0
}

export function sessionOf(ps: string, pid: number): number {
  const procs = new Map(procsIn(ps).map(p => [p.pid, p]))
  for (let p = procs.get(pid), hops = 0; p && hops < 64; p = procs.get(p.ppid), hops++) {
    if (isSession(p)) return p.pid
  }
  return 0
}

export function cwdsIn(lsof: string): Map<number, string> {
  const cwds = new Map<number, string>()
  let pid = 0
  for (const line of lsof.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid) cwds.set(pid, line.slice(1))
  }
  return cwds
}
