// SOURCING: three.js draws and picks everything: WebGLRenderer with a
// PerspectiveCamera, OrbitControls (restrained, damped) for looking around,
// Raycaster for picking, MeshSurfaceSampler for the cells that give a part its
// substance, TubeGeometry along CubicBezierCurve3 for wires, CSS2DRenderer for
// labels that stay readable at any depth. What is ours is the handling: pull a
// part forward while the rest recedes, open a part into its inside with its
// cells reorganising onto the inner parts, values replayed stage by stage.

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { MeshSurfaceSampler } from 'three/examples/jsm/math/MeshSurfaceSampler.js'
import {
  allParts,
  buildNetwork,
  ModelState
  
  
  
  
  
  
  
  
  
  
} from './engine'
import type {Builder, ControlSpec, HandleSpec, Network, Part, PartReading, Settled, Values, Vec3, Wire} from './engine';
import { buildForm, mergedGeometry  } from './form'
import type {Form} from './form';

export type SpatialBuilder = Builder<Form, THREE.Object3D>

export interface MountOptions {
  title?: string
  /**
   * A state collection, declared with `state("name")`, that keeps what the
   * person changed, what is open and what is pulled out, across reloads and
   * revisions of the App.
   */
  remember?: string
  /** Height in CSS pixels. Default 520. */
  height?: number
  /** Stages a change travels per second. Default 5. */
  pace?: number
}

export interface PartView {
  path: string
  label: string
  inputs: Values
  outputs: Values
  state: Values
  /** Where the part is drawn, in world units. */
  at: Vec3
  /** Where its centre is on screen, in CSS pixels from the model's top left; null when not drawn. */
  screen: [number, number] | null
  pulled: boolean
}

export interface SpatialModel {
  /** Sets a state key or an unwired input, and replays the change. */
  set: (path: string, key: string, value: unknown) => void
  value: (path: string, key: string) => unknown
  /** One clock step for every clocked part. */
  step: () => void
  /** Opens a part ('' for the whole model). */
  open: (path: string) => void
  /** Pulls a part forward, or puts every pulled part back (null). */
  pull: (path: string | null) => void
  select: (path: string | null) => void
  /** The model in words and numbers, for tests and for the agent's checks. */
  inspect: () => { open: string; selected: string | null; stage: number; parts: Array<PartView>; failures: Array<string> }
  dispose: () => void
}

type Theme = Record<'ink' | 'muted' | 'faint' | 'accent' | 'lit' | 'warn' | 'surface' | 'border' | 'font' | 'mono', string>

function readTheme(): Theme {
  const style = getComputedStyle(document.documentElement)
  const dark =
    document.documentElement.classList.contains('dark') ||
    style.getPropertyValue('color-scheme').includes('dark') ||
    (!style.getPropertyValue('color-scheme').trim() && matchMedia('(prefers-color-scheme: dark)').matches)
  const token = (name: string, light: string, darkValue: string) =>
    style.getPropertyValue(`--theorem-${name}`).trim() || (dark ? darkValue : light)
  return {
    ink: token('ink', '#22201c', '#ece7dd'),
    muted: token('ink-muted', '#5d574d', '#b7afa2'),
    faint: token('ink-faint', '#9a9286', '#6f685e'),
    accent: token('accent', '#a4442c', '#dd7a5c'),
    lit: token('success', '#1d6f68', '#6cc5b8'),
    warn: token('warning', '#8a6416', '#e0b25a'),
    surface: token('surface', '#fbf8f2', '#26231f'),
    border: token('border', '#d9d2c5', '#3d3832'),
    font: token('font', 'system-ui, sans-serif', 'system-ui, sans-serif'),
    mono: token('font-mono', 'ui-monospace, monospace', 'ui-monospace, monospace'),
  }
}

const color = (css: string) => {
  const value = new THREE.Color()
  try {
    value.setStyle(css)
  } catch {
    value.set('#888888')
  }
  return value
}

const CELL_VERTEX = /* glsl */ `
attribute vec3 aTarget;
attribute float aSeed;
uniform float uTime, uActivity, uMorph, uSize, uScale, uLit;
uniform vec3 uColor, uLitColor;
varying vec3 vColor;
void main() {
  float morph = smoothstep(0.0, 1.0, uMorph);
  vec3 p = mix(position, aTarget, morph);
  float breathe = sin(uTime * 1.7 + aSeed * 43.0) * 0.010;
  float fire = sin(uTime * 13.0 + aSeed * 97.0) * 0.035 * uActivity;
  p += normal * (breathe + fire) * (1.0 - morph);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * uScale * (1.0 + uActivity * 0.9) / -mv.z;
  float spark = step(0.82, fract(aSeed * 7.31 + uTime * 0.9)) * uActivity;
  vColor = mix(uColor, uLitColor, clamp(uLit * 0.85 + spark, 0.0, 1.0));
}`

const CELL_FRAGMENT = /* glsl */ `
uniform float uOpacity;
varying vec3 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;
  gl_FragColor = vec4(vColor, uOpacity * smoothstep(0.5, 0.18, d));
}`

interface PortVisual {
  name: string
  dir: 'in' | 'out'
  /** In the part's body frame. */
  local: THREE.Vector3
  /** Which way a wire leaves it, in the body frame. */
  normal: THREE.Vector3
  dot: THREE.Mesh
  tag: CSS2DObject
}

interface Level {
  network: Network
  /** The frame the network's parts are placed in. */
  group: THREE.Group
  visuals: Array<Visual>
  wires: Array<WireVisual>
}

interface Visual {
  part: Part
  group: THREE.Group
  body: THREE.Group
  shell: THREE.Object3D
  /** An unseen box over the part's bounds, so a form with holes in it is still grabbed anywhere over it. */
  grip: THREE.Mesh
  /** Whether the shell's material is the library's, tinted as the part's values change. */
  own: boolean
  materials: Array<THREE.Material & { opacity: number }>
  baseOpacity: Array<number>
  edges: THREE.LineSegments
  cells?: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>
  size: THREE.Vector3
  home: THREE.Vector3
  /** Where the person moved it, in its level's frame. */
  moved: THREE.Vector3
  ports: Map<string, PortVisual>
  label: CSS2DObject
  handles: Array<{ spec: HandleSpec; knob: THREE.Mesh; track: THREE.Line }>
  inside?: Level
  insideScale: number
  /** Eased display values. */
  fade: number
  cellFade: number
  pull: number
  recede: number
  morph: number
  activity: number
  lit: number
}

interface WireVisual {
  wire: Wire
  mesh: THREE.Mesh<THREE.TubeGeometry, THREE.MeshBasicMaterial>
  pulse: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>
  /** 0..1 along the wire while a change travels it; -1 when idle. */
  travel: number
  ends: string
  fade: number
}

const FRAMING = new THREE.Vector3(0.62, 0.42, 1).normalize()
const ease = (current: number, target: number, rate: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-rate * dt))

const short = (value: unknown): string => {
  if (value === undefined) return '–'
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '')
  if (typeof value === 'string') return value.length > 18 ? `${value.slice(0, 17)}…` : value
  const text = JSON.stringify(value)
  return text.length > 18 ? `${text.slice(0, 17)}…` : text
}

const truthy = (value: unknown) =>
  typeof value === 'number' ? value !== 0 : typeof value === 'boolean' ? value : value != null && value !== ''

const isBit = (value: unknown) => value === 0 || value === 1 || typeof value === 'boolean'

