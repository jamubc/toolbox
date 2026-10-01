// A grid of terminal cells, encoded as a `Raster` takes them: row-major little-endian u32
// triplets [codePoint, foreground, background], base64.

const DEFAULT = 0x01000000 // the terminal's own color

export class Canvas {
  readonly cells: Uint32Array

  constructor(
    readonly rows: number,
    readonly cols: number,
  ) {
    this.cells = new Uint32Array(rows * cols * 3)
    for (let i = 0; i < rows * cols; i++) this.cells.set([0x20, DEFAULT, DEFAULT], i * 3)
  }

  /** Writes `s` from (r, c) in color `fg`; characters off the grid are dropped. */
  put(r: number, c: number, s: string, fg: number): void {
    if (r < 0 || r >= this.rows) return
    let x = c
    for (const ch of s) {
      if (x >= 0 && x < this.cols) this.cells.set([ch.codePointAt(0)!, fg, DEFAULT], (r * this.cols + x) * 3)
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
