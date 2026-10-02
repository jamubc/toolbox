# channel foundation: design

Date: 2026-10-01. Status: approved with the changes of the second review. Scope: project 1 of 4.

## Purpose

channel puts your chats in Claude Code. Today it is one service (iMessage) wired
straight into one 315-line file. The goal is a mod where every major chat
service lives side by side, content moves between chats and the Claude session,
and two channel users can collaborate.

That is four projects, built in this order:

1. **Foundation** (this spec): a multi-provider core and a provider contract.
2. **UI**: switcher, cross-service notifications with jump and jump-back, a
   Claude Code-native look.
3. **Share in and out**: session content and files to chats; explicit pulls
   from chats into the session.
4. **Collaboration**: team share between two channel users.

This spec designs project 1 in full and fixes only the parts of 2 to 4 that the
foundation must not block.

## Success criteria

- iMessage keeps everything it does today on the new core, and gains
  everything its data allows: attachments in and out, replies, tapbacks,
  edited and unsent markers, and members.
- Service tabs are built and visible now, so the design can be tried and
  changed.
- A person is never flooded: one session toasts, and bursts are folded.
- Adding a service is one new folder under `hooks/providers/`, one line in the
  registry and its settings fields in `plugin.json`. No edit to core or UI.
- Several services run at once. One failing does not stop the others.
- A provider cannot reach anything it did not declare.
- The pane offers only what the selected service can do.
- `claude plugin validate`, `claude plugin test` and `tsc -p` all pass.

## Non-goals for project 1

- No new service. Slack, Discord and WhatsApp are unbuilt; the parked files on
  `feature/chat-providers` are reference only.
- No full UI redesign. Service tabs, attachments and the new message details
  are drawn now; the Claude Code-native restyle is project 2.
- No path from chat content to the model. That arrives in project 3.

## Decisions already made

- Services are built into the one plugin, one folder each (option A).
- The contract models everything the services can do: text, attachments,
  threads and replies, reactions, edits and deletes, mentions, read state,
  typing and presence.
- Optional features are capability objects on the provider.

## Layout

```
plugins/channel/
├── .claude-plugin/plugin.json      userConfig: one group of fields per service
├── hooks/
│   ├── hooks.json
│   ├── register.tsx                wiring only: commands, session events, render hooks
│   ├── core/
│   │   ├── contract.ts             every type a provider and the UI share
│   │   ├── registry.ts             the list of services, one line each
│   │   ├── fence.ts                run, fetch and spawn limited to a service's declared reach
│   │   ├── account.ts              one running service: connect, feed loop, backoff, health
│   │   ├── hub.ts                  the one object register and the UI talk to: accounts, inbox, notifier, view
│   │   ├── inbox.ts                conversations, messages and unread across all accounts
│   │   └── notify.ts               toasts, status line, jump target and jump-back
│   ├── ui/
│   │   ├── pane.tsx                the Pane render hook: routes to a view
│   │   ├── list.tsx                the conversation list and service switcher
│   │   ├── conversation.tsx        one conversation and its reply box
│   │   └── format.ts               time, names, wrapping, control-character stripping
│   └── providers/
│       └── imessage/
│           ├── index.ts            the ProviderSpec
│           └── queries.ts          the SQL and row mapping
└── tests/
    ├── kit/fake.ts                 a scriptable in-memory provider
    ├── kit/conformance.ts          the checks every provider must pass
    ├── kit/mac.ts                  a fake Messages database and Messages app
    ├── core.test.ts                account, inbox, notify, fence with fake providers
    ├── pane.test.ts                the pane on terminal and desktop
    └── imessage.test.ts            iMessage against the mocked macOS, plus conformance
```

Each file has one job and depends only downward: `providers/*` and `ui/*` both
import `core/contract.ts`; neither imports the other. `register.tsx` is the only
file that touches `$` for wiring.

## The provider contract (`core/contract.ts`)

### Identity

Every conversation is addressed by a `Ref`, so two services can never collide:

```ts
type Ref = { service: string; conversation: string }
```

### Messages

A message is a list of parts, so one shape holds text, files and what project 3
shares:

```ts
type Part =
  | { kind: 'text'; text: string }
  | { kind: 'file'; name: string; mime: string; bytes?: number; handle: string; path?: string }
  | { kind: 'image'; name: string; mime: string; bytes?: number; handle: string; path?: string }
  | { kind: 'link'; url: string; title?: string }

type Person = { id: string; name: string; isMe: boolean }

type Message = {
  id: string                 // orders messages within one service
  conversation: string
  at: number                 // ms since the epoch
  sender: Person
  parts: Part[]
  replyTo?: string           // the message this one answers
  thread?: string            // the thread it belongs to
  editedAt?: number
  isDeleted?: boolean
  reactions?: { emoji: string; count: number; isMine: boolean }[]
  mentionsMe?: boolean
  isAlert: boolean           // deserves a toast when it arrives unseen
}
```

