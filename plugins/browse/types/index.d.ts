/** Whether the browser helper is running: not yet, coming up, up, or failed. */
export type Status = 'idle' | 'starting' | 'ready' | 'error'

/** How frames are drawn: real pixels (kitty graphics) or half-block cells. */
export type Renderer = 'image' | 'cells'

export type Page = { url: string; title: string }

declare module 'claude-code' {
  interface PluginState {
    browse: {
      status: Status
      /** Why the browser failed (status `error`), or a passing notice. */
      message: string | null
      page: Page
      renderer: Renderer
    }
  }
}
