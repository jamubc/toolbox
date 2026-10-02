// Addresses and where they are. Nothing here makes a network request: anycast and CDN ranges are
// a bundled table, and the offline database is read by geo/geoip.mjs on the host.

export type Place = {
  lat: number
  lon: number
  country: string // ISO 3166-1 alpha-2, '' when unknown
  city: string
  org: string // the network's name or ASN, '' when unknown
  /** The address belongs to an anycast or CDN network, so the place is where its edge answered, if that. */
  isAnycast: boolean
  /** Who runs the anycast network, when known. */
  anycast: string
}

export const UNKNOWN_PLACE: Place = { lat: 0, lon: 0, country: '', city: '', org: '', isAnycast: false, anycast: '' }

/** Well-known anycast and CDN prefixes, as the operators publish them; the place of one is its edge. */
export const ANYCAST: readonly { prefix: string; name: string }[] = [
  // Anthropic (AS399358)
  { prefix: '160.79.104.0/21', name: 'Anthropic' },
  // Cloudflare (https://www.cloudflare.com/ips-v4)
  { prefix: '173.245.48.0/20', name: 'Cloudflare' },
  { prefix: '103.21.244.0/22', name: 'Cloudflare' },
  { prefix: '103.22.200.0/22', name: 'Cloudflare' },
  { prefix: '103.31.4.0/22', name: 'Cloudflare' },
  { prefix: '141.101.64.0/18', name: 'Cloudflare' },
  { prefix: '108.162.192.0/18', name: 'Cloudflare' },
  { prefix: '190.93.240.0/20', name: 'Cloudflare' },
  { prefix: '188.114.96.0/20', name: 'Cloudflare' },
  { prefix: '197.234.240.0/22', name: 'Cloudflare' },
  { prefix: '198.41.128.0/17', name: 'Cloudflare' },
  { prefix: '162.158.0.0/15', name: 'Cloudflare' },
  { prefix: '104.16.0.0/13', name: 'Cloudflare' },
  { prefix: '104.24.0.0/14', name: 'Cloudflare' },
  { prefix: '172.64.0.0/13', name: 'Cloudflare' },
  { prefix: '131.0.72.0/22', name: 'Cloudflare' },
  { prefix: '1.1.1.0/24', name: 'Cloudflare DNS' },
  { prefix: '1.0.0.0/24', name: 'Cloudflare DNS' },
  { prefix: '2606:4700::/32', name: 'Cloudflare' },
  { prefix: '2803:f800::/32', name: 'Cloudflare' },
  { prefix: '2405:b500::/32', name: 'Cloudflare' },
  { prefix: '2405:8100::/32', name: 'Cloudflare' },
  { prefix: '2a06:98c0::/29', name: 'Cloudflare' },
  { prefix: '2c0f:f248::/32', name: 'Cloudflare' },
  // Fastly (https://api.fastly.com/public-ip-list)
  { prefix: '23.235.32.0/20', name: 'Fastly' },
  { prefix: '43.249.72.0/22', name: 'Fastly' },
  { prefix: '103.244.50.0/24', name: 'Fastly' },
  { prefix: '103.245.222.0/23', name: 'Fastly' },
  { prefix: '103.245.224.0/24', name: 'Fastly' },
  { prefix: '104.156.80.0/20', name: 'Fastly' },
  { prefix: '140.248.64.0/18', name: 'Fastly' },
  { prefix: '140.248.128.0/17', name: 'Fastly' },
  { prefix: '146.75.0.0/17', name: 'Fastly' },
  { prefix: '151.101.0.0/16', name: 'Fastly' },
  { prefix: '157.52.64.0/18', name: 'Fastly' },
  { prefix: '167.82.0.0/17', name: 'Fastly' },
  { prefix: '167.82.128.0/20', name: 'Fastly' },
  { prefix: '167.82.160.0/20', name: 'Fastly' },
  { prefix: '167.82.224.0/20', name: 'Fastly' },
  { prefix: '172.111.64.0/18', name: 'Fastly' },
  { prefix: '185.31.16.0/22', name: 'Fastly' },
  { prefix: '199.27.72.0/21', name: 'Fastly' },
  { prefix: '199.232.0.0/16', name: 'Fastly' },
  { prefix: '2a04:4e40::/32', name: 'Fastly' },
  { prefix: '2a04:4e42::/32', name: 'Fastly' },
  // Google public DNS and Quad9
  { prefix: '8.8.8.0/24', name: 'Google DNS' },
  { prefix: '8.8.4.0/24', name: 'Google DNS' },
  { prefix: '9.9.9.0/24', name: 'Quad9 DNS' },
  // Akamai's main edge blocks
  { prefix: '23.192.0.0/11', name: 'Akamai' },
  { prefix: '104.64.0.0/10', name: 'Akamai' },
  { prefix: '184.24.0.0/13', name: 'Akamai' },
  { prefix: '2.16.0.0/13', name: 'Akamai' },
  { prefix: '95.100.0.0/15', name: 'Akamai' },
]

/** Hosts whose operator is known without a lookup, by suffix. */
export const KNOWN_HOSTS: readonly { suffix: string; org: string }[] = [
  { suffix: 'anthropic.com', org: 'Anthropic' },
  { suffix: 'claude.ai', org: 'Anthropic' },
  { suffix: 'claude.com', org: 'Anthropic' },
  { suffix: 'statsig.com', org: 'Statsig (Anthropic telemetry)' },
  { suffix: 'sentry.io', org: 'Sentry' },
  { suffix: 'github.com', org: 'GitHub' },
  { suffix: 'githubusercontent.com', org: 'GitHub' },
  { suffix: 'npmjs.org', org: 'npm' },
  { suffix: 'pypi.org', org: 'PyPI' },
  { suffix: 'pythonhosted.org', org: 'PyPI' },
  { suffix: 'googleapis.com', org: 'Google' },
  { suffix: 'google.com', org: 'Google' },
  { suffix: 'duckduckgo.com', org: 'DuckDuckGo' },
  { suffix: 'wikipedia.org', org: 'Wikimedia' },
  { suffix: 'amazonaws.com', org: 'Amazon Web Services' },
  { suffix: 'cloudfront.net', org: 'Amazon CloudFront' },
  { suffix: 'db-ip.com', org: 'DB-IP' },
]

