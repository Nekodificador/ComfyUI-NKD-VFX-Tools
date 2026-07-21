<template>
  <div class="lb-root">
    <!-- Preview canvas area -->
    <div class="lb-canvas-wrap" ref="canvasWrap" :style="{ aspectRatio: canvasAspectRatio }">
      <canvas ref="canvas" class="lb-canvas"
        @mousedown="onCanvasMouseDown"
        @mouseup="onMouseUp"
        @mousemove="onCanvasMove" />

      <!-- Draggable aperture focus indicator -->
      <div class="lb-focus-dot"
        :class="{ active: arcSelected }"
        :style="focusDotStyle"
        @mousedown.stop="startFocusDrag($event)" />

      <!-- Processing overlay -->
      <Transition name="lb-fade">
        <div v-if="isProcessing" class="lb-processing-overlay">
          <div class="lb-processing-pill">
            <span class="lb-processing-dot" />
            <span class="lb-processing-dot" />
            <span class="lb-processing-dot" />
          </div>
        </div>
      </Transition>
    </div>

    <!-- Controls panel -->
    <div class="lb-controls">
      <div class="lb-section">
        <div class="lb-field">
          <span class="lb-flabel">Blur Strength</span>
          <input class="lb-range" :style="rangeStyle(blurStrength, 0, 5)" type="range" min="0" max="5" step="0.01"
            v-model.number="blurStrength" @input="onEmit" @dblclick="resetSlider('blurStrength')" />
          <span class="lb-fval">{{ blurStrength.toFixed(2) }}</span>
        </div>
        <div class="lb-field">
          <span class="lb-flabel">Depth of Field</span>
          <input class="lb-range" :style="rangeStyle(fieldOfDepth, 0, 1)" type="range" min="0" max="1" step="0.01"
            v-model.number="fieldOfDepth" @input="onEmit" @dblclick="resetSlider('fieldOfDepth')" />
          <span class="lb-fval">{{ fieldOfDepth.toFixed(2) }}</span>
        </div>
        <div class="lb-field">
          <span class="lb-flabel">Focus Offset</span>
          <input class="lb-range" :style="rangeStyle(focalOffset, -0.5, 0.5)" type="range" min="-0.5" max="0.5" step="0.005"
            v-model.number="focalOffset" @input="onEmit" @dblclick="resetSlider('focalOffset')" />
          <span class="lb-fval" :class="{ 'lb-fval-pos': focalOffset > 0.001, 'lb-fval-neg': focalOffset < -0.001 }">
            {{ (focalOffset >= 0 ? '+' : '') + focalOffset.toFixed(3) }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted } from "vue";

// ── Props ───────────────────────────────────────────────────────────────────
const props = defineProps<{ onChange: (json: string) => void }>();

// ── Reactive state ──────────────────────────────────────────────────────────
const blurStrength  = ref(1.0);
const fieldOfDepth  = ref(0.1);
const focalOffset   = ref(0.0);   // manual offset added to the auto-sampled focal depth
const focusX        = ref(0.5);
const focusY        = ref(0.5);
const arcSelected   = ref(false);
const isProcessing  = ref(false);
const canvasAspectRatio = ref("16 / 9");

// focalDepth is derived from the depth map at (focusX, focusY) — not a user param
let focalDepthAuto = 0.5;

// ── Template refs ───────────────────────────────────────────────────────────
const canvas    = ref<HTMLCanvasElement | null>(null);
const canvasWrap = ref<HTMLDivElement | null>(null);

// ── Non-reactive (large buffers + rendering state) ──────────────────────────
let passRgb:   Uint8Array | null = null;
let passDepth: Uint8Array | null = null;
let passW = 0;
let passH = 0;
let canvasDisplayScale = 1;
let rafId = 0;

// Cached blur preview: recomputed when passes or blur params change
let blurCache: ImageData | null = null;
let blurCacheKey = "";

// ── Computed ─────────────────────────────────────────────────────────────────
const focusDotStyle = computed(() => ({
  left: focusX.value * 100 + "%",
  top:  focusY.value * 100 + "%",
}));

// Fill percentage for ComfyUI-style sliders (drives the --lb-fill CSS var)
function rangeStyle(v: number, min: number, max: number) {
  const pct = Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
  return { "--lb-fill": pct + "%" };
}

