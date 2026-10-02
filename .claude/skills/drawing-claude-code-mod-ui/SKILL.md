---
name: drawing-claude-code-mod-ui
description: Use when writing or changing what a Claude Code mod draws (a ui.render hook): a pane, the band above the prompt, tabs, list rows, buttons, text fields, colors, shading, Raster cell drawings, pictures, animation with ui.blit, resizing, or slow redraws. Paste-ready snippets from the toolbox mods atlas, browse, channel, instantnotes and redline.
---

# Mod UI cookbook

Elements come from `$.ui.resolve(e)`. JSX compiles to them. API details: `plugin-authoring`.

**These are starting points, not house style.** The visual language for these mods (icons, glyphs, colors, pixel versus cell rendering, density, sizes) is not settled. Every number, glyph and color below is what one mod happened to use. When the person asks for a look, build that look; when nothing is asked, try alternatives and show them. Check the build's types (`.claude-plugin/types/claude-code/index.d.ts`, grep `Props = {`) for props this page does not show: the element set grows.

## Every element, by surface

| Element | Terminal | Desktop | Use it for |
| --- | :-: | :-: | --- |
| `Box`, `Text`, `Button`, `Link`, `Code`, `Markdown` | ✓ | ✓ | layout, text, actions, links, code and diffs, rich text |
| `Input`, `Select` | ✓ | ✓ | typing, choosing (not on mobile) |
| `Client` | ✓ | ✓ | a region you draw yourself, with live pointer and keys |
| `Raster` | ✓ | | a grid of colored character cells |
| `Image` | ✓ | | real pixels (kitty graphics protocol terminals) |
| `Svg` | | ✓ | vector drawings, charts, icons |

You can also redraw Claude Code's own parts: `Spinner`, `ToolUse`, `ToolResult`, `UserMessage`, `AssistantMessage`, `PromptHint`, `AskUserQuestion` and more (see "Restyle Claude Code itself" below).

## Pane

```tsx
on('command.run', { command: 'chat' }, async $ => {
  await $.ui.open({ id: 'chat', title: 'Chats', focus: true })   // never pass `false`: omit the field
  return {}
})
on('ui.render', { component: 'Pane', requestId: 'chat' }, async ($, e) => {
  const { Box, Text, Button } = $.ui.resolve(e)
  const width = e.props.bodyColumns          // draw to this, not the viewport
  const height = e.props.scroll.bodyRows     // rows the pane shows
  return <Box flexDirection="column"><Text bold>Chats</Text></Box>
})
```

Register the command with `immediate: true` so it runs while Claude works.

## Band above the prompt

```tsx
on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
  if (e.props.hasSurvey) return next(e)       // nothing to show: pass on
  const { Text } = $.ui.resolve(e)
  return <Text dimColor>3 sessions working</Text>
})
```

## Rich text, code, links

```tsx
<Markdown key="body" text={markdown} pressableLinks={['https://example.com']} onLinkPress={link => void go(link)} />
<Code source={text} language="ts" startLine={1} />
<Code source={unifiedDiff} format="diff" />
<Link href="https://example.com" label="docs" />
```

## Text, color, emphasis

```tsx
<Text color="red">named: red green yellow blue magenta cyan white gray</Text>
<Text color="#ff875f">any hex</Text>
<Text backgroundColor="#303030" color="#eeeeee"> chip </Text>
<Text bold inverse> selected </Text>
<Text dimColor>secondary</Text>
<Text wrap="wrap">long text wraps</Text>
<Text wrap="truncate-end">long text cuts with …</Text>
<Text>plain <Text bold color="cyan">nested</Text> spans</Text>
```

A number to hex: `` const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}` ``

## Layout

```tsx
<Box flexDirection="column" gap={1} paddingX={1}>
  <Box gap={1} flexWrap="wrap">{/* a row that wraps when narrow */}</Box>
  <Box borderStyle="round" borderColor="gray" paddingX={1}>{/* a card */}</Box>
  <Box flexGrow={1} />{/* pushes what follows to the far edge */}
