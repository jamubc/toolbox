// Atlas, a Dex-style explorer for your files: an explorer pane (breadcrumbs,
// tree with git marks, properties, source viewer and actions), search by name
// or by text, and a real terminal editor, micro by default, run inside the pane.
// editor/term.py hosts the editor in a pseudo-terminal and streams its screen
// as Raster cells; a Client over the picture forwards keys and the pointer.

import { atom, derive, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Details, Editing, Entry, GitMark, Hit, Naming, Preview, SearchMode } from '../types'
import {
  basename, classOf, copyName, crumbs, date, dirname, foldersBetween, indexMarks, isHidden, isMarkdown, isPng, join,
  literalPattern, markFor, nameProblem, parseGitStatus, parseGrep, printable, printableSource, relative, rows, sameEntries, sameMarks,
  size, sorted,
} from './files'

const PANE = 'atlas'
// The tree's share of a pane's 100,000 characters, leaving room for the source.
const TREE_LIMITS = { perFolder: 300, rows: 800, characters: 50000 }
const PREVIEW_BYTES = 512 * 1024
const PREVIEW_LINES = 80
const PREVIEW_CHARS = 9000
// Lines of context before a search hit in the source viewer.
const HIT_CONTEXT = 8
const SEARCH_LIMIT = 200
const EDITOR_HEADER_ROWS = 1
const DEFAULT_COLOR = 0x01000000
// How often the tree is read again while the pane shows, so what Claude
// or a build writes appears by itself.
const WATCH_MS = 4000
const GIT_TIMEOUT_MS = 5000
const MARK_COLORS: Record<GitMark, string> = { M: 'yellow', A: 'green', '?': 'green', D: 'red', R: 'blue' }
const MARK_NAMES: Record<GitMark, string> = { M: 'modified', A: 'added', '?': 'untracked', D: 'deleted', R: 'renamed' }

const root = atom({ plugin: 'atlas', key: 'root' } as const, '')
const expanded = atom({ plugin: 'atlas', key: 'expanded' } as const, [])
const listings = atom({ plugin: 'atlas', key: 'listings' } as const, {})
const selected = atom({ plugin: 'atlas', key: 'selected' } as const, null)
const details = atom({ plugin: 'atlas', key: 'details' } as const, null)
const query = atom({ plugin: 'atlas', key: 'query' } as const, '')
const mode = atom({ plugin: 'atlas', key: 'mode' } as const, 'names')
const results = atom({ plugin: 'atlas', key: 'results' } as const, null)
const naming = atom({ plugin: 'atlas', key: 'naming' } as const, null)
const notice = atom({ plugin: 'atlas', key: 'notice' } as const, null)
const editing = atom({ plugin: 'atlas', key: 'editing' } as const, null)
const showHidden = atom({ plugin: 'atlas', key: 'showHidden' } as const, false)
const git = atom({ plugin: 'atlas', key: 'git' } as const, {})
const hasPixels = atom({ plugin: 'atlas', key: 'hasPixels' } as const, false)
const seeded = atom({ plugin: 'atlas', key: 'seeded' } as const, false)

// /clear ends the session but not the process: the host's `$.state` starts over empty while this
// module, its pane and the editor live on, so a value read straight from the host is suddenly its
// initial (an empty root, no listings, nothing being edited). `seeded` is false exactly then, and
// before the first `session.start`. `snapshot` is every value the pane draws from, read in one go:
// the host's while `seeded`, else what this process last saw; `write` puts the kept values back
// before the first change after a /clear, and a render that finds `seeded` false schedules that.
type Snapshot = {
  root: string
  expanded: string[]
  listings: Record<string, Entry[]>
  selected: string | null
  details: Details | null
  query: string
  mode: SearchMode
  results: Hit[] | null
  naming: Naming | null
  notice: string | null
  editing: Editing | null
  showHidden: boolean
  git: Record<string, GitMark>
  hasPixels: boolean
}
const KEYS = ['root', 'expanded', 'listings', 'selected', 'details', 'query', 'mode', 'results', 'naming', 'notice', 'editing', 'showHidden', 'git', 'hasPixels'] as const
let kept: Snapshot = {
  root: '', expanded: [], listings: {}, selected: null, details: null, query: '', mode: 'names', results: null, naming: null, notice: null, editing: null, showHidden: false, git: {}, hasPixels: false,
}
let wasLive: boolean | null = null // what the last read saw; null before the first
const snapshot = derive(
  [seeded, root, expanded, listings, selected, details, query, mode, results, naming, notice, editing, showHidden, git, hasPixels],
  (isLive, root, expanded, listings, selected, details, query, mode, results, naming, notice, editing, showHidden, git, hasPixels): Snapshot => {
    wasLive = isLive
    if (!isLive) return kept
    kept = { root, expanded, listings, selected, details, query, mode, results, naming, notice, editing, showHidden, git, hasPixels }
    return kept
  },
)

/** The one place the atoms are written: each key to its own, as the validator asks. */
async function put<K extends keyof Snapshot>($: EngineInterface, key: K, value: Snapshot[K]): Promise<void> {
  switch (key) {
    case 'root': await update($, root, () => value as Snapshot['root']); break
    case 'expanded': await update($, expanded, () => value as Snapshot['expanded']); break
    case 'listings': await update($, listings, () => value as Snapshot['listings']); break
    case 'selected': await update($, selected, () => value as Snapshot['selected']); break
    case 'details': await update($, details, () => value as Snapshot['details']); break
    case 'query': await update($, query, () => value as Snapshot['query']); break
    case 'mode': await update($, mode, () => value as Snapshot['mode']); break
    case 'results': await update($, results, () => value as Snapshot['results']); break
    case 'naming': await update($, naming, () => value as Snapshot['naming']); break
    case 'notice': await update($, notice, () => value as Snapshot['notice']); break
    case 'editing': await update($, editing, () => value as Snapshot['editing']); break
    case 'showHidden': await update($, showHidden, () => value as Snapshot['showHidden']); break
    case 'git': await update($, git, () => value as Snapshot['git']); break
    case 'hasPixels': await update($, hasPixels, () => value as Snapshot['hasPixels']); break
  }
}

