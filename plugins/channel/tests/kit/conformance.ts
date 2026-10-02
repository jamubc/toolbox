import type { ProviderSpec, Settings, Tools } from '../../hooks/core/contract'
import { fence } from '../../hooks/core/fence'

// What every provider must hold to, whatever its service. Answers the list of
// what it broke: a passing provider answers [].
export async function conformance(spec: ProviderSpec, raw: Tools, settings: Settings): Promise<string[]> {
  const broken: string[] = []
  const started: string[] = []
  const tools = fence(spec.reach, {
    ...raw,
    run: argv => {
      started.push(argv[0] ?? '')

      return raw.run(argv)
    },
  })

  const health = await spec.check(tools, settings)
  if (health.state !== 'ready') {
    return [`check answered ${health.state}, not ready`]
  }
  const provider = spec.connect(tools, settings)

  const conversations = await provider.conversations()
  if (conversations.some(one => !one.id || !one.name || !Number.isFinite(one.at))) {
    broken.push('a conversation lacks an id, a name or a time')
  }
  if (conversations.some((one, i) => i > 0 && one.at > (conversations[i - 1]?.at ?? 0))) {
    broken.push('conversations are not most recent first')
  }

  for (const one of conversations) {
    const history = await provider.history(one.id)
    if (history.some((message, i) => i > 0 && message.at < (history[i - 1]?.at ?? 0))) {
      broken.push(`history of ${one.id} is not oldest first`)
    }
    if (new Set(history.map(message => message.id)).size !== history.length) {
      broken.push(`history of ${one.id} repeats an id`)
    }
    if (history.some(message => message.conversation !== one.id || !Array.isArray(message.parts) || !message.sender.id)) {
      broken.push(`a message of ${one.id} is malformed`)
    }
  }

  if (provider.feed.kind === 'polled') {
    const first = await provider.feed.since(undefined)
    if (first.updates.length > 0) {
      broken.push('since() with no cursor answered updates: what is already there is not news')
    }
    const second = await provider.feed.since(first.cursor)
    if (second.updates.length > 0 || second.cursor !== first.cursor) {
      broken.push('since() with nothing new answered updates or moved its cursor')
    }
  }

  const allowed = spec.reach.commands ?? []
  if (started.some(one => !allowed.includes(one))) {
    broken.push('started a command outside its reach')
  }

  return broken
}
