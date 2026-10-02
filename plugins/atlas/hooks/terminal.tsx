import type { ClientModule } from 'claude-code'

type Size = { columns: number; rows: number }

// Lies over the editor's picture and hands the hooks module what the person
// does there: its size as laid out, every key while it has the focus (a click
// gives it; Escape returns it to the prompt), and the pointer in cells.
const Terminal: ClientModule<null, Size> = (_props, surface) => {
  if (surface.state === undefined) {
    surface.onKey(e => surface.post({ kind: 'key', ...e }))
    surface.onPointer(e => {
      // A move matters only as a drag: micro selects text with it.
      if (e.type === 'enter' || e.type === 'leave' || (e.type === 'move' && e.button === undefined)) return
      surface.post({ kind: 'pointer', type: e.type, x: e.x, y: e.y, button: e.button ?? 'left' })
    })
  }
  const { columns, rows } = surface
  if (columns > 0 && (surface.state?.columns !== columns || surface.state?.rows !== rows)) {
    surface.post({ kind: 'size', columns, rows })
    surface.setState({ columns, rows })
  }
  const { Box } = surface.elements

  return <Box width={columns} height={rows} />
}

export default Terminal
