import type { ProcessRunResult } from 'claude-code'

// What a chat service plugs in as. A provider turns one service into
// conversations and messages and sends a reply; the pane, polling, toasts and
// status line in register.tsx are shared and never know which service it is.

export type Run = (argv: readonly string[]) => Promise<ProcessRunResult>

// What a provider may reach, already fenced by register.tsx: `run` starts the
// spec's own commands and nothing else.
export type Tools = { run: Run }

// `app` is the name macOS lists the terminal under, or '' when unknown.
export type Settings = { home: string; app: string }

export type Conversation = { id: string; name: string }

// One message. `id` orders messages within a provider; `at` is milliseconds
// since the epoch; `isAlert` says it deserves a toast when it arrives unseen.
export type Incoming = {
  id: string
  conversation: string
  at: number
  sender: string
  text: string
  isFromMe: boolean
  isAlert: boolean
}

export type Provider = {
  // Most recent first.
  conversations: () => Promise<Conversation[]>
  // The latest messages of one conversation, oldest first.
  recent: (conversation: string) => Promise<Incoming[]>
  // What arrived in any conversation after `cursor`, oldest first, and the
  // cursor to ask from next. With no cursor yet, only the cursor: nothing
  // already there counts as new.
  since: (cursor: string | undefined) => Promise<{ messages: Incoming[]; cursor: string }>
  send: (conversation: string, text: string) => Promise<void>
}

export type ProviderSpec = {
  label: string
  // The only executables `run` will start.
  commands: readonly string[]
  // How often to look for news while the pane shows, and while it does not.
  openMs: number
  closedMs: number
  connect: (tools: Tools, settings: Settings) => Provider
}

export function guardRun(run: Run, commands: readonly string[]): Run {
  return argv =>
    argv[0] !== undefined && commands.includes(argv[0])
      ? run(argv)
      : Promise.reject(new Error(`refused to run ${argv[0] ?? 'nothing'}`))
}