// ── Depth sampling ────────────────────────────────────────────────────────────
// Reads the luminance of the depth map at normalized position (nx, ny).
// Returns 0.5 if no depth data is available yet.
function sampleDepthAt(nx: number, ny: number): number {
  if (!passDepth || passW === 0 || passH === 0) return 0.5;
  const px = Math.max(0, Math.min(passW  - 1, Math.round(nx * (passW  - 1))));
  const py = Math.max(0, Math.min(passH - 1, Math.round(ny * (passH - 1))));
  const i  = py * passW + px;
  return (passDepth[i * 3] + passDepth[i * 3 + 1] + passDepth[i * 3 + 2]) / (3 * 255);
}

function updateFocalDepth() {
  focalDepthAuto = sampleDepthAt(focusX.value, focusY.value);
}

// ── Public API ───────────────────────────────────────────────────────────────
function serialise(): string {
  return JSON.stringify({
    focalDepth:   Math.max(0, Math.min(1, focalDepthAuto + focalOffset.value)),
    focalOffset:  focalOffset.value,
    fieldOfDepth: fieldOfDepth.value,
    blurStrength: blurStrength.value,
    focusX:       focusX.value,
    focusY:       focusY.value,
  });
}

function deserialise(json: string) {
  try {
    const p = JSON.parse(json);
    fieldOfDepth.value = p.fieldOfDepth ?? 0.1;
    blurStrength.value = p.blurStrength ?? 1.0;
    focalOffset.value  = p.focalOffset  ?? 0.0;
    focusX.value       = p.focusX       ?? 0.5;
    focusY.value       = p.focusY       ?? 0.5;
    // focalDepth will be recomputed when passes are available
    nextTick(() => { updateFocalDepth(); scheduleRedraw(); });
  } catch { /* ignore */ }
}

interface PassData {
  rgb:    string;
  depth?: string;
  width:  number;
  height: number;
}

function setPasses(data: PassData) {
  passW = data.width;
  passH = data.height;
  canvasAspectRatio.value = `${passW} / ${passH}`;
  passRgb   = decodeB64(data.rgb);
  passDepth = data.depth ? decodeB64(data.depth) : null;
  blurCache = null;
  blurCacheKey = "";
  isProcessing.value = false;
  updateFocalDepth(); // recompute from new depth data
  nextTick(scheduleRedraw);
}

function setProcessing(val: boolean) {
  isProcessing.value = val;
}

defineExpose({ serialise, deserialise, setPasses, setProcessing });

// ── Emit ─────────────────────────────────────────────────────────────────────
function onEmit() {
  scheduleRedraw();
  props.onChange(serialise());
}

const SLIDER_DEFAULTS: Record<string, number> = {
  blurStrength: 1.0,
  fieldOfDepth: 0.1,
  focalOffset:  0.0,
};

function resetSlider(name: string) {
  if (name === 'blurStrength')  blurStrength.value  = SLIDER_DEFAULTS.blurStrength;
  if (name === 'fieldOfDepth')  fieldOfDepth.value  = SLIDER_DEFAULTS.fieldOfDepth;
  if (name === 'focalOffset')   focalOffset.value   = SLIDER_DEFAULTS.focalOffset;
  onEmit();
}

// ── Rendering ────────────────────────────────────────────────────────────────
function scheduleRedraw() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    drawPreview();
  });
}

