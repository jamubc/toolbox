// The globe: an orthographic view of the land mask with the night side shaded from the real
// time, great-circle arcs that rise off the surface, and the home dot. It draws into `Pixels`
// at any size: the half-block Raster uses one pixel per half cell, the Image many more.

import { Pixels, dim, mix } from './canvas'
import { isLand } from './land'

export type LatLon = { lat: number; lon: number }

export type Arc = {
  from: LatLon
  to: LatLon
  color: number
  /** 0 to 1: how bright the arc is drawn (fading with age). */
  strength: number
  /** 0 to 1: how far from `from` the arc has been drawn (its head travels on a new connection). */
  progress: number
  /** 0 to 1: a pulse travelling along the arc while bytes flow; below 0 for none. */
  pulse: number
  /** 1 to 3 pixels. */
  thickness: number
  /** Drawn as dashes: an inbound connection in observe-all mode, or a blocked attempt. */
  isDashed: boolean
  isSelected: boolean
}

export type Dot = LatLon & { color: number; /** 0 to 1, the ring's expansion; below 0 for none. */ ring: number }

export type Scene = {
  width: number
  height: number
  center: LatLon
  /** ms since the epoch, for the terminator and the animations. */
  time: number
  home: LatLon | null
  arcs: readonly Arc[]
  dots: readonly Dot[]
  /** Quantize the shading to a few levels, for a Raster's palette budget. */
  isQuantized: boolean
  /** Draw a faint graticule. */
  hasGrid: boolean
}

export const OUTBOUND = 0xffa726
export const INBOUND = 0x4dd0e1
export const HOME = 0xff3b30
export const BLOCKED = 0xff5252
export const SELECTED = 0xffffff

/** Distinct colors for sessions in observe-all mode. */
export const SESSION_COLORS = [0xffa726, 0x4dd0e1, 0xba68c8, 0x81c784, 0xf06292, 0xfff176, 0x4fc3f7, 0xffab91, 0xa1887f, 0x90a4ae]

const OCEAN_DAY = 0x1b4f7a
const OCEAN_NIGHT = 0x07131f
const LAND_DAY = 0x4c9a52
const LAND_NIGHT = 0x1a2e1f
const GRID = 0x2a6a95
const LIMB = 0x6fa8d6

const RAD = Math.PI / 180

/** Where the sun is overhead at `time`: declination from the day of the year, longitude from the hour. */
export function subsolarPoint(time: number): LatLon {
  const d = new Date(time)
  const start = Date.UTC(d.getUTCFullYear(), 0, 0)
  const day = (time - start) / 86400000
  const lat = -23.44 * Math.cos((2 * Math.PI * (day + 10)) / 365.25)
  const hours = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600
  // The equation of time, to a few minutes
  const b = (2 * Math.PI * (day - 81)) / 365
  const eot = 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b)
  let lon = -15 * (hours - 12 + eot / 60)
  lon = ((lon + 540) % 360) - 180
  return { lat, lon }
}

/** Unit vector of a place. */
const toVector = (p: LatLon): [number, number, number] => {
  const lat = p.lat * RAD
  const lon = p.lon * RAD
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)]
}

/** Projects a place: screen x, y (pixels) and `depth`, the cosine of its angle from the view center. */
export function project(scene: Scene, p: LatLon, lift = 0): { x: number; y: number; depth: number } {
  const r = radiusOf(scene)
  const cx = scene.width / 2
  const cy = scene.height / 2
  const lat = p.lat * RAD
  const lon = p.lon * RAD
  const lat0 = scene.center.lat * RAD
  const dLon = lon - scene.center.lon * RAD
  const x = Math.cos(lat) * Math.sin(dLon)
  const y = Math.cos(lat0) * Math.sin(lat) - Math.sin(lat0) * Math.cos(lat) * Math.cos(dLon)
  const depth = Math.sin(lat0) * Math.sin(lat) + Math.cos(lat0) * Math.cos(lat) * Math.cos(dLon)
  return { x: cx + x * r * (1 + lift), y: cy - y * r * (1 + lift), depth }
}

export const radiusOf = (scene: Scene) => Math.min(scene.width / 2, scene.height / 2) - 0.5

/** Points along the great circle from `a` to `b`, `n` of them including both ends. */
export function greatCircle(a: LatLon, b: LatLon, n: number): LatLon[] {
  const va = toVector(a)
  const vb = toVector(b)
  const dot = Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]))
  const omega = Math.acos(dot)
  const out: LatLon[] = []
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1)
    let v: [number, number, number]
    if (omega < 1e-6) v = va
    else {
      const s0 = Math.sin((1 - t) * omega) / Math.sin(omega)
      const s1 = Math.sin(t * omega) / Math.sin(omega)
      v = [va[0] * s0 + vb[0] * s1, va[1] * s0 + vb[1] * s1, va[2] * s0 + vb[2] * s1]
    }
    const len = Math.hypot(v[0], v[1], v[2]) || 1
    out.push({ lat: Math.asin(v[2] / len) / RAD, lon: Math.atan2(v[1], v[0]) / RAD })
  }
  return out
}

const quantize = (t: number, levels: number) => Math.round(t * (levels - 1)) / (levels - 1)

