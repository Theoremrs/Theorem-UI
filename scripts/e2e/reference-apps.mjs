// The two Apps the reference e2e builds, each made the way the plan's
// reference workflow says an agent makes one: references gathered for a
// purpose, the features that matter traced from them (agent-side, by
// scripts/e2e/reference/trace.py with the VTracer CLI), the traced numbers kept
// as the App's recipe, geometry generated from that recipe with Manifold in a
// Worker, and behaviour written in the same source.
//
// The guitar comes from a measured drawing of a guitar by Joseph Benedid
// (outline, sound hole, bracing, bridge, on a centimetre scale). It can also
// trace a drawing it is given, in the App, with imagetracerjs, and rebuild the
// body from that outline through the same recipe path.
//
// The 6502 comes from a die photo (where the blocks and the bonding pads are)
// and a package photo (the body's proportions, the pins, the colours).
//
// Nothing in either is Theorem-specific except the spatial parts and the
// `?worker` import (Vite's convention, which the App build follows).
import { readFileSync } from 'node:fs'
import path from 'node:path'

const here = path.join(import.meta.dirname, 'reference')
const guitar = JSON.parse(readFileSync(path.join(here, 'guitar.json'), 'utf8'))
const cpu = JSON.parse(readFileSync(path.join(here, 'cpu.json'), 'utf8'))
const json = (value) => JSON.stringify(value, null, 2)

const page = (files) => `<!doctype html>
<div id="root"></div>
${Object.entries(files)
  .map(([name, text]) => `<script type="text/theorem-source" data-path="${name}">${text}</script>`)
  .join('\n')}`

// What Manifold's worker hands back, and how the page turns it into three.js
// geometry. Both Apps share these lines, as an agent would copy them.
const MESH_TYPE = `/** A mesh as Manifold makes it, moved from the worker to the page. */
export interface Mesh {
  vertProperties: Float32Array
  triVerts: Uint32Array
  numProp: number
}`

const GEOMETRY_OF = `/** Manifold's mesh as three.js geometry. */
function geometryOf(mesh: Mesh): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  const vertices = new THREE.InterleavedBuffer(mesh.vertProperties, mesh.numProp)
  geometry.setAttribute('position', new THREE.InterleavedBufferAttribute(vertices, 3, 0))
  geometry.setIndex(new THREE.BufferAttribute(mesh.triVerts, 1))
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  return geometry
}`

const START_MANIFOLD = `// Manifold is started from the bytes of its own .wasm (bundled into the App).
const config = { locateFile: () => 'manifold.wasm', wasmBinary: wasmBytes }
const wasm: ManifoldToplevel = await Module(config)
wasm.setup()

/** Every Manifold and CrossSection lives in wasm memory until it is deleted. */
function scope<T>(make: (own: <O extends { delete(): void }>(object: O) => O) => T): T {
  const owned: Array<{ delete(): void }> = []
  try {
    return make((object) => (owned.push(object), object))
  } finally {
    for (const object of owned) object.delete()
  }
}

const meshOf = (solid: Manifold): Mesh => {
  const mesh = solid.getMesh()
  return { vertProperties: mesh.vertProperties, triVerts: mesh.triVerts, numProp: mesh.numProp }
}

const buffersOf = (meshes: Record<string, Array<Mesh>>) =>
  Object.values(meshes).flatMap((list) => list.flatMap((mesh) => [mesh.vertProperties.buffer, mesh.triVerts.buffer]))`

// -- the guitar ------------------------------------------------------------

const neckJointWidth =
  Math.round((Math.hypot(guitar.neck_joint_closed.to[0] - guitar.neck_joint_closed.from[0], guitar.neck_joint_closed.to[1] - guitar.neck_joint_closed.from[1]) / guitar.scale.px_per_cm) * 100) / 100

const GUITAR_RECIPE = `// The guitar's recipe. Everything under \`traced\` was measured from the
// reference by scripts/e2e/reference/trace.py; everything under \`written\` was
// not, and says why it is what it is. One scene unit is 10 cm.

/** Where the numbers came from, and what the reference was gathered for. */
export const reference = ${json({
  ...guitar.reference,
  crop: 'the whole sheet; the scale from its ruler, the body from its largest outline',
  scale: guitar.scale,
  trace: 'VTracer 0.6.5 (polygon mode) on the outline, simplified until the fewest points still cover 99.5% of the traced area',
  attempts: guitar.attempts,
})} as const

/** Measured from the drawing, in centimetres: x across the body, y down from the neck joint. */
export const traced = {
  size: ${json(guitar.size_cm)},
  outline: ${JSON.stringify(guitar.outline)} as Array<[number, number]>,
  soundHole: { center: ${JSON.stringify(guitar.sound_hole.center)} as [number, number], radius: ${guitar.sound_hole.radius} },
  braces: ${JSON.stringify(guitar.braces.map((brace) => ({ kind: brace.kind, from: brace.from, to: brace.to, width: brace.width })))} as Array<{ kind: string; from: [number, number]; to: [number, number]; width: number }>,
  bridge: ${JSON.stringify(guitar.bridge)} as [[number, number], [number, number]],
  /** Across the outline where the neck meets it. */
  neckJointWidth: ${neckJointWidth},
}

/**
 * Not in the reference. The drawing is of the top, so depth, thicknesses and
 * heights are not in it; the strings' scale length is not marked either.
 * These are ordinary values for a nineteenth-century Spanish guitar.
 */
export const written = {
  note: 'depth, thicknesses, heights, neck and string spacing are written, not measured; wood colours are written, the reference is a line drawing',
  wood: { top: '#d8b87e', back: '#6e3b22', braces: '#e6cf98', bridge: '#3a2417', neck: '#b88a56', fretboard: '#2b2521' },
}

/** The named parameters the geometry is generated from, in centimetres. */
export const recipe = {
  length: traced.size.length,
  depth: 9.5,
  top: 0.25,
  ribs: 0.2,
  braceHeight: 1.1,
  braceWidth: 0.6,
  bridgeHeight: 0.9,
  scaleLength: 65,
  nutWidth: 5.2,
  neckThickness: 2.2,
  fretboard: 0.6,
  headLength: 17,
  headWidth: 7.4,
  saddleSpread: 5.8,
  nutSpread: 4.4,
}
export type Recipe = typeof recipe
export type Outline = Array<[number, number]>

/** A point of the drawing (cm, y down from the neck joint) in the scene, at the recipe's length. */
export const feature = (r: Recipe, [x, y]: [number, number]): [number, number] => {
  const f = r.length / traced.size.length
  return [(x * f) / 10, (r.length / 2 - y * f) / 10]
}

/** Where the saddle and the nut are along the drawing's y, in cm. */
export const stringEnds = (r: Recipe) => {
  const saddle = (traced.bridge[0][1] + traced.bridge[1][1]) / 2
  return { saddle, nut: saddle - r.scaleLength }
}

${MESH_TYPE}

export type Request =
  | { id: number; kind: 'build'; recipe: Recipe; outline: Outline }
  | { id: number; kind: 'trace'; bitmap: ImageBitmap; length: number }

export interface Built {
  id: number
  kind: 'built'
  meshes: Record<string, Array<Mesh>>
  manifoldMs: number
  inWorker: boolean
}

export interface Traced {
  id: number
  kind: 'traced'
  /** In cm, at the recipe's length: x across the body, y down from its top. */
  outline: Outline
  /** Width over length of what was traced. */
  ratio: number
  points: number
  pixels: [number, number]
  /** The rows kept as the body, top and bottom. */
  rows: [number, number]
  ms: number
  inWorker: boolean
}
`

