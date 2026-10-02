// redline: a turbo boost gauge above the prompt, its needle on how many Claude sessions in your
// terminals are working. `/redline` opens a pane with a larger gauge and every session. With the
// fuelGauge option on, three more dials ride along: the plan's five-hour and seven-day windows
// and this session's context, from `$.session.usage()` and the `session.measure` pushes.
//
// The render hooks mount Rasters; one 10 fps timer steps the needles and repaints them with
// `$.ui.blit`, with no render pass. Sessions live in `$.state`, so they survive a hot reload, and
// in this module too, so they survive a /clear (which empties `$.state`: see `snapshot`).

import { atom, derive, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RedlineSession, RedlineUsage } from '../types'
import { BAND_COLS, BIG, TALL, bandCanvas, fracOf, paneCanvas, paneLayout, tankFrac, usageFrom, type PaneLayout, type Tanks } from './fuel'
import { LARGE, Needle, SCALE, SMALL, colorFor, gauge, stageFor, type Face } from './gauge'
import { PS_ARGV, cwdsIn, lsofArgv, sessionOf, sessionsIn } from './sessions'

const PANE = 'redline'
const FPS = 10
const POLL_MS = 2000
const BAND_WORDS = 20 // the columns the band's words need beside the fuel dials
const EMPTY_USAGE: RedlineUsage = { fiveHour: null, sevenDay: null, context: null }

const sessions = atom({ plugin: 'redline', key: 'sessions' } as const, [] as RedlineSession[])
const preview = atom({ plugin: 'redline', key: 'preview' } as const, null as number | null)
const isPaneOpen = atom({ plugin: 'redline', key: 'isPaneOpen' } as const, false)
const seeded = atom({ plugin: 'redline', key: 'seeded' } as const, false)
const usage = atom({ plugin: 'redline', key: 'usage' } as const, EMPTY_USAGE)

// /clear ends the session but not the process: the host's `$.state` starts over empty while this
// module, its pane and its timers live on, so read straight from the host there are suddenly no
// sessions, no preview and no pane. `seeded` is false exactly then, and before the first
// `session.start`. `snapshot` is what the drawings read, in one go: the host's while `seeded`,
// else what this process last saw; `write` puts the kept values back before the first change
// after a /clear, and a render that finds `seeded` false schedules that.
type Snapshot = { sessions: RedlineSession[]; preview: number | null; isPaneOpen: boolean; usage: RedlineUsage }
const KEYS = ['sessions', 'preview', 'isPaneOpen', 'usage'] as const
let kept: Snapshot = { sessions: [], preview: null, isPaneOpen: false, usage: EMPTY_USAGE }
let wasLive: boolean | null = null // what the last read saw; null before the first
const snapshot = derive([seeded, sessions, preview, isPaneOpen, usage], (isLive, sessions, preview, isPaneOpen, usage): Snapshot => {
  wasLive = isLive
  if (!isLive) return kept
  kept = { sessions, preview, isPaneOpen, usage }
  return kept
})

