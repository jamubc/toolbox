export type Hit = { id: string; title: string; excerpt: string; spaces: string[] }

export type OpenNote = {
  id: string
  title: string
  body: string
  tags: string[]
  spaces: string[]
  updatedAt: string
}

declare module 'claude-code' {
  interface PluginState {
    instantnotes: {
      query: string
      hits: Hit[]
      note: OpenNote | null
      error: string | null
    }
  }
}
