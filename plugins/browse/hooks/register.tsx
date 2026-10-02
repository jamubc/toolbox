// A mini browser in a pane. browser/browser.mjs runs a headless Chrome and
// streams the page as frames on stdout; this module blits them into a Raster
// (half-block cells, any terminal) or an Image (real pixels, kitty and
// Ghostty), and forwards clicks, keys and the wheel to it over its socket.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Renderer } from '../types'
import { toUrl } from './address'

const PANE = 'browse'
const HEADER_ROWS = 2 // the toolbar and the status line above the page
const MIN_COLUMNS = 24
const MIN_VIEW_ROWS = 4
const DENIES_BEFORE_FALLBACK = 3
const DEFAULT_COLOR = 0x01000000
const BLANK_PIXEL = { rgba: 'AAAA/w==', width: 1, height: 1 } as const
const NEEDS = 'Needs Chrome, Chromium, Brave or Edge, and Node.js 18 or later, on macOS or Linux.'
const START_PAGES = [
  ['YouTube', 'https://www.youtube.com'],
  ['DuckDuckGo', 'https://duckduckgo.com'],
  ['Wikipedia', 'https://en.wikipedia.org'],
  ['Hacker News', 'https://news.ycombinator.com'],
  ['GitHub', 'https://github.com'],
] as const

const status = atom({ plugin: 'browse', key: 'status' } as const, 'idle')
const message = atom({ plugin: 'browse', key: 'message' } as const, null)
const page = atom({ plugin: 'browse', key: 'page' } as const, { url: '', title: '' })
const renderer = atom({ plugin: 'browse', key: 'renderer' } as const, 'cells')

type Options = { renderer?: string; chrome?: string; node?: string }

type View = { columns: number; rows: number; renderer: Renderer }

type Frame =
  | { type: 'cells'; columns: number; rows: number; cells: string }
  | { type: 'image'; columns: number; rows: number; file: string; generation: number }

type Helper = { socket: string | null; ready: Promise<string>; stop: () => void }

type PointerMessage =
  | { kind: 'size' }
  | { kind: 'click'; x: number; y: number }
  | { kind: 'key'; key: string; ctrl?: true; shift?: true; meta?: true }

// What only this process has: the helper is a child of this module, so a
// hot reload ends it with the module, and these start over with it.
let helper: Helper | null = null
let view: View | null = null // the view as last drawn in the terminal
let sent: View | null = null // the view the helper renders for
let frame: Frame | null = null // the newest frame, drawn again on a redraw
let imageDenies = 0
const blanks = new Map<string, string>()

const sameView = (a: View | null, b: View | null) =>
  a !== null && b !== null && a.columns === b.columns && a.rows === b.rows && a.renderer === b.renderer

