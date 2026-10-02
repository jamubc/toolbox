import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { toUrl } from '../hooks/address'

const PANE = {
  component: 'Pane',
  requestId: 'browse',
  props: {
    title: 'Browse',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

type Call = { path: string; body: any }

/**
 * Stands in for the engine beneath the plugin: a terminal session, and a
 * browser helper that prints `lines` and then runs until /shutdown.
 */
function fakeWorld(on: On, lines: object[] | Error, calls: Call[], surfaces: string[] = ['terminal']) {
  let release!: () => void
  const running = new Promise<void>(resolve => {
    release = resolve
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.surfaces', async () => ({ value: surfaces }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('ui.open', async () => ({ value: { isOpen: true, isPlaced: true } }) as never)
  on('ui.close', async () => ({ value: undefined }) as never)
  on('ui.blit', async () => ({ value: {} }) as never)
  on('process.spawn', async function* () {
    if (lines instanceof Error) throw lines
    for (const line of lines) yield { stream: 'stdout' as const, text: `${JSON.stringify(line)}\n` }
    if (lines.some(l => (l as { type: string }).type === 'error')) return { value: { code: 1, signal: null } }
    await running
    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', async (_$, e) => {
    const path = new URL(e.url).pathname
    calls.push({ path, body: JSON.parse(e.init?.body ?? '{}') })
    if (path === '/shutdown') release()
    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })
}

/** Lets the plugin's background work run: each read of the drawing is a round trip. */
async function until(ui: { find: (query: { type: 'Box' }) => Promise<unknown> }, isDone: () => boolean) {
  for (let i = 0; i < 200 && !isDone(); i++) await ui.find({ type: 'Box' })
  expect(isDone()).toBe(true)
}

const READY = { type: 'ready', socket: '/tmp/browse-test/browser.sock' }
const PAGE = { type: 'page', url: 'https://www.youtube.com/results?search_query=lofi', title: 'lofi - YouTube' }

test('/browse with no address opens a start page that asks where to', async ($, on) => {
  const calls: Call[] = []
  fakeWorld(on, [READY, { type: 'page', url: 'about:blank', title: 'about:blank' }], calls)
  mock.env(on, { TERM: 'xterm-256color', TERM_PROGRAM: 'zed' })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'browse', args: '', ...RUN } as never)

  const ui = await $.ui.mount({ plugin: 'browse', surface: 'terminal', ...PANE })
  expect(await ui.find({ text: 'Where to?' })).toBeDefined()
  expect((await ui.find({ key: 'address' }))?.props).toMatchObject({ value: '', autoFocus: true })
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  expect(calls.some(c => c.path === '/navigate')).toBe(false)

  await ui.press({ key: 'start:YouTube' })
  expect(calls.at(-1)).toEqual({ path: '/navigate', body: { url: 'https://www.youtube.com' } })
  await ui.unmount()
  await $.command.run({ command: 'browse', args: 'close', ...RUN } as never)
})

test('/browse <address> opens the page and forwards clicks, keys and the wheel', async ($, on) => {
  const calls: Call[] = []
  fakeWorld(on, [READY, PAGE], calls)
  mock.env(on, { TERM: 'xterm-256color', TERM_PROGRAM: 'zed' })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  const ran = await $.command.run({ command: 'browse', args: PAGE.url, ...RUN } as never)
  expect(ran.text).toBe(
    'Opening https://www.youtube.com/results?search_query=lofi. Drawn in colored blocks here; kitty or Ghostty show real pixels.',
  )

  const ui = await $.ui.mount({ plugin: 'browse', surface: 'terminal', ...PANE })
  await until(ui, () => calls.some(c => c.path === '/navigate'))
  expect(calls).toContainEqual({ path: '/navigate', body: { url: PAGE.url } })
  expect((await ui.find({ type: 'Raster', key: 'view' }))?.props).toMatchObject({ columns: 80, rows: 28 })
  expect((await ui.find({ text: /lofi - YouTube/ }))).toBeDefined()

  await ui.resize({ columns: 80, rows: 28 })
  expect(calls).toContainEqual({ path: '/resize', body: { columns: 80, rows: 28, mode: 'cells' } })

  await ui.pointer({ type: 'down', x: 39, y: 13, button: 'left' })
  expect(calls).toContainEqual({ path: '/click', body: { x: 39.5 / 80, y: 13.5 / 28 } })

  await ui.key({ key: 'k' })
  expect(calls.at(-1)).toEqual({ path: '/key', body: { kind: 'key', key: 'k' } })

  await ui.input({ key: 'address', text: 'example.com' })
  expect(calls.at(-1)).toEqual({ path: '/navigate', body: { url: 'https://example.com' } })

  await ui.press({ key: 'back' })
  expect(calls.at(-1)?.path).toBe('/back')

  await ui.unmount()

  const closed = await $.command.run({ command: 'browse', args: 'close', ...RUN } as never)
  expect(closed.text).toBe('Browser closed.')
  expect(calls.at(-1)?.path).toBe('/shutdown')
})

test('picks real pixels in Ghostty', async ($, on) => {
  const calls: Call[] = []
  fakeWorld(on, [READY, PAGE], calls)
  mock.env(on, { TERM: 'xterm-ghostty', TERM_PROGRAM: 'ghostty' })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'browse', args: '', ...RUN } as never)

  const ui = await $.ui.mount({ plugin: 'browse', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Image', key: 'view' })).toBeDefined()
  await ui.resize({ columns: 80, rows: 28 })
  await until(ui, () => calls.some(c => c.path === '/resize'))
  expect(calls).toContainEqual({ path: '/resize', body: { columns: 80, rows: 28, mode: 'image' } })
  await ui.unmount()
  await $.command.run({ command: 'browse', args: 'close', ...RUN } as never)
})

test('draws blocks for kitty inside tmux, which drops kitty graphics', async ($, on) => {
  const calls: Call[] = []
  fakeWorld(on, [READY, PAGE], calls)
  mock.env(on, { TERM: 'tmux-256color', KITTY_WINDOW_ID: '1', TMUX: '/tmp/tmux-501/default,1,0' })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'browse', args: '', ...RUN } as never)

  const ui = await $.ui.mount({ plugin: 'browse', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Raster', key: 'view' })).toBeDefined()
  await ui.unmount()
  await $.command.run({ command: 'browse', args: 'close', ...RUN } as never)
})

test('says how to fix it when Node.js cannot run the helper', async ($, on) => {
  fakeWorld(on, new Error('executable not found: node'), [])
  mock.env(on, {})
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'browse', args: 'example.com', ...RUN } as never)

  const ui = await $.ui.mount({ plugin: 'browse', surface: 'terminal', ...PANE })
  let isShown = false
  for (let i = 0; i < 200 && !isShown; i++) isShown = (await ui.find({ text: /Set Node\.js in \/config/ })) !== undefined
  expect(isShown).toBe(true)
  expect(await ui.find({ key: 'retry' })).toBeDefined()
  await ui.unmount()
})

