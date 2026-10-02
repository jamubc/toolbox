// orbit's state contract: what the pane draws from, held by the host across hot reloads.

export type OrbitPlace = {
  lat: number
  lon: number
  country: string
  city: string
  org: string
  isAnycast: boolean
  anycast: string
}

export type OrbitEvent = {
  id: string
  t: number
  last: number
  sessionPid: number
  session: string
  layer: 'tool' | 'socket' | 'proxy' | 'stream'
  tool: string
  summary: string
  host: string
  ip: string
  port: number
  direction: 'out' | 'in'
  bytesIn: number
  bytesOut: number
  place: OrbitPlace | null
  status: 'open' | 'closed' | 'done' | 'blocked' | 'asked' | 'failed'
  pid: number
  cmd: string
  linked: string
  note: string
}

export type OrbitRule = {
  kind: 'host' | 'mcp' | 'tool'
  pattern: string
  action: 'allow' | 'deny'
  at: number
}

export type OrbitSession = { pid: number; tty: string; cwd: string; isWorking: boolean }

export type OrbitHome = { lat: number; lon: number; label: string; source: 'config' | 'lookup' | 'none' }

/** Which layers work here, from the capability check at start. */
export type OrbitCapabilities = {
  platform: string
  tools: boolean
  /** `lsof`, `ss`, `proc` or '' when no socket source works. */
  sockets: string
  /** nettop (macOS) or ss (Linux) counts bytes per socket. */
  bytes: string
  node: boolean
  geo: 'ready' | 'missing' | 'no-node' | 'downloading' | 'error'
  geoNote: string
  proxy: 'off' | 'starting' | 'on' | 'error'
  proxyPort: number
  self: number
}

export type OrbitReplay = {
  file: string
  count: number
  start: number
  end: number
  position: number
  speed: number
  isPlaying: boolean
}

export type OrbitAsk = {
  id: string
  tool: string
  kind: 'host' | 'mcp'
  subject: string
  summary: string
}

declare module 'claude-code' {
  interface PluginState {
    orbit: {
      events: OrbitEvent[]
      rules: OrbitRule[]
      mode: 'off' | 'denylist' | 'allowlist' | 'ask'
      scope: 'session' | 'all'
      sessions: OrbitSession[]
      home: OrbitHome
      selectedId: string
      capabilities: OrbitCapabilities
      replay: OrbitReplay | null
      /** The view's center longitude offset from home, degrees; null follows home. */
      spin: number | null
      isPaneOpen: boolean
      ask: OrbitAsk | null
      /** `image` or `cells`: how the globe is drawn in this terminal. */
      renderer: 'image' | 'cells'
      /** True once this session's values are written; false after a /clear empties them. */
      seeded: boolean
    }
  }
}
