#!/usr/bin/env node
// A local HTTP(S) proxy for orbit's proxy layer, with no dependencies. It records the CONNECT
// host, the plain-HTTP host, bytes each way and how long each connection lived, and nothing
// else: TLS passes through untouched and is never decrypted.
//
//   node proxy.mjs <log.jsonl> [port]
//
// Prints {"type":"ready","port":N} once listening. ORBIT_UPSTREAM_PROXY, when set, is a proxy
// to chain through (the HTTPS_PROXY the session already had). The log is one JSON line per
// open and per close; it is emptied once it passes 3 MiB, and the plugin notices the shrink.
// The proxy exits when its parent does.

import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { appendFileSync, statSync, writeFileSync } from 'node:fs'

const [logFile, portText] = process.argv.slice(2)
if (!logFile) {
  process.stderr.write('usage: proxy.mjs <log.jsonl> [port]\n')
  process.exit(2)
}
const upstream = process.env.ORBIT_UPSTREAM_PROXY ? new URL(process.env.ORBIT_UPSTREAM_PROXY) : null
let serial = 0

function log(entry) {
  try {
    if (statSync(logFile).size > 3 * 1024 * 1024) writeFileSync(logFile, '')
  } catch {}
  appendFileSync(logFile, JSON.stringify({ t: Date.now(), ...entry }) + '\n')
}

function upstreamAuth() {
  if (!upstream?.username) return ''
  const pair = `${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`
  return `Proxy-Authorization: Basic ${Buffer.from(pair).toString('base64')}\r\n`
}

/** A TCP connection to host:port, directly or through the upstream proxy's CONNECT. */
function open(host, port, onReady, onError) {
  if (!upstream) {
    const socket = netConnect({ host, port }, () => onReady(socket))
    socket.once('error', onError)
    return socket
  }
  const socket = netConnect({ host: upstream.hostname, port: Number(upstream.port || 80) }, () => {
    socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${upstreamAuth()}\r\n`)
  })
  socket.once('error', onError)
  let head = ''
  const onData = chunk => {
    head += chunk.toString('latin1')
    const end = head.indexOf('\r\n\r\n')
    if (end < 0) return
    socket.off('data', onData)
    if (!/^HTTP\/1\.[01] 2\d\d/.test(head)) {
      onError(new Error(`upstream refused: ${head.split('\r\n')[0]}`))
      socket.destroy()
      return
    }
    const rest = Buffer.from(head.slice(end + 4), 'latin1')
    if (rest.length) socket.unshift(rest)
    onReady(socket)
  }
  socket.on('data', onData)
  return socket
}

const server = createServer((req, res) => {
  // A plain HTTP request in absolute form: forward it, counting bytes, through the upstream if any.
  let url
  try {
    url = new URL(req.url)
  } catch {
    res.writeHead(400)
    res.end('orbit proxy: absolute URL required')
    return
  }
  const id = ++serial
  const started = Date.now()
  const host = url.hostname
  const port = Number(url.port || 80)
  let bytesOut = 0
  let bytesIn = 0
  log({ type: 'open', id, host, port, method: req.method, scheme: 'http' })
  req.on('data', c => (bytesOut += c.length))
  const options = upstream
    ? { host: upstream.hostname, port: Number(upstream.port || 80), method: req.method, path: req.url, headers: { ...req.headers, ...(upstream.username ? { 'proxy-authorization': upstreamAuth().split(': ')[1]?.trim() } : {}) } }
    : { host, port, method: req.method, path: url.pathname + url.search, headers: req.headers }
  const out = httpRequest(options, up => {
    if (!upstream && up.socket?.remoteAddress) log({ type: 'ip', id, ip: up.socket.remoteAddress })
    res.writeHead(up.statusCode ?? 502, up.headers)
    up.on('data', c => (bytesIn += c.length))
    up.pipe(res)
    up.on('end', () => log({ type: 'close', id, host, port, bytesIn, bytesOut, ms: Date.now() - started, status: up.statusCode }))
  })
  out.on('error', err => {
    log({ type: 'close', id, host, port, bytesIn, bytesOut, ms: Date.now() - started, error: err.message })
    if (!res.headersSent) res.writeHead(502)
    res.end()
  })
  req.pipe(out)
})

server.on('connect', (req, client, head) => {
  const [host = '', portText = '443'] = req.url.split(':')
  const port = Number(portText) || 443
  const id = ++serial
  const started = Date.now()
  let bytesOut = head.length
  let bytesIn = 0
  let closed = false
  const close = extra => {
    if (closed) return
    closed = true
    log({ type: 'close', id, host, port, bytesIn, bytesOut, ms: Date.now() - started, ...extra })
  }
  log({ type: 'open', id, host, port, method: 'CONNECT', scheme: 'tls' })
  const remote = open(
    host,
    port,
    socket => {
      if (!upstream && socket.remoteAddress) log({ type: 'ip', id, ip: socket.remoteAddress })
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) socket.write(head)
      client.on('data', c => (bytesOut += c.length))
      socket.on('data', c => (bytesIn += c.length))
      client.pipe(socket)
      socket.pipe(client)
      socket.on('close', () => {
        close({})
        client.destroy()
      })
      client.on('close', () => {
        close({})
        socket.destroy()
      })
    },
    err => {
      close({ error: err.message })
      client.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      client.destroy()
    },
  )
  client.on('error', () => {
    close({})
    remote.destroy()
  })
})

server.listen(Number(portText) || 0, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ type: 'ready', port: server.address().port, upstream: upstream ? `${upstream.hostname}:${upstream.port}` : null }) + '\n')
})

// Leave with the parent: stdin closes when it goes, and the ppid turns to 1 if it was killed.
process.stdin.on('end', () => process.exit(0))
process.stdin.on('error', () => {})
process.stdin.resume()
setInterval(() => {
  if (process.ppid === 1) process.exit(0)
}, 2000).unref()
