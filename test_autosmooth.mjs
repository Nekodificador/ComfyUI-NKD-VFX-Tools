/**
 * Self-check for the Preview 3D auto-smooth.  node test_autosmooth.mjs [path/to/mesh.glb]
 * (run `npm run build` first — it imports the built module, like test_depth_range.mjs).
 *
 * Without an argument it synthesises the failure mode; pass a real .glb to assert against it.
 *
 * The property under test is the one the eye actually sees: two vertices at the SAME position
 * that the UV unwrap split apart must end up with the SAME normal, or the seam shows as a hard
 * patch outline. `computeVertexNormals` cannot do that — it averages per index — which is why
 * the shipped path welds by position instead.
 */
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { smoothNormalsByPosition } from './web/js/nkd_smooth_normals.js'

/** Minimal GLB reader: enough to pull POSITION + indices out of the first primitive. */
function readGlb(path) {
  const buf = readFileSync(path)
  assert.equal(buf.toString('ascii', 0, 4), 'glTF', 'not a GLB')
  const jsonLen = buf.readUInt32LE(12)
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen))
  const bin = buf.subarray(20 + jsonLen + 8)
  const read = (ai, Ctor, comps) => {
    const acc = json.accessors[ai], view = json.bufferViews[acc.bufferView]
    const start = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0)
    return new Ctor(bin.buffer, bin.byteOffset + start, acc.count * comps)
  }
  const prim = json.meshes[0].primitives[0]
  const INT = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array }
  return {
    hasNormals: 'NORMAL' in prim.attributes,
    position: read(prim.attributes.POSITION, Float32Array, 3),
    index: read(prim.indices, INT[json.accessors[prim.indices].componentType], 1),
  }
}

/** A curved strip cut down the middle by a UV seam: the two halves share the seam's positions
 *  but own separate vertices for them, exactly as an unwrap leaves it. The seam is placed on the
 *  CREST of the curve — that is where the one-ring either side tilts hardest in opposite
 *  directions, so per-index averaging shows its worst. On an inflection the two sides agree and
 *  the test would pass without proving anything. */
function synthesise() {
  const N = 10, pos = [], index = []
  const P = (x, y) => [x / N - 0.5, Math.cos((x / N - 0.5) * Math.PI * 2) * 0.5, y / N - 0.5]
  // Two independent halves, each with its own copy of the shared middle column (x = N/2).
  for (const [x0, x1] of [[0, N / 2], [N / 2, N]]) {
    const base = pos.length / 3
    const cols = x1 - x0
    for (let y = 0; y <= N; y++) for (let x = x0; x <= x1; x++) pos.push(...P(x, y))
    for (let y = 0; y < N; y++) for (let x = 0; x < cols; x++) {
      const a = base + y * (cols + 1) + x
      index.push(a, a + 1, a + cols + 1, a + 1, a + cols + 2, a + cols + 1)
    }
  }
  return { hasNormals: false, position: new Float32Array(pos), index: new Uint32Array(index) }
}

/** Per-index normals — what computeVertexNormals produces, reproduced here as the baseline the
 *  weld has to beat (and as the `orig` the shipped function blends from). */
function perIndexNormals(position, index) {
  const out = new Float32Array(position.length)
  for (let t = 0; t < index.length / 3; t++) {
    const [a, b, c] = [index[t * 3], index[t * 3 + 1], index[t * 3 + 2]]
    const ax = position[a * 3], ay = position[a * 3 + 1], az = position[a * 3 + 2]
    const ux = position[b * 3] - ax, uy = position[b * 3 + 1] - ay, uz = position[b * 3 + 2] - az
    const vx = position[c * 3] - ax, vy = position[c * 3 + 1] - ay, vz = position[c * 3 + 2] - az
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    for (const v of [a, b, c]) { out[v * 3] += nx; out[v * 3 + 1] += ny; out[v * 3 + 2] += nz }
  }
  for (let i = 0; i < out.length / 3; i++) {
    const l = Math.hypot(out[i * 3], out[i * 3 + 1], out[i * 3 + 2]) || 1
    out[i * 3] /= l; out[i * 3 + 1] /= l; out[i * 3 + 2] /= l
  }
  return out
}

