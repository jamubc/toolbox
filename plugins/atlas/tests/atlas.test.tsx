import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Entry } from '../types'

import {
  classOf, copyName, crumbs, folderMark, foldersBetween, indexMarks, literalPattern, markFor, nameProblem,
  parseGitStatus, parseGrep, relative, rows, sameEntries, sameMarks,
} from '../hooks/files'

const ROOT = '/work'
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
const pane = (bodyColumns: number) => ({
  component: 'Pane',
  requestId: 'atlas',
  props: {
    title: 'Atlas',
    isFocused: true,
    bodyColumns,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const)

type Node = { kind: 'file' | 'dir'; text?: string; mtimeMs?: number }
type World = {
  files: Map<string, Node>
  runs: string[][]
  calls: { route: string; body: any }[]
  spawned: string[][]
  store: Map<string, unknown>
  // What `git status --porcelain -z` answers; null for no repository.
  porcelain: string | null
  // Whether ripgrep is installed.
  hasRg: boolean
}

/** Stands in for the engine: a file tree in memory, the commands atlas runs, and an editor host. */
function fakeWorld(on: On, surfaces: string[] = ['terminal'], answer = 'Cancel'): World {
  const files = new Map<string, Node>([
    [ROOT, { kind: 'dir' }],
    [`${ROOT}/src`, { kind: 'dir' }],
    [`${ROOT}/src/main.ts`, { kind: 'file', text: 'export const x = 1\n' }],
    [`${ROOT}/src/util.ts`, { kind: 'file', text: 'export {}\n' }],
    [`${ROOT}/README.md`, { kind: 'file', text: '# Demo\n' }],
    [`${ROOT}/.env`, { kind: 'file', text: 'SECRET=1\n' }],
  ])
  const world: World = { files, runs: [], calls: [], spawned: [], store: new Map(), porcelain: ' M src/main.ts\0?? notes.txt\0', hasRg: true }
  const childrenOf = (dir: string) => [...files.keys()].filter(p => p !== dir && p.slice(0, p.lastIndexOf('/')) === dir)
  const stat = (path: string) => {
    const node = files.get(path)
    if (!node) throw new Error(`ENOENT: ${path}`)
    return { kind: node.kind, size: node.text?.length ?? 0, mtimeMs: node.mtimeMs ?? 0, isLink: false, realPath: path }
  }
  let release!: () => void
  const editorRuns = new Promise<void>(resolve => {
    release = resolve
  })

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.surfaces', async () => ({ value: surfaces }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('ui.open', async () => ({ value: { isOpen: true, isPlaced: true } }) as never)
  on('ui.close', async () => ({ value: undefined }) as never)
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.blit', async () => ({ value: {} }) as never)
  on('prompt.fill', async () => ({ value: { isFilled: true } }) as never)
  on('fs.list', async (_$, e) => ({ value: childrenOf(e.path).map(p => ({ name: p.slice(p.lastIndexOf('/') + 1), ...stat(p) })) }) as never)
  on('fs.stat', async (_$, e) => ({ value: stat(e.path) }) as never)
  on('fs.exists', async (_$, e) => ({ value: files.has(e.path) }) as never)
  on('fs.read', async (_$, e) => ({ value: files.get(e.path)?.text ?? '' }) as never)
  on('fs.write', async (_$, e) => {
    files.set(e.path, { kind: 'file', text: e.text })
    return { value: undefined } as never
  })
  on('process.run', async (_$, e) => {
    world.runs.push([...e.argv])
    const [command] = e.argv
    const last = e.argv[e.argv.length - 1] as string
    if (command === 'mv') {
      const from = e.argv[e.argv.length - 2] as string
      for (const [p, node] of [...files]) {
        if (p === from || p.startsWith(`${from}/`)) {
          files.delete(p)
          files.set(last + p.slice(from.length), node)
        }
      }
    } else if (command === 'mkdir') {
      files.set(last, { kind: 'dir' })
    } else if (command === 'cp') {
      files.set(last, { ...files.get(e.argv[e.argv.length - 2] as string)! })
    } else if (command === 'trash') {
      files.delete(last)
    }
    const value = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    if (command === 'find') {
      // `-iname` gets `*word*`, escaped; take the word back out.
      const pattern = String(e.argv[e.argv.indexOf('-iname') + 1] ?? '')
      const word = pattern.replace(/^\*/, '').replace(/\*$/, '').replace(/\\(.)/g, '$1')
      value.stdout = [...files.keys()].filter(p => p.includes(word)).join('\n')
    }
    if (command === 'git') {
      if (world.porcelain === null) return { value: { ...value, exitCode: 128, stderr: 'fatal: not a git repository' } }
      value.stdout = e.argv[3] === 'rev-parse' ? `${ROOT}\n` : world.porcelain
    }
    if (command === 'rg') {
      if (!world.hasRg) return { deny: "ENOENT: posix_spawn 'rg'" }
      const text = e.argv[e.argv.length - 2] ?? ''
      value.stdout = [...files].filter(([, node]) => node.text?.includes(text)).map(([p, node]) => `${p}:${node.text!.split('\n').findIndex(l => l.includes(text)) + 1}:${node.text!.split('\n').find(l => l.includes(text))}`).join('\n')
    }
    if (command === 'grep') {
      value.stdout = `${ROOT}/src/util.ts:1:export {}`
    }
    return { value }
  })
  on('ui.panes', async () => ({ value: [{ id: 'atlas', title: 'Atlas', isShown: true, isFocused: false, isPlaced: true }] }) as never)
  on('store.get', (_$, e) => ({ value: world.store.get(e.key) }))
  on('store.set', (_$, e) => {
    world.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, async (_$, e) => ({
    result: { questions: e.questions, answers: { [e.questions[0]!.question]: answer } },
  }) as never)
  on('process.spawn', async function* (_$, e) {
    world.spawned.push([...e.argv])
    const words = new Uint32Array(80 * 29 * 3).fill(0x20)
    const cells = new Uint8Array(words.buffer).toBase64()
    yield { stream: 'stdout' as const, text: `${JSON.stringify({ type: 'ready', socket: '/tmp/atlas-test/term.sock' })}\n` }
    yield { stream: 'stdout' as const, text: `${JSON.stringify({ type: 'cells', columns: 80, rows: 29, cells })}\n` }
    await editorRuns
    yield { stream: 'stdout' as const, text: `${JSON.stringify({ type: 'exit', code: 0 })}\n` }
    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', async (_$, e) => {
    const route = new URL(e.url).pathname
    world.calls.push({ route, body: JSON.parse(e.init?.body ?? '{}') })
    if (route === '/key' && JSON.parse(e.init?.body ?? '{}').key === 'q') release()
    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })
  mock.env(on, { HOME: '/home/me', TERM_PROGRAM: 'ghostty' })
  return world
}

async function start($: any) {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  return $.command.run({ command: 'atlas', args: '', ...RUN })
}

/** Lets work a handler left running settle: each read of the drawing is a round trip. */
async function until(ui: { find: (q: { type: 'Box' }) => Promise<unknown> }, isDone: () => boolean) {
  for (let i = 0; i < 200 && !isDone(); i++) await ui.find({ type: 'Box' })
  expect(isDone()).toBe(true)
}

describe('the explorer', () => {
  test('draws the tree, opens a folder and shows a file\'s properties and source', async ($, on) => {
    fakeWorld(on)
    expect((await start($)).text).toBe('Atlas opened on /work.')
    for (const surface of ['terminal', 'desktop'] as const) {
      for (const width of [60, 120]) {
        const ui = await $.ui.mount({ plugin: 'atlas', surface, ...pane(width) })
        expect((await ui.find({ key: `n:src` }))?.text).toBe('src/')
        expect(await ui.find({ key: `n:src/main.ts` })).toBeUndefined()

        await ui.press({ key: `n:src` })
        await ui.press({ key: `n:src/main.ts` })
        expect(await ui.find({ text: 'Script · TypeScript' })).toBeDefined()
        expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({ source: 'export const x = 1\n', path: `${ROOT}/src/main.ts` })

        await ui.press({ key: `n:src` }) // close it again for the next surface
        await ui.unmount()
      }
    }
  })

  test('refuses a rename onto a name that exists, and renames otherwise', async ($, on) => {
    const world = fakeWorld(on)
    await start($)
    const ui = await $.ui.mount({ plugin: 'atlas', surface: 'terminal', ...pane(80) })
    await ui.press({ key: `n:README.md` })

    await ui.press({ key: 'rename' })
    await ui.input({ key: 'name', text: 'src' })
    expect(await ui.find({ text: /src already exists/ })).toBeDefined()
    expect(world.runs.filter(r => r[0] === 'mv')).toEqual([])

    await ui.input({ key: 'name', text: '../escape' })
    expect(await ui.find({ text: /cannot contain/ })).toBeDefined()

    await ui.input({ key: 'name', text: 'NOTES.md' })
    expect(world.runs).toContainEqual(['mv', '-n', '--', `${ROOT}/README.md`, `${ROOT}/NOTES.md`])
    expect(await ui.find({ key: `n:NOTES.md` })).toBeDefined()
    await ui.unmount()
  })

  test('creates a file in the selected folder, and duplicates without overwriting', async ($, on) => {
    const world = fakeWorld(on)
    await start($)
    const ui = await $.ui.mount({ plugin: 'atlas', surface: 'terminal', ...pane(80) })
    await ui.press({ key: `n:src` })
    await ui.press({ key: 'new-file' })
    await ui.input({ key: 'name', text: 'new.ts' })
    expect(world.files.get(`${ROOT}/src/new.ts`)).toEqual({ kind: 'file', text: '' })

    await ui.press({ key: 'duplicate' })
    await ui.press({ key: `n:src/new.ts` })
    await ui.press({ key: 'duplicate' })
    expect(world.runs.filter(r => r[0] === 'cp').map(r => r[r.length - 1])).toEqual([
      `${ROOT}/src/new copy.ts`,
      `${ROOT}/src/new copy 2.ts`,
    ])
    await ui.unmount()
  })

  test('moves to the Trash only once confirmed', async ($, on) => {
    const world = fakeWorld(on, ['terminal'], 'Cancel')
    await start($)
    const ui = await $.ui.mount({ plugin: 'atlas', surface: 'terminal', ...pane(80) })
    await ui.press({ key: `n:README.md` })
    await ui.press({ key: 'trash' })
    expect(world.runs.filter(r => r[0] === 'trash')).toEqual([])
    expect(world.files.has(`${ROOT}/README.md`)).toBe(true)
    await ui.unmount()
  })

  test('moves to the Trash, never rm, when confirmed', async ($, on) => {
    const world = fakeWorld(on, ['terminal'], 'Move to Trash')
    await start($)
    const ui = await $.ui.mount({ plugin: 'atlas', surface: 'terminal', ...pane(80) })
    await ui.press({ key: `n:README.md` })
    await ui.press({ key: 'trash' })
    expect(world.runs.filter(r => r[0] === 'trash' || r[0] === 'rm')).toEqual([['trash', `${ROOT}/README.md`]])
    expect(await ui.find({ key: `n:README.md` })).toBeUndefined()
    await ui.unmount()
  })

  test('finds by name and reveals a hit in the tree', async ($, on) => {
    fakeWorld(on)
    await start($)
    const ui = await $.ui.mount({ plugin: 'atlas', surface: 'terminal', ...pane(80) })
    await ui.input({ key: 'find', text: 'util' })
    await ui.press({ key: 'r:src/util.ts' })
    expect(await ui.find({ key: `n:src/util.ts` })).toBeDefined()
    expect(await ui.find({ text: 'src/util.ts' })).toBeDefined()
    await ui.unmount()
  })
})

/**
 * What /clear does to a plugin: the session ends and a new one begins in the same process, so the
 * host's `$.state` reads as never written while the module and its pane live on. From the mark,
 * every read answers "never written" until the plugin writes that key again.
 */
function clearSession(on: On) {
  let isCleared = false
  const written = new Set<string>()
  // Through `next`, so the drawing that read the key is still redrawn when it is written.
  on('state.get', async (_$, e, next) => {
    const got = await next(e)
    return (isCleared && !written.has(e.key) ? { value: { value: undefined, version: 0 } } : got) as never
  })
  on('state.set', (_$, e, next) => {
    if (isCleared) written.add(e.key)
    return next(e)
  })
  return async ($: Engine) => {
    await ($ as any).session.end({ reason: 'clear', sessionId: 'before', resume: { id: 'before' } })
    isCleared = true
    written.clear()
  }
}

describe('after /clear', () => {
  test('the pane keeps its root, open folders and selection, and reading works again', async ($, on) => {
    const clear = clearSession(on)
    const clock = mock.clock(on)
    fakeWorld(on)
    on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
    await start($)
    const ui = await $.ui.mount({ plugin: 'atlas', surface: 'terminal', ...pane(120) })
    await ui.press({ key: 'n:src' })
    await ui.press({ key: 'n:src/main.ts' })
    await ui.unmount()

    await clear($)
    const after = await $.ui.mount({ plugin: 'atlas', surface: 'terminal', ...pane(120) })
    // Drawn from what the module kept: not an empty tree under an empty root.
    expect((await after.find({ key: 'n:src/main.ts' }))?.text).toBe('main.ts')
    expect(await after.find({ text: /^work$/ })).toBeDefined()
    expect(await after.find({ text: /Cannot read/ })).toBeUndefined()
    // The render asked for the host's state back; the timer it set writes it.
    await clock.advance(1)

    // Refresh lists the root again, never the empty path that /clear left behind.
    await after.press({ key: 'refresh' })
    expect(await after.find({ text: /Cannot read/ })).toBeUndefined()
    expect(await after.find({ key: 'n:README.md' })).toBeDefined()
    expect((await after.find({ type: 'Code' }))?.props).toMatchObject({ path: `${ROOT}/src/main.ts` })

    // And a change made after the clear builds on what was kept.
    await after.press({ key: 'n:src' })
    expect(await after.find({ key: 'n:src/main.ts' })).toBeUndefined()
    await after.press({ key: 'n:src' })
    expect(await after.find({ key: 'n:src/main.ts' })).toBeDefined()
    await after.unmount()
  })

  test('the editor stays open through a clear, and /atlas finds the same root', async ($, on) => {
    const clear = clearSession(on)
    const world = fakeWorld(on)
    on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
    await start($)
    const ui = await $.ui.mount({ plugin: 'atlas', surface: 'terminal', ...pane(80) })
    await ui.press({ key: 'n:README.md' })
    await ui.press({ key: 'edit' })
    await until(ui, () => world.spawned.length > 0)
    await ui.unmount()

    await clear($)
    const after = await $.ui.mount({ plugin: 'atlas', surface: 'terminal', ...pane(80) })
    expect(await after.find({ type: 'Raster', key: 'editor' })).toBeDefined()
    await after.key({ key: 'x' })
    expect(world.calls.at(-1)).toEqual({ route: '/key', body: { kind: 'key', key: 'x' } })
    await after.unmount()

    expect((await $.command.run({ command: 'atlas', args: '', ...RUN })).text).toBe('Atlas opened on /work.')
    expect(world.spawned.length).toBe(1)
  })
})

describe('what disk can hold', () => {
  test('many huge open folders and hostile names still draw', async ($, on) => {
    const world = fakeWorld(on)
    const bigs = Array.from({ length: 6 }, (_, n) => `node_modules-with-a-long-folder-name-${n}`)
    for (const dir of bigs) {
      world.files.set(`${ROOT}/${dir}`, { kind: 'dir' })
      for (let i = 0; i < 2000; i++) world.files.set(`${ROOT}/${dir}/package-with-a-rather-long-name-number-${i}`, { kind: 'dir' })
    }
    const evil = 'evil\x1b[31mname\nline'
    world.files.set(`${ROOT}/${evil}`, { kind: 'file', text: 'bad \u0085 next \x1b[2J clear\r\n' })
    await start($)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'atlas', surface, ...pane(80) })
      await ui.press({ key: `n:${evil}` })
      await ui.drawn() // rejects when the surface refuses the tree
      expect(await ui.find({ type: 'Code' })).toBeDefined()
      // Bottom up, so each folder's row is still drawn above the ones open.
      for (const dir of [...bigs].reverse()) await ui.press({ key: `n:${dir}` })
      await ui.drawn()
      expect(await ui.find({ text: /close some folders/ })).toBeDefined()
      for (const dir of bigs) await ui.press({ key: `n:${dir}` })
      await ui.unmount()
    }
  })
})

