# Privacy policy

Last updated: 2026-10-13

This policy covers the plugins in the [toolbox](https://github.com/jamubc/toolbox) marketplace that link to it. Each plugin's README has a section that lists exactly what it runs, reads and sends; that section is part of this policy.

## What we collect

Nothing. toolbox plugins have no accounts, no analytics and no telemetry, and the author runs no server that receives data from them.

## redline

- redline runs on your computer only and makes no network requests.
- It runs `claude agents --json`, Claude Code's own list of your running sessions, to show them in its pane.
- It reads this session's usage from Claude Code: the context fill, your plan's rate-limit percentages and reset times, and the session's cost. The limiter decides from them and the dials draw them.
- It writes a heartbeat for this session to its plugin store, a JSON file under `~/.claude/plugins/store/` on your computer: the session id, working directory, state, turn count, context fill, cost, model and whether the limiter is shifted. The heartbeat is removed when the session ends. Other sessions on the same computer read it; nothing else does.
- None of this is sent anywhere or shared with anyone.

## Claude Code and Anthropic

Plugins run inside Claude Code. What Claude Code and Anthropic collect is covered by [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy), not this one.

## Changes and contact

Changes to this policy are made in this file, and its history is on GitHub. Questions go to the [toolbox issues](https://github.com/jamubc/toolbox/issues).
