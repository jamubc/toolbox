import { ALL } from '../core/hub'
import type { Hub } from '../core/hub'
import { clip } from './format'
import type { Elements } from './format'

// The first view: a tab per service, then that tab's conversations.
export function ListView(hub: Hub, { Box, Button, Text }: Elements, columns: number) {
  const tabs = hub.tabs()
  const current = tabs.find(one => one.isSelected)
  const rows = hub.rows()
  const { notifier, inbox } = hub
  const target = notifier.target()

  return (
    <Box flexDirection="column">
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
      {target && (
        <Button key="jump" plain label={clip(`↪ new in ${inbox.nameOf(target)}`, columns)} hotkey="n" onPress={() => void hub.jump()} />
      )}
      {current?.health.state === 'setup' && (
        <Box key="setup" flexDirection="column">
          <Text color="yellow">{current.health.summary}</Text>
          {current.health.steps.map((step, index) => (
            <Text key={`step-${index}`}>{`${index + 1}. ${step}`}</Text>
          ))}
        </Box>
      )}
      {current?.health.state === 'ready' && rows.length === 0 && hub.problems().length === 0 && (
        <Text dimColor>Loading conversations…</Text>
      )}
      {rows.map((one, index) => {
        const unread = inbox.unread(one.ref)
        const service = hub.view.tab === ALL ? `${hub.labelOf(one.ref.service)} · ` : ''
        const count = unread > 0 ? `  ${unread} new` : ''
        // The name gives way to the count, and leaves room for the hotkey.
        const name = clip(`${service}${one.name}`, Math.max(8, columns - count.length - 6))

        return (
          <Button
            key={`open-${one.ref.service}-${one.id}`}
            plain
            label={`${unread > 0 ? '● ' : '  '}${name}${count}`}
            hotkey={String(index + 1)}
            onPress={() => void hub.open(one.ref)}
          />
        )
      })}
      {hub.problems().map((problem, index) => (
        <Text key={`problem-${index}`} color="red">{problem}</Text>
      ))}
    </Box>
  )
}