const GUITAR_WORKER = `import ImageTracer, { type TracedPath } from 'imagetracerjs'
import Module from 'manifold-3d'
import type { Manifold, ManifoldToplevel } from 'manifold-3d'
import wasmBytes from 'manifold-3d/manifold.wasm'
import { feature, stringEnds, traced, type Built, type Mesh, type Outline, type Recipe, type Request, type Traced } from './recipe'

${START_MANIFOLD}

type Point = [number, number]

/** The guitar the recipe describes, around the outline given (the recipe's own or one traced). */
function build(r: Recipe, outline: Outline): Record<string, Array<Mesh>> {
  const { Manifold: Solid, CrossSection: Section } = wasm
  return scope((own) => {
    // The outline is scaled to the recipe's length. The hole, bracing and
    // bridge are the recipe's, placed by \`feature\`.
    const top = Math.min(...outline.map(([, y]) => y))
    const k = r.length / (Math.max(...outline.map(([, y]) => y)) - top)
    const at = ([x, y]: Point): Point => [(x * k) / 10, (r.length / 2 - (y - top) * k) / 10]
    const f = r.length / traced.size.length
    const place = (point: Point) => feature(r, point)
    const half = r.depth / 20
    const plate = r.top / 10

    const body = own(Section.ofPolygons([outline.map(at)], 'NonZero'))
    const [hx, hy] = place(traced.soundHole.center)
    const hole = own(own(Section.circle((traced.soundHole.radius * f) / 10, 96)).translate([hx, hy]))
    const soundboard = own(own(own(body.subtract(hole)).extrude(plate)).translate([0, 0, half - plate]))
    const back = own(own(body.extrude(plate)).translate([0, 0, -half]))
    const wall = own(body.subtract(own(body.offset(-r.ribs / 10, 'Round'))))
    const ribs = own(own(wall.extrude(2 * half - 2 * plate)).translate([0, 0, -half + plate]))

    // Bracing is glued under the top, each bar clipped to the outline.
    const within = own(own(body.extrude(2 * half)).translate([0, 0, -half]))
    const bars: Record<string, Array<Manifold>> = {}
    for (const brace of traced.braces) {
      const [x0, y0] = place(brace.from)
      const [x1, y1] = place(brace.to)
      const height = r.braceHeight / 10
      const bar = own(Solid.cube([Math.hypot(x1 - x0, y1 - y0), (Math.max(brace.width, r.braceWidth) * f) / 10, height], true))
      const turned = own(bar.rotate([0, 0, (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI]))
      const placed = own(turned.translate([(x0 + x1) / 2, (y0 + y1) / 2, half - plate - height / 2]))
      ;(bars[brace.kind] ??= []).push(own(placed.intersect(within)))
    }

    const [[bx0, by0], [bx1, by1]] = traced.bridge
    const [cx, cy] = place([(bx0 + bx1) / 2, (by0 + by1) / 2])
    const bridgeBlock = own(Solid.cube([((bx1 - bx0) * f) / 10, ((by1 - by0) * f) / 10, r.bridgeHeight / 10], true))
    const bridge = own(bridgeBlock.translate([cx, cy, half + r.bridgeHeight / 20]))

    // The neck runs from the joint to the nut, a scale length from the saddle;
    // the fretboard runs on over the top to just short of the sound hole.
    const { nut } = stringEnds(r)
    const joint = traced.neckJointWidth / 2
    const section = (points: Array<Point>) => own(Section.ofPolygons([points.map(place)], 'NonZero'))
    const neckShape = section([[-joint, 0.5], [joint, 0.5], [r.nutWidth / 2, nut], [-r.nutWidth / 2, nut]])
    const headShape = section([[-r.headWidth / 2, nut + 0.2], [r.headWidth / 2, nut + 0.2], [r.headWidth / 2.2, nut - r.headLength], [-r.headWidth / 2.2, nut - r.headLength]])
    const neckSolid = own(own(own(neckShape.add(headShape)).extrude(r.neckThickness / 10)).translate([0, 0, half - r.neckThickness / 10]))
    const boardEnd = traced.soundHole.center[1] - traced.soundHole.radius - 0.4
    const boardWidth = joint + (joint - r.nutWidth / 2) * (boardEnd / -nut)
    const boardShape = section([[-boardWidth, boardEnd], [boardWidth, boardEnd], [r.nutWidth / 2, nut], [-r.nutWidth / 2, nut]])
    const fretboard = own(own(boardShape.extrude(r.fretboard / 10)).translate([0, 0, half]))

    return {
      soundboard: [meshOf(soundboard)],
      ribs: [meshOf(ribs)],
      back: [meshOf(back)],
      bridge: [meshOf(bridge)],
      neck: [meshOf(neckSolid), meshOf(fretboard)],
      ...Object.fromEntries(Object.entries(bars).map(([kind, list]) => [kind, [meshOf(own(Solid.union(list)))]])),
    }
  })
}

/**
 * A drawing's body outline: the drawn line spanning the most of the sheet
 * that is not its frame (dense ornament can hold more ink than a thin outline,
 * so extent decides, not ink), filled row by row between its outermost pixels
 * (a guitar's outline crosses each row twice), then traced by imagetracerjs
 * and scaled to \`length\`.
 */
function trace(bitmap: ImageBitmap, length: number): Omit<Traced, 'id' | 'kind' | 'ms' | 'inWorker'> {
  // Large photographs are brought down to 1600 rows; a thin line drawn at
  // its own size is left alone, as scaling would break it into pieces.
  const height = Math.min(bitmap.height, 1600)
  const width = Math.round((bitmap.width * height) / bitmap.height)
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.fillStyle = '#fff'
  context.fillRect(0, 0, width, height)
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const pixels = context.getImageData(0, 0, width, height).data
  const ink = new Uint8Array(width * height)
  for (let index = 0; index < ink.length; index++)
    ink[index] = 0.299 * pixels[index * 4]! + 0.587 * pixels[index * 4 + 1]! + 0.114 * pixels[index * 4 + 2]! < 140 ? 1 : 0

  // Connected lines (8-neighbour), keeping the largest that is not the frame.
  const label = new Int32Array(width * height)
  const stack = new Int32Array(width * height)
  let best = { id: 0, extent: 0 }
  let next = 0
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || label[start]) continue
    const id = ++next
    let [x0, y0, x1, y1] = [width, height, 0, 0]
    let top = 0
    stack[top++] = start
    label[start] = id
    while (top) {
      const at = stack[--top]!
      const x = at % width
      const y = (at - x) / width
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const near = ny * width + nx
          if (ink[near] && !label[near]) {
            label[near] = id
            stack[top++] = near
          }
        }
    }
    const extent = (x1 - x0) * (y1 - y0)
    if (x1 - x0 < width * 0.9 && y1 - y0 < height * 0.9 && extent > best.extent) best = { id, extent }
  }

  // Each row's span; the body is the longest run of rows at least 35% as wide
  // as the widest (the neck's stub is narrower and drops out).
  const left = new Int32Array(height).fill(-1)
  const right = new Int32Array(height).fill(-1)
  for (let index = 0; index < label.length; index++) {
    if (label[index] !== best.id) continue
    const x = index % width
    const y = (index - x) / width
    if (left[y] === -1 || x < left[y]!) left[y] = x
    if (x > right[y]!) right[y] = x
  }
  const span = (y: number) => (left[y] === -1 ? 0 : right[y]! - left[y]!)
  let widest = 0
  for (let y = 0; y < height; y++) widest = Math.max(widest, span(y))
  let run: [number, number] = [0, -1]
  for (let y = 0, from = -1; y <= height; y++) {
    const wide = y < height && span(y) >= widest * 0.35
    if (wide && from < 0) from = y
    if (!wide && from >= 0) {
      if (y - 1 - from > run[1] - run[0]) run = [from, y - 1]
      from = -1
    }
  }
  const silhouette = new ImageData(width, height)
  silhouette.data.fill(255)
  for (let y = run[0]; y <= run[1]; y++)
    for (let x = left[y]!; x <= right[y]!; x++) silhouette.data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3)

  const result = ImageTracer.imagedataToTracedata(silhouette, {
    numberofcolors: 2,
    pal: [{ r: 0, g: 0, b: 0, a: 255 }, { r: 255, g: 255, b: 255, a: 255 }],
    colorsampling: 0,
    blurradius: 0,
    ltres: 1,
    qtres: 1,
    pathomit: 8,
  })
  const black = result.palette.findIndex((colour) => colour.r < 128)
  const area = (path: TracedPath) => (path.boundingbox[2] - path.boundingbox[0]) * (path.boundingbox[3] - path.boundingbox[1])
  const body = result.layers[black]!.filter((path) => !path.isholepath).sort((a, b) => area(b) - area(a))[0]!
  const points: Array<Point> = body.segments.flatMap((segment): Array<Point> =>
    segment.type === 'Q'
      ? [[segment.x1, segment.y1], [(segment.x1 + 2 * segment.x2 + segment.x3!) / 4, (segment.y1 + 2 * segment.y2 + segment.y3!) / 4]]
      : [[segment.x1, segment.y1]],
  )
  const [bx0, by0, bx1, by1] = body.boundingbox
  const scale = length / (by1 - by0)
  const middle = (bx0 + bx1) / 2
  const round = (n: number) => Math.round(n * 100) / 100
  return {
    outline: points.map(([x, y]): Point => [round((x - middle) * scale), round((y - by0) * scale)]),
    ratio: (bx1 - bx0) / (by1 - by0),
    points: points.length,
    pixels: [width, height],
    rows: run,
  }
}

self.onmessage = ({ data }: MessageEvent<Request>) => {
  const started = performance.now()
  const inWorker = typeof document === 'undefined'
  if (data.kind === 'trace') {
    const reply: Traced = { id: data.id, kind: 'traced', ...trace(data.bitmap, data.length), ms: performance.now() - started, inWorker }
    self.postMessage(reply)
    return
  }
  const meshes = build(data.recipe, data.outline)
  const reply: Built = { id: data.id, kind: 'built', meshes, manifoldMs: performance.now() - started, inWorker }
  // The arrays move to the page; nothing is copied.
  self.postMessage(reply, { transfer: buffersOf(meshes) })
}
self.postMessage('ready')
`