function blankCells(columns: number, rows: number): string {
  const size = `${columns}x${rows}`
  let cells = blanks.get(size)
  if (cells === undefined) {
    const words = new Uint32Array(columns * rows * 3)
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

/**
 * Real pixels where the terminal speaks the kitty graphics protocol. Not
 * through tmux, which drops it, nor over ssh, where the terminal cannot read
 * the frame files; kitty's variables leak into both.
 */
async function pickRenderer($: EngineInterface, options: Options): Promise<Renderer> {
  if (options.renderer === 'image') return 'image'
  if (options.renderer === 'blocks') return 'cells'
  const isRelayed =
    (await $.env.get('TMUX')) !== undefined ||
    (await $.env.get('SSH_CONNECTION')) !== undefined ||
    (await $.env.get('SSH_TTY')) !== undefined
  if (isRelayed) return 'cells'
  const term = (await $.env.get('TERM')) ?? ''
  const program = ((await $.env.get('TERM_PROGRAM')) ?? '').toLowerCase()
  const isKitty = (await $.env.get('KITTY_WINDOW_ID')) !== undefined
  return isKitty || term.includes('kitty') || term.includes('ghostty') || program === 'ghostty' ? 'image' : 'cells'
}

async function call($: EngineInterface, path: string, body: object = {}): Promise<void> {
  const socket = helper?.socket
  if (!socket) return
  try {
    const res = await $.http.fetch(`http://browse${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      socketPath: socket,
    })
    if (!res.ok) {
      let reason = `${path} failed (${res.status})`
      try {
        reason = JSON.parse(res.text).error ?? reason
      } catch {}
      await update($, message, () => reason)
    }
  } catch (err) {
    await update($, message, () => (err as Error).message)
  }
}

/** Tells the helper the size and kind of frames the pane now draws. */
async function syncView($: EngineInterface): Promise<void> {
  if (!helper?.socket || view === null || sameView(sent, view)) return
  sent = view
  await call($, '/resize', { columns: view.columns, rows: view.rows, mode: view.renderer === 'image' ? 'image' : 'cells' })
}

async function show($: EngineInterface, next: Frame): Promise<void> {
  frame = next
  if (view === null || next.columns !== view.columns || next.rows !== view.rows) return
  if (next.type === 'cells') {
    if (view.renderer === 'cells') await $.ui.blit({ requestId: PANE, key: 'view', cells: next.cells })
    return
  }
  if (view.renderer !== 'image') return
  const res = await $.ui.blit({
    requestId: PANE,
    key: 'view',
    source: { file: next.file, format: 'png', generation: next.generation },
  })
  // Not mounted (the pane hidden behind another tab) is no verdict on the terminal.
  if (res.deny === undefined || /mount/i.test(res.deny)) {
    imageDenies = 0
    return
  }
  $.ui.log(`browse: image frame refused: ${res.deny}`, { to: 'debug' })
  imageDenies += 1
  if (imageDenies >= DENIES_BEFORE_FALLBACK) {
    imageDenies = 0
    await update($, renderer, () => 'cells')
    $.ui.toast('This terminal cannot show the page as pixels here; drawing it in colored blocks instead.')
  }
}

async function onLine($: EngineInterface, self: Helper, out: any): Promise<string | null> {
  if (out.type === 'ready') {
    self.socket = out.socket
    await update($, status, () => 'ready')
    await syncView($)
  } else if (out.type === 'page') {
    await update($, page, () => ({ url: out.url, title: out.title }))
    await update($, message, () => null)
  } else if (out.type === 'cells' || out.type === 'image') {
    await show($, out)
  } else if (out.type === 'error') {
    return String(out.message)
  }
  return null
}

/** Starts the helper once; resolves with its socket when it listens. */
function startHelper($: EngineInterface, options: Options): Promise<string> {
  if (helper !== null) return helper.ready
  const node = options.node || 'node'
  const child = $.process.spawn({
    argv: [node, `${$.plugin.root}/browser/browser.mjs`],
    env: options.chrome ? { BROWSE_CHROME: options.chrome } : {},
  })
  let isStopping = false
  let ready!: (socket: string) => void
  let failed!: (err: Error) => void
  const self: Helper = {
    socket: null,
    ready: new Promise<string>((resolve, reject) => {
      ready = resolve
      failed = reject
    }),
    stop: () => {
      isStopping = true
      void child.return(undefined as never)
    },
  }
  self.ready.catch(() => {})
  helper = self
  sent = null
  frame = null

  void (async () => {
    await update($, status, () => 'starting')
    await update($, message, () => null)
    let failure: string | null = null
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
          failure = (await onLine($, self, out)) ?? failure
          if (out.type === 'ready') ready(out.socket)
        }
      }
    } catch (err) {
      failure = `Could not run the browser helper with "${node}": ${(err as Error).message}. Set Node.js in /config.`
    }
    if (helper === self) {
      helper = null
      sent = null
    }
    failed(new Error(failure ?? 'the browser stopped'))
    if (isStopping) return
    await update($, status, () => 'error')
    await update($, message, () => failure ?? `The browser stopped unexpectedly. ${stderr.trim()}`.trim())
  })().catch(() => {}) // the module unloaded under the loop: nothing left to tell

  return self.ready
}

async function stopHelper($: EngineInterface): Promise<void> {
  if (helper === null) return
  await call($, '/shutdown')
  helper?.stop()
  helper = null
  sent = null
  frame = null
  await update($, status, () => 'idle')
}

/** The plugin's own close: its `$.ui.close` never reaches its own `ui.close` hook. */
async function closePane($: EngineInterface): Promise<void> {
  await $.ui.close({ id: PANE })
  view = null
  await stopHelper($)
}

async function go($: EngineInterface, options: Options, url: string | null): Promise<void> {
  try {
    await startHelper($, options)
  } catch {
    return // the helper's own loop has said why
  }
  if (url !== null) await call($, '/navigate', { url })
}

async function open($: EngineInterface, options: Options, args: string) {
  const typed = args.trim()
  if (typed === 'close' || typed === 'stop') {
    await closePane($)
    return { text: 'Browser closed.' }
  }
  if (!(await $.session.surfaces()).includes('terminal')) {
    return { text: 'The browser pane draws only in the Claude Code terminal, not in this app yet.' }
  }
  const url = typed ? toUrl(typed) : null
  const opened = await $.ui.open({ id: PANE, title: 'Browse', focus: true, rows: 30, columns: 100 })
  void go($, options, url) // with no address, Chrome starts now and the start page asks where to
  const where = url ?? 'the browser'
  const looks = (await read($, renderer)) === 'cells' ? ' Drawn in colored blocks here; kitty or Ghostty show real pixels.' : ''
  return {
    text: opened.isPlaced
      ? `Opening ${where}.${looks}`
      : `Opening ${where}; widen the terminal to see the pane.${looks}`,
  }
}

export const register: Register = (on, options: Options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'browse', description: 'Browse the web' })
    const picked = await pickRenderer($, options)
    await update($, renderer, () => picked)
    // A reload ended the old helper with the old module.
    await update($, status, () => 'idle')

    return next(e)
  })

  on('command.run', { command: 'browse' }, ($, e) => open($, options, e.args))

  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) {
      view = null
      await stopHelper($)
    }
    return result
  })

  on('ui.message', { requestId: PANE }, async ($, e) => {
    const data = e.data as PointerMessage
    if (data.kind === 'size') await syncView($)
    else if (data.kind === 'click') await call($, '/click', { x: data.x, y: data.y })
    else if (data.kind === 'key') await call($, '/key', data)
    return {}
  })

  // The wheel over the page scrolls the page; the pane itself never scrolls.
  on('ui.scroll', { requestId: PANE }, async ($, e) => {
    if (view === null) return {}
    const row = e.pointer ? e.pointer.row - HEADER_ROWS : view.rows / 2
    if (row < 0) return {}
    const column = e.pointer ? e.pointer.column : view.columns / 2
    const dy = e.pointer ? e.by : Math.sign(e.by) * 3
    await call($, '/wheel', { x: (column + 0.5) / view.columns, y: (row + 0.5) / view.rows, dy })
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface !== 'terminal') {
      const { Box, Button, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Text>The browser pane draws only in Claude Code's terminal.</Text>
          <Text dimColor>Open this session in a terminal to see the page; kitty or Ghostty show real pixels.</Text>
          <Button key="close" label="Close" onPress={() => closePane($)} />
        </Box>
      )
    }
    const { Box, Button, Client, Image, Input, Raster, Text } = $.ui.resolve(e)
    const now = await read($, status)
    const why = await read($, message)
    const shown = await read($, page)
    const drawAs = await read($, renderer)
    const columns = e.props.bodyColumns
    const rows = e.props.scroll.bodyRows - HEADER_ROWS
    // No page yet: Chrome's blank page draws near-black, so the pane shows a
    // start page instead, and the address bar holds the keys from the start.
    const isBlank = shown.url === '' || shown.url === 'about:blank'

    const toolbar = (
      <Box flexDirection="row" gap={1}>
        <Button key="back" label="‹" onPress={() => call($, '/back')} />
        <Button key="forward" label="›" onPress={() => call($, '/forward')} />
        <Button key="reload" label="↻" onPress={() => call($, '/reload')} />
        <Box flexGrow={1}>
          <Input
            key="address"
            placeholder="address or search"
            value={isBlank ? '' : shown.url}
            autoFocus={isBlank ? true : undefined}
            submitLabel="go"
            onSubmit={value => go($, options, toUrl(value))}
          />
        </Box>
      </Box>
    )

    let line
    if (now === 'starting') line = <Text dimColor>Starting Chrome…</Text>
    else if (now === 'ready' && why !== null) line = <Text color="yellow" wrap="truncate-end">{why}</Text>
    else if (now === 'ready' && shown.url !== '' && shown.url !== 'about:blank') {
      line = (
        <Text wrap="truncate-end">
          <Text bold>{shown.title || shown.url}</Text>
          <Text dimColor>{`  ${shown.url}`}</Text>
        </Text>
      )
    } else if (isBlank) line = <Text dimColor wrap="truncate-end">Esc gives the keys back to the prompt.</Text>
    else line = <Text dimColor wrap="truncate-end">Click the page to type into it; Esc gives the keys back.</Text>

    let body
    if (now === 'error') {
      view = null
      body = (
        <Box flexDirection="column">
          <Text color="red">{why ?? 'The browser stopped.'}</Text>
          <Text dimColor>{NEEDS}</Text>
          <Button key="retry" label="Try again" variant="primary" onPress={() => go($, options, shown.url || null)} />
        </Box>
      )
    } else if (now === 'idle') {
      view = null
      body = (
        <Box flexDirection="column">
          <Text dimColor>The browser is stopped.</Text>
          <Button key="start" label="Start" variant="primary" onPress={() => go($, options, shown.url || null)} />
        </Box>
      )
    } else if (isBlank) {
      view = null
      body = (
        <Box flexDirection="column" paddingTop={1} gap={1}>
          <Text bold>Where to?</Text>
          <Text dimColor wrap="wrap">Type an address or a search into the bar above and press Enter, or pick one:</Text>
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {START_PAGES.map(([name, url]) => (
              <Button key={`start:${name}`} label={name} onPress={() => go($, options, url)} />
            ))}
          </Box>
        </Box>
      )
    } else if (columns < MIN_COLUMNS || rows < MIN_VIEW_ROWS) {
      view = null
      body = <Text dimColor>{`Make the pane bigger to see the page (at least ${MIN_COLUMNS}×${MIN_VIEW_ROWS + HEADER_ROWS}).`}</Text>
    } else {
      view = { columns, rows, renderer: drawAs }
      const fits = frame !== null && frame.columns === columns && frame.rows === rows
      const picture =
        drawAs === 'image' ? (
          <Image
            key="view"
            columns={columns}
            rows={rows}
            alt="This terminal cannot show images: set Picture to blocks in /config."
            source={fits && frame?.type === 'image' ? { file: frame.file, format: 'png', generation: frame.generation } : BLANK_PIXEL}
          />
        ) : (
          <Raster key="view" columns={columns} rows={rows} cells={fits && frame?.type === 'cells' ? frame.cells : blankCells(columns, rows)} />
        )
      body = (
        <Box width={columns} height={rows}>
          {picture}
          <Box position="absolute" top={0} left={0}>
            <Client key="pointer" module="./pointer.tsx" width={columns} height={rows} />
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {toolbar}
        {line}
        {body}
      </Box>
    )
  })
}
