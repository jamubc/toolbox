// redline: a rev limiter for Claude Code. It watches your plan's five-hour and seven-day windows
// and, once one is past the redline you set, shifts this session down (Sonnet, low effort, or
// both) on every model request until the window resets. One quiet line above the prompt says
// where the windows stand and which of your other sessions need you; /redline opens the dash.
//
// State lives in this module: it survives /clear (which empties `$.state`) and is rebuilt on a
// hot reload by `session.start`. Each session running redline writes a heartbeat to the shared
// `$.store`, so every session can list the others with their exact state.

import type { EngineInterface, Register } from 'claude-code'

import type { RedlineBeat, RedlineUsage } from '../types'
import { type Segment, bandSegments, bandLine, matters } from './band'
import { type Agent, type Row, agentsIn, fleet } from './fleet'
import { BIG, Needle, SCALE, type Tanks, dashCanvas, dashLayout, tanksNow, usageFrom } from './fuel'
import { DEFAULT_MODEL, type Gear, LENGTH, type LimiterConfig, type Manual, clock, gearFor, paceOf, shiftFor, shiftWords, span, spawnModel, stepChange, windowNow } from './limiter'

const PANE = 'redline'
const FPS = 10
const POLL_MS = 5000
const BEAT_MS = 30_000
const EMPTY_USAGE: RedlineUsage = { fiveHour: null, sevenDay: null, context: null }

type BandMode = 'always' | 'matters' | 'never'
const BAND_OPTIONS: Record<string, BandMode> = { 'one line, always': 'always', 'only when it matters': 'matters', never: 'never' }

type View = { requestId: string; columns: number }

// What this process knows. A hot reload starts it over; session.start refills it.
let config: LimiterConfig = { redlineAt: 80, weeklyRedlineAt: 90, shift: 'sonnet', model: DEFAULT_MODEL }
let bandMode: BandMode = 'always'
let usage: RedlineUsage = EMPTY_USAGE
let manual: Manual = { mode: 'auto' }
let wasShifted: boolean | null = null // the gear the last check saw; null before the first
let agents: Agent[] = []
let beats: RedlineBeat[] = []
let rows: Row[] = []
let lastFleet = ''
let myId = ''
let myModel = ''
let myState: RedlineBeat['state'] = 'idle'
let myWaitingFor = ''
let mySince = 0
let myTurns = 0
let myUsd: number | null = null
let isPaneOpen = false
let isInteractive = false
let views: View[] = []
const needles: Record<keyof Tanks, Needle> = { fiveHour: new Needle(), sevenDay: new Needle(), context: new Needle() }
const reads: Record<keyof Tanks, number | null> = { fiveHour: null, sevenDay: null, context: null }

const RED = '#ff3b30'
const AMBER = '#ffaf00'
const toneColor = (tone: Segment['tone']) => (tone === 'red' ? RED : tone === 'amber' ? AMBER : undefined)

/** The engine's clock, read as `now()` plus the offset the last `sync` measured. */
let skew = 0
const now = () => Date.now() + skew
async function sync($: EngineInterface): Promise<void> {
  try {
    skew = (await $.clock.now()) - Date.now()
  } catch {
    // the wall clock then
  }
}

const gearNow = (at = now()): Gear => gearFor(usage, config, manual, at)

/** What the dials draw: the sprung needle positions, in 0-1, or null while a tank has no reading. */
function drawnTanks(): Tanks {
  const at = (key: keyof Tanks) => (reads[key] === null ? null : reads[key] / SCALE)
  return { fiveHour: at('fiveHour'), sevenDay: at('sevenDay'), context: at('context') }
}

function mounted(view: View): void {
  views = [...views.filter(v => v.requestId !== view.requestId), view]
}

