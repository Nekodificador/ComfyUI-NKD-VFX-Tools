<script setup lang="ts">
import { onMounted, onBeforeUnmount, nextTick, reactive, ref } from "vue";
import { solve2vp, makeProjector, snapshotLines, reaimLines, slideAlong,
         spreadVanishingPoints, type FSpyState, type LineSnap } from "./solver";
import { attachFineRange, isFine, FINE_GAIN } from "./fine_drag";

const props = defineProps<{
  initialUrl?: string;
  initialState?: string;
  onChange?: (json: string) => void;              // live-save the control points
  // The shared chrome (src/nkd_modal.ts) owns the panel, Esc and closing; this
  // component renders only the canvas and teleports its controls into the
  // footer slots. It reports the solve upward instead of closing itself.
  footerLeft?: HTMLElement;
  footerRight?: HTMLElement;
  onSummary?: (summary: { ok: boolean; fovV: number; focal: number }) => void;
}>();

const DEFAULT: FSpyState = {
  mode: "2point",
  vp1: [[0.10, 0.38], [0.45, 0.30], [0.10, 0.66], [0.45, 0.72]],
  vp2: [[0.55, 0.30], [0.90, 0.38], [0.55, 0.72], [0.90, 0.66]],
  principalPoint: { mode: "center" },
  vp1Axis: "x+",
  vp2Axis: "z+",
  origin: [0.5, 0.5],
  distance: 5.0,
  box: { w: 1, h: 1, d: 1 },
};
const state = reactive<FSpyState>(JSON.parse(JSON.stringify(DEFAULT)));
/** States saved before the box existed have no `box` key — never assume it. */
function boxDims() { return state.box ?? (state.box = { w: 1, h: 1, d: 1 }); }
const hud = reactive({ ok: false, fovV: 0, fovH: 0, focal: 0, pitch: 0, yaw: 0 });
const showGrid = ref(true);
const showAxes = ref(true);
const showBox = ref(false);
const showHorizon = ref(true);
const dim = ref(0);        // darken the background image beneath the overlays (0..0.8)

const canvas = ref<HTMLCanvasElement | null>(null);
const wrap = ref<HTMLDivElement | null>(null);
let ctx: CanvasRenderingContext2D | null = null;
let img: HTMLImageElement | null = null;
const imgDim = reactive({ w: 16, h: 9 });
let ro: ResizeObserver | null = null;
let detachFine: (() => void) | null = null;

// Vanishing points wear their axis' colour — the same red/green/blue the axis
// overlay draws — so which line is doing what is readable at a glance instead of
// requiring a look at the VP1→/VP2→ dropdowns.
const AXIS_COLORS: Record<string, string> = { x: "#ff5555", y: "#55ff77", z: "#5599ff" };
const AXIS_FALLBACK = "#ffd166";
function vpColor(key: "vp1" | "vp2"): string {
  const ax = (key === "vp1" ? state.vp1Axis : state.vp2Axis) || "";
  return AXIS_COLORS[ax[0]?.toLowerCase()] ?? AXIS_FALLBACK;
}
const HANDLE_R = 8;
const DPR = () => Math.max(window.devicePixelRatio || 1, 2);

function setImageUrl(url: string) {
  if (!url) return;
  const im = new Image();
  im.crossOrigin = "anonymous";
  im.onload = () => { img = im; imgDim.w = im.naturalWidth || 16; imgDim.h = im.naturalHeight || 9; nextTick(() => { syncSize(); redraw(); }); };
  im.src = url;
}

function dims(): [number, number] { const cv = canvas.value!; const d = DPR(); return [cv.width / d, cv.height / d]; }
function imgRect(): [number, number, number, number] {
  const [W, H] = dims();
  const scale = Math.min(W / imgDim.w, H / imgDim.h);
  const iw = imgDim.w * scale, ih = imgDim.h * scale;
  return [(W - iw) / 2, (H - ih) / 2, iw, ih];
}
function syncSize(): boolean {
  const cv = canvas.value, w = wrap.value;
  if (!cv || !w) return false;
  const rect = w.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  const d = DPR();
  const bw = Math.round(rect.width * d), bh = Math.round(rect.height * d);
  if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
  cv.style.width = rect.width + "px"; cv.style.height = rect.height + "px";
  ctx = cv.getContext("2d");
  return true;
}

