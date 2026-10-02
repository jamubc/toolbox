// Every query the iMessage provider runs against chat.db. Each starts with a
// comment naming it. Row ids, timestamps and guids are checked before they
// reach a query, so nothing a person typed or received can.

export function digits(value: string, what: string): string {
  if (!/^\d{1,19}$/.test(value)) {
    throw new Error(`${what} must be a number`)
  }

  return value
}

function guid(value: string): string {
  if (!/^[0-9A-Fa-f-]{36}$/.test(value)) {
    throw new Error('message guid is malformed')
  }

  return `'${value}'`
}

// Message rows, tapbacks and system notices left out. The edit and unsend
// stamps are nanoseconds, past what a JSON number holds, so they travel as text.
const MESSAGES = `
SELECT m.ROWID id, m.guid guid, cmj.chat_id conversation, m.date date, m.is_from_me fromMe,
       h.id handle, m.text text, CASE WHEN m.text IS NULL THEN hex(m.attributedBody) END body,
       m.thread_originator_guid replyTo,
       CAST(m.date_edited AS TEXT) edited, CAST(m.date_retracted AS TEXT) retracted,
       (SELECT json_group_array(json_object('id', a.ROWID, 'name', a.transfer_name, 'mime', a.mime_type,
                                            'bytes', a.total_bytes, 'path', a.filename))
        FROM message_attachment_join maj JOIN attachment a ON a.ROWID = maj.attachment_id
        WHERE maj.message_id = m.ROWID) files
FROM message m
JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
LEFT JOIN handle h ON h.ROWID = m.handle_id
WHERE m.associated_message_type = 0 AND m.item_type = 0`

// Tapbacks: 2000 to 2005 set one, 3000 to 3005 take it back.
const TAPS = `
SELECT r.ROWID id, cmj.chat_id conversation, r.associated_message_guid target,
       r.associated_message_type type, r.is_from_me fromMe, r.handle_id who
FROM message r
JOIN chat_message_join cmj ON cmj.message_id = r.ROWID
WHERE (r.associated_message_type BETWEEN 2000 AND 2005 OR r.associated_message_type BETWEEN 3000 AND 3005)`

export const Q = {
  conversations: (limit: number) => `/* channel:conversations */
SELECT c.ROWID id, c.guid guid, c.display_name name, c.chat_identifier ident, MAX(m.date) date,
       (SELECT group_concat(h.id, ', ') FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id
        WHERE chj.chat_id = c.ROWID) people
FROM chat c
JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
JOIN message m ON m.ROWID = cmj.message_id
GROUP BY c.ROWID
ORDER BY MAX(cmj.message_id) DESC
LIMIT ${limit}`,

  history: (chat: string, before: string | undefined, limit: number) =>
    `/* channel:history */${MESSAGES} AND cmj.chat_id = ${digits(chat, 'conversation')}` +
    `${before === undefined ? '' : ` AND m.ROWID < ${digits(before, 'message')}`} ORDER BY m.ROWID DESC LIMIT ${limit}`,

  // The newest row, and the newest edit or unsend.
  top: `/* channel:top */
SELECT MAX(ROWID) id,
       CAST(MAX(COALESCE(MAX(date_edited), 0), COALESCE(MAX(date_retracted), 0)) AS TEXT) stamp
FROM message`,

  after: (rowid: string, limit: number) =>
    `/* channel:after */${MESSAGES} AND m.ROWID > ${digits(rowid, 'cursor')} ORDER BY m.ROWID LIMIT ${limit}`,

  changed: (stamp: string, limit: number) => {
    const since = digits(stamp, 'cursor')

    return `/* channel:changed */${MESSAGES} AND (m.date_edited > ${since} OR m.date_retracted > ${since}) ORDER BY m.ROWID LIMIT ${limit}`
  },

  tapsAfter: (rowid: string) => `/* channel:taps */${TAPS} AND r.ROWID > ${digits(rowid, 'cursor')} ORDER BY r.ROWID`,

  tapsIn: (chats: readonly string[]) =>
    `/* channel:taps */${TAPS} AND cmj.chat_id IN (${chats.map(one => digits(one, 'conversation')).join(', ')}) ORDER BY r.ROWID`,

  ids: (guids: readonly string[]) =>
    `/* channel:ids */ SELECT ROWID id, guid FROM message WHERE guid IN (${guids.map(guid).join(', ')})`,

  members: (chat: string) => `/* channel:members */
SELECT h.id id FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id
WHERE chj.chat_id = ${digits(chat, 'conversation')}`,

  attachment: (id: string) => `/* channel:attachment */ SELECT filename path FROM attachment WHERE ROWID = ${digits(id, 'attachment')}`,

  chatGuid: (chat: string) => `/* channel:guid */ SELECT guid FROM chat WHERE ROWID = ${digits(chat, 'conversation')}`,
}