const GUITAR_MAIN = `import { mount, type Part } from '@theorem/spatial'
import * as THREE from 'three'
import workerUrl from './guitar.worker.ts?worker'
import { feature, recipe, reference, stringEnds, traced, written, type Built, type Mesh, type Outline, type Request, type Traced } from './recipe'

const worker = new Worker(workerUrl)
await new Promise((ready) => worker.addEventListener('message', ready, { once: true }))
const waiting = new Map<number, (reply: Built | Traced) => void>()
worker.onmessage = ({ data }: MessageEvent<Built | Traced>) => {
  waiting.get(data.id)?.(data)
  waiting.delete(data.id)
}
let asked = 0
const send = <T extends Built | Traced>(request: Request, transfer: Array<Transferable> = []) =>
  new Promise<T>((resolve) => {
    waiting.set(request.id, resolve as (reply: Built | Traced) => void)
    worker.postMessage(request, transfer)
  })
const build = (outline: Outline) => send<Built>({ id: ++asked, kind: 'build', recipe, outline })
const traceDrawing = (bitmap: ImageBitmap) => send<Traced>({ id: ++asked, kind: 'trace', bitmap, length: recipe.length }, [bitmap])

${GEOMETRY_OF}

// What each part is drawn from now, and every object drawn from it, so a
// rebuilt outline reaches the drawing (the view refits a part whose mesh
// changes, for any part with a \`show\`).
let current: Record<string, Array<THREE.BufferGeometry>> = {}
const drawn = new Map<string, Set<THREE.Group>>()
const adopt = (built: Built) => {
  const previous = current
  current = Object.fromEntries(Object.entries(built.meshes).map(([name, meshes]) => [name, meshes.map(geometryOf)]))
  for (const [name, groups] of drawn)
    for (const group of groups)
      group.children.forEach((child, index) => {
        if (child instanceof THREE.Mesh && current[name]?.[index]) child.geometry = current[name][index]
      })
  for (const list of Object.values(previous)) for (const geometry of list) geometry.dispose()
}
const woodOf = (name: string, colors: Array<string>) => {
  const group = new THREE.Group()
  ;(current[name] ?? []).forEach((geometry, index) =>
    group.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: colors[index] ?? colors[0], roughness: 0.7 }))),
  )
  drawn.set(name, (drawn.get(name) ?? new Set()).add(group))
  return group
}

const history: Array<{ outline: 'recipe' | 'traced'; manifoldMs: number; ms: number; inWorker: boolean; triangles: number }> = []
const traces: Array<Omit<Traced, 'outline'> & { file: string }> = []
let outline: Outline = traced.outline
const rebuild = async (next: Outline, from: 'recipe' | 'traced') => {
  const started = performance.now()
  const built = await build(next)
  outline = next
  adopt(built)
  history.push({
    outline: from,
    manifoldMs: built.manifoldMs,
    ms: performance.now() - started,
    inWorker: built.inWorker,
    triangles: Object.values(current).flat().reduce((sum, geometry) => sum + geometry.index!.count / 3, 0),
  })
}
await rebuild(traced.outline, 'recipe')

const wood = written.wood
const still = () => {}
const part = (id: string, label: string, about: string, colors: Array<string>, from = id, fromInside = false): Part => ({
  id,
  label,
  about,
  at: [0, 0, 0],
  form: () => {
    const group = woodOf(from, colors)
    // The bracing is glued under the top: turned about its length, the
    // inside faces the camera and the plate no longer hides it.
    if (fromInside) group.rotation.y = Math.PI
    return group
  },
  show: still,
})

const braceAbout: Record<string, string> = {
  'X brace': 'Two short bars crossing between the neck block and the first bar across.',
  'transverse bar': 'Bars across the grain, one each side of the sound hole.',
  'side bar': 'Short bars along the grain beside the sound hole.',
  strut: 'Two bars from the lower bar across toward the tail.',
}
const braceKinds = Object.keys(current).filter((name) => name in braceAbout)

const top: Part = {
  ...part('top', 'Soundboard', 'The top, from the traced outline less the sound hole. Open it for the bracing under it, traced from the dashed lines of the drawing.', [wood.top], 'soundboard'),
  inside: (m) => {
    m.part(part('plate', 'Top plate', 'The top seen from inside.', [wood.top], 'soundboard', true))
    for (const kind of braceKinds)
      m.part(part(kind.toLowerCase().replace(/ /g, '-'), kind.charAt(0).toUpperCase() + kind.slice(1) + (kind.endsWith('s') ? '' : 's'), braceAbout[kind]!, [wood.braces], kind, true))
  },
}

// The strings: the frequency of a stretched string, f = sqrt(T / mu) / 2L,
// with each string's mass per length (mu) taken so that it is in tune at the
// tension given. L is the scale length, shortened by each fret.
const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const open = { E2: 40, A2: 45, D3: 50, G3: 55, B3: 59, E4: 64 } as const
type StringName = keyof typeof open
const tuned = 70
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12)
const mu = (name: StringName) => tuned / (2 * (recipe.scaleLength / 100) * hz(open[name])) ** 2
const sounding = (name: StringName, fret: number, tension: number) => Math.sqrt(tension / mu(name)) / (2 * (recipe.scaleLength / 100) * 2 ** (-fret / 12))
const noteOf = (frequency: number) => {
  const midi = 69 + 12 * Math.log2(frequency / 440)
  const nearest = Math.round(midi)
  return { note: names[((nearest % 12) + 12) % 12]! + (Math.floor(nearest / 12) - 1), cents: Math.round((midi - nearest) * 100) }
}

const { saddle, nut } = stringEnds(recipe)
const half = recipe.depth / 20
const stringLine = (index: number) => {
  const across = (spread: number) => ((index - 2.5) / 5) * spread
  const [sx, sy] = feature(recipe, [across(recipe.saddleSpread), saddle])
  const [nx, ny] = feature(recipe, [across(recipe.nutSpread), nut])
  return { from: new THREE.Vector3(sx, sy, half + recipe.bridgeHeight / 10 + 0.02), to: new THREE.Vector3(nx, ny, half + recipe.fretboard / 10 + 0.04) }
}
const stringNames = Object.keys(open) as Array<StringName>
const stringsForm = () => {
  const group = new THREE.Group()
  stringNames.forEach((name, index) => {
    const { from, to } = stringLine(index)
    const geometry = new THREE.CylinderGeometry(0.004 + (5 - index) * 0.0012, 0.004 + (5 - index) * 0.0012, from.distanceTo(to), 6)
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#d9d4c7', roughness: 0.3, metalness: 0.4 }))
    mesh.name = name
    mesh.position.copy(from).add(to).multiplyScalar(0.5)
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize())
    group.add(mesh)
  })
  const marker = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 12), new THREE.MeshStandardMaterial({ color: '#b5462e' }))
  marker.name = 'fret'
  group.add(marker)
  return group
}

const strings: Part = {
  id: 'strings',
  label: 'Strings',
  about: 'Six strings over the written scale length. Pick a string, stop it at a fret and change its tension: the pitch follows from the string\\'s length, tension and mass.',
  at: [0, 0, 0],
  form: stringsForm,
  ports: { hz: 'out', note: 'out', cents: 'out' },
  state: { string: 'E4', fret: 0, tension: tuned },
  controls: {
    string: { kind: 'select', options: stringNames, label: 'string' },
    fret: { kind: 'range', min: 0, max: 12, step: 1, label: 'fret' },
    tension: { kind: 'range', min: 40, max: 110, step: 1, label: 'tension (N)' },
  },
  compute: (_inputs, state) => {
    const frequency = sounding(state.string as StringName, Number(state.fret), Number(state.tension))
    return { hz: Math.round(frequency * 100) / 100, ...noteOf(frequency) }
  },
  format: (value, port) => (port === 'hz' ? \`\${Number(value).toFixed(1)} Hz\` : port === 'cents' ? \`\${Number(value) > 0 ? '+' : ''}\${value} cents\` : String(value)),
  checks: [
    { name: 'the top string is E4 at the tension it was tuned to', state: { string: 'E4', fret: 0, tension: 70 }, expect: { hz: 329.63, note: 'E4', cents: 0 } },
    { name: 'the twelfth fret halves the length: an octave up', state: { string: 'E4', fret: 12, tension: 70 }, expect: { note: 'E5', cents: 0 } },
    { name: 'the fifth string stopped at the fifth fret sounds the open fourth', state: { string: 'A2', fret: 5, tension: 70 }, expect: { note: 'D3' } },
    { name: 'pitch goes as the square root of tension: a whole tone up needs it times 2^(1/3)', state: { string: 'E4', fret: 0, tension: 70 * 2 ** (1 / 3) }, expect: { note: 'F#4', cents: 0 } },
  ],
  show: (object, { state, activity }) => {
    const chosen = stringNames.indexOf(state.string as StringName)
    for (const child of object.children) {
      if (!(child instanceof THREE.Mesh)) continue
      const material = child.material as THREE.MeshStandardMaterial
      if (child.name === 'fret') {
        const { from, to } = stringLine(chosen)
        const fromNut = 1 - 2 ** (-Number(state.fret) / 12)
        child.position.copy(to).lerp(from, fromNut)
        child.visible = Number(state.fret) > 0
        continue
      }
      const on = child.name === state.string
      material.color.set(on ? '#b5462e' : '#d9d4c7')
      child.scale.set(on ? 1.6 + activity * 2 : 1, 1, on ? 1.6 + activity * 2 : 1)
    }
  },
}

// A drawing can be traced here and the body rebuilt from its outline. The
// controls sit outside the spatial view, above it.
const bar = document.createElement('div')
bar.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:8px 2px;font:13px/1.4 var(--theorem-font, system-ui);color:var(--theorem-ink-muted, inherit)'
const picker = document.createElement('label')
picker.textContent = 'Trace a drawing of a guitar: '
const input = document.createElement('input')
input.type = 'file'
input.accept = 'image/*'
picker.append(input)
const restore = document.createElement('button')
restore.textContent = 'Back to the measured outline'
restore.disabled = true
const status = document.createElement('span')
status.textContent = \`Outline traced from \${reference.credit}, \${reference.license}.\`
bar.append(picker, restore, status)
const root = document.getElementById('root')!
root.before(bar)

input.addEventListener('change', async () => {
  const file = input.files?.[0]
  if (!file) return
  status.textContent = \`Tracing \${file.name}…\`
  const started = performance.now()
  const result = await traceDrawing(await createImageBitmap(file))
  await rebuild(result.outline, 'traced')
  const { outline: points, ...rest } = result
  traces.push({ ...rest, ms: performance.now() - started, file: file.name })
  restore.disabled = false
  status.textContent = \`\${file.name}: \${points.length} points traced, width to length \${result.ratio.toFixed(3)} (the measured drawing: \${(traced.size.width / traced.size.length).toFixed(3)}).\`
})
restore.addEventListener('click', async () => {
  await rebuild(traced.outline, 'recipe')
  restore.disabled = true
  status.textContent = 'The measured outline.'
})

const model = mount(
  root,
  (m) => {
    m.part(top)
    m.part(part('ribs', 'Ribs', 'The sides, bent to the outline, at the written depth.', [wood.back]))
    m.part(part('back', 'Back', 'The back plate, the outline again.', [wood.back]))
    m.part(part('bridge', 'Bridge', 'Where the strings are tied; its footprint is traced from the drawing.', [wood.bridge]))
    m.part(part('neck', 'Neck', 'From the joint (its width traced) to the nut, a scale length from the saddle; the head and fretboard are written.', [wood.neck, wood.fretboard]))
    m.part(strings)
  },
  { title: 'A guitar from its measured drawing' },
)
Object.assign(window, { model, guitar: { history, traces, outline: () => outline, reference, drawn, current: () => current } })
`