function redraw() {
  const cv = canvas.value; if (!cv) return;
  ctx = ctx || cv.getContext("2d"); if (!ctx) return;
  const d = DPR(); ctx.setTransform(d, 0, 0, d, 0, 0);
  const [W, H] = dims();
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0b0d12"; ctx.fillRect(0, 0, W, H);
  const [ix, iy, iw, ih] = imgRect();
  if (img) ctx.drawImage(img, ix, iy, iw, ih);
  else { ctx.fillStyle = "rgba(255,255,255,0.35)"; ctx.font = "13px system-ui"; ctx.fillText("Connect an image to the node's input.", 16, 28); }
  if (img && dim.value > 0) { ctx.fillStyle = `rgba(0,0,0,${dim.value})`; ctx.fillRect(ix, iy, iw, ih); }  // darken under overlays
  const res = solveNow();
  const toPx = (p: [number, number]): [number, number] => [ix + p[0] * iw, iy + p[1] * ih];
  const seg = (a: [number, number], b: [number, number]) => { const pa = toPx(a), pb = toPx(b); ctx!.beginPath(); ctx!.moveTo(pa[0], pa[1]); ctx!.lineTo(pb[0], pb[1]); ctx!.stroke(); };

  // ── 3D reference overlay (grid / axes / box) projected with the solved camera ──
  // Clear the hit-test list first: a degenerate solve draws nothing, and stale
  // entries would leave phantom handles grabbable where nothing is visible.
  boxHandles = [];
  if (res.ok) {
    const aspect = imgDim.w / imgDim.h;
    const proj = makeProjector(res, aspect, state.distance, state.origin);
    const worldSeg = (a: number[], b: number[], steps = 12) => {   // clip against the camera plane
      let prev: [number, number] | null = null;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const rel = proj([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
        const cur = rel ? toPx(rel) : null;
        if (prev && cur) { ctx!.beginPath(); ctx!.moveTo(prev[0], prev[1]); ctx!.lineTo(cur[0], cur[1]); ctx!.stroke(); }
        prev = cur;
      }
    };
    const N = 8;
    if (showGrid.value) {
      ctx.strokeStyle = "rgba(120,180,255,0.35)"; ctx.lineWidth = 1;
      for (let i = -N; i <= N; i++) { worldSeg([i, 0, -N], [i, 0, N]); worldSeg([-N, 0, i], [N, 0, i]); }
    }
    if (showBox.value) {
      ctx.strokeStyle = "#ffd166"; ctx.lineWidth = 2;
      // Sized in world units and standing ON the ground (y from 0), so it reads
      // as an object in the scene you can match against something real.
      const b = boxDims(), hw = b.w / 2, hd = b.d / 2, hh = b.h;
      const c = [[-hw, 0, -hd], [hw, 0, -hd], [hw, 0, hd], [-hw, 0, hd],
                 [-hw, hh, -hd], [hw, hh, -hd], [hw, hh, hd], [-hw, hh, hd]];
      for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) worldSeg(c[a], c[b], 4);

      // Drag handles on the +X, top and +Z faces. Turning a 2D drag into a 3D
      // size needs to know how the projected handle responds to that dimension,
      // so measure it instead of deriving it: project the face centre at the
      // current size and at size+EPS. The difference gives both the screen
      // direction it grows along and the pixels-per-world-unit scale, for any
      // camera the solve produces.
      const EPS = 0.01;
      const FACE = [
        { k: "w" as const, at: (v: number) => [v / 2, b.h / 2, 0] },
        { k: "h" as const, at: (v: number) => [0, v, 0] },
        { k: "d" as const, at: (v: number) => [0, b.h / 2, v / 2] },
      ];
      boxHandles = [];
      for (const f of FACE) {
        const cur = b[f.k];
        const p0 = proj(f.at(cur)), p1 = proj(f.at(cur + EPS));
        if (!p0 || !p1) continue;                       // behind the camera
        const vx = p1[0] - p0[0], vy = p1[1] - p0[1];
        const len = Math.hypot(vx, vy);
        if (len < 1e-9) continue;                       // grows straight at the viewer
        boxHandles.push({ k: f.k, at: p0, dir: [vx / len, vy / len], per: len / EPS });
        const [hx, hy] = toPx(p0);
        ctx!.beginPath(); ctx!.rect(hx - 5, hy - 5, 10, 10);
        ctx!.fillStyle = "#ffd166"; ctx!.fill();
        ctx!.lineWidth = 2; ctx!.strokeStyle = "rgba(0,0,0,0.7)"; ctx!.stroke();
      }
    } else {
      boxHandles = [];
    }
    if (showAxes.value) {
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "#ff5555"; worldSeg([0, 0, 0], [2, 0, 0]);   // X
      ctx.strokeStyle = "#55ff77"; worldSeg([0, 0, 0], [0, 2, 0]);   // Y (up)
      ctx.strokeStyle = "#5599ff"; worldSeg([0, 0, 0], [0, 0, 2]);   // Z
    }
  }

  for (const key of ["vp1", "vp2"] as const) {
    const pts = state[key];
    ctx.strokeStyle = vpColor(key); ctx.lineWidth = 2;
    seg(pts[0], pts[1]); seg(pts[2], pts[3]);
    const vp = key === "vp1" ? res.Fu : res.Fv;
    if (vp) { ctx.globalAlpha = 0.3; seg([(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2], vp); seg([(pts[2][0] + pts[3][0]) / 2, (pts[2][1] + pts[3][1]) / 2], vp); ctx.globalAlpha = 1; }
    for (const p of pts) { const [x, y] = toPx(p); ctx.beginPath(); ctx.arc(x, y, HANDLE_R, 0, Math.PI * 2); ctx.fillStyle = vpColor(key); ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "rgba(0,0,0,0.7)"; ctx.stroke(); }
  }
  // ── Horizon: the line through both vanishing points. Drag it up/down to raise/lower the
  // camera pitch — it translates the 8 handles in Y, moving both VPs and re-aiming everything.
  horizonLine = null; vpGrips = [];
  if (showHorizon.value && res.ok && res.Fu && res.Fv) {
    const A = res.Fu, B = res.Fv, dhx = B[0] - A[0];
    if (Math.abs(dhx) > 1e-6) {                                   // skip a near-vertical horizon
      const yAt = (x: number) => A[1] + (B[1] - A[1]) * (x - A[0]) / dhx;
      horizonLine = { A, B };
      const p0 = toPx([0, yAt(0)]), p1 = toPx([1, yAt(1)]);
      ctx.save();
      ctx.setLineDash([8, 5]); ctx.strokeStyle = "rgba(255,209,102,0.9)"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke();
      ctx.restore();
      const g = toPx([0.5, yAt(0.5)]);                            // draggable grip at mid-width
      ctx.beginPath(); ctx.arc(g[0], g[1], 6, 0, Math.PI * 2); ctx.fillStyle = "#ffd166"; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = "rgba(0,0,0,0.7)"; ctx.stroke();
      ctx.fillStyle = "rgba(0,0,0,0.8)"; ctx.font = "9px system-ui"; ctx.textAlign = "center";
      ctx.fillText("⇕", g[0], g[1] + 3); ctx.textAlign = "left";

      // ── VP slide grips: push a vanishing point in or out ALONG the horizon.
      // Closer to the centre = shorter focal = stretched perspective; farther out =
      // longer lens = compressed. A vanishing point usually lands far off the image,
      // so the grip is clamped to the visible horizon and the drag is geared by how
      // much farther the real VP is — otherwise a distant VP would barely budge.
      const ppx = state.principalPoint?.mode === "manual" ? (state.principalPoint.x ?? 0.5) : 0.5;
      for (const [key, vp] of [["vp1", A], ["vp2", B]] as const) {
        const gx = Math.min(0.94, Math.max(0.06, vp[0]));
        const gain = Math.max(1, Math.abs(vp[0] - ppx) / Math.max(Math.abs(gx - ppx), 1e-3));
        vpGrips.push({ key, at: [gx, yAt(gx)], gain });
        const [x, y] = toPx([gx, yAt(gx)]);
        ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fillStyle = vpColor(key); ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = "rgba(0,0,0,0.7)"; ctx.stroke();
        ctx.fillStyle = "rgba(0,0,0,0.8)"; ctx.font = "9px system-ui"; ctx.textAlign = "center";
        ctx.fillText("⇔", x, y + 3); ctx.textAlign = "left";
      }
    }
  }

  ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 1;
  const c = toPx([0.5, 0.5]); ctx.beginPath(); ctx.moveTo(c[0] - 7, c[1]); ctx.lineTo(c[0] + 7, c[1]); ctx.moveTo(c[0], c[1] - 7); ctx.lineTo(c[0], c[1] + 7); ctx.stroke();

  // Scene anchor (origin) — drag it anywhere: a 2D image position plus the solved
  // camera IS a point on the ground plane, so free dragging already moves it
  // along the ground. Axis-constrained arms were tried and removed: they felt
  // wrong to use and the direct drag does the job.
  const [ox, oy] = toPx(state.origin);
  ctx.beginPath(); ctx.moveTo(ox, oy - 9); ctx.lineTo(ox + 9, oy); ctx.lineTo(ox, oy + 9); ctx.lineTo(ox - 9, oy); ctx.closePath();
  ctx.fillStyle = "#55ff99"; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "rgba(0,0,0,0.7)"; ctx.stroke();

  // Magnifier loupe while dragging — CLEAN image only (no handles/lines), placed next to the cursor,
  // with just a precision crosshair, so you can see the exact pixel under the point.
  if (drag && drag.key !== "horizon" && drag.key !== "vpslide" && drag.key !== "box" && img) {
    const hp = drag.key === "origin" ? state.origin : state[drag.key][drag.idx];
    const [hx, hy] = toPx(hp);
    const z = 3.5, L = 140, m = 8, gap = 22;
    let dx = hx + gap, dy = hy - L - gap;                // near the cursor, upper-right by default
    if (dx + L > W - m) dx = hx - L - gap;               // flip to keep it on-screen
    if (dx < m) dx = m;
    if (dy < m) dy = hy + gap;
    if (dy + L > H - m) dy = H - L - m;

    const scale = iw / imgDim.w;                         // logical canvas px per image px
    const srcPx = L / (z * scale);                       // image-pixel window shown in the loupe
    ctx.save();
    ctx.beginPath(); ctx.rect(dx, dy, L, L); ctx.clip();
    ctx.fillStyle = "#0b0d12"; ctx.fillRect(dx, dy, L, L);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, hp[0] * imgDim.w - srcPx / 2, hp[1] * imgDim.h - srcPx / 2, srcPx, srcPx, dx, dy, L, L);
    if (dim.value > 0) { ctx.fillStyle = `rgba(0,0,0,${dim.value})`; ctx.fillRect(dx, dy, L, L); }
    ctx.restore();
    ctx.strokeStyle = "#4ab4ff"; ctx.lineWidth = 2; ctx.strokeRect(dx, dy, L, L);
    const cx = dx + L / 2, cy = dy + L / 2;              // precision crosshair only
    ctx.strokeStyle = "rgba(255,80,80,0.95)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx - 10, cy); ctx.lineTo(cx + 10, cy); ctx.moveTo(cx, cy - 10); ctx.lineTo(cx, cy + 10); ctx.stroke();
  }
}

