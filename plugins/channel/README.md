# channel

Your iMessages in a pane beside Claude Code. Read your conversations, reply from a text box, and get a toast when someone texts you, without leaving the terminal. macOS only.

```
/plugin marketplace add jamubc/toolbox
/plugin install channel@toolbox
```

## Use

| | |
|---|---|
| `/channel` | Opens a pane with your nine most recent conversations. Press `1` to `9` to open one. |
| In a conversation | Its latest messages with time and sender, and a reply box: type and press Enter to send. `‹ chats` goes back. |
| New messages | A toast for each message you aren't looking at, e.g. *Book club · +1 555 0103: chapter 4 tonight?*, and *iMessage 3 new* under the prompt. Your own messages never toast. |

## Setup

- **Full Disk Access** for the app running Claude Code (System Settings › Privacy & Security › Full Disk Access), so it can read `~/Library/Messages/chat.db`. Without it the pane says what to grant.
- **Automation**: on your first send, macOS asks to let your terminal control Messages.
- **The Claude Code CLI.** It runs commands on your Mac, which the desktop app doesn't allow plugins to do.

Conversations show phone numbers and emails, or a group's name; contact names aren't read yet.

## How it works

Every 3 seconds with the pane open (10 when closed) it reads new rows from the Messages database with `sqlite3 -readonly`. Most messages on macOS 14 and later keep their text in an archived `attributedBody` field, which it decodes. Replies go through the Messages app with `osascript`, the text passed as an argument and never inside the script.

- Messages never reach the model: no prompt, no transcript row, no tool.
- Nothing sends without your Enter.
- Message text stays in the plugin's memory: not in session state other plugins can read, not on disk.
- No network requests at all, and it can start only `/usr/bin/sqlite3` and `/usr/bin/osascript`.

`hooks/register.tsx` draws the pane and polls; `hooks/providers/imessage.ts` is the iMessage provider behind the contract in `hooks/providers/chat.ts`.

## Development

```sh
claude --plugin-dir plugins/channel     # load it; edits hot-reload
claude plugin validate plugins/channel
claude plugin test plugins/channel
tsc -p plugins/channel                  # after one load writes .claude-plugin/types/
```
