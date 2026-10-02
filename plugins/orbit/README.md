# orbit

Where does your Claude session phone? orbit draws a globe in a pane with you as a red dot and an arc for every connection the session makes: the Anthropic stream breathing while Claude writes, a `WebFetch` landing in Ashburn, an MCP server talking to GitHub, a `curl` in a shell. Each arc is traced back to the tool that caused it, the host, the address, the org, the country and the bytes. It can also block: a deny-list enforced before a tool call runs.

## Install

Add the marketplace:

```
/plugin marketplace add jamubc/toolbox
```

Install the plugin:

```
/plugin install orbit@toolbox
```

Then, once: `/orbit locate` (or `/config` → Your location) for the red dot, and `/orbit geodb` for the offline geo database that places connections.

## Usage

| Command | What it does |
| --- | --- |
| `/orbit` | Opens or closes the pane: the globe, the badge, the legend and the live log. |
| `/orbit all` / `/orbit session` | Observe every Claude session on this machine (each its own color, with a legend) or this one only. |
| Click a log row | Highlights its arc in white and shows the details, with **block this host**. |
| `◀` `⌂` `▶` | Turn the globe; `⌂` centers it on you again. |
| `/orbit block <host>` | Blocks a host (`example.com` takes its subdomains, `*.cdn.net` is a glob, an address works too), `mcp:<server>` an MCP server, or `tool:<Tool>` a tool. |
| `/orbit allow <host>` | Allows one, which also whitelists it in allowlist mode. |
| `/orbit unblock <host>` | Removes the rule. Rules are kept across sessions. |
| `/orbit rules` | Lists the rules and the mode. |
| `/orbit mode off\|denylist\|allowlist\|ask` | Watch only; block what is listed; block all but the allowed; or ask about each new host with a dialog (8 seconds, then deny). `/config` → Enforcement sets the default. |
| `/orbit export [path]` | Writes the trace as JSONL. The trace is also written as it goes to `~/.claude/orbit/traces/<session>.jsonl`. |
| `/orbit replay [file\|off]` | Lists the saved traces, or re-animates one on the globe with a scrubber: ⏮ ▶ ⏸ ⏭ and 1× to 16×. |
| `/orbit locate` | Sets your location from your public address: one request, then an offline lookup. Or `/orbit home 49.28,-123.12 Vancouver`. |
| `/orbit geodb [country]` | Downloads DB-IP Lite (city, ~130 MB, or country, ~10 MB) and ASN Lite into `~/.claude/orbit/geo`. No account, no key. |
| `/orbit proxy on\|off` | Starts the proxy layer for this session. `/config` → Proxy layer starts it every session. |
| `/orbit check` | Which layers work here, and why not. |
| `/config` → Status line | Shows `orbit · 6 hosts · 3 countries` on the status line. |

## What it sees

Three layers feed one trace, in the order they are worth having:

1. **Tool layer.** A `tool.call` hook sees `WebFetch`, `WebSearch`, every MCP tool and every Bash command before it runs: which tool, which host (URLs, `git clone`, `ssh`, `curl`, `pip`, `nc`...), when. Rules are enforced here, so a blocked call never runs and Claude reads why.
2. **Process layer.** Every two seconds it reads the session's process tree (Claude Code, its shells, MCP servers, subagents) and the sockets they hold: `lsof -i` on macOS, `ss -tnpi` on Linux (or `/proc` without `ss`). This catches what the hooks cannot see: the Anthropic API itself, telemetry, child processes. Byte counts come from `nettop` on macOS and from `ss` on Linux. A socket that appears within a few seconds of a tool call that named a host is matched to it, so one row shows tool → host → address → bytes.
3. **Proxy layer** (optional). A local HTTP(S) proxy for the commands and MCP servers the session starts after it is on, by setting `HTTPS_PROXY` for them. It records the `CONNECT` host, the address it connected to, bytes each way and how long the connection lived. It never decrypts anything: TLS passes through. A proxy the session already had is chained through.

Beside those, the turn's own stream is tapped so the Anthropic arc pulses while Claude generates, with or without a socket in view.

### Places

Addresses are placed with an offline MaxMind-format database: DB-IP Lite by default (`/orbit geodb`, CC BY 4.0), or a GeoLite2 file you point `/config` → Geo database at. Lookups run on your machine; orbit makes **no request per connection**, ever. Cloudflare, Fastly, Akamai, public DNS and Anthropic's own ranges are marked `~` anycast, because where an anycast address answers is not where its owner is; Anthropic's API is drawn at the company's home and says so.

Your own location is manual first (`/config` → Your location). `/orbit locate` is the one exception to "no requests": one call to api.ipify.org for your address, which the offline database then places (without a database it asks ipinfo.io once instead, and says so).

## Compatibility