/** After a /clear (or at the first start), writes what this process kept back to the host. */
let reseeding: Promise<void> | null = null
function reseed($: EngineInterface): Promise<void> {
  reseeding ??= (async () => {
    try {
      if (await read($, seeded)) return
      for (const key of KEYS) await put($, key, kept[key])
      await update($, seeded, () => true)
      wasLive = true
    } finally {
      reseeding = null
    }
  })()
  return reseeding
}

/** Changes one value from what `snapshot` reads, and keeps it here too. */
async function write<K extends keyof Snapshot>($: EngineInterface, key: K, change: (now: Snapshot[K]) => Snapshot[K]): Promise<void> {
  // `kept` is current once a read has seen the host live: only this module writes these values.
  if (wasLive === null) await read($, snapshot)
  if (!wasLive) await reseed($)
  const next = change(kept[key])
  kept = { ...kept, [key]: next }
  await put($, key, next)
}

type Options = { editor?: string; python?: string }
type Size = { columns: number; rows: number }
type Frame = Size & { cells: string }
type Helper = { socket: string | null; sent: Size | null; stop: () => void }
type TerminalMessage =
  | { kind: 'size' }
  | { kind: 'key'; key: string; ctrl?: true; shift?: true; meta?: true }
  | { kind: 'pointer'; type: string; x: number; y: number; button: string }
type Remembered = { root: string; expanded: string[] }

// What only this process has. The editor's host is a child of this module, so
// a hot reload ends it with the module, and these start over with it.
let cwd = ''
let home = ''
let helper: Helper | null = null
let frame: Frame | null = null
let editorView: Size | null = null // the editor's picture as last drawn
let paneBody: Size = { columns: 100, rows: 30 }
let isWatching = false
/** Counts searches so a slow earlier one cannot land its hits over a newer query. */
let searching = 0
/**
 * Where git said the repository's top folder is, and the root it was asked
 * about. `gitTop` is undefined until git has been asked, and null when it
 * answered that there is no repository; either way it is not asked again for
 * that root. Going to another root asks afresh.
 */
let gitTopFor: string | null = null
let gitTop: string | null | undefined = undefined
const blanks = new Map<string, string>()

const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err))
const say = ($: EngineInterface, text: string | null) => write($, 'notice', () => text)
// Every path or name drawn passes through one of these: see `printable`.
const tilde = (path: string) => printable(home && relative(path, home) !== path ? `~/${relative(path, home)}` : path)
const nameOf = (path: string) => printable(basename(path))
const relOf = (path: string, base: string) => printable(relative(path, base))

function blankCells({ columns, rows: height }: Size): string {
  const size = `${columns}x${height}`
  let cells = blanks.get(size)
  if (cells === undefined) {
    const words = new Uint32Array(columns * height * 3)
    for (let i = 0; i < words.length; i += 3) {
      words[i] = 0x20
      words[i + 1] = DEFAULT_COLOR
      words[i + 2] = DEFAULT_COLOR
    }
    cells = new Uint8Array(words.buffer).toBase64()
    blanks.set(size, cells)
  }
  return cells
}

// Real pixels where the terminal speaks the kitty graphics protocol. Not
// through tmux, which drops it, nor over ssh.
async function pixelsHere($: EngineInterface): Promise<boolean> {
  const isRelayed =
    (await $.env.get('TMUX')) !== undefined ||
    (await $.env.get('SSH_CONNECTION')) !== undefined ||
    (await $.env.get('SSH_TTY')) !== undefined
  if (isRelayed) return false
  const term = (await $.env.get('TERM')) ?? ''
  const program = ((await $.env.get('TERM_PROGRAM')) ?? '').toLowerCase()
  return (await $.env.get('KITTY_WINDOW_ID')) !== undefined || term.includes('kitty') || term.includes('ghostty') || program === 'ghostty'
}

// ---------------------------------------------------------------- the tree

/** Reads one folder; answers whether what it holds changed. */
async function load($: EngineInterface, dir: string, isQuiet = false): Promise<boolean> {
  if (dir === '') return false
  try {
    const listed = await $.fs.list(dir)
    const entries = sorted(listed.map(({ name, kind, size: bytes, mtimeMs, isLink }): Entry => (
      { name, kind, size: bytes, mtimeMs, isLink })))
    const known = (await read($, snapshot)).listings[dir]
    if (known !== undefined && sameEntries(known, entries)) return false
    await write($, 'listings', all => ({ ...all, [dir]: entries }))
    return true
  } catch (err) {
    if (!isQuiet) await say($, `Cannot read ${tilde(dir)}: ${reasonOf(err)}`)
    return false
  }
}

/**
 * What git says about the files under the root; nothing outside a repository.
 * A repository's top folder cannot move while the root stays the same, so the
 * watcher asks git where it is once per root rather than on every tick. `top`
 * is undefined until git has been asked, and null when git answered that there
 * is no repository or is not answering at all; neither is asked again for that
 * root, and going to another root asks afresh.
 */
async function loadGit($: EngineInterface, base: string): Promise<boolean> {
  let marks: Record<string, GitMark> = {}
  if (base !== gitTopFor) {
    gitTopFor = base
    gitTop = undefined
  }
  if (gitTop === undefined) {
    try {
      const ran = await $.process.run(['git', '-C', base, 'rev-parse', '--show-toplevel'], { timeoutMs: GIT_TIMEOUT_MS })
      gitTop = ran.exitCode === 0 ? ran.stdout.trim() : null
    } catch {
      gitTop = null // no git on this machine
    }
  }
  if (gitTop !== null) {
    try {
      const ran = await $.process.run(
        ['git', '-C', base, 'status', '--porcelain=v1', '-z', '--untracked-files=normal', '--', '.'],
        { timeoutMs: GIT_TIMEOUT_MS },
      )
      // A status that failed or was cut short says nothing, so the marks stay as they are.
      if (ran.exitCode === 0 && !ran.isStdoutTruncated) marks = parseGitStatus(ran.stdout, gitTop)
      else return false
    } catch {
      return false
    }
  }
  const known = (await read($, snapshot)).git
  if (sameMarks(known, marks)) return false
  await write($, 'git', () => marks)
  return true
}