function solveNow() {
  const r = solve2vp(state, imgDim.w, imgDim.h);
  hud.ok = r.ok; hud.fovV = r.fovV * 180 / Math.PI; hud.fovH = r.fovH * 180 / Math.PI;
  hud.focal = r.focalMm; hud.pitch = r.pitchDeg; hud.yaw = r.yawDeg;
  // Push it up on every solve: the chrome can be dismissed at any moment (Esc,
  // backdrop) and the node status has to reflect the last state either way.
  props.onSummary?.({ ok: hud.ok, fovV: hud.fovV, focal: hud.focal });
  return r;
}
function emit() { props.onChange?.(JSON.stringify(state)); }

// ── Dragging ──────────────────────────────────────────────────────────────────
let drag: { key: "vp1" | "vp2" | "origin" | "horizon" | "box" | "vpslide"; idx: number } | null = null;
const BOX_ORDER = ["w", "h", "d"] as const;
/** Face-centre handles, rebuilt on every redraw: where each sits on screen, which
 *  way it grows, and how far it travels per world unit. */
let boxHandles: { k: "w" | "h" | "d"; at: [number, number]; dir: [number, number]; per: number }[] = [];
let boxSnap: { k: "w" | "h" | "d"; val: number; lastN: [number, number];
               dir: [number, number]; per: number } | null = null;
