// Enforcement: rules over hosts, MCP servers and tools, decided before a tool runs. A host
// pattern is a domain (`example.com` matches its subdomains too), a glob (`*.example.com`,
// `api-*.example.com`), an address, or `*` for every host.

import type { Intent } from './tools'

export type Rule = {
  /** `host:` a network host, `mcp:` an MCP server, `tool:` a tool name. */
  kind: 'host' | 'mcp' | 'tool'
  pattern: string
  action: 'allow' | 'deny'
  /** When it was added, ms since the epoch. */
  at: number
}

/** `off` logs only; `denylist` blocks what a deny rule names; `allowlist` blocks all but allow rules; `ask` asks about the unknown. */
export type Mode = 'off' | 'denylist' | 'allowlist' | 'ask'

export const MODES: readonly Mode[] = ['off', 'denylist', 'allowlist', 'ask']

export type Decision = {
  action: 'allow' | 'deny' | 'ask'
  /** The rule that decided, when one did. */
  rule?: Rule
  /** What was judged: the host, the server or the tool. */
  subject: string
  kind: Rule['kind']
}

/** Parses `host:example.com`, `mcp:github`, `tool:WebSearch`, or a bare pattern, which is a host. */
export function parseSubject(text: string): { kind: Rule['kind']; pattern: string } | null {
  const t = text.trim().toLowerCase()
  if (t === '') return null
  const m = /^(host|mcp|tool):(.+)$/.exec(t)
  if (m) return { kind: m[1] as Rule['kind'], pattern: m[1] === 'tool' ? text.trim().slice(5) : m[2]! }
  return { kind: 'host', pattern: t }
}

export function matchesPattern(pattern: string, subject: string): boolean {
  const p = pattern.toLowerCase()
  const s = subject.toLowerCase()
  if (p === '*' || p === s) return true
  if (p.includes('*')) {
    const re = new RegExp('^' + p.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
    return re.test(s)
  }
  return s.endsWith('.' + p)
}

/** The rule deciding `subject`: the most specific match (longest pattern), newest among equals. */
export function ruleFor(rules: readonly Rule[], kind: Rule['kind'], subject: string): Rule | undefined {
  return rules
    .filter(r => r.kind === kind && matchesPattern(r.pattern, subject))
    .sort((a, b) => b.pattern.length - a.pattern.length || b.at - a.at)[0]
}

/**
 * Decides every subject a call reaches. The first deny wins; in `allowlist` mode a subject no
 * allow rule names is denied; in `ask` mode it is asked about; `off` allows everything.
 */
export function decide(rules: readonly Rule[], mode: Mode, intent: Intent): Decision[] {
  const subjects: { kind: Rule['kind']; subject: string }[] = [{ kind: 'tool', subject: intent.tool }]
  if (intent.kind === 'mcp') subjects.push({ kind: 'mcp', subject: intent.server })
  for (const h of intent.hosts) subjects.push({ kind: 'host', subject: h })
  if (intent.kind === 'search') subjects.push({ kind: 'host', subject: 'search' })

  const out: Decision[] = []
  for (const { kind, subject } of subjects) {
    const rule = ruleFor(rules, kind, subject)
    if (mode === 'off') out.push({ action: 'allow', subject, kind, rule })
    else if (rule) out.push({ action: rule.action, rule, subject, kind })
    else if (kind === 'tool') out.push({ action: 'allow', subject, kind }) // a tool is judged by what it reaches
    else if (mode === 'allowlist') out.push({ action: 'deny', subject, kind })
    else if (mode === 'ask') out.push({ action: 'ask', subject, kind })
    else out.push({ action: 'allow', subject, kind })
  }
  return out
}

export const verdict = (decisions: readonly Decision[]): Decision | undefined =>
  decisions.find(d => d.action === 'deny') ?? decisions.find(d => d.action === 'ask')

export function describeRule(r: Rule): string {
  return `${r.action === 'deny' ? 'block' : 'allow'} ${r.kind}:${r.pattern}`
}

/** Adds or replaces the rule for a subject. */
export function withRule(rules: readonly Rule[], rule: Rule): Rule[] {
  return [...rules.filter(r => !(r.kind === rule.kind && r.pattern === rule.pattern)), rule]
}

export function withoutRule(rules: readonly Rule[], kind: Rule['kind'], pattern: string): Rule[] {
  return rules.filter(r => !(r.kind === kind && r.pattern === pattern))
}