async function previewOf($: EngineInterface, path: string, bytes: number, aroundLine?: number): Promise<Preview> {
  const name = basename(path)
  if (isPng(name)) {
    return (await read($, snapshot)).hasPixels ? { kind: 'image', path } : { kind: 'binary' }
  }
  if (bytes > PREVIEW_BYTES) return { kind: 'large' }
  try {
    const text = await $.fs.read(path)
    const head = text.slice(0, 8000)
    if (head.includes('\0') || (head.match(/�/g)?.length ?? 0) > head.length / 20) return { kind: 'binary' }
    const lines = text.split('\n')
    if (isMarkdown(name) && aroundLine === undefined) {
      const shown = text.slice(0, PREVIEW_CHARS)
      return { kind: 'markdown', text: printableSource(shown).replace(/\t/g, '    '), isCut: text.length > PREVIEW_CHARS }
    }
    const startLine = aroundLine === undefined ? 1 : Math.max(1, aroundLine - HIT_CONTEXT)
    const kept = lines.slice(startLine - 1, startLine - 1 + PREVIEW_LINES).join('\n')
    const shown = kept.slice(0, PREVIEW_CHARS)
    return {
      kind: 'text',
      text: printableSource(shown),
      isCut: lines.length > startLine - 1 + PREVIEW_LINES || kept.length > PREVIEW_CHARS,
      startLine,
    }
  } catch (err) {
    return { kind: 'unreadable', reason: reasonOf(err) }
  }
}

async function select($: EngineInterface, path: string | null, aroundLine?: number): Promise<void> {
  await write($, 'selected', () => path)
  if (path === null) {
    await write($, 'details', () => null)
    return
  }
  try {
    const stat = await $.fs.stat(path, { resolve: true })
    let items: number | null = null
    if (stat.kind === 'dir') {
      try {
        items = (await $.fs.list(path)).length
      } catch {}
    }
    const found: Details = {
      path,
      kind: stat.kind,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      isLink: stat.isLink,
      realPath: stat.isLink ? stat.realPath ?? null : null,
      items,
      preview: stat.kind === 'file' ? await previewOf($, path, stat.size, aroundLine) : null,
    }
    // A later selection may have landed while this one read.
    if ((await read($, snapshot)).selected === path) await write($, 'details', () => found)
  } catch (err) {
    await write($, 'details', () => null)
    await say($, `Cannot read ${tilde(path)}: ${reasonOf(err)}`)
  }
}

async function remember($: EngineInterface): Promise<void> {
  const { root: base, expanded: open } = await read($, snapshot)
  const kept: Remembered = { root: base, expanded: open }
  try {
    await $.store.set(`root:${cwd}`, kept)
  } catch {}
}

async function toggle($: EngineInterface, path: string): Promise<void> {
  if ((await read($, snapshot)).expanded.includes(path)) {
    await write($, 'expanded', list => list.filter(p => p !== path && !p.startsWith(`${path}/`)))
  } else {
    await load($, path)
    await write($, 'expanded', list => [...list, path])
  }
  await remember($)
}

async function setRoot($: EngineInterface, dir: string): Promise<void> {
  await write($, 'root', () => dir)
  await write($, 'results', () => null)
  await load($, dir)
  await loadGit($, dir)
  await remember($)
}

/** Opens every folder down to `path` and selects it. */
async function reveal($: EngineInterface, path: string, line?: number): Promise<void> {
  const base = (await read($, snapshot)).root
  for (const dir of foldersBetween(base, path)) {
    await load($, dir)
    await write($, 'expanded', list => (list.includes(dir) ? list : [...list, dir]))
  }
  await write($, 'results', () => null)
  await select($, path, line)
  await remember($)
}

async function refresh($: EngineInterface): Promise<void> {
  await say($, null)
  // Asked for by hand, so git is asked where the repository is again: the folder
  // may have become one since the watcher last looked.
  gitTopFor = null
  gitTop = undefined
  const base = (await read($, snapshot)).root
  await load($, base)
  for (const dir of (await read($, snapshot)).expanded) await load($, dir)
  await loadGit($, base)
  await select($, (await read($, snapshot)).selected)
}

/** A quiet pass while the pane shows: the folders on screen and git, redrawing only on a change. */
async function watch($: EngineInterface): Promise<void> {
  if (isWatching || helper !== null) return
  const base = (await read($, snapshot)).root
  if (base === '') return
  let isShown = false
  try {
    isShown = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
  } catch {}
  if (!isShown) return
  isWatching = true
  try {
    let changed = await load($, base, true)
    for (const dir of (await read($, snapshot)).expanded) changed = (await load($, dir, true)) || changed
    await loadGit($, base)
    const chosen = (await read($, snapshot)).selected
    if (changed && chosen !== null && (await read($, snapshot)).details?.path === chosen) await select($, chosen)
  } finally {
    isWatching = false
  }
}

async function search($: EngineInterface, text: string): Promise<void> {
  // Which search asked last: `find` and ripgrep can run for seconds, and a slow
  // earlier one must not land its hits over the query now in the box.
  const mine = ++searching
  await write($, 'query', () => text)
  const words = text.trim()
  if (words === '') {
    await write($, 'results', () => null)
    return
  }
  const base = (await read($, snapshot)).root
  const how = (await read($, snapshot)).mode
  try {
    let hits: Hit[]
    if (how === 'text') {
      hits = await grep($, base, words)
    } else {
      const ran = await $.process.run(
        ['find', base, '-mindepth', '1', '(', '-name', '.git', '-o', '-name', 'node_modules', ')', '-prune', '-o',
          '-iname', literalPattern(words), '-print'],
        { timeoutMs: 8000 },
      )
      hits = ran.stdout.split('\n').filter(Boolean).slice(0, SEARCH_LIMIT).map(path => ({ path }))
    }
    if (mine !== searching) return
    await write($, 'results', () => hits)
    await say($, hits.length === 0 ? `Nothing under ${tilde(base)} ${how === 'text' ? 'contains' : 'is named like'} "${words}".` : null)
  } catch (err) {
    if (mine !== searching) return
    await say($, `Search failed: ${reasonOf(err)}`)
  }
}

