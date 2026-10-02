# redline

Too many Claudes going at once? Feeling overwhelemed? redline puts a guage into claude so you can plan your time better.

***stop starting new Claudes and finish the ones already running.***

## Install

Add the marketplace:

```
/plugin marketplace add jamubc/toolbox
```

Install the plugin:

```
/plugin install redline@toolbox
```

## Usage

| Command | What it does |
| --- | --- |
| UI Mod | gauge & labels. |
| `/redline` | Toggles detailed view. |
| `/redline <0-15>` | demo: enable. |
| `/redline live` | demo: disable |
| `/config` → Status line | toggle labels |

## Stages

<details>
<summary>Stages by sessions working</summary>

<br>

| Working | Stage |
| --- | --- |
| 0 | Napping |
| 1–2 | Idling |
| 3–5 | Cruising |
| 6–8 | Busy |
| 9–12 | Very Busy |
| 13–17 | Under Pressure |
| 18–20 | Redline |
| 21–24 | Overboost |
| 25+ | Blown |

</details>

<details>
<summary>Functions</summary>

<br>

- Every two seconds it reads `ps` and `lsof`.
- A session is a `claude` process attached to a terminal.
- A session counts as working while Claude Code holds a `caffeinate` child process, which happens on macOS during a turn. On Linux every session reads as idle.

</details>

<details>
<summary>Privacy</summary>

- Read-only: it never starts or stops anything.
- It only reads process information from `ps` and `lsof`.

</details>
