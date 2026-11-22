// SOURCING: none: the view's own wire routing, kept here so what measures the
// arrangements (scripts/e2e/arrangement-metrics.ts) measures the drawn routes.

import * as THREE from 'three'

/**
 * A signal's route in its level's own frame: a stub straight out of each
 * port, then runs along the level's axes with as few bends as reach (a
 * right angle here may look oblique once projected, which keeps the model's
 * depth), each bend rounded a little so the tube stays whole. `dA` and `dB`
 * are the directions the ports face.
 */
export function routeInPlane(
  A: THREE.Vector3,
  dA: THREE.Vector3,
  B: THREE.Vector3,
  dB: THREE.Vector3,
): THREE.CurvePath<THREE.Vector3> {
  const stub = Math.max(0.14, A.distanceTo(B) * 0.12)
  const P = A.clone().addScaledVector(dA, stub)
  const Q = B.clone().addScaledVector(dB, stub)
  // Ports face along x (west in, east out) unless their part turned them.
  const along = Math.abs(dA.y) > Math.abs(dA.x) ? 'y' : 'x'
  const across = along === 'x' ? 'y' : 'x'
  const forward = Math.sign(dA[along]) * (Q[along] - P[along]) >= 0
  const points = [A, P]
  if (forward) {
    // Out, across at the middle, in.
    const middle = (P[along] + Q[along]) / 2
    points.push(P.clone().setComponent(along === 'x' ? 0 : 1, middle), Q.clone().setComponent(along === 'x' ? 0 : 1, middle))
  } else {
    // Back past both ends, around the side between them.
    const middle = (P[across] + Q[across]) / 2
    points.push(P.clone().setComponent(across === 'x' ? 0 : 1, middle), Q.clone().setComponent(across === 'x' ? 0 : 1, middle))
  }
  points.push(Q, B)
  const kept = points.filter((point, index) => index === 0 || point.distanceTo(points[index - 1]!) > 1e-4)
  const path = new THREE.CurvePath<THREE.Vector3>()
  let from = kept[0]!.clone()
  for (let index = 1; index < kept.length; index++) {
    const corner = kept[index]!
    const next = kept[index + 1]
    if (!next) {
      path.add(new THREE.LineCurve3(from, corner.clone()))
      break
    }
    const radius = Math.min(0.05, corner.distanceTo(from) / 2, corner.distanceTo(next) / 2)
    const enter = corner.clone().addScaledVector(from.clone().sub(corner).normalize(), radius)
    const leave = corner.clone().addScaledVector(next.clone().sub(corner).normalize(), radius)
    if (enter.distanceTo(from) > 1e-5) path.add(new THREE.LineCurve3(from, enter))
    path.add(new THREE.QuadraticBezierCurve3(enter, corner.clone(), leave))
    from = leave
  }
  return path
}
