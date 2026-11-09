// Self-check for src/pin_solver.ts. Run after `npm run build`: node test_pin_solver.mjs
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'

const dir = new URL('./web/js/', import.meta.url)
const file = readdirSync(dir).find((f) => f.startsWith('nkd_pin_solver'))
const { solvePins, project } = await import(new URL(file, dir))

const aspect = 16 / 9
const lookAt = (pos, tanHalf) => {
  // Camera at pos looking at the origin, world up: quaternion from its basis.
  const n = (v) => { const l = Math.hypot(...v); return v.map((a) => a / l) }
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const z = n([pos.x, pos.y, pos.z]), x = n(cross([0, 1, 0], z)), y = cross(z, x)
  const m = [[x[0], y[0], z[0]], [x[1], y[1], z[1]], [x[2], y[2], z[2]]]
  const t = m[0][0] + m[1][1] + m[2][2]
  let q
  if (t > 0) { const s = Math.sqrt(t + 1) * 2; q = [(m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s, s / 4] }
  else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) { const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2; q = [s / 4, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s, (m[2][1] - m[1][2]) / s] }
  else if (m[1][1] > m[2][2]) { const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2; q = [(m[0][1] + m[1][0]) / s, s / 4, (m[1][2] + m[2][1]) / s, (m[0][2] - m[2][0]) / s] }
  else { const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2; q = [(m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, s / 4, (m[1][0] - m[0][1]) / s] }
  return { pos, quat: q, tanHalf }
}
const box = [[-1, 0, -.6], [1, 0, -.6], [1, 0, .6], [-1, 0, .6], [-1, 1, -.6], [1, 1, .6], [.2, 1.4, 0]]
  .map(([x, y, z]) => ({ x, y, z }))
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const pinsFor = (cam, pts = box) => pts.map((world) => ({ world, ndc: project(cam, world, aspect) }))
const opts = (solveLens) => ({ aspect, solveLens, scale: 5 })

const truth = lookAt({ x: 2.5, y: 1.6, z: 3.4 }, 0.42)
const start = lookAt({ x: 3.6, y: 2.4, z: 2.2 }, 0.62)

// 1. Enough pins and a wrong start: the camera AND the lens come back.
{
  const { cam, rms } = solvePins(start, pinsFor(truth), opts(true))
  assert.ok(rms < 1e-5, `rms ${rms}`)
  assert.ok(dist(cam.pos, truth.pos) < 1e-2, `position off by ${dist(cam.pos, truth.pos)}`)
  assert.ok(Math.abs(cam.tanHalf - truth.tanHalf) < 1e-3, `lens ${cam.tanHalf}`)
}
// 2. Control: same pins with the lens held wrong cannot fit. Without this, 1 could pass with the
//    lens term doing nothing.
{
  const { cam, rms } = solvePins(start, pinsFor(truth), opts(false))
  assert.equal(cam.tanHalf, start.tanHalf)
  assert.ok(rms > 1e-3, `a wrong lens must leave error, got ${rms}`)
}
// 3. One pin: it lands, the camera slides, and the view barely turns. The lens never moves.
{
  const pin = { world: box[0], ndc: [0.3, -0.2] }
  const { cam, rms } = solvePins(truth, [pin], opts(true))
  assert.ok(rms < 1e-5, `rms ${rms}`)
  assert.ok(dist(cam.pos, truth.pos) > 1e-2, 'the camera has to move')
  assert.ok(Math.abs(cam.tanHalf - truth.tanHalf) < 2e-2, `lens ${cam.tanHalf}`)
  const dot = Math.abs(cam.quat.reduce((a, v, i) => a + v * truth.quat[i], 0))
  assert.ok(2 * Math.acos(Math.min(1, dot)) < 0.2, 'one pin should mostly move, not turn')
}
// 4. Pins already in place: nothing moves, or a click would nudge the camera.
{
  const { cam } = solvePins(truth, pinsFor(truth), opts(true))
  assert.deepEqual(cam, truth)
}
// 5. A target nothing can reach stays finite, or one bad drag poisons the camera.
{
  const { cam } = solvePins(truth, [{ world: box[0], ndc: [40, 40] }, { world: box[1], ndc: [-40, -40] }], opts(true))
  assert.ok([cam.pos.x, cam.pos.y, cam.pos.z, ...cam.quat, cam.tanHalf].every(Number.isFinite))
}
console.log('pin solver: all checks passed')
