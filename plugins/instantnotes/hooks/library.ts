// Pure helpers: finding the InstantNotes program and library from what the
// person already set up, and shaping text for the pane. Nothing here touches
// `$`, so the tests import them directly.

import type { Hit } from '../types'

export const APP_BINARY = 'InstantNotes.app/Contents/MacOS/instantnotes'

/** An MCP server entry as `claude mcp add` writes it, or as a `.mcp.json` holds it. */
export type ServerEntry = { command?: unknown; args?: unknown }

/** What one `instantnotes mcp …` command line says: the program, and the library it opens. */
export type Launch = { binary: string; db?: string; attachments?: string }

/**
 * Reads the `instantnotes` server out of a Claude Code MCP configuration:
 * `~/.claude.json` (top level and under `projects[cwd]`) or a `.mcp.json`.
 * The person set this up from the app's Agents page, so it names the exact
 * program and library they use.
 */
export function launchFromConfig(json: string, cwd?: string): Launch | null {
  let parsed: any
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const places: unknown[] = [parsed.mcpServers?.instantnotes, cwd === undefined ? undefined : parsed.projects?.[cwd]?.mcpServers?.instantnotes]
  for (const entry of places) {
    const launch = launchOf(entry as ServerEntry | undefined)
    if (launch !== null) return launch
  }
  return null
}

export function launchOf(entry: ServerEntry | undefined): Launch | null {
  if (!entry || typeof entry.command !== 'string' || entry.command.trim() === '') return null
  const args = Array.isArray(entry.args) ? entry.args.filter((one): one is string => typeof one === 'string') : []
  const launch: Launch = { binary: entry.command }
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--db' && args[i + 1]) launch.db = args[i + 1]
    if (args[i] === '--attachments' && args[i + 1]) launch.attachments = args[i + 1]
  }
  return launch
}

/**
 * The command line that asks `instantnotes mcp` one question. A binary typed
 * with its own arguments ("…/instantnotes mcp") still works: its words are
 * kept, a trailing `mcp` dropped, since `mcp` is added here.
 */
export function argvFor(binary: string, db: string, attachments: string): string[] {
  const words = binary.includes(' ') && !binary.startsWith('/') ? binary.trim().split(/\s+/) : [binary.trim()]
  if (words.length > 1 && words[words.length - 1] === 'mcp') words.pop()
  return [...words, 'mcp', '--db', db, '--attachments', attachments]
}

/** The attachments folder beside a library database. */
export const attachmentsBeside = (db: string) => db.replace(/[^/]*$/, 'attachments')

/** Where the app keeps its library on each platform, under `home`. */
export const defaultLibraries = (home: string) => ({
  linux: `${home}/.local/share/com.instantnotes.app/instantnotes.db`,
  mac: `${home}/Library/Application Support/com.instantnotes.app/instantnotes.db`,
})

/** Whether an error says the program could not start at all, rather than refusing a request. */
export const isNotFound = (message: string) => /ENOENT|posix_spawn|not found|cannot start|failed to start|no such file/i.test(message)

export const SETUP_STEPS = [
  'Open InstantNotes, then Settings › Agents, and turn Access on.',
  'Copy the "Claude Code" command there and run it once in a terminal (claude mcp add instantnotes …), then restart Claude Code.',
  'Or set InstantNotes binary in /config to the app\'s executable, such as /Applications/InstantNotes.app/Contents/MacOS/instantnotes.',
]

// ---------------------------------------------------------------- text

/** Text cut to fit `width` cells, with an ellipsis where it was cut. */
export const clip = (text: string, width: number) => (text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`)

/** One line of a note's text, control characters and newlines out, as the list shows it. */
export const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim()

/** Text as the Markdown element takes it: tab and newline its only control characters. */
export const printableMarkdown = (text: string) => text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')

/** A note's body cut to what one Markdown element may hold, and how much was cut. */
export function clipBody(body: string, max: number): { text: string; cut: number } {
  const clean = printableMarkdown(body)
  if (clean.length <= max) return { text: clean, cut: 0 }
  const kept = clean.slice(0, max - 1)
  // Cut at a line end when one is near, so a heading or list is not left half-drawn.
  const nl = kept.lastIndexOf('\n')
  const end = nl > max * 0.8 ? nl : kept.length
  return { text: `${clean.slice(0, end)}…`, cut: clean.length - end }
}

/** "3 min ago", "yesterday", "2026-09-30": a stamp as the list shows it, against `now`. */
export function ago(stamp: string | undefined, now: number): string {
  if (!stamp) return ''
  const at = Date.parse(stamp)
  if (Number.isNaN(at)) return ''
  const s = Math.max(0, (now - at) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 172800) return 'yesterday'
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`
  return stamp.slice(0, 10)
}

/** The hits whose title or excerpt holds every word typed, for filtering as the person types. */
export function filterHits(hits: readonly Hit[], typed: string): Hit[] {
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...hits]
  return hits.filter(hit => {
    const text = `${hit.title} ${hit.excerpt} ${hit.spaces.join(' ')}`.toLowerCase()
    return words.every(word => text.includes(word))
  })
}

/** The title a body gives a note: its first non-empty line, markdown marks off. */
export function titleOf(body: string): string {
  const line = body.split('\n').map(one => one.trim()).find(Boolean) ?? ''
  return oneLine(line.replace(/^#+\s*/, '').replace(/^[-*]\s+/, ''))
}
