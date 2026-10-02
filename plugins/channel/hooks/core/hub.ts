import { reasonOf, textOf } from './contract'
import type { Attachment, Health, Message, ProviderSpec, Provider, Ref, Settings, Tools } from './contract'
import { createAccount } from './account'
import type { Account, Clock } from './account'
import { createInbox } from './inbox'
import type { Entry } from './inbox'
import { createNotifier } from './notify'
import type { NotifierDeps } from './notify'
import type { Picture } from '../ui/picture'

// The one object register.tsx and the pane talk to: every service's account,
// the inbox they fill, the notifier, and what the person has selected.

export const ALL = 'all'
// Conversations a tab lists; the first nine get a hotkey.
const ROWS = 20
// Thumbnails kept in memory.
export const PICTURES = 12
// Older messages fetched per press of "older".
const OLDER_PAGE = 50
// Image draws refused before pictures fall back to cells for the session.
const DENIES_BEFORE_CELLS = 3

export type HubDeps = {
  tools: Tools
  settings: Settings
  clock: Clock
  isShown: () => Promise<boolean>
  toast: NotifierDeps['toast']
  status: NotifierDeps['status']
  store: NotifierDeps['store']
  session: string
  redraw: () => void
  // Opens a file with the system's own app for it.
  openPath: (path: string) => Promise<void>
  // A small copy of a picture file, or nothing when it cannot be made.
  // `slot` is one of PICTURES places it may keep the copy in; `asPixels` asks
  // for a sharp file the terminal reads itself, else a small bitmap for cells.
  thumbnail: (path: string, slot: number, asPixels: boolean) => Promise<Picture | undefined>
  // Whether the terminal draws real pixels; otherwise pictures are cells.
  // 'off' draws no pictures at all.
  pictures: 'pixels' | 'cells' | 'off'
  // Whether the terminal did draw the Image under `key`: false when it drew
  // the alt text instead, so pictures should fall back to cells.
  probe: (key: string, source: { file: string; generation: number }) => Promise<boolean>
  // Writes into the person's prompt box as a draft; false when it could not.
  toPrompt: (text: string) => Promise<boolean>
  copy: (text: string) => Promise<boolean>
  // What this Claude session can offer a chat: the files it touched, newest
  // first, and Claude's last reply.
  offers: () => Promise<Offers>
}

export type Offers = { files: string[]; lastReply: string }

export type Tab = { id: string; label: string; unread: number; isSelected: boolean; health: Health }

export type View = {
  tab: string
  selected?: Ref
  isAttaching: boolean
  problem: string | null
  // How many acts have finished, and what to say about the last one.
  sent: number
  note: string
  // What the reply box starts with: Claude's last reply, when the person asked.
  draft: string
  offers: Offers
  // How many more rows of history than fit the person asked to see.
  depth: number
  // Whether the oldest message held is the first the service has.
  isAtStart: boolean
}

export type Hub = ReturnType<typeof createHub>

function isSame(a: Ref | undefined, b: Ref): boolean {
  return a !== undefined && a.service === b.service && a.conversation === b.conversation
}