</Box>
```

## Hover

```tsx
<Box key="row-42" hover={{ backgroundColor: '#2a2a2a' }}>{/* lights while the pointer is over it */}</Box>
<Text hover={{ scope: 'msg-42', underline: true }}>linked parts light together</Text>
```

## Buttons

```tsx
<Button key="open-42" plain label="📎 photo.jpg" onPress={() => void open(42)} />   // channel's choice: the item itself is pressable
<Button key="copy-42" plain dimColor label="copy" onPress={() => void copy(42)} />  // secondary
<Button key="save" variant="primary" label="Save" hotkey="s" onPress={save} />
```

- `key` must be stable and unique in the tree: tests press by it.
- A hotkey fires on its key while the pane has focus, so it competes with typing in an `Input`. Choose hotkeys per view.

## Tabs

One way (channel's): the selected tab as inverse text, the rest as buttons. Underlines, colors, `Select`, or a `Client` strip all work too.

```tsx
<Box gap={1} flexWrap="wrap">
  {tabs.map(tab => tab.isSelected
    ? <Text key={`tab-${tab.id}`} bold inverse>{` ${tab.label} `}</Text>
    : <Button key={`tab-${tab.id}`} plain label={tab.label} hotkey={tab.label[0]?.toLowerCase()} onPress={() => select(tab.id)} />)}
