/**
 * Self-check for the Preview 3D depth-range geometry.  node test_depth_range.mjs
 * (run `npm run build` first — it imports the built module).
 *
 * The ground line is defined by two properties, and both are checked directly rather
 * than by re-deriving the formula: the point sits ON the ground (y = 0) and it is at
 * EXACTLY the requested view distance (so what you see is where near/far really are).
 */
import { groundHit, viewZSpan, MIN_UP_Y } from "./web/js/nkd_depth_range.js";

const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };
const near = (a, b, t, m) => ok(Math.abs(a - b) < t, `${m} — got ${a}, want ${b} (±${t})`);

const unit = (v) => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// ── the ground hit, over a spread of camera orientations ────────────────────────────
const CAM = [1.5, 1.8, 4];
const VIEWS = {
  "looking down 30°": unit([0, -Math.sin(Math.PI / 6), -Math.cos(Math.PI / 6)]),
  "horizontal": [0, 0, -1],
  "down 70°, yawed": unit([0.6, -2.5, -1]),
  "looking up 20°": unit([0, Math.sin(Math.PI / 9), -Math.cos(Math.PI / 9)]),
};
for (const [name, fwd] of Object.entries(VIEWS)) {
  for (const d of [0.5, 3, 27.4]) {
    const hit = groundHit(CAM, fwd, d);
    ok(hit, `${name} @ ${d}: expected a ground line`);
    near(hit.point[1], 0, 1e-9, `${name} @ ${d}: point must sit on the ground`);
    // The whole point of the gizmo: the line marks the plane at THAT view distance.
    const z = dot([hit.point[0] - CAM[0], hit.point[1] - CAM[1], hit.point[2] - CAM[2]], fwd);
    near(z, d, 1e-9, `${name} @ ${d}: view distance of the drawn point`);
    // The line runs horizontally and lies in the plane.
    near(hit.dir[1], 0, 1e-12, `${name} @ ${d}: line direction must be horizontal`);
    near(dot(hit.dir, fwd), 0, 1e-12, `${name} @ ${d}: line must lie in the plane`);
    near(Math.hypot(...hit.dir), 1, 1e-12, `${name} @ ${d}: direction must be unit`);
  }
}

// Straight down / straight up: the plane is parallel to the ground — no line exists, and
// the caller must get null rather than a NaN transform that corrupts the scene graph.
ok(groundHit(CAM, [0, -1, 0], 3) === null, "looking straight down must yield no line");
ok(groundHit(CAM, [0, 1, 0], 3) === null, "looking straight up must yield no line");

// And the whole steep band around it, not just the exact pole: a top-down-ish preview is
// where the ground line stops meaning anything, and drawing one there is worse than none.
// |up.y| is cos(pitch), so the cutoff sits at acos(MIN_UP_Y) from horizontal.
const pitched = (deg) => {
  const r = (deg * Math.PI) / 180;
  return unit([0, -Math.sin(r), -Math.cos(r)]);
};
const cutoff = (Math.acos(MIN_UP_Y) * 180) / Math.PI;
ok(cutoff > 75 && cutoff < 88, `cutoff should be a steep angle, is ${cutoff}`);
ok(groundHit(CAM, pitched(cutoff + 2), 3) === null, "steeper than the cutoff: no line");
ok(groundHit(CAM, pitched(cutoff - 2), 3) !== null, "shallower than the cutoff: a line");
// The offset blows up as 1/|up.y| — this is what the cutoff is protecting against. Just
// inside it the line is already far off-axis, and it only gets worse.
{
  const hit = groundHit(CAM, pitched(cutoff - 2), 3);
  const lateral = Math.hypot(hit.point[0] - CAM[0], hit.point[2] - CAM[2]);
  ok(lateral > 3, `near the cutoff the line is already far off-axis, got ${lateral}`);
}

// ── the object's view-z span ────────────────────────────────────────────────────────
// Camera at z=4 looking down -Z at a unit cube on the origin: the near face is at 3.5,
// the far one at 4.5, and the corners' lateral offset does not change view-z.
{
  const s = viewZSpan([-0.5, 0, -0.5], [0.5, 1, 0.5], [0, 0.5, 4], [0, 0, -1]);
  near(s.lo, 3.5, 1e-12, "cube near face");
  near(s.hi, 4.5, 1e-12, "cube far face");
}
// Viewed along the diagonal, the span widens to the box's diagonal extent — the reason
// this uses all eight corners and not just the centre.
{
  const fwd = unit([-1, 0, -1]);
  const s = viewZSpan([-0.5, 0, -0.5], [0.5, 1, 0.5], [4, 0.5, 4], fwd);
  near(s.hi - s.lo, Math.SQRT2, 1e-12, "diagonal view spans the box diagonal");
}

console.log("depth_range: all checks passed");
