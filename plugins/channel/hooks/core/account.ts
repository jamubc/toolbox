import { NeedsSetup, reasonOf } from './contract'
import type { Conversation, Health, Provider, ProviderSpec, Settings, Tools, Update } from './contract'
import { fence } from './fence'

// One running service: checked, connected, and fed. Each account keeps its own
// loop and its own backoff, so a service in trouble never slows another.

const MAX_BACKOFF_MS = 300_000
const LIVE_RETRY_MS = 5_000

export type Clock = { now: () => Promise<number>; after: (ms: number, fn: () => void) => { cancel: () => void } }

export type AccountDeps = {
  // Unfenced: the account fences them to the spec's reach.
  tools: Tools
  settings: Settings
  clock: Clock
  isShown: () => Promise<boolean>
}

export type Sink = {
  conversations: (list: Conversation[]) => void
  updates: (list: Update[]) => Promise<void>
  changed: () => void
}

export type Account = {
  spec: ProviderSpec
  health: Health
  problem: string | null
  provider?: Provider
  start: () => Promise<void>
  // Look for news now: the person is watching.
  poke: () => void
  stop: () => void
}

export function createAccount(spec: ProviderSpec, deps: AccountDeps, sink: Sink): Account {
  const tools = fence(spec.reach, deps.tools)
  let timer: { cancel: () => void } | undefined
  let cursor: string | undefined
  let isBusy = false
  let isStopped = false
  let isListed = false
  let backoffMs = 0

  function recovered(): void {
    backoffMs = 0
    account.problem = null
    if (account.health.state === 'setup') {
      account.health = { state: 'ready' }
    }
  }

  async function deliver(provider: Provider, updates: Update[]): Promise<void> {
    await sink.updates(updates)
    if (updates.some(one => one.kind === 'message')) {
      // A new message moves its conversation to the top, or brings a new one.
      sink.conversations(await provider.conversations())
    }
  }

  // One pass at a time, each scheduling the next: fast while the pane shows,
  // slow behind it, backing off on errors.
  async function pass(): Promise<void> {
    const provider = account.provider
    if (isBusy || isStopped || !provider) {
      return
    }
    isBusy = true
    timer?.cancel()
    const feed = provider.feed
    let nextMs: number
    try {
      if (!isListed) {
        sink.conversations(await provider.conversations())
        isListed = true
      }
      if (feed.kind === 'polled') {
        const news = await feed.since(cursor)
        cursor = news.cursor
        await deliver(provider, news.updates)
        recovered()
        nextMs = (await deps.isShown()) ? feed.openMs : feed.closedMs
      } else {
        for await (const update of feed.updates()) {
          if (isStopped) {
            break
          }
          recovered()
          await deliver(provider, [update])
          sink.changed()
        }
        throw new Error('the connection closed')
      }
    } catch (error) {
      const floor = feed.kind === 'polled' ? feed.closedMs : LIVE_RETRY_MS
      backoffMs = Math.min(Math.max(backoffMs * 2, floor), MAX_BACKOFF_MS)
      nextMs = backoffMs
      if (error instanceof NeedsSetup) {
        account.health = error.health
        account.problem = null
      } else {
        account.problem = `${spec.label}: ${reasonOf(error)}`
      }
    } finally {
      isBusy = false
    }
    sink.changed()
    if (!isStopped) {
      timer = deps.clock.after(nextMs, () => void pass())
    }
  }

  const account: Account = {
    spec,
    health: { state: 'off' },
    problem: null,

    async start() {
      try {
        account.health = await spec.check(tools, deps.settings)
      } catch (error) {
        account.health = { state: 'unavailable', reason: reasonOf(error) }
      }
      sink.changed()
      if (account.health.state === 'ready' && !isStopped) {
        account.provider = spec.connect(tools, deps.settings)
        await pass()
      }
    },

    poke() {
      if (account.provider) {
        void pass()
      } else if (account.health.state === 'setup') {
        // The person may have just done what was asked.
        void account.start()
      }
    },

    stop() {
      isStopped = true
      timer?.cancel()
    },
  }

  return account
}