function drawPreview() {
  const cv   = canvas.value;
  const wrap = canvasWrap.value;
  if (!cv) return;

  const W = wrap?.clientWidth  || 320;
  const H = wrap?.clientHeight || 180;

  if (passRgb && passW > 0 && passH > 0) {
    cv.width  = passW;
    cv.height = passH;
    const ctx = cv.getContext("2d")!;

    // Build (or reuse cached) blur preview
    const effectiveFocal = Math.max(0, Math.min(1, focalDepthAuto + focalOffset.value));
    const cacheKey = `${effectiveFocal.toFixed(3)}_${fieldOfDepth.value.toFixed(3)}_${blurStrength.value.toFixed(3)}`;
    if (!blurCache || blurCacheKey !== cacheKey) {
      blurCache    = buildBlurPreview(passRgb, passDepth, passW, passH,
                                      effectiveFocal, fieldOfDepth.value, blurStrength.value);
      blurCacheKey = cacheKey;
    }
    ctx.putImageData(blurCache, 0, 0);

    canvasDisplayScale =
      wrap && wrap.clientWidth > 0 ? cv.width / wrap.clientWidth : 1;
  } else {
    cv.width  = W;
    cv.height = H;
    const ctx = cv.getContext("2d")!;
    renderFallback(ctx, W, H);
    canvasDisplayScale = 1;
  }

  const ctx = cv.getContext("2d")!;
  drawFocalLine(ctx, cv.width, cv.height);
  drawSemicircleWidgets(ctx, cv.width, cv.height);
  drawHUD(ctx, cv.width, cv.height);
}

function renderFallback(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.6);
  g.addColorStop(0, "#1e293b");
  g.addColorStop(1, "#0f172a");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

// Separable box blur on a single-channel Float32Array (no RGBA overhead).
// radius=3 ≈ σ=2, matching _smooth_blur_map in the Python backend.
function blurMap1D(map: Float32Array, W: number, H: number, r: number): Float32Array {
  const tmp  = new Float32Array(map.length);
  const dst  = new Float32Array(map.length);
  const diam = 2 * r + 1;
  for (let y = 0; y < H; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += map[y * W + Math.max(0, Math.min(W - 1, x))];
    for (let x = 0; x < W; x++) {
      tmp[y * W + x] = sum / diam;
      sum += map[y * W + Math.min(x + r + 1, W - 1)] - map[y * W + Math.max(x - r, 0)];
    }
  }
  for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.max(0, Math.min(H - 1, y)) * W + x];
    for (let y = 0; y < H; y++) {
      dst[y * W + x] = sum / diam;
      sum += tmp[Math.min(y + r + 1, H - 1) * W + x] - tmp[Math.max(y - r, 0) * W + x];
    }
  }
  return dst;
}

// ── JS blur preview (mirrors backend _blur_gpu logic) ────────────────────────
function buildBlurPreview(
  rgb:          Uint8Array,
  depth:        Uint8Array | null,
  W:            number,
  H:            number,
  focalDepth:   number,
  fieldOfDepth: number,
  blurStrength: number
): ImageData {
  const n = W * H;

  // Build RGBA source
  const src = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    src[i * 4]     = rgb[i * 3];
    src[i * 4 + 1] = rgb[i * 3 + 1];
    src[i * 4 + 2] = rgb[i * 3 + 2];
    src[i * 4 + 3] = 255;
  }

  if (!depth || blurStrength < 0.01) {
    return new ImageData(src, W, H);
  }

  // Depth as luminance [0,1]
  const depthF = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    depthF[i] = (depth[i * 3] + depth[i * 3 + 1] + depth[i * 3 + 2]) / (3 * 255);
  }

  // In-focus band: [focalDepth - half, focalDepth + half]
  // Pixels within that band get blur=0; outside, blur grows with distance from band edge.
  const half = fieldOfDepth / 2;
  const lo   = focalDepth - half;
  const hi   = focalDepth + half;

  // Per-pixel blur amount with smoothstep curve
  const blurAmt = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const d = depthF[i];
    const distFromBand = d < lo ? lo - d : d > hi ? d - hi : 0;
    const raw = Math.min(1, distFromBand * blurStrength);
    blurAmt[i] = raw * raw * (3 - 2 * raw);  // smoothstep
  }

  // Spatially blur the blur_amount map to eliminate hard focal-band rings
  const blurAmtSmoothed = blurMap1D(blurAmt, W, H, 3);

  // Kernel bank: N=8 levels, sigma 0 → sigma_max  (synced with Python backend)
  const sigma_max = Math.min(Math.max(W, H) * 0.025, 15);
  const N = 8;

  // Apply each sigma level with separable box/Gaussian approximation
  // Using a 3-pass box blur to approximate Gaussian (fast in JS)
  const layers: Uint8ClampedArray[] = [];
  for (let li = 0; li < N; li++) {
    const sigma = sigma_max * li / (N - 1);
    if (sigma < 0.5) {
      layers.push(src.slice());
    } else {
      layers.push(boxBlurApprox(src, W, H, sigma));
    }
  }

  // Interpolate layers per pixel
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const idxF  = blurAmtSmoothed[i] * (N - 1);
    const idxLo = Math.min(Math.floor(idxF), N - 2);
    const idxHi = idxLo + 1;
    const t     = idxF - idxLo;
    const lo    = layers[idxLo];
    const hi    = layers[idxHi];
    const p     = i * 4;
    out[p]     = lo[p]     + t * (hi[p]     - lo[p]);
    out[p + 1] = lo[p + 1] + t * (hi[p + 1] - lo[p + 1]);
    out[p + 2] = lo[p + 2] + t * (hi[p + 2] - lo[p + 2]);
    out[p + 3] = 255;
  }
  return new ImageData(out, W, H);
}