/** The one place the atoms are written: each key to its own, as the validator asks. */
async function put<K extends keyof Snapshot>($: EngineInterface, key: K, value: Snapshot[K]): Promise<void> {
  switch (key) {
    case 'sessions': await update($, sessions, () => value as Snapshot['sessions']); break
    case 'preview': await update($, preview, () => value as Snapshot['preview']); break
    case 'isPaneOpen': await update($, isPaneOpen, () => value as Snapshot['isPaneOpen']); break
    case 'usage': await update($, usage, () => value as Snapshot['usage']); break
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

/** `fuel` is the pane's dial layout, or true for the band's; absent, the tach draws alone. */
type View = { requestId: string; face: Face; fuel?: PaneLayout | true }
type TankKey = keyof Tanks

const TANK_KEYS = ['fiveHour', 'sevenDay', 'context'] as const

const needle = new Needle()
const fuelNeedles: Record<TankKey, Needle> = {
  fiveHour: new Needle(SCALE, 0),
  sevenDay: new Needle(SCALE, 0),
  context: new Needle(SCALE, 0),
}
const fuelReads: Record<TankKey, number | null> = { fiveHour: null, sevenDay: null, context: null }
let views: View[] = []
let tick = 0
let working = 0 // the count the needle heads for: live, or the preview
let reads = 0 // where the needle reads this frame
let latestUsage: RedlineUsage = EMPTY_USAGE // the last figures the engine reported
let hasFuel = false // the fuelGauge option
let self: number | null = null // this session's pid, once looked for
let hasStatusLine = false

const workingIn = (all: readonly RedlineSession[]) => all.filter(s => s.isWorking).length
const tally = (all: readonly RedlineSession[]) => `${workingIn(all)} working · ${all.length} session${all.length === 1 ? '' : 's'}`
const folder = (cwd: string) => cwd.slice(cwd.lastIndexOf('/') + 1) || cwd || '?'
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`

/** Where each tank sits now: the stored fill, emptied once its reset time has passed. */
function tanksNow(now: number): Tanks {
  return {
    fiveHour: tankFrac(latestUsage.fiveHour, now),
    sevenDay: tankFrac(latestUsage.sevenDay, now),
    context: fracOf(latestUsage.context),
  }
}

/** True before any reading has been adopted (a fresh module, a hot reload, the option just on). */
const isUnknown = (u: RedlineUsage) => u.fiveHour === null && u.sevenDay === null && u.context === null

/** What the dials draw: the sprung needle positions, in 0-1, or null while a tank has no reading. */
function drawnTanks(): Tanks {
  const at = (key: TankKey) => (fuelReads[key] === null ? null : fuelReads[key] / SCALE)
  return { fiveHour: at('fiveHour'), sevenDay: at('sevenDay'), context: at('context') }
}

function cells(view: View): string {
  const reading = { needle: reads, isNapping: working <= 0 && reads < 0.3, isVenting: working >= SCALE, t: tick / FPS }
  if (view.fuel === undefined) return gauge(view.face, reading).encode()
  const tanks = drawnTanks()
  return (view.fuel === true ? bandCanvas(reading, tanks) : paneCanvas(reading, tanks, view.fuel)).encode()
}

function mounted(view: View): void {
  views = [...views.filter(v => v.requestId !== view.requestId), view]
}

async function frame($: EngineInterface): Promise<void> {
  tick += 1
  reads = needle.step(working, 1 / FPS)
  if (hasFuel) {
    const tanks = tanksNow(Date.now())
    for (const key of TANK_KEYS) {
      const frac = tanks[key]
      fuelReads[key] = frac === null ? null : fuelNeedles[key].step(frac * SCALE, 1 / FPS)
    }
  }
  await Promise.all(
    views.map(async v => {
      const res = await $.ui.blit({ requestId: v.requestId, key: 'gauge', cells: cells(v) })
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

/** The engine's figures for the fuel dials; null when the engine has none to give. */
async function readUsage($: EngineInterface): Promise<RedlineUsage | null> {
  try {
    const { rateLimits, context } = await $.session.usage()
    return usageFrom(rateLimits, context.percent ?? null)
  } catch {
    return null
  }
}

/** Adopts new figures and writes them where the drawings can see them. */
async function adoptUsage($: EngineInterface, found: RedlineUsage): Promise<void> {
  latestUsage = found
  await write($, 'usage', () => found)
}

async function refreshUsage($: EngineInterface): Promise<void> {
  const found = await readUsage($)
  if (found !== null) await adoptUsage($, found)
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

  const before = await read($, snapshot)
  if (JSON.stringify(before.sessions) === JSON.stringify(found)) return
  await write($, 'sessions', () => found)
  show($, found, before.preview)
}

/** The shell prints its pid, then `exec`s `ps` under that same pid, so the table holds the way up. */
async function findSelf($: EngineInterface): Promise<number> {
  const sh = await $.process.run(['sh', '-c', `echo $$; exec ${PS_ARGV.join(' ')}`], { timeoutMs: 5000 })
  const [pid = '', ...table] = sh.stdout.split('\n')
  return sessionOf(table.join('\n'), Number(pid))
}

export const register: Register = (on, options) => {
  hasStatusLine = options.statusLine === true
  hasFuel = options.fuelGauge === true

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (!hasStatusLine) $.ui.status(undefined)
    await $.command.register({
      name: 'redline',
      description: `Show your Claude sessions; /redline <0-${SCALE}> previews a count, /redline live follows again`,
    })
    await reseed($)
    if (hasFuel) await refreshUsage($).catch(() => {})
    const now = await read($, snapshot)
    show($, now.sessions, now.preview)
    const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
    await write($, 'isPaneOpen', () => isOpen)

    $.clock.every(1000 / FPS, () => void frame($).catch(() => {}))
    if (e.isInteractive) {
      const count = () => void poll($).catch(() => {})
      count()
      $.clock.every(POLL_MS, count)
    }
    return result
  })

  // The engine measures the session after every turn and whenever a rate-limit window moves a
  // whole point; the figures ride the event, so the tanks only ever move on news.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (hasFuel) await adoptUsage($, usageFrom(e.rateLimits, e.context.percent ?? null))
    return result
  })

  // /clear: the pane and the band stay up, so what they show is written back as soon as the
  // host's state is the new session's (now, or from the next event if that comes later).
  on('session.end', async ($, e, next) => {
    const result = await next(e)
    if (e.reason === 'clear') await reseed($).catch(() => {})
    return result
  })

  on('command.run', { command: 'redline' }, async ($, e) => {
    await reseed($)
    const arg = e.args.trim()
    if (arg === 'live') {
      await write($, 'preview', () => null)
      show($, (await read($, snapshot)).sessions, null)
      return { text: 'Following your sessions again.' }
    }
    if (/^\d+$/.test(arg)) {
      const count = Math.min(Number(arg), SCALE)
      await write($, 'preview', () => count)
      show($, (await read($, snapshot)).sessions, count)
      return { text: `Previewing ${count} working: ${stageFor(count).name}. /redline live to follow your sessions again.` }
    }
    if (arg !== '') return { text: `Usage: /redline, /redline <0-${SCALE}>, /redline live` }

    if ((await read($, snapshot)).isPaneOpen) {
      await $.ui.close({ id: PANE })
      return { text: 'Redline closed.' }
    }
    const rows = LARGE.rows + 12 + (hasFuel ? TALL.rows - LARGE.rows : 0)
    const opened = await $.ui.open({ id: PANE, title: 'Redline', rows })
    await write($, 'isPaneOpen', () => true)
    return { text: opened.isPlaced ? 'Redline opened.' : 'Redline opened; widen the terminal to see it.' }
  })

  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) await write($, 'isPaneOpen', () => false)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Drawn from what this process kept after a /clear; the host gets it back off the render.
    if (!(await read($, seeded))) $.clock.after(0, () => void reseed($).catch(() => {}))
    const { sessions: all, preview: previewing, isPaneOpen: isOpen, usage: heldUsage } = await read($, snapshot)
    if (hasFuel && isUnknown(latestUsage)) latestUsage = heldUsage
    if (e.props.hasSurvey || isOpen) {
      views = views.filter(v => v.requestId !== e.requestId)
      return next(e)
    }
    const shown = previewing ?? workingIn(all)
    const stage = stageFor(shown)
    const count = previewing === null ? tally(all) : 'preview · /redline live'

    if (e.surface !== 'terminal') {
      const { Text } = $.ui.resolve(e)
      return <Text color={hex(colorFor(shown))}>{`${stage.name} · ${count}`}</Text>
    }
    const { Box, Text, Raster } = $.ui.resolve(e)
    const withFuel = hasFuel && e.props.bodyColumns >= BAND_COLS + BAND_WORDS
    const view: View = { requestId: e.requestId, face: SMALL, fuel: withFuel ? true : undefined }
    mounted(view)
    return (
      <Box flexDirection="row">
        <Raster key="gauge" columns={withFuel ? BAND_COLS : SMALL.cols} rows={SMALL.rows} cells={cells(view)} />
        <Box flexDirection="column" paddingX={1}>
          <Text bold color={hex(colorFor(shown))}>{stage.name}</Text>
          {e.props.bodyColumns >= (withFuel ? BAND_COLS : SMALL.cols) + 30 && <Text dimColor wrap="truncate">{stage.line}</Text>}
          <Text dimColor wrap="truncate">{count}</Text>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (!(await read($, seeded))) $.clock.after(0, () => void reseed($).catch(() => {}))
    const { sessions: all, preview: previewing, usage: heldUsage } = await read($, snapshot)
    if (hasFuel && isUnknown(latestUsage)) latestUsage = heldUsage
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
    // A narrow pane stacks the dials, as many to a row as fit; a resize renders again and remounts.
    const fuel = hasFuel && e.props.bodyColumns >= BIG.cols ? paneLayout(e.props.bodyColumns) : undefined
    const view: View = { requestId: e.requestId, face: LARGE, fuel }
    mounted(view)
    const rasterCols = fuel?.cols ?? LARGE.cols
    return (
      <Box flexDirection="column" paddingTop={1}>
        <Box flexDirection={e.props.bodyColumns >= rasterCols + 24 ? 'row' : 'column'}>
          <Raster key="gauge" columns={rasterCols} rows={fuel?.rows ?? LARGE.rows} cells={cells(view)} />
          {words}
        </Box>
        <Text> </Text>
        {list}
      </Box>
    )
  })
}
