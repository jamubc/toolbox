import { expect, test } from 'claude-code/testing'

import type { Settings, Tools, Update } from '../hooks/core/contract'
import { fence } from '../hooks/core/fence'
import { attributedText, foldTaps, imessage } from '../hooks/providers/imessage'
import { conformance } from './kit/conformance'
import { ANA, BEN, PNG, guidOf, messagesApp, row, streamtyped } from './kit/mac'

const SETTINGS: Settings = { home: '/Users/someone', app: 'Ghostty', surface: 'terminal', options: {} }

// The provider over the fake Mac, with no engine between.
function connected() {
  const app = messagesApp()
  const raw: Tools = {
    run: async argv => app.answer(argv),
    fetch: async () => ({ status: 200, ok: true, headers: {}, text: '' }),
    async *spawn() {},
  }
  const tools = fence(imessage.reach, raw)

  return { app, raw, tools, chat: imessage.connect(tools, SETTINGS) }
}

async function news(chat: ReturnType<typeof connected>['chat'], cursor: string): Promise<{ updates: Update[]; cursor: string }> {
  if (chat.feed.kind !== 'polled') {
    throw new Error('iMessage is polled')
  }

  return chat.feed.since(cursor)
}

async function start(chat: ReturnType<typeof connected>['chat']): Promise<string> {
  if (chat.feed.kind !== 'polled') {
    throw new Error('iMessage is polled')
  }

  return (await chat.feed.since(undefined)).cursor
}

test('attributedBody text decodes, short and long', () => {
  expect(attributedText(streamtyped('hi there'))).toBe('hi there')
  const long = 'é'.repeat(200)
  expect(attributedText(streamtyped(long))).toBe(long)
  expect(attributedText('00FF')).toBe(null)
})

test('iMessage passes the conformance every provider must', async () => {
  const { raw } = connected()

  expect(await conformance(imessage, raw, SETTINGS)).toEqual([])
})

test('it reads only through sqlite3, read-only, and never through a shell', async () => {
  const { app, chat } = connected()
  await chat.conversations()
  await chat.history('1')
  await news(chat, await start(chat))

  for (const argv of app.runs) {
    expect(argv.slice(0, 3)).toEqual(['/usr/bin/sqlite3', '-readonly', '-json'])
  }
})

test('history carries text, the reply it answers, and tapbacks', async () => {
  const { chat } = connected()
  const [first, second] = await chat.history('1')

  expect(first?.parts).toEqual([{ kind: 'text', text: 'see you at six' }])
  expect(first?.sender).toEqual({ id: ANA, name: ANA, isMe: false })
  expect(first?.reactions).toEqual([{ emoji: '👍', count: 1, isMine: true }])
  expect(second?.sender.isMe).toBe(true)
  expect(second?.replyTo).toBe('10')
})

test('an attachment becomes a part, and fetch answers where its file is', async () => {
  const { chat } = connected()
  const [only] = await chat.history('2')

  expect(only?.parts).toEqual([
    {
      kind: 'image',
      name: 'photo.png',
      mime: 'image/png',
      bytes: 2048,
      handle: '7',
      path: PNG.replace('~', '/Users/someone'),
    },
  ])
  expect(await chat.attachments?.fetch('7')).toEqual({ path: PNG.replace('~', '/Users/someone') })
  expect(await chat.attachments?.fetch('8').catch(e => e.message)).toBe('that file is not on this Mac')
})