// Horizon line (through the two VPs), in Relative coords — set each redraw, used for hit-testing.
let horizonLine: { A: [number, number]; B: [number, number] } | null = null;
// The two "slide this VP along the horizon" grips, likewise rebuilt every redraw.
let vpGrips: { key: "vp1" | "vp2"; at: [number, number]; gain: number }[] = [];
// Snapshot taken when a horizon or VP-slide drag starts: where the VPs were, and the 4 control
// lines pivoting about their far endpoints (see snapshotLines/reaimLines in solver.ts).
let horizonSnap: {
  start: [number, number];
  Fu: [number, number]; Fv: [number, number];
  gain: number;                       // VP-slide only: screen travel -> VP travel
  slide: "vp1" | "vp2" | null;        // null = horizon drag (both VPs move in Y)
  lines: LineSnap[];
} | null = null;
function eventNorm(e: PointerEvent): [number, number] {
  const cv = canvas.value!; const rect = cv.getBoundingClientRect();
  const [lw, lh] = dims();
  const px = (e.clientX - rect.left) * (lw / rect.width), py = (e.clientY - rect.top) * (lh / rect.height);
  const [ix, iy, iw, ih] = imgRect();
  return [(px - ix) / iw, (py - iy) / ih];
}
function hitTest(n: [number, number]): { key: "vp1" | "vp2" | "origin" | "horizon" | "vpslide"; idx: number } | null {
  const [, , iw, ih] = imgRect(); const tolX = (HANDLE_R + 8) / iw, tolY = (HANDLE_R + 8) / ih;
  for (const key of ["vp1", "vp2"] as const)
    for (let i = 0; i < 4; i++) { const p = state[key][i]; if (Math.abs(p[0] - n[0]) < tolX && Math.abs(p[1] - n[1]) < tolY) return { key, idx: i }; }
  if (Math.abs(state.origin[0] - n[0]) < tolX && Math.abs(state.origin[1] - n[1]) < tolY) return { key: "origin", idx: 0 };
  for (let i = 0; i < boxHandles.length; i++) {
    const h = boxHandles[i];
    if (Math.abs(h.at[0] - n[0]) < tolX && Math.abs(h.at[1] - n[1]) < tolY)
      return { key: "box", idx: BOX_ORDER.indexOf(h.k) };
  }
  for (let i = 0; i < vpGrips.length; i++) {
    const g = vpGrips[i];
    if (Math.abs(g.at[0] - n[0]) < tolX && Math.abs(g.at[1] - n[1]) < tolY) return { key: "vpslide", idx: i };
  }
  // Horizon line last (handles win): perpendicular distance from the cursor to the line.
  if (horizonLine) {
    const { A, B } = horizonLine; const ab: [number, number] = [B[0] - A[0], B[1] - A[1]];
    const len = Math.hypot(ab[0], ab[1]);
    if (len > 1e-6 && Math.abs(ab[0] * (n[1] - A[1]) - ab[1] * (n[0] - A[0])) / len < 0.02) return { key: "horizon", idx: 0 };
  }
  return null;
}
function onDown(e: PointerEvent) {
  const hit = hitTest(eventNorm(e));
  if (!hit) return;
  drag = hit;
  if (hit.key === "box") {
    const k = BOX_ORDER[hit.idx];
    const h = boxHandles.find((x) => x.k === k);
    if (!h) { drag = null; return; }
    boxSnap = { k, val: boxDims()[k], lastN: eventNorm(e), dir: h.dir, per: h.per };
  }
  if (hit.key === "horizon" || hit.key === "vpslide") {
    const res = solveNow();
    if (!res.Fu || !res.Fv) { drag = null; return; }
    horizonSnap = {
      start: eventNorm(e), Fu: res.Fu, Fv: res.Fv,
      gain: hit.key === "vpslide" ? vpGrips[hit.idx].gain : 1,
      slide: hit.key === "vpslide" ? vpGrips[hit.idx].key : null,
      lines: snapshotLines(state, res.Fu, res.Fv),
    };
  }
  canvas.value!.setPointerCapture(e.pointerId); e.preventDefault();
}
function onMove(e: PointerEvent) {
  if (!drag) return;
  const raw = eventNorm(e);
  if (drag.key === "box") {
    if (!boxSnap) return;
    // Incremental, like every other NKD drag, so Shift can be toggled mid-drag.
    const g = isFine() ? FINE_GAIN : 1;
    const along = (raw[0] - boxSnap.lastN[0]) * boxSnap.dir[0]
                + (raw[1] - boxSnap.lastN[1]) * boxSnap.dir[1];
    boxSnap.lastN = raw;
    boxSnap.val = Math.max(0.05, boxSnap.val + (along / boxSnap.per) * g);
    boxDims()[boxSnap.k] = +boxSnap.val.toFixed(3);
    redraw(); emit();
    return;
  }
  if (drag.key === "horizon" || drag.key === "vpslide") {
    const s = horizonSnap; if (!s) return;
    let FuN: [number, number], FvN: [number, number];
    if (s.slide) {
      // Slide ONE vanishing point along the horizon — Shift for the usual tenth speed.
      const u = [s.Fv[0] - s.Fu[0], s.Fv[1] - s.Fu[1]];
      const len = Math.hypot(u[0], u[1]) || 1;
      const t = ((raw[0] - s.start[0]) * u[0] / len + (raw[1] - s.start[1]) * u[1] / len)
              * s.gain * (isFine() ? FINE_GAIN : 1);
      FuN = s.slide === "vp1" ? slideAlong(s.Fu, s.Fu, s.Fv, t) : s.Fu;
      FvN = s.slide === "vp2" ? slideAlong(s.Fv, s.Fu, s.Fv, t) : s.Fv;
    } else {
      const dy = raw[1] - s.start[1];                       // both VPs ride the horizon up/down
      FuN = [s.Fu[0], s.Fu[1] + dy];
      FvN = [s.Fv[0], s.Fv[1] + dy];
    }
    reaimLines(state, s.lines, FuN, FvN);
    redraw(); emit();
    return;
  }
  const n: [number, number] = [Math.max(0, Math.min(1, raw[0])), Math.max(0, Math.min(1, raw[1]))];
  if (drag.key === "origin") state.origin = n;
  else state[drag.key][drag.idx] = n;
  redraw(); emit();
}
function onUp(e: PointerEvent) { if (drag) { drag = null; horizonSnap = null; boxSnap = null; try { canvas.value!.releasePointerCapture(e.pointerId); } catch {} emit(); } }

