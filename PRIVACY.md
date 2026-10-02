# Privacy policy

Last updated: 2026-10-02

This policy covers the plugins in the [toolbox](https://github.com/jamubc/toolbox) marketplace that link to it. Each plugin's README has a section that lists exactly what it runs, reads and sends; that section is part of this policy.

## What we collect

Nothing. toolbox plugins have no accounts, no analytics and no telemetry, and the author runs no server that receives data from them.

## redline

- redline runs on your computer only and makes no network requests.
- It reads your own process table with `ps` and the working directories of your Claude Code sessions with `lsof`, to count the sessions and show them in its pane.
- With the fuel gauges on, it reads this session's usage from Claude Code: the context fill and your plan's rate-limit percentages. They are drawn on the dials and kept in the session's plugin state.
- None of this is written to disk by redline, sent anywhere, or shared with anyone.

## Claude Code and Anthropic

Plugins run inside Claude Code. What Claude Code and Anthropic collect is covered by [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy), not this one.

## Changes and contact

Changes to this policy are made in this file, and its history is on GitHub. Questions go to the [toolbox issues](https://github.com/jamubc/toolbox/issues).
