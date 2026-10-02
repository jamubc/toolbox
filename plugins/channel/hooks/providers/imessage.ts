import type { Conversation, Incoming, ProviderSpec, Run } from './chat'

// iMessage on macOS: reads ~/Library/Messages/chat.db through sqlite3,
// read-only, and sends through Messages with osascript. Needs Full Disk Access
// for the app running Claude Code, and asks once to control Messages on the
// first send. The CLI only: $.process is not there in the desktop app.

const SQLITE = '/usr/bin/sqlite3'
const OSASCRIPT = '/usr/bin/osascript'
// Apple's epoch, 2001-01-01, in Unix milliseconds.
const APPLE_EPOCH_MS = 978_307_200_000
const RECENT = 50
const SINCE_LIMIT = 200
const CONVERSATIONS = 9
const NO_ACCESS =
  'cannot read Messages: give the app running Claude Code Full Disk Access ' +
  '(System Settings › Privacy & Security › Full Disk Access), then restart it'

type Row = {
  id: number
  conversation: number
  date: number
  fromMe: number
  handle: string | null
  text: string | null
  body: string | null
  attachments: number
}

// Message rows, tapbacks and system notices left out. ROWIDs and chat ids are
// checked to be digits before they reach a query, so nothing typed can.
const SELECT_MESSAGES = `
SELECT m.ROWID id, cmj.chat_id conversation, m.date date, m.is_from_me fromMe,
       h.id handle, m.text text, CASE WHEN m.text IS NULL THEN hex(m.attributedBody) END body,
       m.cache_has_attachments attachments
FROM message m
JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
LEFT JOIN handle h ON h.ROWID = m.handle_id
WHERE m.associated_message_type = 0 AND m.item_type = 0`

function digits(value: string, what: string): string {
  if (!/^\d{1,18}$/.test(value)) {
    throw new Error(`${what} must be a number`)
  }

  return value
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

function toIncoming(row: Row): Incoming {
  // Dates are nanoseconds since 2001 on current macOS, seconds on old ones.
  const at = (row.date > 1e14 ? row.date / 1e6 : row.date * 1000) + APPLE_EPOCH_MS
  // U+FFFC stands where an attachment sits in the text.
  const text = (row.text ?? (row.body ? attributedText(row.body) : null) ?? '').replace(/￼/g, '').trim()

  return {
    id: String(row.id),
    conversation: String(row.conversation),
    at,
    sender: row.fromMe ? 'me' : (row.handle ?? 'unknown'),
    text: text || (row.attachments ? '[attachment]' : '[message]'),
    isFromMe: row.fromMe === 1,
    isAlert: row.fromMe !== 1,
  }
}

export const imessage: ProviderSpec = {
  label: 'iMessage',
  commands: [SQLITE, OSASCRIPT],
  openMs: 3_000,
  closedMs: 10_000,
  connect({ run }, { home }) {
    const database = `${home}/Library/Messages/chat.db`
    const guids = new Map<string, string>()

    async function query<T>(sql: string): Promise<T[]> {
      const res = await run([SQLITE, '-readonly', '-json', database, sql])
      if (res.exitCode !== 0) {
        throw new Error(/unable to open|authorization denied|not authorized/i.test(res.stderr) ? NO_ACCESS : res.stderr.trim() || `sqlite3 exited ${res.exitCode}`)
      }
      if (res.isStdoutTruncated) {
        throw new Error('the Messages query answered more than 4 MiB')
      }
      // sqlite3 prints nothing at all for no rows.
      return res.stdout.trim() ? (JSON.parse(res.stdout) as T[]) : []
    }

    return {
      async conversations() {
        const rows = await query<{ id: number; guid: string; name: string | null; people: string | null; ident: string }>(`
SELECT c.ROWID id, c.guid guid, c.display_name name, c.chat_identifier ident,
       (SELECT group_concat(h.id, ', ') FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id
        WHERE chj.chat_id = c.ROWID) people
FROM chat c
JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
GROUP BY c.ROWID
ORDER BY MAX(cmj.message_id) DESC
LIMIT ${CONVERSATIONS}`)

        return rows.map((row): Conversation => {
          guids.set(String(row.id), row.guid)
          return { id: String(row.id), name: row.name || row.people || row.ident }
        })
      },

      async recent(conversation) {
        const rows = await query<Row>(
          `${SELECT_MESSAGES} AND cmj.chat_id = ${digits(conversation, 'conversation')} ORDER BY m.ROWID DESC LIMIT ${RECENT}`,
        )

        return rows.reverse().map(toIncoming)
      },

      async since(cursor) {
        if (cursor === undefined) {
          const [top] = await query<{ id: number | null }>('SELECT MAX(ROWID) id FROM message')
          return { messages: [], cursor: String(top?.id ?? 0) }
        }
        const rows = await query<Row>(
          `${SELECT_MESSAGES} AND m.ROWID > ${digits(cursor, 'cursor')} ORDER BY m.ROWID LIMIT ${SINCE_LIMIT}`,
        )
        const messages = rows.map(toIncoming)

        return { messages, cursor: messages.at(-1)?.id ?? cursor }
      },

      async send(conversation, text) {
        let guid = guids.get(conversation)
        if (!guid) {
          const [row] = await query<{ guid: string }>(`SELECT guid FROM chat WHERE ROWID = ${digits(conversation, 'conversation')}`)
          guid = row?.guid
        }
        if (!guid) {
          throw new Error('that conversation is gone')
        }
        // The text rides as an argument, never inside the script. The leading
        // "x" keeps a message that starts with "-" from reading as an option.
        await sendWith(run, `x${text}`, guid)
      },
    }
  },
}

async function sendWith(run: Run, prefixedText: string, guid: string): Promise<void> {
  const res = await run([
    OSASCRIPT,
    '-e',
    'on run argv',
    '-e',
    'tell application "Messages" to send (text 2 thru -1 of item 1 of argv) to chat id (item 2 of argv)',
    '-e',
    'end run',
    prefixedText,
    guid,
  ])
  if (res.exitCode !== 0) {
    const reason = res.stderr.trim()
    throw new Error(/-1743|not allowed/i.test(reason) ? 'allow Claude Code to control Messages (System Settings › Privacy & Security › Automation)' : reason || `osascript exited ${res.exitCode}`)
  }
}
