/**
 * fSpy 2-point perspective solver — JS mirror of the Python solver in nkd_fspy_camera.py.
 * Keep the two in sync (algorithm parity). Used for the live numeric readout while dragging;
 * the Python side is authoritative on execute.
 */

export interface FSpyState {
  mode: string;
  vp1: [number, number][]; // 4 points: two line segments [a1,a2, b1,b2], Relative coords (y-down)
  vp2: [number, number][];
  principalPoint: { mode: string; x?: number; y?: number };
  vp1Axis: string; // which world axis (+/-) VP1 maps to, e.g. "x+", "z-"
  vp2Axis: string;
  origin: [number, number]; // where the world origin projects, Relative coords (scene anchor height)
  distance: number;
  // Reference box size in world units, sitting on the ground plane. Optional so
  // states saved before it existed still parse; the solver ignores it entirely
  // (it is a visual gauge for judging the solve, not an input to it).
  box?: { w: number; h: number; d: number };
}

export interface SolveResult {
  ok: boolean;
  fovV: number;   // vertical FOV, radians
  fovH: number;   // horizontal FOV, radians
  focalMm: number; // 35mm-equivalent focal length
  pitchDeg: number; // camera tilt for the readout
  yawDeg: number;
  Fu: [number, number] | null; // vanishing points in Relative coords, for drawing markers
  Fv: [number, number] | null;
  R: number[][];  // camera->world rotation (after axis remap)
  f: number;      // relative focal length (image-plane units)
}

type V2 = [number, number];

function relToImagePlane(p: V2, aspect: number): V2 {
  const [rx, ry] = p;
  if (aspect <= 1) return [(-1 + 2 * rx) * aspect, 1 - 2 * ry];
  return [-1 + 2 * rx, (1 - 2 * ry) / aspect];
}

function imagePlaneToRel(p: V2, aspect: number): V2 {
  const [x, y] = p;
  if (aspect <= 1) return [(x / aspect + 1) / 2, (1 - y) / 2];
  return [(x + 1) / 2, (1 - y * aspect) / 2];
}

function lineIntersect(a1: V2, a2: V2, b1: V2, b2: V2): V2 | null {
  const d1: V2 = [a2[0] - a1[0], a2[1] - a1[1]];
  const d2: V2 = [b2[0] - b1[0], b2[1] - b1[1]];
  const denom = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((b1[0] - a1[0]) * d2[1] - (b1[1] - a1[1]) * d2[0]) / denom;
  return [a1[0] + t * d1[0], a1[1] + t * d1[1]];
}

const AXIS_IDX: Record<string, number> = { x: 0, y: 1, z: 2 };

function det3(m: number[][]): number {
  return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
       - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
       + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}

// Place the VP camera-space directions onto the chosen world axes -> world->cam matrix (or null).
function assignmentMatrix(cu: number[], cv: number[], cw: number[], a1: string, a2: string): number[][] | null {
  const i1 = AXIS_IDX[a1[0]], s1 = a1[1] === "+" ? 1 : -1;
  const i2 = AXIS_IDX[a2[0]], s2 = a2[1] === "+" ? 1 : -1;
  if (i1 === undefined || i2 === undefined || i1 === i2) return null;
  const i3 = [0, 1, 2].find((k) => k !== i1 && k !== i2)!;
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; // columns = images of world axes in camera space
  for (let r = 0; r < 3; r++) { M[r][i1] = s1 * cu[r]; M[r][i2] = s2 * cv[r]; M[r][i3] = cw[r]; }
  if (det3(M) < 0) for (let r = 0; r < 3; r++) M[r][i3] = -cw[r]; // keep it a proper rotation
  return M;
}

