#!/usr/bin/env node
// The browse plugin's browser: a headless Chrome driven over the DevTools
// protocol. It streams the page as frames on stdout (one JSON object a line)
// and takes navigation and input as HTTP requests on a Unix socket.
//
//   stdout  {"type":"ready","socket"}          once, when the socket listens
//           {"type":"page","url","title"}      when the page changes
//           {"type":"cells","columns","rows","cells"}   a frame as Raster cells
//           {"type":"image","file","generation"}         a frame as a PNG file
//           {"type":"error","message"}         a fatal error; the process exits
//   socket  POST /resize {columns, rows, mode: "cells" | "image"}
//           POST /navigate {url}   /back   /forward   /reload
//           POST /click {x, y}     /wheel {x, y, dy}    (x, y: 0..1 of the view)
//           POST /key {key, ctrl?, shift?, meta?}       /shutdown
//
// No dependencies. DevTools runs over a pipe (--remote-debugging-pipe), never
// a TCP port another local process could reach, and frames decode with zlib.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, platform, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { inflateSync } from 'node:zlib'

const CSS_PX_PER_COLUMN = 8 // a terminal cell is about 8 by 16 pixels
const FRAME_MS = 66 // at most ~15 frames a second

function emit(message) {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  } catch {
    shutdown(0)
  }
}

function fail(message) {
  emit({ type: 'error', message })
  shutdown(1)
}

// ---------------------------------------------------------------- Chrome

function findChrome() {
  const named = process.env.BROWSE_CHROME
  if (named) return existsSync(named) ? named : null
  const candidates = platform() === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      ]
    : (process.env.PATH ?? '').split(delimiter).flatMap(dir =>
        ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge']
          .map(name => join(dir, name)))
  return candidates.find(path => existsSync(path)) ?? null
}

let chrome = null
let runDir = null
let stopping = false

function shutdown(code) {
  if (stopping) return
  stopping = true
  try { chrome?.kill('SIGTERM') } catch {}
  try { if (runDir) rmSync(runDir, { recursive: true, force: true }) } catch {}
  process.exit(code)
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => shutdown(0))
process.on('exit', () => { try { chrome?.kill('SIGTERM') } catch {} })
process.on('uncaughtException', err => fail(`browser helper crashed: ${err.message}`))
// The engine closes our stdin at spawn, so watch the parent instead: if
// Claude Code goes away without stopping us, Chrome must not keep playing.
const parent = process.ppid
setInterval(() => {
  try { process.kill(parent, 0) } catch { shutdown(0) }
}, 2000).unref()

// ---------------------------------------------------------------- DevTools

let nextId = 1
const pending = new Map()
const listeners = []
let sessionId = null
let targetId = null

/** Chrome reads commands on fd 3 and writes replies and events on fd 4, each
 * message a JSON text ended by a NUL. */
function send(method, params = {}, session = sessionId) {
  const id = nextId++
  chrome.stdio[3].write(`${JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) })}\0`)
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }))
}

function receive(message) {
  if (message.id !== undefined) {
    const waiter = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) waiter?.reject(new Error(`${waiter.method}: ${message.error.message}`))
    else waiter?.resolve(message.result)
  } else {
    for (const listen of listeners) listen(message)
  }
}

function on(method, fn) {
  listeners.push(m => { if (m.method === method) fn(m.params, m.sessionId) })
}

function launch() {
  if (platform() === 'win32') {
    fail('Windows is not supported yet: the browser runs on macOS and Linux.')
  }
  const binary = findChrome()
  if (!binary) {
    fail('No Chrome, Chromium, Brave or Edge found. Install one, or set the Chrome path in /config.')
  }
  const profile = process.env.BROWSE_PROFILE || join(homedir(), '.cache', 'claude-browse', 'chrome-profile')
  mkdirSync(profile, { recursive: true })

  chrome = spawn(binary, [
    '--headless=new',
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--hide-scrollbars',
    '--window-size=1280,800',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] })
  let unread = ''
  chrome.stdio[4].setEncoding('utf8')
  chrome.stdio[4].on('data', chunk => {
    unread += chunk
    for (let end = unread.indexOf('\0'); end >= 0; end = unread.indexOf('\0')) {
      receive(JSON.parse(unread.slice(0, end)))
      unread = unread.slice(end + 1)
    }
  })
  let chromeErr = ''
  chrome.stderr.on('data', d => { chromeErr = (chromeErr + d).slice(-2000) })
  chrome.on('error', err => fail(`Chrome could not start: ${err.message}`))
  chrome.on('exit', code => {
    if (stopping) return
    const locked = /SingletonLock|ProcessSingleton|already running/i.test(chromeErr)
    fail(locked
      ? 'The browser profile is in use by another browse pane. Close that one first.'
      : `Chrome exited (${code}). ${chromeErr.trim().split('\n').pop() ?? ''}`)
  })
}