/** Lines holding the text, by ripgrep when it is there, else grep. */
async function grep($: EngineInterface, base: string, words: string): Promise<Hit[]> {
  const commands = [
    ['rg', '--no-heading', '--line-number', '--color', 'never', '--smart-case', '--max-count', '3', '--max-columns', '200',
      '--max-count', '3', '--glob', '!.git', '--glob', '!node_modules', '-e', words, base],
    ['grep', '-rIn', '--exclude-dir=.git', '--exclude-dir=node_modules', '-i', '-e', words, base],
  ]
  let lastError: unknown = null
  for (const argv of commands) {
    try {
      const ran = await $.process.run(argv, { timeoutMs: 15000 })
      // 1 means nothing matched; 2 and up is a failure (grep) or a missing program.
      if (ran.exitCode > 1) throw new Error(ran.stderr.trim() || `${argv[0]} exited ${ran.exitCode}`)
      return parseGrep(ran.stdout, SEARCH_LIMIT)
    } catch (err) {
      lastError = err
    }
  }
  throw new Error(`neither rg nor grep could search: ${reasonOf(lastError)}`)
}

// ---------------------------------------------------------------- actions

/** The folder a new entry goes in: the selected folder, else the selected file's. */
async function folderForNew($: EngineInterface): Promise<string> {
  const { selected: path, details: info, root: base } = await read($, snapshot)
  if (path === null) return base
  return info?.path === path && info.kind === 'dir' ? path : dirname(path)
}

async function startNaming($: EngineInterface, action: Naming['action']): Promise<void> {
  const path = (await read($, snapshot)).selected
  if (action === 'rename' && path === null) return
  const target = action === 'rename' ? (path as string) : await folderForNew($)
  await say($, null)
  await write($, 'naming', () => ({ action, target }))
  // A click leaves the keys with the prompt: asking for the pane's focus again
  // hands them to the pane, where the name field is drawn autoFocus.
  await openPane($)
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Atlas', focus: true, columns: 110 })

async function finishNaming($: EngineInterface, typed: string): Promise<void> {
  const named = (await read($, snapshot)).naming
  if (named === null) return
  const name = typed.trim()
  const problem = nameProblem(name)
  if (problem !== null) {
    await say($, problem)
    return
  }
  const dir = named.action === 'rename' ? dirname(named.target) : named.target
  const to = join(dir, name)
  if (named.action === 'rename' && to === named.target) {
    await write($, 'naming', () => null)
    return
  }
  if (await $.fs.exists(to)) {
    await say($, `${name} already exists in ${tilde(dir)}. Nothing was changed.`)
    return
  }
  try {
    if (named.action === 'file') {
      await $.fs.write(to, '')
    } else {
      const argv = named.action === 'folder' ? ['mkdir', '--', to] : ['mv', '-n', '--', named.target, to]
      const ran = await $.process.run(argv, { timeoutMs: 10000 })
      if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `${argv[0]} exited ${ran.exitCode}`)
    }
    if (!(await $.fs.exists(to))) throw new Error(`${name} is not there afterwards`)
  } catch (err) {
    await say($, `Could not ${named.action === 'rename' ? 'rename' : 'create'} ${name}: ${reasonOf(err)}`)
    return
  }
  if (named.action === 'rename') {
    const from = named.target
    await write($, 'expanded', list => list.map(p => (p === from || p.startsWith(`${from}/`) ? to + p.slice(from.length) : p)))
  }
  await write($, 'naming', () => null)
  const base = (await read($, snapshot)).root
  if (dir !== base) await write($, 'expanded', list => (list.includes(dir) ? list : [...list, dir]))
  await load($, dir)
  await loadGit($, base)
  await select($, to)
  await say($, named.action === 'rename' ? `Renamed to ${name}.` : `Created ${name}.`)
}

async function duplicate($: EngineInterface, path: string): Promise<void> {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const to = join(dirname(path), copyName(basename(path), attempt))
    if (await $.fs.exists(to)) continue
    const ran = await $.process.run(['cp', '-R', '--', path, to], { timeoutMs: 60000 })
    if (ran.exitCode !== 0 || !(await $.fs.exists(to))) {
      await say($, `Could not duplicate ${nameOf(path)}: ${ran.stderr.trim() || `cp exited ${ran.exitCode}`}`)
      return
    }
    await load($, dirname(path))
    await loadGit($, (await read($, snapshot)).root)
    await select($, to)
    await say($, `Duplicated as ${nameOf(to)}.`)
    return
  }
  await say($, `Too many copies of ${nameOf(path)} already.`)
}

/** Moves to the Trash, never deletes: macOS's trash, else gio or trash-cli on Linux. */
async function trash($: EngineInterface, path: string): Promise<void> {
  const name = nameOf(path)
  let answer: string
  try {
    answer = await $.ui.ask(`Move ${name} to the Trash?`, ['Move to Trash', 'Cancel'])
  } catch {
    return // dismissed
  }
  if (answer !== 'Move to Trash') return
  let ran = null
  for (const argv of [['trash', path], ['gio', 'trash', path], ['trash-put', path]]) {
    try {
      ran = await $.process.run(argv, { timeoutMs: 30000 })
      break
    } catch {}
  }
  if (ran === null) {
    await say($, 'No trash command here (macOS 15 or later has one; Linux needs gio or trash-cli). Nothing was deleted.')
    return
  }
  if (ran.exitCode !== 0 || (await $.fs.exists(path))) {
    await say($, `Could not move ${name} to the Trash: ${ran.stderr.trim() || `exit ${ran.exitCode}`}`)
    return
  }
  await write($, 'expanded', list => list.filter(p => p !== path && !p.startsWith(`${path}/`)))
  await load($, dirname(path))
  await loadGit($, (await read($, snapshot)).root)
  await select($, null)
  await say($, `Moved ${name} to the Trash.`)
}

async function mention($: EngineInterface, path: string): Promise<void> {
  const filled = await $.prompt.fill({ text: `@${relative(path, cwd)} `, mode: 'append' })
  $.ui.toast(filled.isFilled ? `Added @${relOf(path, cwd)} to your prompt.` : 'The prompt cannot take it right now.')
}

