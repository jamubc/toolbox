// Atlas, a Dex-style explorer for your files: an explorer pane (tree,
// properties, source viewer and actions) and a real terminal editor, micro by
// default, run inside the pane.
// editor/term.py hosts the editor in a pseudo-terminal and streams its screen
// as Raster cells; a Client over the picture forwards keys and the pointer.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Details, Editing, Entry, Naming, Preview } from '../types'
import {
  basename, classOf, copyName, date, dirname, foldersBetween, join, literalPattern, nameProblem, printable,
  printableSource, relative, rows, size, sorted,
} from './files'

const PANE = 'atlas'
// The tree's share of a pane's 100,000 characters, leaving room for the source.
const TREE_LIMITS = { perFolder: 300, rows: 800, characters: 50000 }
const PREVIEW_BYTES = 512 * 1024
const PREVIEW_LINES = 80
const PREVIEW_CHARS = 9000
const SEARCH_LIMIT = 200
const EDITOR_HEADER_ROWS = 1
const DEFAULT_COLOR = 0x01000000

const root = atom({ plugin: 'atlas', key: 'root' } as const, '')
const expanded = atom({ plugin: 'atlas', key: 'expanded' } as const, [])
const listings = atom({ plugin: 'atlas', key: 'listings' } as const, {})
const selected = atom({ plugin: 'atlas', key: 'selected' } as const, null)
const details = atom({ plugin: 'atlas', key: 'details' } as const, null)
const query = atom({ plugin: 'atlas', key: 'query' } as const, '')
const results = atom({ plugin: 'atlas', key: 'results' } as const, null)
const naming = atom({ plugin: 'atlas', key: 'naming' } as const, null)
const notice = atom({ plugin: 'atlas', key: 'notice' } as const, null)
const editing = atom({ plugin: 'atlas', key: 'editing' } as const, null)

type Options = { editor?: string; python?: string }
type Size = { columns: number; rows: number }
type Frame = Size & { cells: string }
type Helper = { socket: string | null; sent: Size | null; stop: () => void }
type TerminalMessage =
  | { kind: 'size' }
  | { kind: 'key'; key: string; ctrl?: true; shift?: true; meta?: true }
  | { kind: 'pointer'; type: string; x: number; y: number; button: string }

// What only this process has. The editor's host is a child of this module, so
// a hot reload ends it with the module, and these start over with it.
let cwd = ''
let home = ''
let helper: Helper | null = null
let frame: Frame | null = null
let editorView: Size | null = null // the editor's picture as last drawn
let paneBody: Size = { columns: 100, rows: 30 }
const blanks = new Map<string, string>()

const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err))
const say = ($: EngineInterface, text: string | null) => update($, notice, () => text)
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

// ---------------------------------------------------------------- the tree

async function load($: EngineInterface, dir: string): Promise<void> {
  try {
    const listed = await $.fs.list(dir)
    const entries = sorted(listed.map(({ name, kind, size: bytes, mtimeMs, isLink }): Entry => (
      { name, kind, size: bytes, mtimeMs, isLink })))
    await update($, listings, all => ({ ...all, [dir]: entries }))
  } catch (err) {
    await say($, `Cannot read ${tilde(dir)}: ${reasonOf(err)}`)
  }
}

async function previewOf($: EngineInterface, path: string, bytes: number): Promise<Preview> {
  if (bytes > PREVIEW_BYTES) return { kind: 'large' }
  try {
    const text = await $.fs.read(path)
    const head = text.slice(0, 8000)
    if (head.includes('\0') || (head.match(/�/g)?.length ?? 0) > head.length / 20) return { kind: 'binary' }
    const lines = text.split('\n')
    const kept = lines.slice(0, PREVIEW_LINES).join('\n')
    const shown = kept.slice(0, PREVIEW_CHARS)
    return {
      kind: 'text',
      text: printableSource(shown),
      isCut: lines.length > PREVIEW_LINES || kept.length > PREVIEW_CHARS,
    }
  } catch (err) {
    return { kind: 'unreadable', reason: reasonOf(err) }
  }
}

async function select($: EngineInterface, path: string | null): Promise<void> {
  await update($, selected, () => path)
  if (path === null) {
    await update($, details, () => null)
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
      preview: stat.kind === 'file' ? await previewOf($, path, stat.size) : null,
    }
    // A later selection may have landed while this one read.
    if ((await read($, selected)) === path) await update($, details, () => found)
  } catch (err) {
    await update($, details, () => null)
    await say($, `Cannot read ${tilde(path)}: ${reasonOf(err)}`)
  }
}

