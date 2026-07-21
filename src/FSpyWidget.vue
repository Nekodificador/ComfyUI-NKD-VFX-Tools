<script setup lang="ts">
import { onMounted, onBeforeUnmount, nextTick, reactive, ref } from "vue";
import { solve2vp, makeProjector, type FSpyState } from "./solver";

const props = defineProps<{
  initialUrl?: string;
  initialState?: string;
  onChange?: (json: string) => void;              // live-save the control points
  onClose?: (summary: { ok: boolean; fovV: number; focal: number }) => void;
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
};
const state = reactive<FSpyState>(JSON.parse(JSON.stringify(DEFAULT)));
const hud = reactive({ ok: false, fovV: 0, fovH: 0, focal: 0, pitch: 0, yaw: 0 });
const showGrid = ref(true);
const showAxes = ref(true);
const showBox = ref(false);
const dim = ref(0);        // darken the background image beneath the overlays (0..0.8)

const canvas = ref<HTMLCanvasElement | null>(null);
const wrap = ref<HTMLDivElement | null>(null);
let ctx: CanvasRenderingContext2D | null = null;
let img: HTMLImageElement | null = null;
const imgDim = reactive({ w: 16, h: 9 });
let ro: ResizeObserver | null = null;

const VP_COLORS = { vp1: "#ff8c42", vp2: "#4ab4ff" };
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
  else { ctx.fillStyle = "rgba(255,255,255,0.35)"; ctx.font = "13px system-ui"; ctx.fillText("Conecta una imagen al input del nodo.", 16, 28); }
  if (img && dim.value > 0) { ctx.fillStyle = `rgba(0,0,0,${dim.value})`; ctx.fillRect(ix, iy, iw, ih); }  // darken under overlays
  const res = solveNow();
  const toPx = (p: [number, number]): [number, number] => [ix + p[0] * iw, iy + p[1] * ih];
  const seg = (a: [number, number], b: [number, number]) => { const pa = toPx(a), pb = toPx(b); ctx!.beginPath(); ctx!.moveTo(pa[0], pa[1]); ctx!.lineTo(pb[0], pb[1]); ctx!.stroke(); };

  // ── 3D reference overlay (grid / axes / box) projected with the solved camera ──
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
      const c = [[-.5, 0, -.5], [.5, 0, -.5], [.5, 0, .5], [-.5, 0, .5], [-.5, 1, -.5], [.5, 1, -.5], [.5, 1, .5], [-.5, 1, .5]];
      for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) worldSeg(c[a], c[b], 4);
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
    ctx.strokeStyle = VP_COLORS[key]; ctx.lineWidth = 2;
    seg(pts[0], pts[1]); seg(pts[2], pts[3]);
    const vp = key === "vp1" ? res.Fu : res.Fv;
    if (vp) { ctx.globalAlpha = 0.3; seg([(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2], vp); seg([(pts[2][0] + pts[3][0]) / 2, (pts[2][1] + pts[3][1]) / 2], vp); ctx.globalAlpha = 1; }
    for (const p of pts) { const [x, y] = toPx(p); ctx.beginPath(); ctx.arc(x, y, HANDLE_R, 0, Math.PI * 2); ctx.fillStyle = VP_COLORS[key]; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "rgba(0,0,0,0.7)"; ctx.stroke(); }
  }
  ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 1;
  const c = toPx([0.5, 0.5]); ctx.beginPath(); ctx.moveTo(c[0] - 7, c[1]); ctx.lineTo(c[0] + 7, c[1]); ctx.moveTo(c[0], c[1] - 7); ctx.lineTo(c[0], c[1] + 7); ctx.stroke();

  // Scene anchor (origin) — draggable up/down to set the ground height, like fSpy.
  const [ox, oy] = toPx(state.origin);
  ctx.beginPath(); ctx.moveTo(ox, oy - 9); ctx.lineTo(ox + 9, oy); ctx.lineTo(ox, oy + 9); ctx.lineTo(ox - 9, oy); ctx.closePath();
  ctx.fillStyle = "#55ff99"; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "rgba(0,0,0,0.7)"; ctx.stroke();

  // Magnifier loupe while dragging — CLEAN image only (no handles/lines), placed next to the cursor,
  // with just a precision crosshair, so you can see the exact pixel under the point.
  if (drag && img) {
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
  return r;
}
function emit() { props.onChange?.(JSON.stringify(state)); }

