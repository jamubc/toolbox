import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

// A fake Messages database and Messages app. Invented data only: 555-01xx
// numbers are reserved for fiction.

export const ANA = '+15555550101'
export const BEN = '+15555550102'
// 2026-01-01 in Apple's nanoseconds since 2001.
export const DATE = (1_767_225_600_000 - 978_307_200_000) * 1e6
export const PNG = '~/Library/Messages/Attachments/aa/01/photo.png'

// An archived NSAttributedString as Messages writes it, holding `text`.
export function streamtyped(text: string): string {
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

export type Row = {
  id: number
  guid: string
  conversation: number
  date: number
  fromMe: number
  handle: string | null
  text: string | null
  body: string | null
  replyTo: string | null
  edited: string | null
  retracted: string | null
  files: string | null
}

export type Tap = { id: number; conversation: number; target: string; type: number; fromMe: number; who: number | null }

export function guidOf(id: number): string {
  return `00000000-0000-0000-0000-${String(id).padStart(12, '0')}`
}

export function row(id: number, conversation: number, fields: Partial<Row>): Row {
  return {
    id,
    guid: guidOf(id),
    conversation,
    date: DATE + id * 1e9,
    fromMe: 0,
    handle: ANA,
    text: null,
    body: null,
    replyTo: null,
    edited: '0',
    retracted: '0',
    files: '[]',
    ...fields,
  }
}

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const json = (value: unknown[]) => ok(value.length > 0 ? JSON.stringify(value) : '')
const bigger = (a: string | null, than: string) => BigInt(a ?? '0') > BigInt(than)

// A 2 by 2 picture as `sips` writes one: 24-bit, top-down. Red, green on the
// first row; blue, white on the second.
export function bmp(): Uint8Array {
  const bytes = new Uint8Array(54 + 16)
  const view = new DataView(bytes.buffer)
  bytes.set([0x42, 0x4d])
  view.setUint32(10, 54, true)
  view.setUint32(14, 40, true)
  view.setInt32(18, 2, true)
  view.setInt32(22, -2, true)
  view.setUint16(26, 1, true)
  view.setUint16(28, 24, true)
  // Rows are padded to 4 bytes; pixels are blue, green, red.
  bytes.set([0, 0, 255, 0, 255, 0, 0, 0], 54)
  bytes.set([255, 0, 0, 255, 255, 255, 0, 0], 62)

  return bytes
}

export function messagesApp() {
  const rows: Row[] = [
    row(10, 1, { body: streamtyped('see you at six') }),
    row(11, 1, { fromMe: 1, handle: null, text: 'on my way', replyTo: guidOf(10) }),
    row(12, 2, {
      handle: BEN,
      body: streamtyped('￼'),
      files: JSON.stringify([{ id: 7, name: 'photo.png', mime: 'image/png', bytes: 2048, path: PNG }]),
    }),
  ]
  const taps: Tap[] = [{ id: 13, conversation: 1, target: `p:0/${guidOf(10)}`, type: 2001, fromMe: 1, who: null }]
  const chats = [
    { id: 1, guid: `any;-;${ANA}`, name: null, people: ANA, ident: ANA },
    { id: 2, guid: 'any;+;chat000000000000000001', name: 'Book club', people: `${BEN}, +15555550103`, ident: 'chat000000000000000001' },
  ]
  const runs: (readonly string[])[] = []
  let hasAccess = true

  // What sqlite3, osascript and open would answer.
  function answer(argv: readonly string[]) {
    runs.push(argv)
    if (argv[0] === '/usr/bin/sips' && argv[1] === '-g') {
      return ok('  pixelWidth: 4032\n  pixelHeight: 3024\n')
    }
    if (argv[0] !== '/usr/bin/sqlite3') {
      return ok('')
    }
    if (!hasAccess) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'Error: unable to open database "/Users/someone/Library/Messages/chat.db": authorization denied',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      }
    }
    const sql = argv[4] ?? ''
    const number = (pattern: RegExp) => pattern.exec(sql)?.[1]
    switch (/\/\* channel:(\w+) \*\//.exec(sql)?.[1]) {
      case 'conversations':
        return json(
          chats
            .map(chat => ({ ...chat, last: Math.max(...rows.filter(one => one.conversation === chat.id).map(one => one.id)) }))
            .sort((a, b) => b.last - a.last)
            .map(({ last, ...chat }) => ({ ...chat, date: rows.find(one => one.id === last)?.date ?? DATE })),
        )
      case 'top': {
        let stamp = '0'
        for (const one of rows) {
          for (const mark of [one.edited ?? '0', one.retracted ?? '0']) {
            stamp = bigger(mark, stamp) ? mark : stamp
          }
        }
        return json([{ id: Math.max(...rows.map(one => one.id), ...taps.map(one => one.id)), stamp }])
      }
      case 'history': {
        const before = number(/m\.ROWID < (\d+)/)
        return json(
          rows
            .filter(one => one.conversation === Number(number(/cmj\.chat_id = (\d+)/)) && (!before || one.id < Number(before)))
            .reverse(),
        )
      }
      case 'after':
        return json(rows.filter(one => one.id > Number(number(/m\.ROWID > (\d+)/))))
      case 'changed': {
        const since = number(/m\.date_edited > (\d+)/) ?? '0'
        return json(rows.filter(one => bigger(one.edited, since) || bigger(one.retracted, since)))
      }
      case 'taps': {
        const after = number(/r\.ROWID > (\d+)/)
        const within = number(/cmj\.chat_id IN \(([\d, ]+)\)/)?.split(', ').map(Number)
        return json(taps.filter(one => (!after || one.id > Number(after)) && (!within || within.includes(one.conversation))))
      }
      case 'ids':
        return json(rows.filter(one => sql.includes(`'${one.guid}'`)).map(one => ({ id: one.id, guid: one.guid })))
      case 'members': {
        const chat = chats.find(one => one.id === Number(number(/chj\.chat_id = (\d+)/)))
        return json((chat?.people ?? '').split(', ').map(id => ({ id })))
      }
      case 'attachment':
        return json(number(/ROWID = (\d+)/) === '7' ? [{ path: PNG }] : [])
      case 'guid':
        return json(chats.filter(one => one.id === Number(number(/ROWID = (\d+)/))).map(one => ({ guid: one.guid })))
      default:
        return json([])
    }
  }

  return {
    answer,
    runs,
    rows,
    receive: (one: Row) => void rows.push(one),
    tap: (one: Tap) => void taps.push(one),
    revokeAccess: () => void (hasAccess = false),
  }
}

// The same Mac beneath the whole mod: its processes, clock, store and screen.
export function mac(on: On) {
  const app = messagesApp()
  const clock = mock.clock(on, { now: 1_767_225_600_000 })
  mock.env(on, { HOME: '/Users/someone', TERM_PROGRAM: 'ghostty' })
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const store = new Map<string, unknown>()
  let panes: { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }[] = []

  on('process.run', (_$, e) => ({ value: app.answer(e.argv) }))
  on('fs.read', () => ({ value: { base64: bmp().toBase64() } }))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'session-one' }))
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
  const prompt: string[] = []
  const copied: string[] = []
  on('prompt.fill', (_$, e) => {
    prompt.push(e.text)
    return { isFilled: true }
  })
  on('ui.copy', (_$, e) => {
    copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
  on('session.messages', () => ({
    value: [
      { role: 'user' as const, text: 'write the notes', toolUses: [] },
      {
        role: 'assistant' as const,
        text: 'Here are the notes.',
        toolUses: [{ tool_use_id: 't1', tool: 'Write', input: { file_path: '/work/notes.md' }, result: '' }],
      },
    ],
  }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))

  return { ...app, clock, toasts, statuses, store, prompt, copied }
}