/** One frame of the dials: step every needle and repaint the mounted rasters. */
async function frame($: EngineInterface): Promise<void> {
  if (views.length === 0) return
  const tanks = tanksNow(usage, now())
  for (const key of ['fiveHour', 'sevenDay', 'context'] as const) {
    const frac = tanks[key]
    reads[key] = frac === null ? null : needles[key].step(frac * SCALE, 1 / FPS)
  }
  await Promise.all(
    views.map(async v => {
      const res = await $.ui.blit({ requestId: v.requestId, key: 'dash', cells: dashCanvas(drawnTanks(), dashLayout(v.columns)).encode() })
      if (res.deny !== undefined) views = views.filter(w => w !== v)
    }),
  )
}

/** This session's heartbeat, as the other sessions read it. */
function myBeat(cwd: string, now: number): RedlineBeat {
  return {
    id: myId,
    cwd,
    state: myState,
    waitingFor: myWaitingFor,
    since: mySince,
    at: now,
    turns: myTurns,
    context: usage.context,
    usd: myUsd,
    model: myModel,
    isShifted: gearNow(now).isShifted,
  }
}

async function beat($: EngineInterface): Promise<void> {
  await sync($)
  try {
    const id = await $.session.id()
    if (id !== myId) {
      if (myId) await $.store.delete(`session:${myId}`)
      myId = id
    }
    await $.store.set(`session:${myId}`, myBeat(await $.session.cwd(), now()))
  } catch {
    // the store is best effort: the dash still draws
  }
}

function setState($: EngineInterface, state: RedlineBeat['state'], waitingFor = ''): void {
  if (state === myState && waitingFor === myWaitingFor) return
  myState = state
  myWaitingFor = waitingFor
  mySince = now()
  void beat($).then(() => refleet($))
}

/** Reads the other sessions' heartbeats; a stale one is removed from the store. */
async function readBeats($: EngineInterface): Promise<RedlineBeat[]> {
  const found: RedlineBeat[] = []
  const at = now()
  for (const key of await $.store.keys()) {
    if (!key.startsWith('session:')) continue
    const value = (await $.store.get(key)) as RedlineBeat | undefined
    if (!value || typeof value !== 'object' || typeof value.id !== 'string') continue
    if (at - value.at > 24 * 3600_000) {
      await $.store.delete(key)
      continue
    }
    found.push(value)
  }
  return found
}

/** Folds the two sources into the rows, and redraws when they changed. */
function refleet($: EngineInterface): void {
  rows = fleet(agents, beats, myId, now())
  const key = JSON.stringify(rows.map(r => [r.id, r.state, r.waitingFor, r.folder, Math.floor((r.forMs ?? 0) / 60_000)]))
  if (key === lastFleet) return
  lastFleet = key
  $.ui.invalidate('ui.render')
}

async function poll($: EngineInterface): Promise<void> {
  await sync($)
  try {
    const res = await $.process.run(['claude', 'agents', '--json'], { timeoutMs: 5000 })
    if (res.exitCode === 0) agents = agentsIn(res.stdout)
  } catch {
    // keep the last listing
  }
  beats = await readBeats($).catch(() => beats)
  refleet($)
  checkGear($)
}

/** Notices the gear changing on its own (a window crossing the redline, or resetting) and says so. */
function checkGear($: EngineInterface): void {
  const at = now()
  const gear = gearNow(at)
  if (wasShifted === gear.isShifted) return
  const wasKnown = wasShifted !== null
  wasShifted = gear.isShifted
  if (!wasKnown) return
  if (gear.isShifted) {
    const until = gear.until === null ? '' : ` until ${clock(gear.until, at)}`
    $.ui.toast(config.shift === 'warn' ? `${gear.reason}: past the redline` : `shifted down to ${shiftWords(config)}${until}: ${gear.reason}`)
  } else {
    $.ui.toast('back in gear')
  }
  $.ui.invalidate('ui.render')
  void beat($)
}

/** The engine's figures; null when the engine has none to give. */
async function readUsage($: EngineInterface): Promise<RedlineUsage | null> {
  try {
    const { rateLimits, context, cost } = await $.session.usage()
    if (cost) myUsd = cost.usd
    return usageFrom(rateLimits, context.percent ?? null)
  } catch {
    return null
  }
}

