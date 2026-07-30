/**
 * Depth-range geometry for the Preview 3D Depth tab. Plain arrays, no three import: the
 * only non-trivial maths in the feature, so it sits on its own where it can be asserted
 * against outside a browser.
 */

export type V3 = [number, number, number]

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]

/**
 * How level the plane has to be before its ground line is worth drawing. `|up.y|` is the
 * cosine of the camera's pitch, so this hides anything steeper than ~81° down.
 *
 * Not a numerical guard — the maths stays finite well past it. It is that the whole idea
 * degenerates: the steeper the camera, the closer the plane is to PARALLEL with the ground,
 * so the intersection shoots off sideways (the offset goes as 1/|up.y|) and lands nowhere
 * near what you are looking at. Straight down it does not exist at all: every point of the
 * floor is at the same view distance, so no line on the floor can mark one. Better to draw
 * nothing and say so than to draw a line that means nothing.
 */
export const MIN_UP_Y = 0.15

/**
 * Where the near/far plane at view distance `d` cuts the ground (y = 0).
 *
 * The plane faces the camera (normal = view direction), so it projects to the SAME
 * rectangle on screen whatever `d` is — drawing the plane itself shows nothing. Its ground
 * intersection is a line that does move with `d`, which is what reads from the camera.
 *
 * Returns the point where the plane's own centre line reaches the ground plus the
 * direction the ground line runs in, or null when there is no line worth drawing (see
 * MIN_UP_Y: a camera too close to vertical).
 */
export function groundHit(cam: V3, fwd: V3, d: number): { point: V3; dir: V3 } | null {
  const h = cross(fwd, [0, 1, 0]) // horizontal, in the plane: the ground line's direction
  const hl = Math.hypot(h[0], h[1], h[2])
  if (hl < 1e-6) return null
  const dir: V3 = [h[0] / hl, h[1] / hl, h[2] / hl]
  const u = cross(dir, fwd) // still in the plane, perpendicular to the line, points up-ish
  const ul = Math.hypot(u[0], u[1], u[2])
  if (ul < 1e-9 || Math.abs(u[1] / ul) < MIN_UP_Y) return null
  const up: V3 = [u[0] / ul, u[1] / ul, u[2] / ul]
  // Centre of the plane, then slid ALONG it (so the distance stays `d`) down to y = 0.
  const c: V3 = [cam[0] + fwd[0] * d, cam[1] + fwd[1] * d, cam[2] + fwd[2] * d]
  const t = -c[1] / up[1]
  return { point: [c[0] + up[0] * t, c[1] + up[1] * t, c[2] + up[2] * t], dir }
}

/**
 * The view-z interval an axis-aligned box spans — the range near/far have to bracket.
 * All eight corners, not the bounding sphere: the sphere overstates the span and this
 * number is read as a target to dial against.
 */
export function viewZSpan(min: V3, max: V3, cam: V3, fwd: V3): { lo: number; hi: number } {
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < 8; i++) {
    const c: V3 = [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]]
    const z = dot([c[0] - cam[0], c[1] - cam[1], c[2] - cam[2]], fwd)
    if (z < lo) lo = z
    if (z > hi) hi = z
  }
  return { lo, hi }
}
