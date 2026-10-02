import type { EngineInterface } from 'claude-code'

import type { Reaction } from '../core/contract'

export type Elements = ReturnType<EngineInterface['ui']['resolve']>

// Text cut to fit `width` cells, with an ellipsis where it was cut.
export function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`
}

export function clockTime(at: number): string {
  const time = new Date(at)

  return `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
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
