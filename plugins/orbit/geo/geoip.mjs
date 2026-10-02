#!/usr/bin/env node
// Offline IP geolocation for orbit, with no dependencies.
//
//   node geoip.mjs download <dir> [city|country]   fetch DB-IP Lite (city or country, plus ASN) into <dir>
//   node geoip.mjs lookup <geo.mmdb> <asn.mmdb|-> <ip>...   one JSON line per ip
//   node geoip.mjs check <geo.mmdb>                 print the database's metadata
//
// The reader handles any MaxMind DB file (DB-IP Lite, GeoLite2) and the plugin only ever runs
// it on addresses already seen; it makes no request of its own except `download`, which the
// person asks for. `download` honors HTTPS_PROXY.

import { createWriteStream, openSync, readSync, fstatSync, closeSync, statSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { createGunzip } from 'node:zlib'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { join } from 'node:path'

const METADATA_MARKER = Buffer.from('\xab\xcd\xefMaxMind.com', 'latin1')

class Reader {
  constructor(file) {
    this.fd = openSync(file, 'r')
    this.size = fstatSync(this.fd).size
    this.cache = new Map()
    const tail = this.read(Math.max(0, this.size - 128 * 1024), Math.min(this.size, 128 * 1024))
    const at = tail.lastIndexOf(METADATA_MARKER)
    if (at < 0) throw new Error('not a MaxMind DB file')
    const metaStart = Math.max(0, this.size - 128 * 1024) + at + METADATA_MARKER.length
    this.metaBase = metaStart
    this.meta = this.decode(metaStart, metaStart).value
    this.nodeCount = this.meta.node_count
    this.recordSize = this.meta.record_size
    this.ipVersion = this.meta.ip_version
    this.treeSize = Math.floor((this.nodeCount * this.recordSize * 2) / 8)
    this.dataBase = this.treeSize + 16
    this.ipv4Start = 0
    if (this.ipVersion === 6) {
      let node = 0
      for (let i = 0; i < 96 && node < this.nodeCount; i++) node = this.record(node, 0)
      this.ipv4Start = node
    }
  }

  close() {
    closeSync(this.fd)
  }

  read(offset, length) {
    const buf = Buffer.alloc(length)
    let got = 0
    while (got < length) {
      const n = readSync(this.fd, buf, got, length - got, offset + got)
      if (n <= 0) break
      got += n
    }
    return got === length ? buf : buf.subarray(0, got)
  }

  record(node, bit) {
    const rs = this.recordSize
    if (rs === 24) {
      const b = this.read(node * 6 + bit * 3, 3)
      return (b[0] << 16) | (b[1] << 8) | b[2]
    }
    if (rs === 28) {
      const b = this.read(node * 7, 7)
      if (bit === 0) return ((b[3] & 0xf0) << 20) | (b[0] << 16) | (b[1] << 8) | b[2]
      return ((b[3] & 0x0f) << 24) | (b[4] << 16) | (b[5] << 8) | b[6]
    }
    const b = this.read(node * 8 + bit * 4, 4)
    return b.readUInt32BE(0)
  }

  /** The 16 bytes of an address; IPv4 as mapped. */
  static bytesOf(text) {
    const s = text.trim()
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
      const out = Buffer.alloc(16)
      out[10] = 0xff
      out[11] = 0xff
      s.split('.').forEach((p, i) => (out[12 + i] = Number(p)))
      return out
    }
    const halves = s.split('::')
    const words = part => (part === '' ? [] : part.split(':').map(w => parseInt(w, 16)))
    const head = words(halves[0])
    const tail = halves.length > 1 ? words(halves[1]) : []
    const all = [...head, ...new Array(8 - head.length - tail.length).fill(0), ...tail]
    const out = Buffer.alloc(16)
    all.forEach((w, i) => out.writeUInt16BE(w & 0xffff, i * 2))
    return out
  }

  lookup(text) {
    const ip = Reader.bytesOf(text)
    const isV4 = ip[10] === 0xff && ip[11] === 0xff && ip.subarray(0, 10).every(b => b === 0)
    let node = 0
    let start = 0
    if (this.ipVersion === 6) {
      if (isV4) {
        node = this.ipv4Start
        start = 96
      }
    } else if (isV4) start = 96 // an IPv4 tree walks the 32 bits of the address alone
    else return null
    for (let i = start; i < 128 && node < this.nodeCount; i++) {
      const bit = (ip[i >> 3] >> (7 - (i & 7))) & 1
      node = this.record(node, bit)
    }
    if (node === this.nodeCount) return null
    if (node < this.nodeCount) return null
    const offset = node - this.nodeCount + this.treeSize
    return this.decode(offset, this.dataBase).value
  }

  /** Decodes the value at `offset`; pointers are relative to `base`. */
  decode(offset, base) {
    const ctrl = this.read(offset, 1)[0]
    let type = ctrl >> 5
    let at = offset + 1
    if (type === 0) {
      type = 7 + this.read(at, 1)[0]
      at += 1
    }
    let size = ctrl & 0x1f
    if (type === 1) {
      const ss = (ctrl >> 3) & 3
      const vvv = ctrl & 7
      let pointer
      if (ss === 0) {
        pointer = (vvv << 8) | this.read(at, 1)[0]
        at += 1
      } else if (ss === 1) {
        const b = this.read(at, 2)
        pointer = ((vvv << 16) | (b[0] << 8) | b[1]) + 2048
        at += 2
      } else if (ss === 2) {
        const b = this.read(at, 3)
        pointer = ((vvv << 24) | (b[0] << 16) | (b[1] << 8) | b[2]) + 526336
        at += 3
      } else {
        pointer = this.read(at, 4).readUInt32BE(0)
        at += 4
      }
      const target = base + pointer
      const cached = this.cache.get(target)
      if (cached !== undefined) return { value: cached, next: at }
      const { value } = this.decode(target, base)
      if (this.cache.size < 50000) this.cache.set(target, value)
      return { value, next: at }
    }
    if (size === 29) {
      size = 29 + this.read(at, 1)[0]
      at += 1
    } else if (size === 30) {
      const b = this.read(at, 2)
      size = 285 + ((b[0] << 8) | b[1])
      at += 2
    } else if (size === 31) {
      const b = this.read(at, 3)
      size = 65821 + ((b[0] << 16) | (b[1] << 8) | b[2])
      at += 3
    }
    switch (type) {
      case 2:
        return { value: this.read(at, size).toString('utf8'), next: at + size }
      case 3:
        return { value: this.read(at, 8).readDoubleBE(0), next: at + 8 }
      case 4:
        return { value: this.read(at, size), next: at + size }
      case 5:
      case 6:
      case 9:
      case 10: {
        const b = this.read(at, size)
        let v = 0
        for (const byte of b) v = v * 256 + byte
        return { value: v, next: at + size }
      }
      case 7: {
        const map = {}
        let p = at
        for (let i = 0; i < size; i++) {
          const key = this.decode(p, base)
          const val = this.decode(key.next, base)
          map[key.value] = val.value
          p = val.next
        }
        return { value: map, next: p }
      }
      case 8: {
        const b = this.read(at, size)
        let v = 0
        for (const byte of b) v = (v << 8) | byte
        if (size === 4) v = v | 0
        return { value: v, next: at + size }
      }
      case 11: {
        const arr = []
        let p = at
        for (let i = 0; i < size; i++) {
          const item = this.decode(p, base)
          arr.push(item.value)
          p = item.next
        }
        return { value: arr, next: p }
      }
      case 12:
        return { value: null, next: at }
      case 13:
        return { value: null, next: at }
      case 14:
        return { value: size !== 0, next: at }
      case 15:
        return { value: this.read(at, 4).readFloatBE(0), next: at + 4 }
      default:
        throw new Error(`unknown type ${type}`)
    }
  }
}