/** Groups of vertex indices that sit at the exact same position — the seam splits. */
function coLocated(position) {
  const byPos = new Map()
  for (let i = 0; i < position.length / 3; i++) {
    const k = `${position[i * 3]},${position[i * 3 + 1]},${position[i * 3 + 2]}`
    const g = byPos.get(k); g ? g.push(i) : byPos.set(k, [i])
  }
  return { groups: [...byPos.values()].filter((g) => g.length > 1), unique: byPos.size }
}

/** Worst angle (deg) between the normals of vertices that share a position. 0 = seam is gone. */
function worstSeamGap(normals, groups) {
  let worst = 0
  for (const g of groups)
    for (let j = 1; j < g.length; j++) {
      const d = normals[g[0] * 3] * normals[g[j] * 3] +
                normals[g[0] * 3 + 1] * normals[g[j] * 3 + 1] +
                normals[g[0] * 3 + 2] * normals[g[j] * 3 + 2]
      worst = Math.max(worst, (Math.acos(Math.min(1, Math.max(-1, d))) * 180) / Math.PI)
    }
  return worst
}

const path = process.argv[2]
const { hasNormals, position, index } = path ? readGlb(path) : synthesise()
console.log(path ? `source: ${path}` : 'source: synthetic seam-split strip')

assert.equal(hasNormals, false, 'this check is about meshes that ship NO normals')
const V = position.length / 3
const { groups, unique } = coLocated(position)
assert.ok(groups.length > 0, 'the mesh must actually contain UV-seam splits to be worth testing')
console.log(`  ${V} vertices for ${unique} distinct positions — ${V - unique} seam duplicates`)

// 1. The baseline really is broken: per-index averaging leaves the seam visible.
const orig = perIndexNormals(position, index)
const before = worstSeamGap(orig, groups)
assert.ok(before > 10, `per-index normals must show a seam to fix, got ${before.toFixed(2)}°`)

// 2. The shipped weld closes it. Same position => same normal, to floating-point noise.
const dim = (() => {
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < V; i++) for (let k = 0; k < 3; k++) {
    mn[k] = Math.min(mn[k], position[i * 3 + k]); mx[k] = Math.max(mx[k], position[i * 3 + k])
  }
  return Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2])
})()
const cell = Math.max((dim || 1) * 1e-4, 1e-7)
const welded = smoothNormalsByPosition(position, index, orig, cell, 1, false)
const after = worstSeamGap(welded, groups)
console.log(`  worst seam gap: ${before.toFixed(1)}° per-index  ->  ${after.toFixed(4)}° welded`)
assert.ok(after < 0.05, `the weld must close the seam, still ${after.toFixed(3)}°`)

// 3. It smooths as well as welds — the result is not just the flat normals reshuffled.
let moved = 0
for (let i = 0; i < V; i++) {
  const d = orig[i * 3] * welded[i * 3] + orig[i * 3 + 1] * welded[i * 3 + 1] + orig[i * 3 + 2] * welded[i * 3 + 2]
  if (Math.acos(Math.min(1, Math.max(-1, d))) > 0.02) moved++
}
assert.ok(moved > V * 0.1, `normals must actually move, only ${moved}/${V} did`)
console.log(`  ${((moved / V) * 100).toFixed(0)}% of normals moved by more than ~1°`)

// 4. Every normal is unit length — a degenerate one shades the vertex black.
let worstLen = 0
for (let i = 0; i < V; i++)
  worstLen = Math.max(worstLen, Math.abs(Math.hypot(welded[i * 3], welded[i * 3 + 1], welded[i * 3 + 2]) - 1))
assert.ok(worstLen < 1e-5, `normals must stay unit length, off by ${worstLen}`)

// 5. blend = 0 is a true no-op, so the Smooth slider at 0 cannot change the look.
const untouched = smoothNormalsByPosition(position, index, orig, cell, 0, false)
let worstDrift = 0
for (let i = 0; i < orig.length; i++) worstDrift = Math.max(worstDrift, Math.abs(untouched[i] - orig[i]))
assert.ok(worstDrift < 1e-6, `blend 0 must return the original normals, drifted ${worstDrift}`)

console.log('test_autosmooth OK')
