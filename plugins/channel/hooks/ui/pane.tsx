import type { Hub } from '../core/hub'
import { ConversationView } from './conversation'
import type { Elements } from './format'
import { ListView } from './list'

type Props = { bodyColumns: number; bodyRows: number; surface: string; now: number }

// The pane is one of two views: the list, or the conversation picked from it.
export function PaneView(hub: Hub, elements: Elements, props: Props) {
  const ref = hub.view.selected

  return ref
    ? ConversationView(hub, elements, ref, props)
    : ListView(hub, elements, { columns: Math.max(20, props.bodyColumns), now: props.now })
}
