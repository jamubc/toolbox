import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

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

/** Stands in for `instantnotes mcp`, answering by tool name; records calls. */
function fakeServer(on: On, calls: { name: string; args: any; argv: readonly string[] }[]) {
  on('process.run', async (_$, e) => {
    const request = JSON.parse(e.init?.stdin ?? '{}')
    const { name, arguments: args } = request.params
    calls.push({ name, args, argv: e.argv })
    const answers: Record<string, unknown> = {
      search_notes: { results: [{ id: NOTE.id, title: NOTE.title, excerpt: 'Latest release', spaces: NOTE.spaces }] },
      list_notes: { notes: [] },
      get_note: NOTE,
      create_note: { ...NOTE, id: 'n2', title: 'Buy milk' },
    }
    const result = { content: [], isError: false, structuredContent: answers[name] }
    return {
      value: {
        exitCode: 0,
        stdout: `${JSON.stringify({ jsonrpc: '2.0', id: 1, result })}\n`,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('command.register', async () => ({ value: undefined }) as never)
  on('ui.open', async () => ({ value: { isOpen: true } }) as never)
  on('ui.toast', async () => ({ value: undefined }))
  on('prompt.fill', async () => ({ value: { isFilled: true } }) as never)
}

test('searches, opens a note and draws it as markdown', { options: { db: '/tmp/lib.db' } }, async ($, on) => {
  const calls: { name: string; args: any; argv: readonly string[] }[] = []
  fakeServer(on, calls)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'instantnotes', surface, ...PANE })
    await ui.input({ key: 'query', text: 'CachyOS/Arch' })
    expect((await ui.find({ key: `hit-${NOTE.id}` }))?.text).toContain(NOTE.title)

    await ui.press({ key: `hit-${NOTE.id}` })
    expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe(NOTE.body)
    expect((await ui.find({ text: /Spaces: Instant Notes/ }))).toBeDefined()

    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
    await ui.unmount()
  }

  const search = calls.find(c => c.name === 'search_notes')
  expect(search?.args).toEqual({ query: 'CachyOS/Arch', limit: 15 })
  expect(search?.argv).toEqual(['instantnotes', 'mcp', '--db', '/tmp/lib.db', '--attachments', '/tmp/attachments'])
})

test('/note captures text as a new note', { options: { db: '/tmp/lib.db' } }, async ($, on) => {
  const calls: { name: string; args: any; argv: readonly string[] }[] = []
  fakeServer(on, calls)

  const ran = await $.command.run({
    command: 'note',
    args: 'Buy milk',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  expect(ran.text).toBe('Saved note "Buy milk".')
  expect(calls.map(c => c.name)).toEqual(['create_note'])
  expect(calls[0]?.args).toEqual({ body: 'Buy milk' })
})
