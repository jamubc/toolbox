import type { Conversation, Health, Message, ProviderSpec, Update } from '../../hooks/core/contract'

// A chat service scripted from the test: what it holds, what arrives next,
// and when it fails.

export function message(id: string, conversation: string, text: string, fields: Partial<Message> = {}): Message {
  return {
    id,
    conversation,
    at: Number(id),
    sender: { id: 'ana', name: 'Ana', isMe: false },
    parts: [{ kind: 'text', text }],
    isAlert: true,
    ...fields,
  }
}

export function fake(id: string, options: { isLive?: boolean; health?: Health } = {}) {
  const state = {
    health: options.health ?? ({ state: 'ready' } as Health),
    conversations: [
      { id: 'a', name: 'Ana', at: 1 },
      { id: 'b', name: 'Book club', at: 2 },
    ] as Conversation[],
    history: new Map<string, Message[]>(),
    queue: [] as Update[],
    failure: null as Error | null,
    sent: [] as { conversation: string; text?: string; path?: string }[],
    polls: 0,
    // Ends the live stream after what is queued.
    isClosing: false,
  }

  const spec: ProviderSpec = {
    id,
    label: id.charAt(0).toUpperCase() + id.slice(1),
    reach: { commands: ['/bin/fake'], hosts: ['api.example.com'], helper: ['/bin/helper', 'watch'] },
    check: async () => state.health,
    connect: () => ({
      conversations: async () => state.conversations,
      history: async conversation => state.history.get(conversation) ?? [],
      feed: options.isLive
        ? {
            kind: 'live',
            async *updates() {
              while (state.queue.length > 0) {
                const next = state.queue.shift()
                if (next) {
                  yield next
                }
              }
              if (state.failure) {
                throw state.failure
              }
            },
          }
        : {
            kind: 'polled',
            openMs: 1_000,
            closedMs: 5_000,
            async since(cursor) {
              state.polls += 1
              if (state.failure) {
                throw state.failure
              }
              if (cursor === undefined) {
                return { updates: [], cursor: '0' }
              }

              const updates = state.queue.splice(0)

              return { updates, cursor: String(Number(cursor) + updates.length) }
            },
          },
      send: async (conversation, draft) => void state.sent.push({ conversation, text: draft.text }),
      attachments: {
        send: async (conversation, path) => void state.sent.push({ conversation, path }),
        fetch: async handle => ({ path: `/files/${handle}` }),
      },
    }),
  }

  return { spec, state, push: (...updates: Update[]) => void state.queue.push(...updates) }
}

// A clock the test moves, a store two hubs can share, and everything a hub
// shows the person.
export function world() {
  let now = 0
  const timers: { at: number; fn: () => void; isOff: boolean }[] = []
  const store = new Map<string, unknown>()

  async function settle(): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      await Promise.resolve()
    }
  }

  return {
    store,
    settle,
    clock: {
      now: async () => now,
      after(ms: number, fn: () => void) {
        const timer = { at: now + ms, fn, isOff: false }
        timers.push(timer)

        return { cancel: () => void (timer.isOff = true) }
      },
    },
    async advance(ms: number): Promise<void> {
      const end = now + ms
      for (;;) {
        const due = timers.filter(one => !one.isOff && one.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!due) {
          break
        }
        now = due.at
        due.isOff = true
        due.fn()
        await settle()
      }
      now = end
      await settle()
    },
    // What one session of the mod is given.
    session(name: string) {
      const seen = {
        toasts: [] as string[],
        statuses: [] as (string | undefined)[],
        opened: [] as string[],
        prompt: [] as string[],
        copied: [] as string[],
        offers: { files: [] as string[], lastReply: '' },
        isShown: false,
      }

      return {
        seen,
        deps: {
          tools: {
            run: async () => ({ exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }),
            fetch: async () => ({ status: 200, ok: true, headers: {}, text: '' }),
            async *spawn() {},
          },
          settings: { home: '/Users/someone', app: 'Ghostty', surface: 'terminal', options: {} },
          clock: this.clock,
          isShown: async () => seen.isShown,
          toast: (text: string) => void seen.toasts.push(text),
          status: (text: string | undefined) => void seen.statuses.push(text),
          store: {
            get: async (key: string) => store.get(key),
            set: async (key: string, value: unknown) => void store.set(key, value),
            delete: async (key: string) => void store.delete(key),
          },
          session: name,
          redraw: () => {},
          openPath: async (path: string) => void seen.opened.push(path),
          toPrompt: async (text: string) => seen.prompt.push(text) > 0,
          copy: async (text: string) => seen.copied.push(text) > 0,
          offers: async () => seen.offers,
          thumbnail: async () => undefined,
          pictures: 'cells' as const,
          probe: async () => true,
        },
      }
    },
  }
}