`path` is set when the bytes are already a file on this machine. `handle` is opaque to the core. Only the provider that issued it can turn it
into bytes, through its `attachments` capability.

### Updates

Whatever changes arrives as an `Update`, whether polled or pushed:

```ts
type Update =
  | { kind: 'message'; message: Message }
  | { kind: 'edit'; message: Message }
  | { kind: 'delete'; conversation: string; id: string }
  | { kind: 'reaction'; conversation: string; id: string; reactions: Message['reactions'] }
  | { kind: 'read'; conversation: string; upTo: string }
  | { kind: 'typing'; conversation: string; who: Person; isTyping: boolean }
  | { kind: 'presence'; who: Person; isOnline: boolean }
```

### The required core

Every provider implements this and nothing more:

```ts
type Provider = {
  conversations(): Promise<Conversation[]>                    // most recent first; Conversation = { id, name, at }
  history(conversation: string, page?: { before?: string; limit?: number }): Promise<Message[]>
  feed: Polled | Live
  send(conversation: string, draft: Draft): Promise<void>     // Draft = { text: string; replyTo?: string }

  // Optional capabilities. Present means supported.
  attachments?: { send(conversation: string, path: string): Promise<void>
                  fetch(handle: string): Promise<{ path: string }> }
  threads?:     { replies(conversation: string, thread: string): Promise<Message[]> }
  reactions?:   { set(conversation: string, id: string, emoji: string, on: boolean): Promise<void> }
  edits?:       { edit(conversation: string, id: string, text: string): Promise<void>
                  remove(conversation: string, id: string): Promise<void> }
  readState?:   { markRead(conversation: string, upTo: string): Promise<void> }
  typing?:      { set(conversation: string, isTyping: boolean): Promise<void> }
  members?:     { of(conversation: string): Promise<Person[]> }
  search?:      { find(text: string): Promise<Message[]> }
}

type Polled = { kind: 'polled'; openMs: number; closedMs: number
                since(cursor: string | undefined): Promise<{ updates: Update[]; cursor: string }> }
type Live   = { kind: 'live'; updates(): AsyncIterable<Update> }
```

The UI asks `provider.reactions ? … : nothing`. A provider cannot claim a
feature without implementing it, and a new capability touches no existing
provider.

### The spec a service registers

```ts
type ProviderSpec = {
  id: string                         // 'imessage'
  label: string                      // 'iMessage'
  surfaces: readonly ('terminal' | 'desktop')[]
  reach: {
    commands?: readonly string[]     // absolute paths `run` may start
    hosts?: readonly string[]        // hosts `fetch` may call
    helper?: readonly string[]       // argv of the one streamed process `spawn` may start
  }
  // Is this service set up, and if not, what should the person do?
  check(tools: Tools, settings: Settings): Promise<Health>
  connect(tools: Tools, settings: Settings): Provider
}

type Health =
  | { state: 'ready' }
  | { state: 'off' }                                   // not turned on; show nothing
  | { state: 'setup'; summary: string; steps: string[] }   // on, but needs the person
  | { state: 'unavailable'; reason: string }           // cannot work here, e.g. not macOS

type Tools = { run: Run; fetch: Fetch; spawn: Spawn }  // already fenced to `reach`
type Settings = { home: string; app: string; surface: string; options: Record<string, unknown> }
```

`setup` replaces free-text error strings. The Full Disk Access message becomes
a `summary` and numbered `steps`, which project 2 can draw properly.

### Registry (`core/registry.ts`)

```ts
export const services: readonly ProviderSpec[] = [imessage]
```

This is the only place a new service is named outside its own folder.

## Core modules

### `fence.ts`

Builds a `Tools` for one spec. `run` refuses any executable outside
`reach.commands`; `fetch` refuses any host outside `reach.hosts` and any scheme
but https; `spawn` refuses any argv but `reach.helper`. A tool whose list is
empty always refuses. This replaces `guardRun` in `chat.ts`.

### `account.ts`

One running service. It owns:

- **Lifecycle:** `check` → `connect` → feed. A service that is `off`,
  `setup` or `unavailable` never connects.
- **The feed loop:** for `polled`, one request at a time, each scheduling the
  next: `openMs` while the pane shows, `closedMs` behind it. For `live`, one
  loop over `updates()`, restarted with backoff when it ends.
