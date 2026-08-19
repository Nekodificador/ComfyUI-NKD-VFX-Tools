// node test_view_gizmo.mjs  (after npm run build — imports the BUILT module)
//
// The claim under test: a click landing on the DRAWN axis gizmo is the click ViewHelper
// registers, at any LiteGraph zoom. ViewHelper.render() places the gizmo with offsetWidth
// (unscaled), while handleClick() measures the pointer with getBoundingClientRect()
// (scaled) — so the two only agree at zoom 1 unless the pointer is put back in unscaled space.
import assert from 'node:assert'
import { unscaledRect, unzoomedClient, zoomOf } from './web/js/nkd_view_gizmo.js'

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) < tol, `${msg}: ${a} vs ${b}`)
const W = 500, H = 400, DIM = 128 // DIM is ViewHelper's fixed gizmo box

// Verbatim from three/examples/jsm/helpers/ViewHelper.js (r0.180), the contract we must satisfy.
function helperMouse(rect, offsetWidth, offsetHeight, clientX, clientY) {
  const offsetX = rect.left + (offsetWidth - DIM)
  const offsetY = rect.top + (offsetHeight - DIM)
  return {
    x: ((clientX - offsetX) / (rect.right - offsetX)) * 2 - 1,
    y: -((clientY - offsetY) / (rect.bottom - offsetY)) * 2 + 1,
  }
}
// Where the gizmo is actually DRAWN: bottom-right DIM box in unscaled canvas pixels. Its centre
// in page coordinates, once the canvas is scaled on screen by z and pinned at (px, py).
const drawnCentre = (px, py, z) => ({
  clientX: px + (W - DIM / 2) * z,
  clientY: py + (H - DIM / 2) * z,
})
const pageRect = (px, py, z) => ({
  left: px, top: py, right: px + W * z, bottom: py + H * z, width: W * z, height: H * z,
})

for (const z of [1, 0.6, 1.75, 2.5]) {
  const [px, py] = [37, 91]
  const rect = pageRect(px, py, z)
  near(zoomOf(rect, W), z, 1e-12, `zoom read back at ${z}`)

  // Ours: unscaled pointer + unscaled rect -> the gizmo's own centre, at every zoom.
  const p = unzoomedClient(rect, W, drawnCentre(px, py, z).clientX, drawnCentre(px, py, z).clientY)
  const m = helperMouse(unscaledRect(rect, W, H), W, H, p.clientX, p.clientY)
  near(m.x, 0, 1e-12, `centre x at zoom ${z}`)
  near(m.y, 0, 1e-12, `centre y at zoom ${z}`)

  // A corner of the gizmo box must land on the edge of its normalised square, not past it —
  // catches a compensation that is centred but wrongly scaled.
  const corner = { clientX: px + (W - DIM) * z, clientY: py + (H - DIM) * z }
  const c = unzoomedClient(rect, W, corner.clientX, corner.clientY)
  const mc = helperMouse(unscaledRect(rect, W, H), W, H, c.clientX, c.clientY)
  near(mc.x, -1, 1e-12, `corner x at zoom ${z}`)
  near(mc.y, 1, 1e-12, `corner y at zoom ${z}`)
}

// Control: the raw event straight into the raw rect — the bug this exists to fix. Dead on at
// zoom 1, and reading a different part of the gizmo at a zoom the graph is realistically at.
const at = (z) => {
  const [px, py] = [37, 91]
  const c = drawnCentre(px, py, z)
  return helperMouse(pageRect(px, py, z), W, H, c.clientX, c.clientY)
}
near(at(1).x, 0, 1e-12, 'uncompensated is fine at zoom 1')
// Measured: 0.55 of the way to the edge of the +-1 box, i.e. the click reads as an axis handle
// instead of the centre. Not a subtle drift, and it only shows up once the graph is zoomed.
assert.ok(Math.abs(at(1.75).x) > 0.4, `control: uncompensated must land elsewhere at zoom 1.75, got ${at(1.75).x}`)

console.log('view gizmo: OK')

// ── The orthographic axis view ───────────────────────────────────────────────
// Claim: at the distance being looked at, the ortho twin frames EXACTLY what the lens framed,
// so clicking an axis changes the projection without the subject jumping in size.
import * as THREE from 'three'
import { orthoFrustum } from './web/js/nkd_view_gizmo.js'

const FOV = 42, ASPECT = 16 / 9, DIST = 7.5
const target = new THREE.Vector3(1.2, 0.8, -0.4)

const persp = new THREE.PerspectiveCamera(FOV, ASPECT, 0.01, 1000)
persp.position.copy(target).add(new THREE.Vector3(0, 0, DIST))
persp.lookAt(target)
persp.updateMatrixWorld()

const { halfW, halfH } = orthoFrustum(FOV, ASPECT, persp.position.distanceTo(target))
const ortho = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, persp.near, persp.far)
ortho.position.copy(persp.position)
ortho.quaternion.copy(persp.quaternion)
ortho.updateMatrixWorld()
ortho.updateProjectionMatrix()

// Four points spread over the plane through the target, perpendicular to the view.
for (const [dx, dy] of [[0, 0], [halfW * 0.9, 0], [0, -halfH * 0.9], [-halfW * 0.5, halfH * 0.5]]) {
  const pt = target.clone().add(new THREE.Vector3(dx, dy, 0))
  const a = pt.clone().project(persp), b = pt.clone().project(ortho)
  near(a.x, b.x, 1e-12, `on-plane x (${dx})`)
  near(a.y, b.y, 1e-12, `on-plane y (${dy})`)
}

// Control: off that plane the two MUST differ — that difference is the perspective this view
// exists to remove, so a test that passed everywhere would be testing nothing.
const off = target.clone().add(new THREE.Vector3(halfW * 0.9, 0, DIST * 0.5))
const da = off.clone().project(persp), db = off.clone().project(ortho)
assert.ok(Math.abs(da.x - db.x) > 0.2, `control: off-plane must diverge, got ${Math.abs(da.x - db.x)}`)

console.log('ortho axis view: OK')
