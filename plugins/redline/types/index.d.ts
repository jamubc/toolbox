export type RedlineSession = { pid: number; tty: string; isWorking: boolean; cwd: string }

/** One rate-limit window's last reading: how much is used, and when it refills. */
export type RedlineTank = { percent: number; resetsAt: number | null }

/** The figures behind the fuel dials; each null until the engine has a reading. */
export type RedlineUsage = {
  fiveHour: RedlineTank | null
  sevenDay: RedlineTank | null
  /** This session's context fill, percent used; null until a response reports one. */
  context: number | null
}

declare module 'claude-code' {
  interface PluginState {
    redline: {
      sessions: RedlineSession[]
      /** A count shown instead of the live one (`/redline 12`); null follows the sessions. */
      preview: number | null
      isPaneOpen: boolean
      /** True once this session's values are written; false after a /clear empties them. */
      seeded: boolean
      /** The plan windows and the context, for the fuel dials. */
      usage: RedlineUsage
    }
  }
}