// 3-pass box blur approximating a Gaussian of given sigma (all 3 channels, RGBA)
function boxBlurApprox(src: Uint8ClampedArray, W: number, H: number, sigma: number): Uint8ClampedArray {
  // Box radius for 3-pass approximation: r ≈ sqrt((12σ²/3)+1)/2 - 0.5
  const ideal = Math.sqrt((12 * sigma * sigma / 3) + 1);
  let rl = Math.floor(ideal);
  if (rl % 2 === 0) rl--;
  const ru = rl + 2;
  const m  = Math.round((3 * ideal * ideal - 3 - 9 * rl) / (-4 * rl + 4 * ru));
  const radii = Array.from({ length: 3 }, (_, i) => i < m ? (rl - 1) / 2 : (ru - 1) / 2);

  let buf = src.slice();
  for (const r of radii) buf = boxBlurPass(buf, W, H, Math.round(r));
  return buf;
}

function boxBlurPass(src: Uint8ClampedArray, W: number, H: number, r: number): Uint8ClampedArray {
  if (r < 1) return src.slice();
  const dst  = new Uint8ClampedArray(src.length);
  const tmp  = new Uint8ClampedArray(src.length);
  const diam = 2 * r + 1;

  // Horizontal — replicate-pad: clamp pixel index but track actual window size
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let sr = 0, sg = 0, sb = 0;
    // Seed window using replicate padding (clamp to edge pixel)
    for (let x = -r; x <= r; x++) {
      const xi = Math.max(0, Math.min(W - 1, x));
      const p  = (row + xi) * 4;
      sr += src[p]; sg += src[p + 1]; sb += src[p + 2];
    }
    for (let x = 0; x < W; x++) {
      const p = (row + x) * 4;
      tmp[p]     = sr / diam;
      tmp[p + 1] = sg / diam;
      tmp[p + 2] = sb / diam;
      tmp[p + 3] = 255;
      // Slide: remove leftmost sample (clamped), add next sample (clamped)
      const addX = Math.min(x + r + 1, W - 1);
      const remX = Math.max(x - r,     0);
      const pa = (row + addX) * 4;
      const pr = (row + remX) * 4;
      sr += src[pa] - src[pr];
      sg += src[pa + 1] - src[pr + 1];
      sb += src[pa + 2] - src[pr + 2];
    }
  }

  // Vertical — same replicate-pad strategy
  for (let x = 0; x < W; x++) {
    let sr = 0, sg = 0, sb = 0;
    for (let y = -r; y <= r; y++) {
      const yi = Math.max(0, Math.min(H - 1, y));
      const p  = (yi * W + x) * 4;
      sr += tmp[p]; sg += tmp[p + 1]; sb += tmp[p + 2];
    }
    for (let y = 0; y < H; y++) {
      const p = (y * W + x) * 4;
      dst[p]     = sr / diam;
      dst[p + 1] = sg / diam;
      dst[p + 2] = sb / diam;
      dst[p + 3] = 255;
      const addY = Math.min(y + r + 1, H - 1);
      const remY = Math.max(y - r,     0);
      const pa = (addY * W + x) * 4;
      const pr = (remY * W + x) * 4;
      sr += tmp[pa] - tmp[pr];
      sg += tmp[pa + 1] - tmp[pr + 1];
      sb += tmp[pa + 2] - tmp[pr + 2];
    }
  }
  return dst;
}

