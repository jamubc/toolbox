// A PNG encoder with its own deflate, since the hooks runtime has no zlib: LZ77 over a hash chain
// with the fixed Huffman code (RFC 1951 §3.2.6). A globe frame is mostly flat color and long
// repeats, so it compresses to a few percent of the raw pixels.

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function adler32(bytes: Uint8Array): number {
  let a = 1
  let b = 0
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

/** Writes bits least-significant first, as deflate reads them. */
class BitWriter {
  private out = new Uint8Array(1 << 16)
  private length = 0
  private acc = 0
  private bits = 0

  write(value: number, count: number): void {
    this.acc |= value << this.bits
    this.bits += count
    while (this.bits >= 8) {
      this.push(this.acc & 0xff)
      this.acc >>>= 8
      this.bits -= 8
    }
  }

  /** A Huffman code is written most-significant bit first. */
  writeCode(code: number, length: number): void {
    let reversed = 0
    for (let i = 0; i < length; i++) reversed = (reversed << 1) | ((code >> i) & 1)
    this.write(reversed, length)
  }

  private push(byte: number): void {
    if (this.length === this.out.length) {
      const bigger = new Uint8Array(this.out.length * 2)
      bigger.set(this.out)
      this.out = bigger
    }
    this.out[this.length++] = byte
  }

  finish(): Uint8Array {
    if (this.bits > 0) this.push(this.acc & 0xff)
    return this.out.slice(0, this.length)
  }
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]

function writeLiteral(w: BitWriter, byte: number): void {
  if (byte < 144) w.writeCode(0x30 + byte, 8)
  else w.writeCode(0x190 + (byte - 144), 9)
}

function writeSymbol(w: BitWriter, symbol: number): void {
  // 256..279 are 7-bit codes 0000000..0010111; 280..287 are 8-bit 11000000..
  if (symbol < 280) w.writeCode(symbol - 256, 7)
  else w.writeCode(0xc0 + (symbol - 280), 8)
}

function writeMatch(w: BitWriter, length: number, distance: number): void {
  let li = LENGTH_BASE.length - 1
  while (LENGTH_BASE[li]! > length) li--
  writeSymbol(w, 257 + li)
  if (LENGTH_EXTRA[li]! > 0) w.write(length - LENGTH_BASE[li]!, LENGTH_EXTRA[li]!)
  let di = DIST_BASE.length - 1
  while (DIST_BASE[di]! > distance) di--
  w.writeCode(di, 5)
  if (DIST_EXTRA[di]! > 0) w.write(distance - DIST_BASE[di]!, DIST_EXTRA[di]!)
}

const WINDOW = 32768
const HASH_BITS = 15
const MAX_CHAIN = 16

/** Deflate: one fixed-Huffman block over an LZ77 parse of `data`. */
export function deflate(data: Uint8Array): Uint8Array {
  const w = new BitWriter()
  w.write(1, 1) // final block
  w.write(1, 2) // fixed Huffman
  const head = new Int32Array(1 << HASH_BITS).fill(-1)
  const prev = new Int32Array(WINDOW)
  const hashAt = (i: number) => ((data[i]! << 10) ^ (data[i + 1]! << 5) ^ data[i + 2]!) & ((1 << HASH_BITS) - 1)
  let i = 0
  while (i < data.length) {
    let bestLength = 0
    let bestDistance = 0
    if (i + 2 < data.length) {
      const h = hashAt(i)
      let candidate = head[h]!
      let chain = 0
      while (candidate >= 0 && i - candidate <= WINDOW && chain < MAX_CHAIN) {
        const limit = Math.min(258, data.length - i)
        let length = 0
        while (length < limit && data[candidate + length] === data[i + length]) length++
        if (length > bestLength) {
          bestLength = length
          bestDistance = i - candidate
          if (length === limit) break
        }
        candidate = prev[candidate % WINDOW]!
        chain++
      }
      prev[i % WINDOW] = head[h]!
      head[h] = i
    }
    if (bestLength >= 3) {
      writeMatch(w, bestLength, bestDistance)
      for (let k = 1; k < bestLength; k++) {
        const j = i + k
        if (j + 2 < data.length) {
          const h = hashAt(j)
          prev[j % WINDOW] = head[h]!
          head[h] = j
        }
      }
      i += bestLength
    } else {
      writeLiteral(w, data[i]!)
      i++
    }
  }
  writeSymbol(w, 256)
  return w.finish()
}

function zlib(data: Uint8Array): Uint8Array {
  const body = deflate(data)
  const out = new Uint8Array(body.length + 6)
  out[0] = 0x78
  out[1] = 0x01
  out.set(body, 2)
  const sum = adler32(data)
  out[out.length - 4] = sum >>> 24
  out[out.length - 3] = (sum >>> 16) & 0xff
  out[out.length - 2] = (sum >>> 8) & 0xff
  out[out.length - 1] = sum & 0xff
  return out
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 12)
  const view = new DataView(out.buffer)
  view.setUint32(0, body.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(body, 8)
  view.setUint32(body.length + 8, crc32(out, 4, body.length + 8))
  return out
}

/** A PNG of `width × height` RGBA pixels. */
export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const raw = new Uint8Array((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1)
  }
  const header = new Uint8Array(13)
  const hv = new DataView(header.buffer)
  hv.setUint32(0, width)
  hv.setUint32(4, height)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk('IHDR', header),
    chunk('IDAT', zlib(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
