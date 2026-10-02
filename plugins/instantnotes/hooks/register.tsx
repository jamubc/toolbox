import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Hit, OpenNote } from '../types'

const PANE = 'instantnotes'
const LIST_LIMIT = 15
const MARKDOWN_MAX = 10000

const query = atom({ plugin: 'instantnotes', key: 'query' } as const, '')
const hits = atom({ plugin: 'instantnotes', key: 'hits' } as const, [])
const note = atom({ plugin: 'instantnotes', key: 'note' } as const, null)
const error = atom({ plugin: 'instantnotes', key: 'error' } as const, null)

type Options = { binary?: string; db?: string }

/** Where the app keeps its library when the person has not said. */
async function defaultDb($: EngineInterface): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  const linux = `${home}/.local/share/com.instantnotes.app/instantnotes.db`
  const mac = `${home}/Library/Application Support/com.instantnotes.app/instantnotes.db`
  try {
    await $.fs.stat(linux)
    return linux
  } catch {
    return mac
  }
}

/**
 * One tools/call against `instantnotes mcp`, in the stateless 2026-07-28
 * era: a single request line in, a single response out, no handshake.
 */
async function callTool(
  $: EngineInterface,
  options: Options,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  const db = options.db || (await defaultDb($))
  const attachments = db.replace(/[^/]*$/, 'attachments')
  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name,
      arguments: args,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'Claude Code', version: '0' },
      },
    },
  }
  const ran = await $.process.run(
    [options.binary || 'instantnotes', 'mcp', '--db', db, '--attachments', attachments],
    { stdin: `${JSON.stringify(request)}\n`, timeoutMs: 10000 },
  )
  const line = ran.stdout.trim()
  if (line === '') {
    throw new Error(ran.stderr.trim() || `instantnotes exited ${ran.exitCode}`)
  }
  const reply = JSON.parse(line)
  if (reply.error) {
    throw new Error(reply.error.message)
  }
  if (reply.result.isError) {
    throw new Error(reply.result.content?.[0]?.text ?? 'InstantNotes refused')
  }
  return reply.result.structuredContent
}

async function search($: EngineInterface, options: Options, text: string) {
  await update($, query, () => text)
  await update($, note, () => null)
  try {
    const found: Hit[] = text.trim()
      ? (await callTool($, options, 'search_notes', { query: text, limit: LIST_LIMIT })).results
      : (await callTool($, options, 'list_notes', { limit: LIST_LIMIT })).notes.map(
          (n: any) => ({ id: n.id, title: n.title, excerpt: n.snippet, spaces: [] }),
        )
    await update($, hits, () => found)
    await update($, error, () => null)
  } catch (err) {
    await update($, error, () => String((err as Error).message))
  }
}

async function openNote($: EngineInterface, options: Options, id: string) {
  try {
    const view = await callTool($, options, 'get_note', { id })
    const opened: OpenNote = {
      id: view.id,
      title: view.title,
      body: view.body,
      tags: view.tags,
      spaces: view.spaces,
      updatedAt: view.updatedAt,
    }
    await update($, note, () => opened)
    await update($, error, () => null)
  } catch (err) {
    await update($, error, () => String((err as Error).message))
  }
}

function clip(text: string): string {
  return text.length > MARKDOWN_MAX ? `${text.slice(0, MARKDOWN_MAX - 1)}…` : text
}

export const register: Register = (on, options: Options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'notes',
      description: 'Search InstantNotes in a pane (/notes [words])',
    })
    await $.command.register({
      name: 'note',
      description: 'Capture a note to InstantNotes (/note <text>)',
    })

    return next(e)
  })

  on('command.run', { command: 'notes' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'InstantNotes', focus: true, closeOnEscape: true })
    await search($, options, e.args)

    return { text: 'InstantNotes pane opened.' }
  })

  on('command.run', { command: 'note' }, async ($, e) => {
    const text = e.args.trim()
    if (text === '') {
      return { text: 'Usage: /note <text>. The first line becomes the title.' }
    }
    try {
      const made = await callTool($, options, 'create_note', { body: text })
      $.ui.toast(`Saved to InstantNotes: ${made.title}`)

      return { text: `Saved note "${made.title}".` }
    } catch (err) {
      return { text: `InstantNotes could not save it: ${(err as Error).message}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const failed = await read($, error)
    const opened = await read($, note)

    if (opened !== null) {
      const meta = [
        opened.spaces.length ? `Spaces: ${opened.spaces.join(', ')}` : '',
        opened.tags.length ? `Tags: ${opened.tags.map(t => `#${t}`).join(' ')}` : '',
      ].filter(Boolean)

      return (
        <Box flexDirection="column">
          <Box>
            <Button key="back" label="Back" hotkey="b" onPress={() => update($, note, () => null)} />
            <Text> </Text>
            <Button
              key="ask"
              label="Use in prompt"
              hotkey="u"
              onPress={() =>
                $.prompt.fill({
                  text: `InstantNotes note "${opened.title}" (id ${opened.id}, updatedAt ${opened.updatedAt}): `,
                  mode: 'append',
                })
              }
            />
          </Box>
          <Text bold>{opened.title}</Text>
          {meta.length > 0 && <Text dimColor>{meta.join('  ·  ')}</Text>}
          <Markdown text={clip(opened.body || '_Empty note._')} />
        </Box>
      )
    }

    const list = await read($, hits)
    const text = await read($, query)

    // Mobile draws no Input; there the search comes from /notes <words>.
    let field
    if (e.surface === 'mobile') {
      field = <Text dimColor>{text ? `Results for "${text}"` : 'Recent notes'}</Text>
    } else {
      const { Input } = $.ui.resolve(e)
      field = (
        <Input
          key="query"
          label="Search: "
          placeholder="words or a title, Enter for recent notes"
          value={text}
          autoFocus
          submitLabel="search"
          onSubmit={value => search($, options, value)}
        />
      )
    }

    return (
      <Box flexDirection="column">
        {field}
        {failed !== null && <Text color="red">{failed}</Text>}
        {failed === null && list.length === 0 && <Text dimColor>No notes found.</Text>}
        {list.map(hit => (
          <Box key={`row-${hit.id}`} flexDirection="column">
            <Button key={`hit-${hit.id}`} plain label={hit.title} onPress={() => openNote($, options, hit.id)} />
            {hit.excerpt !== '' && (
              <Text dimColor wrap="truncate-end">
                {'  '}
                {hit.excerpt}
              </Text>
            )}
          </Box>
        ))}
      </Box>
    )
  })
}
