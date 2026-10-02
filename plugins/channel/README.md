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
| `/channel` | Opens a pane with your nine most recent conversations. |

## Supported connections

| Connection | Platform | Setup | Provider |
| --- | --- | --- | --- |
| [iMessage](#imessage) | macOS | Full Disk Access | `hooks/providers/imessage.ts` |

<details>
<summary>Setup details</summary>

### iMessage

- **Reading** uses `sqlite3 -readonly` on `~/Library/Messages/chat.db`, which requires Full Disk Access for your terminal. Grant it in **System Settings › Privacy & Security › Full Disk Access**.
- **Replying** uses `osascript`. On your first reply, macOS asks you to let your terminal control Messages.

</details>

<details>
<summary>Functions</summary>

<br>

- `hooks/register.tsx` draws the pane and polls for new messages.
- `hooks/providers/chat.ts` defines the contract every provider implements.

</details>

<details>
<summary>Privacy</summary>

- Messages never reach Claude: no prompt, no transcript row, no tool.
- Nothing is sent without your explicit approval.
- Message text stays in the plugin's memory (work in progress).
- Neither Claude nor the plugin makes network requests.

</details>
