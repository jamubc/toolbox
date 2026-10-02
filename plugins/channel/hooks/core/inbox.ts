import type { Conversation, Message, Part, Ref, Update } from './contract'

// Conversations, messages and unread counts across every service: the one
// store the pane reads. Messages live here, in module memory, and nowhere else.

const KEEP = 200

export type Entry = Conversation & { ref: Ref }

export type Inbox = ReturnType<typeof createInbox>

export function keyOf(ref: Ref): string {
  return `${ref.service}\u0000${ref.conversation}`
}

// Text from other people reaches the screen with its control characters out,
// so a message cannot move the cursor or restyle the terminal.
export function strip(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
}

function cleanPart(part: Part): Part {
  switch (part.kind) {
    case 'text':
      return { ...part, text: strip(part.text) }
    case 'link':
      return { ...part, url: strip(part.url), title: part.title === undefined ? undefined : strip(part.title) }
    default:
      return { ...part, name: strip(part.name) }
  }
}

function clean(message: Message): Message {
  return {
    ...message,
    sender: { ...message.sender, name: strip(message.sender.name) },
    parts: message.parts.map(cleanPart),
  }
}

export function createInbox() {
  const conversations = new Map<string, Conversation[]>()
  const messages = new Map<string, Message[]>()
  const unread = new Map<string, number>()

  function change(ref: Ref, id: string, edit: (old: Message) => Message): void {
    const list = messages.get(keyOf(ref))
    if (list) {
      messages.set(keyOf(ref), list.map(one => (one.id === id ? edit(one) : one)))
    }
  }

  return {
    setConversations(service: string, list: Conversation[]): void {
      conversations.set(
        service,
        list.map(one => ({ ...one, name: strip(one.name), preview: one.preview === undefined ? undefined : strip(one.preview) })),
      )
    },

    // The conversation's own record, when the service listed it.
    entryOf(ref: Ref): Conversation | undefined {
      return conversations.get(ref.service)?.find(one => one.id === ref.conversation)
    },

    // One service's conversations, or with none named every service's, most
    // recent first.
    list(service?: string): Entry[] {
      const services = service === undefined ? [...conversations.keys()] : [service]

      return services
        .flatMap(id => (conversations.get(id) ?? []).map(one => ({ ...one, ref: { service: id, conversation: one.id } })))
        .sort((a, b) => b.at - a.at)
    },

    nameOf(ref: Ref): string {
      return conversations.get(ref.service)?.find(one => one.id === ref.conversation)?.name ?? ref.conversation
    },

    isLoaded(ref: Ref): boolean {
      return messages.has(keyOf(ref))
    },

    setHistory(ref: Ref, list: Message[]): void {
      messages.set(keyOf(ref), list.map(clean).slice(-KEEP))
    },

    // Older messages, fetched on request, in front of what is held; the
    // KEEP limit gives way, since the person asked to see further back.
    prependHistory(ref: Ref, list: Message[]): number {
      const held = messages.get(keyOf(ref)) ?? []
      const fresh = list.map(clean).filter(one => !held.some(other => other.id === one.id))
      messages.set(keyOf(ref), [...fresh, ...held])

      return fresh.length
    },

    messages(ref: Ref): Message[] {
      return messages.get(keyOf(ref)) ?? []
    },

    // The newest message held for a conversation, for its row's preview.
    lastOf(ref: Ref): Message | undefined {
      return messages.get(keyOf(ref))?.at(-1)
    },

    // Takes one update in. Answers the message when it is one not seen before,
    // so the caller can count and announce it.
    apply(service: string, update: Update): Message | undefined {
      switch (update.kind) {
        case 'message': {
          const message = clean(update.message)
          const key = keyOf({ service, conversation: message.conversation })
          const list = messages.get(key)
          if (list?.some(one => one.id === message.id)) {
            return undefined
          }
          if (list) {
            messages.set(key, [...list, message].slice(-KEEP))
          }

          return message
        }
        case 'edit': {
          const message = clean(update.message)
          change({ service, conversation: message.conversation }, message.id, old => ({
            ...message,
            reactions: message.reactions ?? old.reactions,
          }))

          return undefined
        }
        case 'delete':
          change({ service, conversation: update.conversation }, update.id, old => ({ ...old, isDeleted: true, parts: [] }))

          return undefined
        case 'reaction':
          change({ service, conversation: update.conversation }, update.id, old => ({ ...old, reactions: update.reactions }))

          return undefined
        case 'read':
          // Read somewhere else: nothing left to announce here.
          unread.delete(keyOf({ service, conversation: update.conversation }))

          return undefined
        default:
          return undefined
      }
    },

    bump(ref: Ref): void {
      unread.set(keyOf(ref), (unread.get(keyOf(ref)) ?? 0) + 1)
    },

    markSeen(ref: Ref): void {
      unread.delete(keyOf(ref))
    },

    unread(ref: Ref): number {
      return unread.get(keyOf(ref)) ?? 0
    },

    unreadOf(service?: string): number {
      let total = 0
      for (const [key, count] of unread) {
        if (service === undefined || key.startsWith(`${service}\u0000`)) {
          total += count
        }
      }

      return total
    },
  }
}
