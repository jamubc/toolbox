import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { BEN, mac, row } from './kit/mac'

const PANE_PROPS = {
  title: 'Chats',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}
const SURFACES = ['terminal', 'desktop'] as const

async function start($: Engine) {
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
}

async function openPane($: Engine) {
  await $.command.run({ command: 'channel', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
}

function mount($: Engine, surface: (typeof SURFACES)[number]) {
  return $.ui.mount({ plugin: 'channel', surface, component: 'Pane', props: PANE_PROPS, requestId: 'channel' })
}

test('the pane shows the service tab and its conversations, and a press opens one', async ($, on) => {
  const m = mac(on)
  await start($)
  await m.clock.settle()

  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await ui.find({ text: ' iMessage ' })).toBeDefined()
    expect((await ui.find({ key: 'open-imessage-2' }))?.text).toBe('Book club')
    // The row shows who is in it and its newest message.
    expect(await ui.find({ text: /3 people/ })).toBeDefined()
    expect(await ui.find({ text: /You: on my way/ })).toBeDefined()
    await ui.press({ key: 'open-imessage-1' })
    expect(await ui.find({ text: /see you at six/ })).toBeDefined()
    expect(await ui.find({ text: /on my way/ })).toBeDefined()
    // Messages sit under the day they came, and mine are "You".
    expect(await ui.find({ text: '── Today ──' })).toBeDefined()
    expect(await ui.find({ text: 'You' })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})

test('a reply shows what it answers, with reactions; an attachment shows as a file', async ($, on) => {
  const m = mac(on)
  await start($)
  await m.clock.settle()

  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    await ui.press({ key: 'open-imessage-1' })
    expect(await ui.find({ text: /↳ .*see you at six/ })).toBeDefined()
    expect(await ui.find({ text: /👍/ })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.press({ key: 'open-imessage-2' })
    expect(await ui.find({ text: /🖼 photo\.png · 2 KB/ })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})

test('an edited message is marked and an unsent one says so, as they change', async ($, on) => {
  const m = mac(on)
  await start($)
  await m.clock.settle()
  await openPane($)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'open-imessage-1' })

  m.rows[0] = { ...row(10, 1, { text: 'see you at seven' }), edited: '900' }
  m.rows[1] = { ...row(11, 1, { fromMe: 1, handle: null, text: 'on my way' }), retracted: '950' }
  await m.clock.advance(3_000)

  expect(await ui.find({ text: /see you at seven/ })).toBeDefined()
  expect(await ui.find({ text: /\(edited\)/ })).toBeDefined()
  expect(await ui.find({ text: /message unsent/ })).toBeDefined()
  await ui.unmount()
})

test('a new message while the pane is closed toasts and counts; my own does not', async ($, on) => {
  const m = mac(on)
  await start($)
  await m.clock.settle()
  expect(m.toasts).toEqual([])

  m.receive(row(14, 2, { handle: '+15555550103', text: 'chapter 4 tonight?' }))
  m.receive(row(15, 1, { fromMe: 1, handle: null, text: 'sent from my phone' }))
  await m.clock.advance(10_000)

  expect(m.toasts).toEqual(['Book club · +15555550103: chapter 4 tonight?'])
  expect(m.statuses.at(-1)).toBe('iMessage 1 new')

  const ui = await mount($, 'terminal')
  expect(await ui.find({ text: ' iMessage 1 ' })).toBeDefined()
  expect(await ui.find({ key: 'jump' })).toBeDefined()
  await ui.press({ key: 'jump' })
  expect(await ui.find({ text: /chapter 4 tonight/ })).toBeDefined()
  await ui.unmount()
})

test('Enter sends the text, and attach sends a file', async ($, on) => {
  const m = mac(on)
  await start($)
  await m.clock.settle()
  await openPane($)

  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    await ui.press({ key: 'open-imessage-1' })
    await ui.input({ key: 'reply', text: '  ' })
    await ui.input({ key: 'reply', text: 'hello' })
    expect((await ui.find({ key: 'reply' }))?.text).toBe('')
    expect(await ui.find({ text: 'Sent.' })).toBeDefined()
    await ui.press({ key: 'attach' })
    await ui.input({ key: 'attach-path', text: '/tmp/notes.pdf' })
    expect(await ui.find({ key: 'reply' })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.unmount()
  }

  const sends = m.runs.filter(argv => argv[0] === '/usr/bin/osascript')
  expect(sends.map(argv => argv.at(-2))).toEqual(['xhello', 'x/tmp/notes.pdf', 'xhello', 'x/tmp/notes.pdf'])
})

test('open on a file opens it with the system, in the terminal only', async ($, on) => {
  const m = mac(on)
  await start($)
  await m.clock.settle()

  const ui = await mount($, 'terminal')
  await ui.press({ key: 'open-imessage-2' })
  await ui.press({ key: 'open-file-12-0' })
  expect(m.runs.at(-1)).toEqual(['/usr/bin/open', '/Users/someone/Library/Messages/Attachments/aa/01/photo.png'])
  await ui.press({ key: 'back' })
  await ui.unmount()

  const desktop = await mount($, 'desktop')
  await desktop.press({ key: 'open-imessage-2' })
  expect(await desktop.find({ key: 'open-file-12-0' })).toBe(undefined)
  await desktop.press({ key: 'back' })
  await desktop.unmount()
})

test('without Full Disk Access the tab says what to turn on, step by step', async ($, on) => {
  const m = mac(on)
  m.revokeAccess()
  await start($)
  await m.clock.settle()

  const ui = await mount($, 'terminal')
  expect(await ui.find({ text: /iMessage cannot read your Messages yet/ })).toBeDefined()
  expect(await ui.find({ text: /1\. Open System Settings › Privacy & Security › Full Disk Access/ })).toBeDefined()
  expect(await ui.find({ text: /2\. Turn on Ghostty/ })).toBeDefined()
  expect(m.toasts).toEqual([])
  await ui.unmount()
})

test('turned off in settings, iMessage has no tab and reads nothing', { options: { imessage: false } }, async ($, on) => {
  const m = mac(on)
  await start($)
  await m.clock.settle()

  const ui = await mount($, 'terminal')
  expect(await ui.find({ text: /No chat service is set up/ })).toBeDefined()
  expect(m.runs).toEqual([])
  await ui.unmount()
})

test('ending the session gives up the toast lease', async ($, on) => {
  const m = mac(on)
  await start($)
  await m.clock.settle()
  m.receive(row(14, 2, { handle: BEN, text: 'hi' }))
  await m.clock.advance(10_000)
  expect(m.store.has('notifier')).toBe(true)

  await $.session.end({ reason: 'other', sessionId: 'session-one', resume: { id: 'session-one' } })
  expect(m.store.has('notifier')).toBe(false)
})

test('a file goes into the Claude prompt and the clipboard; a session file and a reply go out', async ($, on) => {
  const m = mac(on)
  await start($)
  await m.clock.settle()
  await openPane($)
  const photo = '/Users/someone/Library/Messages/Attachments/aa/01/photo.png'

  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    await ui.press({ key: 'open-imessage-2' })
    await ui.press({ key: 'claude-file-12-0' })
    expect(await ui.find({ text: 'Added to your prompt.' })).toBeDefined()
    await ui.press({ key: 'copy-file-12-0' })

    await ui.press({ key: 'attach' })
    expect((await ui.find({ key: 'offer-0' }))?.text).toBe('📎 notes.md')
    await ui.press({ key: 'offer-0' })
    await ui.press({ key: 'draft-reply' })
    expect((await ui.find({ key: 'reply' }))?.text).toBe('Here are the notes.')
    await ui.input({ key: 'reply', text: 'Here are the notes.' })
    await ui.press({ key: 'back' })
    await ui.unmount()
  }

  expect(m.prompt).toEqual([`${photo} `, `${photo} `])
  expect(m.copied).toEqual([photo, photo])
  const sends = m.runs.filter(argv => argv[0] === '/usr/bin/osascript').map(argv => argv.at(-2))
  expect(sends).toEqual(['x/work/notes.md', 'xHere are the notes.', 'x/work/notes.md', 'xHere are the notes.'])
})

test('the file name is the open button, and an unread chat is marked', async ($, on) => {
  const m = mac(on)
  await start($)
  await m.clock.settle()
  m.receive(row(14, 2, { handle: BEN, text: 'look at this' }))
  await m.clock.advance(10_000)

  const ui = await mount($, 'terminal')
  expect((await ui.find({ key: 'open-imessage-2' }))?.text).toBe('Book club')
  expect(await ui.find({ text: '  1 new' })).toBeDefined()
  expect(await ui.find({ text: /look at this/ })).toBeDefined()
  await ui.press({ key: 'open-imessage-2' })
  expect((await ui.find({ key: 'open-file-12-0' }))?.text).toBe('🖼 photo.png · 2 KB')
  await ui.press({ key: 'back' })
  await ui.unmount()
})

test('a picture shows inline in the terminal, from a thumbnail sips makes', async ($, on) => {
  const m = mac(on)
  await start($)
  await m.clock.settle()

  const ui = await mount($, 'terminal')
  await ui.press({ key: 'open-imessage-2' })
  await m.clock.settle()
  expect(await ui.find({ key: 'picture-12-0' })).toBeDefined()
  const sips = m.runs.filter(argv => argv[0] === '/usr/bin/sips')
  // Ghostty draws pixels: a sharp PNG the terminal reads itself, never held here.
  expect(sips.map(argv => argv.slice(1, 6))).toEqual([
    ['-g', 'pixelWidth', '-g', 'pixelHeight', '/Users/someone/Library/Messages/Attachments/aa/01/photo.png'],
    ['-s', 'format', 'png', '-Z', '1600'],
  ])
  const picture = await ui.find({ key: 'picture-12-0' })
  expect(picture?.type).toBe('Image')
  expect(picture?.props.source).toEqual({ file: '/tmp/claude-channel-picture-0.png', format: 'png', generation: 1 })
  // A 4:3 photo keeps its shape: 12 rows of the 30-row pane, 32 columns.
  expect([picture?.props.columns, picture?.props.rows]).toEqual([32, 12])
  await ui.press({ key: 'back' })
  await ui.unmount()

  // The desktop app cannot start sips: the file row alone.
  const desktop = await mount($, 'desktop')
  await desktop.press({ key: 'open-imessage-2' })
  expect(await desktop.find({ key: 'picture-12-0' })).toBe(undefined)
  await desktop.press({ key: 'back' })
  await desktop.unmount()
})

test('the pane fits its width: narrow clips and shortens, wide gives a picture more room', async ($, on) => {
  const m = mac(on)
  await start($)
  await m.clock.settle()
  const sized = (bodyColumns: number, bodyRows: number) =>
    $.ui.mount({
      plugin: 'channel',
      surface: 'terminal',
      component: 'Pane',
      props: { ...PANE_PROPS, bodyColumns, scroll: { offset: 0, bodyRows } },
      requestId: 'channel',
    })

  const narrow = await sized(24, 12)
  // "+15555550102, +15555550103" would not fit; "Book club" does.
  expect((await narrow.find({ key: 'open-imessage-2' }))?.text).toBe('Book club')
  await narrow.press({ key: 'open-imessage-2' })
  await m.clock.settle()
  expect((await narrow.find({ key: 'copy-file-12-0' }))?.text).toBe('copy')
  expect((await narrow.find({ key: 'draft-reply' }))?.text).toBe('reply')
  expect((await narrow.find({ key: 'open-file-12-0' }))?.text).toBe('🖼 photo.png · 2 KB')
  const small = await narrow.find({ key: 'picture-12-0' })
  await narrow.unmount()

  const wide = await sized(120, 60)
  expect((await wide.find({ key: 'copy-file-12-0' }))?.text).toBe('copy path')
  expect((await wide.find({ key: 'draft-reply' }))?.text).toBe("Claude's reply")
  const large = await wide.find({ key: 'picture-12-0' })
  await wide.press({ key: 'back' })
  await wide.unmount()

  // A 4:3 photo: as wide as a cramped pane lets it, and up to 24 rows in a roomy one.
  expect([small?.props.columns, small?.props.rows]).toEqual([11, 4])
  expect([large?.props.columns, large?.props.rows]).toEqual([64, 24])
})

test('older brings more history into the conversation, and latest returns to the end', async ($, on) => {
  const m = mac(on)
  await start($)
  await m.clock.settle()
  await openPane($)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'open-imessage-1' })
  expect(await ui.find({ key: 'older' })).toBeDefined()
  expect(await ui.find({ key: 'latest' })).toBeUndefined()

  await ui.press({ key: 'older' })
  await m.clock.settle()
  // Nothing older than row 10: the service answered an empty page, so the start is marked.
  const asked = m.runs.filter(argv => /channel:history/.test(argv[4] ?? '') && /m\.ROWID < 10/.test(argv[4] ?? ''))
  expect(asked).toHaveLength(1)
  expect(await ui.find({ key: 'latest' })).toBeDefined()
  expect(await ui.find({ key: 'older' })).toBeUndefined()
  expect(await ui.find({ text: /the start of this conversation/ })).toBeDefined()
  await ui.press({ key: 'latest' })
  expect(await ui.find({ key: 'latest' })).toBeUndefined()
  await ui.press({ key: 'back' })
  await ui.unmount()
})

