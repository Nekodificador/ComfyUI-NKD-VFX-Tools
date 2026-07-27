/**
 * 😺NKD plumb-line lens solver.
 *
 * Estimates radial distortion from features the user knows are straight in the
 * world: trace a few of them on the photo, and find the k that makes them
 * straight again once undistorted. No calibration target, no EXIF, no model.
 *
 * ALGORITHM PARITY: the normalisation and the radial model here MUST match
 * nkd_lens_distort.py exactly — isotropic coords divided by the half-diagonal,
 * `undistort` = the bisection inverse of the Brown-Conrady forward map. If you
 * touch the model in one, touch it in the other. Tangential p1/p2 are
 * deliberately not fitted: from a handful of hand-traced lines they are not
 * identifiable, and fitting them just absorbs the user's clicking noise.
 *
 * Runnable check: `node test_plumbline.mjs` (after `npm run build`).
 */

/** A traced feature: normalised [0,1] image coords. Needs >= 3 points — two
 *  points define a straight line by construction and carry no curvature. */
export type PlumbLine = Array<[number, number]>;

export interface PlumbSolution {
  k1: number;
  k2: number;
  /** Residual before solving (at k=0) and after, in normalised units. */
  costBefore: number;
  cost: number;
  /** Lines that actually contributed (>= 3 points). */
  usedLines: number;
}

/** Radius past which the forward map folds — see _fold_radius in the Python. */
export function foldRadius(k1: number, k2: number, k3: number, rMax = 1.8, n = 512): number {
  for (let i = 0; i < n; i++) {
    const r = (rMax * i) / (n - 1);
    const r2 = r * r;
    if (1 + r2 * (3 * k1 + r2 * (5 * k2 + r2 * 7 * k3)) <= 0) return r;
  }
  return rMax;
}

/** Invert r*radial(r) = rd by bisection on the monotone branch. */
export function solveRadius(rd: number, k1: number, k2: number, k3: number,
                            rFold: number, iters = 24): number {
  const rf2 = rFold * rFold;
  const rdMax = rFold * (1 + rf2 * (k1 + rf2 * (k2 + rf2 * k3)));
  const target = Math.min(rd, Math.max(rdMax, 0));
  let lo = 0, hi = rFold;
  for (let i = 0; i < iters; i++) {
    const mid = 0.5 * (lo + hi);
    const m2 = mid * mid;
    if (mid * (1 + m2 * (k1 + m2 * (k2 + m2 * k3))) < target) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Ideal normalised coords -> distorted ones. Radial only (see the note above). */
export function distortNorm(x: number, y: number, k1: number, k2: number,
                            k3: number): [number, number] {
  const r2 = x * x + y * y;
  const rad = 1 + r2 * (k1 + r2 * (k2 + r2 * k3));
  return [x * rad, y * rad];
}

/** Distorted normalised coords -> ideal ones. Radial only (see the note above). */
export function undistortNorm(x: number, y: number, k1: number, k2: number, k3: number,
                              rFold: number): [number, number] {
  const rd = Math.hypot(x, y);
  if (rd < 1e-9) return [x, y];
  const r = solveRadius(rd, k1, k2, k3, rFold);
  const s = r / rd;
  return [x * s, y * s];
}

/** [0,1] image coords -> the isotropic normalised space the model works in
 *  (both axes over the half-diagonal, so r = 1 at the corners). */
export function toNorm(nx: number, ny: number, aspect: number,
                       cx = 0, cy = 0): [number, number] {
  const rRef = Math.sqrt(aspect * aspect + 1);
  return [
    (2 * aspect * (nx - 0.5 - cx * 0.5)) / rRef,
    (2 * (ny - 0.5 - cy * 0.5)) / rRef,
  ];
}

/**
 * Sum of squared perpendicular distances from the undistorted points to their
 * own best-fit line. That total is exactly the smaller eigenvalue of the 2x2
 * scatter matrix, so no eigenvector is needed.
 */
export function lineResidual(pts: Array<[number, number]>): number {
  const n = pts.length;
  if (n < 3) return 0;
  let mx = 0, my = 0;
  for (const p of pts) { mx += p[0]; my += p[1]; }
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) {
    const dx = p[0] - mx, dy = p[1] - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const t = sxx + syy;
  const d = Math.sqrt(Math.max((sxx - syy) * (sxx - syy) + 4 * sxy * sxy, 0));
  return Math.max(0.5 * (t - d), 0);
}

/** Total straightness error of every traced line at a given k. Lower is straighter. */
export function totalCost(lines: PlumbLine[], k1: number, k2: number, k3: number,
                          aspect: number, cx = 0, cy = 0): number {
  const rFold = foldRadius(k1, k2, k3);
  let sum = 0;
  for (const ln of lines) {
    if (ln.length < 3) continue;
    const out: Array<[number, number]> = [];
    for (const [nx, ny] of ln) {
      const [x, y] = toNorm(nx, ny, aspect, cx, cy);
      out.push(undistortNorm(x, y, k1, k2, k3, rFold));
    }
    sum += lineResidual(out);
  }
  return sum;
}

/** Golden-section minimisation of a 1-D function on [lo, hi]. */
function goldenMin(f: (x: number) => number, lo: number, hi: number,
                   iters = 60): { x: number; fx: number } {
  const g = (Math.sqrt(5) - 1) / 2;
  let a = lo, b = hi;
  let c = b - g * (b - a), d = a + g * (b - a);
  let fc = f(c), fd = f(d);
  for (let i = 0; i < iters; i++) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = f(c); }
    else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = f(d); }
  }
  const x = 0.5 * (a + b);
  return { x, fx: Math.min(fc, fd) };
}