/** The sphere: land and sea, lit from the sun's side, with the limb and the grid. */
function surface(scene: Scene, px: Pixels): void {
  const r = radiusOf(scene)
  const cx = scene.width / 2
  const cy = scene.height / 2
  const lat0 = scene.center.lat * RAD
  const lon0 = scene.center.lon * RAD
  const sun = toVector(subsolarPoint(scene.time))
  for (let y = 0; y < scene.height; y++) {
    for (let x = 0; x < scene.width; x++) {
      const X = (x + 0.5 - cx) / r
      const Y = (cy - (y + 0.5)) / r
      const rho2 = X * X + Y * Y
      if (rho2 > 1) continue
      const rho = Math.sqrt(rho2)
      const c = Math.asin(Math.min(1, rho))
      const cosc = Math.cos(c)
      const sinc = Math.sin(c)
      const lat = rho < 1e-9 ? lat0 : Math.asin(cosc * Math.sin(lat0) + (Y * sinc * Math.cos(lat0)) / rho)
      const lon = rho < 1e-9 ? lon0 : lon0 + Math.atan2(X * sinc, rho * Math.cos(lat0) * cosc - Y * sinc * Math.sin(lat0))
      const latD = lat / RAD
      const lonD = ((lon / RAD + 540) % 360) - 180
      const land = isLand(latD, lonD)
      const n = toVector({ lat: latD, lon: lonD })
      const light = n[0] * sun[0] + n[1] * sun[1] + n[2] * sun[2]
      let day = Math.max(0, Math.min(1, light * 4 + 0.5)) // a soft terminator
      if (scene.isQuantized) day = quantize(day, 5)
      let color = land ? mix(LAND_NIGHT, LAND_DAY, day) : mix(OCEAN_NIGHT, OCEAN_DAY, day)
      if (scene.hasGrid && !land) {
        const gLat = Math.abs(((latD % 30) + 30) % 30)
        const gLon = Math.abs(((lonD % 30) + 30) % 30)
        const tol = 90 / r
        if (gLat < tol || gLat > 30 - tol || gLon < tol / Math.max(0.2, Math.cos(lat)) || gLon > 30 - tol / Math.max(0.2, Math.cos(lat))) {
          color = mix(color, GRID, scene.isQuantized ? 0.5 : 0.35)
        }
      }
      if (rho > 0.96) color = mix(color, LIMB, scene.isQuantized ? 0.5 : (rho - 0.96) / 0.04 * 0.6)
      px.set(x, y, color)
    }
  }
}

function drawArc(scene: Scene, px: Pixels, arc: Arc): void {
  const distance = Math.acos(
    Math.max(-1, Math.min(1, toVector(arc.from).reduce((s, v, i) => s + v * toVector(arc.to)[i]!, 0))),
  )
  const r = radiusOf(scene)
  const n = Math.max(8, Math.ceil((distance * r) / 2))
  const points = greatCircle(arc.from, arc.to, n)
  const altitude = 0.04 + 0.22 * Math.min(1, distance / Math.PI)
  const color = arc.isSelected ? SELECTED : dim(arc.color, 0.25 + 0.75 * arc.strength)
  const drawn = Math.max(1, Math.round(arc.progress * (n - 1)))
  let prev: { x: number; y: number; depth: number } | null = null
  for (let i = 0; i <= drawn && i < n; i++) {
    const t = i / (n - 1)
    const lift = altitude * Math.sin(Math.PI * t)
    const at = project(scene, points[i]!, lift)
    const isVisible = at.depth + lift * 1.2 > 0
    if (prev && isVisible && (!arc.isDashed || i % 4 < 2)) {
      px.line(prev.x, prev.y, at.x, at.y, color, arc.thickness)
    }
    prev = isVisible ? at : null
  }
  if (arc.progress < 1 && prev) {
    px.set(prev.x, prev.y, SELECTED)
    px.set(prev.x + 1, prev.y, color)
    px.set(prev.x - 1, prev.y, color)
  }
  if (arc.pulse >= 0) {
    const i = Math.round(arc.pulse * (n - 1))
    const lift = altitude * Math.sin(Math.PI * (i / (n - 1)))
    const at = project(scene, points[i]!, lift)
    if (at.depth + lift * 1.2 > 0) {
      px.set(at.x, at.y, SELECTED)
      px.set(at.x + 1, at.y, mix(color, SELECTED, 0.5))
      px.set(at.x - 1, at.y, mix(color, SELECTED, 0.5))
    }
  }
}

function drawDot(scene: Scene, px: Pixels, dot: Dot): void {
  const at = project(scene, dot)
  if (at.depth < -0.02) return
  const r = radiusOf(scene)
  const size = r >= 60 ? 2 : 1
  for (let dx = -size; dx <= size; dx++) for (let dy = -size; dy <= size; dy++) if (Math.abs(dx) + Math.abs(dy) <= size) px.set(at.x + dx, at.y + dy, dot.color)
  if (dot.ring >= 0) {
    const ringR = size + 1 + dot.ring * Math.max(3, r / 12)
    const color = dim(dot.color, 1 - dot.ring)
    const steps = Math.max(12, Math.ceil(ringR * 6))
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * 2 * Math.PI
      px.set(at.x + ringR * Math.cos(a), at.y + ringR * Math.sin(a), color)
    }
  }
}

/** Draws the scene: the sphere, then arcs back to front, then the dots. */
export function render(scene: Scene): Pixels {
  const px = new Pixels(scene.width, scene.height)
  surface(scene, px)
  const ordered = [...scene.arcs].sort((a, b) => Number(a.isSelected) - Number(b.isSelected) || a.strength - b.strength)
  for (const arc of ordered) drawArc(scene, px, arc)
  for (const dot of scene.dots) drawDot(scene, px, dot)
  if (scene.home) drawDot(scene, px, { ...scene.home, color: HOME, ring: ((scene.time % 2000) / 2000) })
  return px
}