// imagetracerjs ships no declarations, so the App declares the part it uses
// (from the library's README and source, version 1.2.6).
const IMAGETRACER_TYPES = `declare module 'imagetracerjs' {
  export interface Colour { r: number; g: number; b: number; a: number }
  /** A line (L) or a quadratic curve (Q) whose control point is x2, y2. */
  export interface Segment { type: 'L' | 'Q'; x1: number; y1: number; x2: number; y2: number; x3?: number; y3?: number }
  export interface TracedPath {
    segments: Array<Segment>
    /** [x0, y0, x1, y1] */
    boundingbox: [number, number, number, number]
    holechildren: Array<number>
    isholepath: boolean
  }
  export interface Tracedata { layers: Array<Array<TracedPath>>; palette: Array<Colour>; width: number; height: number }
  export interface Options {
    ltres?: number
    qtres?: number
    pathomit?: number
    rightangleenhance?: boolean
    colorsampling?: 0 | 1 | 2
    numberofcolors?: number
    mincolorratio?: number
    colorquantcycles?: number
    pal?: Array<Colour>
    blurradius?: number
    blurdelta?: number
  }
  const ImageTracer: {
    imagedataToTracedata(imgd: ImageData, options?: Options | string): Tracedata
    imagedataToSVG(imgd: ImageData, options?: Options | string): string
  }
  export default ImageTracer
}
`

