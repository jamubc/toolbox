/** One directory entry, as `$.fs.list` answers it. */
export type Entry = {
  name: string
  kind: 'file' | 'dir' | 'other'
  size: number
  mtimeMs: number
  isLink: boolean
}

/** What the source viewer shows for the selected file. */
export type Preview =
  | { kind: 'text'; text: string; isCut: boolean }
  | { kind: 'binary' }
  | { kind: 'large' }
  | { kind: 'unreadable'; reason: string }

/** The Properties panel: the selected entry, read when it was selected. */
export type Details = {
  path: string
  kind: 'file' | 'dir' | 'other'
  size: number
  mtimeMs: number
  isLink: boolean
  realPath: string | null
  items: number | null
  preview: Preview | null
}

/** A name being typed: a rename of `target`, or a new file or folder in it. */
export type Naming = { action: 'rename' | 'file' | 'folder'; target: string }

/** The file open in the editor, and how far its start got. */
export type Editing = { path: string; status: 'starting' | 'running' | 'error'; message: string | null }

declare module 'claude-code' {
  interface PluginState {
    atlas: {
      root: string
      expanded: string[]
      listings: Record<string, Entry[]>
      selected: string | null
      details: Details | null
      query: string
      /** Search hits under the root, or null while the tree shows. */
      results: string[] | null
      naming: Naming | null
      notice: string | null
      editing: Editing | null
    }
  }
}
