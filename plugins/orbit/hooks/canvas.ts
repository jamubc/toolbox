// Pixels and cells. A `Pixels` buffer is drawn into at any resolution; it packs into a `Raster`'s
// cells as half-blocks (two pixels per cell, the top as foreground, the bottom as background) or
// into RGBA bytes for an `Image`. Cells are little-endian u32 triplets [codePoint, fg, bg].

export const DEFAULT_COLOR = 0x01000000 // the terminal's own color
const HALF_BLOCK = 0x2580

export class Pixels {
  readonly rgb: Int32Array // 0xRRGGBB per pixel, -1 for transparent (the terminal's background)

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.rgb = new Int32Array(width * height).fill(-1)
  }

  set(x: number, y: number, color: number): void {
    const px = Math.round(x)
    const py = Math.round(y)
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return
    this.rgb[py * this.width + px] = color
  }

  get(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return -1
    return this.rgb[y * this.width + x]!
  }

  /** A line of pixels; `thickness` above 1 draws neighbours too. */
  line(x0: number, y0: number, x1: number, y1: number, color: number, thickness = 1): void {
    const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))) || 1
    for (let i = 0; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n
      const y = y0 + ((y1 - y0) * i) / n
      this.set(x, y, color)
      if (thickness >= 2) {
        this.set(x + 1, y, color)
        this.set(x, y + 1, color)
      }
      if (thickness >= 3) {
        this.set(x - 1, y, color)
        this.set(x, y - 1, color)
      }
    }
  }

  /** Half-block cells for a Raster `columns` wide and `rows` tall; the buffer is `columns × 2·rows`. */
  toCells(): string {
    const columns = this.width
    const rows = Math.ceil(this.height / 2)
    const words = new Uint32Array(columns * rows * 3)
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        const top = this.get(c, r * 2)
        const bottom = this.get(c, r * 2 + 1)
        const i = (r * columns + c) * 3
        if (top < 0 && bottom < 0) {
          words[i] = 0x20
          words[i + 1] = DEFAULT_COLOR
          words[i + 2] = DEFAULT_COLOR
        } else {
          words[i] = HALF_BLOCK
          words[i + 1] = top < 0 ? DEFAULT_COLOR : top
          words[i + 2] = bottom < 0 ? DEFAULT_COLOR : bottom
        }
      }
    }
    return new Uint8Array(words.buffer).toBase64()
  }

  /** RGBA bytes, transparent pixels as `background`. */
  toRgba(background = 0x000000): Uint8Array {
    const out = new Uint8Array(this.width * this.height * 4)
    for (let i = 0; i < this.rgb.length; i++) {
      const c = this.rgb[i]! < 0 ? background : this.rgb[i]!
      out[i * 4] = (c >> 16) & 0xff
      out[i * 4 + 1] = (c >> 8) & 0xff
      out[i * 4 + 2] = c & 0xff
      out[i * 4 + 3] = 0xff
    }
    return out
  }
}

/** A grid of text cells, for a Raster that carries glyphs (labels over a globe). */
export class Canvas {
  readonly cells: Uint32Array

  constructor(
    readonly rows: number,
    readonly cols: number,
  ) {
    this.cells = new Uint32Array(rows * cols * 3)
    for (let i = 0; i < rows * cols; i++) this.cells.set([0x20, DEFAULT_COLOR, DEFAULT_COLOR], i * 3)
  }

  put(r: number, c: number, s: string, fg: number, bg = DEFAULT_COLOR): void {
    if (r < 0 || r >= this.rows) return
    let x = c
    for (const ch of s) {
      if (x >= 0 && x < this.cols) this.cells.set([ch.codePointAt(0)!, fg, bg], (r * this.cols + x) * 3)
      x++
    }
  }

  line(r: number): string {
    let s = ''
    for (let c = 0; c < this.cols; c++) s += String.fromCodePoint(this.cells[(r * this.cols + c) * 3] ?? 0x20)
    return s
  }

  encode(): string {
    return new Uint8Array(this.cells.buffer).toBase64()
  }
}

/** Mixes two 0xRRGGBB colors: `t` 0 is `a`, 1 is `b`. */
export function mix(a: number, b: number, t: number): number {
  const k = Math.max(0, Math.min(1, t))
  const ch = (shift: number) => Math.round(((a >> shift) & 0xff) * (1 - k) + ((b >> shift) & 0xff) * k)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/** Scales a color toward black: `k` 1 keeps it, 0 is black. */
export const dim = (color: number, k: number): number => mix(0x000000, color, k)

/** `#rrggbb` for a Text color prop. */
export const hex = (c: number) => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`
