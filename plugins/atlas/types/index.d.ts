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
  | { kind: 'text'; text: string; isCut: boolean; startLine: number }
  | { kind: 'markdown'; text: string; isCut: boolean }
  | { kind: 'image'; path: string }
  | { kind: 'binary' }
  | { kind: 'large' }
  | { kind: 'unreadable'; reason: string }

/** How a file stands against git: changed, added, untracked, deleted, renamed. */
export type GitMark = 'M' | 'A' | '?' | 'D' | 'R'

/** One search hit: a file by name, or a line in a file by its text. */
export type Hit = { path: string; line?: number; text?: string }

/** Which search runs: file names, or text inside files. */
export type SearchMode = 'names' | 'text'

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
      mode: SearchMode
      /** Search hits under the root, or null while the tree shows. */
      results: Hit[] | null
      naming: Naming | null
      notice: string | null
      editing: Editing | null
      /** Whether files whose name starts with a dot are drawn. */
      showHidden: boolean
      /** What git says about files under the root, by absolute path. */
      git: Record<string, GitMark>
      /** Whether this terminal draws real pixels, for picture previews. */
      hasPixels: boolean
      /** True once this session's values are written; false after a /clear empties them. */
      seeded: boolean
    }
  }
}
