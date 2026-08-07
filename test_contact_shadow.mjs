// Self-check for the contact-shadow rig orientation.  Run: node test_contact_shadow.mjs
//
// Mirrors the rig built by initContactShadow() in src/Preview3DWidget.vue (camera looking up
// from y=0, footprint plane displaying its render target).  Keep the three lines below in sync
// with that function.  It answers one question: does a texel land back on the ground where the
// camera recorded it, or is an axis mirrored?  Run with --bug to see the wrong orientation
// the fixture is guarding against.
import assert from 'node:assert'
import * as THREE from 'three'

const FOOT = 2, SLAB = 1
const MIRROR_BUG = process.argv.includes('--bug') // reproduces the pre-fix orientation

const group = new THREE.Group()

// ── the rig, as in initContactShadow() ────────────────────────────────────────
const geo = new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2)
const plane = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
  side: MIRROR_BUG ? THREE.FrontSide : THREE.BackSide,
}))
if (MIRROR_BUG) plane.rotation.x = Math.PI
plane.position.y = 0.001
plane.scale.set(FOOT, 1, FOOT)
group.add(plane)

const cam = new THREE.OrthographicCamera(-FOOT / 2, FOOT / 2, FOOT / 2, -FOOT / 2, 0, SLAB)
cam.rotation.x = Math.PI / 2
group.add(cam)
// ──────────────────────────────────────────────────────────────────────────────

group.updateMatrixWorld(true)
cam.updateProjectionMatrix()
cam.matrixWorldInverse.copy(cam.matrixWorld).invert()

/** Where the camera writes a world point (framebuffer origin = bottom-left → uv 0,0). */
const toUV = (p) => {
  const n = p.clone().project(cam)
  return [(n.x + 1) / 2, (n.y + 1) / 2]
}
/** Where the display plane draws a given uv, in world space. */
const uvAttr = geo.attributes.uv, posAttr = geo.attributes.position
const fromUV = (u, v) => {
  for (let i = 0; i < uvAttr.count; i++) {
    if (Math.abs(uvAttr.getX(i) - u) < 1e-6 && Math.abs(uvAttr.getY(i) - v) < 1e-6) {
      return new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(plane.matrixWorld)
    }
  }
  throw new Error(`no vertex at uv ${u},${v}`)
}

let mirrored = 0
for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
  const cast = new THREE.Vector3(sx * FOOT / 2, SLAB / 2, sz * FOOT / 2)
  const [u, v] = toUV(cast)
  const shown = fromUV(u, v)
  const ok = Math.abs(shown.x - cast.x) < 1e-6 && Math.abs(shown.z - cast.z) < 1e-6
  if (!ok) mirrored++
  console.log(`caster (x=${cast.x.toFixed(2)} z=${cast.z.toFixed(2)}) -> uv(${u.toFixed(2)},${v.toFixed(2)})` +
    ` -> drawn (x=${shown.x.toFixed(2)} z=${shown.z.toFixed(2)})  ${ok ? 'OK' : 'MIRRORED'}`)
}

// Placement AND visibility: a correctly-placed plane that faces away is still invisible.
// Which side the rasteriser keeps comes from the triangle winding, not the normal attribute.
const idx = geo.index
const [a, b, c] = [0, 1, 2].map(k =>
  new THREE.Vector3().fromBufferAttribute(posAttr, idx.getX(k)).applyMatrix4(plane.matrixWorld))
const windingY = b.sub(a).cross(c.sub(a)).normalize().y
const facesUp = plane.material.side === THREE.DoubleSide ||
  (plane.material.side === THREE.FrontSide) === (windingY > 0)
console.log(`\nwinding points ${windingY > 0 ? 'UP' : 'DOWN'}, side=${plane.material.side}` +
  ` -> visible from above: ${facesUp}`)

if (MIRROR_BUG) {
  assert.strictEqual(mirrored, 4, 'expected the pre-fix rig to mirror every corner')
  console.log('\n--bug: reproduced the mirrored Z (4/4 corners), as expected')
} else {
  assert.strictEqual(mirrored, 0, `${mirrored}/4 corners are mirrored on the ground`)
  assert.ok(facesUp, 'contact plane is not visible from above')
  console.log('\nOK: all 4 corners land where captured, and the plane faces the viewer')
}
