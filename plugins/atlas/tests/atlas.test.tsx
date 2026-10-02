import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { classOf, copyName, foldersBetween, literalPattern, nameProblem, relative, rows } from '../hooks/files'

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

type Node = { kind: 'file' | 'dir'; text?: string }
type World = { files: Map<string, Node>; runs: string[][]; calls: { route: string; body: any }[]; spawned: string[][] }

/** Stands in for the engine: a file tree in memory, the commands atlas runs, and an editor host. */
function fakeWorld(on: On, surfaces: string[] = ['terminal'], answer = 'Cancel'): World {
  const files = new Map<string, Node>([
    [ROOT, { kind: 'dir' }],
    [`${ROOT}/src`, { kind: 'dir' }],
    [`${ROOT}/src/main.ts`, { kind: 'file', text: 'export const x = 1\n' }],
    [`${ROOT}/src/util.ts`, { kind: 'file', text: 'export {}\n' }],
    [`${ROOT}/README.md`, { kind: 'file', text: '# Demo\n' }],
  ])
  const world: World = { files, runs: [], calls: [], spawned: [] }
  const childrenOf = (dir: string) => [...files.keys()].filter(p => p !== dir && p.slice(0, p.lastIndexOf('/')) === dir)
  const stat = (path: string) => {
    const node = files.get(path)
    if (!node) throw new Error(`ENOENT: ${path}`)
    return { kind: node.kind, size: node.text?.length ?? 0, mtimeMs: 0, isLink: false, realPath: path }
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
    if (command === 'find') value.stdout = [...files.keys()].filter(p => p.includes('util')).join('\n')
    return { value }
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
  mock.env(on, { HOME: '/home/me' })
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

describe('the helpers', () => {
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
})