/** Places a network's parts that give no `at`, by stage, left to right. */
function layout(network: Network, settled: Settled, sizes: Map<string, THREE.Vector3>) {
  const placed = new Map<string, THREE.Vector3>()
  const columns = new Map<number, Array<Part>>()
  for (const part of network.parts) {
    if (part.spec.at) placed.set(part.path, new THREE.Vector3(...part.spec.at))
    else {
      const stage = settled.readings.get(part.path)?.stage ?? 0
      columns.set(stage, [...(columns.get(stage) ?? []), part])
    }
  }
  const stages = [...columns.keys()].sort((a, b) => a - b)
  let x = 0
  const widths = stages.map((stage) =>
    Math.max(...columns.get(stage)!.map((part) => sizes.get(part.path)!.x)),
  )
  const total = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, stages.length - 1) * 1.6
  x = -total / 2
  stages.forEach((stage, index) => {
    const column = columns.get(stage)!
    const heights = column.map((part) => sizes.get(part.path)!.y)
    const height = heights.reduce((sum, h) => sum + h, 0) + (column.length - 1) * 0.9
    let y = height / 2
    column.forEach((part, row) => {
      y -= heights[row]! / 2
      placed.set(part.path, new THREE.Vector3(x + widths[index]! / 2, y, (row % 2) * -0.35))
      y -= heights[row]! / 2 + 0.9
    })
    x += widths[index]! + 1.6
  })
  return placed
}

/**
 * Draws a model into `element` and lets the person handle it. `build`
 * describes the parts and wires; every part's form, behavior, controls and
 * inside come from its own spec.
 */
