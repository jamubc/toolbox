import type { EngineInterface, Register } from 'claude-code'

import { createHub } from './core/hub'
import type { Hub } from './core/hub'
import { services } from './core/registry'
import { PaneView } from './ui/pane'
import { decodeBmp } from './ui/picture'
import type { Picture } from './ui/picture'

// Wiring only: the services run in core/, the pane is drawn in ui/.
//
// Chat is untrusted input and private, whichever service it comes from:
// - Nothing a chat says reaches the model. No session.append, no
//   prompt.submit, no tool. Messages go to the pane, toasts and the status line.
// - One thing crosses into the session, and only on the person's press: the
//   path of a received file, written into their prompt box as a draft
//   (prompt.fill). They send it; the message text never goes.
// - One thing crosses out, and only on the person's press: Claude's last
//   reply, or a file this session touched, offered for sending.
// - A message goes out only on the person's Enter or press.
// - Message text lives in this mod's memory alone, never in $.state (any
//   plugin reads that) or $.store (it outlives the session). The store holds
//   one thing: which session toasts.
// - Each service reaches only the commands and hosts its spec declares
//   (core/fence.ts). The mod itself starts one more program, `open`, and only
//   when the person presses a file. It also starts `sips` to make the small
//   copy of a picture (or a PDF's first page) that the pane shows; those copies
//   are at most twelve temporary files, each overwritten in turn.
//
// Pictures follow the browse pane: a sharp PNG the terminal reads itself where
// it draws pixels, small bitmaps packed into cells elsewhere, a /config choice
// between them, and a fall back to cells when the terminal turns out not to
// draw pixels after all.

const PANE = 'channel'
const OPEN = '/usr/bin/open'
const SIPS = '/usr/bin/sips'
// The longest side of a picture's copy, in pixels: sharp where the terminal
// draws pixels and reads the file itself, small where it is packed into cells.
const SHARP = 1600
const BLOCKS = 200
const OFFERED_FILES = 5
// How long after a picture is drawn the terminal is asked whether it took it.
const PROBE_MS = 400
// The pane's share of the terminal when docked, and the least it takes.
const SIDEBAR = 0.36
const MIN_COLUMNS = 44
// What Claude's reply is cut to as a chat draft.
const DRAFT = 2000

// TERM_PROGRAM to the name the terminal goes by in System Settings.
const APPS: Record<string, string> = {
  Apple_Terminal: 'Terminal',
  'iTerm.app': 'iTerm',
  ghostty: 'Ghostty',
  WezTerm: 'WezTerm',
  WarpTerminal: 'Warp',
  vscode: 'Visual Studio Code',
}

type Options = { imessage?: boolean; pictures?: string }

// Real pixels where the terminal speaks the kitty graphics protocol. Not
// through tmux, which drops it, nor over ssh.
async function hasPixels($: EngineInterface): Promise<boolean> {
  const isRelayed =
    (await $.env.get('TMUX')) !== undefined ||
    (await $.env.get('SSH_CONNECTION')) !== undefined ||
    (await $.env.get('SSH_TTY')) !== undefined
  if (isRelayed) {
    return false
  }
  const term = (await $.env.get('TERM')) ?? ''
  const program = ((await $.env.get('TERM_PROGRAM')) ?? '').toLowerCase()

  return (await $.env.get('KITTY_WINDOW_ID')) !== undefined || term.includes('kitty') || term.includes('ghostty') || program === 'ghostty'
}

// How pictures draw, from /config and the terminal: pixels, cells, or not at all.
// The words are what the /config picker shows, so a row there explains itself;
// the engine has already turned anything else into the default before we run.
async function pictureMode($: EngineInterface, options: Options): Promise<'pixels' | 'cells' | 'off'> {
  const choice = (options.pictures ?? '').toLowerCase()
  if (choice.startsWith('no previews')) return 'off'
  if (choice.startsWith('always real')) return 'pixels'
  if (choice.startsWith('always colored')) return 'cells'

  return (await hasPixels($)) ? 'pixels' : 'cells'
}

