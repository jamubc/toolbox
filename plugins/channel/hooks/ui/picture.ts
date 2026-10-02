// Pictures in the pane. A thumbnail arrives as an uncompressed BMP (what
// `sips` writes); it is drawn as real pixels where the terminal can, and as
// half-block cells anywhere else. The same ideas as the browse pane's frames:
// the terminal reads a PNG file itself where it draws pixels, cells are
// averaged from the pixels they cover rather than sampled, and the encoded
// cells of one picture at one size are kept, since a pane redraws often and
// a picture seldom changes.

export type Bitmap = { width: number; height: number; rgba: Uint8Array }

// A picture ready to draw. `width` and `height` are the original's, for its
// shape. Where the terminal draws pixels it is a PNG file the terminal reads
// itself, so its pixels never sit in this mod's memory; elsewhere it is a
// small bitmap to pack into cells.
export type Picture = {
  width: number
  height: number
  source: { file: string; generation: number } | { bitmap: Bitmap }
}

// Decodes an uncompressed 24- or 32-bit BMP, stored top-down or bottom-up.
export function decodeBmp(bytes: Uint8Array): Bitmap | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
    return undefined
  }
  const start = view.getUint32(10, true)
  const width = view.getInt32(18, true)
  const signed = view.getInt32(22, true)
  const height = Math.abs(signed)
  const depth = view.getUint16(28, true) / 8
  const stride = Math.ceil((width * depth) / 4) * 4
  if (width <= 0 || height <= 0 || (depth !== 3 && depth !== 4) || start + stride * height > bytes.length) {
    return undefined
  }

  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    // A positive height stores the bottom row first.
    const row = start + (signed > 0 ? height - 1 - y : y) * stride
    for (let x = 0; x < width; x += 1) {
      const from = row + x * depth
      const to = (y * width + x) * 4
      rgba[to] = bytes[from + 2] ?? 0
      rgba[to + 1] = bytes[from + 1] ?? 0
      rgba[to + 2] = bytes[from] ?? 0
      rgba[to + 3] = 0xff
    }
  }

  return { width, height, rgba }
}

// The box of character cells a picture fills, keeping its shape: a cell is
// about twice as tall as it is wide.
export function fit(bitmap: { width: number; height: number }, maxColumns: number, maxRows: number): { columns: number; rows: number } {
  const rows = Math.max(1, Math.min(maxRows, Math.round((maxColumns * bitmap.height) / bitmap.width / 2)))
  const columns = Math.max(1, Math.min(maxColumns, Math.round((rows * 2 * bitmap.width) / bitmap.height)))

  return { columns, rows }
}

// The average color of the pixels a half-cell covers: a box filter, so a
// photo shrunk to a few dozen cells keeps its tones instead of flickering
// between the pixels that happen to land on a sample point.
function average(bitmap: Bitmap, x0: number, x1: number, y0: number, y1: number): number {
  const left = Math.min(bitmap.width - 1, Math.floor(x0))
  const right = Math.max(left + 1, Math.min(bitmap.width, Math.ceil(x1)))
  const top = Math.min(bitmap.height - 1, Math.floor(y0))
  const bottom = Math.max(top + 1, Math.min(bitmap.height, Math.ceil(y1)))
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let y = top; y < bottom; y += 1) {
    let i = (y * bitmap.width + left) * 4
    for (let x = left; x < right; x += 1) {
      r += bitmap.rgba[i] ?? 0
      g += bitmap.rgba[i + 1] ?? 0
      b += bitmap.rgba[i + 2] ?? 0
      n += 1
      i += 4
    }
  }
  if (n === 0) {
    return 0
  }

  return (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n)
}

// Packs a picture into Raster cells: one upper-half block per cell, the top
// half's average as its foreground and the bottom half's as its background.
export function toCells(bitmap: Bitmap, columns: number, rows: number): string {
  const words = new Uint32Array(columns * rows * 3)
  const cellWidth = bitmap.width / columns
  const halfHeight = bitmap.height / (rows * 2)
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const i = (row * columns + col) * 3
      const x0 = col * cellWidth
      const x1 = x0 + cellWidth
      words[i] = 0x2580
      words[i + 1] = average(bitmap, x0, x1, row * 2 * halfHeight, (row * 2 + 1) * halfHeight)
      words[i + 2] = average(bitmap, x0, x1, (row * 2 + 1) * halfHeight, (row * 2 + 2) * halfHeight)
    }
  }

  return new Uint8Array(words.buffer).toBase64()
}

// The cells of a bitmap at one size, encoded once: a redraw at the same size
// (every message, every poll) reuses them; a resize makes the new size.
const encoded = new WeakMap<Bitmap, Map<string, string>>()

export function cellsOf(bitmap: Bitmap, columns: number, rows: number): string {
  let sizes = encoded.get(bitmap)
  if (sizes === undefined) {
    sizes = new Map()
    encoded.set(bitmap, sizes)
  }
  const size = `${columns}x${rows}`
  let cells = sizes.get(size)
  if (cells === undefined) {
    cells = toCells(bitmap, columns, rows)
    // A pane that changed width a few times keeps a few; not every size ever drawn.
    if (sizes.size >= 4) {
      const [oldest] = sizes.keys()
      if (oldest !== undefined) {
        sizes.delete(oldest)
      }
    }
    sizes.set(size, cells)
  }

  return cells
}