test('news is new messages, edits, unsends and tapbacks, and the cursor passes them all', async () => {
  const { app, chat } = connected()
  await chat.history('1')
  const cursor = await start(chat)
  expect(cursor).toBe('13.0')

  app.receive(row(14, 2, { handle: BEN, text: 'chapter 4 tonight?' }))
  app.rows[0] = { ...row(10, 1, { text: 'see you at seven' }), edited: '900' }
  app.rows[1] = { ...row(11, 1, { fromMe: 1, handle: null, text: 'on my way' }), retracted: '950' }
  app.tap({ id: 15, conversation: 1, target: `p:0/${guidOf(10)}`, type: 3001, fromMe: 1, who: null })
  app.tap({ id: 16, conversation: 1, target: `p:0/${guidOf(10)}`, type: 2000, fromMe: 0, who: 4 })

  const first = await news(chat, cursor)
  expect(first.cursor).toBe('16.950')
  expect(first.updates.map(one => one.kind)).toEqual(['message', 'edit', 'delete', 'reaction'])
  const [arrived, edited, unsent, reacted] = first.updates
  expect(arrived?.kind === 'message' && arrived.message.parts).toEqual([{ kind: 'text', text: 'chapter 4 tonight?' }])
  expect(edited?.kind === 'edit' && edited.message.parts).toEqual([{ kind: 'text', text: 'see you at seven' }])
  expect(edited?.kind === 'edit' && edited.message.editedAt !== undefined).toBe(true)
  expect(unsent).toEqual({ kind: 'delete', conversation: '1', id: '11' })
  expect(reacted).toEqual({ kind: 'reaction', conversation: '1', id: '10', reactions: [{ emoji: '❤️', count: 1, isMine: false }] })

  // Nothing since: nothing again.
  expect(await news(chat, first.cursor)).toEqual({ updates: [], cursor: '16.950' })
})

test('tapbacks fold to one per person, and a removal clears it', () => {
  const tap = (id: number, type: number, who: number | null) => ({ id, conversation: 1, target: `p:0/${guidOf(1)}`, type, fromMe: who === null ? 1 : 0, who })

  expect(foldTaps([tap(1, 2001, 4), tap(2, 2001, 5), tap(3, 2003, null), tap(4, 2000, 4), tap(5, 3001, 5)]).get(guidOf(1))).toEqual([
    { emoji: '❤️', count: 1, isMine: false },
    { emoji: '😂', count: 1, isMine: true },
  ])
})

test('text and a file are sent through Messages as arguments, never inside the script', async () => {
  const { app, chat } = connected()
  await chat.conversations()

  await chat.send('1', { text: '-e "quoted" & end tell' })
  await chat.attachments?.send('1', '~/Desktop/notes.pdf')

  const sends = app.runs.filter(argv => argv[0] === '/usr/bin/osascript')
  expect(sends.length).toBe(2)
  expect(sends[0]?.slice(-2)).toEqual(['x-e "quoted" & end tell', `any;-;${ANA}`])
  expect(sends[0]?.slice(0, -2).join(' ')).not.toContain('quoted')
  expect(sends[1]?.slice(-2)).toEqual(['x/Users/someone/Desktop/notes.pdf', `any;-;${ANA}`])
  expect(sends[1]?.slice(0, -2).join(' ')).toContain('POSIX file')

  expect(await chat.attachments?.send('1', 'notes.pdf').catch(e => e.message)).toBe('give the full path of the file')
  expect(await chat.send('99', { text: 'hi' }).catch(e => e.message)).toBe('that conversation is gone')
})

test('members lists who is in a conversation', async () => {
  const { chat } = connected()

  expect((await chat.members?.of('2'))?.map(one => one.id)).toEqual([BEN, '+15555550103'])
})

test('a value that is not a number never reaches a query', async () => {
  const { app, chat } = connected()
  const before = app.runs.length

  expect(await chat.history('1; DROP TABLE message').catch(e => e.message)).toBe('conversation must be a number')
  expect(await news(chat, '1 OR 1=1.0').catch(e => e.message)).toBe('cursor must be a number')
  expect(app.runs.length).toBe(before)
})

test('check says ready, off, unavailable, or how to grant Full Disk Access', async () => {
  const { app, tools } = connected()

  expect(await imessage.check(tools, SETTINGS)).toEqual({ state: 'ready' })
  expect(await imessage.check(tools, { ...SETTINGS, options: { imessage: false } })).toEqual({ state: 'off' })
  expect((await imessage.check(tools, { ...SETTINGS, surface: 'desktop' })).state).toBe('unavailable')

  app.revokeAccess()
  const health = await imessage.check(tools, SETTINGS)
  expect(health.state).toBe('setup')
  expect(health.state === 'setup' && health.steps[1]).toBe('Turn on Ghostty (add it with + if it is not listed)')
  const nameless = await imessage.check(tools, { ...SETTINGS, app: '' })
  expect(nameless.state === 'setup' && nameless.steps[1]).toContain('the terminal app you run Claude Code in')
})
