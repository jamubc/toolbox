// Parked, not loaded: the Slack provider, cut from the iMessage-first release.
// It needs Http and RateLimited back in hooks/providers/chat.ts. See IDEA.md.

import { RateLimited } from './chat'
import type { Incoming, ProviderSpec } from './chat'

const BASE = 'https://slack.com/api/'
const SHOWN_SUBTYPES = new Set(['bot_message', 'me_message', 'thread_broadcast', 'file_share'])

type SlackMessage = {
  ts: string
  user?: string
  username?: string
  subtype?: string
  text?: string
}

function markup(raw: string, names: ReadonlyMap<string, string>): string {
  return raw
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => `@${label || names.get(id) || id}`)
    .replace(/<#[CG][A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<((?:https?|mailto):[^>]+)>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

// Slack reads &, < and > as markup: escaped, a typed <!channel> stays text.
function escapeOutgoing(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export const slack: ProviderSpec = {
  label: 'Slack',
  needsToken: true,
  base: BASE,
  openMs: 5_000,
  closedMs: 30_000,
  connect({ http }, { token, channel }) {
    const names = new Map<string, string>()
    let me = ''

    async function call(method: string, params: Record<string, string>, isPost = false): Promise<Record<string, unknown>> {
      const auth = { Authorization: `Bearer ${token}` }
      const query = Object.entries(params)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&')
      const res = isPost
        ? await http(BASE + method, {
            method: 'POST',
            headers: { ...auth, 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify(params),
          })
        : await http(`${BASE}${method}${query ? `?${query}` : ''}`, { headers: auth })
      if (res.status === 429) {
        throw new RateLimited(Number(res.headers['retry-after'] ?? 30) * 1000)
      }
      let body: Record<string, unknown>
      try {
        body = JSON.parse(res.text) as Record<string, unknown>
      } catch {
        throw new Error(`HTTP ${res.status}`)
      }
      // Slack reports most failures as HTTP 200 with ok: false.
      if (body.ok !== true) {
        throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${res.status}`)
      }

      return body
    }

    async function nameOf(id: string): Promise<string> {
      const known = names.get(id)
      if (known) {
        return known
      }
      try {
        const { user } = (await call('users.info', { user: id })) as {
          user?: { name?: string; profile?: { display_name?: string; real_name?: string } }
        }
        names.set(id, user?.profile?.display_name || user?.profile?.real_name || user?.name || id)
      } catch {
        names.set(id, id)
      }

      return names.get(id) ?? id
    }

    async function history(params: Record<string, string>): Promise<Incoming[]> {
      if (!me) {
        me = String((await call('auth.test', {})).user_id ?? '')
      }
      const { messages } = (await call('conversations.history', { channel, ...params })) as { messages?: SlackMessage[] }
      const shown = (messages ?? []).filter(one => !one.subtype || SHOWN_SUBTYPES.has(one.subtype)).reverse()

      const incoming: Incoming[] = []
      for (const one of shown) {
        const raw = one.text ?? ''
        for (const [, id] of raw.matchAll(/<@([UW][A-Z0-9]+)>/g)) {
          if (id) {
            await nameOf(id)
          }
        }
        incoming.push({
          id: one.ts,
          conversation: channel,
          at: Number(one.ts) * 1000,
          sender: one.user ? await nameOf(one.user) : (one.username ?? 'bot'),
          text: markup(raw, names),
          isFromMe: me !== '' && one.user === me,
          isAlert: me !== '' && one.user !== me && raw.includes(`<@${me}>`),
        })
      }

      return incoming
    }

    // One configured channel is the whole list of conversations.
    return {
      async conversations() {
        const { channel: info } = (await call('conversations.info', { channel })) as { channel?: { name?: string } }

        return [{ id: channel, name: `#${info?.name ?? channel}` }]
      },

      recent: () => history({ limit: '50' }),

      async since(cursor) {
        if (cursor === undefined) {
          const [newest] = await history({ limit: '1' })
          return { messages: [], cursor: newest?.id ?? '0' }
        }
        const messages = await history({ limit: '50', oldest: cursor })

        return { messages, cursor: messages.at(-1)?.id ?? cursor }
      },

      async send(_conversation, text) {
        await call('chat.postMessage', { channel, text: escapeOutgoing(text) }, true)
      },
    }
  },
}