export function solve2vp(state: FSpyState, width: number, height: number): SolveResult {
  const fail: SolveResult = { ok: false, fovV: 0, fovH: 0, focalMm: 0, pitchDeg: 0, yawDeg: 0, Fu: null, Fv: null, R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], f: 0 };
  const aspect = width / height;
  const conv = (p: V2) => relToImagePlane(p, aspect);
  const v1 = state.vp1.map(conv);
  const v2 = state.vp2.map(conv);
  const Fu = lineIntersect(v1[0], v1[1], v1[2], v1[3]);
  const Fv = lineIntersect(v2[0], v2[1], v2[2], v2[3]);
  if (!Fu || !Fv) return fail;

  const pp = state.principalPoint || { mode: "center" };
  const P: V2 = pp.mode === "manual" ? conv([pp.x!, pp.y!]) : [0, 0];

  const dot = (Fu[0] - P[0]) * (Fv[0] - P[0]) + (Fu[1] - P[1]) * (Fv[1] - P[1]);
  const fSq = -dot;
  if (fSq <= 0) return fail;
  const f = Math.sqrt(fSq);

  const OFu = [Fu[0] - P[0], Fu[1] - P[1], -f];
  const OFv = [Fv[0] - P[0], Fv[1] - P[1], -f];
  const n = (v: number[]) => Math.hypot(v[0], v[1], v[2]);
  const s1 = n(OFu), s2 = n(OFv);
  const cu = [OFu[0] / s1, OFu[1] / s1, OFu[2] / s1];
  const cv = [OFv[0] / s2, OFv[1] / s2, OFv[2] / s2];
  const cw = [cu[1] * cv[2] - cu[2] * cv[1], cu[2] * cv[0] - cu[0] * cv[2], cu[0] * cv[1] - cu[1] * cv[0]];
  const Moc = assignmentMatrix(cu, cv, cw, state.vp1Axis || "x+", state.vp2Axis || "z+");
  if (!Moc) return fail;                                // both VPs on the same axis
  const R = [                                           // camera->world = transpose(world->cam)
    [Moc[0][0], Moc[1][0], Moc[2][0]],
    [Moc[0][1], Moc[1][1], Moc[2][1]],
    [Moc[0][2], Moc[1][2], Moc[2][2]],
  ];

  const halfH = aspect <= 1 ? 1 : 1 / aspect;
  const halfW = aspect <= 1 ? aspect : 1;
  const fovV = 2 * Math.atan(halfH / f);
  const fovH = 2 * Math.atan(halfW / f);
  const focalMm = 36 / (2 * Math.tan(fovH / 2));

  // Camera Euler angles (approx, for the readout): pitch from forward vector, yaw about world Y.
  const fwd = [-R[0][2], -R[1][2], -R[2][2]]; // camera looks down local -Z
  const pitchDeg = Math.asin(Math.max(-1, Math.min(1, fwd[1]))) * 180 / Math.PI;
  const yawDeg = Math.atan2(fwd[0], -fwd[2]) * 180 / Math.PI;

  return {
    ok: true, fovV, fovH, focalMm, pitchDeg, yawDeg,
    Fu: imagePlaneToRel(Fu, aspect), Fv: imagePlaneToRel(Fv, aspect),
    R, f,
  };
}

// ── Moving the vanishing points ───────────────────────────────────────────────
// Both the horizon drag (raise/lower pitch) and the VP slide (compress/stretch
// perspective) work the same way: decide where the two VPs should go, then re-aim
// the 4 control lines at them. Shared here so the editor holds no geometry.

export interface LineSnap { key: "vp1" | "vp2"; moverIdx: number; anchor: V2; dist: number }

/** For each control line, the endpoint FARTHEST from its vanishing point becomes the
 *  anchor (stays put, usually the one out near the image edge); the near one moves. */
export function snapshotLines(state: FSpyState, Fu: V2, Fv: V2): LineSnap[] {
  const out: LineSnap[] = [];
  for (const [key, vp] of [["vp1", Fu], ["vp2", Fv]] as const)
    for (const [ia, ib] of [[0, 1], [2, 3]] as const) {
      const A = state[key][ia], B = state[key][ib];
      const dA = Math.hypot(A[0] - vp[0], A[1] - vp[1]), dB = Math.hypot(B[0] - vp[0], B[1] - vp[1]);
      const anchorIdx = dA >= dB ? ia : ib, moverIdx = dA >= dB ? ib : ia;
      const anchor: V2 = [state[key][anchorIdx][0], state[key][anchorIdx][1]];
      const m = state[key][moverIdx];
      out.push({ key, moverIdx, anchor, dist: Math.hypot(m[0] - anchor[0], m[1] - anchor[1]) });
    }
  return out;
}

/** Pivot each snapshotted line about its anchor so it points at the VP's new spot,
 *  keeping its original length. Writes straight into `state`. */
