/**
 * Self-check for the plumb-line solver.  node test_plumbline.mjs
 * (run `npm run build` first — it imports the built module).
 *
 * The test is a round trip against the model itself: take world-straight lines,
 * push them through the FORWARD distortion to fake a photo shot with a known
 * lens, then check the solver recovers that lens from the bent points alone.
 */
import {
  solvePlumbLines, totalCost, toNorm, foldRadius, solveRadius, undistortNorm, lineResidual,
} from "./web/js/nkd_plumbline.js";

const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };
const near = (a, b, t, m) => ok(Math.abs(a - b) < t, `${m} — got ${a}, want ${b} (±${t})`);

const ASPECT = 16 / 9;
const R_REF = Math.sqrt(ASPECT * ASPECT + 1);

/** Inverse of toNorm: isotropic normalised coords -> [0,1] image coords. */
function fromNorm(x, y) {
  return [x * R_REF / (2 * ASPECT) + 0.5, y * R_REF / 2 + 0.5];
}

/** Forward Brown-Conrady, radial only — the same polynomial as the Python. */
function distortNorm(x, y, k1, k2) {
  const r2 = x * x + y * y;
  const rad = 1 + r2 * (k1 + r2 * k2);
  return [x * rad, y * rad];
}

/** A world-straight segment, sampled and then bent by a known lens. */
function fakePhotoLine(x0, y0, x1, y1, k1, k2, n = 9) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const [nx, ny] = [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
    const [ux, uy] = toNorm(nx, ny, ASPECT);
    out.push(fromNorm(...distortNorm(ux, uy, k1, k2)));
  }
  return out;
}

// 1. The JS inverse matches the JS forward (same contract the Python asserts).
{
  const k1 = -0.28, k2 = 0.05, rFold = foldRadius(k1, k2, 0);
  let worst = 0;
  for (let i = 0; i <= 20; i++) {
    for (let j = 0; j <= 20; j++) {
      const x = -1 + i / 10, y = -1 + j / 10;
      if (Math.hypot(x, y) > Math.min(1, rFold - 1e-3)) continue;
      const [dx, dy] = distortNorm(x, y, k1, k2);
      const [rx, ry] = undistortNorm(dx, dy, k1, k2, 0, rFold);
      worst = Math.max(worst, Math.hypot(rx - x, ry - y));
    }
  }
  ok(worst < 1e-6, `inverse does not invert: ${worst}`);
}

// 2. A genuinely straight line has ~zero residual; a bent one does not.
{
  const straight = [[0.1, 0.5], [0.5, 0.5], [0.9, 0.5]].map(([a, b]) => toNorm(a, b, ASPECT));
  ok(lineResidual(straight) < 1e-12, "a straight line should have no residual");
  const bent = [[0.1, 0.5], [0.5, 0.56], [0.9, 0.5]].map(([a, b]) => toNorm(a, b, ASPECT));
  ok(lineResidual(bent) > 1e-4, "a bent line should have residual");
}

// 3. THE test: recover a known barrel from bent lines. Barrel is the case that
//    matters — it is what real wide lenses do.
for (const truth of [-0.30, -0.18, 0.12, 0.25]) {
  const lines = [
    fakePhotoLine(0.05, 0.12, 0.95, 0.12, truth, 0),   // near the top edge
    fakePhotoLine(0.05, 0.88, 0.95, 0.88, truth, 0),   // near the bottom edge
    fakePhotoLine(0.10, 0.05, 0.10, 0.95, truth, 0),   // left vertical
  ];
  const s = solvePlumbLines(lines, ASPECT);
  near(s.k1, truth, 0.005, `k1 recovery (truth ${truth})`);
  ok(s.cost < s.costBefore, "solving must reduce the residual");
  ok(s.usedLines === 3, `expected 3 usable lines, got ${s.usedLines}`);
}

// 4. Two-parameter recovery (moustache: k1 and k2 of opposite signs).
{
  const T1 = -0.26, T2 = 0.10;
  const lines = [
    fakePhotoLine(0.03, 0.10, 0.97, 0.10, T1, T2, 13),
    fakePhotoLine(0.03, 0.90, 0.97, 0.90, T1, T2, 13),
    fakePhotoLine(0.06, 0.04, 0.06, 0.96, T1, T2, 13),
    fakePhotoLine(0.94, 0.04, 0.94, 0.96, T1, T2, 13),
  ];
  const s = solvePlumbLines(lines, ASPECT, { fitK2: true });
  near(s.k1, T1, 0.02, "k1 with k2 fitted");
  near(s.k2, T2, 0.05, "k2 with k2 fitted");
}

// 5. Lines with < 3 points carry no curvature and must be ignored, not crash.
{
  const s = solvePlumbLines([[[0.1, 0.1], [0.9, 0.9]], [[0.2, 0.2]]], ASPECT);
  ok(s.usedLines === 0, "2-point lines must not be used");
  ok(s.k1 === 0 && s.cost === s.costBefore, "no usable lines must be a no-op");
}

// 6. An undistorted photo must solve to ~0, not to some spurious k.
{
  const lines = [
    fakePhotoLine(0.05, 0.15, 0.95, 0.15, 0, 0),
    fakePhotoLine(0.05, 0.85, 0.95, 0.85, 0, 0),
  ];
  near(solvePlumbLines(lines, ASPECT).k1, 0, 0.005, "a straight photo must solve to k1=0");
}

// 7. Aspect independence: the same physical lens on 16:9 and 1:1 must give the
//    same k1 — the whole point of normalising by the half-diagonal.
{
  const truth = -0.22;
  const forAspect = (aspect) => {
    const rRef = Math.sqrt(aspect * aspect + 1);
    const mk = (x0, y0, x1, y1) => {
      const out = [];
      for (let i = 0; i < 9; i++) {
        const t = i / 8;
        const nx = x0 + (x1 - x0) * t, ny = y0 + (y1 - y0) * t;
        const [ux, uy] = toNorm(nx, ny, aspect);
        const [dx, dy] = distortNorm(ux, uy, truth, 0);
        out.push([dx * rRef / (2 * aspect) + 0.5, dy * rRef / 2 + 0.5]);
      }
      return out;
    };
    return solvePlumbLines([mk(0.05, 0.12, 0.95, 0.12), mk(0.05, 0.88, 0.95, 0.88),
                            mk(0.12, 0.05, 0.12, 0.95)], aspect).k1;
  };
  near(forAspect(16 / 9), forAspect(1), 0.01, "k1 must not depend on aspect ratio");
}

console.log("plumbline self-check OK");