/**
 * Fit k1 (and optionally k2) to the traced lines.
 *
 * NESTED search, not coordinate descent: k1 and k2 are strongly correlated, so
 * the cost valley runs diagonally and axis-aligned steps zigzag and stall.
 * Measured on a synthetic moustache lens (k1=-0.26, k2=0.10, cost 4e-14 at the
 * truth) coordinate descent parked at k1=-0.18 with cost 2e-4 and would not
 * move. Profiling k2 out — for each candidate k1, minimise over k2 exactly —
 * makes the outer problem 1-D and unimodal, and it lands on the truth.
 * k3 stays zero: from hand-traced lines it is pure overfit.
 */
export function solvePlumbLines(lines: PlumbLine[], aspect: number,
                                opts: { fitK2?: boolean; cx?: number; cy?: number;
                                        k1Range?: [number, number] } = {}): PlumbSolution {
  const cx = opts.cx ?? 0, cy = opts.cy ?? 0;
  const [lo, hi] = opts.k1Range ?? [-0.6, 0.6];
  const usable = lines.filter((l) => l.length >= 3);
  const costBefore = totalCost(lines, 0, 0, 0, aspect, cx, cy);
  if (usable.length === 0) {
    return { k1: 0, k2: 0, cost: costBefore, costBefore, usedLines: 0 };
  }

  const K2_RANGE: [number, number] = [-0.4, 0.4];
  const bestK2 = (k1v: number) =>
    goldenMin((k) => totalCost(usable, k1v, k, 0, aspect, cx, cy), K2_RANGE[0], K2_RANGE[1], 40);

  let k1: number, k2 = 0;
  if (opts.fitK2) {
    k1 = goldenMin((k) => bestK2(k).fx, lo, hi, 50).x;   // k2 profiled out
    k2 = bestK2(k1).x;
  } else {
    k1 = goldenMin((k) => totalCost(usable, k, 0, 0, aspect, cx, cy), lo, hi).x;
  }
  return {
    k1, k2,
    cost: totalCost(usable, k1, k2, 0, aspect, cx, cy),
    costBefore,
    usedLines: usable.length,
  };
}