describe('the editor', () => {
  test('runs micro in the pane, forwards keys, and returns to the files when it quits', async ($, on) => {
    const world = fakeWorld(on)
    await start($)
    const ui = await $.ui.mount({ plugin: 'atlas', surface: 'terminal', ...pane(80) })
    await ui.press({ key: `n:src` })
    await ui.press({ key: `n:src/main.ts` })
    await ui.press({ key: 'edit' })
    await until(ui, () => world.calls.some(c => c.route === '/resize') || world.spawned.length > 0)
    expect(world.spawned[0]?.slice(1)).toEqual([
      expect.stringMatching(/\/editor\/term\.py$/), '80', '29', 'micro', `${ROOT}/src/main.ts`,
    ])
    expect((await ui.find({ type: 'Raster', key: 'editor' }))?.props).toMatchObject({ columns: 80, rows: 29 })

    await ui.key({ key: 's', ctrl: true })
    expect(world.calls.at(-1)).toEqual({ route: '/key', body: { kind: 'key', key: 's', ctrl: true } })
    await ui.press({ key: 'undo' })
    expect(world.calls.at(-1)).toEqual({ route: '/text', body: { text: '\x1a' } })

    await ui.key({ key: 'q' })
    await until(ui, () => world.calls.length > 0)
    let isBack = false
    for (let i = 0; i < 200 && !isBack; i++) isBack = (await ui.find({ key: `n:src/main.ts` })) !== undefined
    expect(isBack).toBe(true)
    await ui.unmount()
  })

  test('outside the terminal the explorer works and editing says why it cannot', async ($, on) => {
    const world = fakeWorld(on, ['desktop'])
    await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
    await $.command.run({ command: 'atlas', args: '', ...RUN })
    const ui = await $.ui.mount({ plugin: 'atlas', surface: 'desktop', ...pane(80) })
    await ui.press({ key: `n:README.md` })
    await ui.press({ key: 'edit' })
    expect(await ui.find({ text: /runs in Claude Code's terminal/ })).toBeDefined()
    expect(world.spawned).toEqual([])
    await ui.unmount()

    for (const surface of ['vscode', 'mobile'] as const) {
      const other = await $.ui.mount({ plugin: 'atlas', surface, ...pane(60) })
      await other.press({ key: `n:src` })
      expect(await other.find({ key: `n:src/main.ts` })).toBeDefined()
      expect((await other.find({ key: 'rename' })) !== undefined).toBe(surface === 'vscode')
      await other.press({ key: `n:src` })
      await other.unmount()
    }
  })
})

describe('what git and the folder say', () => {
  test('marks changed and untracked files, and folders holding them', async ($, on) => {
    fakeWorld(on)
    await start($)
    const ui = await $.ui.mount({ plugin: 'atlas', surface: 'terminal', ...pane(120) })
    expect(await ui.find({ text: '1 changed' })).toBeUndefined()
    expect(await ui.find({ text: '2 changed' })).toBeDefined()
    // src holds a modified file: a dot; the file itself shows M once src is open.
    expect(await ui.find({ text: ' •' })).toBeDefined()
    await ui.press({ key: 'n:src' })
    expect(await ui.find({ text: ' M' })).toBeDefined()
    await ui.press({ key: 'n:src/main.ts' })
    expect(await ui.find({ text: 'modified' })).toBeDefined()
    await ui.unmount()
  })

  test('the watcher asks git where the repository is once, and status on every tick', async ($, on) => {
    const clock = mock.clock(on)
    const world = fakeWorld(on)
    await start($)
    const ui = await $.ui.mount({ plugin: 'atlas', surface: 'terminal', ...pane(120) })
    const git = (verb: string) => world.runs.filter(r => r[0] === 'git' && r[3] === verb).length
    const before = git('status')
    await clock.advance(4000)
    await clock.advance(4000)
    expect(git('status')).toBeGreaterThan(before) // the watcher is looking
    expect(git('rev-parse')).toBe(1)
    await ui.unmount()
  })

  test('outside a repository nothing is marked', async ($, on) => {
    const world = fakeWorld(on)
    world.porcelain = null
    await start($)
    const ui = await $.ui.mount({ plugin: 'atlas', surface: 'terminal', ...pane(120) })
    expect(await ui.find({ text: /changed$/ })).toBeUndefined()
    expect(await ui.find({ text: ' •' })).toBeUndefined()
    await ui.unmount()
  })

  test('dotfiles stay out of the tree until asked for, and the choice is kept', async ($, on) => {
    const world = fakeWorld(on)
    await start($)
    const ui = await $.ui.mount({ plugin: 'atlas', surface: 'terminal', ...pane(80) })
    expect(await ui.find({ key: 'n:.env' })).toBeUndefined()
    expect((await ui.find({ key: 'hidden' }))?.text).toBe('Show dotfiles (1)')
    await ui.press({ key: 'hidden' })
    expect(await ui.find({ key: 'n:.env' })).toBeDefined()
    expect(world.store.get('showHidden')).toBe(true)
    await ui.press({ key: 'hidden' })
    expect(await ui.find({ key: 'n:.env' })).toBeUndefined()
    await ui.unmount()
  })

  test('the path is a trail of folders, each a step back up', async ($, on) => {
    fakeWorld(on)
    await start($)
    const ui = await $.ui.mount({ plugin: 'atlas', surface: 'terminal', ...pane(80) })
    await ui.press({ key: 'n:src' })
    await ui.press({ key: 'open' })
    expect(await ui.find({ key: 'n:main.ts' })).toBeDefined()
    expect(await ui.find({ key: 'crumb:/work' })).toBeDefined()
    await ui.press({ key: 'crumb:/work' })
    expect(await ui.find({ key: 'n:src' })).toBeDefined()
    await ui.unmount()
  })

  test('a markdown file previews rendered; a search by text lands on the line', async ($, on) => {
    fakeWorld(on)
    await start($)
    const ui = await $.ui.mount({ plugin: 'atlas', surface: 'terminal', ...pane(80) })
    await ui.press({ key: 'n:README.md' })
    expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe('# Demo\n')
    expect(await ui.find({ text: 'Preview' })).toBeDefined()

    await ui.press({ key: 'mode-text' })
    await ui.input({ key: 'find', text: 'const x' })
    expect(await ui.find({ key: 'r:src/main.ts:1' })).toBeDefined()
    expect(await ui.find({ text: /export const x = 1/ })).toBeDefined()
    await ui.press({ key: 'r:src/main.ts:1' })
    expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({ source: 'export const x = 1\n', startLine: 1 })
    await ui.unmount()
  })

  test('a picture previews when its modified time has a fraction of a millisecond', async ($, on) => {
    const world = fakeWorld(on)
    world.files.set(`${ROOT}/shot.png`, { kind: 'file', text: 'png', mtimeMs: 1790921112850.018 })
    await start($)
    const ui = await $.ui.mount({ plugin: 'atlas', surface: 'terminal', ...pane(80) })
    await ui.press({ key: 'n:shot.png' })
    expect((await ui.find({ type: 'Image' }))?.props.source).toMatchObject({ file: `${ROOT}/shot.png`, generation: 1790921112850 })
    await ui.unmount()
  })

  test('without ripgrep, grep searches instead', async ($, on) => {
    const world = fakeWorld(on)
    world.hasRg = false
    await start($)
    const ui = await $.ui.mount({ plugin: 'atlas', surface: 'terminal', ...pane(80) })
    await ui.press({ key: 'mode-text' })
    await ui.input({ key: 'find', text: 'export' })
    expect(world.runs.some(r => r[0] === 'grep')).toBe(true)
    expect(await ui.find({ key: 'r:src/util.ts:1' })).toBeDefined()
    await ui.unmount()
  })

  test('/atlas returns to the folder left open last time, folders and all', async ($, on) => {
    const world = fakeWorld(on)
    world.store.set(`root:${ROOT}`, { root: `${ROOT}/src`, expanded: [] })
    expect((await start($)).text).toBe('Atlas opened on /work/src.')
    const ui = await $.ui.mount({ plugin: 'atlas', surface: 'terminal', ...pane(80) })
    expect(await ui.find({ key: 'n:main.ts' })).toBeDefined()
    await ui.press({ key: 'crumb:/work' })
    await ui.press({ key: 'n:src' })
    expect(world.store.get(`root:${ROOT}`)).toEqual({ root: ROOT, expanded: [`${ROOT}/src`] })
    await ui.unmount()
  })
})

describe('the helpers', () => {
  test('reads git status, grep output and a path\'s trail', () => {
    const marks = parseGitStatus(' M a.ts\0?? new/\0A  b.ts\0R  c.ts\0old.ts\0 D gone.ts\0', '/r')
    expect(marks).toEqual({ '/r/a.ts': 'M', '/r/new': '?', '/r/b.ts': 'A', '/r/c.ts': 'R', '/r/gone.ts': 'D' })
    expect(folderMark('/r/new', marks)).toBe('?')
    expect(folderMark('/r', marks)).toBe('M')
    expect(folderMark('/r/other', marks)).toBeNull()
    expect(parseGrep('/r/a.ts:12:  hello\nnot a hit\n/r/b.ts:3:x\u001b[31m', 10)).toEqual([
      { path: '/r/a.ts', line: 12, text: 'hello' },
      { path: '/r/b.ts', line: 3, text: 'x?[31m' },
    ])
    expect(crumbs('/home/me/work/src', '/home/me').map(c => c.label)).toEqual(['~', 'work', 'src'])
    expect(crumbs('/etc/nginx', '/home/me').map(c => c.path)).toEqual(['/', '/etc', '/etc/nginx'])
  })

  test('names, copies, paths and classes', () => {
    expect(nameProblem('ok.txt')).toBeNull()
    expect(nameProblem('a/b')).not.toBeNull()
    expect(nameProblem('..')).not.toBeNull()
    expect(nameProblem('  ')).not.toBeNull()
    expect(copyName('a.txt', 1)).toBe('a copy.txt')
    expect(copyName('a.txt', 3)).toBe('a copy 3.txt')
    expect(copyName('.env', 1)).toBe('.env copy')
    expect(relative('/work/src/a.ts', '/work')).toBe('src/a.ts')
    expect(relative('/elsewhere/a.ts', '/work')).toBe('/elsewhere/a.ts')
    expect(relative('/workshop/a.ts', '/work')).toBe('/workshop/a.ts')
    expect(foldersBetween('/work', '/work/a/b/c.ts')).toEqual(['/work/a', '/work/a/b'])
    expect(literalPattern('a*b[1]')).toBe('*a\\*b\\[1\\]*')
    expect(classOf('x.py', 'file', false).name).toBe('Script · Python')
    expect(classOf('src', 'dir', false).name).toBe('Folder')
  })

  test('flattens open folders beneath their parent and caps long ones', () => {
    const entry = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })
    const listings = {
      '/r': [entry('a', 'dir'), entry('b.txt', 'file')],
      '/r/a': [entry('x', 'file'), entry('y', 'file'), entry('z', 'file')],
    }
    const shape = (limits: { perFolder: number; rows: number; characters: number }) =>
      rows('/r', listings, ['/r/a'], limits).map(r =>
        r.type === 'entry' ? `${r.depth}:${r.entry.name}` : r.type === 'more' ? `${r.depth}:+${r.hidden}` : 'cut')
    expect(shape({ perFolder: 2, rows: 100, characters: 1000 })).toEqual(['0:a', '1:x', '1:y', '1:+1', '0:b.txt'])
    expect(shape({ perFolder: 9, rows: 3, characters: 1000 })).toEqual(['0:a', '1:x', '1:y', 'cut'])
  })

  test('the mark index a drawing uses answers exactly as asking each folder did', () => {
    // The index is a rewrite of folderMark for speed, so it has to agree with it
    // for every folder a tree could draw: over random trees, every mark, and the
    // root at '/' as well as below it.
    const KINDS = ['M', 'A', '?', 'D', 'R'] as const
    let seed = 987654321
    const at = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n
    const parent = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/'
    for (let round = 0; round < 4000; round += 1) {
      const base = at(6) === 0 ? '/' : `/r${at(3)}`
      const marks: Record<string, (typeof KINDS)[number]> = {}
      for (let i = 0; i < at(7); i += 1) {
        let path = base === '/' ? '' : base
        for (let depth = 1 + at(4); depth > 0; depth -= 1) path += `/x${at(3)}`
        marks[`${path}${at(2) === 0 ? '' : '.ts'}`] = KINDS[at(KINDS.length)]!
      }
      const index = indexMarks(marks, base)
      // Every folder a tree under `base` could draw, the root included.
      const drawn = new Set<string>([base])
      for (const path of Object.keys(marks)) {
        for (let dir = parent(path); ; dir = parent(dir)) {
          if (dir === base || dir.startsWith(base === '/' ? '/' : `${base}/`)) drawn.add(dir)
          if (dir === '/') break
        }
      }
      for (const dir of drawn) {
        expect({ dir, mark: markFor(index, dir) }).toEqual({ dir, mark: folderMark(dir, marks) })
      }
    }
  })

  test('a change or a deletion beneath a folder wins over anything found first', () => {
    // The two orderings that matter: an added file listed before a modified one,
    // and a renamed one before a deleted one.
    expect(markFor(indexMarks({ '/r/a/new': 'A', '/r/b/gone': 'D' }, '/r'), '/r')).toBe('M')
    expect(markFor(indexMarks({ '/r/a/moved': 'R', '/r/b/gone': 'D' }, '/r'), '/r')).toBe('M')
    expect(markFor(indexMarks({ '/r/a/new': 'A' }, '/r'), '/r')).toBe('A')
    expect(markFor(indexMarks({ '/r/deep/inside/new': '?' }, '/r'), '/r')).toBe('?')
    // A mark on the root's own path still shows on the root.
    expect(markFor(indexMarks({ '/': 'A' }, '/'), '/')).toBe('A')
    expect(markFor(indexMarks({ '/r': 'M' }, '/r'), '/r')).toBe('M')
    // A folder holding nothing marked shows nothing, whatever lies outside it.
    expect(markFor(indexMarks({ '/elsewhere/a': 'M' }, '/r'), '/r')).toBeNull()
    expect(markFor(indexMarks({ '/r/a/x': 'M' }, '/r'), '/r/other')).toBeNull()
  })

  test('tells a changed listing from the same one without building strings', () => {
    const entry = (name: string, over: Partial<Entry> = {}): Entry =>
      ({ name, kind: 'file', size: 1, mtimeMs: 2, isLink: false, ...over })
    expect(sameEntries([entry('a')], [entry('a')])).toBe(true)
    expect(sameEntries([], [])).toBe(true)
    expect(sameEntries([entry('a')], [entry('b')])).toBe(false)
    expect(sameEntries([entry('a')], [entry('a'), entry('b')])).toBe(false)
    expect(sameEntries([entry('a'), entry('b')], [entry('a')])).toBe(false)
    // A file rewritten in place keeps its name and so must not read as unchanged.
    expect(sameEntries([entry('a', { size: 1 })], [entry('a', { size: 2 })])).toBe(false)
    expect(sameEntries([entry('a', { mtimeMs: 2 })], [entry('a', { mtimeMs: 3 })])).toBe(false)
    expect(sameEntries([entry('a', { isLink: false })], [entry('a', { isLink: true })])).toBe(false)
    expect(sameEntries([entry('a', { kind: 'file' })], [entry('a', { kind: 'dir' })])).toBe(false)
  })

  test('tells new git marks from the same ones, in either order', () => {
    expect(sameMarks({}, {})).toBe(true)
    expect(sameMarks({ '/r/a': 'M' }, { '/r/a': 'M' })).toBe(true)
    expect(sameMarks({ '/r/a': 'M', '/r/b': '?' }, { '/r/b': '?', '/r/a': 'M' })).toBe(true)
    expect(sameMarks({ '/r/a': 'M' }, {})).toBe(false)
    expect(sameMarks({}, { '/r/a': 'M' })).toBe(false)
    expect(sameMarks({ '/r/a': 'M' }, { '/r/a': 'A' })).toBe(false)
    expect(sameMarks({ '/r/a': 'M' }, { '/r/b': 'M' })).toBe(false)
  })
})