async function build($: EngineInterface, surface: string, options: Options): Promise<Hub> {
  const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')
  let generation = 0
  // One at a time: sips is not cheap, and a slot's file must not be half-written.
  let making: Promise<unknown> = Promise.resolve()

  async function thumbnail(path: string, slot: number, asPixels: boolean): Promise<Picture | undefined> {
    const measured = await $.process.run([SIPS, '-g', 'pixelWidth', '-g', 'pixelHeight', path])
    const width = Number(/pixelWidth: (\d+)/.exec(measured.stdout)?.[1])
    const height = Number(/pixelHeight: (\d+)/.exec(measured.stdout)?.[1])
    if (measured.exitCode !== 0 || !(width > 0) || !(height > 0)) {
      return undefined
    }
    const file = `${tmp}/claude-channel-picture-${slot}.${asPixels ? 'png' : 'bmp'}`
    const made = await $.process.run([SIPS, '-s', 'format', asPixels ? 'png' : 'bmp', '-Z', String(asPixels ? SHARP : BLOCKS), path, '--out', file])
    if (made.exitCode !== 0) {
      return undefined
    }
    if (asPixels) {
      generation += 1

      return { width, height, source: { file, generation } }
    }
    const bitmap = decodeBmp(Uint8Array.fromBase64((await $.fs.read(file, { as: 'bytes' })).base64))

    return bitmap && { width, height, source: { bitmap } }
  }

  return createHub(services, {
    pictures: await pictureMode($, options),
    thumbnail(path, slot, asPixels) {
      const next = making.then(() => thumbnail(path, slot, asPixels))
      making = next.catch(() => undefined)

      return next
    },
    // A blit of the very source the Image already shows sends nothing new,
    // and answers whether the terminal drew it or its alt text.
    probe: (key, source) =>
      new Promise(resolve => {
        $.clock.after(PROBE_MS, () => {
          $.ui.blit({ requestId: PANE, key, source: { file: source.file, format: 'png', generation: source.generation } })
            .then(res => resolve(res.deny === undefined || /mount/i.test(res.deny)))
            .catch(() => resolve(true))
        })
      }),
    tools: {
      run: argv => $.process.run(argv),
      fetch: (url, init) => $.http.fetch(url, init),
      spawn: argv => $.process.spawn({ argv: [...argv] }),
    },
    settings: {
      home: (await $.env.get('HOME')) ?? '',
      app: APPS[(await $.env.get('TERM_PROGRAM')) ?? ''] ?? '',
      surface,
      options,
    },
    clock: { now: () => $.clock.now(), after: (ms, fn) => $.clock.after(ms, fn) },
    isShown: async () => (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown),
    toast: text => void $.ui.toast(text),
    status: text => void $.ui.status(text),
    store: {
      get: key => $.store.get(key),
      set: (key, value) => $.store.set(key, value),
      delete: key => $.store.delete(key),
    },
    session: await $.session.id(),
    redraw: () => void $.ui.invalidate('ui.render'),
    toPrompt: async text => (await $.prompt.fill({ text, mode: 'insert' })).isFilled,
    copy: async text => (await $.ui.copy({ text })).isCopied,
    async offers() {
      const messages = await $.session.messages()
      const files: string[] = []
      for (const message of [...messages].reverse()) {
        for (const use of [...message.toolUses].reverse()) {
          const path = use.input.file_path
          if (typeof path === 'string' && path.startsWith('/') && !files.includes(path)) {
            files.push(path)
          }
        }
      }
      const lastReply = messages.findLast(one => one.role === 'assistant' && one.text.trim())?.text.trim() ?? ''

      return { files: files.slice(0, OFFERED_FILES), lastReply: lastReply.slice(0, DRAFT) }
    },
    async openPath(path) {
      const res = await $.process.run([OPEN, path])
      if (res.exitCode !== 0) {
        throw new Error(res.stderr.trim() || `open exited ${res.exitCode}`)
      }
    },
  })
}

export const register: Register = (on, options: Options) => {
  let hub: Hub | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'channel',
      description: 'Open your chats in a pane',
      immediate: true,
    })
    hub = await build($, e.surface ?? 'none', options)
    if (e.isInteractive) {
      void hub.start()
    }

    return next(e)
  })

  // /clear ends the conversation, not the process, and no session.start follows.
  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear') {
      await hub?.stop()
    }

    return next(e)
  })

  on('command.run', { command: 'channel' }, async ($, e) => {
    // A sidebar: a third of the terminal, so Claude keeps most of the width.
    const columns = Math.max(MIN_COLUMNS, Math.round(e.presentation.columns * SIDEBAR))
    await $.ui.open({ id: PANE, title: 'Chats', focus: true, columns })
    await hub?.attend()

    return { text: 'channel opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    if (!hub) {
      return <elements.Text dimColor>Starting…</elements.Text>
    }

    return PaneView(hub, elements, {
      bodyColumns: e.props.bodyColumns,
      bodyRows: e.props.scroll.bodyRows,
      surface: e.surface,
      now: await $.clock.now(),
    })
  })
}