export const GUITAR_FILES = {
  'main.ts': GUITAR_MAIN,
  'imagetracerjs.d.ts': IMAGETRACER_TYPES,
  'guitar.worker.ts': GUITAR_WORKER,
  'recipe.ts': GUITAR_RECIPE,
  'package.json': JSON.stringify({ dependencies: { 'manifold-3d': '3.5.5', three: '0.187.0', imagetracerjs: '1.2.6' } }),
}
export const GUITAR_APP = page(GUITAR_FILES)

// -- the 6502 ---------------------------------------------------------------

const PINOUT = [
  'VSS', 'RDY', 'φ1 out', 'IRQ', 'NC', 'NMI', 'SYNC', 'VCC',
  ...Array.from({ length: 12 }, (_, bit) => `A${bit}`),
  'VSS', 'A12', 'A13', 'A14', 'A15',
  ...Array.from({ length: 8 }, (_, bit) => `D${7 - bit}`),
  'R/W', 'NC', 'NC', 'φ0 in', 'SO', 'φ2 out', 'RES',
]
if (PINOUT.length !== 40) throw new Error(`the 6502 pinout has ${PINOUT.length} pins`)

const CPU_RECIPE = `// The 6502's recipe. \`measured\` was taken from the references by
// scripts/e2e/reference/trace.py; \`written\` was not. One scene unit is 10 mm.

export const references = ${json(cpu.references.map((each, index) => ({ ...each, crop: index === 0 ? 'the whole die' : "the body's box; the pins from the band of shoulder highlights along its lower edge" })))} as const

export const measured = {
  package: ${json(cpu.package)},
  /** The die, in fractions of its width (u) and height (v) from the top left. */
  die: {
    aspect: ${cpu.die.aspect},
    /** Bonding pads, counter-clockwise from the top left: [u, v, radius]. */
    pads: ${JSON.stringify(cpu.die.pads)} as Array<[number, number, number]>,
    /** Placed by eye on the die photo, not traced: [u0, v0, u1, v1]. */
    blocks: ${JSON.stringify(cpu.die.blocks)} as Record<'datapath' | 'control' | 'decode', [number, number, number, number]>,
  },
}

/** Not in the references, in mm. */
export const written = {
  note: 'the body depth, the legs, the die width and the lead fingers are written; the lead fingers are schematic',
  bodyDepth: 4,
  dieWidth: 4.3,
  shoulder: { width: 1.5, out: 1.2 },
  leg: { width: 0.5, length: 3.3, thickness: 0.25 },
  finger: { gap: 0.8, length: 1.6, width: 0.22 },
}

/** Pin names, pin 1 first. */
export const pinout = ${JSON.stringify(PINOUT)}

/** Pins with a bonding pad: every pin but the three not connected. */
export const bonded = pinout.flatMap((name, index) => (name === 'NC' ? [] : [index + 1]))

/** A pad's place on the die and where its lead finger starts, in mm from the die's centre. */
export function padPlaces() {
  const width = written.dieWidth
  const height = width / measured.die.aspect
  return measured.die.pads.map(([u, v, r]) => {
    const x = (u - 0.5) * width
    const y = (0.5 - v) * height
    // Out through the nearest edge of the die.
    const edges: Array<[number, number, number]> = [[(u) * width, -1, 0], [(1 - u) * width, 1, 0], [v * height, 0, 1], [(1 - v) * height, 0, -1]]
    const [, dx, dy] = edges.sort((a, b) => a[0] - b[0])[0]!
    const tip: [number, number] = dx ? [(dx * width) / 2 + dx * written.finger.gap, y] : [x, (dy * height) / 2 + dy * written.finger.gap]
    return { pad: [x, y] as [number, number], radius: r * width, tip, out: [dx, dy] as [number, number] }
  })
}

${MESH_TYPE}

export interface Built {
  meshes: Record<string, Array<Mesh>>
  manifoldMs: number
  inWorker: boolean
}
`

