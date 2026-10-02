// The dial standard library: the parts every gauge in redline is built from. A dial is a pivot,
// a radius, and the arc its scale sweeps clockwise from `from`; callers work in `t`, 0 at the
// start of the sweep and 1 at its end, and supply the colors. The braille grid is in `dots.ts`.

import { Dots } from './dots'

/** A dial's scale: where the pivot sits and the arc it sweeps. */
export type Dial = { cx: number; cy: number; r: number; from: number; sweep: number }

/** A shallow dial whose pivot sits at the bottom edge of a `cols` × `rows` panel. */
export function shallow(cols: number, rows: number, from: number, sweep: number): Dial {
  const cx = cols
  const cy = rows * 4 - 2
  const reach = Math.max(Math.abs(Math.cos(from)), Math.abs(Math.cos(from - sweep)))
  const r = Math.floor(Math.min((cols - 2) / reach, cy - 5))
  return { cx, cy, r, from, sweep }
}

export const angleAt = (d: Dial, t: number) => d.from - t * d.sweep

/** The point `r` from the pivot at angle `a`. */
export const polar = (d: Dial, a: number, r: number): [number, number] => [d.cx + r * Math.cos(a), d.cy - r * Math.sin(a)]

/** The point at `t` on a circle of radius `r`. */
export const at = (d: Dial, t: number, r = d.r): [number, number] => polar(d, angleAt(d, t), r)

export type ArcSpec = {
  colorAt: (t: number) => number
  /** Extra dots drawn outward at `t`, for a painted zone. */
  widthAt?: (t: number) => number
  radius?: number
  rank?: number
}

/** The scale arc, in fine steps so it reads as a line. */
export function arc(dots: Dots, d: Dial, spec: ArcSpec): void {
  const r = spec.radius ?? d.r
  const rank = spec.rank ?? 1
  const widthAt = spec.widthAt ?? (() => 0)
  const n = Math.ceil(d.sweep * r * 1.6)
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const color = spec.colorAt(t)
    const [x, y] = at(d, t, r)
    dots.dot(x, y, color, rank)
    for (let k = 1, w = widthAt(t); k <= w; k++) {
      const [wx, wy] = at(d, t, r + k)
      dots.dot(wx, wy, color, rank)
    }
  }
}

export type TickSpec = {
  count: number
  colorAt: (t: number) => number
  length?: number
  majorLength?: number
  /** Every `majorEvery`-th tick is a major one, one rank above the rest; 0 (the default) makes none. */
  majorEvery?: number
  rank?: number
  /** How far inside the arc the ticks start. */
  inner?: number
}

/** The ticks along the scale. */
export function ticks(dots: Dots, d: Dial, spec: TickSpec): void {
  const length = spec.length ?? 2
  const majorLength = spec.majorLength ?? length + 1
  const rank = spec.rank ?? 2
  const inner = spec.inner ?? 1
  for (let k = 0; k <= spec.count; k++) {
    const t = k / spec.count
    const major = spec.majorEvery ? k % spec.majorEvery === 0 : false
    const [x0, y0] = at(d, t, d.r - inner)
    const [x1, y1] = at(d, t, d.r - (major ? majorLength : length))
    dots.line(x0, y0, x1, y1, spec.colorAt(t), major ? rank + 1 : rank)
  }
}

export type NeedleSpec = {
  t: number
  color: number
  /** The tip stops this far inside the arc. */
  inner?: number
  /** How far past the pivot the tail runs. */
  tail?: number
  /** The needle's width at the pivot; it tapers to the tip. */
  width?: number
  hub?: { color: number; ringRadius?: number; ringColor?: number }
}

/** The needle at `t`, with its tail and hub. */
export function needle(dots: Dots, d: Dial, spec: NeedleSpec): void {
  const a = angleAt(d, spec.t)
  const [tipX, tipY] = polar(d, a, d.r - (spec.inner ?? 4))
  const [tailX, tailY] = polar(d, a + Math.PI, spec.tail ?? 2)
  dots.needle(d.cx, d.cy, tipX, tipY, spec.width ?? 1.2, spec.color, 3)
  dots.line(tailX, tailY, tipX, tipY, spec.color, 3)
  if (spec.hub) {
    if (spec.hub.ringRadius) {
      for (let i = 0; i < 18; i++) {
        const ha = (i / 18) * 2 * Math.PI
        dots.dot(d.cx + spec.hub.ringRadius * Math.cos(ha), d.cy - spec.hub.ringRadius * Math.sin(ha), spec.hub.ringColor ?? spec.hub.color, 4)
      }
    }
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) dots.dot(d.cx + dx, d.cy + dy, spec.hub.color, 5)
  }
}

export type DialSpec = {
  dial: Dial
  arc?: ArcSpec
  ticks?: TickSpec
  needle?: NeedleSpec
}

/** Draws a dial from its parts, the needle last. */
export function dial(dots: Dots, spec: DialSpec): void {
  if (spec.arc) arc(dots, spec.dial, spec.arc)
  if (spec.ticks) ticks(dots, spec.dial, spec.ticks)
  if (spec.needle) needle(dots, spec.dial, spec.needle)
}