- **Backoff:** doubling from `closedMs` to a 5-minute ceiling, reset on
  success. Kept per account, so one broken service never slows another.
- **Health:** the current `Health`, plus the last error as a `setup` or a
  plain problem line.

This is today's `connect`, `poll` and `pollNow`, moved and made per-service.

### `inbox.ts`

The one store the UI reads. It merges every account into:

- conversations across services, most recent first, each carrying its `Ref`;
- messages per `Ref`, capped at 200, kept in module memory only;
- unread counts per `Ref` and per service.

It applies each `Update`: append, replace on edit, mark deleted, set reactions,
advance read state. It strips control characters from every string that came
from a service, once, here, so no view can forget to.

### `notify.ts`

Decides what deserves attention and where it leads, without flooding:

- **One session toasts.** Every Claude session on the machine runs the mod, so
  without care one text makes a toast in each. The sessions share a lease in
  `$.store` (key `notifier`: `{ session, at }`). A session toasts only while it
  holds the lease. It takes the lease when none is held, when the holder has
  not renewed for 30 seconds, or when the person opens `/channel` in it, and
  it re-reads after writing so two claimants settle on one. It renews on each
  feed pass and deletes its lease on `session.end`. Every session still counts
  unread and shows its status line; only toasts are single.
- **Bursts fold.** Updates are notified per feed pass, not per message:
  one unseen message in a conversation toasts `Name: text`; several toast
  `Name: 4 new messages`; more than three conversations at once toast one line,
  `12 new messages in 5 chats`.
- **A conversation toasts at most once in 10 seconds.** Later messages inside
  that window only raise the unread count.
- **Nothing old toasts.** The first pass after start only takes a cursor.
- A toast names the service when more than one is ready;
- the status line: total unread, split by service when more than one has any;
- `target`: the `Ref` of the latest notification, and `previous`: where the
  person was before they jumped. Project 2 binds keys to these; the foundation
  only keeps them correct.

### `register.tsx`

Wiring and nothing else: build the accounts from the registry, register
`/channel`, start and stop feeds on `session.start` and `session.end`, and
hand `ui.render` to `ui/pane.tsx`.

## Settings and setup

Each service declares its fields under `userConfig` in `plugin.json`, named
`<service><Field>`. Tokens are `sensitive` fields, so Claude Code keeps them out
of plain settings. `register` receives the values as `options` and passes each
provider the whole map; a provider reads only its own keys.

For iMessage there is one field, `imessage` (boolean, default on). Its `check`
answers `unavailable` off macOS or outside the terminal, and `setup` with the
Full Disk Access steps when the database cannot be read.

## Trust rules

These hold for every service and are restated at the top of `register.tsx`:

1. **Chat content is untrusted.** It is cleaned of control characters in
   `inbox.ts` and never interpreted.
2. **Nothing reaches the model by itself.** The foundation has no call to
   `prompt.submit`, `prompt.fill`, `session.append` or `tool.register`.
   Project 3 adds explicit, person-initiated paths and must restate this rule.
3. **Nothing sends without the person's act.**
4. **Message content stays in module memory.** Never in `$.state` (other mods
   read it) or `$.store` (it outlives the session). `$.store` may hold cursors
   and the last selected `Ref`, nothing a person wrote.
5. **A service reaches only what it declared.** The fence enforces `reach`.
6. **A token goes only to its own service's hosts.**

The README states reach per provider, in one table: the commands each starts
and the hosts each calls. For iMessage: `/usr/bin/sqlite3`, `/usr/bin/osascript`,
no network.

## Pane behaviour in project 1

- **Service tabs, always drawn.** The list view opens with a row of tabs: one
  per service that is `ready` or in `setup`, each with its unread count, and
  an `All` tab first when there are two or more. The selected tab is bold and
  inverse; Tab and Shift+Tab move through them as buttons, and each has a
  letter hotkey. With one service the row shows that one tab, so the design is
  visible today.
- In `All`, each conversation row is marked with its service.
- A service in `setup` shows its summary and numbered steps in its own tab
  instead of a red line. A service that is `off` or `unavailable` has no tab.
- **Message details.** A reply shows a dim `↳ sender: first words` line above
  it. Reactions show after the text as `👍 2`. An edited message is marked
  `(edited)`, an unsent one draws as dim `message unsent`.
- **Attachments.** A file part draws as a row with its name and size and an
  `open` button, which opens the file with `/usr/bin/open` (the mod's own
  reach, stated in the README; `Link` takes only https). An image part in the terminal draws inline with `Image` when
  it is a PNG (what the `Image` element reads from a file), and as a file row
  otherwise and on desktop.