function drawFocalLine(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const half  = fieldOfDepth.value / 2;
  const focus = Math.max(0, Math.min(1, focalDepthAuto + focalOffset.value));

  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 6]);

  // Focal point line (solid-ish, brighter)
  ctx.beginPath();
  ctx.moveTo(0, focus * H);
  ctx.lineTo(W, focus * H);
  ctx.strokeStyle = "rgba(100,200,255,0.55)";
  ctx.stroke();

  // Band edges (dimmer)
  for (const edge of [focus - half, focus + half]) {
    if (edge < 0 || edge > 1) continue;
    ctx.beginPath();
    ctx.moveTo(0, edge * H);
    ctx.lineTo(W, edge * H);
    ctx.strokeStyle = "rgba(100,200,255,0.25)";
    ctx.stroke();
  }

  ctx.restore();
}

function drawSemicircleWidgets(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const s      = canvasDisplayScale;
  const innerR = 20 * s;
  const MIN_LW =  3 * s;
  const MAX_LW = 22 * s;
  const HG     = 3 * Math.PI / 180; // 3° gap

  const fx = focusX.value * W;
  const fy = focusY.value * H;
  const sel = arcSelected.value;

  // Canvas angles: 0=right, π/2=bottom, π=left, 3π/2=top (clockwise positive)
  // Top arc (blur_strength): clockwise from left+gap to right-gap, passing through top (3π/2)
  // i.e. start=π+HG, end=2π-HG  (anticlockwise=false, sweeps ~183°→357°)
  const BLUR_A1  = Math.PI + HG;
  const BLUR_A2  = 2 * Math.PI - HG;

  // Bottom arc (focal_depth): clockwise from right+gap to left-gap, passing through bottom (π/2)
  // i.e. start=HG, end=π-HG  (anticlockwise=false, sweeps ~3°→177°)
  const FOCAL_A1 = HG;
  const FOCAL_A2 = Math.PI - HG;

  ctx.save();
  ctx.lineCap = "butt";

  const drawArc = (
    norm: number, a1: number, a2: number
  ) => {
    const lw = MIN_LW + norm * (MAX_LW - MIN_LW);
    const r  = innerR + lw / 2;
    const alphaT = sel ? 0.13 : 0.07;
    const alphaF = sel ? 0.62 : 0.22;

    ctx.beginPath();
    ctx.arc(fx, fy, innerR + MAX_LW / 2, a1, a2, false);
    ctx.strokeStyle = `rgba(180,220,255,${alphaT})`;
    ctx.lineWidth   = MAX_LW;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(fx, fy, r, a1, a2, false);
    ctx.strokeStyle = `rgba(100,180,255,${alphaF})`;
    ctx.lineWidth   = lw;
    ctx.stroke();
  };

  drawArc(blurStrength.value / 5, BLUR_A1,  BLUR_A2);
  drawArc(fieldOfDepth.value,     FOCAL_A1, FOCAL_A2);

  if (sel) {
    const off = innerR + MAX_LW + 9 * s;
    ctx.fillStyle    = "rgba(200,230,255,0.85)";
    ctx.font         = `${Math.round(9 * s)}px sans-serif`;
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    const upAngle   = -Math.PI / 2;
    const downAngle =  Math.PI / 2;
    ctx.fillText(`S ${blurStrength.value.toFixed(2)}`, fx + off * Math.cos(upAngle),   fy + off * Math.sin(upAngle));
    ctx.fillText(`D ${fieldOfDepth.value.toFixed(2)}`, fx + off * Math.cos(downAngle), fy + off * Math.sin(downAngle));
  }

  ctx.restore();
}

function drawHUD(ctx: CanvasRenderingContext2D, W: number, H: number) {
  ctx.fillStyle    = "rgba(255,255,255,0.55)";
  ctx.font         = "10px monospace";
  ctx.textAlign    = "left";
  ctx.textBaseline = "top";
  const ef = Math.max(0, Math.min(1, focalDepthAuto + focalOffset.value));
  ctx.fillText(
    `focus ${ef.toFixed(2)}  dof ${fieldOfDepth.value.toFixed(2)}  str ${blurStrength.value.toFixed(2)}`,
    8, 8
  );

  if (!passRgb) {
    ctx.fillStyle    = "rgba(255,255,255,0.3)";
    ctx.textBaseline = "bottom";
    ctx.fillText("Execute graph to enable real-time preview", 8, H - 8);
  }
}

