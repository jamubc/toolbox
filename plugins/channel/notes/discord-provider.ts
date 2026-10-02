// Parked, not loaded: a Discord provider written against an earlier, single-channel
// version of the contract in hooks/providers/chat.ts. Bot tokens only. See IDEA.md.

import { RateLimited } from './chat'
import type { ProviderSpec } from './chat'

// A bot token only: the bot reads the channels it was added to and posts as
// itself. Driving a person's own account with its token breaks Discord's terms.

const BASE = 'https://discord.com/api/v10/'
// Plain messages and replies; joins, pins, boosts and the rest are notices.
const SHOWN_TYPES = new Set([0, 19])
const NO_CONTENT = '[no text: turn on the Message Content intent for this bot]'

type DiscordUser = { id: string; username: string; global_name?: string | null }

type DiscordMessage = {
  id: string
  type: number
  content: string
  timestamp: string
  author: DiscordUser
  mentions?: DiscordUser[]
  attachments?: unknown[]
  embeds?: unknown[]
}

function nameOf(user: DiscordUser): string {
  return user.global_name || user.username
}

function markup(raw: string, mentions: readonly DiscordUser[]): string {
  const names = new Map(mentions.map(user => [user.id, nameOf(user)]))

  return raw
    .replace(/<@!?(\d+)>/g, (_, id: string) => `@${names.get(id) ?? id}`)
    .replace(/<@&\d+>/g, '@role')
    .replace(/<#\d+>/g, '#channel')
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
}

// Snowflakes outgrow a double; compared as BigInts they sort by time.
function bySnowflake(a: DiscordMessage, b: DiscordMessage): number {
  const x = BigInt(a.id)
  const y = BigInt(b.id)

  return x < y ? -1 : x > y ? 1 : 0
}

export const discord: ProviderSpec = {
  label: 'Discord',
  base: BASE,
  connect(http, { token, channel, userId }) {
    async function call(path: string, body?: unknown): Promise<unknown> {
      // The channel is spliced into the path: digits only, or it could walk elsewhere.
      if (!/^\d{5,25}$/.test(channel)) {
        throw new Error('channel must be a Discord channel ID (digits only)')
      }
      const res = await http(BASE + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bot ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      let parsed: unknown = null
      try {
        parsed = res.text ? JSON.parse(res.text) : null
      } catch {
        // Some errors are not JSON; the status says enough.
      }
      if (res.status === 429) {
        const seconds = Number((parsed as { retry_after?: number } | null)?.retry_after ?? res.headers['retry-after'] ?? 5)
        throw new RateLimited(Math.ceil(seconds * 1000))
      }
      if (!res.ok) {
        const message = (parsed as { message?: string } | null)?.message
        throw new Error(message ? `${message} (HTTP ${res.status})` : `HTTP ${res.status}`)
      }

      return parsed
    }

    return {
      async channelName() {
        const info = (await call(`channels/${channel}`)) as { name?: string }

        return info.name ?? channel
      },

      async history(after) {
        const list = (await call(`channels/${channel}/messages?limit=50${after ? `&after=${after}` : ''}`)) as DiscordMessage[]

        return list
          .filter(one => SHOWN_TYPES.has(one.type))
          .sort(bySnowflake)
          .map(one => ({
            id: one.id,
            at: Date.parse(one.timestamp),
            sender: nameOf(one.author),
            text: one.content
              ? markup(one.content, one.mentions ?? [])
              : one.attachments?.length || one.embeds?.length
                ? '[attachment]'
                : NO_CONTENT,
            isMention: userId !== '' && one.author.id !== userId && (one.mentions ?? []).some(user => user.id === userId),
          }))
      },

      async send(text) {
        // Nothing typed here pings anyone: no @everyone, roles or users.
        await call(`channels/${channel}/messages`, { content: text, allowed_mentions: { parse: [] } })
      },
    }
  },
}
