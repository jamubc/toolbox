// redline: a turbo boost gauge above the prompt, its needle on how many Claude sessions in your
// terminals are working. `/redline` opens a pane with a larger gauge and every session.
//
// The render hooks mount Rasters; one 10 fps timer steps the needle and repaints them with
// `$.ui.blit`, with no render pass. Sessions live in `$.state`, so they survive a hot reload.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RedlineSession } from '../types'
import { LARGE, Needle, SCALE, SMALL, colorFor, gauge, stageFor, type Face } from './gauge'
import { PS_ARGV, cwdsIn, lsofArgv, sessionOf, sessionsIn } from './sessions'

const PANE = 'redline'
const FPS = 10
const POLL_MS = 2000

const sessionsRef = { plugin: 'redline', key: 'sessions' } as const
const sessions = atom(sessionsRef, [] as RedlineSession[])
const preview = atom({ plugin: 'redline', key: 'preview' } as const, null as number | null)
const isPaneOpen = atom({ plugin: 'redline', key: 'isPaneOpen' } as const, false)

type View = { requestId: string; face: Face }

const needle = new Needle()
let views: View[] = []
let tick = 0
let working = 0 // the count the needle heads for: live, or the preview
let reads = 0 // where the needle reads this frame
let self: number | null = null // this session's pid, once looked for
let hasStatusLine = false