// ---------------------------------------------------------------- frames

const view = { columns: 0, rows: 0, mode: 'cells' }
let latestFrame = null
let lastSent = 0
let flushTimer = null
let generation = 0

/** Decodes an 8-bit, non-interlaced RGB or RGBA PNG to { width, height, rgba }. */
function decodePng(buffer) {
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 0
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      colorType = data[9]
      if (data[8] !== 8 || data[12] !== 0 || (colorType !== 2 && colorType !== 6)) {
        throw new Error('unsupported PNG')
      }
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  const bpp = colorType === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const pixels = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? pixels[out + x - bpp] : 0
      const b = y > 0 ? pixels[out + x - stride] : 0
      const c = x >= bpp && y > 0 ? pixels[out + x - stride - bpp] : 0
      let value = line[x]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      pixels[out + x] = value & 0xff
    }
  }
  return { width, height, bpp, pixels }
}

/** Packs a frame into Raster cells: one upper-half block per cell, the top
 * pixel as foreground and the bottom pixel as background. */
function toCells(png, columns, rows) {
  const { width, height, bpp, pixels } = decodePng(png)
  const words = new Uint32Array(columns * rows * 3)
  const pixel = (x, y) => {
    const px = Math.min(width - 1, Math.floor(((x + 0.5) * width) / columns))
    const py = Math.min(height - 1, Math.floor(((y + 0.5) * height) / (rows * 2)))
    const i = (py * width + px) * bpp
    return (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]
  }
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const i = (row * columns + col) * 3
      words[i] = 0x2580
      words[i + 1] = pixel(col, row * 2)
      words[i + 2] = pixel(col, row * 2 + 1)
    }
  }
  return Buffer.from(words.buffer).toString('base64')
}

function flush() {
  flushTimer = null
  if (!latestFrame || view.columns === 0) return
  const png = latestFrame
  latestFrame = null
  lastSent = Date.now()
  if (view.mode === 'image') {
    generation += 1
    const file = join(runDir, `frame-${generation % 2}.png`)
    writeFileSync(`${file}.tmp`, png)
    renameSync(`${file}.tmp`, file)
    emit({ type: 'image', file, generation, columns: view.columns, rows: view.rows })
  } else {
    emit({ type: 'cells', columns: view.columns, rows: view.rows, cells: toCells(png, view.columns, view.rows) })
  }
}

function queueFrame(png) {
  latestFrame = png
  if (flushTimer) return
  flushTimer = setTimeout(flush, Math.max(0, FRAME_MS - (Date.now() - lastSent)))
}

function viewport() {
  return { width: view.columns * CSS_PX_PER_COLUMN, height: view.rows * 2 * CSS_PX_PER_COLUMN }
}

async function resize({ columns, rows, mode }) {
  view.columns = Math.max(1, Math.min(512, Math.floor(columns)))
  view.rows = Math.max(1, Math.min(256, Math.floor(rows)))
  view.mode = mode === 'image' ? 'image' : 'cells'
  const { width, height } = viewport()
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await send('Page.stopScreencast')
  await send('Page.startScreencast', view.mode === 'image'
    ? { format: 'png', maxWidth: width, maxHeight: height }
    : { format: 'png', maxWidth: view.columns, maxHeight: view.rows * 2 })
}

// ---------------------------------------------------------------- input

