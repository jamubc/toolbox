/** One search hit or recent note, as the list draws it. */
export type Hit = { id: string; title: string; excerpt: string; spaces: string[]; updatedAt?: string }

export type OpenNote = {
  id: string
  title: string
  body: string
  tags: string[]
  spaces: string[]
  updatedAt: string
}

/** How the plugin reaches InstantNotes: the MCP server Claude Code already runs, or its own one-shot process. */
export type Source = { kind: 'mcp'; server: string } | { kind: 'process'; argv: string[] } | null

/** What went wrong, and when it is a setup matter, what the person can do. */
export type Problem = { message: string; steps: string[] }

declare module 'claude-code' {
  interface PluginState {
    instantnotes: {
      /** The words the last library search ran with. */
      query: string
      /** What is in the search field now, which filters the list as it is typed. */
      typed: string
      hits: Hit[]
      note: OpenNote | null
      problem: Problem | null
      /** A call to InstantNotes is in flight. */
      isBusy: boolean
      /** The composer for a new note is open in the list view. */
      isComposing: boolean
      source: Source
    }
  }
}