// ── Dragging ──────────────────────────────────────────────────────────────────
let drag: { key: "vp1" | "vp2" | "origin"; idx: number } | null = null;
function eventNorm(e: PointerEvent): [number, number] {
  const cv = canvas.value!; const rect = cv.getBoundingClientRect();
  const [lw, lh] = dims();
  const px = (e.clientX - rect.left) * (lw / rect.width), py = (e.clientY - rect.top) * (lh / rect.height);
  const [ix, iy, iw, ih] = imgRect();
  return [(px - ix) / iw, (py - iy) / ih];
}
function hitTest(n: [number, number]): { key: "vp1" | "vp2" | "origin"; idx: number } | null {
  const [, , iw, ih] = imgRect(); const tolX = (HANDLE_R + 8) / iw, tolY = (HANDLE_R + 8) / ih;
  for (const key of ["vp1", "vp2"] as const)
    for (let i = 0; i < 4; i++) { const p = state[key][i]; if (Math.abs(p[0] - n[0]) < tolX && Math.abs(p[1] - n[1]) < tolY) return { key, idx: i }; }
  if (Math.abs(state.origin[0] - n[0]) < tolX && Math.abs(state.origin[1] - n[1]) < tolY) return { key: "origin", idx: 0 };
  return null;
}
function onDown(e: PointerEvent) { const hit = hitTest(eventNorm(e)); if (hit) { drag = hit; canvas.value!.setPointerCapture(e.pointerId); e.preventDefault(); } }
function onMove(e: PointerEvent) {
  if (!drag) return;
  const raw = eventNorm(e);
  const n: [number, number] = [Math.max(0, Math.min(1, raw[0])), Math.max(0, Math.min(1, raw[1]))];
  if (drag.key === "origin") state.origin = n;
  else state[drag.key][drag.idx] = n;
  redraw(); emit();
}
function onUp(e: PointerEvent) { if (drag) { drag = null; try { canvas.value!.releasePointerCapture(e.pointerId); } catch {} emit(); } }

function onAxis() { redraw(); emit(); }
function close() { props.onClose?.({ ok: hud.ok, fovV: hud.fovV, focal: hud.focal }); }
function onKey(e: KeyboardEvent) { if (e.key === "Escape") { e.stopPropagation(); close(); } }

onMounted(() => {
  if (props.initialState) { try { const s = JSON.parse(props.initialState); if (s?.vp1 && s?.vp2) Object.assign(state, DEFAULT, s); } catch {} }
  syncSize();
  if (props.initialUrl) setImageUrl(props.initialUrl);
  redraw();
  ro = new ResizeObserver(() => { syncSize(); redraw(); });
  if (wrap.value) ro.observe(wrap.value);
  window.addEventListener("keydown", onKey, true);
});
onBeforeUnmount(() => { ro?.disconnect(); window.removeEventListener("keydown", onKey, true); });
</script>