function onAxis() { redraw(); emit(); }

// ── Spread slider: move both vanishing points apart / together at once ─────────
// There is no "spread" number in the state — the truth is the 8 control points — so
// the slider is RELATIVE to where they were when the drag began, and springs back to
// its centre on release. That also makes it re-appliable: nudge, let go, nudge again.
const spread = ref(0);   // log2 of the scale, so the centre detent is exactly 1x
let spreadSnap: { Fu: [number, number]; Fv: [number, number]; lines: LineSnap[] } | null = null;
function ppRel(): [number, number] {
  const pp = state.principalPoint;
  return pp?.mode === "manual" ? [pp.x ?? 0.5, pp.y ?? 0.5] : [0.5, 0.5];
}
function onSpread() {
  if (!spreadSnap) {                       // first tick of a drag — or an arrow key, which
    const res = solveNow();                // never sends a pointerdown
    if (!res.ok || !res.Fu || !res.Fv) return;
    spreadSnap = { Fu: res.Fu, Fv: res.Fv, lines: snapshotLines(state, res.Fu, res.Fv) };
  }
  const [FuN, FvN] = spreadVanishingPoints(spreadSnap.Fu, spreadSnap.Fv, ppRel(), Math.pow(2, spread.value));
  reaimLines(state, spreadSnap.lines, FuN, FvN);
  redraw(); emit();
}
function endSpread() { spreadSnap = null; spread.value = 0; }

