// The braille dot grid the gauges draw into: each terminal cell is a 2 × 4 grid of dots, so the
// arcs stay round and the needles thin. A cell takes the color of the highest-ranked dot drawn in
// it; text cells sit above every dot.

import { Canvas } from './canvas'

const BIT = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]] as const // braille dot bits by [row][column]

export class Dots {
  readonly bits: Uint8Array
  readonly color: Int32Array
  readonly rank: Int8Array
  private readonly chars = new Map<number, string>()

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

  /** A needle from the hub to the tip, `wBase` dots wide at the hub and a point at the tip. */
  needle(hubX: number, hubY: number, tipX: number, tipY: number, wBase: number, color: number, rank: number): void {
    const dx = tipX - hubX
    const dy = tipY - hubY
    const len = Math.hypot(dx, dy) || 1
    const px = -dy / len
    const py = dx / len
    const n = Math.ceil(len * 2)
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const w = wBase * (1 - t)
      const x = hubX + dx * t
      const y = hubY + dy * t
      for (let o = -w; o <= w; o += 0.5) this.dot(x + px * o, y + py * o, color, rank)
    }
  }

  /** Writes `s` as text cells from (r, c); characters off the grid are dropped. */
  text(r: number, c: number, s: string, color: number): void {
    if (r < 0 || r >= this.rows) return
    let x = c
    for (const ch of s) {
      if (x >= 0 && x < this.cols) {
        const i = r * this.cols + x
        this.bits[i] = 0
        this.rank[i] = 99
        this.color[i] = color
        this.chars.set(i, ch)
      }
      x++
    }
  }

  /** Pastes `other` at (r, c): dots merge by rank, text stays text. */
  blit(other: Dots, r: number, c: number): void {
    for (let i = 0; i < other.bits.length; i++) {
      const or = Math.floor(i / other.cols) + r
      const oc = (i % other.cols) + c
      if (or < 0 || or >= this.rows || oc < 0 || oc >= this.cols) continue
      const to = or * this.cols + oc
      const ch = other.chars.get(i)
      if (ch !== undefined) {
        this.bits[to] = 0
        this.rank[to] = 99
        this.color[to] = other.color[i]!
        this.chars.set(to, ch)
        continue
      }
      if (!other.bits[i]) continue
      this.bits[to]! |= other.bits[i]!
      if (other.rank[i]! >= this.rank[to]!) {
        this.rank[to] = other.rank[i]!
        this.color[to] = other.color[i]!
      }
    }
  }

  toCanvas(): Canvas {
    const cv = new Canvas(this.rows, this.cols)
    for (let i = 0; i < this.bits.length; i++) {
      const ch = this.chars.get(i)
      if (ch !== undefined) cv.put(Math.floor(i / this.cols), i % this.cols, ch, this.color[i]!)
      else if (this.bits[i]) cv.put(Math.floor(i / this.cols), i % this.cols, String.fromCharCode(0x2800 + this.bits[i]!), this.color[i]!)
    }
    return cv
  }
}
