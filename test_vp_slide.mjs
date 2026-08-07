/**
 * Self-check for the fSpy VP slide gizmo (drag a vanishing point along the horizon).
 *
 *   npm run build && node test_vp_slide.mjs
 *
 * Asserts on the SHIPPED module (web/js/nkd_solver.js), not a re-implementation.
 * What has to hold, and what would silently break it:
 *  - the slid VP stays ON the old horizon      (else the solve stops being 2-point)
 *  - the OTHER VP does not move                (re-aiming must not drag its lines along)
 *  - pushing a VP outward lengthens the lens, pulling it inward widens it — that IS
 *    the "compress / stretch the perspective" the gizmo exists for
 *  - the solve stays valid throughout
 */
import assert from "node:assert";
import { solve2vp, snapshotLines, reaimLines, slideAlong, spreadVanishingPoints } from "./web/js/nkd_solver.js";

const W = 1600, H = 900;
const base = () => ({
  mode: "2point",
  vp1: [[0.10, 0.38], [0.45, 0.30], [0.10, 0.66], [0.45, 0.72]],
  vp2: [[0.55, 0.30], [0.90, 0.38], [0.55, 0.72], [0.90, 0.66]],
  principalPoint: { mode: "center" },
  vp1Axis: "x+", vp2Axis: "z+",
  origin: [0.5, 0.5], distance: 5.0,
});

/** Do what the widget's drag does: snapshot, slide VP1 by t, re-aim, re-solve. */
function slideVp1(t) {
  const st = base();
  const r0 = solve2vp(st, W, H);
  assert.ok(r0.ok, "the default state must solve");
  const lines = snapshotLines(st, r0.Fu, r0.Fv);
  reaimLines(st, lines, slideAlong(r0.Fu, r0.Fu, r0.Fv, t), r0.Fv);
  return { r0, r1: solve2vp(st, W, H) };
}

// Signed distance from the horizon line A->B (0 = exactly on it).
const offHorizon = (p, A, B) => {
  const ax = B[0] - A[0], ay = B[1] - A[1], len = Math.hypot(ax, ay);
  return (ax * (p[1] - A[1]) - ay * (p[0] - A[0])) / len;
};

for (const t of [-0.35, -0.12, 0.12, 0.35]) {
  const { r0, r1 } = slideVp1(t);
  assert.ok(r1.ok, `slide t=${t} must still solve`);
  const off = Math.abs(offHorizon(r1.Fu, r0.Fu, r0.Fv));
  assert.ok(off < 2e-3, `t=${t}: VP1 left the horizon by ${off.toFixed(5)}`);
  const drift = Math.hypot(r1.Fv[0] - r0.Fv[0], r1.Fv[1] - r0.Fv[1]);
  assert.ok(drift < 2e-3, `t=${t}: VP2 drifted ${drift.toFixed(5)} — it must stay put`);
  // Did it actually move? A no-op gizmo would pass everything above.
  const moved = Math.hypot(r1.Fu[0] - r0.Fu[0], r1.Fu[1] - r0.Fu[1]);
  assert.ok(moved > Math.abs(t) * 0.5, `t=${t}: VP1 barely moved (${moved.toFixed(4)})`);
}

// VP1 sits left of centre, so a NEGATIVE t pushes it further out (longer lens) and a
// positive one pulls it toward the principal point (wider lens).
const out = slideVp1(-0.35), inn = slideVp1(0.35);
assert.ok(out.r1.focalMm > out.r0.focalMm, "pushing the VP out must compress the perspective");
assert.ok(inn.r1.focalMm < inn.r0.focalMm, "pulling the VP in must stretch the perspective");
console.log(`focal: in ${inn.r1.focalMm.toFixed(1)}mm < base ${out.r0.focalMm.toFixed(1)}mm < out ${out.r1.focalMm.toFixed(1)}mm`);

// A zero-length drag must change nothing at all, or the gizmo would nudge the solve
// on every click that does not turn into a drag.
const { r0, r1 } = slideVp1(0);
assert.ok(Math.abs(r1.focalMm - r0.focalMm) < 1e-9, "t=0 must be an exact no-op");

// ── Spread slider: both VPs at once, about the principal point's foot on the horizon ──
function spreadBy(k) {
  const st = base();
  const a = solve2vp(st, W, H);
  const lines = snapshotLines(st, a.Fu, a.Fv);
  const [FuN, FvN] = spreadVanishingPoints(a.Fu, a.Fv, [0.5, 0.5], k);
  reaimLines(st, lines, FuN, FvN);
  return { a, b: solve2vp(st, W, H) };
}
const gap = (r) => Math.hypot(r.Fv[0] - r.Fu[0], r.Fv[1] - r.Fu[1]);
for (const k of [0.5, 0.8, 1.25, 2]) {
  const { a, b } = spreadBy(k);
  assert.ok(b.ok, `spread ${k}× must still solve`);
  const ratio = gap(b) / gap(a);
  assert.ok(Math.abs(ratio - k) < 0.02, `spread ${k}×: the gap scaled ${ratio.toFixed(3)}× instead`);
  // Both must stay on the original horizon, or the pair stops describing one ground plane.
  for (const p of [b.Fu, b.Fv])
    assert.ok(Math.abs(offHorizon(p, a.Fu, a.Fv)) < 2e-3, `spread ${k}×: a VP left the horizon`);
  // Apart = longer lens, together = wider. This is the whole point of the control.
  assert.ok(k > 1 ? b.focalMm > a.focalMm : b.focalMm < a.focalMm,
            `spread ${k}×: focal went the wrong way (${a.focalMm.toFixed(1)} -> ${b.focalMm.toFixed(1)})`);
}
{ // Scaling about the principal point must not swing the camera — only the lens.
  const { a, b } = spreadBy(2);
  assert.ok(Math.abs(b.yawDeg - a.yawDeg) < 1.0, `spread swung the yaw ${(b.yawDeg - a.yawDeg).toFixed(2)}°`);
  console.log(`spread 2x: focal ${a.focalMm.toFixed(1)} -> ${b.focalMm.toFixed(1)}mm, yaw ${a.yawDeg.toFixed(2)} -> ${b.yawDeg.toFixed(2)}°`);
}
{ // k=1 is the slider's centre detent: releasing it must not nudge anything.
  const { a, b } = spreadBy(1);
  assert.ok(Math.abs(b.focalMm - a.focalMm) < 1e-9, "spread 1x must be an exact no-op");
}

console.log("test_vp_slide: all assertions passed");
