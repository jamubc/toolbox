import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { guardRun } from '../hooks/providers/chat'
import { attributedText } from '../hooks/providers/imessage'

// Invented data only: 555-01xx numbers are reserved for fiction.
const ANA = '+15555550101'
const PANE_PROPS = {
  title: 'iMessage',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}
const SURFACES = ['terminal', 'desktop'] as const
// 2026-01-01 in Apple's nanoseconds since 2001.
const DATE = (1_767_225_600_000 - 978_307_200_000) * 1e6

// An archived NSAttributedString as Messages writes it, holding `text`.
function streamtyped(text: string): string {
  const utf8 = [...new TextEncoder().encode(text)]
  const length = utf8.length < 0x80 ? [utf8.length] : [0x81, utf8.length & 0xff, utf8.length >> 8]
  const bytes = [
    0x04, 0x0b, ...new TextEncoder().encode('streamtyped'), 0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84,
    0x12, ...new TextEncoder().encode('NSAttributedString'), 0x00, 0x84, 0x84, 0x08,
    ...new TextEncoder().encode('NSObject'), 0x00, 0x85, 0x92, 0x84, 0x84, 0x84, 0x08,
    ...new TextEncoder().encode('NSString'), 0x01, 0x94, 0x84, 0x01, 0x2b, ...length, ...utf8, 0x86,
  ]
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase()
}

type Row = { id: number; conversation: number; date: number; fromMe: number; handle: string | null; text: string | null; body: string | null; attachments: number }

function row(id: number, conversation: number, fields: Partial<Row>): Row {
  return { id, conversation, date: DATE, fromMe: 0, handle: ANA, text: null, body: null, attachments: 0, ...fields }
}

// A fake Messages database and Messages app beneath the plugin.
function mac(on: On) {
  const clock = mock.clock(on, { now: 1_767_225_600_000 })
  mock.env(on, { HOME: '/Users/someone' })
  const runs: (readonly string[])[] = []
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const rows: Row[] = [
    row(10, 1, { body: streamtyped('see you at six') }),
    row(11, 1, { fromMe: 1, handle: null, text: 'on my way' }),
    row(12, 2, { handle: '+15555550102', text: null, attachments: 1, body: streamtyped('￼') }),
  ]
  const chats = [
    { id: 1, guid: `any;-;${ANA}`, name: null, people: ANA, ident: ANA },
    { id: 2, guid: 'any;+;chat000000000000000001', name: 'Book club', people: '+15555550102, +15555550103', ident: 'chat000000000000000001' },
  ]
  let access = true
  let panes: { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }[] = []
  const json = (value: unknown[]) => ({ value: { exitCode: 0, stdout: value.length ? JSON.stringify(value) : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

  on('process.run', (_$, e) => {
    runs.push(e.argv)
    if (e.argv[0] === '/usr/bin/osascript') {
      return json([])
    }
    if (!access) {
      return { value: { exitCode: 1, stdout: '', stderr: 'Error: unable to open database "/Users/someone/Library/Messages/chat.db": authorization denied', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const sql = e.argv[4] ?? ''
    if (sql.includes('MAX(ROWID) id FROM message')) {
      return json([{ id: Math.max(...rows.map(one => one.id)) }])
    }
    if (sql.includes('GROUP BY c.ROWID')) {
      return json(chats)
    }
    const inChat = /cmj\.chat_id = (\d+)/.exec(sql)
    if (inChat) {
      return json(rows.filter(one => one.conversation === Number(inChat[1])).reverse())
    }
    const after = /m\.ROWID > (\d+)/.exec(sql)
    if (after) {
      return json(rows.filter(one => one.id > Number(after[1])))
    }
    return json([])
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: panes }))
  on('ui.open', (_$, e) => {
    panes = [{ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: true }]
    return { value: { isPlaced: true as const } }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  return {
    clock,
    runs,
    toasts,
    statuses,
    receive: (one: Row) => rows.push(one),
    revokeAccess: () => (access = false),
  }
}

async function start($: Engine) {
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
}

async function openPane($: Engine) {
  await $.command.run({ command: 'backchannel', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
}

test('attributedBody text decodes, short and long', () => {
  expect(attributedText(streamtyped('hi there'))).toBe('hi there')
  const long = 'é'.repeat(200)
  expect(attributedText(streamtyped(long))).toBe(long)
  expect(attributedText('00FF')).toBe(null)
})

test('the pane lists conversations, and a press opens one with its history', async ($, on) => {
  const m = mac(on)
  await start($)
  await m.clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'backchannel', surface, component: 'Pane', props: PANE_PROPS, requestId: 'backchannel' })
    expect((await ui.find({ key: 'open-2' }))?.text).toBe('Book club')
    expect(await ui.find({ type: 'Button', text: /Book club/ })).toBeDefined()
    await ui.press({ key: 'open-1' })
    expect(await ui.find({ text: /see you at six/ })).toBeDefined()
    expect(await ui.find({ text: /on my way/ })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.press({ key: 'open-2' })
    expect(await ui.find({ text: /\[attachment\]/ })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
  // Read-only, and never through a shell.
  for (const argv of m.runs) {
    expect(argv.slice(0, 3)).toEqual(['/usr/bin/sqlite3', '-readonly', '-json'])
  }
})

test('a new message while the pane is closed toasts and counts; my own does not', async ($, on) => {
  const m = mac(on)
  await start($)
  await m.clock.settle()
  expect(m.toasts).toEqual([])

  m.receive(row(13, 2, { handle: '+15555550103', text: 'chapter 4 tonight?' }))
  m.receive(row(14, 1, { fromMe: 1, handle: null, text: 'sent from my phone' }))
  await m.clock.advance(10_000)

  expect(m.toasts).toEqual(['Book club · +15555550103: chapter 4 tonight?'])
  expect(m.statuses.at(-1)).toBe('iMessage 1 new')
})

test('Enter sends through Messages with the text as an argument, never in the script', async ($, on) => {
  const m = mac(on)
  await start($)
  await m.clock.settle()
  await openPane($)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'backchannel', surface, component: 'Pane', props: PANE_PROPS, requestId: 'backchannel' })
    await ui.press({ key: 'open-1' })
    await ui.input({ key: 'reply', text: '  ' })
    await ui.input({ key: 'reply', text: '-e "quoted" & end tell' })
    expect((await ui.find({ key: 'reply' }))?.text).toBe('')
    expect(await ui.find({ text: 'Sent.' })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.unmount()
  }

  const sends = m.runs.filter(argv => argv[0] === '/usr/bin/osascript')
  expect(sends.length).toBe(2)
  expect(sends[0]?.slice(-2)).toEqual(['x-e "quoted" & end tell', `any;-;${ANA}`])
  expect(sends[0]?.join(' ')).not.toContain('quoted" & end tell" to')
})

test('without Full Disk Access the pane says how to grant it', async ($, on) => {
  const m = mac(on)
  m.revokeAccess()
  await start($)
  await m.clock.settle()

  const ui = await $.ui.mount({ plugin: 'backchannel', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'backchannel' })
  expect(await ui.find({ text: /Full Disk Access/ })).toBeDefined()
})

test('a provider runs only its own commands', async () => {
  const run = async () => ({ exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  await expect(guardRun(run, ['/usr/bin/sqlite3'])(['/bin/sh', '-c', 'x'])).rejects.toThrow('refused')
  await expect(guardRun(run, [])(['/usr/bin/sqlite3'])).rejects.toThrow('refused')
  expect((await guardRun(run, ['/usr/bin/sqlite3'])(['/usr/bin/sqlite3'])).exitCode).toBe(0)
})
