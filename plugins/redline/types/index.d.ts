export type RedlineSession = { pid: number; tty: string; isWorking: boolean; cwd: string }

declare module 'claude-code' {
  interface PluginState {
    redline: {
      sessions: RedlineSession[]
      /** A count shown instead of the live one (`/redline 12`); null follows the sessions. */
      preview: number | null
      isPaneOpen: boolean
      /** True once this session's values are written; false after a /clear empties them. */
      seeded: boolean
    }
  }
}
