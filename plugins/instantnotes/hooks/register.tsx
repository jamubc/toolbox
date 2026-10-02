// InstantNotes in a pane: search, read, capture. It reaches the library the
// way the app's Agents page sets Claude Code up to: through the `instantnotes`
// MCP server Claude Code already runs when the person added it with
// `claude mcp add instantnotes …`, and otherwise by running `instantnotes mcp`
// itself, found from that same configuration, the app bundle, or PATH.

import { atom, derive, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Hit, OpenNote, Problem, Source } from '../types'
import {
  APP_BINARY, SETUP_STEPS, ago, argvFor, attachmentsBeside, clip, clipBody, defaultLibraries, filterHits, isNotFound,
  launchFromConfig, oneLine, titleOf,
} from './library'
import type { Launch } from './library'

const PANE = 'instantnotes'
const SERVER = 'instantnotes'
const LIST_LIMIT = 20
const MARKDOWN_MAX = 9000
const PASTE_MAX = 6000
const CACHE_MS = 60_000
const PROTOCOL = '2026-07-28'
const NARROW = 56
const ROW_BG = '#1c2730'

const query = atom({ plugin: 'instantnotes', key: 'query' } as const, '')
const typed = atom({ plugin: 'instantnotes', key: 'typed' } as const, '')
const hits = atom({ plugin: 'instantnotes', key: 'hits' } as const, [])
const note = atom({ plugin: 'instantnotes', key: 'note' } as const, null)
const problem = atom({ plugin: 'instantnotes', key: 'problem' } as const, null)
const isBusy = atom({ plugin: 'instantnotes', key: 'isBusy' } as const, false)
const isComposing = atom({ plugin: 'instantnotes', key: 'isComposing' } as const, false)
const source = atom({ plugin: 'instantnotes', key: 'source' } as const, null)
const seeded = atom({ plugin: 'instantnotes', key: 'seeded' } as const, false)

// /clear ends the session but not the process: the host's `$.state` starts over empty while this
// module and its pane live on, so read straight from the host the search and the open note are
// suddenly gone. `seeded` is false exactly then, and before the first `session.start`. `snapshot` is
// what the pane draws from, read in one go: the host's while `seeded`, else what this process
// last saw; `write` puts the kept values back before the first change after a /clear, and a
// render that finds `seeded` false schedules that.
type Snapshot = {
  query: string
  typed: string
  hits: Hit[]
  note: OpenNote | null
  problem: Problem | null
  isBusy: boolean
  isComposing: boolean
  source: Source
}
const KEYS = ['query', 'typed', 'hits', 'note', 'problem', 'isBusy', 'isComposing', 'source'] as const
let kept: Snapshot = { query: '', typed: '', hits: [], note: null, problem: null, isBusy: false, isComposing: false, source: null }
let wasLive: boolean | null = null // what the last read saw; null before the first
const snapshot = derive(
  [seeded, query, typed, hits, note, problem, isBusy, isComposing, source],
  (isLive, query, typed, hits, note, problem, isBusy, isComposing, source): Snapshot => {
    wasLive = isLive
    if (!isLive) return kept
    kept = { query, typed, hits, note, problem, isBusy, isComposing, source }
    return kept
  },
)

/** The one place the atoms are written: each key to its own, as the validator asks. */
async function put<K extends keyof Snapshot>($: EngineInterface, key: K, value: Snapshot[K]): Promise<void> {
  switch (key) {
    case 'query': await update($, query, () => value as Snapshot['query']); break
    case 'typed': await update($, typed, () => value as Snapshot['typed']); break
    case 'hits': await update($, hits, () => value as Snapshot['hits']); break
    case 'note': await update($, note, () => value as Snapshot['note']); break
    case 'problem': await update($, problem, () => value as Snapshot['problem']); break
    case 'isBusy': await update($, isBusy, () => value as Snapshot['isBusy']); break
    case 'isComposing': await update($, isComposing, () => value as Snapshot['isComposing']); break
    case 'source': await update($, source, () => value as Snapshot['source']); break
  }
}

/** After a /clear (or at the first start), writes what this process kept back to the host. */
let reseeding: Promise<void> | null = null
function reseed($: EngineInterface): Promise<void> {
  reseeding ??= (async () => {
    try {
      if (await read($, seeded)) return
      for (const key of KEYS) await put($, key, kept[key])
      await update($, seeded, () => true)
      wasLive = true
    } finally {
      reseeding = null
    }
  })()
  return reseeding
}