/** Put every draggable back where it started. The 8 vanishing-line handles have
 *  no undo, so dragging one off the image used to be unrecoverable. */
function resetPoints() {
  const d: FSpyState = JSON.parse(JSON.stringify(DEFAULT));
  state.vp1 = d.vp1;
  state.vp2 = d.vp2;
  state.origin = d.origin;
  state.box = d.box;
  redraw();
  emit();
}

const BOX_AXES = [
  { k: "w" as const, label: "W", tip: "Reference box width (world X)" },
  { k: "h" as const, label: "H", tip: "Reference box height (world Y, up from the ground)" },
  { k: "d" as const, label: "D", tip: "Reference box depth (world Z)" },
];
function setBox(k: "w" | "h" | "d", v: number) {
  boxDims()[k] = v;
  redraw();
  emit();          // rides in fspy_state, so the gauge survives a reload
}

onMounted(() => {
  if (props.initialState) { try { const s = JSON.parse(props.initialState); if (s?.vp1 && s?.vp2) Object.assign(state, DEFAULT, s); } catch {} }
  syncSize();
  if (props.initialUrl) setImageUrl(props.initialUrl);
  redraw();
  ro = new ResizeObserver(() => { syncSize(); redraw(); });
  if (wrap.value) ro.observe(wrap.value);
  // Shift = tenth speed on the footer sliders, same as every other NKD panel.
  // Attached to the whole modal because the controls live in its footer, not here.
  detachFine = attachFineRange(
    (props.footerRight?.closest('.nkd-modal-panel') as HTMLElement) ?? document.body);
});
onBeforeUnmount(() => { ro?.disconnect(); detachFine?.(); });
</script>

