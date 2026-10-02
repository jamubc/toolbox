# instantnotes

Your [InstantNotes](https://github.com/Jam-Sw/InstantNotes) library, directly in Claude Code. Search, read and capture notes without leaving the terminal.

***Every note you have, one command away.***

## Install

Add the marketplace:

```
/plugin marketplace add jamubc/toolbox
```

Install the plugin:

```
/plugin install instantnotes@toolbox
```

## Usage

| Command | What it does |
| --- | --- |
| `/notes` | Opens a pane with your recent notes. |
| `/notes <words>` | Opens the pane searching for those words or a title. |
| `/note <text>` | Saves the text as a new note. The first line becomes the title. |

In the pane:

- **Type** to filter the notes already listed; **Enter** searches the whole library. An empty search lists recent notes.
- **A note** opens as Markdown with its spaces, tags and when it last changed. `b` goes back.
- **mention in prompt** (`u`) puts a reference to the note in your prompt, so Claude can read it through the InstantNotes MCP server. **paste into prompt** (`p`) puts the note's text itself there. **copy** (`c`) copies it.
- **+ new note** opens a field: write the note and press Enter. It opens once saved.
- Notes you have opened are kept for a minute, so going back and forth is instant; **reload** (`r`) reads one again.

## How it reaches InstantNotes

The plugin uses what InstantNotes › Settings › Agents sets up, in this order:

1. **The `instantnotes` MCP server** Claude Code already runs, once you ran the `claude mcp add instantnotes …` command from that page. This is the fast path: the server stays up, and every request is a call to it.
2. **`instantnotes mcp` run by the plugin**, one request at a time. It finds the program from what `claude mcp add` wrote in `~/.claude.json` or the project's `.mcp.json` (the exact program and library you use), from `/Applications/InstantNotes.app` or `~/Applications/InstantNotes.app`, or on your PATH.

When none of these can start, the pane says so and lists the steps.

<details>
<summary>Setup details</summary>

<br>

- Needs InstantNotes 0.9.0 or later, with Access turned on in Settings › Agents.
- `/config` → InstantNotes binary names the program when the plugin cannot find it. `/config` → Library database names a library other than the one the app or `claude mcp add` uses; the attachments folder is read beside it.
- With nothing set, the app's own library is used: `~/.local/share/com.instantnotes.app` on Linux, `~/Library/Application Support/com.instantnotes.app` on macOS.

</details>

<details>
<summary>Functions</summary>

<br>

- `hooks/register.tsx` draws the pane and answers `/notes` and `/note`.
- `hooks/library.ts` finds the program and library from your configuration, and shapes text for the pane.
- Each request is one MCP `tools/call`, through the connected server or one `instantnotes mcp` process, so the plugin follows the same rules as any agent.

</details>

<details>
<summary>Privacy</summary>

- Notes reach Claude only when you put one in your prompt (mention or paste) and send it.
- It writes only when you save a note (`/note`, or the field in the pane).
- It talks only to the local `instantnotes` program or the MCP server you connected, never the network. `~/.claude.json` is read only to find that server's command line.

</details>

## Development

```sh
claude --plugin-dir plugins/instantnotes   # load it; edits hot-reload
claude plugin validate plugins/instantnotes
claude plugin test plugins/instantnotes
```