async function toggle($: EngineInterface, path: string): Promise<void> {
  if ((await read($, expanded)).includes(path)) {
    await update($, expanded, list => list.filter(p => p !== path && !p.startsWith(`${path}/`)))
    return
  }
  await load($, path)
  await update($, expanded, list => [...list, path])
}

async function setRoot($: EngineInterface, dir: string): Promise<void> {
  await update($, root, () => dir)
  await update($, results, () => null)
  await load($, dir)
}

/** Opens every folder down to `path` and selects it. */
async function reveal($: EngineInterface, path: string): Promise<void> {
  const base = await read($, root)
  for (const dir of foldersBetween(base, path)) {
    await load($, dir)
    await update($, expanded, list => (list.includes(dir) ? list : [...list, dir]))
  }
  await update($, results, () => null)
  await select($, path)
}

async function refresh($: EngineInterface): Promise<void> {
  await say($, null)
  await load($, await read($, root))
  for (const dir of await read($, expanded)) await load($, dir)
  await select($, await read($, selected))
}

async function search($: EngineInterface, text: string): Promise<void> {
  await update($, query, () => text)
  const words = text.trim()
  if (words === '') {
    await update($, results, () => null)
    return
  }
  const base = await read($, root)
  try {
    const ran = await $.process.run(
      ['find', base, '-mindepth', '1', '(', '-name', '.git', '-o', '-name', 'node_modules', ')', '-prune', '-o',
        '-iname', literalPattern(words), '-print'],
      { timeoutMs: 8000 },
    )
    const hits = ran.stdout.split('\n').filter(Boolean).slice(0, SEARCH_LIMIT)
    await update($, results, () => hits)
    await say($, hits.length === 0 ? `Nothing under ${tilde(base)} is named like "${words}".` : null)
  } catch (err) {
    await say($, `Search failed: ${reasonOf(err)}`)
  }
}

// ---------------------------------------------------------------- actions

/** The folder a new entry goes in: the selected folder, else the selected file's. */
async function folderForNew($: EngineInterface): Promise<string> {
  const path = await read($, selected)
  const info = await read($, details)
  if (path === null) return read($, root)
  return info?.path === path && info.kind === 'dir' ? path : dirname(path)
}

async function startNaming($: EngineInterface, action: Naming['action']): Promise<void> {
  const path = await read($, selected)
  if (action === 'rename' && path === null) return
  const target = action === 'rename' ? (path as string) : await folderForNew($)
  await say($, null)
  await update($, naming, () => ({ action, target }))
  // A click leaves the keys with the prompt: asking for the pane's focus again
  // hands them to the pane, where the name field is drawn autoFocus.
  await openPane($)
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Atlas', focus: true, columns: 110 })

async function finishNaming($: EngineInterface, typed: string): Promise<void> {
  const named = await read($, naming)
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
    await update($, naming, () => null)
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
    await update($, expanded, list => list.map(p => (p === from || p.startsWith(`${from}/`) ? to + p.slice(from.length) : p)))
  }
  await update($, naming, () => null)
  const base = await read($, root)
  if (dir !== base) await update($, expanded, list => (list.includes(dir) ? list : [...list, dir]))
  await load($, dir)
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
    await select($, to)
    await say($, `Duplicated as ${nameOf(to)}.`)
    return
  }
  await say($, `Too many copies of ${nameOf(path)} already.`)
}

/** Moves to the Trash, never deletes: macOS's trash, else gio on Linux. */
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
  for (const argv of [['trash', path], ['gio', 'trash', path]]) {
    try {
      ran = await $.process.run(argv, { timeoutMs: 30000 })
      break
    } catch {}
  }
  if (ran === null) {
    await say($, 'No trash command here (macOS 15 or later has one; Linux needs gio). Nothing was deleted.')
    return
  }
  if (ran.exitCode !== 0 || (await $.fs.exists(path))) {
    await say($, `Could not move ${name} to the Trash: ${ran.stderr.trim() || `exit ${ran.exitCode}`}`)
    return
  }
  await update($, expanded, list => list.filter(p => p !== path && !p.startsWith(`${path}/`)))
  await load($, dirname(path))
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
  const now = await read($, editing)
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
  await update($, editing, () => starting)
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
            await update($, editing, (e): Editing | null => (e === null ? e : { ...e, status: 'running' }))
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
      await update($, editing, () => failed)
      return
    }
    await update($, editing, () => null)
    await load($, dirname(path))
    if ((await read($, selected)) === path) await select($, path)
  })().catch(() => {}) // the module unloaded under the loop: nothing left to tell
}

