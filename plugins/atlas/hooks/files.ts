// Pure helpers for paths, file classes and the flattened tree: nothing here
// touches `$`, so the tests import them directly.

import type { Entry } from '../types'

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