/** Changes one value from what `snapshot` reads, and keeps it here too. */
async function write<K extends keyof Snapshot>($: EngineInterface, key: K, change: (now: Snapshot[K]) => Snapshot[K]): Promise<void> {
  // `kept` is current once a read has seen the host live: only this module writes these values.
  if (wasLive === null) await read($, snapshot)
  if (!wasLive) await reseed($)
  const next = change(kept[key])
  kept = { ...kept, [key]: next }
  await put($, key, next)
}

type Options = { binary?: string; db?: string }

// What only this process has: notes already read, so a second look is
// instant, and whether the MCP server answered this session.
let home = ''
let cwd = ''
let mcpIsDown = false
const notes = new Map<string, { note: OpenNote; at: number }>()
let recent: { hits: Hit[]; at: number } | null = null

const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

// ---------------------------------------------------------------- reaching InstantNotes

/** The program and library to run, from what the person already set up. */
async function findLaunch($: EngineInterface, options: Options): Promise<Launch> {
  const chosen = (options.binary ?? '').trim()
  const candidates: Launch[] = []
  if (chosen !== '' && chosen !== 'instantnotes') candidates.push({ binary: chosen })
  // What `claude mcp add instantnotes …` wrote: the exact program and library the app named.
  for (const file of [`${home}/.claude.json`, `${cwd}/.mcp.json`]) {
    try {
      const found = launchFromConfig(await $.fs.read(file), cwd)
      if (found !== null) candidates.push(found)
    } catch {}
  }
  candidates.push({ binary: `/Applications/${APP_BINARY}` }, { binary: `${home}/Applications/${APP_BINARY}` })
  for (const candidate of candidates) {
    if (candidate.binary.startsWith('/')) {
      try {
        if (!(await $.fs.exists(candidate.binary))) continue
      } catch {
        continue
      }
    }
    return candidate
  }
  return { binary: chosen || 'instantnotes' }
}

async function defaultDb($: EngineInterface): Promise<string> {
  const { linux, mac } = defaultLibraries(home)
  try {
    await $.fs.stat(linux)
    return linux
  } catch {
    return mac
  }
}

async function processSource($: EngineInterface, options: Options): Promise<Source> {
  const launch = await findLaunch($, options)
  const db = options.db || launch.db || (await defaultDb($))
  const attachments = launch.attachments && !options.db ? launch.attachments : attachmentsBeside(db)
  return { kind: 'process', argv: argvFor(launch.binary, db, attachments) }
}

function resultOf(reply: { isError?: boolean; content?: { text?: string }[]; structuredContent?: unknown }): any {
  if (reply.isError) throw new Error(reply.content?.[0]?.text ?? 'InstantNotes refused')
  if (reply.structuredContent !== undefined) return reply.structuredContent
  const text = reply.content?.[0]?.text ?? ''
  try {
    return JSON.parse(text)
  } catch {
    return { text }
  }
}

/**
 * One tools/call, in the stateless 2026-07-28 era: a single request line in,
 * a single response out, no handshake.
 */
async function callProcess($: EngineInterface, argv: readonly string[], name: string, args: Record<string, unknown>): Promise<any> {
  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name,
      arguments: args,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': PROTOCOL,
        'io.modelcontextprotocol/clientInfo': { name: 'Claude Code', version: '0' },
      },
    },
  }
  const ran = await $.process.run(argv, { stdin: `${JSON.stringify(request)}\n`, timeoutMs: 15000 })
  const line = ran.stdout.trim().split('\n').find(one => one.startsWith('{')) ?? ''
  if (line === '') {
    throw new Error(ran.stderr.trim() || `instantnotes exited ${ran.exitCode} without answering`)
  }
  const reply = JSON.parse(line)
  if (reply.error) throw new Error(reply.error.message)
  return resultOf(reply.result)
}