/** The pane's rows: the dash, the readouts, the limiter and the sessions. */
function paneRows(): number {
  return dashLayout(Infinity).rows + 9 + Math.max(1, rows.length)
}

export const register: Register = (on, options) => {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(1, Math.min(100, v)) : d)
  const model = typeof options.model === 'string' && options.model.trim() ? options.model.trim() : DEFAULT_MODEL
  config = { redlineAt: num(options.redlineAt, 80), weeklyRedlineAt: num(options.weeklyRedlineAt, 90), shift: shiftFor(options.shift), model }
  bandMode = BAND_OPTIONS[String(options.band)] ?? 'always'

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await sync($)
    mySince = now()
    isInteractive = e.isInteractive
    try {
      await $.command.register({ name: 'redline', description: 'The dash: your plan windows, the limiter, and every session', argumentHint: '[shift|lift|auto]', immediate: true })
    } catch {
      // a reload registers it again
    }
    myModel = await $.session.model().catch(() => '')
    const found = await readUsage($)
    if (found) usage = found
    isPaneOpen = await $.ui.panes().then(panes => panes.some(p => p.id === PANE), () => false)
    wasShifted = gearNow().isShifted
    await beat($)
    $.clock.every(1000 / FPS, () => void frame($).catch(() => {}))
    $.clock.every(BEAT_MS, () => void beat($))
    if (isInteractive) {
      void poll($)
      $.clock.every(POLL_MS, () => void poll($))
    }
    return result
  })

  // The engine measures after every turn and whenever a window moves a whole point.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await sync($)
    usage = usageFrom(e.rateLimits, e.context.percent ?? null)
    if (e.cost) myUsd = e.cost.usd
    checkGear($)
    $.ui.invalidate('ui.render')
    return result
  })

  on('session.end', async ($, e, next) => {
    const result = await next(e)
    if (e.reason !== 'clear' && myId) await $.store.delete(`session:${myId}`).catch(() => {})
    return result
  })

  on('turn.start', async ($, e, next) => {
    setState($, 'working')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      myTurns += 1
      setState($, 'idle')
    }
    return result
  })

  // The limiter: while shifted, every request goes out on the cheaper setting.
  on('turn.step', async function* ($, e, next) {
    const change = gearNow().isShifted ? stepChange(e, config) : null
    return yield* next(change ? { ...e, ...change } : e)
  })

  on('agent.spawn', async ($, e, next) => {
    const model = gearNow().isShifted ? spawnModel(e, config) : null
    return next(model ? { ...e, model } : e)
  })

  // A permission prompt is the main way a session waits on you: tool.check answers `ask` for
  // it, inside the tool.call that then waits for your answer.
  on('tool.check', async ($, e, next) => {
    const decided = await next(e)
    if (decided.decision === 'ask' && e.tool_use_id !== undefined) setState($, 'waiting', `approve ${e.tool}`)
    return decided
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'AskUserQuestion') setState($, 'waiting', 'a question')
    const result = await next(e)
    if (myState === 'waiting') setState($, 'working')
    return result
  })

  on('command.run', { command: 'redline' }, async ($, e) => {
    await sync($)
    const arg = e.args.trim().toLowerCase()
    const at = now()
    const five = windowNow(usage.fiveHour, at)
    const until = five?.resetsAt ?? at + LENGTH.fiveHour
    if (arg === 'shift') {
      manual = { mode: 'shift', until }
      checkGear($)
      return { text: `Shifted down to ${shiftWords(config)} until ${clock(until, at)}. /redline auto hands it back to the limiter.` }
    }
    if (arg === 'lift') {
      const gear = gearNow(at)
      const liftUntil = gear.until ?? until
      manual = { mode: 'lift', until: liftUntil }
      checkGear($)
      return { text: `Limiter lifted until ${clock(liftUntil, at)}. /redline auto hands it back.` }
    }
    if (arg === 'auto') {
      manual = { mode: 'auto' }
      checkGear($)
      const gear = gearNow(at)
      return { text: gear.isShifted ? `Automatic again: shifted, ${gear.reason}.` : 'Automatic again: in gear.' }
    }
    if (arg !== '') return { text: 'Usage: /redline, /redline shift, /redline lift, /redline auto' }

    if (isPaneOpen) {
      await $.ui.close({ id: PANE })
      isPaneOpen = false
      return {}
    }
    const opened = await $.ui.open({ id: PANE, title: 'Redline', rows: paneRows() })
    isPaneOpen = true
    if (isInteractive) void poll($)
    return opened.isPlaced ? {} : { text: 'Redline opened; widen the terminal to see it.' }
  })

  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) {
      isPaneOpen = false
      views = []
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || bandMode === 'never' || isPaneOpen) return next(e)
    await sync($)
    const segments = bandSegments({ usage, gear: gearNow(), shift: config, redlineAt: config.redlineAt, weeklyRedlineAt: config.weeklyRedlineAt, rows, now: now() })
    if (segments.length === 0 || (bandMode === 'matters' && !matters(segments))) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const theirs = await next(e)
    const line = (
      <Text wrap="truncate">
        {segments.map((s, i) => (
          <Text key={`seg-${i}`} color={toneColor(s.tone)} dimColor={s.tone === 'dim'} bold={s.tone === 'red'}>
            {i === 0 ? s.text : `  ·  ${s.text}`}
          </Text>
        ))}
      </Text>
    )
    if (e.props.bodyColumns < bandLine(segments, Infinity).length) {
      return <Box flexDirection="column"><Text dimColor wrap="truncate">{bandLine(segments, e.props.bodyColumns)}</Text>{theirs}</Box>
    }
    return <Box flexDirection="column">{line}{theirs}</Box>
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await sync($)
    const at = now()
    const gear = gearNow(at)
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const width = e.props.bodyColumns

    const five = windowNow(usage.fiveHour, at)
    const week = windowNow(usage.sevenDay, at)
    const fivePace = paceOf(five, LENGTH.fiveHour, at)
    const weekPace = paceOf(week, LENGTH.sevenDay, at)
    const percentColor = (percent: number, redlineAt: number) => (percent >= redlineAt ? RED : percent >= redlineAt - 20 ? AMBER : undefined)
    const readout = (label: string, tank: { percent: number; resetsAt: number | null } | null, redlineAt: number, pace: ReturnType<typeof paceOf>) => {
      if (!tank) return <Text dimColor>{`${label.padEnd(4)} no reading yet`}</Text>
      const resets = tank.resetsAt === null ? '' : `resets ${clock(tank.resetsAt, at)} · ${span(tank.resetsAt - at)} left`
      const runsOut = pace?.runsOutAt ? ` · runs out ${clock(pace.runsOutAt, at)} at this pace` : ''
      return (
        <Text wrap="truncate">
          <Text dimColor>{label.padEnd(4)}</Text>
          <Text color={percentColor(tank.percent, redlineAt)} bold={tank.percent >= redlineAt}>{`${String(Math.round(tank.percent)).padStart(3)}%`}</Text>
          <Text dimColor>{`  ${resets}`}</Text>
          {runsOut ? <Text color={AMBER}>{runsOut}</Text> : null}
        </Text>
      )
    }
    const readouts = (
      <Box flexDirection="column" paddingX={1}>
        {readout('5h', five, config.redlineAt, fivePace)}
        {readout('7d', week, config.weeklyRedlineAt, weekPace)}
        {usage.context === null ? (
          <Text dimColor>{'ctx  no reading yet'}</Text>
        ) : (
          <Text wrap="truncate">
            <Text dimColor>{'ctx '}</Text>
            <Text color={percentColor(usage.context, 85)}>{`${String(Math.round(usage.context)).padStart(3)}%`}</Text>
            <Text dimColor>{myUsd === null ? '' : `  $${myUsd.toFixed(2)} this session`}</Text>
          </Text>
        )}
      </Box>
    )

    const limiterWords = gear.isShifted
      ? `⇣ ${config.shift === 'warn' ? 'past the redline' : `shifted down to ${shiftWords(config)}`} · ${gear.reason}${gear.until === null ? '' : ` · lifts ${clock(gear.until, at)}`}`
      : `in gear · shifts at ${config.redlineAt}% of 5h, ${config.weeklyRedlineAt}% of 7d${manual.mode === 'lift' ? ' · lifted by hand' : ''}`
    const limiter = (
      <Box flexDirection="column" paddingX={1}>
        <Text wrap="truncate">
          <Text bold color={gear.isShifted ? RED : undefined}>{'Limiter  '}</Text>
          <Text color={gear.isShifted ? RED : undefined} dimColor={!gear.isShifted}>{limiterWords}</Text>
        </Text>
        <Box gap={2}>
          {!gear.isShifted && <Button key="shift" plain hotkey="s" label="shift at" onPress={() => void $.command.run({ command: 'redline', args: 'shift' })} />}
          {gear.isShifted && <Button key="lift" plain hotkey="l" label="lift" onPress={() => void $.command.run({ command: 'redline', args: 'lift' })} />}
          {manual.mode !== 'auto' && <Button key="auto" plain hotkey="a" label="auto" onPress={() => void $.command.run({ command: 'redline', args: 'auto' })} />}
        </Box>
      </Box>
    )

    const mark = (r: Row) => (r.state === 'waiting' ? '!' : r.state === 'working' ? '●' : r.state === 'done' ? '✓' : '○')
    const words = (r: Row) => {
      const ago = r.forMs === null ? '' : ` · ${span(r.forMs)}`
      const detail =
        r.state === 'waiting' ? `needs you · ${r.waitingFor}${ago}`
        : r.state === 'working' ? `working${ago}`
        : r.state === 'done' ? `done${ago} ago`
        : `idle${ago}`
      const extra = r.beat ? [r.beat.context === null ? '' : `ctx ${Math.round(r.beat.context)}%`, r.beat.usd === null ? '' : `$${r.beat.usd.toFixed(2)}`, r.beat.isShifted ? '⇣' : ''].filter(Boolean).join(' · ') : ''
      return `${detail}${extra ? ` · ${extra}` : ''}${r.isThis ? ' · this one' : ''}`
    }
    const nameWidth = Math.min(24, Math.max(8, ...rows.map(r => r.folder.length)))
    const sessions = (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>{rows.length === 0 ? 'Sessions' : `Sessions  ${rows.length}`}</Text>
        {rows.length === 0 && <Text dimColor>none found yet</Text>}
        {rows.map(r => (
          <Text key={`row-${r.id}`} wrap="truncate" color={r.state === 'waiting' ? RED : undefined} dimColor={r.state === 'idle'} bold={r.state === 'waiting'}>
            {`${mark(r)} ${r.folder.slice(0, nameWidth).padEnd(nameWidth)}  ${words(r)}`}
          </Text>
        ))}
      </Box>
    )

    const gap = <Text> </Text>
    if (!('Raster' in elements) || width < BIG.cols) {
      return <Box flexDirection="column" paddingTop={1}>{readouts}{gap}{limiter}{gap}{sessions}</Box>
    }
    const layout = dashLayout(width)
    mounted({ requestId: e.requestId, columns: width })
    return (
      <Box flexDirection="column" paddingTop={1}>
        <Box paddingX={Math.max(0, Math.floor((width - layout.cols) / 2))}>
          <elements.Raster key="dash" columns={layout.cols} rows={layout.rows} cells={dashCanvas(drawnTanks(), layout).encode()} />
        </Box>
        {readouts}
        {gap}
        {limiter}
        {gap}
        {sessions}
      </Box>
    )
  })
}