export function reaimLines(state: FSpyState, lines: LineSnap[], FuN: V2, FvN: V2): void {
  const cl = (v: number) => Math.max(0, Math.min(1, v));
  for (const ln of lines) {
    const vp = ln.key === "vp1" ? FuN : FvN;
    const vx = vp[0] - ln.anchor[0], vy = vp[1] - ln.anchor[1];
    const len = Math.hypot(vx, vy);
    if (len < 1e-6) continue;
    state[ln.key][ln.moverIdx] = [cl(ln.anchor[0] + ln.dist * vx / len), cl(ln.anchor[1] + ln.dist * vy / len)];
  }
}

/** Slide a point by `t` along the direction A->B (the horizon), so a VP pushed in or
 *  out stays exactly on the horizon — which is what keeps the solve two-point. */
export function slideAlong(p: V2, A: V2, B: V2, t: number): V2 {
  const dx = B[0] - A[0], dy = B[1] - A[1], len = Math.hypot(dx, dy);
  if (len < 1e-9) return [p[0], p[1]];
  return [p[0] + (dx / len) * t, p[1] + (dy / len) * t];
}

/**
 * Push both vanishing points apart (k>1) or together (k<1) along the horizon, which is
 * the same as changing the lens: wide apart = long lens, close together = wide angle.
 *
 * They are scaled about the FOOT of the principal point on the horizon, not about their
 * own midpoint. That foot is the point the solve measures the focal length from
 * (f² = -(Fu-P)·(Fv-P)), so scaling about it moves the lens and leaves the camera
 * pointing where it was; scaling about the midpoint would swing the view direction too.
 */
export function spreadVanishingPoints(Fu: V2, Fv: V2, P: V2, k: number): [V2, V2] {
  const dx = Fv[0] - Fu[0], dy = Fv[1] - Fu[1], len2 = dx * dx + dy * dy;
  if (len2 < 1e-18) return [[Fu[0], Fu[1]], [Fv[0], Fv[1]]];
  const t = ((P[0] - Fu[0]) * dx + (P[1] - Fu[1]) * dy) / len2;
  const C: V2 = [Fu[0] + t * dx, Fu[1] + t * dy];
  return [
    [C[0] + (Fu[0] - C[0]) * k, C[1] + (Fu[1] - C[1]) * k],
    [C[0] + (Fv[0] - C[0]) * k, C[1] + (Fv[1] - C[1]) * k],
  ];
}

/**
 * Build a projector: world point -> Relative image coords [0,1] (or null if behind camera).
 * Camera sits at `distance` along its view axis looking at the origin (orientation-only placement),
 * matching the Python camera_info. Used to draw the reference grid/box/axes overlay.
 */
export function makeProjector(res: SolveResult, aspect: number, distance: number, originRel: [number, number] = [0.5, 0.5]): (p: [number, number, number]) => [number, number] | null {
  const R = res.R, f = res.f;
  // Place the camera so the world origin projects to `originRel` (the scene anchor), at `distance`.
  const Po = relToImagePlane(originRel, aspect);
  const s = distance / Math.hypot(Po[0], Po[1], f);
  const oc = [s * Po[0], s * Po[1], -s * f];                                    // world origin in camera space
  const camPos = [
    -(R[0][0] * oc[0] + R[0][1] * oc[1] + R[0][2] * oc[2]),                     // camPos = -R * origin_cam
    -(R[1][0] * oc[0] + R[1][1] * oc[1] + R[1][2] * oc[2]),
    -(R[2][0] * oc[0] + R[2][1] * oc[1] + R[2][2] * oc[2]),
  ];
  return (Pw) => {
    const v = [Pw[0] - camPos[0], Pw[1] - camPos[1], Pw[2] - camPos[2]];
    const xc = R[0][0] * v[0] + R[1][0] * v[1] + R[2][0] * v[2];   // world->cam = R^T
    const yc = R[0][1] * v[0] + R[1][1] * v[1] + R[2][1] * v[2];
    const zc = R[0][2] * v[0] + R[1][2] * v[1] + R[2][2] * v[2];
    if (zc > -1e-4) return null;                                   // behind camera
    return imagePlaneToRel([f * xc / -zc, f * yc / -zc], aspect);
  };
}
