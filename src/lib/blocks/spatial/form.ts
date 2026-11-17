// SOURCING: three.js geometries (RoundedBoxGeometry, ExtrudeGeometry,
// LatheGeometry, TubeGeometry and the primitives) build every form, and
// BufferGeometryUtils merges a group for sampling; a recipe
// is only a compact way to name one. A part can instead give a function that
// builds any three.js geometry or object itself.

import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Vec3 } from './engine'

export type Form =
  | { shape: 'box'; size: Vec3; radius?: number }
  | { shape: 'sphere'; radius: number }
  | { shape: 'cylinder'; radius: number; height: number; axis?: 'x' | 'y' | 'z' }
  | { shape: 'cone'; radius: number; height: number; axis?: 'x' | 'y' | 'z' }
  | { shape: 'torus'; radius: number; tube: number }
  | { shape: 'capsule'; radius: number; length: number; axis?: 'x' | 'y' | 'z' }
  /** A 2D outline in x/y extruded along z, centred on z. */
  | { shape: 'extrude'; outline: Array<[number, number]>; depth: number; bevel?: number }
  /** A profile of [radius, height] points turned around y. */
  | { shape: 'lathe'; profile: Array<[number, number]> }
  /** A tube along a path of points. */
  | { shape: 'tube'; path: Array<Vec3>; radius: number }
  /** Several forms as one, each offset. */
  | { shape: 'group'; parts: Array<{ form: Form; at?: Vec3; rotate?: Vec3 }> }
  /** Anything three.js can build: a geometry, or a whole object with its own materials. */
  | ((three: typeof THREE) => THREE.BufferGeometry | THREE.Object3D)

const AXIS: Record<'x' | 'y' | 'z', THREE.Euler> = {
  x: new THREE.Euler(0, 0, Math.PI / 2),
  y: new THREE.Euler(0, 0, 0),
  z: new THREE.Euler(Math.PI / 2, 0, 0),
}

const turned = (geometry: THREE.BufferGeometry, axis: 'x' | 'y' | 'z' = 'y') =>
  geometry.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(AXIS[axis]))

/** The geometry of a recipe, or what a form function built. */
export function buildForm(form: Form): THREE.BufferGeometry | THREE.Object3D {
  if (typeof form === 'function') return form(THREE)
  switch (form.shape) {
    case 'box': {
      const [x, y, z] = form.size
      const radius = Math.min(form.radius ?? 0.12, x / 2, y / 2, z / 2)
      return radius > 0 ? new RoundedBoxGeometry(x, y, z, 3, radius) : new THREE.BoxGeometry(x, y, z)
    }
    case 'sphere':
      return new THREE.SphereGeometry(form.radius, 32, 20)
    case 'cylinder':
      return turned(new THREE.CylinderGeometry(form.radius, form.radius, form.height, 32), form.axis)
    case 'cone':
      return turned(new THREE.ConeGeometry(form.radius, form.height, 32), form.axis)
    case 'torus':
      return new THREE.TorusGeometry(form.radius, form.tube, 16, 48)
    case 'capsule':
      return turned(new THREE.CapsuleGeometry(form.radius, form.length, 6, 16), form.axis)
    case 'extrude': {
      const shape = new THREE.Shape(form.outline.map(([x, y]) => new THREE.Vector2(x, y)))
      const bevel = form.bevel ?? 0.04
      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: Math.max(0.001, form.depth - bevel * 2),
        bevelEnabled: bevel > 0,
        bevelSize: bevel,
        bevelThickness: bevel,
        bevelSegments: 2,
      })
      geometry.center()
      return geometry
    }
    case 'lathe':
      return new THREE.LatheGeometry(
        form.profile.map(([r, h]) => new THREE.Vector2(r, h)),
        40,
      ).center()
    case 'tube':
      return new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(form.path.map((p) => new THREE.Vector3(...p))),
        Math.max(16, form.path.length * 12),
        form.radius,
        12,
      )
    case 'group': {
      const group = new THREE.Group()
      for (const piece of form.parts) {
        const built = buildForm(piece.form)
        const object = built instanceof THREE.BufferGeometry ? new THREE.Mesh(built) : built
        if (piece.at) object.position.set(...piece.at)
        if (piece.rotate) object.rotation.set(...piece.rotate)
        group.add(object)
      }
      return group
    }
  }
}

/** One geometry for an object a form built, so cells can be sampled over all of it. */
export function mergedGeometry(object: THREE.Object3D): THREE.BufferGeometry | undefined {
  const pieces: Array<THREE.BufferGeometry> = []
  object.updateMatrixWorld(true)
  const inverse = object.matrixWorld.clone().invert()
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    const geometry = (child.geometry as THREE.BufferGeometry).index
      ? (child.geometry as THREE.BufferGeometry).toNonIndexed()
      : (child.geometry as THREE.BufferGeometry).clone()
    geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, child.matrixWorld))
    for (const name of Object.keys(geometry.attributes))
      if (name !== 'position' && name !== 'normal') geometry.deleteAttribute(name)
    if (!geometry.attributes.normal) geometry.computeVertexNormals()
    pieces.push(geometry)
  })
  // mergeGeometries returns null when the pieces' attributes differ, though its types say otherwise.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return pieces.length ? (mergeGeometries(pieces) ?? undefined) : undefined
}