test('previews off in settings shows the file row alone', { options: { pictures: 'no previews, files only' } }, async ($, on) => {
  const m = mac(on)
  await start($)
  await m.clock.settle()
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'open-imessage-2' })
  await m.clock.settle()
  expect(await ui.find({ key: 'picture-12-0' })).toBeUndefined()
  expect(m.runs.filter(argv => argv[0] === '/usr/bin/sips')).toEqual([])
  expect((await ui.find({ key: 'open-file-12-0' }))?.text).toBe('🖼 photo.png · 2 KB')
  await ui.unmount()
})

test('colored blocks forced in settings packs a picture into cells, encoded once per size', { options: { pictures: 'always colored blocks (any terminal)' } }, async ($, on) => {
  const m = mac(on)
  await start($)
  await m.clock.settle()
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'open-imessage-2' })
  await m.clock.settle()
  const picture = await ui.find({ key: 'picture-12-0' })
  expect(picture?.type).toBe('Raster')
  expect([picture?.props.columns, picture?.props.rows]).toEqual([32, 12])
  const sips = m.runs.filter(argv => argv[0] === '/usr/bin/sips')
  expect(sips[1]?.slice(1, 6)).toEqual(['-s', 'format', 'bmp', '-Z', '200'])
  await ui.unmount()
})

test('a terminal that draws the alt text instead of pixels falls back to cells', async ($, on) => {
  const m = mac(on)
  on('ui.blit', () => ({ value: { deny: 'the Image draws its alt there: this terminal cannot read the file' } }))
  await start($)
  await m.clock.settle()
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'open-imessage-2' })
  await m.clock.advance(1_000)
  expect((await ui.find({ key: 'picture-12-0' }))?.type).toBe('Image')
  // Each refused probe is counted; the third turns pictures into cells for the session.
  for (let i = 0; i < 2; i += 1) {
    await ui.press({ key: 'back' })
    await ui.press({ key: 'open-imessage-2' })
    await m.clock.advance(1_000)
  }
  expect((await ui.find({ key: 'picture-12-0' }))?.type).toBe('Raster')
  expect(m.toasts.at(-1)).toMatch(/colored blocks/)
  await ui.unmount()
})