export function mount(
  element: HTMLElement,
  build: (model: SpatialBuilder) => void,
  options: MountOptions = {},
): SpatialModel {
  const network = buildNetwork(build as (model: Builder) => void)
  const model = new ModelState(network)
  const failures = model.check()
  for (const failure of failures) reportError(new Error(`Spatial check failed: ${failure}`))

  let theme = readTheme()
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const pace = options.pace ?? 5

  // The page around the canvas: no frame, only what is needed beside the model.
  const root = document.createElement('div')
  root.className = 'theorem-spatial'
  root.style.cssText = `position:relative;width:100%;height:${options.height ?? 520}px;overflow:hidden;touch-action:none;user-select:none;-webkit-user-select:none;font-family:${theme.font};`
  element.append(root)
  const style = document.createElement('style')
  root.append(style)
  const paint = () => {
    style.textContent = `
.theorem-spatial .ts-label{font:500 11.5px/1.25 ${theme.font};color:${theme.ink};text-align:center;pointer-events:none;white-space:nowrap;text-shadow:0 0 6px ${theme.surface},0 0 2px ${theme.surface}}
.theorem-spatial .ts-label small{display:block;font:400 10.5px/1.2 ${theme.mono};color:${theme.muted}}
.theorem-spatial .ts-port{font:500 10px/1 ${theme.mono};color:${theme.muted};pointer-events:none;text-shadow:0 0 4px ${theme.surface},0 0 2px ${theme.surface}}
.theorem-spatial .ts-port.on{color:${theme.lit}}
.theorem-spatial .ts-card{position:absolute;min-width:190px;max-width:270px;padding:10px 12px;border-radius:10px;background:color-mix(in srgb, ${theme.surface} 88%, transparent);backdrop-filter:blur(10px);border:1px solid color-mix(in srgb, ${theme.border} 70%, transparent);box-shadow:0 8px 28px rgb(0 0 0 / .14);color:${theme.ink};font-size:12px;line-height:1.35;user-select:text;-webkit-user-select:text;z-index:3}
.theorem-spatial .ts-card h3{margin:0 0 2px;font-size:13px;font-weight:600}
.theorem-spatial .ts-card p{margin:0 0 8px;color:${theme.muted}}
.theorem-spatial .ts-card table{width:100%;border-collapse:collapse;font-family:${theme.mono};font-size:11px}
.theorem-spatial .ts-card td{padding:2px 0;vertical-align:middle}
.theorem-spatial .ts-card td:first-child{color:${theme.muted};padding-right:8px}
.theorem-spatial .ts-card td:last-child{text-align:right}
.theorem-spatial .ts-card input[type=number]{width:72px;padding:2px 4px;font:inherit;text-align:right}
.theorem-spatial .ts-card input{accent-color:${theme.lit}}
.theorem-spatial .ts-card input[type=range]{width:110px}
.theorem-spatial .ts-card .ts-actions{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.theorem-spatial button.ts-chip{font:500 11.5px/1 ${theme.font};padding:5px 9px;border-radius:999px;border:1px solid color-mix(in srgb, ${theme.border} 80%, transparent);background:color-mix(in srgb, ${theme.surface} 80%, transparent);color:${theme.ink};cursor:pointer}
.theorem-spatial button.ts-chip:hover{background:color-mix(in srgb, ${theme.ink} 8%, ${theme.surface})}
.theorem-spatial button.ts-chip[aria-pressed=true]{border-color:${theme.lit};color:${theme.lit}}
.theorem-spatial button.ts-bit{min-width:26px;padding:2px 6px;border-radius:6px;font:600 11px/1.2 ${theme.mono};cursor:pointer;border:1px solid ${theme.border};background:transparent;color:${theme.muted}}
.theorem-spatial button.ts-bit[aria-pressed=true]{background:${theme.lit};border-color:${theme.lit};color:${theme.surface}}
.theorem-spatial .ts-crumbs{position:absolute;left:10px;top:8px;display:flex;gap:4px;align-items:center;font-size:12px;color:${theme.muted};z-index:2}
.theorem-spatial .ts-crumbs button{border:0;background:none;padding:2px 4px;color:${theme.muted};cursor:pointer;font:inherit}
.theorem-spatial .ts-crumbs button:last-child{color:${theme.ink};font-weight:600;cursor:default}
.theorem-spatial .ts-bar{position:absolute;left:10px;bottom:10px;display:flex;gap:6px;align-items:center;font:500 11px/1 ${theme.mono};color:${theme.muted};z-index:2}
.theorem-spatial .ts-hint{position:absolute;right:12px;bottom:12px;font-size:11px;color:${theme.faint};pointer-events:none}
.theorem-spatial .ts-outline{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:pre}
`
  }
  paint()

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setClearColor(0x000000, 0)
  renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;outline:none'
  renderer.domElement.tabIndex = 0
  renderer.domElement.setAttribute('aria-label', options.title ?? 'Spatial model')
  root.append(renderer.domElement)
  const labels = new CSS2DRenderer()
  labels.domElement.style.cssText = 'position:absolute;inset:0;pointer-events:none'
  root.append(labels.domElement)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 400)
  const hemisphere = new THREE.HemisphereLight(0xffffff, 0x8a8070, 1.6)
  const sun = new THREE.DirectionalLight(0xffffff, 1.4)
  sun.position.set(4, 7, 9)
  scene.add(hemisphere, sun)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.minPolarAngle = Math.PI * 0.28
  controls.maxPolarAngle = Math.PI * 0.64
  controls.minAzimuthAngle = -1
  controls.maxAzimuthAngle = 1.1
  controls.screenSpacePanning = true
  controls.rotateSpeed = 0.6

  const crumbs = document.createElement('nav')
  crumbs.className = 'ts-crumbs'
  crumbs.setAttribute('aria-label', 'Where you are in the model')
  const bar = document.createElement('div')
  bar.className = 'ts-bar'
  const hint = document.createElement('div')
  hint.className = 'ts-hint'
  hint.textContent = 'Drag a part to pull it out · double-click to open · Esc to go back'
  const card = document.createElement('div')
  card.className = 'ts-card'
  card.hidden = true
  const outline = document.createElement('div')
  outline.className = 'ts-outline'
  outline.setAttribute('role', 'list')
  root.append(crumbs, bar, hint, card, outline)

  // The model's values: what was settled, and what is shown while a change travels.
  let settled = model.settle()
  let previous = settled
  let replay = { time: Infinity, end: 0, paused: false, changed: new Set<string>() }
  let slow = false
  let running = false
  let lastStepAt = 0

  const sizes = new Map<string, THREE.Vector3>()
  const visuals = new Map<string, Visual>()
  const ticking = [...allParts(network)].some((part) => part.spec.tick)

  /**
   * When each part fires in the replay, in stages of the open network: its
   * parts fire at whole stages, a part's inside within its own stage, and
   * everything outside the open part at once.
   */
  const fireTime = new Map<string, number>()
  const timeline = () => {
    fireTime.clear()
    for (const part of allParts(network)) fireTime.set(part.path, 0)
    const visit = (net: Network, start: number, unit: number) => {
      const count = Math.max(1, ...net.parts.map((part) => (settled.readings.get(part.path)?.stage ?? 0) + 1))
      const each = unit / count
      for (const part of net.parts) {
        const at = start + (settled.readings.get(part.path)?.stage ?? 0) * each
        fireTime.set(part.path, at)
        if (part.inside) visit(part.inside, at, each)
      }
      return count
    }
    const focus = focusNetwork()
    const count = Math.max(1, ...focus.parts.map((part) => (settled.readings.get(part.path)?.stage ?? 0) + 1))
    visit(focus, 0, count)
    return count
  }

  const reading = (path: string): PartReading | undefined => {
    const now = settled.readings.get(path)
    if (replay.time >= replay.end || !replay.changed.has(path)) return now
    return (fireTime.get(path) ?? 0) <= replay.time ? now : previous.readings.get(path)
  }

  const valuesOf = (path: string): { inputs: Values; outputs: Values } => {
    const found = reading(path)
    return { inputs: found?.inputs ?? {}, outputs: found?.outputs ?? {} }
  }

  // Building parts.
  const cellMaterial = (count: number) =>
    new THREE.ShaderMaterial({
      vertexShader: CELL_VERTEX,
      fragmentShader: CELL_FRAGMENT,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uActivity: { value: 0 },
        uMorph: { value: 0 },
        uSize: { value: count > 500 ? 0.04 : 0.05 },
        uScale: { value: 400 },
        uLit: { value: 0 },
        uOpacity: { value: 0.85 },
        uColor: { value: color(theme.ink) },
        uLitColor: { value: color(theme.lit) },
      },
    })

  /** A part's form, or a box with room for its ports. */
  const formOf = (part: Part): Form => {
    if (part.spec.form) return part.spec.form as Form
    const ins = part.ports.filter((port) => port.dir === 'in').length
    const most = Math.max(ins, part.ports.length - ins)
    return { shape: 'box', size: [1.3, Math.max(0.9, most * 0.34 + 0.4), 0.6], radius: 0.16 }
  }

  const sizeOf = (part: Part) => {
    let size = sizes.get(part.path)
    if (size) return size
    const built = buildForm(formOf(part))
    const object = built instanceof THREE.BufferGeometry ? new THREE.Mesh(built) : built
    const box = new THREE.Box3().setFromObject(object)
    size = box.getSize(new THREE.Vector3()).multiplyScalar(part.spec.scale ?? 1)
    sizes.set(part.path, size)
    return size
  }

  function buildVisual(part: Part, level: THREE.Group, at: THREE.Vector3): Visual {
    const spec = part.spec
    const group = new THREE.Group()
    group.position.copy(at)
    const body = new THREE.Group()
    if (spec.rotate) body.rotation.set(...spec.rotate)
    body.scale.setScalar(spec.scale ?? 1)
    group.add(body)
    level.add(group)
    const built = buildForm(formOf(part))
    let shell: THREE.Object3D
    const own = built instanceof THREE.BufferGeometry
    if (built instanceof THREE.BufferGeometry) {
      shell = new THREE.Mesh(
        built,
        new THREE.MeshStandardMaterial({
          color: color(spec.color ?? theme.surface),
          transparent: true,
          opacity: 0.42,
          roughness: 0.4,
          metalness: 0,
          depthWrite: false,
        }),
      )
    } else shell = built
    const materials: Visual['materials'] = []
    shell.traverse((child) => {
      child.userData.path = part.path
      if (child instanceof THREE.Mesh) {
        for (const material of [child.material].flat() as Array<THREE.Material>) {
          material.transparent = true
          materials.push(material)
        }
      }
    })
    body.add(shell)
    const merged = shell instanceof THREE.Mesh ? (shell.geometry as THREE.BufferGeometry) : mergedGeometry(shell)
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(merged ?? new THREE.BoxGeometry(1, 1, 1), 30),
      new THREE.LineBasicMaterial({ color: color(theme.faint), transparent: true, opacity: 0.55 }),
    )
    body.add(edges)
    const box = new THREE.Box3().setFromObject(shell)
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const grip = new THREE.Mesh(
      new THREE.BoxGeometry(Math.max(size.x, 0.2), Math.max(size.y, 0.2), Math.max(size.z, 0.2)),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    grip.position.copy(center)
    grip.userData.path = part.path
    body.add(grip)

    // Cells: sampled once over the surface, then only moved by the shader.
    let cells: Visual['cells']
    const area = 2 * (size.x * size.y + size.y * size.z + size.x * size.z)
    const count = spec.cells ?? Math.round(Math.min(1400, Math.max(120, area * 110)))
    if (count > 0 && merged) {
      const sampler = new MeshSurfaceSampler(new THREE.Mesh(merged)).build()
      const position = new Float32Array(count * 3)
      const normal = new Float32Array(count * 3)
      const seed = new Float32Array(count)
      const point = new THREE.Vector3()
      const facing = new THREE.Vector3()
      for (let index = 0; index < count; index++) {
        sampler.sample(point, facing)
        point.toArray(position, index * 3)
        facing.toArray(normal, index * 3)
        seed[index] = Math.random()
      }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(position, 3))
      geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3))
      geometry.setAttribute('aTarget', new THREE.BufferAttribute(position.slice(), 3))
      geometry.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
      cells = new THREE.Points(geometry, cellMaterial(count))
      cells.renderOrder = 2
      body.add(cells)
    }

    // Ports: on the part's faces, inputs to the left and outputs to the right, unless placed.
    const ports = new Map<string, PortVisual>()
    const sides = { in: part.ports.filter((p) => p.dir === 'in'), out: part.ports.filter((p) => p.dir === 'out') }
    for (const dir of ['in', 'out'] as const) {
      sides[dir].forEach((port, index) => {
        const count = sides[dir].length
        const local = port.at
          ? new THREE.Vector3(...port.at)
          : new THREE.Vector3(
              center.x + (dir === 'in' ? -size.x / 2 : size.x / 2),
              center.y + (count === 1 ? 0 : size.y * 0.8 * (0.5 - index / (count - 1))),
              center.z,
            )
        const normal = port.at
          ? local.clone().sub(center).setZ(0).normalize()
          : new THREE.Vector3(dir === 'in' ? -1 : 1, 0, 0)
        if (normal.lengthSq() === 0) normal.set(dir === 'in' ? -1 : 1, 0, 0)
        const dot = new THREE.Mesh(
          new THREE.SphereGeometry(0.055, 12, 8),
          new THREE.MeshBasicMaterial({ color: color(theme.faint), transparent: true }),
        )
        dot.position.copy(local)
        dot.userData.path = part.path
        dot.userData.port = port.name
        body.add(dot)
        const tagElement = document.createElement('div')
        tagElement.className = 'ts-port'
        const tag = new CSS2DObject(tagElement)
        tag.position.copy(local).add(normal.clone().multiplyScalar(0.16))
        tag.center.set(dir === 'in' ? 1 : 0, 0.5)
        body.add(tag)
        ports.set(port.name, { name: port.name, dir, local, normal, dot, tag })
      })
    }

    const labelElement = document.createElement('div')
    labelElement.className = 'ts-label'
    const label = new CSS2DObject(labelElement)
    label.position.set(center.x, box.max.y + 0.16, center.z)
    label.center.set(0.5, 1)
    body.add(label)

    const handles = (spec.handles ?? []).map((handle) => {
      const axis = new THREE.Vector3(handle.axis === 'x' ? 1 : 0, handle.axis === 'y' ? 1 : 0, handle.axis === 'z' ? 1 : 0)
      const start = new THREE.Vector3(...handle.at)
      const track = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([start, start.clone().addScaledVector(axis, handle.length)]),
        new THREE.LineBasicMaterial({ color: color(theme.faint), transparent: true }),
      )
      const knob = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 16, 12),
        new THREE.MeshStandardMaterial({ color: color(theme.accent), transparent: true }),
      )
      knob.userData.path = part.path
      knob.userData.handle = handle.key
      body.add(track, knob)
      return { spec: handle, knob, track }
    })

    const visual: Visual = {
      part,
      group,
      body,
      shell,
      grip,
      own,
      materials,
      baseOpacity: materials.map((material) => material.opacity),
      edges,
      cells,
      size: size.multiplyScalar(spec.scale ?? 1),
      home: at.clone(),
      moved: new THREE.Vector3(),
      ports,
      label,
      handles,
      insideScale: 1,
      fade: 0,
      cellFade: 0,
      pull: 0,
      recede: 0,
      morph: 0,
      activity: 0,
      lit: 0,
    }
    visuals.set(part.path, visual)
    return visual
  }

  function buildLevel(net: Network, group: THREE.Group): Level {
    for (const part of net.parts) sizeOf(part)
    const places = layout(net, settled, sizes)
    const level: Level = { network: net, group, visuals: [], wires: [] }
    for (const part of net.parts) level.visuals.push(buildVisual(part, group, places.get(part.path)!))
    for (const wire of net.wires) {
      const mesh = new THREE.Mesh(
        new THREE.TubeGeometry(new THREE.LineCurve3(new THREE.Vector3(), new THREE.Vector3(0, 0.01, 0)), 2, 0.02, 6),
        new THREE.MeshBasicMaterial({ color: color(theme.faint), transparent: true }),
      )
      const pulse = new THREE.Mesh(
        new THREE.SphereGeometry(1, 12, 8),
        new THREE.MeshBasicMaterial({ color: color(theme.lit), transparent: true }),
      )
      pulse.visible = false
      scene.add(mesh, pulse)
      level.wires.push({ wire, mesh, pulse, travel: -1, ends: '', fade: 0 })
    }
    return level
  }

  /** Builds a part's inside, scaled to sit within the part. */
  function insideOf(visual: Visual): Level | undefined {
    if (visual.inside || !visual.part.inside) return visual.inside
    const group = new THREE.Group()
    visual.body.add(group)
    const level = buildLevel(visual.part.inside, group)
    const box = new THREE.Box3()
    for (const inner of level.visuals) {
      const half = inner.size.clone().multiplyScalar(0.5)
      box.expandByPoint(inner.home.clone().sub(half))
      box.expandByPoint(inner.home.clone().add(half))
    }
    const extent = box.getSize(new THREE.Vector3())
    const own = visual.size.clone().divideScalar(visual.part.spec.scale ?? 1)
    const scale = Math.min((own.x * 0.86) / extent.x, (own.y * 0.86) / extent.y)
    group.scale.setScalar(scale)
    group.position.copy(box.getCenter(new THREE.Vector3()).multiplyScalar(-scale))
    visual.insideScale = scale
    visual.inside = level
    // The part's cells reorganise onto its inner parts when it opens.
    if (visual.cells) {
      const targets: Array<THREE.Vector3> = []
      group.updateMatrix()
      for (const inner of level.visuals) {
        const positions = inner.cells?.geometry.attributes.position
        if (!positions) continue
        inner.body.updateMatrix()
        inner.group.updateMatrix()
        const matrix = new THREE.Matrix4().multiplyMatrices(group.matrix, inner.group.matrix).multiply(inner.body.matrix)
        for (let index = 0; index < positions.count; index++)
          targets.push(new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(matrix))
      }
      const attribute = visual.cells.geometry.attributes.aTarget as THREE.BufferAttribute
      if (targets.length)
        for (let index = 0; index < attribute.count; index++) {
          const target = targets[Math.floor((index / attribute.count) * targets.length)]!
          attribute.setXYZ(index, target.x, target.y, target.z)
        }
      attribute.needsUpdate = true
    }
    return level
  }

  const rootGroup = new THREE.Group()
  scene.add(rootGroup)
  const rootLevel = buildLevel(network, rootGroup)

  // A soft ground under the assembly, so it stands somewhere.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uColor: { value: color(theme.ink) }, uOpacity: { value: 0.08 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader:
        'uniform vec3 uColor; uniform float uOpacity; varying vec2 vUv; void main() { float d = length(vUv - 0.5) * 2.0; gl_FragColor = vec4(uColor, uOpacity * smoothstep(1.0, 0.0, d)); }',
    }),
  )
  {
    scene.updateMatrixWorld(true)
    const box = new THREE.Box3()
    for (const visual of rootLevel.visuals) box.expandByObject(visual.shell)
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    ground.rotation.x = -Math.PI / 2
    ground.position.set(center.x, box.min.y - 0.45, center.z)
    ground.scale.set(size.x * 1.5 + 2, size.z * 2 + size.y + 2, 1)
    ground.renderOrder = -1
    scene.add(ground)
  }

  // Where the person is: what is open, pulled out and selected.
  let openPath = ''
  let selected: string | null = null
  const pulled = new Set<string>()
  const focusNetwork = () => (openPath ? visuals.get(openPath)!.part.inside! : network)
  const ownerOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

  // Remembering across reloads and revisions.
  type Remembered = {
    model?: ReturnType<ModelState['snapshot']>
    open?: string
    pulled?: Record<string, Vec3>
    selected?: string | null
    known?: Array<string>
  }
  let collection: { get: (key: string) => unknown; set: (key: string, value: unknown) => Promise<void> } | undefined
  let saveTimer = 0
  const save = () => {
    if (!collection) return
    clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      const value: Remembered = {
        model: model.snapshot(),
        open: openPath,
        pulled: Object.fromEntries([...pulled].map((path) => [path, visuals.get(path)!.moved.toArray()])),
        selected,
        known: [...allParts(network)].map((part) => part.path),
      }
      void collection?.set('spatial', value).catch(() => {})
    }, 250)
  }
  const theorem = (window as unknown as { theorem?: { state: (name: string) => Promise<NonNullable<typeof collection>> } }).theorem
  if (options.remember && theorem) {
    void theorem
      .state(options.remember)
      .then((opened) => {
        collection = opened
        const remembered = opened.get('spatial') as Remembered | undefined
        if (!remembered) return
        if (remembered.model) model.restore(remembered.model)
        settled = model.settle()
        previous = settled
        if (remembered.open && visuals.has(remembered.open.split('/')[0]!)) {
          // Open each level down to where the person was.
          let path = ''
          for (const id of remembered.open.split('/')) {
            const next = path ? `${path}/${id}` : id
            const visual = visuals.get(next)
            if (!visual?.part.inside) break
            insideOf(visual)
            path = next
          }
          openPath = path
        }
        for (const [path, moved] of Object.entries(remembered.pulled ?? {})) {
          const visual = visuals.get(path)
          if (!visual) continue
          visual.moved.set(...moved)
          pulled.add(path)
        }
        if (remembered.selected && visuals.has(remembered.selected)) select(remembered.selected)
        renderCrumbs()
        frame(true)
        // A part the last revision did not have arrives lit, so it can be found.
        const known = new Set(remembered.known ?? [])
        if (known.size)
          for (const part of allParts(network)) {
            const visual = visuals.get(part.path)
            if (!known.has(part.path) && visual) visual.activity = 1.6
          }
        changed(true)
      })
      .catch(() => {})
  }

  // Values.
  function changed(jump = false) {
    previous = jump ? model.settle() : settled
    settled = model.settle()
    const different = new Set<string>()
    for (const [path, now] of settled.readings) {
      const before = previous.readings.get(path)
      if (!before || JSON.stringify(before.outputs) !== JSON.stringify(now.outputs) || JSON.stringify(before.inputs) !== JSON.stringify(now.inputs))
        different.add(path)
    }
    const end = timeline()
    replay = { time: jump || reduced ? end : 0, end, paused: false, changed: different }
    if (!jump) for (const path of different) {
      const visual = visuals.get(path)
      if (visual) visual.activity = Math.max(visual.activity, 0.001)
    }
    renderBar()
    renderCard()
    renderOutline()
    save()
  }

  function set(path: string, key: string, value: unknown) {
    model.set(path, key, value)
    changed()
  }

  function step() {
    previous = settled
    model.step(settled)
    changed()
  }

  // Camera.
  const fly = { from: new THREE.Vector3(), to: new THREE.Vector3(), lookFrom: new THREE.Vector3(), lookTo: new THREE.Vector3(), t: 1 }
  function frame(instant = false) {
    const box = new THREE.Box3()
    scene.updateMatrixWorld(true)
    const level = openPath ? visuals.get(openPath)!.inside! : rootLevel
    if (openPath) box.setFromObject(visuals.get(openPath)!.shell)
    else for (const visual of level.visuals) box.expandByObject(visual.shell)
    const sphere = box.getBoundingSphere(new THREE.Sphere())
    const aspect = camera.aspect || 1
    const fit = Math.max(sphere.radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)), sphere.radius / Math.sin(Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * aspect)))
    const distance = fit * (openPath ? 1.1 : 1.12)
    fly.from.copy(camera.position)
    fly.lookFrom.copy(controls.target)
    fly.lookTo.copy(sphere.center)
    fly.to.copy(sphere.center).addScaledVector(FRAMING, distance)
    fly.t = instant || reduced ? 1 : 0
    if (fly.t === 1) {
      camera.position.copy(fly.to)
      controls.target.copy(fly.lookTo)
    }
    controls.minDistance = distance * 0.3
    controls.maxDistance = distance * 2.6
    camera.near = distance / 200
    camera.far = distance * 40
    camera.updateProjectionMatrix()
  }

  function open(path: string) {
    if (path && !visuals.get(path)?.part.inside) return
    if (path) {
      // Every level above it opens too.
      const ids = path.split('/')
      for (let depth = 1; depth <= ids.length; depth++) insideOf(visuals.get(ids.slice(0, depth).join('/'))!)
    }
    openPath = path
    if (selected && !(ownerOf(selected) === path)) selected = null
    timeline()
    frame()
    renderCrumbs()
    renderCard()
    renderOutline()
    renderBar()
    save()
  }

  function pull(path: string | null) {
    if (path === null) {
      for (const each of pulled) visuals.get(each)?.moved.set(0, 0, 0)
      pulled.clear()
    } else if (visuals.get(path)?.part.spec.movable !== false) pulled.add(path)
    renderCard()
    save()
  }

  function select(path: string | null) {
    selected = path && visuals.has(path) ? path : null
    const label = selected ? (visuals.get(selected)!.part.spec.label ?? selected) : ''
    for (const target of [renderer.domElement, card]) {
      if (selected) {
        target.setAttribute('data-entity-id', selected)
        target.setAttribute('data-entity-label', `${label} (${selected})`)
      } else {
        target.removeAttribute('data-entity-id')
        target.removeAttribute('data-entity-label')
      }
    }
    renderCard()
    save()
  }

  // Beside the model.
  function renderCrumbs() {
    crumbs.replaceChildren()
    const ids = openPath ? openPath.split('/') : []
    const steps = [{ path: '', label: options.title ?? 'Model' }, ...ids.map((_, index) => {
      const path = ids.slice(0, index + 1).join('/')
      return { path, label: visuals.get(path)!.part.spec.label ?? path }
    })]
    steps.forEach((step, index) => {
      if (index) crumbs.append(Object.assign(document.createElement('span'), { textContent: '/' }))
      const button = document.createElement('button')
      button.textContent = step.label
      if (index < steps.length - 1) button.onclick = () => open(step.path)
      else button.setAttribute('aria-current', 'location')
      crumbs.append(button)
    })
  }

  function chip(text: string, onClick: () => void, pressed?: boolean) {
    const button = document.createElement('button')
    button.className = 'ts-chip'
    button.textContent = text
    if (pressed !== undefined) button.setAttribute('aria-pressed', String(pressed))
    button.onclick = onClick
    return button
  }

  function renderBar() {
    bar.replaceChildren()
    if (ticking) {
      bar.append(chip('Step', step))
      bar.append(chip(running ? 'Stop' : 'Run', () => ((running = !running), renderBar()), running))
    }
    bar.append(chip('Slow', () => ((slow = !slow), renderBar()), slow))
    if (replay.time < replay.end) {
      bar.append(chip(replay.paused ? 'Continue' : 'Pause', () => ((replay.paused = !replay.paused), renderBar())))
      const status = document.createElement('span')
      status.className = 'ts-stage'
      status.textContent = `stage ${Math.min(replay.end, Math.floor(replay.time) + 1)} of ${replay.end}`
      bar.append(status)
    }
  }

  const controlFor = (path: string, key: string, value: unknown, spec?: ControlSpec): HTMLElement => {
    if (spec?.kind === 'toggle' || (!spec && isBit(value))) {
      const button = document.createElement('button')
      button.className = 'ts-bit'
      button.textContent = truthy(value) ? '1' : '0'
      button.setAttribute('aria-pressed', String(truthy(value)))
      button.setAttribute('aria-label', `${key} of ${path}`)
      button.onclick = () => set(path, key, typeof value === 'boolean' ? !value : truthy(value) ? 0 : 1)
      return button
    }
    if (spec?.kind === 'bits') {
      const wrap = document.createElement('span')
      for (let index = spec.bits - 1; index >= 0; index--) {
        const on = (Number(value) >> index) & 1
        const button = document.createElement('button')
        button.className = 'ts-bit'
        button.textContent = String(on)
        button.setAttribute('aria-pressed', String(Boolean(on)))
        button.setAttribute('aria-label', `bit ${index} of ${key}`)
        button.onclick = () => set(path, key, Number(value) ^ (1 << index))
        wrap.append(button)
      }
      return wrap
    }
    if (spec?.kind === 'select') {
      const select = document.createElement('select')
      for (const option of spec.options) select.append(new Option(option, option, false, option === value))
      select.onchange = () => set(path, key, select.value)
      return select
    }
    const input = document.createElement('input')
    input.type = spec?.kind === 'range' ? 'range' : 'number'
    if (spec && 'min' in spec && spec.min !== undefined) input.min = String(spec.min)
    if (spec && 'max' in spec && spec.max !== undefined) input.max = String(spec.max)
    if (spec && 'step' in spec && spec.step !== undefined) input.step = String(spec.step)
    input.value = String(value ?? 0)
    input.setAttribute('aria-label', `${key} of ${path}`)
    input.oninput = () => set(path, key, Number(input.value))
    return input
  }

  let cardKey = ''
  /** When a clicked part's card may show: a moment later, so a double-click opens it instead. */
  let cardAt = 0
  function renderCard() {
    if (!selected || performance.now() < cardAt) {
      card.hidden = true
      cardKey = ''
      return
    }
    const visual = visuals.get(selected)!
    const spec = visual.part.spec
    const { inputs, outputs } = valuesOf(selected)
    const state = model.states.get(selected) ?? {}
    const key = JSON.stringify([selected, inputs, outputs, state, pulled.has(selected), openPath])
    if (key === cardKey) return
    // Keep a field the person is typing in.
    if (card.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'number') return
    cardKey = key
    card.replaceChildren()
    card.hidden = false
    const title = document.createElement('h3')
    title.textContent = spec.label ?? spec.id
    card.append(title)
    if (spec.about) card.append(Object.assign(document.createElement('p'), { textContent: spec.about }))
    const table = document.createElement('table')
    const row = (name: string, value: unknown, control?: HTMLElement) => {
      const tr = table.insertRow()
      tr.insertCell().textContent = name
      const cell = tr.insertCell()
      if (control) cell.append(control)
      else cell.textContent = spec.format?.(value, name) ?? short(value)
    }
    for (const port of visual.part.ports) {
      const value = port.dir === 'in' ? inputs[port.name] : outputs[port.name]
      const editable = port.dir === 'in' && model.isPin(selected, port.name)
      row(`${port.dir === 'in' ? '→' : '←'} ${port.label ?? port.name}`, value, editable ? controlFor(selected, port.name, value, spec.controls?.[port.name]) : undefined)
    }
    for (const [name, value] of Object.entries(state))
      row(name, value, spec.controls?.[name] ? controlFor(selected, name, value, spec.controls[name]) : undefined)
    if (table.rows.length) card.append(table)
    const actions = document.createElement('div')
    actions.className = 'ts-actions'
    const path = selected
    if (visual.part.inside) actions.append(chip('Open', () => open(path)))
    if (pulled.has(path)) actions.append(chip('Put back', () => ((visual.moved.set(0, 0, 0), pulled.delete(path)), renderCard(), save())))
    if (actions.childElementCount) card.append(actions)
  }

  function renderOutline() {
    const focus = focusNetwork()
    outline.replaceChildren(
      ...focus.parts.map((part) => {
        const item = document.createElement('div')
        item.setAttribute('role', 'listitem')
        item.setAttribute('data-entity-id', part.path)
        item.textContent = model.describe(part.path, settled)
        return item
      }),
    )
  }

  // Handling.
  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  const pickable = () => {
    const level = openPath ? visuals.get(openPath)!.inside! : rootLevel
    const objects: Array<THREE.Object3D> = []
    for (const visual of level.visuals) {
      objects.push(visual.grip)
      for (const port of visual.ports.values()) objects.push(port.dot)
      for (const handle of visual.handles) objects.push(handle.knob)
    }
    return objects
  }
  const pick = (event: PointerEvent | MouseEvent) => {
    const rect = renderer.domElement.getBoundingClientRect()
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    raycaster.setFromCamera(pointer, camera)
    const hit = raycaster.intersectObjects(pickable(), true)
    // A port or handle in front of its own shell wins.
    const precise = hit.find((each) => each.object.userData.port || each.object.userData.handle)
    return precise ?? hit[0]
  }

  type Drag =
    | { kind: 'part'; path: string; plane: THREE.Plane; grab: THREE.Vector3; start: THREE.Vector3; moved: boolean; x: number; y: number }
    | { kind: 'handle'; path: string; handle: HandleSpec; x: number; y: number }
  let drag: Drag | null = null

  const onDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    const hit = pick(event)
    const path = hit?.object.userData.path as string | undefined
    if (!hit || !path) return
    if (hit.object.userData.handle) {
      const handle = visuals.get(path)!.handles.find((each) => each.spec.key === hit.object.userData.handle)!.spec
      drag = { kind: 'handle', path, handle, x: event.clientX, y: event.clientY }
    } else {
      const visual = visuals.get(path)!
      const normal = camera.getWorldDirection(new THREE.Vector3()).negate()
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit.point)
      drag = { kind: 'part', path, plane, grab: hit.point.clone(), start: visual.moved.clone(), moved: false, x: event.clientX, y: event.clientY }
    }
    controls.enabled = false
    renderer.domElement.setPointerCapture(event.pointerId)
  }

  const onMove = (event: PointerEvent) => {
    if (!drag) {
      const hit = pick(event)
      renderer.domElement.style.cursor = hit?.object.userData.port && model.isPin(hit.object.userData.path, hit.object.userData.port) ? 'pointer' : hit ? 'grab' : ''
      return
    }
    const rect = renderer.domElement.getBoundingClientRect()
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    raycaster.setFromCamera(pointer, camera)
    if (drag.kind === 'handle') {
      const visual = visuals.get(drag.path)!
      const handle = drag.handle
      const axis = new THREE.Vector3(handle.axis === 'x' ? 1 : 0, handle.axis === 'y' ? 1 : 0, handle.axis === 'z' ? 1 : 0)
      const start = visual.body.localToWorld(new THREE.Vector3(...handle.at))
      const end = visual.body.localToWorld(new THREE.Vector3(...handle.at).addScaledVector(axis, handle.length))
      const onAxis = new THREE.Vector3()
      raycaster.ray.distanceSqToSegment(start, end, undefined, onAxis)
      const t = THREE.MathUtils.clamp(onAxis.distanceTo(start) / start.distanceTo(end), 0, 1)
      let value = handle.min + t * (handle.max - handle.min)
      if (handle.step) value = Math.round(value / handle.step) * handle.step
      if (value !== model.value(drag.path, handle.key, settled)) set(drag.path, handle.key, value)
      return
    }
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return
    const visual = visuals.get(drag.path)!
    if (visual.part.spec.movable === false) return
    if (!drag.moved) {
      drag.moved = true
      pulled.add(drag.path)
      select(drag.path)
      renderer.domElement.style.cursor = 'grabbing'
    }
    const point = raycaster.ray.intersectPlane(drag.plane, new THREE.Vector3())
    if (!point) return
    const parent = visual.group.parent!
    const local = parent.worldToLocal(point.clone()).sub(parent.worldToLocal(drag.grab.clone()))
    visual.moved.copy(drag.start).add(local)
  }

  const onUp = (event: PointerEvent) => {
    controls.enabled = true
    const ended = drag
    drag = null
    renderer.domElement.style.cursor = ''
    if (ended?.kind === 'part' && ended.moved) {
      renderCard()
      save()
      return
    }
    if (ended?.kind === 'handle') return
    if (Math.abs(event.clientX - (ended?.x ?? event.clientX)) > 4) return
    const hit = pick(event)
    const path = hit?.object.userData.path as string | undefined
    const port = hit?.object.userData.port as string | undefined
    if (path && port && model.isPin(path, port)) {
      // A click on an input no wire reaches changes it: a bit flips.
      const value = model.value(path, port, settled)
      if (isBit(value) || value === undefined) set(path, port, typeof value === 'boolean' ? !value : truthy(value) ? 0 : 1)
    }
    cardAt = performance.now() + 260
    select(path ?? null)
  }

  const onDouble = (event: MouseEvent) => {
    const hit = pick(event)
    const path = hit?.object.userData.path as string | undefined
    cardAt = path && visuals.get(path)?.part.inside ? Infinity : 0
    if (path && visuals.get(path)?.part.inside) open(path)
    else if (!path) {
      if (pulled.size) pull(null)
      else if (openPath) open(ownerOf(openPath))
    }
  }

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    // A card button that re-rendered leaves focus on the body, so Esc is heard from the document.
    const focused = element.ownerDocument.activeElement
    if (focused && focused !== element.ownerDocument.body && !root.contains(focused)) return
    if (pulled.size) pull(null)
    else if (selected) select(null)
    else if (openPath) open(ownerOf(openPath))
  }

  renderer.domElement.addEventListener('pointerdown', onDown)
  renderer.domElement.addEventListener('pointermove', onMove)
  renderer.domElement.addEventListener('pointerup', onUp)
  renderer.domElement.addEventListener('dblclick', onDouble)
  element.ownerDocument.addEventListener('keydown', onKey)

  // Drawing.
  const scratch = { a: new THREE.Vector3(), b: new THREE.Vector3(), na: new THREE.Vector3(), nb: new THREE.Vector3() }
  const portWorld = (endpoint: Wire['from'], out: THREE.Vector3, normal: THREE.Vector3) => {
    const visual = visuals.get(endpoint.part)!
    const port = visual.ports.get(endpoint.port)!
    out.copy(port.local)
    visual.body.localToWorld(out)
    normal.copy(port.normal).transformDirection(visual.body.matrixWorld)
    // A wire to the part's own port from inside leaves it inward.
    if (endpoint.boundary) normal.negate()
  }

  const worldScale = (object: THREE.Object3D) => object.getWorldScale(new THREE.Vector3()).x

  function drawWires(level: Level, visible: number, dt: number) {
    for (const wire of level.wires) {
      wire.fade = ease(wire.fade, visible, 8, dt)
      wire.mesh.visible = wire.fade > 0.02
      if (!wire.mesh.visible) {
        wire.pulse.visible = false
        continue
      }
      portWorld(wire.wire.from, scratch.a, scratch.na)
      portWorld(wire.wire.to, scratch.b, scratch.nb)
      const scale = worldScale(level.group)
      const ends = [scratch.a, scratch.b].map((point) => point.toArray().map((n) => n.toFixed(4)).join()).join('|')
      const distance = scratch.a.distanceTo(scratch.b)
      if (ends !== wire.ends) {
        wire.ends = ends
        const reach = Math.max(0.25 * scale, distance * 0.4)
        const lift = new THREE.Vector3(0, 0, distance * 0.12)
        const curve = new THREE.CubicBezierCurve3(
          scratch.a.clone(),
          scratch.a.clone().addScaledVector(scratch.na, reach).add(lift),
          scratch.b.clone().addScaledVector(scratch.nb, reach).add(lift),
          scratch.b.clone(),
        )
        wire.mesh.geometry.dispose()
        wire.mesh.geometry = new THREE.TubeGeometry(curve, 40, 0.018 * scale, 6)
        wire.mesh.userData.curve = curve
      }
      const sourcePath = wire.wire.from.boundary ? null : wire.wire.from.part
      const value = wire.wire.from.boundary
        ? valuesOf(wire.wire.from.part).inputs[wire.wire.from.port]
        : valuesOf(wire.wire.from.part).outputs[wire.wire.from.port]
      const on = truthy(value)
      wire.mesh.material.color.copy(color(on ? theme.lit : theme.faint))
      wire.mesh.material.opacity = (on ? 0.95 : 0.6) * wire.fade
      // A change travels the wire after its source fires.
      if (replay.time < replay.end && (sourcePath ? replay.changed.has(sourcePath) : replay.changed.has(wire.wire.from.part))) {
        const start = sourcePath ? (fireTime.get(sourcePath) ?? 0) + 0.5 : (fireTime.get(wire.wire.to.part) ?? 0) - 0.5
        wire.travel = THREE.MathUtils.clamp(replay.time - start, -1, 1)
      } else wire.travel = -1
      const curve = wire.mesh.userData.curve as THREE.CubicBezierCurve3 | undefined
      wire.pulse.visible = Boolean(curve) && wire.travel >= 0 && wire.travel < 1
      if (wire.pulse.visible && curve) {
        wire.pulse.position.copy(curve.getPoint(wire.travel))
        wire.pulse.scale.setScalar(0.06 * scale)
        wire.pulse.material.color.copy(color(on ? theme.lit : theme.faint))
        wire.pulse.material.opacity = wire.fade
      }
    }
  }

  const clock = new THREE.Clock()
  let visible = true
  let disposed = false
  frame(true)
  renderCrumbs()
  renderBar()
  renderOutline()

  function animate() {
    if (disposed) return
    requestAnimationFrame(animate)
    if (!visible) return
    const dt = Math.min(clock.getDelta(), 0.05)
    const time = clock.elapsedTime
    if (fly.t < 1) {
      fly.t = Math.min(1, fly.t + dt / 0.85)
      const t = 1 - Math.pow(1 - fly.t, 3)
      camera.position.lerpVectors(fly.from, fly.to, t)
      controls.target.lerpVectors(fly.lookFrom, fly.lookTo, t)
    }
    controls.update()
    if (replay.time < replay.end && !replay.paused) {
      const before = Math.floor(replay.time)
      replay.time = Math.min(replay.end, replay.time + dt * (slow ? 1 : pace))
      if (Math.floor(replay.time) !== before || replay.time >= replay.end) {
        renderBar()
        renderCard()
      }
    }
    if (running && time - lastStepAt > 0.6 && replay.time >= replay.end) {
      lastStepAt = time
      step()
    }

    const anyPulled = pulled.size > 0
    const toCamera = new THREE.Vector3()
    for (const visual of visuals.values()) {
      const path = visual.part.path
      const inFocus = ownerOf(path) === openPath
      const isOpen = path === openPath || openPath.startsWith(`${path}/`)
      const inside = openPath !== '' && path.startsWith(`${openPath}/`) && !inFocus
      const parentVisible = ownerOf(path) === '' || visuals.get(ownerOf(path))!.morph > 0.5
      // How present it is: the open network in full, what is around it ghosted.
      const target = isOpen ? 0.06 : inFocus ? 1 : inside ? 0 : parentVisible ? 0.12 : 0
      visual.fade = ease(visual.fade, parentVisible || inFocus ? target : 0, reduced ? 60 : 6, dt)
      visual.morph = ease(visual.morph, isOpen ? 1 : 0, reduced ? 60 : 3.2, dt)
      const isPulled = pulled.has(path)
      visual.pull = ease(visual.pull, isPulled ? 1 : 0, reduced ? 60 : 7, dt)
      visual.recede = ease(visual.recede, inFocus && anyPulled && !isPulled ? 1 : 0, reduced ? 60 : 5, dt)
      // Pulled toward the camera, the rest a little away from it.
      const parent = visual.group.parent!
      toCamera.copy(parent.worldToLocal(camera.position.clone())).sub(visual.home).normalize()
      visual.group.position
        .copy(visual.home)
        .add(visual.moved)
        .addScaledVector(toCamera, visual.pull * Math.max(visual.size.x, visual.size.y) * 0.7 - visual.recede * 0.5)
      visual.group.scale.setScalar(1 + visual.pull * 0.12)
      const dim = 1 - visual.recede * 0.55
      const values = valuesOf(path)
      // A part with no outputs (a lamp, a gauge) shows what reaches it.
      const shown = visual.part.ports.some((port) => port.dir === 'out') ? values.outputs : values.inputs
      const lit = Object.values(shown).some(truthy) ? 1 : 0
      visual.lit = ease(visual.lit, lit, 6, dt)
      // A part fires when the replay reaches it.
      if (replay.changed.has(path) && replay.time < replay.end) {
        const since = replay.time - (fireTime.get(path) ?? 0)
        if (since >= 0 && since < 0.2 && !replay.paused) visual.activity = 1
      }
      visual.activity = ease(visual.activity, 0, reduced ? 60 : 2.2, dt)
      const opacity = visual.fade * dim
      visual.group.visible = opacity > 0.01
      if (visual.own)
        (visual.materials[0] as THREE.MeshStandardMaterial).color
          .copy(color(visual.part.spec.color ?? theme.surface))
          .lerp(color(theme.lit), visual.lit * 0.35 + Math.min(1, visual.activity) * 0.25)
      visual.materials.forEach((material, index) => {
        material.opacity = visual.baseOpacity[index]! * Math.max(opacity, isOpen ? 0.25 : 0) * (isOpen ? 0.3 : 1)
        material.depthWrite = false
      })
      ;(visual.edges.material as THREE.LineBasicMaterial).opacity = 0.55 * opacity * (path === selected ? 1.6 : 1)
      ;(visual.edges.material as THREE.LineBasicMaterial).color.copy(color(path === selected ? theme.accent : theme.faint))
      if (visual.cells) {
        const uniforms = visual.cells.material.uniforms
        uniforms.uTime!.value = reduced ? 0 : time
        uniforms.uActivity!.value = Math.min(1, visual.activity)
        uniforms.uMorph!.value = visual.morph
        uniforms.uLit!.value = visual.lit
        uniforms.uScale!.value = (renderer.domElement.clientHeight / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * worldScale(visual.body)
        // Once the part is open its cells have become its inner parts' cells.
        uniforms.uOpacity!.value = 0.62 * (isOpen ? Math.max(0, 1 - visual.morph * 1.4) + (visual.morph < 0.98 ? 0.15 : 0) : opacity)
        uniforms.uColor!.value.copy(color(visual.part.spec.color ?? theme.ink))
        uniforms.uLitColor!.value.copy(color(theme.lit))
      }
      const labelVisible = inFocus && opacity > 0.3
      visual.label.visible = labelVisible
      const element = visual.label.element
      // A part that has stepped back for the one in hand says less.
      element.style.opacity = String(1 - visual.recede * 0.75)
      const output = Object.entries(values.outputs).slice(0, 3).map(([name, value]) => `${name} ${visual.part.spec.format?.(value, name) ?? short(value)}`).join('  ')
      const text = `${visual.part.spec.label ?? visual.part.spec.id}`
      if (element.dataset.text !== text + output) {
        element.dataset.text = text + output
        element.replaceChildren(text)
        if (output) element.append(Object.assign(document.createElement('small'), { textContent: output }))
      }
      for (const port of visual.ports.values()) {
        const value = port.dir === 'in' ? values.inputs[port.name] : values.outputs[port.name]
        // Port values are shown for the part in hand, and for the open part's boundary.
        port.tag.visible = (labelVisible && (path === selected || pulled.has(path))) || (isOpen && path === openPath && visual.morph > 0.5)
        const tag = `${port.name} ${visual.part.spec.format?.(value, port.name) ?? short(value)}`
        if (port.tag.element.textContent !== tag) port.tag.element.textContent = tag
        port.tag.element.classList.toggle('on', truthy(value))
        ;(port.dot.material as THREE.MeshBasicMaterial).color.copy(color(truthy(value) ? theme.lit : model.isPin(path, port.name) && port.dir === 'in' ? theme.accent : theme.faint))
        ;(port.dot.material as THREE.MeshBasicMaterial).opacity = Math.max(opacity, isOpen ? 1 : 0)
        port.dot.visible = opacity > 0.05 || isOpen
      }
      for (const handle of visual.handles) {
        const value = Number(model.value(path, handle.spec.key, settled) ?? handle.spec.min)
        const t = THREE.MathUtils.clamp((value - handle.spec.min) / (handle.spec.max - handle.spec.min || 1), 0, 1)
        const axis = new THREE.Vector3(handle.spec.axis === 'x' ? 1 : 0, handle.spec.axis === 'y' ? 1 : 0, handle.spec.axis === 'z' ? 1 : 0)
        handle.knob.position.set(...handle.spec.at).addScaledVector(axis, t * handle.spec.length)
        handle.knob.visible = handle.track.visible = inFocus
      }
      visual.part.spec.show?.(visual.shell, {
        values: { ...values.inputs, ...values.outputs },
        state: model.states.get(path) ?? {},
        activity: Math.min(1, visual.activity),
      })
    }
    ground.material.uniforms.uOpacity!.value = ease(ground.material.uniforms.uOpacity!.value as number, openPath ? 0.03 : 0.08, 4, dt)
    ground.material.uniforms.uColor!.value.copy(color(theme.ink))
    scene.updateMatrixWorld()
    // Wires of the open network in full; the ones around it ghosted.
    const drawLevel = (level: Level, owner: string) => {
      const inFocus = owner === openPath
      const above = openPath === '' ? false : owner === '' ? true : openPath.startsWith(`${owner}/`)
      const visibleness = inFocus ? 1 : above ? 0.12 : 0
      drawWires(level, visibleness, dt)
      for (const visual of level.visuals) if (visual.inside) drawLevel(visual.inside, visual.part.path)
    }
    drawLevel(rootLevel, '')

    // The card stays beside the selected part.
    if (selected && !card.hidden) {
      const visual = visuals.get(selected)!
      const box = new THREE.Box3().setFromObject(visual.shell)
      const rect = root.getBoundingClientRect()
      let right = -Infinity
      let left = Infinity
      let top = Infinity
      let bottom = -Infinity
      for (const x of [box.min.x, box.max.x])
        for (const y of [box.min.y, box.max.y])
          for (const z of [box.min.z, box.max.z]) {
            const projected = new THREE.Vector3(x, y, z).project(camera)
            const px = ((projected.x + 1) / 2) * rect.width
            const py = ((1 - projected.y) / 2) * rect.height
            right = Math.max(right, px)
            left = Math.min(left, px)
            top = Math.min(top, py)
            bottom = Math.max(bottom, py)
          }
      const width = card.offsetWidth
      const height = card.offsetHeight
      let x: number
      let y: number
      if (right + 16 + width < rect.width) [x, y] = [right + 16, top]
      else if (left - 16 - width > 0) [x, y] = [left - 16 - width, top]
      else {
        // No room beside it: below the part, or above it, or along the bottom edge.
        x = (rect.width - width) / 2
        y = bottom + 12 + height < rect.height - 44 ? bottom + 12 : top - 12 - height > 40 ? top - 12 - height : rect.height - height - 48
      }
      card.style.left = `${Math.round(THREE.MathUtils.clamp(x, 8, rect.width - width - 8))}px`
      // The bar along the bottom stays in reach.
      card.style.top = `${Math.round(THREE.MathUtils.clamp(y, 40, rect.height - height - 48))}px`
    } else if (selected && card.hidden && performance.now() >= cardAt) renderCard()
    renderer.render(scene, camera)
    labels.render(scene, camera)
  }

  const resize = () => {
    const width = root.clientWidth
    const height = root.clientHeight
    if (!width || !height) return
    renderer.setSize(width, height, false)
    hint.hidden = width < 640
    labels.setSize(width, height)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
  }
  const resizer = new ResizeObserver(() => {
    resize()
    if (fly.t >= 1 && !drag) frame(true)
  })
  resizer.observe(root)
  resize()
  frame(true)
  const watcher = new IntersectionObserver(([entry]) => {
    visible = Boolean(entry?.isIntersecting)
    clock.getDelta()
  })
  watcher.observe(root)
  // The page's theme can change under the App: draw with what it is now.
  const themer = new MutationObserver(() => {
    theme = readTheme()
    paint()
    cardKey = ''
    renderCard()
  })
  themer.observe(document.documentElement, { attributes: true })
  themer.observe(document.head, { childList: true, subtree: true, characterData: true })
  const scheme = matchMedia('(prefers-color-scheme: dark)')
  const onScheme = () => {
    theme = readTheme()
    paint()
  }
  scheme.addEventListener('change', onScheme)
  requestAnimationFrame(animate)

  return {
    set,
    value: (path, key) => model.value(path, key, settled),
    step,
    open,
    pull,
    select,
    inspect: () => {
      scene.updateMatrixWorld()
      return {
        open: openPath,
        selected,
        stage: replay.time >= replay.end ? replay.end : Math.floor(replay.time) + 1,
        failures,
        parts: [...allParts(network)]
          .filter((part) => !part.path.includes('/') || visuals.has(part.path))
          .map((part) => {
            const visual = visuals.get(part.path)
            const reading = settled.readings.get(part.path)
            const world = visual ? visual.group.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3()
            const at = world.toArray()
            const projected = world.clone().project(camera)
            const screen: [number, number] | null =
              visual?.group.visible && Math.abs(projected.z) <= 1
                ? [Math.round(((projected.x + 1) / 2) * root.clientWidth), Math.round(((1 - projected.y) / 2) * root.clientHeight)]
                : null
            return {
              path: part.path,
              label: part.spec.label ?? part.spec.id,
              inputs: reading?.inputs ?? {},
              outputs: reading?.outputs ?? {},
              state: model.states.get(part.path) ?? {},
              at: at.map((n) => Math.round(n * 1000) / 1000) as Vec3,
              screen,
              pulled: pulled.has(part.path),
            }
          }),
      }
    },
    dispose: () => {
      disposed = true
      resizer.disconnect()
      watcher.disconnect()
      themer.disconnect()
      scheme.removeEventListener('change', onScheme)
      element.ownerDocument.removeEventListener('keydown', onKey)
      controls.dispose()
      renderer.dispose()
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.LineSegments) {
          object.geometry.dispose()
          for (const material of [object.material].flat()) material.dispose()
        }
      })
      root.remove()
    },
  }
}