export function createHub(specs: readonly ProviderSpec[], deps: HubDeps) {
  const inbox = createInbox()
  const view: View = {
    tab: ALL, isAttaching: false, problem: null, sent: 0, note: '', draft: '', offers: { files: [], lastReply: '' }, depth: 0, isAtStart: false,
  }
  let pictureMode = deps.pictures
  let imageDenies = 0

  // Services the person can see: ready, or waiting on them.
  const shown = (): Account[] => accounts.filter(one => one.health.state === 'ready' || one.health.state === 'setup')

  const notifier = createNotifier({
    toast: deps.toast,
    status: deps.status,
    store: deps.store,
    session: deps.session,
    now: deps.clock.now,
    services: () => shown().map(one => ({ id: one.spec.id, label: one.spec.label })),
    nameOf: ref => inbox.nameOf(ref),
    unreadOf: service => inbox.unreadOf(service),
  })

  function redraw(): void {
    notifier.showStatus()
    deps.redraw()
  }

  const accounts: Account[] = specs.map(spec =>
    createAccount(spec, deps, {
      conversations: list => inbox.setConversations(spec.id, list),
      changed: redraw,
      async updates(list) {
        const isShown = await deps.isShown()
        const fresh: Message[] = []
        for (const update of list) {
          const message = inbox.apply(spec.id, update)
          if (!message || message.sender.isMe) {
            continue
          }
          const ref = { service: spec.id, conversation: message.conversation }
          if (isShown && isSame(view.selected, ref)) {
            continue
          }
          inbox.bump(ref)
          fresh.push(message)
        }
        await notifier.pass(spec.id, fresh)
      },
    }),
  )

  function providerOf(ref: Ref | undefined): Provider | undefined {
    return ref && accounts.find(one => one.spec.id === ref.service)?.provider
  }

  function labelOf(service: string): string {
    return specs.find(one => one.id === service)?.label ?? service
  }

  async function open(ref: Ref): Promise<void> {
    view.selected = ref
    view.isAttaching = false
    view.problem = null
    view.depth = 0
    view.isAtStart = false
    inbox.markSeen(ref)
    redraw()
    if (inbox.isLoaded(ref)) {
      return
    }
    try {
      const provider = providerOf(ref)
      if (provider) {
        inbox.setHistory(ref, await provider.history(ref.conversation))
      }
    } catch (error) {
      view.problem = `${labelOf(ref.service)}: ${reasonOf(error)}`
    }
    redraw()
  }

  // Thumbnails by file, loaded on first draw. null: loading, or none to show.
  const pictures = new Map<string, Picture | null>()
  let loaded = 0

  async function loadPicture(key: string, ref: Ref, part: Attachment, element: string): Promise<void> {
    const slot = loaded % PICTURES
    loaded += 1
    const asPixels = pictureMode === 'pixels'
    const bitmap = await pathOf(ref, part)
      .then(path => deps.thumbnail(path, slot, asPixels))
      .catch(() => undefined)
    if (!bitmap || !pictures.has(key)) {
      return
    }
    pictures.set(key, bitmap)
    redraw()
    if ('file' in bitmap.source && pictureMode === 'pixels') {
      void probe(element, bitmap.source)
    }
  }

  // Asks the terminal whether it drew the picture as pixels. One that drew the
  // alt text instead (no kitty graphics after all) is counted; a few of those
  // and every picture is remade as cells, as the browse pane does with frames.
  async function probe(element: string, source: { file: string; generation: number }): Promise<void> {
    for (let attempt = 0; attempt < DENIES_BEFORE_CELLS; attempt += 1) {
      if (pictureMode !== 'pixels') {
        return
      }
      const isDrawn = await deps.probe(element, source).catch(() => true)
      if (isDrawn) {
        imageDenies = 0

        return
      }
      imageDenies += 1
      if (imageDenies >= DENIES_BEFORE_CELLS) {
        pictureMode = 'cells'
        pictures.clear()
        deps.toast('This terminal cannot show pictures as pixels; drawing them in colored blocks instead.')
        redraw()

        return
      }
    }
  }

  function done(note: string): void {
    view.sent += 1
    view.note = note
    view.problem = null
  }

  // A dragged or pasted path arrives quoted or with its spaces escaped.
  function unquote(path: string): string {
    const trimmed = path.trim()
    const inner = /^(['"])(.*)\1$/.exec(trimmed)?.[2]

    return inner ?? trimmed.replace(/\\(.)/g, '$1')
  }

  async function pathOf(ref: Ref, part: Attachment): Promise<string> {
    const path = part.path ?? (await providerOf(ref)?.attachments?.fetch(part.handle))?.path
    if (!path) {
      throw new Error('that file is not on this machine')
    }

    return path
  }

  // Runs one act on a received file and reports how it went.
  async function withFile(ref: Ref, part: Attachment, verb: string, what: (path: string) => Promise<string>): Promise<void> {
    try {
      done(await what(await pathOf(ref, part)))
    } catch (error) {
      view.problem = `Not ${verb}: ${reasonOf(error)}`
    }
    redraw()
  }

  // Runs one outgoing act and reports how it went.
  async function act(what: (provider: Provider, conversation: string) => Promise<void>): Promise<void> {
    const ref = view.selected
    const provider = providerOf(ref)
    if (!ref || !provider) {
      return
    }
    try {
      await what(provider, ref.conversation)
      done('Sent.')
      view.isAttaching = false
      view.draft = ''
    } catch (error) {
      view.problem = `Not sent: ${reasonOf(error)}`
    }
    redraw()
    accounts.find(one => one.spec.id === ref.service)?.poke()
  }

  return {
    view,
    inbox,
    notifier,
    accounts,
    providerOf,
    labelOf,
    open,

    async start(): Promise<void> {
      await Promise.all(accounts.map(one => one.start()))
    },

    async stop(): Promise<void> {
      for (const one of accounts) {
        one.stop()
      }
      await notifier.release()
    },

    // The person opened the pane here: this session toasts from now on.
    async attend(): Promise<void> {
      await notifier.claim()
      if (view.selected) {
        inbox.markSeen(view.selected)
      }
      redraw()
      for (const one of accounts) {
        one.poke()
      }
    },

    // One tab per visible service, behind an All tab when there are several.
    tabs(): Tab[] {
      const services = shown()
      const ids = services.map(one => one.spec.id)
      if (services.length < 2 ? view.tab !== ids[0] : view.tab !== ALL && !ids.includes(view.tab)) {
        view.tab = services.length < 2 ? (ids[0] ?? ALL) : ALL
      }
      const tabs: Tab[] = services.map(one => ({
        id: one.spec.id,
        label: one.spec.label,
        unread: inbox.unreadOf(one.spec.id),
        isSelected: view.tab === one.spec.id,
        health: one.health,
      }))

      return services.length < 2
        ? tabs
        : [{ id: ALL, label: 'All', unread: inbox.unreadOf(), isSelected: view.tab === ALL, health: { state: 'ready' } }, ...tabs]
    },

    selectTab(id: string): void {
      view.tab = id
      redraw()
    },

    // The conversations of the selected tab.
    rows(): Entry[] {
      return inbox.list(view.tab === ALL ? undefined : view.tab).slice(0, ROWS)
    },

    // One line for a conversation's row: its newest message held here, else
    // what the service said when it listed it.
    previewOf(entry: Entry): string {
      const last = inbox.lastOf(entry.ref)
      if (last) {
        const text = textOf(last)

        return last.sender.isMe ? `You: ${text}` : text
      }

      return entry.preview ?? ''
    },

    // Further back in the open conversation: more of what is held, and when
    // that runs out, another page from the service.
    async older(bodyRows: number): Promise<void> {
      const ref = view.selected
      const provider = providerOf(ref)
      if (!ref || !provider) {
        return
      }
      view.depth += Math.max(4, bodyRows - 2)
      redraw()
      const oldest = inbox.messages(ref)[0]
      if (view.isAtStart || !oldest) {
        return
      }
      try {
        const page = await provider.history(ref.conversation, { before: oldest.id, limit: OLDER_PAGE })
        const added = inbox.prependHistory(ref, page)
        if (added === 0) {
          view.isAtStart = true
        }
      } catch (error) {
        view.problem = `${labelOf(ref.service)}: ${reasonOf(error)}`
      }
      redraw()
    },

    latest(): void {
      view.depth = 0
      redraw()
    },

    problems(): string[] {
      return [...accounts.map(one => one.problem), view.problem].filter((one): one is string => one !== null)
    },

    back(): void {
      view.selected = undefined
      view.isAttaching = false
      redraw()
    },

    // Attach mode offers the files this Claude session touched.
    async toggleAttach(): Promise<void> {
      view.isAttaching = !view.isAttaching
      redraw()
      if (view.isAttaching) {
        view.offers = await deps.offers().catch(() => ({ files: [], lastReply: '' }))
        redraw()
      }
    },

    // Claude's last reply, into the reply box for the person to edit and send.
    async draftLastReply(): Promise<void> {
      const { lastReply } = await deps.offers().catch(() => ({ lastReply: '' }))
      if (lastReply) {
        view.draft = lastReply
        view.isAttaching = false
        view.problem = null
      } else {
        view.problem = 'Claude has not replied yet in this session'
      }
      redraw()
    },

    async send(text: string): Promise<void> {
      const body = text.trim()
      if (body) {
        await act((provider, conversation) => provider.send(conversation, { text: body }))
      }
    },

    async sendFile(path: string): Promise<void> {
      const file = unquote(path)
      if (file) {
        await act(async (provider, conversation) => {
          if (!provider.attachments) {
            throw new Error('this service cannot send files')
          }
          await provider.attachments.send(conversation, file)
        })
      }
    },

    // Whether pictures draw at all, and how.
    pictureMode: () => pictureMode,

    // A picture's thumbnail once it is ready; asking starts it loading.
    // `element` is the key the view draws it under, for the probe.
    picture(ref: Ref, part: Attachment, element: string): Picture | undefined {
      if (pictureMode === 'off') {
        return undefined
      }
      const key = `${ref.service}\u0000${part.handle}`
      if (!pictures.has(key)) {
        if (pictures.size >= PICTURES) {
          const [oldest] = pictures.keys()
          if (oldest !== undefined) {
            pictures.delete(oldest)
          }
        }
        pictures.set(key, null)
        void loadPicture(key, ref, part, element)
      }

      return pictures.get(key) ?? undefined
    },

    openFile(ref: Ref, part: Attachment): Promise<void> {
      return withFile(ref, part, 'opened', async path => {
        await deps.openPath(path)

        return 'Opened.'
      })
    },

    // The file's path, into the person's prompt box as a draft. The person
    // sends it; only the path goes, never what the chat said.
    fileToClaude(ref: Ref, part: Attachment): Promise<void> {
      return withFile(ref, part, 'added', async path => {
        if (!(await deps.toPrompt(`${/\s/.test(path) ? `"${path}"` : path} `))) {
          throw new Error('the prompt box is not open')
        }

        return 'Added to your prompt.'
      })
    },

    copyFile(ref: Ref, part: Attachment): Promise<void> {
      return withFile(ref, part, 'copied', async path => {
        if (!(await deps.copy(path))) {
          throw new Error('the clipboard is not available here')
        }

        return 'Path copied.'
      })
    },

    // Follows the latest notification, and comes back from it.
    async jump(): Promise<void> {
      const to = notifier.jump(view.selected)
      if (to) {
        await open(to)
      }
    },

    async jumpBack(): Promise<void> {
      const to = notifier.jumpBack()
      if (to) {
        await open(to)
      }
    },
  }
}