| Where you run Claude Code | Globe | Layers |
| --- | --- | --- |
| **kitty**, **Ghostty** | Real pixels (kitty graphics protocol), 4 frames a second. Untested so far. | All |
| Any other terminal, tmux, ssh | Colored half-blocks, two pixels per character, 10 frames a second. | All |
| Claude desktop app, VS Code extension, mobile | The trace and the badge; no globe. | Tool layer; the rest needs the terminal |

| Layer | macOS | Linux | Elevated permissions |
| --- | --- | --- | --- |
| Tool | Yes | Yes | None |
| Process: sockets | `lsof -i` (ships with macOS) | `ss` (iproute2), or `/proc` | None for your own processes. Other users' processes need root, so observe-all sees your sessions only. |
| Process: bytes | `nettop` (ships with macOS) | `ss -i` counters (TCP only) | None. If `nettop` needs more than it has on your macOS version, arcs still draw without thickness. |
| Proxy | Node.js 18+ | Node.js 18+ | None. Only children started after it is on go through it; the Claude Code process read `HTTPS_PROXY` at launch and keeps its own route, which the process layer sees. |
| Geo | Node.js 18+ for the helper | Node.js 18+ | None. One download you ask for. |
| Blocking | Tool layer only | Tool layer only | None. Sockets are observed, never cut: a process that opens a connection without going through a tool call (an MCP server on its own, a child the shell left behind) is shown, not stopped. |

`/orbit check` says which of these apply on your machine.

`/clear` and `/compact` leave the pane, the trace and your rules where they were: `/clear` starts a new session in the same process, and orbit writes what it was showing into it.

- **Needs** nothing for the tool and process layers on macOS. On Linux, `ss` from iproute2 (nearly always there). Node.js for the geo helper and the proxy.
- One Claude Code session is found by walking `ps` from the shell it runs in; if that fails `/orbit check` says so and only the tool layer records.
- Processes a tool started and left running (a dev server) stay in the tree and keep tracing until they exit.

<details>
<summary>Gaps that remain</summary>

<br>

- Sockets are polled every two seconds, so a connection that lives less than that can be missed by the process layer. The tool layer still records what caused it, and the proxy layer sees every connection of the children it covers.
- Linux byte counters come from `ss -i`, which has them for TCP only; UDP (DNS) shows without bytes. macOS `nettop` per-connection rows are parsed by column name; if your macOS version prints them differently, bytes stay at zero, and the format is in `hooks/procs.ts`.
- A hostname is known from the tool layer and the proxy; the process layer sees addresses, and orbit does no reverse DNS (that would be traffic of its own). Matching by time is a guess when several calls run at once.
- Observe-all mode labels a session by its folder and terminal, not its title: Claude Code keeps no title where a process can be matched to it from outside.
- The proxy cannot see the Claude Code process itself, nor children that ignore `HTTPS_PROXY`; the process layer covers both, without hostnames.
- `ask` mode has eight seconds, the budget a hook has to answer; with no answer the call is denied, and Claude is told to ask you.
- The globe is a half-degree land mask from Natural Earth outlines; at pane sizes coastlines are rough, and in image mode the same mask is drawn at pixel size.
- Real-pixel mode is untested on a live kitty or Ghostty; it falls back to blocks after three refused frames.

</details>

<details>
<summary>Functions</summary>

<br>

- `hooks/register.tsx` wires the hooks, the command, the timers (frames at 10 Hz, polling at 0.5 Hz) and the helpers.
- `hooks/tools.ts` reads what a tool call reaches; `hooks/rules.ts` decides it.
- `hooks/procs.ts` parses `ps`, `lsof`, `ss`, `/proc` and `nettop`; `hooks/model.ts` folds sockets and proxy lines into events and matches them to tool calls.
- `hooks/globe.ts` draws the globe into `hooks/canvas.ts` pixels; `hooks/png.ts` encodes them with its own deflate for the Image path; `hooks/land.ts` is the land mask (`docs/landmask.py` makes it).
- `hooks/trace.ts` is the event shape, the arcs a moment draws, JSONL and replay.
- `geo/geoip.mjs` reads MaxMind-format databases and downloads DB-IP Lite; `proxy/proxy.mjs` is the proxy. Both are plain Node with no dependencies.

</details>

<details>
<summary>Privacy</summary>

- Read-only, apart from blocking what you asked it to block: it never starts, stops or cuts anything.
- It reads process and socket tables with `ps`, `lsof`, `ss`, `nettop` or `/proc`, for your own processes.
- No request per connection. The only requests it ever makes are the ones you ask for: `/orbit geodb` (db-ip.com) and `/orbit locate` (api.ipify.org, or ipinfo.io without a database).
- The proxy sees hostnames, addresses and byte counts; it does not decrypt TLS and keeps no request bodies.
- The trace is written to `~/.claude/orbit/traces` (off with `/config` → Write the trace) and rules to the plugin's store. Nothing leaves your machine.

</details>