const workingIn = (all: readonly RedlineSession[]) => all.filter(s => s.isWorking).length
const tally = (all: readonly RedlineSession[]) => `${workingIn(all)} working · ${all.length} session${all.length === 1 ? '' : 's'}`
const folder = (cwd: string) => cwd.slice(cwd.lastIndexOf('/') + 1) || cwd || '?'
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`

function cells(face: Face): string {
  return gauge(face, { needle: reads, isNapping: working <= 0 && reads < 0.3, isVenting: working >= SCALE, t: tick / FPS }).encode()
}

function mounted(view: View): void {
  views = [...views.filter(v => v.requestId !== view.requestId), view]
}

async function frame($: EngineInterface): Promise<void> {
  tick += 1
  reads = needle.step(working, 1 / FPS)
  await Promise.all(
    views.map(async v => {
      const res = await $.ui.blit({ requestId: v.requestId, key: 'gauge', cells: cells(v.face) })
      if (res.deny !== undefined) views = views.filter(w => w !== v)
    }),
  )
}

function show($: EngineInterface, all: readonly RedlineSession[], previewing: number | null): void {
  working = previewing ?? workingIn(all)
  if (!hasStatusLine) return
  const stage = stageFor(working).name
  $.ui.status(previewing === null ? `${stage} · ${workingIn(all)}/${all.length}` : `${stage} · preview`)
}

async function poll($: EngineInterface): Promise<void> {
  const ps = await $.process.run(PS_ARGV, { timeoutMs: 5000 })
  if (ps.exitCode !== 0) return
  let found = sessionsIn(ps.stdout)
  if (found.length) {
    // lsof exits 1 when a pid has gone; the directories it did find still count.
    const cwds = cwdsIn((await $.process.run(lsofArgv(found.map(s => s.pid)), { timeoutMs: 5000 })).stdout)
    found = found.map(s => ({ ...s, cwd: cwds.get(s.pid) ?? '' }))
  }
  if (self === null) self = await findSelf($)

  const before = (await $.state.get(sessionsRef)).value
  if (before && JSON.stringify(before) === JSON.stringify(found)) return
  await update($, sessions, () => found)
  show($, found, await read($, preview))
}

/** The shell prints its pid, then `exec`s `ps` under that same pid, so the table holds the way up. */
async function findSelf($: EngineInterface): Promise<number> {
  const sh = await $.process.run(['sh', '-c', `echo $$; exec ${PS_ARGV.join(' ')}`], { timeoutMs: 5000 })
  const [pid = '', ...table] = sh.stdout.split('\n')
  return sessionOf(table.join('\n'), Number(pid))
}

export const register: Register = (on, options) => {
  hasStatusLine = options.statusLine === true

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (!hasStatusLine) $.ui.status(undefined)
    await $.command.register({
      name: 'redline',
      description: `Show your Claude sessions; /redline <0-${SCALE}> previews a count, /redline live follows again`,
    })
    show($, await read($, sessions), await read($, preview))
    const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
    await update($, isPaneOpen, () => isOpen)

    $.clock.every(1000 / FPS, () => void frame($).catch(() => {}))
    if (e.isInteractive) {
      const count = () => void poll($).catch(() => {})
      count()
      $.clock.every(POLL_MS, count)
    }
    return result
  })

  on('command.run', { command: 'redline' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'live') {
      await update($, preview, () => null)
      show($, await read($, sessions), null)
      return { text: 'Following your sessions again.' }
    }
    if (/^\d+$/.test(arg)) {
      const count = Math.min(Number(arg), SCALE)
      await update($, preview, () => count)
      show($, await read($, sessions), count)
      return { text: `Previewing ${count} working: ${stageFor(count).name}. /redline live to follow your sessions again.` }
    }
    if (arg !== '') return { text: `Usage: /redline, /redline <0-${SCALE}>, /redline live` }

    if (await read($, isPaneOpen)) {
      await $.ui.close({ id: PANE })
      return { text: 'Redline closed.' }
    }
    const opened = await $.ui.open({ id: PANE, title: 'Redline', rows: LARGE.rows + 12 })
    await update($, isPaneOpen, () => true)
    return { text: opened.isPlaced ? 'Redline opened.' : 'Redline opened; widen the terminal to see it.' }
  })

  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) await update($, isPaneOpen, () => false)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isPaneOpen))) {
      views = views.filter(v => v.requestId !== e.requestId)
      return next(e)
    }
    const all = await read($, sessions)
    const previewing = await read($, preview)
    const shown = previewing ?? workingIn(all)
    const stage = stageFor(shown)
    const count = previewing === null ? tally(all) : 'preview · /redline live'

    if (e.surface !== 'terminal') {
      const { Text } = $.ui.resolve(e)
      return <Text color={hex(colorFor(shown))}>{`${stage.name} · ${count}`}</Text>
    }
    const { Box, Text, Raster } = $.ui.resolve(e)
    mounted({ requestId: e.requestId, face: SMALL })
    return (
      <Box flexDirection="row">
        <Raster key="gauge" columns={SMALL.cols} rows={SMALL.rows} cells={cells(SMALL)} />
        <Box flexDirection="column" paddingX={1}>
          <Text bold color={hex(colorFor(shown))}>{stage.name}</Text>
          {e.props.bodyColumns >= SMALL.cols + 30 && <Text dimColor wrap="truncate">{stage.line}</Text>}
          <Text dimColor wrap="truncate">{count}</Text>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const all = await read($, sessions)
    const previewing = await read($, preview)
    const shown = previewing ?? workingIn(all)
    const stage = stageFor(shown)
    const { Box, Text } = $.ui.resolve(e)
    const list = (
      <Box flexDirection="column" paddingX={1}>
        {all.length === 0 && <Text dimColor>No Claude sessions in terminals.</Text>}
        {all.map(s => (
          <Text wrap="truncate" dimColor={!s.isWorking}>
            {`${s.isWorking ? '●' : '○'} ${s.tty.padEnd(8)} ${folder(s.cwd)}${s.pid === self ? '  (this one)' : ''}`}
          </Text>
        ))}
      </Box>
    )
    const words = (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color={hex(colorFor(shown))}>{previewing === null ? stage.name : `${stage.name} (preview)`}</Text>
        <Text dimColor wrap="wrap">{stage.line}</Text>
        <Text dimColor>{tally(all)}</Text>
      </Box>
    )
    if (e.surface !== 'terminal') {
      return <Box flexDirection="column">{words}{list}</Box>
    }
    const { Raster } = $.ui.resolve(e)
    mounted({ requestId: e.requestId, face: LARGE })
    return (
      <Box flexDirection="column">
        <Box flexDirection={e.props.bodyColumns >= LARGE.cols + 24 ? 'row' : 'column'}>
          <Raster key="gauge" columns={LARGE.cols} rows={LARGE.rows} cells={cells(LARGE)} />
          {words}
        </Box>
        <Text> </Text>
        {list}
      </Box>
    )
  })
}
