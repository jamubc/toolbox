# channel

Your favourite chat, directly in Claude Code. Read, reply, get notified and more, without leaving the terminal.

***It can all be done, inside Claude Code***

## Install

Add the marketplace:

```
/plugin marketplace add jamubc/toolbox
```

Install the plugin:

```
/plugin install channel@toolbox
```

## Usage

| Command | What it does |
| --- | --- |
| `/channel` | Opens the chat pane: a tab per service, and your twenty most recent conversations in each. |

In the pane:

- **Tabs** switch between services. With two or more set up, an `All` tab shows every conversation together.
- **The list** shows each conversation with a colored avatar chip, when it last moved, how many people are in it, and its newest message. Unread chats are marked and counted; keys `1` to `9` open the first nine.
- **A conversation** shows messages under the day they came, each person in their own color (you in cyan), with files, the message a reply answers, reactions, and edited or unsent messages. **↑ older** pages back through the history; **↓ latest** returns to the end.
- **Pictures** (and the first page of a PDF) preview inline in the terminal: as real pixels in kitty and Ghostty, as colored blocks elsewhere. A terminal that turns out not to draw pixels falls back to blocks by itself. `/config` → Pictures forces one, or turns previews off.
- **→ Claude** on a file puts its path in your Claude prompt, ready for you to send. **copy path** copies it, and pressing the file name opens it with your Mac's own app.
- **attach** sends a file: pick one this Claude session touched, type a path, or drag a file onto the field.
- **Claude's reply** puts Claude's last answer in the reply box for you to edit and send.
- **↪ new in …** jumps to the conversation that last notified you, and **↩ back to …** returns you.

Notifications stay quiet: only one of your Claude sessions toasts, several messages in one chat fold into one toast, and a chat toasts at most once every 10 seconds. Every session still shows the unread count in its status line.

## Supported connections

| Connection | Platform | Setup | What it can do |
| --- | --- | --- | --- |
| [iMessage](#imessage) | macOS 13 or later, terminal | Full Disk Access | Read and send text and files; show replies, tapbacks, edits, unsends and members |

Turn a service off in `/config` under channel.

<details>
<summary>Setup details</summary>

### iMessage

- **Reading** uses `sqlite3 -readonly` on `~/Library/Messages/chat.db`, which requires Full Disk Access for your terminal. The pane lists the steps and names your terminal app.
- **Sending** text and files uses `osascript`. On your first send, macOS asks you to let your terminal control Messages.
- Messages gives no way to send a tapback, edit a message or mark one read, so channel shows those and cannot do them.

</details>

<details>
<summary>What each service reaches</summary>

<br>

A service can start only the programs and call only the hosts listed here. Anything else is refused in `hooks/core/fence.ts`.

| Service | Programs it starts | Hosts it calls |
| --- | --- | --- |
| iMessage | `/usr/bin/sqlite3`, `/usr/bin/osascript` | none |

The pane itself starts `/usr/bin/open` when you press a file, and `/usr/bin/sips` to make a picture's or a PDF's preview. Previews are at most twelve temporary files in your `TMPDIR`, each overwritten in turn. The cells of a preview are averaged from the pixels they cover and encoded once per size, so redrawing the pane costs nothing more.

</details>

<details>
<summary>How it is built</summary>

<br>

- `hooks/core/contract.ts` is what every service implements: a small required core, plus optional capabilities (attachments, threads, reactions, edits, read state, typing, members, search). The pane offers only what a service has.
- `hooks/core/registry.ts` lists the services. Adding one is a folder under `hooks/providers/` and a line there.
- `hooks/core/account.ts` runs one service with its own loop and backoff; `inbox.ts` merges them; `notify.ts` decides what toasts; `hub.ts` ties them together.
- `hooks/ui/` draws the pane: `list.tsx` the conversations, `conversation.tsx` one chat, `picture.ts` thumbnails as pixels or cells, `format.ts` labels, colors and days. `hooks/register.tsx` is wiring only.
- `tests/kit/` has a scriptable fake service and the conformance checks every provider must pass.

</details>

<details>
<summary>Privacy</summary>

- What a chat says never reaches Claude by itself: no prompt, no transcript row, no tool.
- Only you move things across. **→ Claude** writes a received file's path into your prompt box as a draft, and you send it. **Claude's reply** and the offered files go to a chat only when you press and send.
- Nothing is sent without your Enter or press.
- Message text stays in the plugin's memory: not in session state other plugins can read, not on disk. The only thing stored is which session shows toasts.
- Each service reaches only what the table above lists. iMessage makes no network request.

</details>

## Development

```sh
claude --plugin-dir plugins/channel     # load it; edits hot-reload
claude plugin validate plugins/channel
claude plugin test plugins/channel
tsc -p plugins/channel                  # after one load writes .claude-plugin/types/
```