<template>
  <div class="nkd-fspy-modal" @pointerdown.self="close">
    <div class="nkd-fspy-panel">
      <div class="nkd-head">
        <span>😺 fSpy Camera — arrastra los tiradores sobre dos direcciones ortogonales</span>
        <button class="nkd-x" @click="close">✕</button>
      </div>
      <div class="nkd-canvas-wrap" ref="wrap">
        <canvas ref="canvas" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointerleave="onUp" @contextmenu.prevent />
      </div>
      <div class="nkd-bar">
        <span class="nkd-hud" :class="{ bad: !hud.ok }">
          <template v-if="hud.ok">FOV {{ hud.fovV.toFixed(1) }}°v · {{ hud.fovH.toFixed(1) }}°h &nbsp;|&nbsp; {{ hud.focal.toFixed(1) }}mm &nbsp;|&nbsp; pitch {{ hud.pitch.toFixed(1) }}° · yaw {{ hud.yaw.toFixed(1) }}°</template>
          <template v-else>líneas degeneradas — ajusta los tiradores</template>
        </span>
        <span class="nkd-spacer" />
        <button class="nkd-tog" :class="{ on: showGrid }" @click="showGrid = !showGrid; redraw()">Grid</button>
        <button class="nkd-tog" :class="{ on: showAxes }" @click="showAxes = !showAxes; redraw()">Ejes</button>
        <button class="nkd-tog" :class="{ on: showBox }" @click="showBox = !showBox; redraw()">Caja</button>
        <label class="nkd-lbl" title="Oscurecer la imagen bajo los overlays">Atenuar
          <input type="range" class="nkd-rng" min="0" max="0.8" step="0.05" v-model.number="dim" @input="redraw" />
        </label>
        <label class="nkd-lbl" :style="{ color: VP_COLORS.vp1 }" title="Eje de mundo al que apunta la fuga naranja (VP1)">VP1→
          <select v-model="state.vp1Axis" class="nkd-sel" @change="onAxis">
            <option value="x+">+X</option><option value="x-">−X</option><option value="y+">+Y</option><option value="y-">−Y</option><option value="z+">+Z</option><option value="z-">−Z</option>
          </select>
        </label>
        <label class="nkd-lbl" :style="{ color: VP_COLORS.vp2 }" title="Eje de mundo al que apunta la fuga azul (VP2)">VP2→
          <select v-model="state.vp2Axis" class="nkd-sel" @change="onAxis">
            <option value="x+">+X</option><option value="x-">−X</option><option value="y+">+Y</option><option value="y-">−Y</option><option value="z+">+Z</option><option value="z-">−Z</option>
          </select>
        </label>
        <button class="nkd-save" @click="close">Guardar y cerrar</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.nkd-fspy-modal { position: fixed; inset: 0; z-index: 100000; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.8); backdrop-filter: blur(3px); font: 12px system-ui, sans-serif; }
.nkd-fspy-panel { display: flex; flex-direction: column; width: 92vw; height: 92vh; max-width: 1800px; background: #111318; color: #c8d0e0; border: 1px solid #3a3d46; border-radius: 10px; box-shadow: 0 12px 48px rgba(0,0,0,0.7); overflow: hidden; }
.nkd-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: #1a1c22; border-bottom: 1px solid rgba(255,255,255,0.07); font-weight: 500; }
.nkd-x { background: transparent; border: none; color: #c8d0e0; font-size: 16px; cursor: pointer; padding: 2px 8px; border-radius: 4px; }
.nkd-x:hover { background: rgba(255,77,77,0.25); color: #ff6b6b; }
.nkd-canvas-wrap { position: relative; flex: 1 1 auto; min-height: 0; background: #0b0d12; }
.nkd-canvas-wrap canvas { display: block; width: 100%; height: 100%; cursor: crosshair; touch-action: none; }
.nkd-bar { display: flex; align-items: center; gap: 12px; padding: 8px 14px; background: #1a1c22; border-top: 1px solid rgba(255,255,255,0.07); }
.nkd-hud { color: #4ab4ff; font-variant-numeric: tabular-nums; }
.nkd-hud.bad { color: #ff6b6b; }
.nkd-spacer { flex: 1 1 auto; }
.nkd-tog { background: #252830; border: 1px solid #3a3d46; border-radius: 4px; color: #8a92a4; padding: 3px 10px; font-size: 12px; cursor: pointer; }
.nkd-tog:hover { border-color: #4ab4ff; }
.nkd-tog.on { border-color: #4ab4ff; color: #4ab4ff; background: rgba(74,180,255,0.12); }
.nkd-lbl { color: rgba(255,255,255,0.55); display: flex; align-items: center; gap: 6px; }
.nkd-rng { width: 80px; accent-color: #4ab4ff; cursor: pointer; }
.nkd-sel { background: #252830; border: 1px solid #3a3d46; border-radius: 4px; color: #c8d0e0; padding: 3px 8px; font-size: 12px; cursor: pointer; }
.nkd-save { background: #252830; border: 1px solid #4ab4ff; border-radius: 4px; color: #4ab4ff; padding: 5px 14px; font-size: 12px; font-weight: 500; cursor: pointer; }
.nkd-save:hover { background: rgba(74,180,255,0.15); }
</style>