export const orgOfHost = (host: string): string => {
  const h = host.toLowerCase()
  return KNOWN_HOSTS.find(k => h === k.suffix || h.endsWith('.' + k.suffix))?.org ?? ''
}

/** 16 bytes for an IPv4 (mapped) or IPv6 address, or null. */
export function parseIp(text: string): Uint8Array | null {
  const s = text.trim().replace(/^\[|\]$/g, '')
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    const parts = s.split('.').map(Number)
    if (parts.some(p => p > 255)) return null
    const out = new Uint8Array(16)
    out[10] = 0xff
    out[11] = 0xff
    out.set(parts, 12)
    return out
  }
  if (!s.includes(':')) return null
  const zone = s.indexOf('%')
  const body = zone >= 0 ? s.slice(0, zone) : s
  const halves = body.split('::')
  if (halves.length > 2) return null
  const words = (part: string): number[] | null => {
    if (part === '') return []
    const out: number[] = []
    for (const w of part.split(':')) {
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(w)) {
        const v4 = parseIp(w)
        if (!v4) return null
        out.push((v4[12]! << 8) | v4[13]!, (v4[14]! << 8) | v4[15]!)
      } else if (/^[0-9a-f]{1,4}$/i.test(w)) out.push(parseInt(w, 16))
      else return null
    }
    return out
  }
  const head = words(halves[0]!)
  const tail = halves.length === 2 ? words(halves[1]!) : []
  if (!head || !tail) return null
  const missing = 8 - head.length - tail.length
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null
  const all = [...head, ...new Array(missing).fill(0), ...tail]
  const out = new Uint8Array(16)
  all.forEach((w, i) => {
    out[i * 2] = w >> 8
    out[i * 2 + 1] = w & 0xff
  })
  return out
}

export const isIpv4 = (ip: Uint8Array): boolean => ip.slice(0, 10).every(b => b === 0) && ip[10] === 0xff && ip[11] === 0xff

/** The address as text: dotted for IPv4, compressed hex for IPv6. */
export function formatIp(ip: Uint8Array): string {
  if (isIpv4(ip)) return `${ip[12]}.${ip[13]}.${ip[14]}.${ip[15]}`
  const words = Array.from({ length: 8 }, (_, i) => ((ip[i * 2]! << 8) | ip[i * 2 + 1]!).toString(16))
  let best = -1
  let bestLength = 0
  for (let i = 0; i < 8; i++) {
    let j = i
    while (j < 8 && words[j] === '0') j++
    if (j - i > bestLength) {
      best = i
      bestLength = j - i
    }
  }
  if (bestLength < 2) return words.join(':')
  return `${words.slice(0, best).join(':')}::${words.slice(best + bestLength).join(':')}`
}

export function inPrefix(ip: Uint8Array, prefix: string): boolean {
  const [base, bitsText] = prefix.split('/')
  const net = parseIp(base ?? '')
  if (!net) return false
  let bits = Number(bitsText)
  if (isIpv4(net)) bits += 96
  if (isIpv4(net) !== isIpv4(ip)) return false
  for (let i = 0; i < 16 && bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff
    if (((ip[i]! ^ net[i]!) & mask) !== 0) return false
  }
  return true
}

/** Loopback, link-local, private, multicast and unspecified addresses, which have no place. */
export function isLocal(ip: Uint8Array): boolean {
  const local4 = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10', '0.0.0.0/8', '224.0.0.0/4']
  const local6 = ['::1/128', '::/128', 'fe80::/10', 'fc00::/7', 'ff00::/8']
  return (isIpv4(ip) ? local4 : local6).some(p => inPrefix(ip, p))
}

export const anycastOf = (ip: Uint8Array): string => ANYCAST.find(a => inPrefix(ip, a.prefix))?.name ?? ''

/** A host as the rules and the log spell it: lowercase, no port, no trailing dot. */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase().replace(/\.$/, '')
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    return end > 0 ? h.slice(1, end) : h
  }
  const colon = h.lastIndexOf(':')
  if (colon > 0 && !h.slice(0, colon).includes(':') && /^\d+$/.test(h.slice(colon + 1))) h = h.slice(0, colon)
  return h
}

/** Great-circle distance in kilometres between two places. */
export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** One line of geo/geoip.mjs's lookup output. */
export type GeoAnswer = { ip: string; country?: string; city?: string; lat?: number; lon?: number; org?: string; error?: string }

export function placeOf(answer: GeoAnswer | undefined, ip: Uint8Array): Place {
  const anycast = anycastOf(ip)
  return {
    lat: answer?.lat ?? 0,
    lon: answer?.lon ?? 0,
    country: answer?.country ?? '',
    city: answer?.city ?? '',
    org: answer?.org || anycast,
    isAnycast: anycast !== '',
    anycast,
  }
}

export const hasPlace = (p: Place): boolean => p.country !== '' || p.lat !== 0 || p.lon !== 0

/** A country code as a flag emoji falls outside width-1 cells; the code itself is drawn instead. */
export const countryLabel = (code: string): string => code || '??'
