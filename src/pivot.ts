/**
 * Pivot placement for the Preview 3D object transform.
 *
 * The user's transform maps a model point x to  q·s·(x − p) + p + t  (p = pivot, t = the panel's
 * Pos). Carrying that as ONE group forces the group's origin to sit at `p + t − q·s·p`, which is
 * NOT the pivot — and TransformControls draws itself at the attached object's origin, so the
 * gizmo appeared away from the object (at the world origin for a default Pos) and rotated about
 * a point the panel did not agree with.
 *
 * So it is carried as TWO nodes instead: the group sits exactly ON the pivot
 * (`position = p + t`, the pivot's world place) and an inner node holds the model at `−p`.
 * Same map, but now the group's origin IS the pivot: the gizmo lands on it, rotate and scale
 * happen about it for free, and dragging the group in Alt mode moves the pivot itself.
 *
 * `base` is the object's own placement, q·s·x + base — the part that must NOT change while the
 * pivot is being dragged. It is what makes "move the pivot, leave the object" exact rather than
 * compensated after the fact.
 *
 * Deliberately three-free (same reason as depth_range.ts): a module that imports three cannot be
 * asserted from node without dragging the whole library into the build. The quaternion arrives
 * as [x, y, z, w] — three computes it, this only applies it.
 */
export type V3 = { x: number; y: number; z: number }
export type Quat = [number, number, number, number]

const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const add = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })

/** Rotate v by the quaternion — the same expansion three uses in Vector3.applyQuaternion.
 *  `inv` applies the conjugate, which for a unit quaternion is the inverse rotation. */
export function rotate(v: V3, [qx, qy, qz, qw]: Quat, inv = false): V3 {
  if (inv) { qx = -qx; qy = -qy; qz = -qz }
  const ix = qw * v.x + qy * v.z - qz * v.y
  const iy = qw * v.y + qz * v.x - qx * v.z
  const iz = qw * v.z + qx * v.y - qy * v.x
  const iw = -qx * v.x - qy * v.y - qz * v.z
  return {
    x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
    y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
    z: iz * qw + iw * -qz + ix * -qy - iy * -qx,
  }
}

/** Where the object sits regardless of the pivot: base = G − q·s·p, so world(x) = q·s·x + base. */
export function objectBase(gpos: V3, pivot: V3, q: Quat, s: number): V3 {
  return sub(gpos, rotate({ x: pivot.x * s, y: pivot.y * s, z: pivot.z * s }, q))
}

/** Panel Pos that keeps `base` with this pivot: t = base + q·s·p − p. Use after moving the
 *  pivot (by hand or by switching preset) and the object has not budged. */
export function objPosition(base: V3, pivot: V3, q: Quat, s: number): V3 {
  return sub(add(base, rotate({ x: pivot.x * s, y: pivot.y * s, z: pivot.z * s }, q)), pivot)
}

/** The pivot implied by a dragged group position, holding the object still: p = (q·s)⁻¹(G − base). */
export function pivotFromGroup(gpos: V3, base: V3, q: Quat, s: number): V3 {
  const d = rotate(sub(gpos, base), q, true)
  return { x: d.x / s, y: d.y / s, z: d.z / s }
}
