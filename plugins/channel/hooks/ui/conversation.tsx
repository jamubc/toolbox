import { textOf } from '../core/contract'
import type { Attachment, Message, Ref } from '../core/contract'
import type { Hub } from '../core/hub'
import { clip, clockTime, colorOf, dayLabel, fileLabel, isSameDay, reactionsOf } from './format'
import type { Elements } from './format'
import { cellsOf, fit } from './picture'
import type { Picture as Thumbnail } from './picture'

// Below this width the pane is cramped: labels shorten.
const NARROW = 48
const ROW_BG = '#1c2730'

// The most room a picture may take: it grows and shrinks with the pane, up
// to 80 columns.
function pictureRoom(columns: number, bodyRows: number): { columns: number; rows: number } {
  return { columns: Math.min(columns - 2, 80), rows: Math.max(4, Math.min(24, Math.floor(bodyRows * 0.4))) }
}
const RUN_MS = 5 * 60_000

type Props = { bodyColumns: number; bodyRows: number; surface: string; now: number }

function isFile(part: Message['parts'][number]): part is Extract<Message['parts'][number], Attachment> {
  return part.kind === 'file' || part.kind === 'image'
}

// What a thumbnail can be made of: a picture, or a PDF's first page.
function isPicturable(part: Attachment): boolean {
  return part.mime.startsWith('image/') || part.mime === 'application/pdf'
}

const pictureKey = (one: Message, index: number) => `picture-${one.id}-${index}`

// A picture draws inline in the terminal once its thumbnail is ready.
function pictureOf(hub: Hub, ref: Ref, one: Message, index: number, part: Attachment, surface: string): Thumbnail | undefined {
  return surface === 'terminal' && isPicturable(part) ? hub.picture(ref, part, pictureKey(one, index)) : undefined
}

// Messages a person sends in a row read as one block: the name shows once.
function continues(one: Message, before: Message | undefined): boolean {
  return before !== undefined && before.sender.id === one.sender.id && one.at - before.at < RUN_MS && !one.replyTo
}

// The rows one message takes, near enough to fit the newest ones in the pane.
function rowsOf(hub: Hub, ref: Ref, one: Message, before: Message | undefined, columns: number, props: Props): number {
  const { surface } = props
  const room = pictureRoom(columns, props.bodyRows)
  const files = one.parts.filter(isFile)
  const pictures = files
    .map((part, index) => pictureOf(hub, ref, one, index, part, surface))
    .filter(bitmap => bitmap !== undefined)

  return (
    (continues(one, before) ? 0 : 1) +
    (before === undefined || !isSameDay(before.at, one.at) ? 1 : 0) +
    Math.max(1, Math.ceil(textOf(one).length / Math.max(1, columns - 2))) +
    (one.replyTo ? 1 : 0) +
    files.length +
    pictures.reduce((sum, bitmap) => sum + fit(bitmap, room.columns, room.rows).rows, 0)
  )
}

