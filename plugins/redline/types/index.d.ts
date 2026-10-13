/** One rate-limit window's last reading: how much is used, and when it refills. */
export type RedlineTank = { percent: number; resetsAt: number | null }

/** The figures behind the dials; each null until the engine has a reading. */
export type RedlineUsage = {
  fiveHour: RedlineTank | null
  sevenDay: RedlineTank | null
  /** This session's context fill, percent used; null until a response reports one. */
  context: number | null
}

/** What one session running redline writes to the shared store, so the others can list it. */
export type RedlineBeat = {
  /** The session's id, as `claude agents --json` lists it. */
  id: string
  cwd: string
  state: 'working' | 'waiting' | 'idle'
  /** What it waits for while `waiting`: `approve Bash`, `a question`. */
  waitingFor: string
  /** When it entered this state. */
  since: number
  /** When this beat was written; one older than a few minutes is a session that has gone. */
  at: number
  /** Turns completed this session: an idle session with none has not started yet. */
  turns: number
  context: number | null
  usd: number | null
  model: string
  isShifted: boolean
}