test('says why when the browser cannot start, and offers to try again', async ($, on) => {
  const calls: Call[] = []
  const why = 'No Chrome, Chromium, Brave or Edge found. Install one, or set the Chrome path in /config.'
  fakeWorld(on, [{ type: 'error', message: why }], calls)
  mock.env(on, {})
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'browse', args: 'example.com', ...RUN } as never)

  const ui = await $.ui.mount({ plugin: 'browse', surface: 'terminal', ...PANE })
  let isShown = false
  for (let i = 0; i < 200 && !isShown; i++) isShown = (await ui.find({ text: why })) !== undefined
  expect(isShown).toBe(true)
  expect(await ui.find({ key: 'retry' })).toBeDefined()
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  expect(calls.some(c => c.path === '/navigate')).toBe(false)
  await ui.unmount()
})

test('outside the terminal it says so instead of starting a browser', async ($, on) => {
  const calls: Call[] = []
  fakeWorld(on, [READY], calls, ['desktop'])
  mock.env(on, {})
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  const ran = await $.command.run({ command: 'browse', args: 'lofi', ...RUN } as never)
  expect(ran.text).toContain('only in the Claude Code terminal')
  expect(calls).toEqual([])

  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'browse', surface, ...PANE })
    expect((await ui.find({ text: /draws only in Claude Code's terminal/ }))).toBeDefined()
    await ui.unmount()
  }
})

/**
 * What /clear does to a plugin: the session ends and a new one begins in the same process, so the
 * host's `$.state` reads as never written while the module, its pane and Chrome live on. From the
 * mark, every read answers "never written" until the plugin writes that key again; through
 * `next`, so the drawing that read the key is still redrawn when it is written.
 */
function clearSession(on: On) {
  let isCleared = false
  const written = new Set<string>()
  on('state.get', async (_$, e, next) => {
    const got = await next(e)
    return (isCleared && !written.has(e.key) ? { value: { value: undefined, version: 0 } } : got) as never
  })
  on('state.set', (_$, e, next) => {
    if (isCleared) written.add(e.key)
    return next(e)
  })
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  return async ($: Engine) => {
    await ($ as any).session.end({ reason: 'clear', sessionId: 'before', resume: { id: 'before' } })
    isCleared = true
    written.clear()
  }
}

test('after /clear the page is still up, in the same picture, and the browser still answers', async ($, on) => {
  const calls: Call[] = []
  const clear = clearSession(on)
  const clock = mock.clock(on)
  fakeWorld(on, [READY, PAGE], calls)
  mock.env(on, { TERM: 'xterm-ghostty', TERM_PROGRAM: 'ghostty' })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'browse', args: PAGE.url, ...RUN } as never)
  const ui = await $.ui.mount({ plugin: 'browse', surface: 'terminal', ...PANE })
  await until(ui, () => calls.some(c => c.path === '/navigate'))
  expect(await ui.find({ type: 'Image', key: 'view' })).toBeDefined()
  await ui.unmount()

  await clear($)
  const after = await $.ui.mount({ plugin: 'browse', surface: 'terminal', ...PANE })
  // Not "The browser is stopped" with a Start button that cannot start what is already running.
  expect(await after.find({ key: 'start' })).toBeUndefined()
  expect(await after.find({ text: /lofi - YouTube/ })).toBeDefined()
  expect(await after.find({ type: 'Image', key: 'view' })).toBeDefined()
  await clock.advance(1)

  await after.input({ key: 'address', text: 'example.com' })
  expect(calls.at(-1)).toEqual({ path: '/navigate', body: { url: 'https://example.com' } })
  await after.unmount()

  const closed = await $.command.run({ command: 'browse', args: 'close', ...RUN } as never)
  expect(closed.text).toBe('Browser closed.')
  expect(calls.at(-1)?.path).toBe('/shutdown')
})

test('turns what was typed into a URL or a search', () => {
  expect(toUrl('https://example.com/a?b')).toBe('https://example.com/a?b')
  expect(toUrl('example.com/path')).toBe('https://example.com/path')
  expect(toUrl('localhost:3000')).toBe('http://localhost:3000')
  expect(toUrl('cats vs dogs')).toBe('https://duckduckgo.com/?q=cats%20vs%20dogs')
  expect(toUrl('javascript:alert(1)')).toBe('https://duckduckgo.com/?q=javascript%3Aalert(1)')
  expect(toUrl('file:///etc/passwd')).toBe('https://duckduckgo.com/?q=file%3A%2F%2F%2Fetc%2Fpasswd')
})
