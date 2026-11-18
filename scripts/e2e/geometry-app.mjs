// The App the geometry e2e builds: a gear written as a recipe (named
// parameters) and the code that generates it with Manifold in a Worker, then
// used as a @theorem/spatial part's form. An agent would write exactly this;
// nothing in it is a Theorem-specific API except the part and the `?worker`
// import (Vite's convention, which the App build follows).

const PACKAGE = JSON.stringify({ dependencies: { 'manifold-3d': '3.5.5', three: '0.187.0' } })

/** The recipe: named parameters, in scene units, shared by the page and the worker. */
const RECIPE = `export const recipe = {
  teeth: 18,
  module: 0.14,
  thickness: 0.5,
  bore: 0.3,
  holes: 5,
  holeRadius: 0.22,
}
export type Recipe = typeof recipe

/** What the worker sends back: the mesh Manifold made and what it cost there. */
export interface Made {
  id: number
  recipe: Recipe
  vertProperties: Float32Array
  triVerts: Uint32Array
  numProp: number
  manifoldMs: number
  inWorker: boolean
}
`

// Manifold is started from the bytes of its own .wasm (bundled into the App);
// once bundled it cannot find the file itself. All of it runs in the worker.
const WORKER = `import Module from 'manifold-3d'
import type { ManifoldToplevel } from 'manifold-3d'
import wasmBytes from 'manifold-3d/manifold.wasm'
import type { Made, Recipe } from './recipe'

// locateFile keeps it from building a URL out of import.meta.url, which in a
// bundled App is not a place a file can be found. wasmBinary is missing from
// the package's typings; a config held in a variable is not checked for it.
const config = { locateFile: () => 'manifold.wasm', wasmBinary: wasmBytes }
const wasm: ManifoldToplevel = await Module(config)
wasm.setup()

/** The gear the recipe describes: tooth outline extruded, bored, lightened, with a hub. */
function gear(r: Recipe) {
  const { Manifold, CrossSection } = wasm
  // Every Manifold and CrossSection lives in wasm memory until it is deleted.
  const owned: Array<{ delete(): void }> = []
  const own = <T extends { delete(): void }>(object: T): T => (owned.push(object), object)
  try {
    const pitch = (r.module * r.teeth) / 2
    const tip = pitch + r.module
    const root = pitch - 1.25 * r.module
    const bore = Math.min(r.bore, root * 0.45)
    const hub = bore + 0.1
    const step = (Math.PI * 2) / r.teeth
    const outline: Array<[number, number]> = []
    for (let tooth = 0; tooth < r.teeth; tooth++)
      for (const [radius, turn] of [[root, -0.275], [tip, -0.125], [tip, 0.125], [root, 0.275]] as const) {
        const angle = (tooth + turn) * step
        outline.push([radius * Math.cos(angle), radius * Math.sin(angle)])
      }
    const plate = own(own(CrossSection.ofPolygons([outline])).subtract(own(CrossSection.circle(bore, 48))))
    let body = own(plate.extrude(r.thickness, 0, 0, 1, true))
    const holeRadius = Math.min(r.holeRadius, ((root - hub) / 2) * 0.8)
    const ring = (root + hub) / 2
    for (let hole = 0; hole < r.holes; hole++) {
      const angle = (hole / r.holes) * Math.PI * 2
      const cutter = own(Manifold.cylinder(r.thickness * 2, holeRadius, holeRadius, 24, true))
      body = own(body.subtract(own(cutter.translate([ring * Math.cos(angle), ring * Math.sin(angle), 0]))))
    }
    const boss = own(Manifold.cylinder(r.thickness * 1.6, hub, hub, 48, true))
    const hole = own(Manifold.cylinder(r.thickness * 4, bore, bore, 48, true))
    body = own(body.add(own(boss.subtract(hole))))
    return body.getMesh()
  } finally {
    for (const object of owned) object.delete()
  }
}

self.onmessage = ({ data }: MessageEvent<{ id: number; recipe: Recipe }>) => {
  const started = performance.now()
  const mesh = gear(data.recipe)
  const made: Made = {
    id: data.id,
    recipe: data.recipe,
    vertProperties: mesh.vertProperties,
    triVerts: mesh.triVerts,
    numProp: mesh.numProp,
    manifoldMs: performance.now() - started,
    inWorker: typeof document === 'undefined',
  }
  // The arrays move to the page; nothing is copied.
  self.postMessage(made, { transfer: [made.vertProperties.buffer, made.triVerts.buffer] })
}
self.postMessage('ready')
`

