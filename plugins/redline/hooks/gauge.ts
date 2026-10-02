// A turbo boost gauge drawn in braille: each cell is a 2 × 4 grid of roughly square dots, so the
// arcs stay round and the needle thin. The needle reads how many Claude sessions are working.

import { Canvas } from './canvas'

export const SCALE = 25 // the needle pins here
const AMBER = 13
const RED = 18

const DIAL = 0x6c6c6c
const TICK = 0xd0d0d0
const AMBER_C = 0xffaf00
const RED_C = 0xff3b30
const NEEDLE = 0xff875f
const HUB = 0xeeeeee
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
 * reads, and past the top presses against the pin and rattles there.
 */
export class Needle {
  value = 0
  private velocity = 0

  /** Moves `dt` seconds toward `target`; returns where the needle reads now. */
  step(target: number, dt: number): number {
    const goal = target >= SCALE ? SCALE + 2 : Math.min(target, SCALE)
    this.velocity += (18 * (goal - this.value) - 5 * this.velocity) * dt
    this.value += this.velocity * dt
    if (this.value > SCALE) {
      this.value = SCALE
      this.velocity = -Math.abs(this.velocity) * 0.6
    }
    if (this.value < 0) {
      this.value = 0
      this.velocity = Math.abs(this.velocity) * 0.3
    }
    const tremble = (Math.max(0, Math.min(target, SCALE) - 6) / (SCALE - 6)) * 0.5
    return Math.max(0, Math.min(SCALE, this.value + (Math.random() * 2 - 1) * tremble))
  }
}

const BIT = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]] as const // braille dot bits by [row][column]

/** Braille dots; a cell takes the color of the highest-ranked dot drawn in it. */
class Dots {
  readonly bits: Uint8Array
  readonly color: Int32Array
  readonly rank: Int8Array

  constructor(readonly cols: number, readonly rows: number) {
    this.bits = new Uint8Array(cols * rows)
    this.color = new Int32Array(cols * rows)
    this.rank = new Int8Array(cols * rows).fill(-1)
  }

  dot(x: number, y: number, color: number, rank: number): void {
    const [px, py] = [Math.round(x), Math.round(y)]
    const [c, r] = [Math.floor(px / 2), Math.floor(py / 4)]
    if (px < 0 || py < 0 || c >= this.cols || r >= this.rows) return
    const i = r * this.cols + c
    this.bits[i]! |= BIT[py % 4]![px % 2]!
    if (rank >= this.rank[i]!) {
      this.rank[i] = rank
      this.color[i] = color
    }
  }

  line(x0: number, y0: number, x1: number, y1: number, color: number, rank: number): void {
    const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 1.5) || 1
    for (let i = 0; i <= n; i++) this.dot(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, color, rank)
  }

  toCanvas(): Canvas {
    const cv = new Canvas(this.rows, this.cols)
    for (let i = 0; i < this.bits.length; i++) {
      if (this.bits[i]) cv.put(Math.floor(i / this.cols), i % this.cols, String.fromCharCode(0x2800 + this.bits[i]!), this.color[i]!)
    }
    return cv
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

const angleOf = (face: Face, value: number) => face.from - (Math.max(0, Math.min(SCALE, value)) / SCALE) * face.sweep
const at = (face: Face, angle: number, r: number): [number, number] => [face.cx + r * Math.cos(angle), face.cy - r * Math.sin(angle)]

export type Reading = { needle: number; isNapping: boolean; isVenting: boolean; t: number }

export function gauge(face: Face, reading: Reading): Canvas {
  const dots = new Dots(face.cols, face.rows)
  const { r } = face

  for (let i = 0, n = Math.ceil(face.sweep * r * 1.6); i <= n; i++) {
    const v = (i / n) * SCALE
    const [x, y] = at(face, angleOf(face, v), r)
    dots.dot(x, y, v >= RED ? RED_C : v >= AMBER ? AMBER_C : DIAL, 1)
  }
  for (let v = 0; v <= SCALE; v++) {
    const isMajor = v % 5 === 0
    if (!isMajor && !face.numbers) continue
    const a = angleOf(face, v)
    const [x0, y0] = at(face, a, r - 1)
    const [x1, y1] = at(face, a, r - (isMajor ? (face.numbers ? 4 : 3) : 2))
    dots.line(x0, y0, x1, y1, zoneColor(v), 2)
  }

  const a = angleOf(face, reading.needle)
  const tip = at(face, a, r - (face.numbers ? 5 : 3))
  const tail = at(face, a + Math.PI, face.numbers ? 3 : 1.5)
  dots.line(tail[0], tail[1], tip[0], tip[1], reading.needle >= RED ? RED_C : NEEDLE, 3)
  for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) dots.dot(face.cx + dx, face.cy + dy, HUB, 4)

  const cv = dots.toCanvas()

  if (face.numbers) {
    for (const v of [0, 5, 10, 15, 20, 25]) {
      const [x, y] = at(face, angleOf(face, v), r - 9)
      const s = String(v)
      cv.put(Math.round(y / 4), Math.round(x / 2 - (s.length - 1) / 2), s, zoneColor(v))
    }
    const label = 'CLAUDES'
    cv.put(face.rows - 1, Math.round(face.cx / 2 - label.length / 2), label, DIAL)
  }

  const lane = face.cols - face.lane
  if (reading.isNapping) {
    const k = Math.floor(reading.t * 2) % 8
    const snore = ['z', 'z', 'Z', 'Z']
    for (let i = 0; i < Math.min(k, 4); i++) cv.put(face.rows - 1 - i, lane + 1 + i, snore[i]!, SNORE)
  }
  if (reading.isVenting) {
    for (let i = 0; i < 3; i++) {
      const u = (reading.t * 1.7 + i / 3) % 1
      const row = Math.round((face.rows - 1) * (1 - u))
      const col = lane + 1 + Math.round(u * (face.lane - 2))
      cv.put(row, col, u < 0.4 ? '▓' : u < 0.7 ? '▒' : '░', STEAM)
    }
  }
  return cv
}