- **Sending a file.** An `attach` button beside the reply box switches it to a
  path field; Enter sends that file to the conversation. It is drawn only when
  the provider has `attachments`.
- Reply controls appear only for capabilities the provider has.

## iMessage on the new contract

Same reach (`/usr/bin/sqlite3`, `/usr/bin/osascript`), same SQL, same
behaviour. Mapped onto the contract:

- `feed`: `polled`, 3 s open and 10 s closed, as today.
- **Attachments in:** each row of the `attachment` table joined to a message
  becomes a `file` or `image` part, with name (`transfer_name`), MIME type,
  size and the attachment's ROWID as `handle`. `attachments.fetch(handle)`
  answers the file's path under `~/Library/Messages/Attachments`.
- **Attachments out:** `attachments.send(conversation, path)` sends the file
  through Messages with osascript, the path as an argument, never in the
  script.
- **Replies:** `thread_originator_guid` becomes `replyTo`.
- **Tapbacks:** rows with `associated_message_type` 2000 to 2005 (and their
  removals, 3000 to 3005) become `reactions` on the message they point at, and
  a new tapback arrives as a `reaction` update. Read-only: Messages gives no
  way to send one, so there is no `reactions` capability.
- **Edits and unsends:** `date_edited` sets `editedAt`; `date_retracted` sets
  `isDeleted`. Read-only, so no `edits` capability.
- **Members:** `members.of` from `chat_handle_join`.
- Not possible through what macOS exposes, so absent: sending tapbacks,
  editing, typing, presence, marking read.
- Needs macOS 13 or later (the edit and unsend columns).
- `check`: `unavailable` off macOS or on desktop; `setup` with the Full Disk
  Access steps when the database cannot be read.

## Testing

- **`kit/fake.ts`:** a provider scripted from the test: conversations, a queue
  of updates, failures on demand, polled or live.
- **`kit/conformance.ts`:** checks any provider must pass: history is oldest
  first, `since` with no cursor returns only a cursor, ids are stable, it never
  calls outside its `reach`. Each provider's test file runs it.
- **`core.test.ts`**, with two fake services at once:
  - updates from both merge into one ordered inbox;
  - unread counts are kept per service and in total;
  - one service failing backs off alone while the other keeps delivering;
  - a live feed that ends is restarted;
  - the fence refuses an undeclared command, host and helper;
  - an edit, a delete and a reaction change the stored message;
  - `target` and `previous` follow a notification and a jump;
  - with two sessions sharing a store, one message makes one toast, and the
    lease passes on when its holder stops renewing or another session opens
    the pane;
  - five messages in one conversation make one toast; messages in four
    conversations make one summary toast; a second message within 10 seconds
    makes none.
- **`pane.test.ts`**, looped over terminal and desktop: one service draws its
  one tab; two draw `All` and both, and a press switches the list; a reply,
  reactions, an edited and an unsent message and a file part draw as
  specified; the `attach` button sends a path; a `setup` service draws its steps; a control for a
  missing capability is absent.
- **`imessage.test.ts`:** the existing six tests ported, plus conformance,
  plus: an attachment row becomes a part and `fetch` answers its path; `send`
  of a file passes the path as an argument; a reply carries `replyTo`; a
  tapback and its removal change `reactions`; an edited and an unsent row are
  marked; `members.of` lists the handles.

## How projects 2 to 4 build on this

| Project | Uses from the foundation | Mods features it adds |
|---|---|---|
| 2. UI | `inbox`, `notify.target` and `previous`, `Health.steps`, capability checks | Pane tabs, the band above the prompt, hotkeys, `Select`, `Markdown`, `Image`, dialogs |
| 3. Share | `Part`, the `attachments` capability, `Ref` | `$.session.messages`, `$.fs`, `$.prompt.fill`, prompt context, `$.ui.copy`, tools behind a permission check |
| 4. Collaboration | `Message`, `send`, `Update` | The chat as transport between two machines; `$.session.send` for one person's own sessions |

## Risks

- **Hot reload drops module memory**, so messages reload from the service
  after an edit to the mod. Acceptable: nothing is lost that the service does
  not still hold.
- **A live helper needs a runtime on the person's machine.** No service in
  project 1 uses one; the first that does must say what it needs in its
  `check`.
- **The lease is not atomic.** `$.store` has no compare-and-set, so two
  sessions can both toast once in a rare race. The re-read after writing makes
  that a single duplicate, not a flood.
- **Messages' database is undocumented.** Column meanings can change between
  macOS versions; each mapping is covered by a test so a change shows up there.
