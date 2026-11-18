// Wire crossings and total wire length of the stage arrangement against ELK's,
// for the processor fixture with no part given a place, at the model's top
// level and inside the ALU. Wires are the routes the view draws between ports
// (route.ts: a stub out of each port, then right angles with rounded bends),
// in the model's plane. Run with: bun scripts/e2e/arrangement-metrics.ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as THREE from 'three'
import { arrangeElk, arrangeStages } from '../../src/lib/blocks/spatial/arrange'
import type { Arranged, Box } from '../../src/lib/blocks/spatial/arrange'
import { buildNetwork, ModelState } from '../../src/lib/blocks/spatial/engine'
import type { Builder, Network, Part } from '../../src/lib/blocks/spatial/engine'
import * as parts from '../../src/lib/blocks/spatial/parts'
import { buildForm } from '../../src/lib/blocks/spatial/form'
import { routeInPlane } from '../../src/lib/blocks/spatial/route'
import type { Form } from '../../src/lib/blocks/spatial/form'
import { MOUNT, PARTS, unplaced } from './spatial-fixture.mjs'

// The fixture with every `at` removed.
const library = path.resolve(import.meta.dirname, '../../src/lib/blocks/spatial/index.ts')
const callback = /mount\(document\.getElementById\('root'\)!, (\(m\) => \{[\s\S]*?\n\}), \{/.exec(unplaced(MOUNT))![1]!
const file = path.join(mkdtempSync(path.join(tmpdir(), 'arrangement-')), 'processor.ts')
writeFileSync(file, `${unplaced(PARTS).replace("'@theorem/spatial'", JSON.stringify(library))}\nexport const build = ${callback}\n`)
const { build } = (await import(file)) as { build: (m: Builder) => void }

const network = buildNetwork(build)
const settled = new ModelState(network).settle()

const sizeCache = new Map<string, Box>()
const sizes = (part: Part): Box => {
  let size = sizeCache.get(part.path)
  if (!size) {
    const ins = part.ports.filter((port) => port.dir === 'in').length
    const most = Math.max(ins, part.ports.length - ins)
    const form = (part.spec.form ?? { shape: 'box', size: [1.3, Math.max(0.9, most * 0.34 + 0.4), 0.6], radius: 0.16 }) as Form
    const built = buildForm(form)
    const box = new THREE.Box3().setFromObject(built instanceof THREE.BufferGeometry ? new THREE.Mesh(built) : built)
    const measured = box.getSize(new THREE.Vector3()).multiplyScalar(part.spec.scale ?? 1)
    size = { x: measured.x, y: measured.y }
    sizeCache.set(part.path, size)
  }
  return size
}
const stageIn = (reading: typeof settled) => (part: Part) => reading.readings.get(part.path)?.stage ?? 0

type Point = [number, number]
const portPoint = (part: Part, at: Point, port: string): { point: Point; dir: number } => {
  const found = part.ports.find((candidate) => candidate.name === port)!
  const same = part.ports.filter((candidate) => candidate.dir === found.dir)
  const size = sizes(part)
  const index = same.indexOf(found)
  const local: Point = found.at
    ? [found.at[0], found.at[1]]
    : [(found.dir === 'in' ? -size.x : size.x) / 2, same.length === 1 ? 0 : size.y * 0.8 * (0.5 - index / (same.length - 1))]
  return { point: [at[0] + local[0], at[1] + local[1]], dir: found.dir === 'in' ? -1 : 1 }
}

/** The route the view draws between two ports (route.ts), sampled in the model's plane. */
const drawn = (a: Point, na: number, b: Point, nb: number): Array<Point> =>
  routeInPlane(
    new THREE.Vector3(a[0], a[1], 0),
    new THREE.Vector3(na, 0, 0),
    new THREE.Vector3(b[0], b[1], 0),
    new THREE.Vector3(nb, 0, 0),
  )
    .getPoints(8)
    .map((point): Point => [point.x, point.y])

const cross = (a: Point, b: Point, c: Point, d: Point) => {
  const s = (p: Point, q: Point, r: Point) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  return s(a, b, c) * s(a, b, d) < 0 && s(c, d, a) * s(c, d, b) < 0
}

function measure(net: Network, arranged: Arranged) {
  const at = (part: Part) => arranged.positions.get(part.path)!
  const byPath = new Map(net.parts.map((part) => [part.path, part]))
  const wires = net.wires
    .filter((wire) => !wire.from.boundary && !wire.to.boundary)
    .map((wire) => {
      const from = byPath.get(wire.from.part)!
      const to = byPath.get(wire.to.part)!
      const a = portPoint(from, [at(from)[0], at(from)[1]], wire.from.port)
      const b = portPoint(to, [at(to)[0], at(to)[1]], wire.to.port)
      return { wire, line: drawn(a.point, a.dir, b.point, b.dir) }
    })
  let length = 0
  let crossings = 0
  let throughParts = 0
  for (const { line } of wires) for (let i = 1; i < line.length; i++) length += Math.hypot(line[i]![0] - line[i - 1]![0], line[i]![1] - line[i - 1]![1])
  for (let i = 0; i < wires.length; i++)
    for (let j = i + 1; j < wires.length; j++) {
      const p = wires[i]!.wire
      const q = wires[j]!.wire
      const shares = [p.from, p.to].some((x) => [q.from, q.to].some((y) => x.part === y.part && x.port === y.port))
      if (shares) continue
      const a = wires[i]!.line
      const b = wires[j]!.line
      let hit = false
      for (let s = 1; s < a.length && !hit; s++) for (let t = 1; t < b.length && !hit; t++) hit = cross(a[s - 1]!, a[s]!, b[t - 1]!, b[t]!)
      if (hit) crossings++
    }
  for (const { wire, line } of wires)
    for (const part of net.parts) {
      if (part.path === wire.from.part || part.path === wire.to.part) continue
      const [x, y] = at(part)
      const size = sizes(part)
      if (line.some(([px, py]) => Math.abs(px - x) < size.x / 2 && Math.abs(py - y) < size.y / 2)) throughParts++
    }
  const xs = net.parts.flatMap((part) => [at(part)[0] - sizes(part).x / 2, at(part)[0] + sizes(part).x / 2])
  const ys = net.parts.flatMap((part) => [at(part)[1] - sizes(part).y / 2, at(part)[1] + sizes(part).y / 2])
  const width = Math.max(...xs) - Math.min(...xs)
  const height = Math.max(...ys) - Math.min(...ys)
  const backwards = wires.filter(({ wire }) => at(byPath.get(wire.from.part)!)[0] >= at(byPath.get(wire.to.part)!)[0]).length
  return { wires: wires.length, crossings, throughParts, length: +length.toFixed(2), width: +width.toFixed(2), height: +height.toFixed(2), aspect: +(width / height).toFixed(2), backwards }
}

// The library's own adders, with their parts' places taken away, for models with more wires.
const withoutPlaces = (net: Network): Network => ({ ...net, parts: net.parts.map((part) => ({ ...part, spec: { ...part.spec, at: undefined } })) })
const adder = buildNetwork((m) => m.part(parts.rippleAdder({ id: 'add', bits: 4 })))
const adderSettled = new ModelState(adder).settle()
const levels: Array<[string, Network, typeof settled]> = [
  ['top level', network, settled],
  ['inside the ALU', network.parts.find((part) => part.path === 'alu')!.inside!, settled],
  ['inside a 4-bit adder', withoutPlaces(adder.parts[0]!.inside!), adderSettled],
  ['inside a full adder', withoutPlaces(adder.parts[0]!.inside!.parts.find((part) => part.path === 'add/fa0')!.inside!), adderSettled],
]
const rows: Record<string, unknown> = {}
for (const [level, net, reading] of levels) {
  rows[`${level} / stages`] = measure(net, arrangeStages(net, sizes, stageIn(reading)))
  rows[`${level} / elk`] = measure(net, await arrangeElk(net, sizes))
}
console.table(rows)
console.log(JSON.stringify(rows))
process.exit(0)