// ── Interaction ───────────────────────────────────────────────────────────────
function onCanvasMouseDown(e: MouseEvent) {
  const cv = canvas.value;
  if (!cv) return;
  const cvRect = cv.getBoundingClientRect();
  const sx = (e.clientX - cvRect.left) * (cv.width  / cvRect.width);
  const sy = (e.clientY - cvRect.top)  * (cv.height / cvRect.height);

  const s      = canvasDisplayScale;
  const innerR = 20 * s;
  const MAX_LW = 22 * s;
  const tol    =  4 * s;
  const HG     = 3 * Math.PI / 180;

  const fx  = focusX.value * cv.width;
  const fy  = focusY.value * cv.height;
  const ddx = sx - fx;
  const ddy = sy - fy;
  const dist = Math.sqrt(ddx * ddx + ddy * ddy);

  if (dist < innerR - tol || dist > innerR + MAX_LW + tol) return;

  const a  = Math.atan2(ddy, ddx);
  const aN = a < 0 ? a + 2 * Math.PI : a;

  // Top arc: from π+HG to 2π-HG clockwise (sweeps through 3π/2 = top of canvas)
  const inTop    = aN >= Math.PI + HG && aN <= 2 * Math.PI - HG;
  // Bottom arc: from HG to π-HG clockwise (sweeps through π/2 = bottom of canvas)
  const inBottom = aN >= HG && aN <= Math.PI - HG;

  if (!inTop && !inBottom) return;

  arcSelected.value = true;

  const makeDrag = (
    getV: () => number,
    setV: (v: number) => void,
    min: number,
    max: number,
    invert = false
  ) => {
    let prevY = e.clientY;
    const sens = (max - min) / (60 * cvRect.height / cv.height);
    const onMove = (ev: MouseEvent) => {
      const delta = (ev.clientY - prevY) * sens;
      setV(Math.max(min, Math.min(max, getV() + (invert ? delta : -delta))));
      prevY = ev.clientY;
      onEmit();
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup",   onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup",   onUp);
  };

  if (inTop) {
    makeDrag(
      () => blurStrength.value,
      v  => { blurStrength.value = v; },
      0, 5
    );
  } else {
    makeDrag(
      () => fieldOfDepth.value,
      v  => { fieldOfDepth.value = v; },
      0, 1,
      true  // bottom arc: drag down = increase (away from center = more)
    );
  }
}

function onCanvasMove(_e: MouseEvent) {
  // Reserved for future hover effects
}

function onMouseUp() {
  // Nothing needed — drag handlers remove themselves
}

