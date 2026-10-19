/**
 * Crop volume — the six half-spaces of the box, and the guard on its size.
 *
 * Split out of Preview3DWidget.vue with no three import so `node test_crop_volume.mjs` can
 * assert on the SHIPPED function instead of a copy of it. What lives here is the part that is
 * ours and easy to get backwards: the sign convention, and stopping a box from turning inside
 * out. Placing and orienting the box is a matrix, which is three's job (Plane.applyMatrix4 does
 * the normal matrix) and is not re-implemented here.
 *
 * The box is the UNIT box, ±1 on each axis, carried into place by an Object3D whose scale is
 * the half-extents. That is why a rotated crop needs no extra maths: the planes and Spark's box
 * sdf both take the orientation straight off the same matrix.
 */

/** A plane in the convention three's clipper uses: the half-space where n·p + c > 0 is KEPT. */
export type PlaneSpec = { n: [number, number, number]; c: number }

/** The six faces of the unit box, pointing INWARDS.
 *
 *  "Keep x ≥ −1" is `1·x + 1 > 0`, so the normal points into the box and the constant is the
 *  negated bound; the opposite face flips both. Getting either wrong keeps the outside and
 *  throws the model away, which is why this is the piece with a test. */
export function unitFaces(): PlaneSpec[] {
  return [
    { n: [1, 0, 0], c: 1 }, { n: [-1, 0, 0], c: 1 },
    { n: [0, 1, 0], c: 1 }, { n: [0, -1, 0], c: 1 },
    { n: [0, 0, 1], c: 1 }, { n: [0, 0, -1], c: 1 },
  ]
}

/** The rule the GPU applies, for asserting against: a point survives only if every face keeps
 *  it. Points exactly on a face are clipped, matching `> 0`. */
export function inside(faces: PlaneSpec[], p: { x: number; y: number; z: number }): boolean {
  return faces.every((f) => f.n[0] * p.x + f.n[1] * p.y + f.n[2] * p.z + f.c > 0)
}

export const MIN_HALF = 1e-3

/** Half-extents can only be positive. The gizmo's scale handles will happily drag a component
 *  through zero and out the far side, and a negative one mirrors the box: every face flips, the
 *  inside becomes the outside, and the model vanishes with no hint of why. */
export function clampHalf(v: number): number {
  return Math.max(MIN_HALF, Math.abs(v))
}

/** Where a face lands after being dragged along its own axis, and what that does to the box.
 *
 *  Dragging one face must leave the OPPOSITE one where it is — that is the whole difference
 *  between this and the gizmo's scale handles, which grow the box both ways about its centre.
 *  So the half-extent takes the whole movement and the centre takes half of it.
 *
 *  `half` is the current half-extent on that axis, `sign` is which of the two faces is being
 *  dragged (+1 or −1) and `t` is how far it moved along the axis, in the box's parent space. */
export function dragFace(half: number, sign: number, t: number): { half: number; shift: number } {
  // Moving ONE face by t grows the box by t and its HALF-extent by t/2, while the centre slides
  // t/2 to keep the other face still. Taking the whole t into the half-extent is the obvious
  // wrong answer: it moves both faces and the box creeps away under the pointer.
  const next = Math.max(MIN_HALF, half + (sign * t) / 2)
  // Not Math.abs here, unlike clampHalf: a face shoved far past its opposite must STOP at the
  // floor, and abs would fold it back out into a big box instead.
  return { half: next, shift: (next - half) * sign }
}