</Box>
```

## List rows

```tsx
{rows.slice(0, 9).map((row, i) => (
  <Button key={`open-${row.id}`} plain hotkey={String(i + 1)}
    label={`${row.unread ? '● ' : '  '}${clip(row.name, width - 12)}${row.unread ? `  ${row.unread} new` : ''}`}
    onPress={() => void open(row.id)} />
))}
```

```ts
const clip = (text: string, width: number) => (text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`)
```

## Text field

```tsx
const Field = 'Input' in elements ? elements.Input : undefined   // mobile has none
{Field && <Field key="reply" label="> " placeholder="Message" value={draft} submitLabel="send"
  autoFocus onSubmit={text => void send(text)} />}
```

Prefill with `value`. After a click the keys stay with the prompt: call `$.ui.open({ id, focus: true })` again to hand them to an `autoFocus` field.

## Dropdown

```tsx
<Select key="model" label="Model" value={current} options={[{ value: 'a', label: 'A' }]} onSelect={v => void pick(v)} />
```

## Status, toast, clipboard

```ts
$.ui.status('iMessage 2 new')      // undefined clears it
$.ui.toast('Ana: lunch?')          // channel folds bursts and limits each chat to one per 10 s
await $.ui.copy({ text: path })
await $.prompt.fill({ text: `${path} `, mode: 'insert' })   // into the person's prompt box, as a draft
```

## Feedback lines

```tsx
{isLoading && <Text dimColor>Loading…</Text>}
{problem && <Text color="red">{problem}</Text>}
<Text color="yellow">{setup.summary}</Text>
{setup.steps.map((step, i) => <Text key={`step-${i}`}>{`${i + 1}. ${step}`}</Text>)}
<Text key={`note-${count}`} dimColor>{note}</Text>          {/* a new key re-announces it */}
```

## Redraw

```ts
// State in $.state: readers redraw themselves, and it survives a hot reload.
const count = atom({ plugin: 'my-mod', key: 'count' } as const, 0)
const n = await read($, count)                 // in ui.render
await update($, count, n => n + 1)             // in a handler; never while drawing

// Private data (anything a person wrote): module variable + explicit redraw.
$.ui.invalidate('ui.render')
```

## Draw with cells (shapes, gauges, shading)

A `Raster` is a grid of cells: `[codePoint, foreground, background]` per cell, colors `0xRRGGBB`.

```ts
const DEFAULT = 0x01000000                     // the terminal's own color
const cells = new Uint32Array(rows * cols * 3)
const put = (r: number, c: number, ch: string, fg: number, bg = DEFAULT) =>
  cells.set([ch.codePointAt(0)!, fg, bg], (r * cols + c) * 3)
const encode = () => new Uint8Array(cells.buffer).toBase64()
```

```tsx
<Raster key="gauge" columns={cols} rows={rows} cells={encode()} />
```

Glyphs are an open choice: any Unicode the terminal font has works, including emoji, symbols, box drawing, block elements, sextants (`🬀`…`🬻`, 2×3 per cell), braille (2×4), and Nerd Font icons if the person uses one. A few to start from:

```ts
put(r, c, ' ', DEFAULT, 0x3a86ff)              // a solid block: space on a background
put(r, c, '▀', top, bottom)                    // two pixels in one cell: fg is the top half
'░▒▓█'                                         // 25 / 50 / 75 / 100 % shade
'▁▂▃▄▅▆▇█'                                     // a bar or sparkline, eighths of a cell
'╭─╮│╰╯'  '┌─┐│└┘'                             // rounded and square frames
'⠁⠂⠄⡀⢀⠠⠐⠈'                                     // braille: 2×4 dots per cell for fine lines

// A gradient between two colors, t from 0 to 1.
const mix = (a: number, b: number, t: number) =>
  [16, 8, 0].reduce((out, s) => out | (Math.round(((a >> s) & 255) + (((b >> s) & 255) - ((a >> s) & 255)) * t) << s), 0)
```

Full canvas class: `plugins/redline/hooks/canvas.ts`. `Raster` is terminal only. `e.surface` does not narrow the element table for TypeScript: check the element itself.

```tsx
const elements = $.ui.resolve(e)
if (!('Raster' in elements)) return <elements.Text>…</elements.Text>
const { Raster, Image, Client, Select } = elements
```

## Animate

```ts
// Repaint the mounted Raster directly: no render pass, up to 30 fps.
$.clock.every(100, () => void $.ui.blit({ requestId: 'gauge-pane', key: 'gauge', cells: frame() }).catch(() => {}))
```

`invalidate` in a loop also animates, but re-runs the whole render hook each frame; `blit` repaints one element.

## Draw your own region (Client)

A `Client` is a module of yours that draws a region and gets the pointer and keys directly, on both terminal and desktop. Use it for custom widgets the element set lacks.

```tsx
<Client key="canvas" module="./canvas.tsx" props={{ points }} width={cols} height={rows} />
```

```tsx
// canvas.tsx
import type { ClientModule } from 'claude-code'

const Canvas: ClientModule<{ points: number[] }, { hover: number }> = (props, surface) => {
  if (surface.state === undefined) {                         // first draw: subscribe once
    surface.onPointer(e => surface.setState({ hover: e.x }))  // redraws this region only
    surface.onKey(e => surface.post({ kind: 'key', ...e }))   // reaches ui.message in the hooks module
  }
  const { Box, Text } = surface.elements
  return <Box width={surface.columns} height={surface.rows}><Text>{`x ${surface.state?.hover ?? '-'}`}</Text></Box>
}
export default Canvas
```

`surface` also has `every(ms, fn)` for a local animation loop.

`module` must be a string literal. Examples in use: `plugins/browse/hooks/pointer.tsx`, `plugins/atlas/hooks/terminal.tsx`.

## Vector drawings (desktop)

```tsx
{'Svg' in elements && <elements.Svg source={svgText} alt="usage chart" width={320} height={120} />}
```

## Show a picture

Pick the method by what the person wants and where it runs: real pixels, cells, vector, or the system's own viewer (`open`). The sizes below are one mod's choice, not a rule; go sharper, smaller, or different formats as needed.

```ts
// Known to draw real pixels: kitty and Ghostty, not through tmux or ssh. Other terminals may support it: test and widen this check.
const term = (await $.env.get('TERM')) ?? ''
const program = ((await $.env.get('TERM_PROGRAM')) ?? '').toLowerCase()
const isRelayed = (await $.env.get('TMUX')) !== undefined || (await $.env.get('SSH_CONNECTION')) !== undefined
const hasPixels = !isRelayed && (term.includes('kitty') || term.includes('ghostty') || program === 'ghostty')
```

```tsx
// Other sources Image takes: { png } base64, { rgba, width, height } base64, { shm, format, width, height } for streaming frames.
// Pixels from a PNG file the terminal reads itself: nothing held in memory.
await $.process.run(['/usr/bin/sips', '-s', 'format', 'png', '-Z', '1600', source, '--out', file])
<Image key="pic" source={{ file, format: 'png', generation }} columns={box.columns} rows={box.rows} alt={name} />

// Anywhere else: a 200 px BMP, decoded and packed into half-block cells.
await $.process.run(['/usr/bin/sips', '-s', 'format', 'bmp', '-Z', '200', source, '--out', file])
const bitmap = decodeBmp(Uint8Array.fromBase64((await $.fs.read(file, { as: 'bytes' })).base64))
<Raster key="pic" columns={box.columns} rows={box.rows} cells={toCells(bitmap, box.columns, box.rows)} />
```

`decodeBmp`, `toCells` (averages the pixels each half-cell covers), `cellsOf` (the same cells encoded once per size), `fit` (keeps the shape; a cell is twice as tall as wide): `plugins/channel/hooks/ui/picture.ts`. Bump `generation` when a file path is reused. To learn whether the terminal drew an `Image` or its alt text, `$.ui.blit` the same source again a moment later: a `deny` that is not about mounting means fall back to cells (channel's `probe`, browse's frames).

## Keys and pointer over a drawing

```tsx
<Box>
  <Raster key="view" columns={cols} rows={rows} cells={cells} />
  <Client key="pointer" module="./pointer.tsx" width={cols} height={rows} />
</Box>
```

```ts
on('ui.message', { requestId: PANE }, async ($, e) => { /* e.data: what the Client posted */ return {} })
on('ui.scroll', { requestId: PANE }, async ($, e) => { /* e.by rows: scroll your content, not the pane */ })
```

Overlay modules to copy: `plugins/browse/hooks/pointer.tsx`, `plugins/atlas/hooks/terminal.tsx`. Ctrl+C, Ctrl+Z and Escape never reach a `Client`: add buttons for them.

## Resize

The numbers here are one mod's tuning; pick your own.

```ts
const isNarrow = width < 48                      // shorten labels below this
const picture = { columns: Math.min(width - 2, 80), rows: Math.max(4, Math.min(24, Math.floor(height * 0.4))) }
```

- `flexWrap="wrap"` on every button row, `clip()` on every name.
- A width change redraws. A height-only change does not: it shows on the next redraw.

## Restyle Claude Code itself

```tsx
// Change a detail and keep Claude Code's drawing.
on('ui.render', { component: 'Spinner' }, ($, e, next) => next({ ...e, props: { ...e.props, suffix: ' · 3 chats new' } }))
// Replace it: return your own tree and do not call next.
on('ui.render', { component: 'ToolResult' }, async ($, e, next) => (e.props.tool === 'Read' ? myView($, e) : next(e)))
```

Sites: `UserMessage`, `AssistantMessage`, `ToolUse`, `ToolResult`, `ToolGroup`, `CommandOutput`, `AskUserQuestion`, `Spinner`, `ToolProgress`, `TurnDuration`, `InfoNotice`, `SessionMode`, `PromptHint`. The permission prompt is not one.

## More of `$.ui` (see the types for each)

`ask` (a question dialog), `notice` (a transcript line), `scroll({ to: { key } })` (bring a row into view), `focus`, `close`, `log`. `$.ui.open` also takes `rows` and `columns`; the band's `e.props.maxRows` caps its height. Mobile and VS Code have their own element tables: mobile has `Svg` but no `Input`, `Select` or `Client`.

## Make it faster

| Slow | Options |
| --- | --- |
| Re-rendering to animate | `$.ui.blit` on `$.clock.every` |
| Big picture bytes in memory | PNG file source; the terminal reads it |
| Encoding the same cells every draw | Cache the base64 by size (`Map<string, string>`; channel keeps one per bitmap in a `WeakMap`) |
| Drawing rows nobody sees | Draw only what fits `bodyRows`; a pane holds about 100,000 characters, a `Text` 10,000 |
| `invalidate` per message | Once per batch; redraws are throttled to 10 a second anyway |
| Work at draw time | Compute in handlers, read in `ui.render` |
| Polling while hidden | `(await $.ui.panes()).some(p => p.id === PANE && p.isShown)` and slow down |

## Refused by the engine

These are the engine's rules, not choices. Everything above them is open.

```ts
store: $.store                       // ✗ a noun passed as a value
store: { get: key => $.store.get(key) }   // ✓
$.env.get(name)                      // ✗ must be a literal: $.env.get('HOME')
await import('./x')                  // ✗ static imports only
setTimeout(fn, 100)                  // ✗ $.clock.after(100, fn)
<Link href="file:///tmp/a.png" />    // ✗ https only: open files with a Button that runs `open`
$.ui.open({ id, focus: false })      // ✗ omit the field
```

## Test it

```ts
test('a press opens the chat', async ($, on) => {
  on('process.run', (_$, e) => ({ value: answer(e.argv) }))      // answer every call the mod makes
  const clock = mock.clock(on, { now: 0 })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'my-mod', surface, component: 'Pane', props, requestId: 'chat' })
    await ui.press({ key: 'open-42' })
    expect(await ui.find({ text: /hello/ })).toBeDefined()
    await ui.unmount()
  }
})
```

Run a dev copy with an absolute path: `claude --plugin-dir /abs/path/to/mod`. Disable an installed copy of the same name first, or it draws instead.
