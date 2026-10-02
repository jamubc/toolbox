import { textOf } from './contract'
import type { Message, Ref } from './contract'
import { keyOf } from './inbox'

// What deserves the person's attention, without flooding them. Every Claude
// session on the machine runs this mod, so the sessions share one lease in the
// store and only its holder toasts; a burst folds into one toast; and a
// conversation toasts at most once in a while.

const LEASE = 'notifier'
const STALE_MS = 30_000
const QUIET_MS = 10_000
const MAX_TOASTS = 3

type Lease = { session: string; at: number }

export type NotifierDeps = {
  toast: (text: string) => void
  status: (text: string | undefined) => void
  store: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
    delete: (key: string) => Promise<void>
  }
  session: string
  now: () => Promise<number>
  // The services that are ready, as { id, label }.
  services: () => { id: string; label: string }[]
  nameOf: (ref: Ref) => string
  unreadOf: (service: string) => number
}

export type Notifier = ReturnType<typeof createNotifier>

export function createNotifier(deps: NotifierDeps) {
  const lastToast = new Map<string, number>()
  let target: Ref | undefined
  let previous: Ref | undefined

  async function held(): Promise<Lease | undefined> {
    const lease = (await deps.store.get(LEASE)) as Lease | undefined

    return lease && typeof lease.session === 'string' ? lease : undefined
  }

  // Whether this session is the one that toasts, taking or renewing the lease
  // when it may. The store has no compare-and-set, so it reads back what it
  // wrote: two claimants settle on whoever wrote last.
  async function holds(): Promise<boolean> {
    const lease = await held()
    const now = await deps.now()
    if (lease && lease.session !== deps.session && now - lease.at < STALE_MS) {
      return false
    }
    await deps.store.set(LEASE, { session: deps.session, at: now })

    return (await held())?.session === deps.session
  }

  function showStatus(): void {
    const counts = deps
      .services()
      .map(one => ({ label: one.label, count: deps.unreadOf(one.id) }))
      .filter(one => one.count > 0)
    deps.status(counts.length > 0 ? `${counts.map(one => `${one.label} ${one.count}`).join(' · ')} new` : undefined)
  }

  return {
    showStatus,

    // The person turned to this session: it takes the lease outright.
    async claim(): Promise<void> {
      await deps.store.set(LEASE, { session: deps.session, at: await deps.now() })
    },

    async release(): Promise<void> {
      if ((await held())?.session === deps.session) {
        await deps.store.delete(LEASE)
      }
    },

    // One feed pass of one service: `fresh` are its new messages from other
    // people that the person is not looking at.
    async pass(service: string, fresh: Message[]): Promise<void> {
      showStatus()
      const isHolder = await holds()
      const now = await deps.now()
      const groups = new Map<string, Message[]>()
      for (const one of fresh) {
        const key = keyOf({ service, conversation: one.conversation })
        if (one.isAlert && now - (lastToast.get(key) ?? -QUIET_MS) >= QUIET_MS) {
          groups.set(key, [...(groups.get(key) ?? []), one])
        }
      }
      if (groups.size === 0) {
        return
      }
      for (const key of groups.keys()) {
        lastToast.set(key, now)
      }
      const last = [...groups.values()].at(-1)?.at(-1)
      if (last) {
        target = { service, conversation: last.conversation }
      }
      if (!isHolder) {
        return
      }

      const services = deps.services()
      const prefix = services.length > 1 ? `${services.find(one => one.id === service)?.label ?? service} · ` : ''
      if (groups.size > MAX_TOASTS) {
        const total = [...groups.values()].reduce((sum, list) => sum + list.length, 0)
        deps.toast(`${prefix}${total} new messages in ${groups.size} chats`)

        return
      }
      for (const list of groups.values()) {
        const [first] = list
        if (!first) {
          continue
        }
        const name = deps.nameOf({ service, conversation: first.conversation })
        if (list.length > 1) {
          deps.toast(`${prefix}${name}: ${list.length} new messages`)
        } else {
          const who = name === first.sender.name ? name : `${name} · ${first.sender.name}`
          deps.toast(`${prefix}${who}: ${textOf(first).slice(0, 80)}`)
        }
      }
    },

    // Where the latest notification leads, and where the person was before
    // they followed one.
    target: () => target,
    previous: () => previous,
    jump(from: Ref | undefined): Ref | undefined {
      const to = target
      if (to) {
        previous = from
        target = undefined
      }

      return to
    },
    jumpBack(): Ref | undefined {
      const to = previous
      previous = undefined

      return to
    },
  }
}