async function copyPath($: EngineInterface, path: string, surface: RenderSurface): Promise<void> {
  const copied = await $.ui.copy({ text: path, surface })
  $.ui.toast(copied.isCopied ? 'Copied the path.' : 'Could not copy the path here.')
}

/** Opens the file or folder with the system's own app: `open` on macOS, `xdg-open` on Linux. */
async function openWithApp($: EngineInterface, path: string): Promise<void> {
  for (const argv of [['open', path], ['xdg-open', path]]) {
    try {
      const ran = await $.process.run(argv, { timeoutMs: 10000 })
      if (ran.exitCode === 0) return
      await say($, `Could not open ${nameOf(path)}: ${ran.stderr.trim() || `${argv[0]} exited ${ran.exitCode}`}`)
      return
    } catch {}
  }
  await say($, 'No open command here (open on macOS, xdg-open on Linux).')
}

// ---------------------------------------------------------------- the editor

async function call($: EngineInterface, route: string, body: object): Promise<void> {
  const socket = helper?.socket
  if (!socket) return
  try {
    const res = await $.http.fetch(`http://atlas${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      socketPath: socket,
    })
    if (!res.ok) $.ui.log(`atlas: editor ${route} failed: ${res.text}`, { to: 'debug' })
  } catch (err) {
    $.ui.log(`atlas: editor ${route} failed: ${reasonOf(err)}`, { to: 'debug' })
  }
}

/** Tells the editor the size its picture is now drawn at. */
async function syncSize($: EngineInterface): Promise<void> {
  const self = helper
  const view = editorView
  if (!self?.socket || view === null) return
  if (self.sent?.columns === view.columns && self.sent.rows === view.rows) return
  self.sent = view
  await call($, '/resize', view)
}

async function show($: EngineInterface, next: Frame): Promise<void> {
  frame = next
  if (editorView === null || next.columns !== editorView.columns || next.rows !== editorView.rows) return
  const res = await $.ui.blit({ requestId: PANE, key: 'editor', cells: next.cells })
  if (res.deny !== undefined && !/mount/i.test(res.deny)) $.ui.log(`atlas: editor frame refused: ${res.deny}`, { to: 'debug' })
}

async function edit($: EngineInterface, options: Options, path: string): Promise<void> {
  const now = (await read($, snapshot)).editing
  if (helper !== null && now !== null) {
    $.ui.toast(`Already editing ${nameOf(now.path)}: quit it first (Ctrl+Q).`)
    return
  }
  if (!(await $.session.surfaces()).includes('terminal')) {
    await say($, 'Editing runs in Claude Code\'s terminal; this app shows the explorer only.')
    return
  }
  const python = options.python || 'python3'
  const program = options.editor || 'micro'
  const start = { columns: paneBody.columns, rows: Math.max(3, paneBody.rows - EDITOR_HEADER_ROWS) }
  const child = $.process.spawn({
    argv: [python, `${$.plugin.root}/editor/term.py`, String(start.columns), String(start.rows), program, path],
  })
  let isStopping = false
  const self: Helper = {
    socket: null,
    sent: start,
    stop: () => {
      isStopping = true
      void child.return(undefined as never)
    },
  }
  helper = self
  frame = null
  const starting: Editing = { path, status: 'starting', message: null }
  await write($, 'editing', () => starting)
  $.ui.toast('Click the text to type. Ctrl+Z would suspend Claude Code: use the Undo button instead.', { timeoutMs: 8000 })

  void (async () => {
    let failure: string | null = null
    let hasExited = false
    let stderr = ''
    let pending = ''
    try {
      for await (const piece of child) {
        if (piece.stream === 'stderr') {
          stderr = (stderr + piece.text).slice(-400)
          continue
        }
        pending += piece.text
        for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
          const line = pending.slice(0, end)
          pending = pending.slice(end + 1)
          let out
          try {
            out = JSON.parse(line)
          } catch {
            continue
          }
          if (out.type === 'ready') {
            self.socket = out.socket
            await write($, 'editing', (e): Editing | null => (e === null ? e : { ...e, status: 'running' }))
            await syncSize($)
          } else if (out.type === 'cells') {
            await show($, out)
          } else if (out.type === 'exit') {
            hasExited = true
          } else if (out.type === 'error') {
            failure = String(out.message)
          }
        }
      }
    } catch (err) {
      failure = `Could not run "${python}": ${reasonOf(err)}. Editing needs Python 3.9 or later; set its path in /config.`
    }
    if (helper === self) helper = null
    frame = null
    if (isStopping) return
    if (!hasExited) {
      const why = failure ?? (`The editor stopped unexpectedly. ${stderr.trim()}`.trim())
      const failed: Editing = { path, status: 'error', message: why }
      await write($, 'editing', () => failed)
      return
    }
    await write($, 'editing', () => null)
    await load($, dirname(path))
    await loadGit($, (await read($, snapshot)).root)
    if ((await read($, snapshot)).selected === path) await select($, path)
  })().catch(() => {}) // the module unloaded under the loop: nothing left to tell
}

// ---------------------------------------------------------------- wiring

export const register: Register = (on, options: Options) => {
  const program = options.editor || 'micro'

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    home = (await $.env.get('HOME')) ?? ''
    await $.command.register({ name: 'atlas', description: 'Explore files in a pane; a file opens in micro (/atlas [path])', immediate: true })
    await reseed($)
    const pixels = e.surface === 'terminal' && (await pixelsHere($))
    await write($, 'hasPixels', () => pixels)
    try {
      const kept = await $.store.get('showHidden')
      await write($, 'showHidden', () => kept === true)
    } catch {}
    // A reload ended the old editor with the old module.
    const closed = 'The editor closed when atlas reloaded. micro keeps a backup of unsaved changes and offers it when you reopen the file.'
    await write($, 'editing', (now): Editing | null => (now === null ? now : { ...now, status: 'error', message: closed }))
    if (e.isInteractive) $.clock.every(WATCH_MS, () => void watch($).catch(() => {}))

    return next(e)
  })

  // /clear: the editor and the pane stay up, so what they show is written back as soon as the
  // host's state is the new session's (now, or from the next event if that comes later).
  on('session.end', async ($, e, next) => {
    const result = await next(e)
    if (e.reason === 'clear') await reseed($).catch(() => {})
    return result
  })

  on('command.run', { command: 'atlas' }, async ($, e) => {
    await reseed($)
    const typed = e.args.trim()
    let target: string | null = null
    if (typed !== '') {
      const spelled = typed === '~' ? home : typed.startsWith('~/') ? join(home, typed.slice(2)) : typed.startsWith('/') ? typed : join(cwd, typed)
      try {
        const stat = await $.fs.stat(spelled, { resolve: true })
        target = stat.realPath ?? spelled
        const current = (await read($, snapshot)).root || cwd
        if (stat.kind === 'dir') await setRoot($, target)
        else await setRoot($, target.startsWith(`${current}/`) ? current : dirname(target))
      } catch {
        return { text: `atlas: nothing at ${typed}.` }
      }
    } else if ((await read($, snapshot)).root === '') {
      // Back where the person left this project last time, when that folder is still there.
      let kept: Remembered | null = null
      try {
        const stored = (await $.store.get(`root:${cwd}`)) as Remembered | undefined
        if (stored && typeof stored.root === 'string' && (await $.fs.exists(stored.root))) kept = stored
      } catch {}
      await setRoot($, kept?.root ?? cwd)
      if (kept) {
        for (const dir of kept.expanded.filter(p => p.startsWith(`${kept.root}/`))) {
          if (await load($, dir)) await write($, 'expanded', list => (list.includes(dir) ? list : [...list, dir]))
        }
      }
    } else {
      await refresh($)
    }
    const opened = await openPane($)
    const base = (await read($, snapshot)).root
    if (target !== null && target !== base) {
      await reveal($, target)
      const info = (await read($, snapshot)).details
      if (info?.kind === 'file') await edit($, options, target)
    }
    return { text: `Atlas opened on ${tilde(base)}.${opened.isPlaced ? '' : ' Widen the terminal to see the pane.'}` }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && helper !== null && e.origin.kind !== 'unload') {
      $.ui.toast(`${program} is still open: quit it with Ctrl+Q first, so it can ask about unsaved changes.`)
      return { deny: `${program} is still open` }
    }
    return next(e)
  })

  // Walking the tree with the keys selects as it goes, as Dex's explorer does.
  // A row's key is `n:` and its path below the root.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined && e.element?.startsWith('n:')) {
      const path = join((await read($, snapshot)).root, e.element.slice(2))
      if ((await read($, snapshot)).selected !== path) void select($, path).catch(() => {})
    }
    return result
  })

  on('ui.message', { requestId: PANE }, async ($, e) => {
    const data = e.data as TerminalMessage
    if (data.kind === 'size') await syncSize($)
    else if (data.kind === 'key') await call($, '/key', data)
    else if (data.kind === 'pointer') await call($, '/mouse', data)
    return {}
  })

  // The wheel over the editor scrolls the file; over the explorer, the pane.
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if (helper === null || editorView === null) return next(e)
    const y = e.pointer ? e.pointer.row - EDITOR_HEADER_ROWS : Math.floor(editorView.rows / 2)
    const x = e.pointer ? e.pointer.column : Math.floor(editorView.columns / 2)
    const type = e.by < 0 ? 'wheel-up' : 'wheel-down'
    for (let i = 0; i < Math.min(5, Math.abs(e.by)); i += 1) await call($, '/mouse', { type, x, y })
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Code, Markdown, Text } = elements
    paneBody = { columns: e.props.bodyColumns, rows: e.props.scroll.bodyRows }
    // Drawn from what this process kept after a /clear; the host gets it back off the render.
    if (!(await read($, seeded))) $.clock.after(0, () => void reseed($).catch(() => {}))
    const shown = await read($, snapshot)
    const { editing: now, root: base } = shown

    if (now !== null) {
      const rel = relOf(now.path, base)
      if (now.status === 'error' || e.surface !== 'terminal') {
        editorView = null
        return (
          <Box flexDirection="column">
            <Text color="red">{now.message ?? `${program} draws only in Claude Code's terminal.`}</Text>
            <Button key="back" variant="primary" label="Back to files" onPress={() => write($, 'editing', () => null)} />
          </Box>
        )
      }
      const { Client, Raster } = $.ui.resolve(e)
      const view = { columns: e.props.bodyColumns, rows: Math.max(3, e.props.scroll.bodyRows - EDITOR_HEADER_ROWS) }
      editorView = view
      const fits = frame !== null && frame.columns === view.columns && frame.rows === view.rows
      // Ctrl+C and Ctrl+Z never reach the editor (Claude Code keeps them), and
      // Escape hands the keys back to the prompt: these send them instead.
      const send = (text: string) => () => call($, '/text', { text })
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Button key="esc" label="Esc" onPress={send('\x1b')} />
            <Button key="copy" label="Copy" onPress={send('\x03')} />
            <Button key="undo" label="Undo" onPress={send('\x1a')} />
            <Text wrap="truncate-end">
              <Text bold>{now.status === 'starting' ? `Starting ${program}…` : program}</Text>
              <Text dimColor>{` ${rel} · click the text to type · Ctrl+S save · Ctrl+Q quit`}</Text>
            </Text>
          </Box>
          <Box width={view.columns} height={view.rows}>
            <Raster key="editor" columns={view.columns} rows={view.rows} cells={fits ? (frame as Frame).cells : blankCells(view)} />
            <Box position="absolute" top={0} left={0}>
              <Client key="terminal" module="./terminal.tsx" width={view.columns} height={view.rows} />
            </Box>
          </Box>
        </Box>
      )
    }
    editorView = null

    const hidden = shown.showHidden
    const marks = shown.git
    // Indexed once for this drawing: every folder row asks it below.
    const marksByPath = indexMarks(marks, base)
    const allListings = shown.listings
    const shownListings = hidden
      ? allListings
      : Object.fromEntries(Object.entries(allListings).map(([dir, entries]) => [dir, entries.filter(entry => !isHidden(entry.name))]))
    const tree = rows(base, shownListings, shown.expanded, TREE_LIMITS)
    const hiddenCount = (allListings[base] ?? []).filter(entry => isHidden(entry.name)).length
    const chosen = shown.selected
    const info = shown.details
    const hits = shown.results
    const named = shown.naming
    const line = shown.notice
    const typed = shown.query
    const how = shown.mode
    const pixels = shown.hasPixels
    const width = e.props.bodyColumns
    const isWide = width >= 90
    const treeWidth = isWide ? Math.min(48, Math.floor(width * 0.42)) : width
    const canType = e.surface !== 'mobile' // mobile draws no Input: naming needs one
    const changed = Object.keys(marks).length
    const setMode = async (next: SearchMode) => {
      await write($, 'mode', () => next)
      if (typed.trim()) await search($, typed)
    }
    const toggleHidden = async () => {
      const next = !hidden
      await write($, 'showHidden', () => next)
      try {
        await $.store.set('showHidden', next)
      } catch {}
    }
    const collapseAll = async () => {
      await write($, 'expanded', () => [])
      await remember($)
    }

    let finder = null
    if (e.surface !== 'mobile') {
      const { Input } = $.ui.resolve(e)
      finder = (
        <Box flexDirection="row" gap={1}>
          <Box flexGrow={1} flexShrink={1}>
            <Input key="find" label="⌕ " placeholder={how === 'text' ? 'text inside files under this folder' : 'part of a name under this folder'}
              value={typed} submitLabel="search" onSubmit={value => search($, value)} />
          </Box>
          {how === 'names'
            ? <Text bold inverse>{' names '}</Text>
            : <Button key="mode-names" plain label="names" onPress={() => setMode('names')} />}
          {how === 'text'
            ? <Text bold inverse>{' text '}</Text>
            : <Button key="mode-text" plain label="text" onPress={() => setMode('text')} />}
        </Box>
      )
    }

    let asking = null
    if (named !== null && e.surface !== 'mobile') {
      const { Input } = $.ui.resolve(e)
      const label = named.action === 'rename' ? `Rename ${nameOf(named.target)} to`
        : `New ${named.action} in ${named.target === base ? tilde(base) : relOf(named.target, base)}`
      asking = (
        <Box flexDirection="row" gap={1}>
          <Box flexGrow={1}>
            <Input key="name" label={label} autoFocus value={named.action === 'rename' ? nameOf(named.target) : ''}
              submitLabel={named.action === 'rename' ? 'rename' : 'create'} onSubmit={value => finishNaming($, value)} />
          </Box>
          <Button key="cancel" plain label="Cancel" onPress={() => write($, 'naming', () => null)} />
        </Box>
      )
    }

    let explorer
    if (hits !== null) {
      explorer = (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text bold>{`${hits.length}${hits.length === SEARCH_LIMIT ? '+' : ''} found`}</Text>
            <Button key="clear" plain label="Back to the tree" onPress={() => write($, 'results', () => null)} />
          </Box>
          {hits.map((hit, index) => {
            const where = relOf(hit.path, base)
            const key = hit.line === undefined ? `r:${relative(hit.path, base)}` : `r:${relative(hit.path, base)}:${hit.line}`
            return (
              <Box key={`hit-${index}`} flexDirection="column">
                <Button key={key} plain label={hit.line === undefined ? where : `${where}:${hit.line}`} onPress={() => reveal($, hit.path, hit.line)} />
                {hit.text !== undefined && <Text dimColor wrap="truncate-end">{`    ${hit.text}`}</Text>}
              </Box>
            )
          })}
        </Box>
      )
    } else {
      // The focus ring starts in the tree, so the arrows walk it at once.
      const firstEntry = tree.find(row => row.type === 'entry')
      const ringStart = tree.some(row => row.path === chosen) ? chosen : firstEntry?.path
      explorer = (
        <Box flexDirection="column">
          {tree.length === 0 && <Text dimColor>{hiddenCount > 0 ? `Only hidden files here (${hiddenCount}).` : 'This folder is empty.'}</Text>}
          {tree.map(row => {
            const indent = '  '.repeat(row.depth)
            if (row.type === 'more') return <Text key={`more:${relative(row.path, base)}`} dimColor>{`  ${indent}… ${row.hidden} more`}</Text>
            if (row.type === 'cut') return <Text key="cut" dimColor>  … more: close some folders, or use Find</Text>
            const kind = classOf(row.entry.name, row.entry.kind, row.entry.isLink)
            const isChosen = row.path === chosen
            const mark = row.entry.kind === 'dir' ? markFor(marksByPath, row.path) : marks[row.path] ?? null
            return (
              <Box key={`row:${relative(row.path, base)}`} flexDirection="row" hover={{ backgroundColor: '#1c2730' }}>
                <Text color="cyan">{isChosen ? '▌' : ' '}</Text>
                <Text color={kind.color}>{`${indent}${row.entry.kind === 'dir' ? (row.isOpen ? '▾' : '▸') : kind.glyph} `}</Text>
                <Button key={`n:${relative(row.path, base)}`} plain dimColor={isHidden(row.entry.name) && !isChosen}
                  autoFocus={row.path === ringStart ? true : undefined}
                  label={printable(row.entry.kind === 'dir' ? `${row.entry.name}/` : row.entry.name)}
                  onPress={async () => {
                    await say($, null)
                    if (row.entry.kind === 'dir') await toggle($, row.path)
                    await select($, row.path)
                  }} />
                {mark !== null && (
                  <Text color={MARK_COLORS[mark]}>{row.entry.kind === 'dir' ? ' •' : ` ${mark}`}</Text>
                )}
              </Box>
            )
          })}
        </Box>
      )
    }

    const prop = (name: string, value: string, color?: string) => (
      <Box key={`prop:${name}`} flexDirection="row">
        <Box width={10} flexShrink={0}><Text dimColor>{name}</Text></Box>
        <Text wrap="truncate-middle" color={color}>{value}</Text>
      </Box>
    )
    const isFile = info !== null && info.kind === 'file'
    const isDir = info !== null && info.kind === 'dir'
    const chosenMark = info === null ? null : marks[info.path] ?? null
    let source = null
    if (info?.preview) {
      const shown = info.preview
      if (shown.kind === 'text') {
        source = (
          <Box flexDirection="column">
            {shown.startLine > 1 && <Text dimColor>{`… from line ${shown.startLine}`}</Text>}
            <Code source={shown.text || ' '} path={printable(info.path)} startLine={shown.startLine} wrap="truncate-end" />
            {shown.isCut && <Text dimColor>{`… press e to open the whole file in ${program}`}</Text>}
          </Box>
        )
      } else if (shown.kind === 'markdown') {
        source = (
          <Box flexDirection="column">
            <Markdown key="markdown" text={shown.text || ' '} />
            {shown.isCut && <Text dimColor>{`… press e to open the whole file in ${program}`}</Text>}
          </Box>
        )
      } else if (shown.kind === 'image' && 'Image' in elements && pixels) {
        const room = { columns: Math.max(10, Math.min(isWide ? width - treeWidth - 4 : width - 2, 80)), rows: Math.max(4, Math.min(24, Math.floor(paneBody.rows * 0.5))) }
        source = <elements.Image key="picture" source={{ file: shown.path, format: 'png', generation: Math.trunc(info.mtimeMs) }} columns={room.columns} rows={room.rows} alt={nameOf(shown.path)} />
      } else {
        source = <Text dimColor>{shown.kind === 'binary' ? 'Binary file: no preview.' : shown.kind === 'large' ? 'Too large to preview here.' : shown.kind === 'image' ? 'A picture: open it with its app to see it.' : `Cannot read it: ${shown.reason}`}</Text>
      }
    }

    const inspector = (
      <Box flexDirection="column" flexGrow={1}>
        <Text bold>Properties</Text>
        {info === null || info.path !== chosen
          ? <Text dimColor>{chosen === null ? 'Select a file or folder: click it, or Tab to it.' : 'Reading…'}</Text>
          : (
            <Box flexDirection="column">
              {prop('Name', nameOf(info.path))}
              {prop('Class', classOf(basename(info.path), info.kind, info.isLink).name)}
              {prop('Path', relOf(info.path, base))}
              {isFile && prop('Size', size(info.size))}
              {isDir && info.items !== null && prop('Items', String(info.items))}
              {prop('Modified', date(info.mtimeMs))}
              {chosenMark !== null && prop('Git', MARK_NAMES[chosenMark], MARK_COLORS[chosenMark])}
              {info.realPath !== null && prop('Links to', tilde(info.realPath))}
            </Box>
          )}
        <Text bold>Actions</Text>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {isFile && <Button key="edit" plain hotkey="e" label={`Edit in ${program}`} onPress={() => edit($, options, info.path)} />}
          {isDir && <Button key="open" plain hotkey="o" label="Open as root" onPress={() => setRoot($, info.path)} />}
          {chosen !== null && <Button key="mention" plain hotkey="p" label="Add to prompt" onPress={() => mention($, chosen)} />}
          {chosen !== null && <Button key="copy-path" plain hotkey="c" label="Copy path" onPress={press => copyPath($, chosen, press.surface)} />}
          {chosen !== null && e.surface === 'terminal' && <Button key="open-app" plain hotkey="a" label="Open with app" onPress={() => openWithApp($, chosen)} />}
          {chosen !== null && canType && <Button key="rename" plain hotkey="r" label="Rename" onPress={() => startNaming($, 'rename')} />}
          {chosen !== null && <Button key="duplicate" plain hotkey="d" label="Duplicate" onPress={() => duplicate($, chosen)} />}
          {chosen !== null && <Button key="trash" plain hotkey="x" label="Trash" onPress={() => trash($, chosen)} />}
          {canType && <Button key="new-file" plain hotkey="n" label="New file" onPress={() => startNaming($, 'file')} />}
          {canType && <Button key="new-folder" plain hotkey="f" label="New folder" onPress={() => startNaming($, 'folder')} />}
        </Box>
        {source !== null && <Text bold>{info?.preview?.kind === 'markdown' ? 'Preview' : 'Source'}</Text>}
        {source}
      </Box>
    )

    const trail = crumbs(base, home)
    const shownTrail = trail.length > 4 ? trail.slice(-4) : trail
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Box flexShrink={0}><Text bold color="cyan">Atlas</Text></Box>
          <Box flexDirection="row" flexShrink={1} flexWrap="wrap">
            {trail.length > 4 && <Text dimColor>{'… '}</Text>}
            {shownTrail.map((crumb, index) => (
              <Box key={`crumb-${index}`} flexDirection="row">
                {index === shownTrail.length - 1
                  ? <Text bold>{printable(crumb.label)}</Text>
                  : <Button key={`crumb:${crumb.path}`} plain dimColor label={printable(crumb.label)} onPress={() => setRoot($, crumb.path)} />}
                {index < shownTrail.length - 1 && <Text dimColor>{' › '}</Text>}
              </Box>
            ))}
          </Box>
          <Box flexGrow={1} />
          {changed > 0 && <Text color="yellow">{`${changed} changed`}</Text>}
          <Button key="up" plain hotkey="u" label="Up" onPress={() => setRoot($, dirname(base))} />
          <Button key="hidden" plain hotkey="h" label={hidden ? 'Hide dotfiles' : `Show dotfiles${hiddenCount > 0 ? ` (${hiddenCount})` : ''}`}
            onPress={() => toggleHidden()} />
          <Button key="collapse" plain hotkey="z" label="Collapse" onPress={() => collapseAll()} />
          <Button key="refresh" plain hotkey="g" label="Refresh" onPress={() => refresh($)} />
        </Box>
        {finder}
        {asking}
        {line !== null && <Text color="yellow" wrap="truncate-end">{line}</Text>}
        {isWide
          ? (
            <Box flexDirection="row" gap={2}>
              <Box width={treeWidth} flexShrink={0} flexDirection="column">{explorer}</Box>
              {inspector}
            </Box>
          )
          : (
            <Box flexDirection="column">
              {explorer}
              {inspector}
            </Box>
          )}
      </Box>
    )
  })
}