/** Asks InstantNotes one question, by the server Claude Code runs when it has one, else by a process of its own. */
async function ask($: EngineInterface, options: Options, name: string, args: Record<string, unknown>): Promise<any> {
  let from = (await read($, snapshot)).source
  if (from === null && !mcpIsDown) {
    try {
      const reply = await $.mcp.call(SERVER, name, args)
      const viaMcp: Source = { kind: 'mcp', server: SERVER }
      await write($, 'source', () => viaMcp)
      return resultOf(reply)
    } catch (err) {
      // Not connected here: the person has not run `claude mcp add`, or it is off.
      mcpIsDown = true
      $.ui.log(`instantnotes: no MCP server "${SERVER}" (${reasonOf(err)}); running instantnotes itself`, { to: 'debug' })
    }
  }
  if (from?.kind === 'mcp') {
    return resultOf(await $.mcp.call(from.server, name, args))
  }
  const running = from ?? (await processSource($, options))
  if (from === null) await write($, 'source', () => running)
  if (running === null || running.kind !== 'process') throw new Error('InstantNotes is not reachable')
  try {
    return await callProcess($, running.argv, name, args)
  } catch (err) {
    if (isNotFound(reasonOf(err))) {
      // Forget the program so the next try looks again (after an install, a /config change).
      await write($, 'source', () => null)
    }
    throw err
  }
}

/** Runs one request, showing that it is under way and what went wrong. */
async function attempt<T>($: EngineInterface, work: () => Promise<T>): Promise<T | undefined> {
  await write($, 'isBusy', () => true)
  try {
    const result = await work()
    await write($, 'problem', () => null)
    return result
  } catch (err) {
    const message = reasonOf(err)
    const trouble: Problem = isNotFound(message)
      ? { message: `InstantNotes could not be started: ${message}`, steps: SETUP_STEPS }
      : { message, steps: [] }
    await write($, 'problem', () => trouble)
    return undefined
  } finally {
    await write($, 'isBusy', () => false)
  }
}

// ---------------------------------------------------------------- notes

function toHit(found: any): Hit {
  return {
    id: String(found.id),
    title: oneLine(String(found.title ?? '')) || 'Untitled',
    excerpt: oneLine(String(found.excerpt ?? found.snippet ?? '')),
    spaces: Array.isArray(found.spaces) ? found.spaces.map(String) : [],
    updatedAt: typeof found.updatedAt === 'string' ? found.updatedAt : undefined,
  }
}

async function search($: EngineInterface, options: Options, text: string, isForced = false): Promise<void> {
  const words = text.trim()
  await write($, 'query', () => words)
  await write($, 'typed', () => words)
  await write($, 'note', () => null)
  const now = await $.clock.now()
  if (words === '' && !isForced && recent !== null && now - recent.at < CACHE_MS) {
    const kept = recent.hits
    await write($, 'hits', () => kept)
    return
  }
  const found = await attempt($, async (): Promise<Hit[]> =>
    words
      ? ((await ask($, options, 'search_notes', { query: words, limit: LIST_LIMIT })).results ?? []).map(toHit)
      : ((await ask($, options, 'list_notes', { limit: LIST_LIMIT })).notes ?? []).map(toHit))
  if (found === undefined) return
  if (words === '') recent = { hits: found, at: now }
  await write($, 'hits', () => found)
}

async function openNote($: EngineInterface, options: Options, id: string, isFresh = false): Promise<void> {
  const now = await $.clock.now()
  const known = notes.get(id)
  if (known && !isFresh && now - known.at < CACHE_MS) {
    const { note: kept } = known
    await write($, 'note', () => kept)
    return
  }
  const opened = await attempt($, async (): Promise<OpenNote> => {
    const view = await ask($, options, 'get_note', { id })
    return {
      id: String(view.id ?? id),
      title: oneLine(String(view.title ?? '')) || 'Untitled',
      body: String(view.body ?? ''),
      tags: Array.isArray(view.tags) ? view.tags.map(String) : [],
      spaces: Array.isArray(view.spaces) ? view.spaces.map(String) : [],
      updatedAt: String(view.updatedAt ?? ''),
    }
  })
  if (opened === undefined) return
  notes.set(id, { note: opened, at: now })
  await write($, 'note', () => opened)
}

async function createNote($: EngineInterface, options: Options, body: string): Promise<{ id: string; title: string } | undefined> {
  const made = await attempt($, async () => ask($, options, 'create_note', { body }))
  if (made === undefined) return undefined
  recent = null
  const id = String(made.id ?? '')
  const title = oneLine(String(made.title ?? '')) || titleOf(body) || 'Untitled'
  return { id, title }
}

