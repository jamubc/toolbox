// Pure helpers for paths, file classes and the flattened tree: nothing here
// touches `$`, so the tests import them directly.

import type { Entry, GitMark } from '../types'

/**
 * A name from disk as drawable text: a file name may legally hold a newline
 * or an escape, and one control character in a label refuses the whole pane.
 */
export const printable = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, '?')

/** File content for the Code element, which takes tab and newline and no other control. */
export const printableSource = (text: string) =>
  text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '�')

export const dirname = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/'
export const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1) || path
export const join = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`)

/** `path` from `base` when it lies inside it, else `path` as given. */
export function relative(path: string, base: string): string {
  if (path === base) return '.'
  return path.startsWith(base === '/' ? '/' : `${base}/`) ? path.slice(base === '/' ? 1 : base.length + 1) : path
}

/** What a typed name may be: one path segment, nothing that climbs out. */
export function nameProblem(name: string): string | null {
  if (name.trim() === '') return 'A name cannot be empty.'
  if (name.includes('/') || name.includes('\0')) return 'A name cannot contain / .'
  if (name === '.' || name === '..') return `"${name}" is not a name.`
  if (name.length > 255) return 'That name is too long.'
  return null
}

/** "a.txt" → "a copy.txt", then "a copy 2.txt" and on. */
export function copyName(name: string, attempt: number): string {
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  return `${stem} copy${attempt > 1 ? ` ${attempt}` : ''}${ext}`
}

export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export function date(ms: number): string {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

/** A file's class, as Dex names an instance's: a glyph, a color and a name. */
export type FileClass = { glyph: string; color: string; name: string }

const LANGUAGES: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
  mjs: 'JavaScript', cjs: 'JavaScript', py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin',
  swift: 'Swift', c: 'C', h: 'C', cpp: 'C++', hpp: 'C++', cc: 'C++', cs: 'C#', php: 'PHP', lua: 'Lua', luau: 'Luau',
  sh: 'Shell', bash: 'Shell', zsh: 'Shell', fish: 'Shell', sql: 'SQL', html: 'HTML', css: 'CSS', scss: 'SCSS',
  vue: 'Vue', svelte: 'Svelte', dart: 'Dart', zig: 'Zig', ex: 'Elixir', hs: 'Haskell',
}
const DOCUMENTS: Record<string, string> = { md: 'Markdown', mdx: 'MDX', txt: 'Text', rst: 'reStructuredText', adoc: 'AsciiDoc' }
const DATA: Record<string, string> = {
  json: 'JSON', jsonc: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', ini: 'INI', xml: 'XML', csv: 'CSV',
  lock: 'Lockfile', env: 'Environment', plist: 'Property list',
}
const MEDIA = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'mp3', 'wav', 'mp4', 'mov', 'webm'])
const BINARY = new Set(['zip', 'tar', 'gz', 'tgz', 'dmg', 'exe', 'bin', 'o', 'so', 'dylib', 'wasm', 'pdf', 'db', 'sqlite'])

export function classOf(name: string, kind: Entry['kind'], isLink: boolean): FileClass {
  if (kind === 'dir') return { glyph: '▸', color: 'yellow', name: isLink ? 'Folder (link)' : 'Folder' }
  if (isLink) return { glyph: '↪', color: 'blue', name: 'Link' }
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : name.startsWith('.env') ? 'env' : ''
  if (ext in LANGUAGES) return { glyph: '◆', color: 'cyan', name: `Script · ${LANGUAGES[ext]}` }
  if (ext in DOCUMENTS) return { glyph: '≡', color: 'white', name: `Document · ${DOCUMENTS[ext]}` }
  if (ext in DATA) return { glyph: '▪', color: 'green', name: `Data · ${DATA[ext]}` }
  if (MEDIA.has(ext)) return { glyph: '▣', color: 'magenta', name: `Media · ${ext.toUpperCase()}` }
  if (BINARY.has(ext)) return { glyph: '■', color: 'red', name: `Binary · ${ext.toUpperCase()}` }
  return { glyph: '·', color: 'gray', name: kind === 'other' ? 'Special file' : 'File' }
}

/** Folders first, then names, ignoring case. */
export function sorted(entries: readonly Entry[]): Entry[] {
  return [...entries].sort((a, b) =>
    a.kind === 'dir' && b.kind !== 'dir' ? -1
      : b.kind === 'dir' && a.kind !== 'dir' ? 1
        : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

export type Row =
  | { type: 'entry'; path: string; depth: number; entry: Entry; isOpen: boolean }
  | { type: 'more'; path: string; depth: number; hidden: number }
  | { type: 'cut'; path: string; depth: 0 }

/** How much of the tree one drawing holds: a pane refuses past 100,000 characters of text. */
export type TreeLimits = { perFolder: number; rows: number; characters: number }

/**
 * The tree as drawn: the root's children, and each open folder's beneath it,
 * up to `limits`; past them a `cut` row stands for the rest.
 */
export function rows(
  root: string,
  listings: Readonly<Record<string, readonly Entry[]>>,
  expanded: readonly string[],
  limits: TreeLimits,
): Row[] {
  const open = new Set(expanded)
  const out: Row[] = []
  let characters = 0
  const walk = (dir: string, depth: number): boolean => {
    const entries = listings[dir]
    if (entries === undefined) return true
    for (const entry of entries.slice(0, limits.perFolder)) {
      const path = join(dir, entry.name)
      // The row's label and indent, and its key: the path below the root.
      characters += entry.name.length + depth * 2 + (path.length - root.length) + 8
      if (out.length >= limits.rows || characters > limits.characters) return false
      const isOpen = entry.kind === 'dir' && open.has(path)
      out.push({ type: 'entry', path, depth, entry, isOpen })
      if (isOpen && !walk(path, depth + 1)) return false
    }
    if (entries.length > limits.perFolder) out.push({ type: 'more', path: dir, depth, hidden: entries.length - limits.perFolder })
    return true
  }
  if (!walk(root, 0)) out.push({ type: 'cut', path: root, depth: 0 })
  return out
}

/** The folders between `root` (exclusive) and `path` (exclusive), outermost first. */
export function foldersBetween(root: string, path: string): string[] {
  const out: string[] = []
  for (let dir = dirname(path); dir !== root && dir.startsWith(root) && dir !== '/'; dir = dirname(dir)) out.unshift(dir)
  return out
}

/** `-iname` reads `* ? [ ]` as a pattern; the typed words are literal. */
export const literalPattern = (text: string) => `*${text.replace(/[\\*?[\]]/g, '\\$&')}*`

/** Whether an entry is hidden by convention: its name starts with a dot. */
export const isHidden = (name: string) => name.startsWith('.')

/** The folders from `home` or `/` down to `path`, each with its label and full path. */
export function crumbs(path: string, home: string): { label: string; path: string }[] {
  const out: { label: string; path: string }[] = []
  const inHome = home !== '' && (path === home || path.startsWith(`${home}/`))
  const base = inHome ? home : '/'
  out.push({ label: inHome ? '~' : '/', path: base })
  const rest = inHome ? path.slice(home.length) : path
  let at = base
  for (const part of rest.split('/').filter(Boolean)) {
    at = join(at, part)
    out.push({ label: part, path: at })
  }
  return out
}

/**
 * `git status --porcelain -z` as marks by absolute path. An untracked folder
 * is listed once with a trailing slash; everything beneath it is untracked.
 * A rename lists the new name first, then the old, NUL-separated.
 */
export function parseGitStatus(porcelain: string, top: string): Record<string, GitMark> {
  const marks: Record<string, GitMark> = {}
  const fields = porcelain.split('\0')
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i] ?? ''
    if (field.length < 4) continue
    const x = field[0] ?? ' '
    const y = field[1] ?? ' '
    const rel = field.slice(3)
    const path = join(top, rel.replace(/\/$/, ''))
    if (x === 'R' || x === 'C') {
      marks[path] = 'R'
      i += 1 // the old name follows
    } else if (x === '?' && y === '?') marks[path] = '?'
    else if (x === 'D' || y === 'D') marks[path] = 'D'
    else if (x === 'A') marks[path] = 'A'
    else if (x === 'M' || y === 'M' || x === 'T' || y === 'T') marks[path] = 'M'
  }
  return marks
}

/** The mark a folder shows: the strongest of what lies beneath it, or none. */
export function folderMark(dir: string, marks: Readonly<Record<string, GitMark>>): GitMark | null {
  let found: GitMark | null = null
  const prefix = dir === '/' ? '/' : `${dir}/`
  for (const [path, mark] of Object.entries(marks)) {
    if (path === dir || path.startsWith(prefix)) {
      if (mark === 'M' || mark === 'D') return 'M'
      found = found ?? mark
    }
  }
  return found
}

/**
 * The marks as the tree draws them, rolled up to the folders holding them.
 *
 * `folderMark` answers one folder by walking every mark, and the tree asks it
 * once per folder row, so a repository with thousands of changed files costs
 * rows × marks on every redraw. This builds the same answers once: each mark
 * is offered to the folders above it, deepest first, so a drawing costs
 * marks × depth to build and one lookup per row after that.
 *
 * A mark keeps the same standing `folderMark` gives it: a change or a deletion
 * anywhere beneath reads as a change, and otherwise the first mark found wins.
 */
export type MarkIndex = { byPath: Readonly<Record<string, GitMark>>; byFolder: ReadonlyMap<string, GitMark> }

export function indexMarks(marks: Readonly<Record<string, GitMark>>, root: string): MarkIndex {
  const byFolder = new Map<string, GitMark>()
  const under = root === '/' ? '/' : `${root}/`
  for (const [path, mark] of Object.entries(marks)) {
    if (path !== root && !path.startsWith(under)) continue
    // The folders this mark shows on: every folder from the root down to the
    // mark's own path, which is a folder itself when git reported a directory.
    const chain = [path]
    for (let dir = dirname(path); ; dir = dirname(dir)) {
      chain.push(dir)
      if (dir === root || dir === '/') break
    }
    for (const dir of chain.reverse()) {
      const was = byFolder.get(dir)
      // A change or a deletion anywhere beneath reads as a change, whatever
      // was found first; anything else keeps the first mark that got here.
      if (mark === 'M' || mark === 'D') {
        if (was !== 'M') byFolder.set(dir, 'M')
      } else if (was === undefined) byFolder.set(dir, mark)
    }
  }
  return { byPath: marks, byFolder }
}

/** The mark a folder row draws, from an index built once for the drawing. */
export function markFor(index: MarkIndex, dir: string): GitMark | null {
  return index.byFolder.get(dir) ?? null
}

/**
 * Whether a folder now holds what the drawing already has. The watcher asks
 * this every few seconds for every open folder, and building two JSON strings
 * to compare them costs far more than reading the fields.
 */
export function sameEntries(known: readonly Entry[], fresh: readonly Entry[]): boolean {
  if (known === fresh) return true
  if (known.length !== fresh.length) return false
  for (let i = 0; i < known.length; i += 1) {
    const was = known[i]!
    const now = fresh[i]!
    if (was.name !== now.name || was.kind !== now.kind || was.size !== now.size
      || was.mtimeMs !== now.mtimeMs || was.isLink !== now.isLink) return false
  }
  return true
}

/** Whether git now says what the tree already draws, without stringifying either. */
export function sameMarks(known: Readonly<Record<string, GitMark>>, fresh: Readonly<Record<string, GitMark>>): boolean {
  if (known === fresh) return true
  const paths = Object.keys(known)
  if (paths.length !== Object.keys(fresh).length) return false
  for (const path of paths) if (known[path] !== fresh[path]) return false
  return true
}

/** `path:line:text` lines as grep and ripgrep print them, absolute paths only. */
export function parseGrep(output: string, limit: number): { path: string; line: number; text: string }[] {
  const hits: { path: string; line: number; text: string }[] = []
  for (const row of output.split('\n')) {
    const match = /^(\/[^\0]*?):(\d+):(.*)$/.exec(row)
    if (!match) continue
    hits.push({ path: match[1] ?? '', line: Number(match[2]), text: printable((match[3] ?? '').trim()).slice(0, 160) })
    if (hits.length >= limit) break
  }
  return hits
}

/** Whether a file is a picture a kitty-graphics terminal can read as it is: a PNG. */
export const isPng = (name: string) => /\.png$/i.test(name)

/** Whether a file reads as Markdown, drawn rendered rather than as source. */
export const isMarkdown = (name: string) => /\.(md|mdx|markdown)$/i.test(name)
