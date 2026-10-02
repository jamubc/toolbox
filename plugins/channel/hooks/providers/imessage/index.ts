import { NeedsSetup } from '../../core/contract'
import type { Conversation, Message, Part, Person, ProviderSpec, Reaction, Run, Setup, Update } from '../../core/contract'
import { Q } from './queries'

// iMessage on macOS 13 or later: reads ~/Library/Messages/chat.db through
// sqlite3, read-only, and sends through Messages with osascript. Needs Full
// Disk Access for the app running Claude Code, and asks once to control
// Messages on the first send. The terminal only: a mod cannot start a process
// in the desktop app. Messages offers no way to send a tapback, edit, or mark
// read, so those are read here and never written.

const SQLITE = '/usr/bin/sqlite3'
const OSASCRIPT = '/usr/bin/osascript'
// Apple's epoch, 2001-01-01, in Unix milliseconds.
const APPLE_EPOCH_MS = 978_307_200_000
const PAGE = 50
const SINCE_LIMIT = 200
const CONVERSATIONS = 20
// Tapback kinds 0 to 5, as Messages numbers them.
const TAPBACKS = ['❤️', '👍', '👎', '😂', '‼️', '❓']

type Row = {
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

type FileRow = { id: number; name: string | null; mime: string | null; bytes: number | null; path: string | null }

export type TapRow = { id: number; conversation: number; target: string; type: number; fromMe: number; who: number | null }

function needsAccess(app: string): Setup {
  return {
    state: 'setup',
    summary: 'iMessage cannot read your Messages yet',
    steps: [
      'Open System Settings › Privacy & Security › Full Disk Access',
      `Turn on ${app || 'the terminal app you run Claude Code in'} (add it with + if it is not listed)`,
      `Quit and reopen ${app || 'that app'}`,
    ],
  }
}

// Apple's dates are nanoseconds since 2001 on current macOS, seconds on old ones.
function toMs(date: number): number {
  return (date > 1e14 ? date / 1e6 : date * 1000) + APPLE_EPOCH_MS
}

// The later of two stamps held as digit strings.
function later(a: string, b: string): string {
  return a.length === b.length ? (a > b ? a : b) : a.length > b.length ? a : b
}

function isSet(stamp: string | null): stamp is string {
  return stamp !== null && stamp !== '0'
}

// Each person holds at most one tapback on a message: a new one replaces it,
// and taking it back clears it. Keyed by the target message's guid.
export function foldTaps(rows: readonly TapRow[]): Map<string, Reaction[]> {
  const votes = new Map<string, Map<string, { kind: number; isMine: boolean }>>()
  for (const row of rows) {
    const target = row.target.slice(-36)
    const voter = row.fromMe ? 'me' : String(row.who)
    const kind = row.type % 1000
    const mine = votes.get(target) ?? new Map<string, { kind: number; isMine: boolean }>()
    votes.set(target, mine)
    if (row.type >= 3000) {
      if (mine.get(voter)?.kind === kind) {
        mine.delete(voter)
      }
    } else {
      mine.set(voter, { kind, isMine: row.fromMe === 1 })
    }
  }

  const folded = new Map<string, Reaction[]>()
  for (const [target, mine] of votes) {
    const reactions: Reaction[] = []
    for (const { kind, isMine } of mine.values()) {
      const emoji = TAPBACKS[kind]
      if (!emoji) {
        continue
      }
      const known = reactions.find(one => one.emoji === emoji)
      if (known) {
        known.count += 1
        known.isMine ||= isMine
      } else {
        reactions.push({ emoji, count: 1, isMine })
      }
    }
    folded.set(target, reactions)
  }

  return folded
}

// Most messages since macOS 13 keep their text only in attributedBody, an
// archived NSAttributedString ("streamtyped"): the string follows the
// NSString class name and a '+' marker, behind a length byte (0x81 and 0x82
// say a 2- or 3-byte little-endian length follows).
export function attributedText(hex: string): string | null {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  const mark = new TextEncoder().encode('NSString')
  let at = -1
  search: for (let i = 0; i + mark.length <= bytes.length; i += 1) {
    for (let j = 0; j < mark.length; j += 1) {
      if (bytes[i + j] !== mark[j]) {
        continue search
      }
    }
    at = i
    break
  }
  if (at < 0) {
    return null
  }
  let i = bytes.indexOf(0x2b, at + mark.length)
  if (i < 0) {
    return null
  }
  i += 1
  let length = bytes[i] ?? 0
  i += 1
  if (length === 0x81) {
    length = (bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8)
    i += 2
  } else if (length === 0x82) {
    length = (bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8) | ((bytes[i + 2] ?? 0) << 16)
    i += 3
  }
  if (i + length > bytes.length) {
    return null
  }

  return new TextDecoder().decode(bytes.subarray(i, i + length))
}

export const imessage: ProviderSpec = {
  id: 'imessage',
  label: 'iMessage',
  reach: { commands: [SQLITE, OSASCRIPT] },

  async check({ run }, { home, app, surface, options }) {
    if (options.imessage === false) {
      return { state: 'off' }
    }
    if (surface !== 'terminal') {
      return { state: 'unavailable', reason: 'iMessage needs Claude Code in a terminal' }
    }
    try {
      await query(run, `${home}/Library/Messages/chat.db`, app, Q.top)
    } catch (error) {
      return error instanceof NeedsSetup ? error.health : { state: 'unavailable', reason: 'iMessage needs macOS 13 or later' }
    }

    return { state: 'ready' }
  },

  connect({ run }, { home, app }) {
    const database = `${home}/Library/Messages/chat.db`
    const chatGuids = new Map<string, string>()
    // Message guid to row id, for every message seen: replies and tapbacks
    // name their target by guid.
    const ids = new Map<string, string>()
    const ask = <T>(sql: string) => query<T>(run, database, app, sql)
    const expand = (path: string) => (path.startsWith('~') ? `${home}${path.slice(1)}` : path)

    function toParts(row: Row): Part[] {
      // U+FFFC stands where an attachment sits in the text.
      const text = (row.text ?? (row.body ? attributedText(row.body) : null) ?? '').replace(/\uFFFC/g, '').trim()
      const files = (JSON.parse(row.files ?? '[]') as FileRow[]).map((file): Part => {
        const path = file.path ? expand(file.path) : undefined
        const mime = file.mime ?? 'application/octet-stream'

        return {
          kind: mime.startsWith('image/') ? 'image' : 'file',
          name: file.name ?? path?.split('/').at(-1) ?? 'attachment',
          mime,
          bytes: file.bytes ?? undefined,
          handle: String(file.id),
          path,
        }
      })

      return [...(text ? [{ kind: 'text' as const, text }] : []), ...files]
    }

    function toMessages(rows: readonly Row[], taps?: Map<string, Reaction[]>): Message[] {
      for (const row of rows) {
        ids.set(row.guid, String(row.id))
      }

      return rows.map(row => {
        const isMe = row.fromMe === 1
        const who = row.handle ?? 'unknown'

        return {
          id: String(row.id),
          conversation: String(row.conversation),
          at: toMs(row.date),
          sender: isMe ? { id: 'me', name: 'me', isMe } : { id: who, name: who, isMe },
          parts: isSet(row.retracted) ? [] : toParts(row),
          replyTo: row.replyTo ? ids.get(row.replyTo) : undefined,
          editedAt: isSet(row.edited) ? toMs(Number(row.edited)) : undefined,
          isDeleted: isSet(row.retracted) || undefined,
          reactions: taps?.get(row.guid),
          isAlert: !isMe,
        }
      })
    }

    async function chatGuid(conversation: string): Promise<string> {
      const guid = chatGuids.get(conversation) ?? (await ask<{ guid: string }>(Q.chatGuid(conversation)))[0]?.guid
      if (!guid) {
        throw new Error('that conversation is gone')
      }

      return guid
    }

    // What changed on messages already delivered: tapbacks set or taken back.
    async function tapUpdates(taps: readonly TapRow[]): Promise<Update[]> {
      if (taps.length === 0) {
        return []
      }
      const chats = [...new Set(taps.map(one => String(one.conversation)))]
      const folded = foldTaps(await ask<TapRow>(Q.tapsIn(chats)))
      const targets = new Map(taps.map(one => [one.target.slice(-36), String(one.conversation)]))
      const unknown = [...targets.keys()].filter(one => !ids.has(one))
      if (unknown.length > 0) {
        for (const row of await ask<{ id: number; guid: string }>(Q.ids(unknown))) {
          ids.set(row.guid, String(row.id))
        }
      }

      return [...targets].flatMap(([target, conversation]): Update[] => {
        const id = ids.get(target)

        return id ? [{ kind: 'reaction', conversation, id, reactions: folded.get(target) ?? [] }] : []
      })
    }

    return {
      async conversations() {
        const rows = await ask<{
          id: number; guid: string; name: string | null; people: string | null; ident: string; date: number
          last: string | null; lastBody: string | null; lastFromMe: number | null; members: number | null
        }>(Q.conversations(CONVERSATIONS))

        return rows.map((row): Conversation => {
          chatGuids.set(String(row.id), row.guid)
          const text = (row.last ?? (row.lastBody ? attributedText(row.lastBody) : null) ?? '').replace(/\uFFFC/g, '').trim()
          const preview = text ? (row.lastFromMe === 1 ? `You: ${text}` : text) : undefined

          return {
            id: String(row.id),
            name: row.name || row.people || row.ident,
            at: toMs(row.date),
            preview,
            members: row.members === null ? undefined : row.members + 1,
          }
        })
      },

      async history(conversation, page) {
        const rows = await ask<Row>(Q.history(conversation, page?.before, page?.limit ?? PAGE))
        const taps = foldTaps(await ask<TapRow>(Q.tapsIn([conversation])))

        return toMessages(rows.reverse(), taps)
      },

      feed: {
        kind: 'polled',
        openMs: 3_000,
        closedMs: 10_000,
        // The cursor is "<newest row id>.<newest edit or unsend stamp>".
        async since(cursor) {
          if (cursor === undefined) {
            const [top] = await ask<{ id: number | null; stamp: string | null }>(Q.top)

            return { updates: [], cursor: `${top?.id ?? 0}.${top?.stamp ?? '0'}` }
          }
          const [rowid = '0', stamp = '0'] = cursor.split('.')
          const fresh = await ask<Row>(Q.after(rowid, SINCE_LIMIT))
          const changed = (await ask<Row>(Q.changed(stamp, SINCE_LIMIT))).filter(row => !fresh.some(one => one.id === row.id))
          const taps = await ask<TapRow>(Q.tapsAfter(rowid))

          const updates: Update[] = [
            ...toMessages(fresh).map((message): Update => ({ kind: 'message', message })),
            ...toMessages(changed).map(
              (message): Update =>
                message.isDeleted ? { kind: 'delete', conversation: message.conversation, id: message.id } : { kind: 'edit', message },
            ),
            ...(await tapUpdates(taps)),
          ]
          const newest = Math.max(Number(rowid), ...fresh.map(row => row.id), ...taps.map(row => row.id))
          const stamped = [...fresh, ...changed].reduce(
            (max, row) => later(later(max, row.edited ?? '0'), row.retracted ?? '0'),
            stamp,
          )

          return { updates, cursor: `${newest}.${stamped}` }
        },
      },

      async send(conversation, draft) {
        // The text rides as an argument, never inside the script. The leading
        // "x" keeps a message that starts with "-" from reading as an option.
        await tell(
          run,
          'tell application "Messages" to send (text 2 thru -1 of item 1 of argv) to chat id (item 2 of argv)',
          `x${draft.text}`,
          await chatGuid(conversation),
        )
      },

      attachments: {
        async send(conversation, path) {
          const file = expand(path)
          if (!file.startsWith('/')) {
            throw new Error('give the full path of the file')
          }
          await tell(
            run,
            'tell application "Messages" to send (POSIX file (text 2 thru -1 of item 1 of argv)) to chat id (item 2 of argv)',
            `x${file}`,
            await chatGuid(conversation),
          )
        },

        async fetch(handle) {
          const [row] = await ask<{ path: string | null }>(Q.attachment(handle))
          if (!row?.path) {
            throw new Error('that file is not on this Mac')
          }

          return { path: expand(row.path) }
        },
      },

      members: {
        async of(conversation) {
          const rows = await ask<{ id: string }>(Q.members(conversation))

          return rows.map((row): Person => ({ id: row.id, name: row.id, isMe: false }))
        },
      },
    }
  },
}

async function query<T>(run: Run, database: string, app: string, sql: string): Promise<T[]> {
  const res = await run([SQLITE, '-readonly', '-json', database, sql])
  if (res.exitCode !== 0) {
    if (/unable to open|authorization denied|not authorized/i.test(res.stderr)) {
      throw new NeedsSetup(needsAccess(app))
    }
    throw new Error(res.stderr.trim() || `sqlite3 exited ${res.exitCode}`)
  }
  if (res.isStdoutTruncated) {
    throw new Error('the Messages query answered more than 4 MiB')
  }

  // sqlite3 prints nothing at all for no rows.
  return res.stdout.trim() ? (JSON.parse(res.stdout) as T[]) : []
}

// Runs one line of AppleScript with its two values as arguments.
async function tell(run: Run, line: string, first: string, second: string): Promise<void> {
  const res = await run([OSASCRIPT, '-e', 'on run argv', '-e', line, '-e', 'end run', first, second])
  if (res.exitCode !== 0) {
    const reason = res.stderr.trim()
    throw new Error(
      /-1743|not allowed/i.test(reason)
        ? 'allow Claude Code to control Messages (System Settings › Privacy & Security › Automation)'
        : reason || `osascript exited ${res.exitCode}`,
    )
  }
}