const MAIN = `import { mount, type Part } from '@theorem/spatial'
import * as THREE from 'three'
import workerUrl from './gear.worker.ts?worker'
import { recipe, type Made, type Recipe } from './recipe'

const worker = new Worker(workerUrl)
await new Promise((ready) => worker.addEventListener('message', ready, { once: true }))

/** Manifold's mesh as three.js geometry. */
function geometryOf(made: Made): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  const vertices = new THREE.InterleavedBuffer(made.vertProperties, made.numProp)
  geometry.setAttribute('position', new THREE.InterleavedBufferAttribute(vertices, 3, 0))
  geometry.setIndex(new THREE.BufferAttribute(made.triVerts, 1))
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  return geometry
}

/** What each regeneration cost and made, for whoever is watching. */
const generated: Array<{ ms: number; manifoldMs: number; inWorker: boolean; vertices: number; triangles: number; size: [number, number, number]; recipe: Recipe }> = []

// At most one recipe is with the worker; the newest one asked for waits, and
// any in between are skipped, so a dragged slider never queues up work.
let asked = JSON.stringify(recipe)
let made = ''
let busy = false
let target: THREE.Mesh | null = null
let sentAt = 0
let id = 0
const send = (r: Recipe) => {
  busy = true
  sentAt = performance.now()
  worker.postMessage({ id: ++id, recipe: r })
}
const first = await new Promise<THREE.BufferGeometry>((resolve) => {
  worker.onmessage = ({ data }: MessageEvent<Made>) => {
    busy = false
    const geometry = geometryOf(data)
    const box = geometry.boundingBox!
    generated.push({
      ms: performance.now() - sentAt,
      manifoldMs: data.manifoldMs,
      inWorker: data.inWorker,
      vertices: geometry.getAttribute('position').count,
      triangles: geometry.index!.count / 3,
      size: [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z],
      recipe: data.recipe,
    })
    made = JSON.stringify(data.recipe)
    if (target) {
      const old = target.geometry
      target.geometry = geometry
      old.dispose()
    } else resolve(geometry)
    if (asked !== made) send(JSON.parse(asked) as Recipe)
  }
  send(recipe)
})

const gear: Part = {
  id: 'gear',
  label: 'Gear',
  about: 'A spur gear generated from its recipe: a tooth outline extruded, bored, lightened and given a hub.',
  form: () => first,
  color: '#6f7f8f',
  state: { ...recipe },
  controls: {
    teeth: { kind: 'range', min: 8, max: 48, step: 1, label: 'teeth' },
    module: { kind: 'range', min: 0.12, max: 0.2, step: 0.01, label: 'module' },
    thickness: { kind: 'range', min: 0.2, max: 1, step: 0.05, label: 'thickness' },
    bore: { kind: 'range', min: 0.1, max: 0.5, step: 0.02, label: 'bore' },
    holes: { kind: 'range', min: 0, max: 8, step: 1, label: 'lightening holes' },
  },
  // Each frame: a changed recipe goes to the worker, and its mesh replaces
  // this one when it comes back.
  show: (object, { state }) => {
    if (!(object instanceof THREE.Mesh)) return
    target = object
    const r = JSON.stringify({ ...recipe, ...state })
    if (r === asked) return
    asked = r
    if (!busy) send(JSON.parse(r) as Recipe)
  },
}

const model = mount(document.getElementById('root')!, (m) => m.part(gear), { title: 'A parametric gear' })
Object.assign(window, { model, gear: { generated, size: () => generated.at(-1)?.size } })
`

// What the frame's policy allows, as the App sees it.
const probe = (url) => `const probe: { violations: Array<{ directive: string; effective: string; blocked: string }>; worker?: string; wasm?: string; fetch?: string } = { violations: [] }
document.addEventListener('securitypolicyviolation', (event) => {
  probe.violations.push({ directive: event.violatedDirective, effective: event.effectiveDirective, blocked: event.blockedURI })
})
try {
  // The worker tries the network too: it keeps the frame's policy. The address
  // answers any origin (CORS), so only a policy can refuse it.
  const source = "fetch('${url}').then((r) => r.text()).then((text) => postMessage('fetched ' + text), () => postMessage('fetch refused'))"
  const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })))
  probe.worker = await new Promise<string>((resolve) => {
    worker.onmessage = ({ data }) => resolve('ran, ' + data)
    worker.onerror = (event) => resolve('error: ' + event.message)
    setTimeout(() => resolve('no message in 3s'), 3000)
  })
} catch (error) {
  probe.worker = 'threw: ' + (error as Error).message
}
try {
  await WebAssembly.instantiate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))
  probe.wasm = 'compiled'
} catch (error) {
  probe.wasm = 'threw: ' + (error as Error).message
}
Object.assign(window, { probe })
`

const page = (files) => `<!doctype html>
<div id="root"></div>
${Object.entries(files)
  .map(([path, text]) => `<script type="text/theorem-source" data-path="${path}">${text}</script>`)
  .join('\n')}`

export const GEAR_FILES = { 'main.ts': MAIN, 'gear.worker.ts': WORKER, 'recipe.ts': RECIPE, 'package.json': PACKAGE }
export const GEAR_APP = page(GEAR_FILES)
/** The probe App: it reports whether a blob Worker reaches `url`, and whether WebAssembly compiles. */
export const probeApp = (url) => page({ 'main.ts': probe(url) })
