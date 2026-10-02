# redline

Too many Claudes going at once? Feeling overwhelmed? redline puts a gauge above your Claude Code prompt that counts how many of your sessions are working, so you can plan your time better.

<img width="638" height="98" alt="image" src="https://github.com/user-attachments/assets/c7d1ae26-46c2-4222-be22-d6f85e3db13f" />

<img width="302" height="731" alt="image" src="https://github.com/user-attachments/assets/4e546a80-f59e-4ba1-a81e-f5f83e7b584f" />


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
| `/redline <0-25>` | demo: enable. |
| `/redline live` | demo: disable |
| `/config` → Show the count at the bottom of the terminal | toggle labels |
| `/config` → Show the fuel gauges | toggle the 5H / 7D / CTX dials |

## Fuel gauges

<details>
<summary>The three dials, off until switched on</summary>

<br>

With **Show the fuel gauges** on, three more dials ride along: beside the tachometer above your prompt, and under it in the pane.

| Dial | What it reads |
| --- | --- |
| 5H | Your plan's five-hour rate-limit window. |
| 7D | Your plan's seven-day rate-limit window. |
| CTX | This session's context, filling as the conversation grows. |

On every dial the needle swings right, into the red, as its tank is used. The plan windows drain, so 5H and 7D read F (full) to E (empty); the context fills, so CTX reads E to F. The plan dials need a subscription; CTX works for everyone. A dial the engine has no reading for stays dim.

</details>

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

## What it runs, reads and sends

redline runs two read-only programs on your machine and sends nothing anywhere. It makes no network requests.

| Program | Exactly what it runs | Why |
| --- | --- | --- |
| `ps` | `ps -x -o pid=,ppid=,tty=,args=`, every two seconds | Lists your own processes, to find the `claude` sessions in your terminals and which are mid-turn. |
| `ps` | `ps -x -o pid=,ppid=,tty=,command=`, once a session until it succeeds | The same table in a second format, so redline can tell which session is this one and mark it `(this one)` in the pane. |
| `lsof` | `lsof -a -d cwd -Fn -p <pids>`, every two seconds, where `<pids>` are the `claude` sessions `ps` just found | Reads each session's working directory, shown beside it in the pane. |

- A session is a `claude` process attached to a terminal. It counts as working while Claude Code holds a `caffeinate` child process, which happens on macOS during a turn. On Linux every session reads as idle.
- With the fuel gauges on, it reads this session's usage (`session.usage`, and the `session.measure` event after each turn): the context fill and your plan's rate-limit percentages, the same figures the status line has. They are drawn on the dials and kept in this session's plugin state; they are never written to disk by redline or sent anywhere.
- It never starts, stops or changes another process. The process tables are read, parsed in memory and dropped.
- It hooks `command.run` only for its own `/redline` command, which opens and closes the pane and sets the demo count. It does not see or change any other command.
- It hooks `ui.close` to notice when you close its pane, and `session.start`, `session.end` and `session.measure` to keep the gauge right across `/clear`.
