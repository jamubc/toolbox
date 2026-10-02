// A turbo boost gauge drawn in braille: the needle reads how many Claude sessions are working.
// The dial wears a dim housing, the redline zone is painted on thicker, and the needle tapers
// from a ringed hub. Built from the dial library; the fuel dials in `fuel.ts` use it too.

import type { Canvas } from './canvas'
import { arc, at, dial } from './dial'
import { Dots } from './dots'

export const SCALE = 25 // the needle pins here
const AMBER = 13
const RED = 18

export const DIAL = 0x6c6c6c
export const DIAL_DIM = 0x4a4a4a
export const TICK = 0xd0d0d0
export const AMBER_C = 0xffaf00
export const RED_C = 0xff3b30
export const NEEDLE = 0xff875f
export const HUB = 0xeeeeee
const STEAM = 0xc7c7cc
const SNORE = 0x9aa5b1

export type Stage = { from: number; name: string; line: string }

/** Each stage starts at `from` working sessions. */
export const STAGES: readonly Stage[] = [
  { from: 0, name: 'Napping', line: 'Engine off.' },
  { from: 1, name: 'Idling', line: 'This is peaceful.' },
  { from: 3, name: 'Cruising', line: 'Smooth and steady.' },
  { from: 6, name: 'Busy', line: "Things are heating up." },
  { from: 9, name: 'Very Busy', line: "Needle's climbing." },
  { from: AMBER, name: 'Under Pressure', line: 'Pushing hard.' },
  { from: RED, name: 'Redline', line: 'Needle in the red.' },
  { from: 21, name: 'Overboost', line: "Past the red. Something's going to give." },
  { from: SCALE, name: 'Blown', line: 'Pinned. Blow-off valve wide open.' },
]

export const stageFor = (working: number): Stage => STAGES.findLast(s => working >= s.from) ?? STAGES[0]!

export const colorFor = (working: number): number =>
  working <= 0 ? SNORE : working >= RED ? RED_C : working >= AMBER ? AMBER_C : NEEDLE

const zoneColor = (value: number) => (value >= RED ? RED_C : value >= AMBER ? AMBER_C : TICK)

/**
 * A damped spring: it swings to a new count with a little overshoot, trembles more the higher it
 * reads, and past the top presses against the pin and rattles there. `scale` is where the pin
 * sits and `jitter` how much it trembles; the fuel needles take the same spring without jitter.
 */
export class Needle {
  value = 0
  private velocity = 0

  constructor(
    private readonly scale = SCALE,
    private readonly jitter = 1,
  ) {}

  /** Moves `dt` seconds toward `target`; returns where the needle reads now. */
  step(target: number, dt: number): number {
    const goal = target >= this.scale ? this.scale + 2 : Math.min(target, this.scale)
    this.velocity += (18 * (goal - this.value) - 5 * this.velocity) * dt
    this.value += this.velocity * dt
    if (this.value > this.scale) {
      this.value = this.scale
      this.velocity = -Math.abs(this.velocity) * 0.6
    }
    if (this.value < 0) {
      this.value = 0
      this.velocity = Math.abs(this.velocity) * 0.3
    }
    const tremble = (Math.max(0, Math.min(target, this.scale) - 6) / (this.scale - 6)) * 0.5 * this.jitter
    return Math.max(0, Math.min(this.scale, this.value + (Math.random() * 2 - 1) * tremble))
  }
}

/** A dial in dots: center, radius, and the arc the scale sweeps clockwise from `from`. */
export type Face = {
  cols: number
  rows: number
  cx: number
  cy: number
  r: number
  from: number
  sweep: number
  numbers: boolean
  lane: number // columns on the right for the snore and the steam
}

/** Above the prompt: 240°, so at rest the needle points down-left. */
export const SMALL: Face = { cols: 11 + 5, rows: 4, cx: 11, cy: 9, r: 9, from: (7 / 6) * Math.PI, sweep: (4 / 3) * Math.PI, numbers: false, lane: 5 }
/** In the pane: 270°, numbered. */
export const LARGE: Face = { cols: 24 + 6, rows: 11, cx: 24, cy: 22, r: 21, from: 1.25 * Math.PI, sweep: 1.5 * Math.PI, numbers: true, lane: 6 }

export type Reading = { needle: number; isNapping: boolean; isVenting: boolean; t: number }

/** The tach alone, as dots, for composing with the fuel dials. */
export function tachDots(face: Face, reading: Reading): Dots {
  const dots = new Dots(face.cols, face.rows)
  const zone = (t: number) => zoneColor(t * SCALE)

  if (face.numbers) arc(dots, face, { colorAt: () => DIAL_DIM, radius: face.r + 2, rank: 0 })
  dial(dots, {
    dial: face,
    arc: { colorAt: zone, widthAt: t => (t * SCALE >= RED ? 1 : 0) },
    ticks: face.numbers
      ? { count: SCALE, majorEvery: 5, length: 2, majorLength: 5, rank: 2, colorAt: zone }
      : { count: 5, majorEvery: 1, length: 3, majorLength: 3, colorAt: zone },
    needle: {
      t: reading.needle / SCALE,
      color: reading.needle >= RED ? RED_C : NEEDLE,
      inner: face.numbers ? 5 : 3,
      tail: face.numbers ? 3 : 1.5,
      width: face.numbers ? 1.6 : 1.1,
      hub: face.numbers ? { color: HUB, ringRadius: 3, ringColor: DIAL } : { color: HUB },
    },
  })

  if (face.numbers) {
    for (const v of [0, 5, 10, 15, 20, 25]) {
      const [x, y] = at(face, v / SCALE, face.r - 9)
      const s = String(v)
      dots.text(Math.round(y / 4), Math.round(x / 2 - (s.length - 1) / 2), s, zoneColor(v))
    }
    dots.text(face.rows - 1, Math.round(face.cx / 2 - 7 / 2), 'CLAUDES', DIAL)
  }

  const lane = face.cols - face.lane
  if (reading.isNapping) {
    const k = Math.floor(reading.t * 2) % 8
    const snore = ['z', 'z', 'Z', 'Z']
    for (let i = 0; i < Math.min(k, 4); i++) dots.text(face.rows - 1 - i, lane + 1 + i, snore[i]!, SNORE)
  }
  if (reading.isVenting) {
    for (let i = 0; i < 3; i++) {
      const u = (reading.t * 1.7 + i / 3) % 1
      const row = Math.round((face.rows - 1) * (1 - u))
      const col = lane + 1 + Math.round(u * (face.lane - 2))
      dots.text(row, col, u < 0.4 ? '▓' : u < 0.7 ? '▒' : '░', STEAM)
    }
  }
  return dots
}

export function gauge(face: Face, reading: Reading): Canvas {
  return tachDots(face, reading).toCanvas()
}
