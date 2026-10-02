import type { ProcessRunResult } from 'claude-code'

// What every chat service plugs in as, and what the pane draws from. A
// provider turns one service into conversations, messages and updates; the
// core and the UI never know which service it is.

export type Ref = { service: string; conversation: string }

// `at` is the conversation's latest activity, milliseconds since the epoch.
export type Conversation = { id: string; name: string; at: number }

export type Person = { id: string; name: string; isMe: boolean }

// `path` is set when the bytes are already a file on this machine. `handle` is
// opaque to the core: only the provider that issued it can resolve it.
export type Attachment = { name: string; mime: string; bytes?: number; handle: string; path?: string }

export type Part =
  | { kind: 'text'; text: string }
  | ({ kind: 'file' } & Attachment)
  | ({ kind: 'image' } & Attachment)
  | { kind: 'link'; url: string; title?: string }

export type Reaction = { emoji: string; count: number; isMine: boolean }

// `id` orders messages within one service. `isAlert` says it deserves a toast
// when it arrives unseen.
export type Message = {
  id: string
  conversation: string
  at: number
  sender: Person
  parts: Part[]
  replyTo?: string
  thread?: string
  editedAt?: number
  isDeleted?: boolean
  reactions?: Reaction[]
  mentionsMe?: boolean
  isAlert: boolean
}

export type Update =
  | { kind: 'message'; message: Message }
  | { kind: 'edit'; message: Message }
  | { kind: 'delete'; conversation: string; id: string }
  | { kind: 'reaction'; conversation: string; id: string; reactions: Reaction[] }
  | { kind: 'read'; conversation: string; upTo: string }
  | { kind: 'typing'; conversation: string; who: Person; isTyping: boolean }
  | { kind: 'presence'; who: Person; isOnline: boolean }

export type Draft = { text: string; replyTo?: string }

// News by asking: with no cursor yet, only the cursor, so nothing already
// there counts as new.
export type Polled = {
  kind: 'polled'
  openMs: number
  closedMs: number
  since: (cursor: string | undefined) => Promise<{ updates: Update[]; cursor: string }>
}

// News as it happens, from a streamed helper.
export type Live = { kind: 'live'; updates: () => AsyncIterable<Update> }

export type Provider = {
  // Most recent first.
  conversations: () => Promise<Conversation[]>
  // One page of a conversation, oldest first.
  history: (conversation: string, page?: { before?: string; limit?: number }) => Promise<Message[]>
  feed: Polled | Live
  send: (conversation: string, draft: Draft) => Promise<void>

  // Optional capabilities: present means supported.
  attachments?: {
    send: (conversation: string, path: string) => Promise<void>
    fetch: (handle: string) => Promise<{ path: string }>
  }
  threads?: { replies: (conversation: string, thread: string) => Promise<Message[]> }
  reactions?: { set: (conversation: string, id: string, emoji: string, isOn: boolean) => Promise<void> }
  edits?: {
    edit: (conversation: string, id: string, text: string) => Promise<void>
    remove: (conversation: string, id: string) => Promise<void>
  }
  readState?: { markRead: (conversation: string, upTo: string) => Promise<void> }
  typing?: { set: (conversation: string, isTyping: boolean) => Promise<void> }
  members?: { of: (conversation: string) => Promise<Person[]> }
  search?: { find: (text: string) => Promise<Message[]> }
}

export type Setup = { state: 'setup'; summary: string; steps: string[] }

export type Health =
  | { state: 'ready' }
  // Not turned on: shown nowhere.
  | { state: 'off' }
  // Turned on, and waiting on the person.
  | Setup
  // Cannot work here.
  | { state: 'unavailable'; reason: string }

// Thrown by a provider that finds, mid-flight, it needs the person again.
export class NeedsSetup extends Error {
  constructor(readonly health: Setup) {
    super(health.summary)
  }
}

export type Run = (argv: readonly string[]) => Promise<ProcessRunResult>
export type Fetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; headers: Record<string, string>; text: string }>
export type Spawn = (argv: readonly string[]) => AsyncIterable<{ stream: 'stdout' | 'stderr'; text: string }>

// What a provider may reach, already fenced to its `reach`.
export type Tools = { run: Run; fetch: Fetch; spawn: Spawn }

// `app` is the name macOS lists the terminal under, or '' when unknown.
// `options` are the plugin's userConfig values; a provider reads only its own.
export type Settings = {
  home: string
  app: string
  surface: string
  options: Readonly<Record<string, unknown>>
}

export type Reach = {
  // Executables `run` may start, by absolute path.
  commands?: readonly string[]
  // Hosts `fetch` may call, over https only.
  hosts?: readonly string[]
  // The argv of the one streamed process `spawn` may start.
  helper?: readonly string[]
}

export type ProviderSpec = {
  id: string
  label: string
  reach: Reach
  // Whether the service is set up, and if not, what the person should do.
  check: (tools: Tools, settings: Settings) => Promise<Health>
  connect: (tools: Tools, settings: Settings) => Provider
}

export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// A message as one line of plain text.
export function textOf(message: Message): string {
  const text = message.parts
    .map(part => (part.kind === 'text' ? part.text : part.kind === 'link' ? (part.title ?? part.url) : `[${part.name}]`))
    .join(' ')
    .trim()

  return text || '[message]'
}
