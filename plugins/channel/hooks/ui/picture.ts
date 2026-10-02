// Pictures in the pane. A thumbnail arrives as an uncompressed BMP (what
// `sips` writes); it is drawn as real pixels where the terminal can, and as
// half-block cells anywhere else.

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

// Packs a picture into Raster cells: one upper-half block per cell, the top
// pixel as its foreground and the bottom pixel as its background.
export function toCells(bitmap: Bitmap, columns: number, rows: number): string {
  const words = new Uint32Array(columns * rows * 3)
  const pixel = (x: number, y: number) => {
    const px = Math.min(bitmap.width - 1, Math.floor(((x + 0.5) * bitmap.width) / columns))
    const py = Math.min(bitmap.height - 1, Math.floor(((y + 0.5) * bitmap.height) / (rows * 2)))
    const i = (py * bitmap.width + px) * 4

    return ((bitmap.rgba[i] ?? 0) << 16) | ((bitmap.rgba[i + 1] ?? 0) << 8) | (bitmap.rgba[i + 2] ?? 0)
  }
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const i = (row * columns + col) * 3
      words[i] = 0x2580
      words[i + 1] = pixel(col, row * 2)
      words[i + 2] = pixel(col, row * 2 + 1)
    }
  }

  return new Uint8Array(words.buffer).toBase64()
}