function startFocusDrag(e: MouseEvent) {
  arcSelected.value = true;
  const wrap = canvasWrap.value;
  if (!wrap) return;

  const onMove = (ev: MouseEvent) => {
    const rect = wrap.getBoundingClientRect();
    focusX.value = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    focusY.value = Math.max(0, Math.min(1, (ev.clientY - rect.top)  / rect.height));
    updateFocalDepth(); // re-sample depth at new position
    blurCache = null;   // invalidate cache
    blurCacheKey = "";
    onEmit();
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup",   onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup",   onUp);
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function decodeB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
onMounted(() => {
  scheduleRedraw();
  window.addEventListener("mouseup", onMouseUp);
});

onUnmounted(() => {
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  window.removeEventListener("mouseup", onMouseUp);
});
</script>

<style scoped>
/* ── Root ─────────────────────────────────────────────────────────────────── */
.lb-root {
  width: 100%;
  background: var(--comfy-menu-bg, #111827);
  color: var(--fg-color, #e5e7eb);
  font-size: 12px;
  font-family: var(--font-family, "Inter", sans-serif);
  box-sizing: border-box;
  user-select: none;
  border-radius: 8px;
  overflow: hidden;
}
/* Universal border-box inside the widget — prevents fixed-width children
   from overflowing the node and "bleeding" past its border. */
.lb-root, .lb-root *, .lb-root *::before, .lb-root *::after {
  box-sizing: border-box;
}

/* ── Canvas area ─────────────────────────────────────────────────────────── */
.lb-canvas-wrap {
  position: relative;
  width: 100%;
  background: var(--comfy-input-bg, #0f172a);
  overflow: hidden;
}

.lb-canvas {
  display: block;
  width: 100%;
  height: 100%;
}

/* ── Aperture focus indicator ────────────────────────────────────────────── */
.lb-focus-dot {
  position: absolute;
  width: 22px;
  height: 22px;
  border: 2px solid rgba(255, 255, 255, 0.7);
  border-radius: 50%;
  transform: translate(-50%, -50%);
  cursor: move;
  pointer-events: auto;
  transition: border-color 0.15s;
  box-sizing: border-box;
}
.lb-focus-dot.active { border-color: rgba(255, 255, 255, 0.95); }

.lb-focus-dot::before {
  content: '';
  position: absolute;
  inset: 4px;
  border: 1.5px solid rgba(255, 255, 255, 0.45);
  border-radius: 50%;
}

.lb-focus-dot::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 4px;
  height: 4px;
  background: rgba(255, 255, 255, 0.85);
  border-radius: 50%;
  transform: translate(-50%, -50%);
}

/* ── Controls panel (ComfyUI-style — same language as Relight widget) ────── */
.lb-controls {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--comfy-menu-bg, #1f2937);
  min-width: 0;
}

/* Single container holding all sliders — mirrors Relight's .rl-section body */
.lb-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--border-color, #374151);
  border-radius: 6px;
  background: var(--comfy-menu-bg, #1f2937);
  min-width: 0;
}

.lb-field {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.lb-flabel {
  flex-shrink: 0;
  width: 78px;
  font-size: 10px;
  color: var(--descrip-text, #9ca3af);
}

.lb-fval {
  flex-shrink: 0;
  width: 44px;
  text-align: right;
  font-size: 10px;
  color: var(--fg-color, #cbd5e1);
  font-variant-numeric: tabular-nums;
}
.lb-fval-pos { color: var(--p-primary-color, #60a5fa); }
.lb-fval-neg { color: var(--error-text, #f87171); }

/* Range: thin filled track + small thumb, themed to ComfyUI */
.lb-range {
  flex: 1 1 auto;
  min-width: 0;
  height: 14px;
  margin: 0;
  background: transparent;
  cursor: pointer;
  -webkit-appearance: none;
  appearance: none;
}
.lb-range::-webkit-slider-runnable-track {
  height: 5px;
  border-radius: 3px;
  background: linear-gradient(
    to right,
    var(--p-primary-color, #3b82f6) 0 var(--lb-fill, 0%),
    var(--comfy-input-bg, #0f172a) var(--lb-fill, 0%) 100%
  );
}
.lb-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  margin-top: -4px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--fg-color, #e5e7eb);
  border: 1px solid var(--border-color, #1f2937);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
}
.lb-range::-moz-range-track {
  height: 5px;
  border-radius: 3px;
  background: var(--comfy-input-bg, #0f172a);
}
.lb-range::-moz-range-progress {
  height: 5px;
  border-radius: 3px;
  background: var(--p-primary-color, #3b82f6);
}
.lb-range::-moz-range-thumb {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--fg-color, #e5e7eb);
  border: 1px solid var(--border-color, #1f2937);
}

/* ── Processing overlay ──────────────────────────────────────────────────── */
.lb-processing-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  pointer-events: none;
  z-index: 10;
}

.lb-processing-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(15, 23, 42, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  padding: 10px 18px;
}

.lb-processing-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #60a5fa;
  animation: lb-bounce 1.1s ease-in-out infinite;
}
.lb-processing-dot:nth-child(2) { animation-delay: 0.18s; }
.lb-processing-dot:nth-child(3) { animation-delay: 0.36s; }

@keyframes lb-bounce {
  0%, 80%, 100% { transform: scale(0.7); opacity: 0.4; }
  40%           { transform: scale(1.15); opacity: 1; }
}

/* ── Fade transition ─────────────────────────────────────────────────────── */
.lb-fade-enter-active, .lb-fade-leave-active { transition: opacity 0.18s ease; }
.lb-fade-enter-from,  .lb-fade-leave-to      { opacity: 0; }
</style>
