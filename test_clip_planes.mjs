// node test_clip_planes.mjs  (after npm run build — imports the BUILT module)
//
// What the crop box and the floor hand the model's materials. The two share one owner, and
// three bakes the plane COUNT into the shader, so the shape of the answer matters as much as
// its contents: null when nothing clips, never an empty array.
import assert from 'node:assert'
import { clipPlanesFor } from './web/js/nkd_clip_planes.js'

const CROP = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5']
const FLOOR = 'floor'
const call = (o) => clipPlanesFor({ cropPlanes: CROP, floorPlane: FLOOR, ...o })

// Nothing on: null, not [] — an empty array still counts as a clipped material, and the
// caller's "did the count change" test would never fire the shader rebuild.
assert.strictEqual(call({ crop: false, floor: false, isSplat: false }), null, 'both off -> null')

// The floor alone is the common case: one plane, and it is the floor's.
assert.deepStrictEqual(call({ crop: false, floor: true, isSplat: false }), [FLOOR], 'floor alone')

// The crop alone stays exactly what it was before the floor joined: the six half-spaces.
assert.deepStrictEqual(call({ crop: true, floor: false, isSplat: false }), CROP, 'crop alone')

// Together: six plus one, crop first, nothing dropped.
const both = call({ crop: true, floor: true, isSplat: false })
assert.strictEqual(both.length, 7, 'crop + floor is seven planes')
assert.deepStrictEqual(both, [...CROP, FLOOR], 'crop first, floor last')

// A splat is clipped by neither: Spark's shader never receives these, and handing them over
// would rebuild its materials for nothing.
for (const crop of [false, true]) {
  for (const floor of [false, true]) {
    assert.strictEqual(call({ crop, floor, isSplat: true }), null,
      `splat ignores crop=${crop} floor=${floor}`)
  }
}

// The counts the caller compares to decide on needsUpdate have to differ across the states,
// or a toggle leaves the shader built for the wrong number of planes.
const count = (o) => (call(o)?.length ?? 0)
assert.deepStrictEqual(
  [count({ crop: false, floor: false, isSplat: false }),
   count({ crop: false, floor: true, isSplat: false }),
   count({ crop: true, floor: false, isSplat: false }),
   count({ crop: true, floor: true, isSplat: false })],
  [0, 1, 6, 7], 'every state has its own plane count')

// The source array is never handed out, or a later push would mutate the crop's own planes.
both.push('x')
assert.strictEqual(CROP.length, 6, 'the crop planes are not the returned array')

console.log('test_clip_planes: ok')

// The floor's sign, which the generic function above cannot see. three keeps a point where
// normal · p + constant >= 0, so above the floor must come out positive and below negative —
// flipped, the object would lose its top half instead of what it buries.
const { normal, constant } = (await import('./web/js/nkd_clip_planes.js')).FLOOR_HALF_SPACE
const side = (y) => normal[0] * 0 + normal[1] * y + normal[2] * 0 + constant
assert.ok(side(1) > 0, 'a point above the floor is kept')
assert.ok(side(-1) < 0, 'a point below the floor is clipped')
assert.strictEqual(side(0), 0, 'the floor itself is the boundary')
console.log('test_clip_planes: floor sign ok')