function placeOf(record) {
  if (!record) return {}
  const out = {}
  const country = record.country?.iso_code ?? record.registered_country?.iso_code
  if (country) out.country = country
  const city = record.city?.names?.en
  if (city) out.city = city
  if (record.location && typeof record.location.latitude === 'number') {
    out.lat = Math.round(record.location.latitude * 1000) / 1000
    out.lon = Math.round(record.location.longitude * 1000) / 1000
  }
  return out
}

function lookup(geoFile, asnFile, ips) {
  const geo = new Reader(geoFile)
  const asn = asnFile && asnFile !== '-' && existsSync(asnFile) ? new Reader(asnFile) : null
  for (const ip of ips) {
    const line = { ip }
    try {
      Object.assign(line, placeOf(geo.lookup(ip)))
      if (asn) {
        const a = asn.lookup(ip)
        if (a?.autonomous_system_organization) line.org = a.autonomous_system_organization
        else if (a?.autonomous_system_number) line.org = `AS${a.autonomous_system_number}`
      }
    } catch (err) {
      line.error = String(err.message ?? err)
    }
    process.stdout.write(JSON.stringify(line) + '\n')
  }
  geo.close()
  asn?.close()
}

/** A GET through HTTPS_PROXY (CONNECT) when set, else direct; resolves the response. */
function get(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
    const options = { method: 'GET', headers: { 'user-agent': 'orbit-geoip/1 (Claude Code plugin)', accept: '*/*' } }
    if (!proxy) {
      const req = httpsRequest(url, options, resolve)
      req.on('error', reject)
      req.end()
      return
    }
    const p = new URL(proxy)
    const socket = netConnect({ host: p.hostname, port: Number(p.port || 80) }, () => {
      const auth = p.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}\r\n` : ''
      socket.write(`CONNECT ${target.hostname}:443 HTTP/1.1\r\nHost: ${target.hostname}:443\r\n${auth}\r\n`)
    })
    socket.once('error', reject)
    let head = ''
    const onData = chunk => {
      head += chunk.toString('latin1')
      const end = head.indexOf('\r\n\r\n')
      if (end < 0) return
      socket.off('data', onData)
      if (!/^HTTP\/1\.[01] 200/.test(head)) {
        reject(new Error(`proxy refused CONNECT: ${head.split('\r\n')[0]}`))
        return
      }
      const tls = tlsConnect({ socket, servername: target.hostname }, () => {
        const req = httpsRequest(url, { ...options, createConnection: () => tls }, resolve)
        req.on('error', reject)
        req.end()
      })
      tls.on('error', reject)
    }
    socket.on('data', onData)
  })
}

async function fetchFollowing(url, hops = 0) {
  const res = await get(url)
  if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 5) {
    res.resume()
    return fetchFollowing(new URL(res.headers.location, url).href, hops + 1)
  }
  return res
}

const say = obj => process.stdout.write(JSON.stringify(obj) + '\n')

async function downloadOne(name, dir) {
  const now = new Date()
  const months = [0, 1, 2].map(back => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  })
  const out = join(dir, `${name}.mmdb`)
  const part = out + '.part'
  for (const month of months) {
    const url = `https://download.db-ip.com/free/${name}-${month}.mmdb.gz`
    say({ type: 'start', name, url })
    let res
    try {
      res = await fetchFollowing(url)
    } catch (err) {
      say({ type: 'error', name, error: String(err.message ?? err) })
      return null
    }
    if (res.statusCode !== 200) {
      res.resume()
      say({ type: 'miss', name, url, status: res.statusCode })
      continue
    }
    const total = Number(res.headers['content-length'] || 0)
    let got = 0
    let lastSaid = 0
    await new Promise((resolve, reject) => {
      const file = createWriteStream(part)
      res.on('data', chunk => {
        got += chunk.length
        if (got - lastSaid > 2 * 1024 * 1024) {
          lastSaid = got
          say({ type: 'progress', name, bytes: got, total })
        }
      })
      res.pipe(createGunzip()).pipe(file)
      file.on('finish', resolve)
      file.on('error', reject)
      res.on('error', reject)
    })
    renameSync(part, out)
    say({ type: 'done', name, file: out, size: statSync(out).size, month })
    return out
  }
  say({ type: 'error', name, error: 'no release found for the last three months' })
  return null
}

async function download(dir, level) {
  mkdirSync(dir, { recursive: true })
  const geo = await downloadOne(level === 'country' ? 'dbip-country-lite' : 'dbip-city-lite', dir)
  const asn = await downloadOne('dbip-asn-lite', dir)
  say({ type: 'finished', geo, asn })
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'lookup') {
  const [geoFile, asnFile, ...ips] = rest
  lookup(geoFile, asnFile, ips)
} else if (command === 'download') {
  download(rest[0], rest[1] === 'country' ? 'country' : 'city').catch(err => {
    say({ type: 'error', error: String(err.message ?? err) })
    process.exit(1)
  })
} else if (command === 'check') {
  const r = new Reader(rest[0])
  say({ type: 'meta', database: r.meta.database_type, built: r.meta.build_epoch, nodes: r.nodeCount, recordSize: r.recordSize, ipVersion: r.ipVersion })
  r.close()
} else {
  process.stderr.write('usage: geoip.mjs lookup <geo.mmdb> <asn.mmdb|-> <ip>... | download <dir> [city|country] | check <geo.mmdb>\n')
  process.exit(2)
}
