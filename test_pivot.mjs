// node test_pivot.mjs  (after npm run build — imports the BUILT module)
import assert from 'node:assert'
import { objectBase, objPosition, pivotFromGroup, rotate } from './web/js/nkd_pivot.js'

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) < tol, `${msg}: ${a} vs ${b}`)
const V = (x, y, z) => ({ x, y, z })
// Euler XYZ -> quaternion, the same order three's Euler('XYZ') uses.
const quat = (rx, ry, rz) => {
  const [x, y, z] = [rx, ry, rz].map((d) => (d * Math.PI) / 180 / 2)
  const c1 = Math.cos(x), c2 = Math.cos(y), c3 = Math.cos(z)
  const s1 = Math.sin(x), s2 = Math.sin(y), s3 = Math.sin(z)
  return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3,
          c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3]
}
// The scene graph as built: group at (pivot + Pos) with q,s — the model held at −pivot inside.
const group = (pos, pivot) => V(pos.x + pivot.x, pos.y + pivot.y, pos.z + pivot.z)
const world = (x, pos, pivot, q, s) => {
  const g = group(pos, pivot)
  const r = rotate(V((x.x - pivot.x) * s, (x.y - pivot.y) * s, (x.z - pivot.z) * s), q)
  return V(r.x + g.x, r.y + g.y, r.z + g.z)
}
const same = (a, b, tol, msg) => { for (const k of 'xyz') near(a[k], b[k], tol, `${msg} ${k}`) }

const q = quat(-24.6, 40, 12)
const s = 1.7
const pos = V(0.3, 0.42, 2.5)
const p0 = V(0.1, -0.8, 0.2)
const probe = V(2, -3, 0.5) // any point of the model

// 1. THE POINT OF THE REWRITE: the gizmo is drawn at the attached object's origin, and that
//    origin must be the pivot — not some q·s-skewed placeholder off in the world.
same(group(pos, p0), V(p0.x + pos.x, p0.y + pos.y, p0.z + pos.z), 1e-12, 'gizmo sits on the pivot')
same(world(p0, pos, p0, q, s), group(pos, p0), 1e-12, 'pivot is the fixed point')

// 2. Rotate/scale with the gizmo (group q,s change, position untouched) turn about the pivot.
const spun = world(p0, pos, p0, quat(30, 0, 0), 4)
same(spun, world(p0, pos, p0, q, s), 1e-12, 'pivot held under a spin')

// 3. Alt: the user drags the gizmo (the group) by delta. Holding the object's base fixed gives
//    the implied pivot — and every point of the object must land exactly where it was.
const base = objectBase(group(pos, p0), p0, q, s)
const dragged = V(group(pos, p0).x + 1.3, group(pos, p0).y + 0.7, group(pos, p0).z - 2.1)
const p1 = pivotFromGroup(dragged, base, q, s)
const pos1 = objPosition(base, p1, q, s)
same(group(pos1, p1), dragged, 1e-12, 'gizmo followed the drag')
same(world(probe, pos1, p1, q, s), world(probe, pos, p0, q, s), 1e-12, 'object moved')

// 4. Control: the same pivot swap WITHOUT re-deriving Pos does move the object — so test 3
//    is not passing by accident.
const bad = world(probe, pos, p1, q, s)
const ref = world(probe, pos, p0, q, s)
assert.ok(Math.hypot(bad.x - ref.x, bad.y - ref.y, bad.z - ref.z) > 1,
  'control: a bare pivot swap must move the object')

// 5. Switching preset (Bottom -> Center) keeps the object still through the same base.
const pc = V(0.1, 0.35, 0.2)
const posC = objPosition(base, pc, q, s)
same(world(probe, posC, pc, q, s), ref, 1e-12, 'preset switch moved the object')

// 6. Fit to ground: the world pivot is pivot + Pos, so Pos = -pivot drops the bbox's floor
//    centre on the origin (Pos = 0 would leave it wherever the mesh was authored).
const foot = V(0.7, -1.25, -0.4)
same(world(foot, V(-foot.x, -foot.y, -foot.z), foot, quat(0, 0, 0), 2 / 3.4), V(0, 0, 0), 1e-12, 'fit')

console.log('pivot: 6/6 OK')
