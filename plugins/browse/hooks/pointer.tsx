import type { ClientModule } from 'claude-code'

type Size = { columns: number; rows: number }

// Lies over the page's picture and hands the hooks module what the person
// does there: its size as laid out, a click as a fraction of the view, then
// every key while it has the focus (the click gives it; Escape returns it).
const Pointer: ClientModule<null, Size> = (_props, surface) => {
  if (surface.state === undefined) {
    surface.onPointer(e => {
      if (e.type !== 'down' || e.button !== 'left' || surface.columns === 0) return
      surface.post({
        kind: 'click',
        x: (e.fine?.x ?? e.x + 0.5) / surface.columns,
        y: (e.fine?.y ?? e.y + 0.5) / surface.rows,
      })
    })
    surface.onKey(e => surface.post({ kind: 'key', ...e }))
  }
  const { columns, rows } = surface
  if (columns > 0 && (surface.state?.columns !== columns || surface.state?.rows !== rows)) {
    surface.post({ kind: 'size', columns, rows })
    surface.setState({ columns, rows })
  }
  const { Box } = surface.elements

  return <Box width={columns} height={rows} />
}

export default Pointer