const CPU_WORKER = `import Module from 'manifold-3d'
import type { Manifold, ManifoldToplevel } from 'manifold-3d'
import wasmBytes from 'manifold-3d/manifold.wasm'
import { measured, padPlaces, written, type Built, type Mesh } from './recipe'

${START_MANIFOLD}

const mm = (n: number) => n / 10

function build(): Record<string, Array<Mesh>> {
  const { Manifold: Solid } = wasm
  return scope((own) => {
    const [length, width] = measured.package.body_mm
    const depth = written.bodyDepth
    // The body, with the notch at pin 1's end and the dimple by pin 1.
    const block = own(Solid.cube([mm(length), mm(width), mm(depth)], true))
    const notch = own(own(Solid.cylinder(mm(depth), mm(1.6), mm(1.6), 48, true)).translate([mm(-length / 2), 0, mm(depth / 2)]))
    const dimple = own(own(Solid.sphere(mm(1), 32)).translate([mm(-length / 2 + 3), mm(-width / 2 + 2.6), mm(depth / 2 + 0.7)]))
    const body = own(own(block.subtract(notch)).subtract(dimple))

    // One leg on the near side: the shoulder out of the body, then down.
    const { shoulder, leg } = written
    const side = mm(-width / 2)
    const parts: Array<Manifold> = [
      own(own(Solid.cube([mm(shoulder.width), mm(shoulder.out), mm(leg.thickness)], true)).translate([0, side - mm(shoulder.out / 2), 0])),
      own(own(Solid.cube([mm(shoulder.width), mm(leg.thickness), mm(1.6)], true)).translate([0, side - mm(shoulder.out), mm(-0.8)])),
      own(own(Solid.cube([mm(leg.width), mm(leg.thickness), mm(leg.length)], true)).translate([0, side - mm(shoulder.out), mm(-1.6 - leg.length / 2)])),
    ]
    const near = own(Solid.union(parts))
    const far = own(near.mirror([0, 1, 0]))

    // The die at its own scale, centred, its top at z = 0.
    const dieWidth = mm(written.dieWidth)
    const dieHeight = dieWidth / measured.die.aspect
    const die = own(own(Solid.cube([dieWidth, dieHeight, mm(0.3)], true)).translate([0, 0, mm(-0.15)]))
    const blocks = Object.fromEntries(
      Object.entries(measured.die.blocks).map(([name, [u0, v0, u1, v1]]) => {
        const slab = own(Solid.cube([(u1 - u0) * dieWidth, (v1 - v0) * dieHeight, mm(0.04)], true))
        return [name, [meshOf(own(slab.translate([((u0 + u1) / 2 - 0.5) * dieWidth, (0.5 - (v0 + v1) / 2) * dieHeight, mm(0.02)])))]]
      }),
    )
    const places = padPlaces()
    const pads = own(Solid.union(places.map(({ pad: [x, y], radius }) => own(own(Solid.cylinder(mm(0.05), mm(radius), mm(radius), 20, false)).translate([mm(x), mm(y), 0])))))
    const { finger } = written
    const fingers = own(
      Solid.union(
        places.map(({ tip: [x, y], out: [dx, dy] }) => {
          const bar = own(Solid.cube(dx ? [mm(finger.length), mm(finger.width), mm(0.15)] : [mm(finger.width), mm(finger.length), mm(0.15)], true))
          return own(bar.translate([mm(x + (dx * finger.length) / 2), mm(y + (dy * finger.length) / 2), mm(-0.2)]))
        }),
      ),
    )
    return {
      body: [meshOf(body)],
      legNear: [meshOf(near)],
      legFar: [meshOf(far)],
      die: [meshOf(die)],
      pads: [meshOf(pads)],
      fingers: [meshOf(fingers)],
      ...blocks,
    }
  })
}

const started = performance.now()
const meshes = build()
const built: Built = { meshes, manifoldMs: performance.now() - started, inWorker: typeof document === 'undefined' }
self.postMessage(built, { transfer: buffersOf(meshes) })
`