const SPECIAL_KEYS = {
  return: ['Enter', 13, '\r'], enter: ['Enter', 13, '\r'], tab: ['Tab', 9], backspace: ['Backspace', 8],
  delete: ['Delete', 46], escape: ['Escape', 27], up: ['ArrowUp', 38], down: ['ArrowDown', 40],
  left: ['ArrowLeft', 37], right: ['ArrowRight', 39], pageup: ['PageUp', 33], pagedown: ['PageDown', 34],
  home: ['Home', 36], end: ['End', 35], space: [' ', 32, ' '],
}

async function pressKey({ key, ctrl, shift, meta }) {
  const modifiers = (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0)
  const special = SPECIAL_KEYS[key]
  if (!special && [...key].length !== 1) return
  const [name, code, text] = special ?? [key, key.toUpperCase().charCodeAt(0), ctrl || meta ? undefined : key]
  const base = { key: name, windowsVirtualKeyCode: code, modifiers }
  await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text } : {}) })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

function point({ x, y }) {
  const { width, height } = viewport()
  return { x: Math.round(Math.min(1, Math.max(0, x)) * width), y: Math.round(Math.min(1, Math.max(0, y)) * height) }
}

async function click(at) {
  const { x, y } = point(at)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

async function wheel(at) {
  const { x, y } = point(at)
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: at.dy * 120 })
}

async function history(step) {
  const { currentIndex, entries } = await send('Page.getNavigationHistory')
  const entry = entries[currentIndex + step]
  if (entry) await send('Page.navigateToHistoryEntry', { entryId: entry.id })
}

async function navigate({ url }) {
  const result = await send('Page.navigate', { url })
  if (result.errorText) throw new Error(`${result.errorText} (${url})`)
}

const routes = {
  '/resize': resize,
  '/navigate': navigate,
  '/back': () => history(-1),
  '/forward': () => history(1),
  '/reload': () => send('Page.reload'),
  '/click': click,
  '/wheel': wheel,
  '/key': pressKey,
  '/shutdown': () => setTimeout(() => shutdown(0), 10),
}

function serve() {
  const socket = join(runDir, 'browser.sock')
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', async () => {
      const route = routes[req.url]
      try {
        if (!route) throw new Error(`no route ${req.url}`)
        await route(body ? JSON.parse(body) : {})
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: err.message }))
      }
    })
  })
  return new Promise(resolve => server.listen(socket, () => resolve(socket)))
}

// ---------------------------------------------------------------- main

async function main() {
  runDir = mkdtempSync(join(tmpdir(), 'browse-'))
  launch()

  const { userAgent } = await send('Browser.getVersion', {}, null)
  await send('Target.setDiscoverTargets', { discover: true }, null)
  const { targetInfos } = await send('Target.getTargets', {}, null)
  targetId = targetInfos.find(t => t.type === 'page')?.targetId
    ?? (await send('Target.createTarget', { url: 'about:blank' }, null)).targetId
  sessionId = (await send('Target.attachToTarget', { targetId, flatten: true }, null)).sessionId

  await send('Page.enable')
  // Sites serve a lesser page to an agent that calls itself headless.
  await send('Emulation.setUserAgentOverride', { userAgent: userAgent.replace('HeadlessChrome', 'Chrome') })

  on('Page.screencastFrame', (params, session) => {
    if (session !== sessionId) return
    send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
    queueFrame(Buffer.from(params.data, 'base64'))
  })

  let page = { url: '', title: '' }
  const popups = new Set()
  on('Target.targetCreated', ({ targetInfo }) => {
    if (targetInfo.type === 'page' && targetInfo.openerId === targetId) popups.add(targetInfo.targetId)
  })
  on('Target.targetInfoChanged', ({ targetInfo }) => {
    // One tab only: a link that opens a new tab opens here instead.
    if (popups.has(targetInfo.targetId) && targetInfo.url && targetInfo.url !== 'about:blank') {
      popups.delete(targetInfo.targetId)
      send('Target.closeTarget', { targetId: targetInfo.targetId }, null).catch(() => {})
      navigate({ url: targetInfo.url }).catch(() => {})
      return
    }
    if (targetInfo.targetId !== targetId) return
    if (targetInfo.url === page.url && targetInfo.title === page.title) return
    page = { url: targetInfo.url, title: targetInfo.title }
    emit({ type: 'page', ...page })
  })

  emit({ type: 'ready', socket: await serve() })
}

main().catch(err => fail(err.message))
