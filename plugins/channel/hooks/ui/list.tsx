import { ALL } from '../core/hub'
import type { Hub } from '../core/hub'
import { clip, colorOf, initialsOf, whenLabel } from './format'
import type { Elements } from './format'

// Below this width rows drop their preview line and time.
const NARROW = 40
const HOTKEYS = 9
const ROW_BG = '#1c2730'

type Props = { columns: number; now: number }

// The first view: a tab per service, then that tab's conversations, each a
// row with an avatar chip, the name, when it last moved, and its newest
// message beneath.
export function ListView(hub: Hub, { Box, Button, Text }: Elements, props: Props) {
  const { columns, now } = props
  const tabs = hub.tabs()
  const current = tabs.find(one => one.isSelected)
  const rows = hub.rows()
  const { notifier, inbox } = hub
  const target = notifier.target()
  const isNarrow = columns < NARROW
  const unreadAll = inbox.unreadOf()

  return (
    <Box flexDirection="column">
      <Box key="head" flexDirection="row" gap={1}>
        <Box flexShrink={0}>
          <Text bold color="cyan">{'● Chats'}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text dimColor wrap="truncate-end">{unreadAll > 0 ? `${unreadAll} unread` : ' '}</Text>
        </Box>
      </Box>
      <Box key="tabs" gap={1} flexWrap="wrap">
        {tabs.map(tab => {
          const label = tab.unread > 0 ? `${tab.label} ${tab.unread}` : tab.label

          return tab.isSelected ? (
            <Text key={`tab-${tab.id}`} bold inverse>{` ${label} `}</Text>
          ) : (
            <Button key={`tab-${tab.id}`} plain label={label} hotkey={tab.label.charAt(0).toLowerCase()} onPress={() => hub.selectTab(tab.id)} />
          )
        })}
        {tabs.length === 0 && <Text dimColor>No chat service is set up.</Text>}
      </Box>
      <Text dimColor>{'─'.repeat(columns)}</Text>
      {target && (
        <Button key="jump" plain label={clip(`↪ new in ${inbox.nameOf(target)}`, columns)} hotkey="n" onPress={() => void hub.jump()} />
      )}
      {current?.health.state === 'setup' && (
        <Box key="setup" flexDirection="column">
          <Text color="yellow">{current.health.summary}</Text>
          {current.health.steps.map((step, index) => (
            <Text key={`step-${index}`} wrap="wrap">{`${index + 1}. ${step}`}</Text>
          ))}
        </Box>
      )}
      {current?.health.state === 'ready' && rows.length === 0 && hub.problems().length === 0 && (
        <Text dimColor>Loading conversations…</Text>
      )}
      {rows.map((one, index) => {
        const unread = inbox.unread(one.ref)
        const service = hub.view.tab === ALL ? hub.labelOf(one.ref.service) : ''
        const when = isNarrow ? '' : whenLabel(one.at, now)
        const people = one.members !== undefined && one.members > 2 ? `${one.members} people` : ''
        const tail = [service, people].filter(Boolean).join(' · ')
        const badge = unread > 0 ? `${unread} new` : ''
        // The name gives way to the time and the badge; the hotkey and the chip take 7 cells.
        const room = Math.max(8, columns - 7 - (when ? when.length + 2 : 0) - (badge ? badge.length + 2 : 0))
        const preview = isNarrow ? '' : clip(hub.previewOf(one), columns - 7)
        const hotkey = index < HOTKEYS ? String(index + 1) : undefined
        const color = colorOf(one.name)

        return (
          <Box key={`row-${one.ref.service}-${one.id}`} flexDirection="column" hover={{ backgroundColor: ROW_BG }}>
            <Box flexDirection="row">
              <Text color={unread > 0 ? 'cyan' : undefined}>{unread > 0 ? '● ' : '  '}</Text>
              <Text backgroundColor={color} color="#101418" bold>{` ${initialsOf(one.name).padEnd(2)} `}</Text>
              <Text> </Text>
              <Button
                key={`open-${one.ref.service}-${one.id}`}
                plain
                hotkey={hotkey}
                label={clip(one.name, room)}
                onPress={() => void hub.open(one.ref)}
              />
              {badge !== '' && <Text color="cyan" bold>{`  ${badge}`}</Text>}
              <Box flexGrow={1} />
              {when !== '' && <Text dimColor>{`  ${when}`}</Text>}
            </Box>
            {(preview !== '' || tail !== '') && (
              <Text dimColor wrap="truncate-end">{`       ${preview || tail}${preview && tail ? `  · ${tail}` : ''}`}</Text>
            )}
          </Box>
        )
      })}
      {hub.problems().map((problem, index) => (
        <Text key={`problem-${index}`} color="red" wrap="wrap">{problem}</Text>
      ))}
    </Box>
  )
}