<template>
  <!-- Mounted into the shared chrome's body; the panel, title bar, Esc handling
       and the Save & close button all belong to src/nkd_modal.ts. -->
  <div class="nkd-fspy-wrap" ref="wrap">
    <canvas ref="canvas" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointerleave="onUp" @contextmenu.prevent />
  </div>

  <Teleport v-if="footerLeft" :to="footerLeft">
    <span class="nkd-modal-status" :class="{ bad: !hud.ok }">
      <template v-if="hud.ok">FOV {{ hud.fovV.toFixed(1) }}°v · {{ hud.fovH.toFixed(1) }}°h &nbsp;|&nbsp; {{ hud.focal.toFixed(1) }}mm &nbsp;|&nbsp; pitch {{ hud.pitch.toFixed(1) }}° · yaw {{ hud.yaw.toFixed(1) }}°</template>
      <template v-else>degenerate lines — adjust the handles</template>
    </span>
  </Teleport>

  <Teleport v-if="footerRight" :to="footerRight">
    <button class="nkd-modal-btn" :class="{ on: showGrid }" @click="showGrid = !showGrid; redraw()">Grid</button>
    <button class="nkd-modal-btn" :class="{ on: showAxes }" @click="showAxes = !showAxes; redraw()">Axes</button>
    <button class="nkd-modal-btn" :class="{ on: showBox }" @click="showBox = !showBox; redraw()">Box</button>
    <button class="nkd-modal-btn" :class="{ on: showHorizon }" @click="showHorizon = !showHorizon; redraw()" title="Drag the yellow horizon up/down to raise/lower the camera pitch. Drag a coloured ⇔ grip sideways to slide that vanishing point along the horizon: toward the centre stretches the perspective (wider lens), outward compresses it (longer lens).">Horizon</button>
    <template v-if="showBox">
      <label class="nkd-modal-lbl" v-for="ax in BOX_AXES" :key="ax.k" :title="ax.tip">{{ ax.label }}
        <input type="range" class="nkd-modal-rng nkd-fspy-box" min="0.1" max="20" step="0.05"
               :value="boxDims()[ax.k]"
               @input="setBox(ax.k, parseFloat(($event.target as HTMLInputElement).value))" />
        <span class="nkd-fspy-num">{{ boxDims()[ax.k].toFixed(2) }}</span>
      </label>
    </template>
    <label class="nkd-modal-lbl" :class="{ off: !hud.ok }"
           title="Spread the two vanishing points apart or squeeze them together along the horizon, about the principal point — apart compresses the perspective (longer lens), together stretches it (wider). Relative: it springs back to 1× on release so you can keep nudging. Shift for fine steps.">Spread
      <input type="range" class="nkd-modal-rng nkd-fspy-box" min="-1" max="1" step="0.005"
             v-model.number="spread" :disabled="!hud.ok"
             @input="onSpread" @pointerup="endSpread" @pointercancel="endSpread" @change="endSpread" />
      <span class="nkd-fspy-num">{{ Math.pow(2, spread).toFixed(2) }}×</span>
    </label>
    <label class="nkd-modal-lbl" title="Darken the image beneath the overlay">Darken
      <input type="range" class="nkd-modal-rng" min="0" max="0.8" step="0.05" v-model.number="dim" @input="redraw" />
    </label>
    <label class="nkd-modal-lbl" :style="{ color: vpColor('vp1') }" title="World axis VP1 maps to — its handles take that axis' colour">VP1→
      <select v-model="state.vp1Axis" class="nkd-modal-sel" @change="onAxis">
        <option value="x+">+X</option><option value="x-">−X</option><option value="y+">+Y</option><option value="y-">−Y</option><option value="z+">+Z</option><option value="z-">−Z</option>
      </select>
    </label>
    <button class="nkd-modal-btn" @click="resetPoints"
            title="Put the vanishing-line handles, the origin and the reference box back to their starting positions">↺ Reset points</button>
    <label class="nkd-modal-lbl" :style="{ color: vpColor('vp2') }" title="World axis VP2 maps to — its handles take that axis' colour">VP2→
      <select v-model="state.vp2Axis" class="nkd-modal-sel" @change="onAxis">
        <option value="x+">+X</option><option value="x-">−X</option><option value="y+">+Y</option><option value="y-">−Y</option><option value="z+">+Z</option><option value="z-">−Z</option>
      </select>
    </label>
  </Teleport>
</template>

<style scoped>
/* Only what is specific to this editor — the chrome's own look lives in the
   shared stylesheet injected by src/nkd_modal.ts (.nkd-modal-*). */
.nkd-fspy-wrap { position: relative; flex: 1 1 auto; min-height: 0; }
.nkd-fspy-wrap canvas { display: block; width: 100%; height: 100%; cursor: crosshair; touch-action: none; }
.nkd-fspy-box { width: 64px; }
.nkd-fspy-num { color: #4ab4ff; font-variant-numeric: tabular-nums; min-width: 30px; text-align: right; }
/* Spread needs a valid solve to have vanishing points to move. */
.nkd-modal-lbl.off { opacity: 0.4; }
</style>
