// The tool layer: what a tool call means to reach, read from its input before it runs. WebFetch
// names a URL, WebSearch a search, an MCP tool its server, and a Bash command whatever hosts its
// text names (curl, git, ssh, scp, nc, wget, pip, npm...), found best effort.

import { normalizeHost } from './geo'

export type Intent = {
  tool: string
  /** `host` for a network host, `mcp` for an MCP server, `search` for a web search, `none` for a tool that reaches nothing. */
  kind: 'host' | 'mcp' | 'search' | 'none'
  hosts: string[]
  /** The MCP server's name, for `mcp`. */
  server: string
  /** What the call said, shortened for the log: the URL, the query, the command. */
  summary: string
}

const URL_RE = /\b(?:https?|wss?|ftp|git|ssh|git\+ssh|ssh\+git|smb|rsync):\/\/(?:[^\s@/'"`]*@)?(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(?::\d+)?/gi
const SCP_RE = /(?:^|[\s;&|(])(?:ssh|scp|sftp|rsync|git\s+clone|git\s+push|git\s+pull|git\s+fetch)\s+(?:-\S+\s+)*(?:[a-z0-9._-]+@)?([a-z0-9][a-z0-9.-]+\.[a-z]{2,}|\[[0-9a-f:.]+\]|\d{1,3}(?:\.\d{1,3}){3})(?::|\s|$)/gi
const TOOL_HOST_RE = /(?:^|[\s;&|(])(?:nc|ncat|netcat|telnet|ping|ping6|dig|nslookup|host|traceroute|mtr|openssl\s+s_client\s+-connect|psql\s+-h|mysql\s+-h|redis-cli\s+-h|mongosh|curl|wget|http|https)\s+(?:-[-\w=]+\s+)*(\[[0-9a-f:.]+\]|[a-z0-9][a-z0-9.-]+\.[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:\s|$|\/)/gi
const BARE_HOST_RE = /(?:^|[\s=@'"`(])((?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|ai|co|edu|gov|app|sh|me|info|cloud|tech|xyz|us|uk|de|fr|jp|cn|in|ca|au|nl|se|ch|eu|ru|br))(?::\d+)?(?=[\s/:'"`)]|$)/gi

/** The hosts a shell command names, in order of appearance, each once. */
export function hostsInCommand(command: string): string[] {
  const found: string[] = []
  const add = (raw: string | undefined) => {
    if (!raw) return
    const host = normalizeHost(raw)
    if (host && host !== 'localhost' && !found.includes(host)) found.push(host)
  }
  for (const re of [URL_RE, SCP_RE, TOOL_HOST_RE, BARE_HOST_RE]) {
    re.lastIndex = 0
    for (let m = re.exec(command); m; m = re.exec(command)) add(m[1])
  }
  return found
}

export function hostOfUrl(url: string): string {
  try {
    return normalizeHost(new URL(url).hostname)
  } catch {
    const m = /^(?:[a-z]+:\/\/)?([^/\s:]+)/i.exec(url.trim())
    return m ? normalizeHost(m[1]!) : ''
  }
}

const shorten = (s: string, n = 96) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/** What a tool call reaches, from its input; the fields are read loosely since inputs vary by tool. */
export function intentOf(input: { tool: string } & Record<string, unknown>): Intent {
  const tool = String(input.tool)
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '')
  if (tool === 'WebFetch') {
    const host = hostOfUrl(text('url'))
    return { tool, kind: 'host', hosts: host ? [host] : [], server: '', summary: shorten(text('url')) }
  }
  if (tool === 'WebSearch') {
    return { tool, kind: 'search', hosts: [], server: '', summary: shorten(`search: ${text('query')}`) }
  }
  if (tool === 'Bash') {
    const command = text('command')
    return { tool, kind: 'host', hosts: hostsInCommand(command), server: '', summary: shorten(command.replace(/\s+/g, ' ')) }
  }
  const mcp = /^mcp__([^_].*?)__(.+)$/.exec(tool)
  if (mcp) {
    return { tool, kind: 'mcp', hosts: [], server: mcp[1]!, summary: shorten(`${mcp[1]}: ${mcp[2]}`) }
  }
  return { tool, kind: 'none', hosts: [], server: '', summary: '' }
}

/** Whether a tool is one the tracer watches at all. */
export const isTraced = (tool: string): boolean => tool === 'WebFetch' || tool === 'WebSearch' || tool === 'Bash' || tool.startsWith('mcp__')
