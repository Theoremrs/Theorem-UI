// The App the geometry e2e builds: a gear written as a recipe (named
// parameters) and the code that generates it with Manifold, then used as a
// @theorem/spatial part's form. An agent would write exactly this; nothing in
// it is a Theorem-specific API except the part.

const PACKAGE = JSON.stringify({ dependencies: { 'manifold-3d': '3.5.5', three: '0.187.0' } })

// The recipe and what generates it. Manifold is started from the bytes of its
// own .wasm (bundled into the App); once bundled it cannot find the file itself.
const GEAR = `import Module from 'manifold-3d'
import type { ManifoldToplevel } from 'manifold-3d'
import wasmBytes from 'manifold-3d/manifold.wasm'
import * as THREE from 'three'

/** The recipe: named parameters, in scene units. */
export const recipe = {
  teeth: 18,
  module: 0.14,
  thickness: 0.5,
  bore: 0.3,
  holes: 5,
  holeRadius: 0.22,
}
export type Recipe = typeof recipe

export async function startManifold(): Promise<ManifoldToplevel> {
  // locateFile keeps it from building a URL out of import.meta.url, which in
  // a bundled App is not a place a file can be found. wasmBinary is missing
  // from the package's typings; a config held in a variable is not checked for it.
  const config = { locateFile: () => 'manifold.wasm', wasmBinary: wasmBytes }
  const wasm = await Module(config)
  wasm.setup()
  return wasm
}

/** The gear the recipe describes: tooth outline extruded, bored, lightened, with a hub. */
export function gearGeometry(wasm: ManifoldToplevel, r: Recipe): THREE.BufferGeometry {
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

    const mesh = body.getMesh()
    const geometry = new THREE.BufferGeometry()
    const vertices = new THREE.InterleavedBuffer(mesh.vertProperties, mesh.numProp)
    geometry.setAttribute('position', new THREE.InterleavedBufferAttribute(vertices, 3, 0))
    geometry.setIndex(new THREE.BufferAttribute(mesh.triVerts, 1))
    geometry.computeVertexNormals()
    geometry.computeBoundingBox()
    return geometry
  } finally {
    for (const object of owned) object.delete()
  }
}
`

const MAIN = `import { mount, type Part } from '@theorem/spatial'
import * as THREE from 'three'
import { gearGeometry, recipe, startManifold, type Recipe } from './gear'

const wasm = await startManifold()

/** What each regeneration cost and made, for whoever is watching. */
const generated: Array<{ ms: number; vertices: number; triangles: number; size: [number, number, number]; recipe: Recipe }> = []
let last = ''
const regenerate = (r: Recipe) => {
  const started = performance.now()
  const geometry = gearGeometry(wasm, r)
  const box = geometry.boundingBox!
  generated.push({
    ms: performance.now() - started,
    vertices: geometry.getAttribute('position').count,
    triangles: geometry.index!.count / 3,
    size: [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z],
    recipe: { ...r },
  })
  last = JSON.stringify(r)
  return geometry
}

const gear: Part = {
  id: 'gear',
  label: 'Gear',
  about: 'A spur gear generated from its recipe: a tooth outline extruded, bored, lightened and given a hub.',
  form: () => regenerate(recipe),
  color: '#6f7f8f',
  state: { ...recipe },
  controls: {
    teeth: { kind: 'range', min: 8, max: 48, step: 1, label: 'teeth' },
    module: { kind: 'range', min: 0.12, max: 0.2, step: 0.01, label: 'module' },
    thickness: { kind: 'range', min: 0.2, max: 1, step: 0.05, label: 'thickness' },
    bore: { kind: 'range', min: 0.1, max: 0.5, step: 0.02, label: 'bore' },
    holes: { kind: 'range', min: 0, max: 8, step: 1, label: 'lightening holes' },
  },
  // Each frame; a changed recipe is rebuilt at most once per frame.
  show: (object, { state }) => {
    const r = { ...recipe, ...state } as Recipe
    if (JSON.stringify(r) === last || !(object instanceof THREE.Mesh)) return
    const old = object.geometry
    object.geometry = regenerate(r)
    old.dispose()
  },
}

const model = mount(document.getElementById('root')!, (m) => m.part(gear), { title: 'A parametric gear' })
Object.assign(window, { model, gear: { generated, size: () => (generated.at(-1)?.size) } })
`

// What the frame's policy allows, as the App sees it.
const PROBE = `const probe: { violations: Array<{ directive: string; effective: string; blocked: string }>; worker?: string; wasm?: string } = { violations: [] }
document.addEventListener('securitypolicyviolation', (event) => {
  probe.violations.push({ directive: event.violatedDirective, effective: event.effectiveDirective, blocked: event.blockedURI })
})
try {
  const worker = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' })))
  probe.worker = await new Promise<string>((resolve) => {
    worker.onmessage = () => resolve('ran')
    worker.onerror = (event) => resolve('error: ' + event.message)
    setTimeout(() => resolve('no message in 1.5s'), 1500)
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

export const GEAR_FILES = { 'main.ts': MAIN, 'gear.ts': GEAR, 'package.json': PACKAGE }
export const GEAR_APP = page(GEAR_FILES)
export const PROBE_APP = page({ 'main.ts': PROBE })