async function compose($: EngineInterface, options: Options, body: string): Promise<void> {
  const text = body.trim()
  if (text === '') return
  const made = await createNote($, options, text)
  if (made === undefined) return
  await write($, 'isComposing', () => false)
  $.ui.toast(`Saved to InstantNotes: ${made.title}`)
  if (made.id) await openNote($, options, made.id, true)
  else await search($, options, '', true)
}

// ---------------------------------------------------------------- the pane

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'InstantNotes', focus: true, closeOnEscape: true, columns: 90 })

export const register: Register = (on, options: Options) => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    home = (await $.env.get('HOME')) ?? ''
    mcpIsDown = false
    notes.clear()
    recent = null
    await write($, 'source', () => null)
    await $.command.register({ name: 'notes', description: 'Your InstantNotes in a pane (/notes [words])', immediate: true })
    await $.command.register({ name: 'note', description: 'Capture a note to InstantNotes (/note <text>)', immediate: true })
    await reseed($)

    return next(e)
  })

  // /clear: the pane stays up, so what it shows is written back as soon as the host's state is
  // the new session's (now, or from the next event if that comes later).
  on('session.end', async ($, e, next) => {
    const result = await next(e)
    if (e.reason === 'clear') await reseed($).catch(() => {})
    return result
  })

  on('command.run', { command: 'notes' }, async ($, e) => {
    const opened = await openPane($)
    await search($, options, e.args)
    const from = (await read($, snapshot)).source
    const how = from?.kind === 'mcp' ? ' (through the instantnotes MCP server)' : ''
    return { text: `InstantNotes pane opened${how}.${opened.isPlaced ? '' : ' Widen the terminal to see it.'}` }
  })

  on('command.run', { command: 'note' }, async ($, e) => {
    const text = e.args.trim()
    if (text === '') {
      return { text: 'Usage: /note <text>. The first line becomes the title.' }
    }
    const made = await createNote($, options, text)
    if (made === undefined) {
      const trouble = (await read($, snapshot)).problem
      return { text: `InstantNotes could not save it: ${trouble?.message ?? 'unknown error'}` }
    }
    $.ui.toast(`Saved to InstantNotes: ${made.title}`)
    return { text: `Saved note "${made.title}".` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Markdown, Text } = elements
    const Field = 'Input' in elements ? elements.Input : undefined
    const width = Math.max(24, e.props.bodyColumns)
    const isNarrow = width < NARROW
    const rule = <Text dimColor>{'─'.repeat(width)}</Text>
    // Drawn from what this process kept after a /clear; the host gets it back off the render.
    if (!(await read($, seeded))) $.clock.after(0, () => void reseed($).catch(() => {}))
    const snap = await read($, snapshot)
    const { note: opened, problem: trouble, isBusy: busy, source: from } = snap
    const now = await $.clock.now()

    const status = busy ? (
      <Text color="yellow">{'◌ Asking InstantNotes…'}</Text>
    ) : trouble !== null ? (
      <Box flexDirection="column">
        <Text color="red" wrap="wrap">{trouble.message}</Text>
        {trouble.steps.map((step, index) => (
          <Text key={`step-${index}`} wrap="wrap">{`${index + 1}. ${step}`}</Text>
        ))}
      </Box>
    ) : null

    if (opened !== null) {
      const { text, cut } = clipBody(opened.body, MARKDOWN_MAX)
      const meta = [
        opened.spaces.length ? opened.spaces.join(', ') : '',
        opened.tags.length ? opened.tags.map(tag => `#${tag}`).join(' ') : '',
        ago(opened.updatedAt, now) ? `updated ${ago(opened.updatedAt, now)}` : '',
      ].filter(Boolean)

      return (
        <Box flexDirection="column">
          <Box gap={1} flexWrap="wrap">
            <Button key="back" plain hotkey="b" label="‹ notes" onPress={() => write($, 'note', () => null)} />
            <Button
              key="ask"
              plain
              hotkey="u"
              label={isNarrow ? 'mention' : 'mention in prompt'}
              onPress={() =>
                $.prompt.fill({
                  text: `InstantNotes note "${opened.title}" (id ${opened.id}, updated ${opened.updatedAt}): `,
                  mode: 'append',
                })
              }
            />
            <Button
              key="paste"
              plain
              hotkey="p"
              label={isNarrow ? 'paste' : 'paste into prompt'}
              onPress={() =>
                $.prompt.fill({
                  text: `Note "${opened.title}" from InstantNotes:\n\n${clipBody(opened.body, PASTE_MAX).text}\n\n`,
                  mode: 'append',
                })
              }
            />
            <Button
              key="copy"
              plain
              hotkey="c"
              label="copy"
              onPress={async press => {
                const copied = await $.ui.copy({ text: opened.body, surface: press.surface })
                $.ui.toast(copied.isCopied ? 'Copied the note.' : 'Could not copy here.')
              }}
            />
            <Button key="reload" plain hotkey="r" label="reload" onPress={() => openNote($, options, opened.id, true)} />
          </Box>
          <Text bold color="cyan" wrap="truncate-end">{opened.title}</Text>
          {meta.length > 0 && <Text dimColor wrap="truncate-end">{meta.join('  ·  ')}</Text>}
          {rule}
          {status}
          <Markdown key="body" text={text || '_Empty note._'} />
          {cut > 0 && <Text dimColor>{`… ${cut.toLocaleString()} more characters in InstantNotes`}</Text>}
        </Box>
      )
    }

    const { hits: list, query: ran, typed: typing, isComposing: composing } = snap
    const shown = typing !== ran ? filterHits(list, typing) : list
    const isFiltering = typing !== ran && typing.trim() !== ''

    let field = null
    if (Field) {
      field = (
        <Field
          key="query"
          label="⌕ "
          placeholder={isNarrow ? 'search notes' : 'words or a title · Enter searches · empty lists recent notes'}
          value={typing}
          autoFocus={composing ? undefined : true}
          submitLabel="search"
          onInput={value => void write($, 'typed', () => value)}
          onSubmit={value => void search($, options, value)}
        />
      )
    } else {
      field = <Text dimColor>{ran ? `Results for "${ran}"` : 'Recent notes'}</Text>
    }

    const heading = isFiltering
      ? `${shown.length} of ${list.length} match "${typing.trim()}"${Field ? ' · Enter searches the library' : ''}`
      : ran
        ? `${list.length}${list.length === LIST_LIMIT ? '+' : ''} result${list.length === 1 ? '' : 's'} for "${ran}"`
        : `Recent notes · ${list.length}`

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Box flexShrink={0}>
            <Text bold color="cyan">✎ InstantNotes</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor wrap="truncate-start">{from === null ? '' : from.kind === 'mcp' ? 'via MCP server' : `via ${from.argv[0]}`}</Text>
          </Box>
          {Field && (
            <Button key="new" plain label={composing ? 'cancel' : isNarrow ? '+ new' : '+ new note'} onPress={() => write($, 'isComposing', was => !was)} />
          )}
          <Button key="recent" plain label="recent" onPress={() => search($, options, '', true)} />
        </Box>
        {field}
        {Field && composing && (
          <Field
            key="compose"
            label="✎ "
            placeholder={isNarrow ? 'New note' : 'New note: the first line becomes the title'}
            value=""
            autoFocus
            submitLabel="save"
            onSubmit={value => void compose($, options, value)}
          />
        )}
        <Text dimColor>{heading}</Text>
        {rule}
        {status}
        {trouble === null && !busy && shown.length === 0 && (
          <Text dimColor>{list.length === 0 ? (ran ? `Nothing in your notes matches "${ran}".` : 'No notes yet. Press + new note to write one.') : 'Nothing loaded matches; press Enter to search the library.'}</Text>
        )}
        {shown.map(hit => {
          const when = ago(hit.updatedAt, now)
          const tail = [hit.spaces[0] ?? '', when].filter(Boolean).join(' · ')
          const room = Math.max(8, width - 2 - (tail ? tail.length + 2 : 0))

          return (
            <Box key={`row-${hit.id}`} flexDirection="column" hover={{ backgroundColor: ROW_BG }}>
              <Box flexDirection="row">
                <Text color="cyan">{'▸ '}</Text>
                <Button key={`hit-${hit.id}`} plain label={clip(hit.title, room)} onPress={() => openNote($, options, hit.id)} />
                {tail !== '' && !isNarrow && <Text dimColor>{`  ${tail}`}</Text>}
              </Box>
              {hit.excerpt !== '' && (
                <Text dimColor wrap="truncate-end">{`  ${clip(hit.excerpt, width - 3)}`}</Text>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
