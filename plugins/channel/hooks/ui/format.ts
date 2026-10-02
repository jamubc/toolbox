import type { EngineInterface } from 'claude-code'

import type { Attachment, Reaction } from '../core/contract'

export type Elements = ReturnType<EngineInterface['ui']['resolve']>

// Text cut to fit `width` cells, with an ellipsis where it was cut.
export function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`
}

export function clockTime(at: number): string {
  const time = new Date(at)

  return `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function dayStart(at: number): number {
  const d = new Date(at)

  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

// The day a message belongs to, as a separator names it against `now`.
export function dayLabel(at: number, now: number): string {
  const days = Math.round((dayStart(now) - dayStart(at)) / 86_400_000)
  if (days <= 0) {
    return 'Today'
  }
  if (days === 1) {
    return 'Yesterday'
  }
  const d = new Date(at)
  if (days < 7) {
    return DAYS[d.getDay()] ?? ''
  }
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]}`

  return d.getFullYear() === new Date(now).getFullYear() ? date : `${date} ${d.getFullYear()}`
}

export const isSameDay = (a: number, b: number) => dayStart(a) === dayStart(b)

// When a conversation last moved, as its row shows it: the time today, the
// day this week, else the date.
export function whenLabel(at: number, now: number): string {
  const label = dayLabel(at, now)

  return label === 'Today' ? clockTime(at) : label === 'Yesterday' ? 'Yest.' : label
}

export function sizeOf(bytes: number | undefined): string {
  if (bytes === undefined) {
    return ''
  }
  if (bytes < 1024) {
    return `${bytes} B`
  }

  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function reactionsOf(reactions: readonly Reaction[] | undefined): string {
  return (reactions ?? []).map(one => (one.count > 1 ? `${one.emoji} ${one.count}` : one.emoji)).join(' ')
}

// A glyph for a file by what it holds, so a row reads at a glance.
export function glyphOf(part: Pick<Attachment, 'mime' | 'name'>): string {
  const mime = part.mime.toLowerCase()
  const ext = part.name.toLowerCase().split('.').at(-1) ?? ''
  if (mime.startsWith('image/')) {
    return '🖼'
  }
  if (mime.startsWith('video/') || ['mov', 'mp4', 'webm', 'm4v'].includes(ext)) {
    return '🎬'
  }
  if (mime.startsWith('audio/') || ['m4a', 'mp3', 'caf', 'wav', 'aac'].includes(ext)) {
    return '🎵'
  }
  if (mime === 'application/pdf' || ext === 'pdf') {
    return '📄'
  }
  if (/zip|tar|gzip|compressed|archive/.test(mime) || ['zip', 'tgz', 'gz', 'dmg', '7z', 'rar'].includes(ext)) {
    return '📦'
  }
  if (mime.startsWith('text/') || /json|xml|markdown/.test(mime) || ['md', 'txt', 'csv', 'json', 'log'].includes(ext)) {
    return '📝'
  }
  if (/vcard|contact/.test(mime) || ext === 'vcf') {
    return '👤'
  }
  if (/calendar/.test(mime) || ext === 'ics') {
    return '📅'
  }

  return '📎'
}

export function fileLabel(part: Attachment): string {
  return `${glyphOf(part)} ${part.name}${part.bytes === undefined ? '' : ` · ${sizeOf(part.bytes)}`}`
}

// A color for a person, the same every time their name comes up: soft tones
// that read on dark and light terminals alike.
const PALETTE = ['#5fb3f5', '#f58fb8', '#f5c35f', '#6fd6a8', '#b49cf5', '#f5a56f', '#6fd3e0', '#d9b36f']

export function colorOf(id: string): string {
  let hash = 0
  for (const ch of id) {
    hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  }

  return PALETTE[hash % PALETTE.length] ?? '#5fb3f5'
}

// The letters an avatar chip shows for a name: the initials of a person, the
// first letter of a phone number's digits spelled out as "#".
export function initialsOf(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}+ ]/gu, ' ').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) {
    return '?'
  }
  if (/^\+?\d/.test(words[0] ?? '')) {
    return '#'
  }
  const first = [...(words[0] ?? '')][0] ?? ''
  const second = words.length > 1 ? ([...(words[words.length - 1] ?? '')][0] ?? '') : ''

  return `${first}${second}`.toUpperCase()
}
