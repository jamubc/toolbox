# channel: what is done and what is not

As of 2026-10-02, version 0.4.0. Design:
`docs/superpowers/specs/2026-10-01-channel-foundation-design.md`.

## Done

**Foundation (project 1)**
- Multi-service core: provider contract with optional capabilities, registry,
  fence, per-service loop with its own backoff, merged inbox, hub.
- Polled and live feeds behind one interface.
- Setup as structured steps (ready, off, setup, unavailable).
- Test kit: scriptable fake service, conformance suite, fake Mac. 37 tests.

**iMessage**
- Ported to the contract; text in and out as before.
- Attachments in (name, type, size, path) and out (send a file).
- Replies, tapbacks, edited and unsent messages, members: read and shown.
- A setting to turn it off.

**Notifications**
- One session toasts (shared lease; opening `/channel` takes it).
- Bursts fold; one toast per chat per 10 s; nothing old toasts.
- Jump to the chat that notified you, and back.

**Sharing (first slice of project 3)**
- A received file: open, path into the Claude prompt box, copy path.
- Out: send a file this session touched, a typed or dragged path, or Claude's
  last reply as an editable draft.

**UI**
- Service tabs with unread counts; `All` tab from two services.
- Conversation rows with an avatar chip, when the chat last moved, how many
  people are in it, and its newest message; twenty per tab, nine with hotkeys.
- Messages under day separators, each sender in a stable color, "You" for
  the person's own; hover lights a row.
- Older-history paging in the pane (`↑ older`, `↓ latest`).
- Pictures of any type macOS reads (JPEG, HEIC, PNG) and a PDF's first page
  preview inline: pixels in kitty and Ghostty, colored blocks elsewhere.
  Cells are box-filtered and cached per size. A picture-previews setting (auto,
  real pixels, colored blocks, none), and a fall back to blocks after three refused draws,
  as the browse pane does with frames.
- Files carry a glyph by kind (picture, video, audio, PDF, archive, text).
- The file name is the open button; unread chats marked; a run of messages
  from one sender shows the name once; the pane takes focus on `/channel`.

## Not done

**Never verified**
- Nothing has been watched in a live session: the pane's real look, a real
  send, a real file send, drag from Finder, inline PNG, the toast lease across
  real sessions. Only the automated tests and the SQL against the real
  database (row counts only) have run.

**Missing from what was asked**
- No second service. Slack, Discord and WhatsApp are unbuilt, so tabs,
  `All`, and the live feed have only run against fakes.
- No Claude Code-native restyle (project 2): no band above the prompt, no
  dropdowns or dialogs, no restyled transcript rows.
- No keyboard shortcut for jump and jump-back inside a conversation (buttons
  only; a hotkey would clash with typing in the reply box).
- Chat text cannot be pulled into Claude, only file paths.
- No tools for Claude to read or send chats.
- No collaboration or team share (project 4).
- No implementation plan document (skipped on request).

**iMessage gaps**
- No thread view, no search, no member list in the pane (a count only).
- Cannot send tapbacks, edit, or mark read: macOS offers no way.
- Only the twenty most recent conversations per tab.

**Known weak spots**
- Two sessions can both toast once in a rare race (the store has no atomic
  write).
- "Files this session touched" misses files changed only by shell commands.
- The installed `channel@toolbox` 0.2.0 shadows the dev copy unless disabled.
