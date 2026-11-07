/**
 * Camera from pins: the object stays put and the camera moves so each pin's model point lands on
 * its target in the image. Same job as a PnP, but it has to behave with ONE pin as well as with
 * ten, because it runs on every pointer move while the pins are still being placed.
 *
 * So it is damped least squares from the current pose rather than a closed-form solve: with too
 * few pins the problem is underdetermined and the damping picks the smallest change. The weights
 * say what "small" means, and they are the interaction design: moving the camera is cheap, turning
 * it costs more, and the lens costs most. One pin therefore slides the camera without changing the
 * perspective, and the lens only moves once the pins actually need it.
 *
 * Three-free like pivot.ts, so it can be asserted from node. Targets are NDC (x right, y up).
 */
import { rotate, type Quat, type V3 } from './pivot'

export type PinCam = { pos: V3; quat: Quat; tanHalf: number } // tanHalf: tan(vertical fov / 2)
export type Pin = { world: V3; ndc: [number, number] }
export type PinOpts = { aspect: number; solveLens: boolean; scale: number } // scale: distance to the object

const W_MOVE = 1, W_TURN = 4, W_LENS = 16
const MIN_TAN = 0.02, MAX_TAN = 3
const STEP = 1e-5

export function project(c: PinCam, x: V3, aspect: number): [number, number] | null {
  const p = rotate({ x: x.x - c.pos.x, y: x.y - c.pos.y, z: x.z - c.pos.z }, c.quat, true)
  if (p.z > -1e-6) return null // behind the camera: no image point
  return [p.x / -p.z / (c.tanHalf * aspect), p.y / -p.z / c.tanHalf]
}

function mulQuat([ax, ay, az, aw]: Quat, [bx, by, bz, bw]: Quat): Quat {
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}

/** d = [move xyz in the camera's own axes, in units of `scale`; turn xyz, radians; log lens]. */
function nudge(c: PinCam, d: number[], scale: number): PinCam {
  const t = rotate({ x: d[0] * scale, y: d[1] * scale, z: d[2] * scale }, c.quat)
  const a = Math.hypot(d[3], d[4], d[5])
  const s = a > 1e-12 ? Math.sin(a / 2) / a : 0.5
  const q = mulQuat(c.quat, [d[3] * s, d[4] * s, d[5] * s, Math.cos(a / 2)])
  const n = Math.hypot(...q)
  return {
    pos: { x: c.pos.x + t.x, y: c.pos.y + t.y, z: c.pos.z + t.z },
    quat: q.map((v) => v / n) as Quat,
    tanHalf: Math.min(MAX_TAN, Math.max(MIN_TAN, c.tanHalf * Math.exp(d[6]))),
  }
}

function residuals(c: PinCam, pins: Pin[], aspect: number): number[] | null {
  const r: number[] = []
  for (const p of pins) {
    const s = project(c, p.world, aspect)
    if (!s) return null
    r.push(s[0] - p.ndc[0], s[1] - p.ndc[1])
  }
  return r
}

const cost = (r: number[]) => r.reduce((a, v) => a + v * v, 0)

/** Gaussian elimination with pivoting; A is small and damped, so it is never singular here. */
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let i = 0; i < n; i++) {
    let p = i
    for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k
    ;[M[i], M[p]] = [M[p], M[i]]
    for (let k = i + 1; k < n; k++) {
      const f = M[k][i] / M[i][i]
      for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j]
    }
  }
  const x = new Array(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    let v = M[i][n]
    for (let j = i + 1; j < n; j++) v -= M[i][j] * x[j]
    x[i] = v / M[i][i]
  }
  return x
}

/** Move the camera toward the pins. Returns the start pose untouched if no step improves it. */
export function solvePins(start: PinCam, pins: Pin[], { aspect, solveLens, scale }: PinOpts) {
  let c = start
  let r = residuals(c, pins, aspect)
  if (!r || !pins.length) return { cam: start, rms: Infinity }
  const dims = solveLens ? 7 : 6
  const weights = [W_MOVE, W_MOVE, W_MOVE, W_TURN, W_TURN, W_TURN, W_LENS]
  let lambda = 1e-3
  for (let it = 0; it < 40 && cost(r) > 1e-14; it++) {
    const J: number[][] = []
    for (let k = 0; k < dims; k++) {
      const d = new Array(7).fill(0)
      d[k] = STEP
      const hi = residuals(nudge(c, d, scale), pins, aspect)
      d[k] = -STEP
      const lo = residuals(nudge(c, d, scale), pins, aspect)
      if (!hi || !lo) return { cam: c, rms: Math.sqrt(cost(r) / pins.length) }
      J.push(hi.map((v, i) => (v - lo[i]) / (2 * STEP)))
    }
    const g = J.map((col) => col.reduce((a, v, i) => a + v * r![i], 0))
    const H = J.map((a) => J.map((b) => a.reduce((s, v, i) => s + v * b[i], 0)))
    let improved = false
    while (lambda < 1e8) {
      const A = H.map((row, i) => row.map((v, j) => (i === j ? v + lambda * weights[i] : v)))
      const step = solveLinear(A, g.map((v) => -v))
      const d = new Array(7).fill(0)
      step.forEach((v, i) => { d[i] = v })
      const next = nudge(c, d, scale)
      const nr = residuals(next, pins, aspect)
      if (nr && cost(nr) < cost(r)) {
        c = next; r = nr; lambda = Math.max(lambda / 3, 1e-7); improved = true
        break
      }
      lambda *= 4
    }
    if (!improved) break
  }
  return { cam: c, rms: Math.sqrt(cost(r) / pins.length) }
}
