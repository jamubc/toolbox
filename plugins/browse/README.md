# browse

A Claude Code web browser.

## Install

Add the marketplace:

```
/plugin marketplace add jamubc/toolbox
```

Install the plugin:

```
/plugin install browse@toolbox
```

## Usage

| Command | What it does |
| --- | --- |
| `/browse` | Opens the browser on a start page: type an address or a search and press Enter, or pick YouTube, DuckDuckGo, Wikipedia, Hacker News or GitHub. |
| `/browse <address or words>` | Opens the address, or searches DuckDuckGo. |
| `/browse close`, or the pane's ✕ | Closes the pane and stops the browser and its sound. |
| The address bar | Type an address or words and press Enter. It has the keys when the start page opens. |
| Click the page | Clicks there. Your keys then go to the page; **Esc** gives them back to the prompt. |
| Mouse wheel over the page | Scrolls the page. |
| `/config` → Picture | `auto`, `image` (real pixels) or `blocks` (colored cells). |

## Compatibility

| Where you run Claude Code | Picture | Sound |
| --- | --- | --- |
| **kitty**, **Ghostty** | Real pixels (kitty graphics protocol). Untested so far. | Yes |
| Any other terminal: Terminal.app, iTerm2, Zed, VS Code's terminal, WezTerm, tmux, or over ssh | Colored half-blocks, two pixels per character. Video is recognizable but chunky, and small text cannot be read. | Yes, on the machine running Claude Code |
| Claude desktop app, VS Code extension, mobile | Nothing. The pane says the browser only draws in the terminal, and no browser starts. | No |

| System | Status |
| --- | --- |
| macOS | Tested: YouTube with sound, clicks, keys, the wheel, closing. |
| Linux | Should work; untested. Chrome is looked up on your PATH. |
| Windows | Not supported yet. The pane says so. |

- **Needs** Chrome, Chromium, Brave or Edge, and Node.js 18 or later on your PATH. If one is missing, the pane says which and offers **Try again**. You can set either path in `/config`.
- Inside tmux or over ssh the picture is always blocks, even from kitty or Ghostty, because neither passes the images through.
- If you force `image` on a terminal that cannot draw it, the pane says so; set Picture back to `auto` or `blocks`.
- One browser at a time: if another Claude Code session has the pane open, `/browse` says so.
- While a video plays, expect roughly a fifth of a CPU core each for Claude Code drawing the pane and for Chrome (measured on an M-series Mac).

<details>
<summary>Functions</summary>

<br>

- `browser/browser.mjs` runs Chrome headless and drives it over the DevTools protocol, with no dependencies.
  - Frames go out on stdout at up to 15 a second.
  - Clicks, keys and navigation come in over a Unix socket in a private temp folder.
- `hooks/register.tsx` draws the pane, answers `/browse`, and forwards the wheel.
- `hooks/pointer.tsx` lies over the picture and passes on clicks and keys.
- Closing the pane, a hot reload, or Claude Code exiting stops the browser. If Claude Code is killed, the helper notices within two seconds and stops Chrome.

</details>

<details>
<summary>Privacy</summary>

- An address you open with `/browse <address>` shows in the conversation as the command's reply, so Claude can read it. Pages, frames and what you type into the page stay between the pane and the local Chrome.
- Chrome is driven over a pipe, not a network port, so no other program on your machine can take control of it.
- The browser keeps its own profile in `~/.cache/claude-browse/chrome-profile`: cookies and logins persist there between sessions, apart from your everyday Chrome profile. Delete that folder to forget them.
- Searches go to DuckDuckGo, as typed.

</details>
