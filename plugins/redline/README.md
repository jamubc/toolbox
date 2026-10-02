# redline

A turbo boost gauge above your Claude Code prompt. The needle reads how many Claude sessions in your terminals are working right now, from *Napping* to *Blown* at 25.

```
/plugin marketplace add jamubc/toolbox
/plugin install redline@toolbox
```

## Use

| | |
|---|---|
| Above the prompt | A small gauge with the stage and count: *Idling · 1 working · 6 sessions*. |
| `/redline` | Opens a pane with a larger gauge and every session: working or idle, terminal, folder. Run again to close. |
| `/redline 15` | Previews the gauge at 15 working. `/redline live` returns to your real sessions. |
| `/config` → Status line | Off by default. On, it adds `Idling · 1/7` under the prompt. |

## Stages

| Working | Stage |
|---|---|
| 0 | Napping |
| 1–2 | Idling |
| 3–5 | Cruising |
| 6–8 | Spooling up |
| 9–12 | Boost building |
| 13–17 | Under pressure… |
| 18–20 | Redline |
| 21–24 | Overboost |
| 25+ | Blown |

## How it counts

Every two seconds it reads `ps` and `lsof`. A session is a `claude` process with a terminal; it is working while Claude Code holds a `caffeinate` child, which happens on macOS during a turn. On Linux every session reads as idle. It never starts or stops anything.

## Development

```sh
claude --plugin-dir plugins/redline     # load it; edits hot-reload
claude plugin validate plugins/redline
claude plugin test plugins/redline
tsc -p plugins/redline                  # after one load writes .claude-plugin/types/
```
