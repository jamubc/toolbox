import type { EngineInterface, Register, Timer } from 'claude-code'

import { guardRun } from './providers/chat'
import type { Conversation, Incoming, Provider, ProviderSpec, Settings } from './providers/chat'
import { imessage } from './providers/imessage'

// Chat is untrusted input and private: nothing here reaches the model. No
// session.append, no prompt.submit or prompt.fill, no tool. Messages go to the
// pane, toasts and the status line only, and a message goes out only on the
// person's Enter. Message text lives in this module's memory alone, never in
// $.state (any plugin reads that) or $.store (it outlives the session), and
// the mod makes no network request.

const PANE = 'channel'
const MAX_BACKOFF_MS = 300_000
const KEEP = 200

type View = {
  spec: ProviderSpec
  settings: Settings
  chat?: Provider
  conversations: Conversation[]
  selected?: string
  // Messages of the conversations opened so far.
  messages: Map<string, Incoming[]>
  unread: Map<string, number>
  cursor?: string
  problem: string | null
  sent: number
  timer?: Timer
  isPolling: boolean
  backoffMs: number
}

// Text from other people reaches the screen with its control characters out,
// so a message cannot move the cursor or restyle the terminal.
function clean(one: Incoming): Incoming {
  const strip = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')

  return { ...one, sender: strip(one.sender), text: strip(one.text) }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clockTime(at: number): string {
  const time = new Date(at)

  return `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
}

function nameOf(view: View, conversation: string): string {
  return view.conversations.find(one => one.id === conversation)?.name ?? conversation
}

// The provider gets a fenced `run`: its own commands and nothing else.
async function connect($: EngineInterface, view: View): Promise<Provider> {
  if (!view.chat) {
    view.settings.home ||= (await $.env.get('HOME')) ?? ''
    view.chat = view.spec.connect({ run: guardRun(argv => $.process.run(argv), view.spec.commands) }, view.settings)
  }

  return view.chat
}

async function isPaneShown($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
}

function showStatus($: EngineInterface, view: View): void {
  const count = [...view.unread.values()].reduce((sum, n) => sum + n, 0)
  $.ui.status(count > 0 ? `${view.spec.label} ${count} new` : undefined)
}

function redraw($: EngineInterface, view: View): void {
  showStatus($, view)
  $.ui.invalidate('ui.render')
}

async function openConversation($: EngineInterface, view: View, conversation: string): Promise<void> {
  view.selected = conversation
  view.unread.delete(conversation)
  redraw($, view)
  try {
    const chat = await connect($, view)
    view.messages.set(conversation, (await chat.recent(conversation)).map(clean))
  } catch (error) {
    view.problem = `${view.spec.label}: ${reasonOf(error)}`
  }
  redraw($, view)
}

function closeConversation($: EngineInterface, view: View): void {
  view.selected = undefined
  redraw($, view)
}

async function poll($: EngineInterface, view: View): Promise<number> {
  const chat = await connect($, view)
  if (view.conversations.length === 0) {
    view.conversations = await chat.conversations()
    const [only] = view.conversations
    if (only && view.conversations.length === 1) {
      await openConversation($, view, only.id)
    }
  }

  const { messages, cursor } = await chat.since(view.cursor)
  view.cursor = cursor
  view.problem = null
  const isShown = await isPaneShown($)
  for (const one of messages.map(clean)) {
    const list = view.messages.get(one.conversation)
    if (list && !list.some(known => known.id === one.id)) {
      view.messages.set(one.conversation, [...list, one].slice(-KEEP))
    }
    if (one.isFromMe || (isShown && view.selected === one.conversation)) {
      continue
    }
    view.unread.set(one.conversation, (view.unread.get(one.conversation) ?? 0) + 1)
    if (one.isAlert) {
      const name = nameOf(view, one.conversation)
      $.ui.toast(`${name === one.sender ? name : `${name} · ${one.sender}`}: ${one.text.slice(0, 80)}`)
    }
  }
  if (messages.length > 0) {
    // A new message moves its conversation to the top, or brings a new one.
    view.conversations = await chat.conversations()
  }
  redraw($, view)

  return isShown ? view.spec.openMs : view.spec.closedMs
}

// One poll at a time, each scheduling the next: fast while the pane shows,
// slow behind it, backing off on errors.
async function pollNow($: EngineInterface, view: View): Promise<void> {
  if (view.isPolling) {
    return
  }
  view.isPolling = true
  view.timer?.cancel()
  let nextMs: number
  try {
    nextMs = await poll($, view)
    view.backoffMs = 0
  } catch (error) {
    view.backoffMs = Math.min(Math.max(view.backoffMs * 2, view.spec.closedMs), MAX_BACKOFF_MS)
    nextMs = view.backoffMs
    view.problem = `${view.spec.label}: ${reasonOf(error)}`
    redraw($, view)
  } finally {
    view.isPolling = false
  }
  view.timer = $.clock.after(nextMs, () => void pollNow($, view))
}

async function send($: EngineInterface, view: View, text: string): Promise<void> {
  const body = text.trim()
  const conversation = view.selected
  if (!body || !conversation) {
    return
  }
  try {
    await (await connect($, view)).send(conversation, body)
    view.sent += 1
    view.problem = null
  } catch (error) {
    view.problem = `Not sent: ${reasonOf(error)}`
    redraw($, view)
    return
  }
  redraw($, view)
  await pollNow($, view)
}

export const register: Register = on => {
  const spec: ProviderSpec = imessage
  const settings: Settings = { home: '' }
  const view: View = {
    spec,
    settings,
    conversations: [],
    messages: new Map(),
    unread: new Map(),
    problem: null,
    sent: 0,
    isPolling: false,
    backoffMs: 0,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'channel',
      description: `Open your ${spec.label} conversations in a pane`,
      immediate: true,
    })
    if (e.isInteractive) {
      void pollNow($, view)
    }

    return next(e)
  })

  // /clear ends the conversation, not the process, and no session.start follows.
  on('session.end', ($, e, next) => {
    if (e.reason !== 'clear') {
      view.timer?.cancel()
    }

    return next(e)
  })

  on('command.run', { command: 'channel' }, async $ => {
    await $.ui.open({ id: PANE, title: spec.label })
    if (view.selected) {
      view.unread.delete(view.selected)
    }
    redraw($, view)
    void pollNow($, view)

    return { text: 'channel opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements

    const trouble = view.problem && <Text color="red">{view.problem}</Text>

    if (!view.selected) {
      return (
        <Box flexDirection="column">
          <Text bold>{view.spec.label}</Text>
          {view.conversations.length === 0 && !view.problem && <Text dimColor>Loading conversations…</Text>}
          {view.conversations.map((one, index) => {
            const unread = view.unread.get(one.id) ?? 0
            return (
              <Button
                key={`open-${one.id}`}
                plain
                label={`${one.name}${unread > 0 ? `  (${unread} new)` : ''}`}
                hotkey={String(index + 1)}
                onPress={() => void openConversation($, view, one.id)}
              />
            )
          })}
          {trouble}
        </Box>
      )
    }

    const list = view.messages.get(view.selected) ?? []
    const columns = Math.max(20, e.props.bodyColumns)
    const Reply = 'Input' in elements ? elements.Input : undefined
    let room = Math.max(1, e.props.scroll.bodyRows - (Reply ? 3 : 1) - (view.problem ? 1 : 0))
    const tail: Incoming[] = []
    for (const one of [...list].reverse()) {
      if (room <= 0) {
        break
      }
      room -= Math.max(1, Math.ceil((one.sender.length + one.text.length + 8) / columns))
      tail.unshift(one)
    }
    const name = nameOf(view, view.selected)

    return (
      <Box flexDirection="column">
        <Box>
          {view.conversations.length > 1 && <Button key="back" label="‹ chats" onPress={() => closeConversation($, view)} />}
          <Text bold> {name}</Text>
        </Box>
        {list.length === 0 && !view.problem && <Text dimColor>Loading…</Text>}
        {tail.map(one => (
          <Text key={one.id} wrap="wrap">
            <Text dimColor>{clockTime(one.at)} </Text>
            <Text bold color={one.isFromMe ? 'cyan' : undefined}>
              {one.sender}
            </Text>
            <Text> {one.text}</Text>
          </Text>
        ))}
        {trouble}
        {Reply && (
          <Reply
            key="reply"
            label="> "
            placeholder={`Message ${name}`}
            value=""
            submitLabel="send"
            autoFocus
            onSubmit={text => void send($, view, text)}
          />
        )}
        {Reply && (
          <Text key={`sent-${view.sent}`} dimColor>
            {view.sent > 0 ? 'Sent.' : ' '}
          </Text>
        )}
      </Box>
    )
  })
}