// ---------------------------------------------------------------- wiring

export const register: Register = (on, options: Options) => {
  const program = options.editor || 'micro'

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    home = (await $.env.get('HOME')) ?? ''
    await $.command.register({ name: 'atlas', description: 'Explore files in a pane; a file opens in micro (/atlas [path])' })
    // A reload ended the old editor with the old module.
    const closed = 'The editor closed when atlas reloaded. micro keeps a backup of unsaved changes and offers it when you reopen the file.'
    await update($, editing, (now): Editing | null => (now === null ? now : { ...now, status: 'error', message: closed }))

    return next(e)
  })

  on('command.run', { command: 'atlas' }, async ($, e) => {
    const typed = e.args.trim()
    let target: string | null = null
    if (typed !== '') {
      const spelled = typed === '~' ? home : typed.startsWith('~/') ? join(home, typed.slice(2)) : typed.startsWith('/') ? typed : join(cwd, typed)
      try {
        const stat = await $.fs.stat(spelled, { resolve: true })
        target = stat.realPath ?? spelled
        const current = (await read($, root)) || cwd
        if (stat.kind === 'dir') await setRoot($, target)
        else await setRoot($, target.startsWith(`${current}/`) ? current : dirname(target))
      } catch {
        return { text: `atlas: nothing at ${typed}.` }
      }
    } else if ((await read($, root)) === '') {
      await setRoot($, cwd)
    } else {
      await load($, await read($, root))
    }
    const opened = await openPane($)
    const base = await read($, root)
    if (target !== null && target !== base) {
      await reveal($, target)
      const info = await read($, details)
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
      const path = join(await read($, root), e.element.slice(2))
      if ((await read($, selected)) !== path) void select($, path).catch(() => {})
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
    const { Box, Button, Code, Text } = $.ui.resolve(e)
    paneBody = { columns: e.props.bodyColumns, rows: e.props.scroll.bodyRows }
    const now = await read($, editing)
    const base = await read($, root)

    if (now !== null) {
      const rel = relOf(now.path, base)
      if (now.status === 'error' || e.surface !== 'terminal') {
        editorView = null
        return (
          <Box flexDirection="column">
            <Text color="red">{now.message ?? `${program} draws only in Claude Code's terminal.`}</Text>
            <Button key="back" variant="primary" label="Back to files" onPress={() => update($, editing, () => null)} />
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

    const tree = rows(base, await read($, listings), await read($, expanded), TREE_LIMITS)
    const chosen = await read($, selected)
    const info = await read($, details)
    const hits = await read($, results)
    const named = await read($, naming)
    const line = await read($, notice)
    const typed = await read($, query)
    const width = e.props.bodyColumns
    const isWide = width >= 90
    const treeWidth = isWide ? Math.min(48, Math.floor(width * 0.42)) : width

    let finder = null
    if (e.surface !== 'mobile') {
      const { Input } = $.ui.resolve(e)
      finder = (
        <Input key="find" label="Find" placeholder="part of a name under this folder" value={typed} submitLabel="search"
          onSubmit={value => search($, value)} />
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
          <Button key="cancel" plain label="Cancel" onPress={() => update($, naming, () => null)} />
        </Box>
      )
    }

    let explorer
    if (hits !== null) {
      explorer = (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text bold>{`${hits.length}${hits.length === SEARCH_LIMIT ? '+' : ''} found`}</Text>
            <Button key="clear" plain label="Back to the tree" onPress={() => update($, results, () => null)} />
          </Box>
          {hits.map(path => (
            <Button key={`r:${relative(path, base)}`} plain label={relOf(path, base)} onPress={() => reveal($, path)} />
          ))}
        </Box>
      )
    } else {
      // The focus ring starts in the tree, so the arrows walk it at once.
      const firstEntry = tree.find(row => row.type === 'entry')
      const ringStart = tree.some(row => row.path === chosen) ? chosen : firstEntry?.path
      explorer = (
        <Box flexDirection="column">
          {tree.length === 0 && <Text dimColor>This folder is empty.</Text>}
          {tree.map(row => {
            const indent = '  '.repeat(row.depth)
            if (row.type === 'more') return <Text key={`more:${relative(row.path, base)}`} dimColor>{`  ${indent}… ${row.hidden} more`}</Text>
            if (row.type === 'cut') return <Text key="cut" dimColor>  … more: close some folders, or use Find</Text>
            const kind = classOf(row.entry.name, row.entry.kind, row.entry.isLink)
            const isChosen = row.path === chosen
            return (
              <Box flexDirection="row">
                <Text color="cyan">{isChosen ? '▌' : ' '}</Text>
                <Text color={kind.color}>{`${indent}${row.entry.kind === 'dir' ? (row.isOpen ? '▾' : '▸') : kind.glyph} `}</Text>
                <Button key={`n:${relative(row.path, base)}`} plain dimColor={row.entry.name.startsWith('.') && !isChosen}
                  autoFocus={row.path === ringStart ? true : undefined}
                  label={printable(row.entry.kind === 'dir' ? `${row.entry.name}/` : row.entry.name)}
                  onPress={async () => {
                    await say($, null)
                    if (row.entry.kind === 'dir') await toggle($, row.path)
                    await select($, row.path)
                  }} />
              </Box>
            )
          })}
        </Box>
      )
    }

    const prop = (name: string, value: string) => (
      <Box key={`prop:${name}`} flexDirection="row">
        <Box width={10} flexShrink={0}><Text dimColor>{name}</Text></Box>
        <Text wrap="truncate-middle">{value}</Text>
      </Box>
    )
    const isFile = info !== null && info.kind === 'file'
    const isDir = info !== null && info.kind === 'dir'
    const canType = e.surface !== 'mobile' // mobile draws no Input: naming needs one
    let source = null
    if (info?.preview) {
      const shown = info.preview
      source = shown.kind === 'text'
        ? (
          <Box flexDirection="column">
            <Code source={shown.text || ' '} path={printable(info.path)} startLine={1} wrap="truncate-end" />
            {shown.isCut && <Text dimColor>{`… press e to open the whole file in ${program}`}</Text>}
          </Box>
        )
        : <Text dimColor>{shown.kind === 'binary' ? 'Binary file: no preview.' : shown.kind === 'large' ? 'Too large to preview here.' : `Cannot read it: ${shown.reason}`}</Text>
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
              {info.realPath !== null && prop('Links to', tilde(info.realPath))}
            </Box>
          )}
        <Text bold>Actions</Text>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {isFile && <Button key="edit" plain hotkey="e" label={`Edit in ${program}`} onPress={() => edit($, options, info.path)} />}
          {isDir && <Button key="open" plain hotkey="o" label="Open as root" onPress={() => setRoot($, info.path)} />}
          {chosen !== null && <Button key="mention" plain hotkey="p" label="Add to prompt" onPress={() => mention($, chosen)} />}
          {chosen !== null && <Button key="copy-path" plain hotkey="c" label="Copy path" onPress={press => copyPath($, chosen, press.surface)} />}
          {chosen !== null && canType && <Button key="rename" plain hotkey="r" label="Rename" onPress={() => startNaming($, 'rename')} />}
          {chosen !== null && <Button key="duplicate" plain hotkey="d" label="Duplicate" onPress={() => duplicate($, chosen)} />}
          {chosen !== null && <Button key="trash" plain hotkey="x" label="Trash" onPress={() => trash($, chosen)} />}
          {canType && <Button key="new-file" plain hotkey="n" label="New file" onPress={() => startNaming($, 'file')} />}
          {canType && <Button key="new-folder" plain hotkey="f" label="New folder" onPress={() => startNaming($, 'folder')} />}
        </Box>
        {source !== null && <Text bold>Source</Text>}
        {source}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Box flexShrink={0}><Text bold color="cyan">Atlas</Text></Box>
          <Box flexGrow={1} flexShrink={1}><Text dimColor wrap="truncate-start">{tilde(base)}</Text></Box>
          <Button key="up" plain hotkey="u" label="Up" onPress={() => setRoot($, dirname(base))} />
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