const CPU_MAIN = `import { mount, type Part } from '@theorem/spatial'
import * as THREE from 'three'
import workerUrl from './cpu.worker.ts?worker'
import { bonded, measured, padPlaces, pinout, references, written, type Built, type Mesh } from './recipe'

const worker = new Worker(workerUrl)
const built = await new Promise<Built>((resolve) => worker.addEventListener('message', ({ data }) => resolve(data as Built), { once: true }))
worker.terminate()

${GEOMETRY_OF}

const geometry = Object.fromEntries(Object.entries(built.meshes).map(([name, meshes]) => [name, meshes.map(geometryOf)]))
const colours = measured.package.colours
const solid = (name: string, color: string, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) => () => {
  const group = new THREE.Group()
  for (const each of geometry[name] ?? []) group.add(new THREE.Mesh(each, new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...extra })))
  return group
}

// Pins 1 to 20 run along the near side from the notch end, 21 to 40 back
// along the far side, as on any DIP seen from above.
const pitch = measured.package.pitch_mm / 10
const pinAt = (pin: number): [number, number] => (pin <= 20 ? [(pin - 10.5) * pitch, 0] : [(30.5 - pin) * pitch, 1])
const pinsForm = () => {
  const group = new THREE.Group()
  for (let pin = 1; pin <= 40; pin++) {
    const [x, far] = pinAt(pin)
    const leg = new THREE.Mesh(geometry[far ? 'legFar' : 'legNear']![0]!, new THREE.MeshStandardMaterial({ color: colours.pins, roughness: 0.35, metalness: 0.6 }))
    leg.position.x = x
    leg.name = String(pin)
    group.add(leg)
  }
  return group
}

/** Which pins the bus drives high: address A0..A15, data D0..D7, and R/W high to read. */
const highPins = (address: number, data: number, read: boolean) =>
  pinout.flatMap((name, index) => {
    const bit = /^([AD])(\\d+)$/.exec(name)
    const high = bit ? ((bit[1] === 'A' ? address : data) >> Number(bit[2])) & 1 : name === 'R/W' && read
    return high ? [index + 1] : []
  })

const pins: Part = {
  id: 'pins',
  label: 'Pins',
  about: \`Forty pins at the \${measured.package.pitch_mm} mm pitch counted on the package photo. Set the address and data buses and read or write: the pins they drive high light up. Pin names are the 6502's.\`,
  at: [0, 0, 0],
  form: pinsForm,
  ports: { high: 'out', address: 'out', data: 'out' },
  state: { address: 0xfffc, data: 0x4c, read: true },
  controls: {
    address: { kind: 'bits', bits: 16, label: 'address A15..A0' },
    data: { kind: 'bits', bits: 8, label: 'data D7..D0' },
    read: { kind: 'toggle', label: 'R/W high (read)' },
  },
  compute: (_inputs, state) => ({
    high: highPins(Number(state.address), Number(state.data), Boolean(state.read)),
    address: '$' + Number(state.address).toString(16).padStart(4, '0'),
    data: '$' + Number(state.data).toString(16).padStart(2, '0'),
  }),
  format: (value, port) => (port === 'high' ? \`\${(value as Array<number>).length} pins high\` : String(value)),
  checks: [
    { name: 'A0 is pin 9', state: { address: 1, data: 0, read: false }, expect: { high: [9] } },
    { name: 'A15 is pin 25, after VSS at 21', state: { address: 0x8000, data: 0, read: false }, expect: { high: [25] } },
    { name: 'D7 is pin 26 and D0 pin 33', state: { address: 0, data: 0x81, read: false }, expect: { high: [26, 33] } },
    { name: 'reading holds R/W, pin 34, high', state: { address: 0, data: 0, read: true }, expect: { high: [34] } },
  ],
  show: (object, { values }) => {
    const high = new Set((values.high ?? []) as Array<number>)
    for (const child of object.children)
      if (child instanceof THREE.Mesh) (child.material as THREE.MeshStandardMaterial).color.set(high.has(Number(child.name)) ? '#e0a33a' : colours.pins)
  },
}

// Bond wires from each pad to its lead finger, in an arc. Real bond wire is
// far thinner than drawn here.
const bondsForm = () => {
  const group = new THREE.Group()
  const material = new THREE.MeshStandardMaterial({ color: '#c9a24c', roughness: 0.3, metalness: 0.7 })
  for (const { pad: [x, y], tip: [tx, ty] } of padPlaces()) {
    const from = new THREE.Vector3(x / 10, y / 10, 0.005)
    const to = new THREE.Vector3(tx / 10, ty / 10, -0.0125)
    const peak = from.clone().lerp(to, 0.35).setZ(0.06)
    group.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(from, peak, to), 16, 0.004, 5), material.clone()))
  }
  return group
}

const blockAbout = {
  datapath: 'Registers and the ALU, laid out in bit slices. Placed by eye on the die photo.',
  control: 'The random logic that sequences each instruction. Placed by eye on the die photo.',
  decode: 'The decode ROM (the PLA) that turns an opcode and cycle into control lines. Placed by eye on the die photo.',
}
const blockTint = { datapath: '#8e9a7e', control: '#9a8a7a', decode: '#7e8c9a' }

const body: Part = {
  id: 'package',
  label: '6502 package',
  about: \`The plastic body, \${measured.package.body_mm.join(' × ')} mm as measured from the package photo (its colour sampled from it), with the notch and dimple by pin 1. Open it for the die.\`,
  at: [0, 0, 0],
  form: solid('body', colours.body, { roughness: 0.8 }),
  inside: (m) => {
    m.part({ id: 'die', label: 'Die', about: \`The silicon, \${written.dieWidth} mm wide (written), its proportions measured from the die photo. Drawn enlarged to fill the package.\`, at: [0, 0, 0], form: solid('die', colours.die, { metalness: 0.3 }) })
    for (const name of ['datapath', 'control', 'decode'] as const)
      m.part({ id: name, label: name === 'decode' ? 'Decode ROM' : name.charAt(0).toUpperCase() + name.slice(1), about: blockAbout[name], at: [0, 0, 0], form: solid(name, blockTint[name]) })
    m.part({ id: 'pads', label: 'Bonding pads', about: \`\${measured.die.pads.length} pads traced from the die photo, one for each connected pin (\${bonded.length}: every pin but the three marked NC). Pad order is assumed to follow pin order around the die.\`, at: [0, 0, 0], form: solid('pads', '#c9ccd0', { metalness: 0.7, roughness: 0.3 }) })
    m.part({ id: 'bonds', label: 'Bond wires', about: 'From each pad out to its lead finger; drawn much thicker than real bond wire.', at: [0, 0, 0], form: bondsForm })
    m.part({ id: 'fingers', label: 'Lead fingers', about: 'Where the pins reach in toward the die. Schematic: each starts straight out from its pad.', at: [0, 0, 0], form: solid('fingers', colours.pins, { metalness: 0.6, roughness: 0.35 }) })
  },
}

const model = mount(
  document.getElementById('root')!,
  (m) => {
    m.part(body)
    m.part(pins)
  },
  { title: 'The 6502, from its die and package' },
)
Object.assign(window, { model, cpu: { built: { manifoldMs: built.manifoldMs, inWorker: built.inWorker }, references, pinAt, highPins } })
`

export const CPU_FILES = {
  'main.ts': CPU_MAIN,
  'cpu.worker.ts': CPU_WORKER,
  'recipe.ts': CPU_RECIPE,
  'package.json': JSON.stringify({ dependencies: { 'manifold-3d': '3.5.5', three: '0.187.0' } }),
}
export const CPU_APP = page(CPU_FILES)
