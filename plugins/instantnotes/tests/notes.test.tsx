import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { ago, argvFor, clipBody, filterHits, launchFromConfig, titleOf } from '../hooks/library'

const NOTE = {
  id: 'n1',
  title: 'Install InstantNotes on CachyOS/Arch',
  kind: 'document',
  body: '# Install\n\n1. Install the dependencies',
  tags: ['linux'],
  spaces: ['Instant Notes'],
  updatedAt: '2026-10-01T00:00:00Z',
}

const PANE = {
  component: 'Pane',
  requestId: 'instantnotes',
  props: {
    title: 'InstantNotes',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
const APP = '/Users/jam/Documents/github/jam-sw/InstantNotes/src-tauri/target/release/bundle/macos/InstantNotes.app/Contents/MacOS/instantnotes'

type Call = { name: string; args: any; argv?: readonly string[]; server?: string }

const ANSWERS: Record<string, unknown> = {
  search_notes: { results: [{ id: NOTE.id, title: NOTE.title, excerpt: 'Latest release', spaces: NOTE.spaces }] },
  list_notes: { notes: [{ id: 'n3', title: 'Groceries', snippet: 'eggs, milk' }] },
  get_note: NOTE,
  create_note: { ...NOTE, id: 'n2', title: 'Buy milk' },
}

type World = {
  calls: Call[]
  files: Map<string, string>
  // The MCP server Claude Code runs, once the person ran `claude mcp add`.
  hasServer: boolean
  // Programs that exist, by absolute path; a bare name runs when `onPath`.
  binaries: Set<string>
  onPath: boolean
  clock?: ReturnType<typeof mock.clock>
}

/** Stands in for the Mac beneath the plugin: files, the MCP server, and `instantnotes mcp`. */
function fakeMac(on: On, setup: Partial<World> = {}): World {
  const world: World = { calls: [], files: new Map(), hasServer: false, binaries: new Set(), onPath: true, ...setup }
  const result = (name: string) => ({ content: [], isError: false, structuredContent: ANSWERS[name] })

  on('mcp.call', async (_$, e) => {
    if (!world.hasServer) return { deny: `no MCP server named ${e.server}` }
    world.calls.push({ name: e.tool, args: e.args, server: e.server })
    return { value: result(e.tool) }
  })
  on('process.run', async (_$, e) => {
    const [binary] = e.argv
    const exists = binary !== undefined && (binary.startsWith('/') ? world.binaries.has(binary) : world.onPath)
    if (!exists) return { deny: `ENOENT: no such file or directory, posix_spawn '${binary}'` }
    const request = JSON.parse(e.init?.stdin ?? '{}')
    const { name, arguments: args } = request.params
    world.calls.push({ name, args, argv: e.argv })
    return {
      value: {
        exitCode: 0,
        stdout: `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: result(name) })}\n`,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('fs.read', async (_$, e) => {
    const text = world.files.get(e.path)
    if (text === undefined) return { deny: `ENOENT: ${e.path}` } as never
    return { value: text } as never
  })
  on('fs.exists', async (_$, e) => ({ value: world.binaries.has(e.path) || world.files.has(e.path) }) as never)
  on('fs.stat', async (_$, e) => {
    if (!world.files.has(e.path)) return { deny: `ENOENT: ${e.path}` } as never
    return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } } as never
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async () => ({ value: undefined }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.copy', async () => ({ value: { isCopied: true } }) as never)
  on('prompt.fill', async () => ({ value: { isFilled: true } }) as never)
  world.clock = mock.clock(on, { now: Date.parse('2026-10-02T12:00:00Z') })
  mock.env(on, { HOME: '/Users/jam' })
  return world
}

const start = ($: any, args = '') =>
  $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true }).then(() =>
    $.command.run({ command: 'notes', args, ...RUN }))

describe('the pane', () => {
  test('searches, opens a note and draws it as markdown', { options: { db: '/tmp/lib.db' } }, async ($, on) => {
    const world = fakeMac(on)
    await start($)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'instantnotes', surface, ...PANE })
      await ui.input({ key: 'query', text: 'CachyOS/Arch' })
      expect((await ui.find({ key: `hit-${NOTE.id}` }))?.text).toContain(NOTE.title)
      expect(await ui.find({ text: /1 result for "CachyOS\/Arch"/ })).toBeDefined()

      await ui.press({ key: `hit-${NOTE.id}` })
      expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe(NOTE.body)
      expect(await ui.find({ text: /Instant Notes {2}· {2}#linux {2}· {2}updated yesterday/ })).toBeDefined()

      await ui.press({ key: 'back' })
      expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
      await ui.unmount()
    }

    const search = world.calls.find(c => c.name === 'search_notes')
    expect(search?.args).toEqual({ query: 'CachyOS/Arch', limit: 20 })
    expect(search?.argv).toEqual(['instantnotes', 'mcp', '--db', '/tmp/lib.db', '--attachments', '/tmp/attachments'])
    // The note was read once; the second surface drew it from memory.
    expect(world.calls.filter(c => c.name === 'get_note')).toHaveLength(1)
  })

  test('typing filters what is listed before Enter searches the library', { options: { db: '/tmp/lib.db' } }, async ($, on) => {
    const world = fakeMac(on)
    await start($)
    const ui = await $.ui.mount({ plugin: 'instantnotes', surface: 'terminal', ...PANE })
    expect((await ui.find({ key: 'hit-n3' }))?.text).toBe('Groceries')
    expect(await ui.find({ text: 'Recent notes · 1' })).toBeDefined()

    await ui.input({ key: 'query', text: 'zzz', kind: 'change' })
    expect(await ui.find({ key: 'hit-n3' })).toBeUndefined()
    expect(await ui.find({ text: /0 of 1 match "zzz"/ })).toBeDefined()
    expect(world.calls.filter(c => c.name === 'search_notes')).toHaveLength(0)

    await ui.input({ key: 'query', text: 'milk', kind: 'change' })
    expect((await ui.find({ key: 'hit-n3' }))?.text).toBe('Groceries')
    await ui.unmount()
  })

  test('a new note is written in the pane and opens once saved', { options: { db: '/tmp/lib.db' } }, async ($, on) => {
    const world = fakeMac(on)
    await start($)
    const ui = await $.ui.mount({ plugin: 'instantnotes', surface: 'terminal', ...PANE })
    expect(await ui.find({ key: 'compose' })).toBeUndefined()
    await ui.press({ key: 'new' })
    await ui.input({ key: 'compose', text: 'Buy milk\n\nand eggs' })
    expect(world.calls.find(c => c.name === 'create_note')?.args).toEqual({ body: 'Buy milk\n\nand eggs' })
    expect(await ui.find({ type: 'Markdown' })).toBeDefined()
    await ui.unmount()
  })
})

describe('reaching InstantNotes', () => {
  test('/note captures text as a new note', { options: { db: '/tmp/lib.db' } }, async ($, on) => {
    const world = fakeMac(on)
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    const ran = await $.command.run({ command: 'note', args: 'Buy milk', ...RUN })
    expect(ran.text).toBe('Saved note "Buy milk".')
    expect(world.calls.map(c => c.name)).toEqual(['create_note'])
    expect(world.calls[0]?.args).toEqual({ body: 'Buy milk' })
  })

  test('the MCP server Claude Code runs is used first, and no process starts', async ($, on) => {
    const world = fakeMac(on, { hasServer: true, onPath: false })
    const ran = await start($, 'arch')
    expect(ran.text).toBe('InstantNotes pane opened (through the instantnotes MCP server).')
    expect(world.calls).toEqual([{ name: 'search_notes', args: { query: 'arch', limit: 20 }, server: 'instantnotes' }])
    const ui = await $.ui.mount({ plugin: 'instantnotes', surface: 'terminal', ...PANE })
    expect(await ui.find({ text: 'via MCP server' })).toBeDefined()
    await ui.unmount()
  })

  test('without the server, the program and library come from what claude mcp add wrote', async ($, on) => {
    const config = {
      mcpServers: {
        instantnotes: {
          command: APP,
          args: ['mcp', '--db', '/Users/jam/Library/Application Support/com.instantnotes.app/instantnotes.db',
            '--attachments', '/Users/jam/Library/Application Support/com.instantnotes.app/attachments'],
        },
      },
    }
    const world = fakeMac(on, { onPath: false, binaries: new Set([APP]), files: new Map([['/Users/jam/.claude.json', JSON.stringify(config)]]) })
    await start($)
    expect(world.calls[0]?.argv).toEqual([
      APP, 'mcp', '--db', '/Users/jam/Library/Application Support/com.instantnotes.app/instantnotes.db',
      '--attachments', '/Users/jam/Library/Application Support/com.instantnotes.app/attachments',
    ])
  })

  test('the app bundle is found when nothing else names the program', async ($, on) => {
    const bundled = '/Applications/InstantNotes.app/Contents/MacOS/instantnotes'
    const world = fakeMac(on, { onPath: false, binaries: new Set([bundled]) })
    await start($)
    expect(world.calls[0]?.argv?.slice(0, 2)).toEqual([bundled, 'mcp'])
    expect(world.calls[0]?.argv?.[3]).toBe('/Users/jam/Library/Application Support/com.instantnotes.app/instantnotes.db')
  })

  test('when nothing can start, the pane says what to set up, step by step', async ($, on) => {
    fakeMac(on, { onPath: false })
    await start($)
    const ui = await $.ui.mount({ plugin: 'instantnotes', surface: 'terminal', ...PANE })
    expect(await ui.find({ text: /InstantNotes could not be started/ })).toBeDefined()
    expect(await ui.find({ text: /1\. Open InstantNotes, then Settings › Agents/ })).toBeDefined()
    expect(await ui.find({ text: /claude mcp add instantnotes/ })).toBeDefined()
    expect(await ui.find({ text: /3\. Or set InstantNotes binary in \/config/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('the helpers', () => {
  test('reads the server out of a Claude Code configuration', () => {
    const user = JSON.stringify({ mcpServers: { instantnotes: { command: '/a/instantnotes', args: ['mcp', '--db', '/lib.db'] } } })
    expect(launchFromConfig(user)).toEqual({ binary: '/a/instantnotes', db: '/lib.db' })
    const project = JSON.stringify({ projects: { '/work': { mcpServers: { instantnotes: { command: 'instantnotes', args: [] } } } } })
    expect(launchFromConfig(project, '/work')).toEqual({ binary: 'instantnotes' })
    expect(launchFromConfig(project, '/elsewhere')).toBeNull()
    expect(launchFromConfig('not json')).toBeNull()
    expect(launchFromConfig(JSON.stringify({ mcpServers: { instantnotes: { command: 7 } } }))).toBeNull()
  })

  test('builds the command line, taking a binary typed with its own words', () => {
    expect(argvFor('instantnotes', '/l.db', '/att')).toEqual(['instantnotes', 'mcp', '--db', '/l.db', '--attachments', '/att'])
    expect(argvFor('/Applications/Instant Notes.app/Contents/MacOS/instantnotes', '/l.db', '/att')[0]).toBe('/Applications/Instant Notes.app/Contents/MacOS/instantnotes')
    expect(argvFor('instantnotes mcp', '/l.db', '/att')).toEqual(['instantnotes', 'mcp', '--db', '/l.db', '--attachments', '/att'])
  })

  test('shapes text for the pane', () => {
    expect(filterHits([{ id: '1', title: 'Buy milk', excerpt: 'and eggs', spaces: [] }], 'EGGS milk')).toHaveLength(1)
    expect(filterHits([{ id: '1', title: 'Buy milk', excerpt: '', spaces: [] }], 'bread')).toHaveLength(0)
    expect(clipBody('short', 100)).toEqual({ text: 'short', cut: 0 })
    const long = `${'a'.repeat(90)}\n${'b'.repeat(90)}`
    expect(clipBody(long, 100)).toEqual({ text: `${'a'.repeat(90)}…`, cut: 91 })
    expect(clipBody('x\u0007y\r\nz', 100).text).toBe('xy\nz')
    expect(titleOf('\n# Hello world\nmore')).toBe('Hello world')
    const now = Date.parse('2026-10-02T12:00:00Z')
    expect(ago('2026-10-02T11:30:00Z', now)).toBe('30 min ago')
    expect(ago('2026-10-01T06:00:00Z', now)).toBe('yesterday')
    expect(ago('2026-01-01T00:00:00Z', now)).toBe('2026-01-01')
    expect(ago('nope', now)).toBe('')
  })
})

/**
 * What /clear does to a plugin: the session ends and a new one begins in the same process, so the
 * host's `$.state` reads as never written while the module and its pane live on. From the mark,
 * every read answers "never written" until the plugin writes that key again; through `next`, so
 * the drawing that read the key is still redrawn when it is written.
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

test('after /clear the open note and the search stay in the pane', { options: { db: '/tmp/lib.db' } }, async ($, on) => {
  const clear = clearSession(on)
  const clock = fakeMac(on).clock!
  await start($)
  const ui = await $.ui.mount({ plugin: 'instantnotes', surface: 'terminal', ...PANE })
  await ui.input({ key: 'query', text: 'CachyOS/Arch' })
  await ui.press({ key: `hit-${NOTE.id}` })
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe(NOTE.body)
  await ui.unmount()

  await clear($)
  const after = await $.ui.mount({ plugin: 'instantnotes', surface: 'terminal', ...PANE })
  expect((await after.find({ type: 'Markdown' }))?.props.text).toBe(NOTE.body)
  await clock.advance(1)
  await after.press({ key: 'back' })
  expect(await after.find({ type: 'Markdown' })).toBeUndefined()
  expect((await after.find({ key: 'query' }))?.props).toMatchObject({ value: 'CachyOS/Arch' })
  expect((await after.find({ key: `hit-${NOTE.id}` }))?.text).toContain(NOTE.title)
  await after.unmount()
})
