// node test_crop_volume.mjs  (after npm run build): the crop volume's maths.
//
// What this pins is the SIGN CONVENTION and the face drag. A flipped normal keeps the outside
// and deletes the model instead of the junk around it, and on a MoGe scene "everything
// vanished" and "nothing vanished" look equally like the feature being broken. Carrying the
// box into place is three's Plane.applyMatrix4 and is not re-tested here.
import { unitFaces, inside, clampHalf, dragFace, MIN_HALF } from './web/js/nkd_crop_volume.js'

const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1) } }
const p = (x, y, z) => ({ x, y, z })
const near = (a, b, t = 1e-9) => Math.abs(a - b) <= t

// 1. The centre of the unit box survives, and each face rejects the point just outside IT.
const faces = unitFaces()
assert(faces.length === 6, 'six faces')
assert(inside(faces, p(0, 0, 0)), 'the centre must survive')
const outs = [
  ['-x', p(-1.001, 0, 0)], ['+x', p(1.001, 0, 0)],
  ['-y', p(0, -1.001, 0)], ['+y', p(0, 1.001, 0)],
  ['-z', p(0, 0, -1.001)], ['+z', p(0, 0, 1.001)],
]
for (const [name, q] of outs) assert(!inside(faces, q), `${name}: a point outside must be clipped`)

// 2. ...and the CONTROL that stops 1 passing by accident: a point just INSIDE each face must
//    still survive. A normal flipped on one axis would clip these while still rejecting those.
for (const q of [p(-0.999, 0, 0), p(0.999, 0, 0), p(0, -0.999, 0), p(0, 0.999, 0), p(0, 0, -0.999), p(0, 0, 0.999)]) {
  assert(inside(faces, q), `just inside (${q.x},${q.y},${q.z}) must survive`)
}

// 3. A corner is in, a point past it on every axis is out.
assert(inside(faces, p(0.99, 0.99, 0.99)), 'inner corner')
assert(!inside(faces, p(1.01, 1.01, 1.01)), 'outer corner')

// 4. Half-extents stay positive. A negative one mirrors the box: every face flips, the inside
//    becomes the outside and the model disappears with no hint of why.
assert(clampHalf(-3) === 3, 'a negative half-extent is mirrored back to positive')
assert(clampHalf(0) === MIN_HALF, 'zero clamps to the floor, never to nothing')
assert(clampHalf(2.5) === 2.5, 'a good value is untouched')

// 5. Dragging a face moves THAT face and leaves the opposite one where it was. This is the
//    whole difference from the gizmo's scale handles, which grow the box both ways at once.
{
  const half = 2, sign = 1, t = 1            // pull the +x face out by 1
  const r = dragFace(half, sign, t)
  assert(near(r.half, 2.5), `half 2 -> 2.5, got ${r.half}`)
  assert(near(r.shift, 0.5), `the centre slides half as far, got ${r.shift}`)
  assert(near(r.shift + r.half, half + t), `the +x face landed where the pointer put it`)
  assert(near(r.shift - r.half, -half), `the -x face moved: ${-half} -> ${r.shift - r.half}`)
}
{
  const half = 2, sign = -1, t = -1          // pull the -x face further out, towards -x
  const r = dragFace(half, sign, t)
  assert(near(r.half, 2.5), `half 2 -> 2.5 off the low face, got ${r.half}`)
  assert(near(r.shift - r.half, -half + t), `the -x face landed where the pointer put it`)
  assert(near(r.shift + r.half, half), `the +x face moved: ${half} -> ${r.shift + r.half}`)
}
{
  const half = 2, sign = 1, t = -1.5         // push the +x face INWARDS
  const r = dragFace(half, sign, t)
  assert(near(r.half, 1.25), `half 2 -> 1.25, got ${r.half}`)
  assert(near(r.shift - r.half, -half), `the -x face must still not move`)
}

// 6. Shoved past its opposite, the face stops at the floor and does NOT drag the box along —
//    the shift is half of what the face ACTUALLY did, not half of what the pointer asked for.
{
  const half = 2, sign = 1, t = -100
  const r = dragFace(half, sign, t)
  assert(r.half === MIN_HALF, `clamped to the floor, got ${r.half}`)
  const before = -half, after = r.shift - r.half
  assert(near(before, after, 1e-9), `the opposite face still holds: ${before} -> ${after}`)
}

console.log('crop volume ok: 6 unit faces both ways, half-extents clamped, face drag pins the opposite face')