// One conversation: its newest messages, then the reply box.
export function ConversationView(hub: Hub, elements: Elements, ref: Ref, props: Props) {
  const { Box, Button, Text } = elements
  const Reply = 'Input' in elements ? elements.Input : undefined
  const Picture = 'Image' in elements ? elements.Image : undefined
  const Cells = 'Raster' in elements ? elements.Raster : undefined
  const { view, inbox, notifier } = hub
  const provider = hub.providerOf(ref)
  const list = inbox.messages(ref)
  const problems = hub.problems()
  const columns = Math.max(20, props.bodyColumns)
  const name = inbox.nameOf(ref)
  const entry = inbox.entryOf(ref)
  const isNarrow = columns < NARROW
  const pictures = pictureRoom(columns, props.bodyRows)
  const target = notifier.target()
  const previous = notifier.previous()
  const { now } = props

  const offered = view.isAttaching ? view.offers.files.length + 1 : 0
  let room = Math.max(1, props.bodyRows - (Reply ? 5 : 2) - problems.length - offered) + view.depth
  const tail: Message[] = []
  for (let at = list.length - 1; at >= 0; at -= 1) {
    const one = list[at]
    if (!one || room <= 0) {
      break
    }
    room -= rowsOf(hub, ref, one, list[at - 1], columns, props)
    tail.unshift(one)
  }
  const hasOlder = tail.length < list.length || !view.isAtStart
  const people = entry?.members !== undefined && entry.members > 2 ? `${entry.members} people` : ''

  return (
    <Box flexDirection="column">
      <Box key="head" gap={1} flexWrap="wrap">
        <Button key="back" plain label="‹ chats" onPress={() => hub.back()} />
        <Text bold color="cyan">{clip(name, Math.max(8, columns - 12))}</Text>
        <Text dimColor>{[hub.labelOf(ref.service), people].filter(Boolean).join(' · ')}</Text>
        {target && <Button key="jump" plain label={clip(`↪ new in ${inbox.nameOf(target)}`, columns)} onPress={() => void hub.jump()} />}
        {!target && previous && (
          <Button key="jump-back" plain label={clip(`↩ back to ${inbox.nameOf(previous)}`, columns)} onPress={() => void hub.jumpBack()} />
        )}
      </Box>
      <Text dimColor>{'─'.repeat(columns)}</Text>
      {list.length === 0 && problems.length === 0 && <Text dimColor>Loading…</Text>}
      {list.length > 0 && (
        <Box key="paging" gap={2}>
          {hasOlder && <Button key="older" plain dimColor label="↑ older" onPress={() => void hub.older(props.bodyRows)} />}
          {!hasOlder && <Text dimColor>{isNarrow ? '· start ·' : '· the start of this conversation ·'}</Text>}
          {view.depth > 0 && <Button key="latest" plain dimColor label="↓ latest" onPress={() => hub.latest()} />}
        </Box>
      )}
      {tail.map((one, at) => {
        const before = tail[at - 1]
        const isRun = continues(one, before)
        const isNewDay = before === undefined || !isSameDay(before.at, one.at)
        const hasText = one.isDeleted || one.parts.some(part => !isFile(part)) || one.parts.length === 0
        const quoted = one.replyTo ? list.find(other => other.id === one.replyTo) : undefined
        const reactions = reactionsOf(one.reactions)
        const text = one.parts
          .filter(part => !isFile(part))
          .map(part => (part.kind === 'text' ? part.text : part.kind === 'link' ? (part.title ?? part.url) : ''))
          .join(' ')
        const color = one.sender.isMe ? 'cyan' : colorOf(one.sender.id)
        const who = one.sender.isMe ? 'You' : one.sender.name

        return (
          <Box key={`message-${one.id}`} flexDirection="column" hover={{ backgroundColor: ROW_BG }}>
            {isNewDay && (
              <Text dimColor>{`── ${dayLabel(one.at, now)} ──`}</Text>
            )}
            {quoted && (
              <Text dimColor wrap="truncate-end">{`  ↳ ${quoted.sender.isMe ? 'You' : quoted.sender.name}: ${textOf(quoted)}`}</Text>
            )}
            {!isRun && (
              <Text>
                <Text bold color={color}>{who}</Text>
                <Text dimColor>{` ${clockTime(one.at)}`}</Text>
              </Text>
            )}
            {(hasText || reactions) && (
              <Box flexDirection="row">
                <Text color={color}>{'▎'}</Text>
                <Box flexGrow={1} flexShrink={1}>
                  <Text wrap="wrap">
                    {one.isDeleted ? <Text dimColor italic>message unsent</Text> : <Text>{text}</Text>}
                    {one.editedAt !== undefined && !one.isDeleted && <Text dimColor> (edited)</Text>}
                    {reactions && <Text> {reactions}</Text>}
                  </Text>
                </Box>
              </Box>
            )}
            {one.parts.filter(isFile).map((part, index) => {
              const bitmap = pictureOf(hub, ref, one, index, part, props.surface)
              const box = bitmap && fit(bitmap, pictures.columns, pictures.rows)

              return (
                <Box key={`file-${one.id}-${index}`} flexDirection="column">
                  <Box gap={1} flexWrap="wrap">
                    <Text color={color}>{'▎'}</Text>
                    {props.surface === 'terminal' ? (
                      // The file itself is the button: pressing it opens it.
                      <Button key={`open-file-${one.id}-${index}`} plain label={clip(fileLabel(part), columns - 2)} onPress={() => void hub.openFile(ref, part)} />
                    ) : (
                      <Text>{clip(fileLabel(part), columns - 2)}</Text>
                    )}
                    <Button key={`claude-file-${one.id}-${index}`} plain dimColor label="→ Claude" onPress={() => void hub.fileToClaude(ref, part)} />
                    <Button key={`copy-file-${one.id}-${index}`} plain dimColor label={isNarrow ? 'copy' : 'copy path'} onPress={() => void hub.copyFile(ref, part)} />
                  </Box>
                  {bitmap && box && 'file' in bitmap.source && Picture && (
                    <Picture
                      key={pictureKey(one, index)}
                      source={{ file: bitmap.source.file, format: 'png', generation: bitmap.source.generation }}
                      columns={box.columns}
                      rows={box.rows}
                      alt={part.name}
                    />
                  )}
                  {bitmap && box && 'bitmap' in bitmap.source && Cells && (
                    <Cells key={pictureKey(one, index)} columns={box.columns} rows={box.rows} cells={cellsOf(bitmap.source.bitmap, box.columns, box.rows)} />
                  )}
                </Box>
              )
            })}
          </Box>
        )
      })}
      {problems.map((problem, index) => (
        <Text key={`problem-${index}`} color="red" wrap="wrap">{problem}</Text>
      ))}
      {Reply && <Text dimColor>{'─'.repeat(columns)}</Text>}
      {Reply && !view.isAttaching && (
        <Reply
          key="reply"
          label="› "
          placeholder={clip(`Message ${name}`, columns - 10)}
          value={view.draft}
          submitLabel="send"
          autoFocus
          onSubmit={text => void hub.send(text)}
        />
      )}
      {Reply && view.isAttaching && (
        <Reply
          key="attach-path"
          label="📎 "
          placeholder={isNarrow ? 'Path of a file' : 'Path of a file to send (type it, or drag the file here)'}
          value=""
          submitLabel="send file"
          autoFocus
          onSubmit={path => void hub.sendFile(path)}
        />
      )}
      {Reply && view.isAttaching && view.offers.files.length > 0 && (
        <Box key="offers" flexDirection="column">
          <Text dimColor>From this Claude session:</Text>
          {view.offers.files.map((file, index) => (
            <Button key={`offer-${index}`} plain label={clip(`📎 ${file.split('/').at(-1) ?? file}`, columns)} onPress={() => void hub.sendFile(file)} />
          ))}
        </Box>
      )}
      {Reply && (
        <Box key="foot" gap={1} flexWrap="wrap">
          {provider?.attachments && (
            <Button key="attach" plain dimColor label={view.isAttaching ? 'cancel' : 'attach'} onPress={() => void hub.toggleAttach()} />
          )}
          <Button key="draft-reply" plain dimColor label={isNarrow ? 'reply' : "Claude's reply"} onPress={() => void hub.draftLastReply()} />
          <Text key={`sent-${view.sent}`} color="green">
            {view.sent > 0 ? view.note : ' '}
          </Text>
        </Box>
      )}
    </Box>
  )
}
