<script setup lang="ts">
/**
 * 😺NKD Lens Distort — lens editor.
 *
 * Two jobs in one panel: tune the lens parameters against a live preview, and
 * solve them from plumb lines (trace features that are straight in the world;
 * the solver finds the k that straightens them again).
 *
 * Mounted inside the shared NKD editor chrome (src/nkd_modal.ts), which owns the
 * panel, Esc and the primary button.
 *
 * Every parameter edit writes straight back to the node's widget — the editor is
 * a way to DRIVE the node, never a second source of truth. Reopening therefore
 * always shows the node's real state.
 *
 * The photo is drawn by a WebGL pass running the SAME model as the Python node,
 * so the preview is what the node will actually output. Overlay (traces, grid)
 * is a plain 2D canvas stacked on top, so moving a point never re-renders GL.
 *
 * ALGORITHM PARITY: the shader below, ./plumbline.ts and nkd_lens_distort.py are
 * three implementations of one model. Change one, change all three.
 */
import { onMounted, onBeforeUnmount, reactive, ref, computed } from "vue";
import { solvePlumbLines, toNorm, foldRadius, undistortNorm, distortNorm,
         type PlumbLine } from "./plumbline";
import { attachFineRange } from "./fine_drag";

const props = defineProps<{
  initialUrl?: string;
  initialState?: string;
  params?: Record<string, any>;                         // the node's widget values
  footerLeft?: HTMLElement;
  footerRight?: HTMLElement;
  onChange?: (json: string) => void;                    // persist the traces
  onParam?: (name: string, value: any) => void;         // live write-back
}>();

/* Keys ARE the node's widget names, so write-back is a straight pass-through. */
const P = reactive({
  mode: "distort", k1: 0, k2: 0, k3: 0, p1: 0, p2: 0,
  center_x: 0, center_y: 0, squeeze: 1, zoom: 1,
  ca_red: 1, ca_blue: 1, ca_falloff: 1, vignette_amount: 0, vignette_falloff: 2.5,
  edge_mode: "black",
});

// `def` is the node's own default for that input, and the only place it is
// written down: it feeds both double-click-to-reset on the slider and the
// Reset lens button, so the two can no longer disagree.
const SLIDERS = [
  { k: "k1", label: "k1", min: -0.75, max: 0.75, step: 0.001, dp: 3, def: 0 },
  { k: "k2", label: "k2", min: -0.5, max: 0.5, step: 0.001, dp: 3, def: 0 },
  { k: "k3", label: "k3", min: -0.25, max: 0.25, step: 0.001, dp: 3, def: 0 },
  { k: "p1", label: "p1 tangential", min: -0.05, max: 0.05, step: 0.0005, dp: 4, def: 0 },
  { k: "p2", label: "p2 tangential", min: -0.05, max: 0.05, step: 0.0005, dp: 4, def: 0 },
  { k: "center_x", label: "Center X", min: -1, max: 1, step: 0.005, dp: 3, def: 0 },
  { k: "center_y", label: "Center Y", min: -1, max: 1, step: 0.005, dp: 3, def: 0 },
  { k: "squeeze", label: "Anamorphic", min: 0.25, max: 4, step: 0.01, dp: 2, def: 1 },
  { k: "zoom", label: "Zoom", min: 0.25, max: 4, step: 0.005, dp: 3, def: 1 },
  { k: "ca_red", label: "CA Red", min: 0.98, max: 1.02, step: 0.0002, dp: 4, def: 1 },
  { k: "ca_blue", label: "CA Blue", min: 0.98, max: 1.02, step: 0.0002, dp: 4, def: 1 },
  { k: "ca_falloff", label: "CA Falloff", min: 1, max: 6, step: 0.05, dp: 2, def: 1 },
  { k: "vignette_amount", label: "Vignette", min: 0, max: 1, step: 0.01, dp: 2, def: 0 },
  { k: "vignette_falloff", label: "Falloff", min: 0.5, max: 6, step: 0.05, dp: 2, def: 2.5 },
] as const;

const lines = reactive<{ v: PlumbLine[] }>({ v: [] });
const activeIdx = ref(-1);
const fitK2 = ref(false);
const showPreview = ref(true);
const showGrid = ref(false);
const showFrame = ref(true);
const showPanel = ref(true);
const dim = ref(0);
const report = ref("trace 3+ points along something straight");

const wrap = ref<HTMLDivElement | null>(null);
const glCanvas = ref<HTMLCanvasElement | null>(null);
const uiCanvas = ref<HTMLCanvasElement | null>(null);

const view = reactive({ s: 1, tx: 0, ty: 0 });
const img = { el: null as HTMLImageElement | null, w: 16, h: 9 };
let ctx: CanvasRenderingContext2D | null = null;
let ro: ResizeObserver | null = null;
let gl: WebGLRenderingContext | null = null;
let prog: WebGLProgram | null = null;
let tex: WebGLTexture | null = null;
let detachFine: (() => void) | null = null;

const DPR = () => Math.max(window.devicePixelRatio || 1, 1);
const aspect = computed(() => img.w / img.h);
const HIT = 9;
const C = { trace: "#4ab4ff", active: "#ffd166", grid: "rgba(255,255,255,0.22)" };
const EDGES = ["black", "edge", "reflect"];

/* Zoom is measured in RECTIFIED space — that is what makes it cancel exactly on
   the lens_data return trip — so which way fills the frame flips with the mode:
   raise it when undistorting, LOWER it when distorting. Rather than leave that
   to be discovered, the label carries the arrow and the row carries the why.
   Measured with k1=-0.25 in distort: 144792 gap px at zoom 1.0, 616 at 0.70. */
function labelFor(f: { k: string; label: string }): string {
  if (f.k !== "zoom") return f.label;
  return P.mode === "distort" ? "Zoom ↓ fills" : "Zoom ↑ fills";
}
function tipFor(k: string): string {
  if (k !== "zoom") return "";
  return P.mode === "distort"
    ? "Covers the empty corners the barrel leaves. In Distort mode LOWER it below 1 — "
      + "zoom is measured in the rectified image, so here above 1 pushes the picture in "
      + "and opens more gaps. Turn on Frame to see them."
    : "Covers the bowed edges. In Undistort mode RAISE it above 1. "
      + "Turn on Frame to see what is still uncovered.";
}

function setParam(k: string, v: any) {
  (P as any)[k] = v;
  props.onParam?.(k, v);
  redraw();
}

/* ── GL preview ─────────────────────────────────────────────────────────── */
const VERT = `attribute vec2 p; varying vec2 uv;
void main(){ uv = p*0.5+0.5; gl_Position = vec4(p,0.,1.); }`;

const FRAG = `precision highp float;
varying vec2 uv;
uniform sampler2D img;
uniform vec2 canvasSize, imgRect0, imgRect1;
uniform float k1,k2,k3,tp1,tp2,cx,cy,aspect,rFold,rdMax;
uniform float dimAmt, zoom, squeeze, caR, caB, caFall, vigAmt, vigFall;
uniform bool inverse, markGaps;
uniform int edgeMode;                       // 0 black, 1 clamp, 2 mirror

float radial(float r){ float r2=r*r; return 1.0 + r2*(k1 + r2*(k2 + r2*k3)); }

vec2 fwd(vec2 p){                            // Brown-Conrady incl. tangential
  float r2 = dot(p,p);
  float rad = 1.0 + r2*(k1 + r2*(k2 + r2*k3));
  return vec2(p.x*rad + (2.0*tp1*p.x*p.y + tp2*(r2 + 2.0*p.x*p.x)),
              p.y*rad + (tp1*(r2 + 2.0*p.y*p.y) + 2.0*tp2*p.x*p.y));
}
float solveR(float rd){                      // bisection on the monotone branch
  float t = min(rd, max(rdMax, 0.0));
  float lo = 0.0, hi = rFold;
  for (int i=0;i<24;i++){
    float m = 0.5*(lo+hi);
    if (m*radial(m) < t) lo = m; else hi = m;
  }
  return 0.5*(lo+hi);
}
vec2 inv(vec2 pd){                           // outer loop peels off tangential
  vec2 p = pd;
  for (int i=0;i<3;i++){
    float r2 = dot(p,p);
    vec2 tang = vec2(2.0*tp1*p.x*p.y + tp2*(r2 + 2.0*p.x*p.x),
                     tp1*(r2 + 2.0*p.y*p.y) + 2.0*tp2*p.x*p.y);
    vec2 t = pd - tang;
    float rd = length(t);
    p = rd < 1e-9 ? t : t * (solveR(rd)/rd);
  }
  return p;
}

/* Output normalised -> source normalised, for one channel scale. Mirrors
   _sample_grid: squeeze conjugates, zoom lives in rectified space. */
/* Fringe ramp, matching _ca_scale in the Python: displacement grows as
   r^caFall, normalised so the corner always lands on caIn. caFall = 1 is the
   old linear behaviour. NOTE: no backticks in here — this whole shader is a JS
   template literal and one would close it mid-string. */
vec2 srcUV(vec2 q, float caIn, float rRef){
  float ca = caIn;
  if (caIn != 1.0 && caFall != 1.0)
    ca = 1.0 + (caIn - 1.0) * pow(min(length(q), 1.0), max(caFall - 1.0, 0.0));
  vec2 src;
  if (inverse) { src = inv(vec2(q.x/squeeze, q.y)*ca) * zoom; }
  else         { src = fwd(vec2(q.x/(zoom*squeeze), q.y/zoom)*ca); }
  src.x *= squeeze;
  return vec2(src.x*rRef/(2.0*aspect)+0.5, src.y*rRef/2.0+0.5);
}
float mirror1(float x){ x = abs(x); float m = mod(x,2.0); return m>1.0 ? 2.0-m : m; }
bool outside(vec2 t){ return t.x<0.0||t.x>1.0||t.y<0.0||t.y>1.0; }
vec3 fetch(vec2 t, float miss){
  if (outside(t)) {
    if (edgeMode == 0) return vec3(miss);
    if (edgeMode == 1) t = clamp(t, 0.0, 1.0);
    else t = vec2(mirror1(t.x), mirror1(t.y));
  }
  return texture2D(img, t).rgb;
}

void main(){
  vec2 px = vec2(uv.x, 1.0-uv.y) * canvasSize;
  vec2 n  = (px - imgRect0) / (imgRect1 - imgRect0);
  vec3 bg = vec3(0.043,0.051,0.071);

  // OUTSIDE the output frame: canvas, not picture. This is a different thing
  // from a gap INSIDE the frame, and painting both the same background is what
  // made it impossible to judge how much zoom was needed.
  if (n.x < 0.0 || n.x > 1.0 || n.y < 0.0 || n.y > 1.0) {
    gl_FragColor = vec4(bg, 1.0); return;
  }

  float rRef = sqrt(aspect*aspect + 1.0);
  vec2 q = vec2(2.0*aspect*(n.x-0.5-cx*0.5), 2.0*(n.y-0.5-cy*0.5)) / rRef;

  vec2 tG = srcUV(q, 1.0, rRef);
  // Inside the frame with no source to sample: the node writes BLACK here, so
  // show black. Tinted while the frame overlay is on, because "there is a hole
  // in this corner" is exactly what the zoom slider is for.
  if (edgeMode == 0 && outside(tG)) {
    gl_FragColor = markGaps ? vec4(0.40, 0.09, 0.13, 1.0) : vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  vec3 c = vec3(fetch(srcUV(q, caR, rRef), 0.0).r,
                fetch(tG, 0.0).g,
                fetch(srcUV(q, caB, rRef), 0.0).b);

  float r = min(length(q), 1.0);              // vignette uses the OUTPUT radius
  c *= 1.0 - vigAmt*pow(r, vigFall);
  gl_FragColor = vec4(c*(1.0-dimAmt), 1.0);
}`;

function compile(g: WebGLRenderingContext, type: number, src: string) {
  const s = g.createShader(type)!;
  g.shaderSource(s, src); g.compileShader(s);
  if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(s) || "shader");
  return s;
}

function initGL() {
  const cv = glCanvas.value;
  if (!cv) return;
  try {
    gl = cv.getContext("webgl", { alpha: false, antialias: false });
    if (!gl) throw new Error("no webgl");
    prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "link");
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  } catch {
    gl = null;
    report.value = "preview unavailable (no WebGL) — tracing and solving still work";
  }
}

function uploadTexture() {
  if (!gl || !tex || !img.el) return;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img.el);
}

function drawGL() {
  const cv = glCanvas.value;
  if (!gl || !prog || !cv || !img.el) return;
  const r = rect(), d = DPR(), on = showPreview.value;
  const p = warpParams();
  const rf2 = p.rFold * p.rFold;
  gl.viewport(0, 0, cv.width, cv.height);
  gl.clearColor(0.043, 0.051, 0.071, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(prog);
  const u = (n: string) => gl!.getUniformLocation(prog!, n);
  gl.uniform2f(u("canvasSize"), cv.width, cv.height);
  gl.uniform2f(u("imgRect0"), r.x * d, r.y * d);
  gl.uniform2f(u("imgRect1"), (r.x + r.w) * d, (r.y + r.h) * d);
  gl.uniform1f(u("k1"), p.k[0]); gl.uniform1f(u("k2"), p.k[1]); gl.uniform1f(u("k3"), p.k[2]);
  gl.uniform1f(u("tp1"), on ? P.p1 : 0); gl.uniform1f(u("tp2"), on ? P.p2 : 0);
  gl.uniform1f(u("cx"), p.cx); gl.uniform1f(u("cy"), p.cy);
  gl.uniform1f(u("aspect"), aspect.value);
  gl.uniform1f(u("rFold"), p.rFold);
  gl.uniform1f(u("rdMax"), p.rFold * (1 + rf2 * (p.k[0] + rf2 * (p.k[1] + rf2 * p.k[2]))));
  gl.uniform1i(u("inverse"), p.distort ? 1 : 0);
  gl.uniform1f(u("dimAmt"), dim.value);
  gl.uniform1f(u("zoom"), p.zoom); gl.uniform1f(u("squeeze"), p.sq);
  gl.uniform1f(u("caR"), on ? P.ca_red : 1); gl.uniform1f(u("caB"), on ? P.ca_blue : 1);
  gl.uniform1f(u("caFall"), P.ca_falloff);
  gl.uniform1f(u("vigAmt"), on ? P.vignette_amount : 0);
  gl.uniform1f(u("vigFall"), P.vignette_falloff);
  gl.uniform1i(u("edgeMode"), Math.max(0, EDGES.indexOf(P.edge_mode)));
  gl.uniform1i(u("markGaps"), showFrame.value ? 1 : 0);
  gl.uniform1i(u("img"), 0);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/* ── View maths ─────────────────────────────────────────────────────────── */
function rect() {
  const cv = uiCanvas.value;
  const cw = (cv?.width ?? 1) / DPR(), ch = (cv?.height ?? 1) / DPR();
  const fit = Math.min(cw / img.w, ch / img.h);
  const w = img.w * fit * view.s, h = img.h * fit * view.s;
  return { x: (cw - w) / 2 + view.tx, y: (ch - h) / 2 + view.ty, w, h };
}
function toScreen(n: [number, number]): [number, number] {
  const r = rect(); return [r.x + n[0] * r.w, r.y + n[1] * r.h];
}
function toOutputN(sx: number, sy: number): [number, number] {
  const r = rect(); return [(sx - r.x) / r.w, (sy - r.y) / r.h];
}

/* ── The display transform, in both directions ──────────────────────────────
   The preview WARPS the photo, so screen position and source position are not
   the same thing once k != 0. Two exact inverses are needed:

     sampleMap  : output n -> source n   (what the shader asks the texture for)
     contentMap : source n -> output n   (where a source feature ends up)

   Clicks must go through sampleMap, or the stored point is not the feature the
   user clicked — and the error grows with radius, so it was hundreds of pixels
   at the frame edge. Drawing and hit-testing go through contentMap. Getting this
   wrong also poisons the solve, because the traced points then describe nothing
   real, which in turn produced a garbage k and a preview blown off the canvas.
   Tangential p1/p2 are left out of these two on purpose: they are not fitted by
   the solver, and including them here would make the pair non-invertible for no
   gain. The SHADER does apply them. */
function warpParams() {
  const on = showPreview.value;
  const k: [number, number, number] = on ? [P.k1, P.k2, P.k3] : [0, 0, 0];
  return {
    on, k,
    rFold: foldRadius(...k),
    zoom: on ? Math.max(Math.abs(P.zoom), 1e-6) : 1,
    sq: on ? Math.max(Math.abs(P.squeeze), 1e-6) : 1,
    distort: P.mode === "distort",
    cx: P.center_x, cy: P.center_y,
  };
}
function fromNorm(x: number, y: number, cx: number, cy: number): [number, number] {
  const a = aspect.value, rRef = Math.sqrt(a * a + 1);
  return [(x * rRef) / (2 * a) + 0.5 + cx * 0.5, (y * rRef) / 2 + 0.5 + cy * 0.5];
}
function sampleMap(n: [number, number]): [number, number] {
  const p = warpParams();
  if (!p.on) return n;
  const [qx, qy] = toNorm(n[0], n[1], aspect.value, p.cx, p.cy);
  let sx: number, sy: number;
  if (p.distort) {
    const [ux, uy] = undistortNorm(qx / p.sq, qy, ...p.k, p.rFold);
    sx = ux * p.zoom; sy = uy * p.zoom;
  } else {
    [sx, sy] = distortNorm(qx / (p.zoom * p.sq), qy / p.zoom, ...p.k);
  }
  return fromNorm(sx * p.sq, sy, p.cx, p.cy);
}
function contentMap(s: [number, number]): [number, number] {
  const p = warpParams();
  if (!p.on) return s;
  const [x, y] = toNorm(s[0], s[1], aspect.value, p.cx, p.cy);
  const sx = x / p.sq;
  let ox: number, oy: number;
  if (p.distort) {
    const [mx, my] = distortNorm(sx / p.zoom, y / p.zoom, ...p.k);
    ox = mx * p.sq; oy = my;
  } else {
    const [mx, my] = undistortNorm(sx, y, ...p.k, p.rFold);
    ox = mx * p.zoom * p.sq; oy = my * p.zoom;
  }
  return fromNorm(ox, oy, p.cx, p.cy);
}
function toImage(sx: number, sy: number): [number, number] {
  return sampleMap(toOutputN(sx, sy));
}
function toScreenWarped(n: [number, number]): [number, number] {
  return toScreen(contentMap(n));
}

/* ── Overlay ────────────────────────────────────────────────────────────── */
function drawUI() {
  const cv = uiCanvas.value;
  if (!cv || !ctx) return;
  const d = DPR();
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.clearRect(0, 0, cv.width / d, cv.height / d);
  const r = rect();

  // Output frame: same rectangle (and so the same aspect) the node will emit.
  // Anything black inside it is a hole the zoom slider has to cover; anything
  // beyond it is just canvas. Drawn dark-then-light so the line survives both a
  // blown highlight and a black corner.
  if (showFrame.value) {
    ctx.save();
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.restore();
  }

  if (showGrid.value) {
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    for (let i = 1; i < 8; i++) {
      const x = r.x + (r.w * i) / 8, y = r.y + (r.h * i) / 8;
      ctx.beginPath(); ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(r.x, y); ctx.lineTo(r.x + r.w, y); ctx.stroke();
    }
  }

  lines.v.forEach((ln, li) => {
    const isActive = li === activeIdx.value;
    ctx!.strokeStyle = isActive ? C.active : C.trace;
    ctx!.lineWidth = 1.5;
    const pts = ln.map((p) => toScreenWarped(p));     // follow the photo
    ctx!.beginPath();
    pts.forEach((p, i) => (i ? ctx!.lineTo(p[0], p[1]) : ctx!.moveTo(p[0], p[1])));
    ctx!.stroke();
    if (pts.length >= 3) {                             // the straight chord it is measured against
      ctx!.save();
      ctx!.strokeStyle = "rgba(255,255,255,0.30)"; ctx!.setLineDash([4, 4]);
      ctx!.beginPath(); ctx!.moveTo(pts[0][0], pts[0][1]);
      ctx!.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]); ctx!.stroke();
      ctx!.restore();
    }
    pts.forEach((p, pi) => {
      ctx!.fillStyle = isActive && pi === pts.length - 1 ? C.active : C.trace;
      ctx!.beginPath(); ctx!.arc(p[0], p[1], 4, 0, Math.PI * 2); ctx!.fill();
      ctx!.strokeStyle = "rgba(0,0,0,0.65)"; ctx!.lineWidth = 1; ctx!.stroke();
    });
  });
}

function redraw() { drawGL(); drawUI(); }

function syncSize() {
  const w = wrap.value, d = DPR();
  if (!w) return;
  for (const cv of [glCanvas.value, uiCanvas.value]) {
    if (!cv) continue;
    cv.width = Math.max(1, Math.round(w.clientWidth * d));
    cv.height = Math.max(1, Math.round(w.clientHeight * d));
    cv.style.width = w.clientWidth + "px";
    cv.style.height = w.clientHeight + "px";
  }
}

/* ── Interaction ────────────────────────────────────────────────────────── */
let drag: { li: number; pi: number } | null = null;
let pan: { x: number; y: number } | null = null;

function hitPoint(sx: number, sy: number): { li: number; pi: number } | null {
  for (let li = lines.v.length - 1; li >= 0; li--) {
    for (let pi = 0; pi < lines.v[li].length; pi++) {
      const [px, py] = toScreenWarped(lines.v[li][pi]);   // where it is DRAWN
      if (Math.hypot(px - sx, py - sy) <= HIT) return { li, pi };
    }
  }
  return null;
}
function localXY(e: PointerEvent | WheelEvent): [number, number] {
  const b = uiCanvas.value!.getBoundingClientRect();
  return [e.clientX - b.left, e.clientY - b.top];
}

function onDown(e: PointerEvent) {
  const [sx, sy] = localXY(e);
  if (e.button === 1 || e.button === 2) { pan = { x: sx - view.tx, y: sy - view.ty }; return; }
  const hit = hitPoint(sx, sy);
  if (hit && e.shiftKey) {
    lines.v[hit.li].splice(hit.pi, 1);
    if (lines.v[hit.li].length === 0) {
      lines.v.splice(hit.li, 1);
      if (activeIdx.value >= lines.v.length) activeIdx.value = -1;
    }
    changed(); return;
  }
  if (hit) { drag = hit; uiCanvas.value!.setPointerCapture(e.pointerId); return; }

  const p = toImage(sx, sy);
  // Outside the source frame there is no feature to trace — and past the fold
  // the warp has no inverse, so a point placed there cannot be drawn back where
  // it was clicked. Refuse rather than scatter a dot somewhere else.
  if (p[0] < 0 || p[0] > 1 || p[1] < 0 || p[1] > 1) {
    report.value = "that spot is outside the photo — trace inside the image";
    return;
  }
  if (activeIdx.value < 0) { lines.v.push([]); activeIdx.value = lines.v.length - 1; }
  lines.v[activeIdx.value].push(p);
  changed();
}

function onMove(e: PointerEvent) {
  const [sx, sy] = localXY(e);
  if (pan) { view.tx = sx - pan.x; view.ty = sy - pan.y; redraw(); return; }
  if (!drag) return;
  const p = toImage(sx, sy);
  if (p[0] < 0 || p[0] > 1 || p[1] < 0 || p[1] > 1) return;
  lines.v[drag.li][drag.pi] = p;
  redraw();
}

function onUp(e: PointerEvent) {
  if (pan) { pan = null; return; }
  if (drag) { drag = null; try { uiCanvas.value!.releasePointerCapture(e.pointerId); } catch {} changed(); }
}

function onWheel(e: WheelEvent) {
  e.preventDefault();
  const [mx, my] = localXY(e);
  const ns = Math.max(0.2, Math.min(12, view.s * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
  const f = ns / view.s;
  // Anchor on the cursor measured from the canvas CENTRE, not from its origin:
  // rect() places the image at (cw - w)/2 + tx, so the base position already
  // moves with the scale. The textbook `t = m - (m - t)*f` assumes a top-left
  // origin and, with this centred base, drifts the image towards a corner —
  // visibly so even when zooming exactly on the centre, where it must not move.
  const cv = uiCanvas.value, d = DPR();
  const cw = (cv?.width ?? 1) / d, ch = (cv?.height ?? 1) / d;
  const dx = mx - cw / 2, dy = my - ch / 2;
  view.tx = dx - (dx - view.tx) * f;
  view.ty = dy - (dy - view.ty) * f;
  view.s = ns;
  redraw();
}

function finishLine() { activeIdx.value = -1; changed(); }
function newLine() { lines.v.push([]); activeIdx.value = lines.v.length - 1; changed(); }
function clearAll() { lines.v.splice(0); activeIdx.value = -1; changed(); }
function undo() {
  const li = activeIdx.value >= 0 ? activeIdx.value : lines.v.length - 1;
  if (li < 0) return;
  lines.v[li].pop();
  if (lines.v[li].length === 0) { lines.v.splice(li, 1); activeIdx.value = -1; }
  changed();
}
function resetView() { view.s = 1; view.tx = 0; view.ty = 0; redraw(); }
function resetLens() {
  // Straight off SLIDERS. The hand-kept list this replaced was one entry short
  // — ca_falloff never came back to its default when you pressed Reset.
  for (const f of SLIDERS) setParam(f.k, f.def);
}

function changed() {
  props.onChange?.(JSON.stringify({ lines: lines.v }));
  updateReport();
  redraw();
}
function updateReport() {
  const usable = lines.v.filter((l) => l.length >= 3).length;
  const short = lines.v.length - usable;
  report.value = usable === 0
    ? `trace 3+ points along something straight${short ? ` — ${short} trace(s) too short` : ""}`
    : `${usable} usable trace(s)${short ? `, ${short} too short (need 3+ points)` : ""}`;
}

function solve() {
  const usable = lines.v.filter((l) => l.length >= 3);
  if (usable.length === 0) { report.value = "need at least one trace with 3+ points"; return; }
  const s = solvePlumbLines(lines.v, aspect.value, {
    fitK2: fitK2.value, cx: P.center_x, cy: P.center_y,
  });
  setParam("k1", +s.k1.toFixed(5));
  setParam("k2", fitK2.value ? +s.k2.toFixed(5) : P.k2);
  const drop = s.costBefore > 0 ? (1 - s.cost / s.costBefore) * 100 : 0;
  report.value = `k1 ${s.k1.toFixed(4)}${fitK2.value ? ` · k2 ${s.k2.toFixed(4)}` : ""}` +
                 ` · ${s.usedLines} trace(s) · curvature −${drop.toFixed(1)}%`;
}

/* ── Image ──────────────────────────────────────────────────────────────── */
function setImage(url: string) {
  const el = new Image();
  el.crossOrigin = "anonymous";
  el.onload = () => {
    img.el = el; img.w = el.naturalWidth; img.h = el.naturalHeight;
    uploadTexture(); redraw();
  };
  el.src = url;
}

onMounted(() => {
  ctx = uiCanvas.value?.getContext("2d") ?? null;
  initGL();
  if (props.params) for (const k in P) if (k in props.params) (P as any)[k] = props.params[k];
  if (props.initialState) {
    try {
      const s = JSON.parse(props.initialState);
      if (Array.isArray(s?.lines)) lines.v.push(...s.lines);
    } catch { /* a corrupt trace blob must not block the editor */ }
  }
  syncSize();
  if (props.initialUrl) setImage(props.initialUrl);
  updateReport();
  redraw();
  ro = new ResizeObserver(() => { syncSize(); redraw(); });
  if (wrap.value) ro.observe(wrap.value);
  // Hold Shift for tenth-speed dragging on every slider in the panel.
  detachFine = attachFineRange(wrap.value?.parentElement ?? document.body);
});
onBeforeUnmount(() => { ro?.disconnect(); detachFine?.(); });
</script>

<template>
  <div class="nkd-ld-wrap" ref="wrap">
    <canvas ref="glCanvas" class="nkd-ld-layer" />
    <canvas ref="uiCanvas" class="nkd-ld-layer nkd-ld-ui"
            @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp"
            @pointerleave="onUp" @wheel="onWheel" @dblclick="finishLine"
            @contextmenu.prevent />
  </div>

  <div class="nkd-ld-panel" v-show="showPanel">
    <div class="nkd-ld-row">
      <span class="nkd-ld-lbl">Mode</span>
      <select class="nkd-modal-sel nkd-ld-grow" :value="P.mode"
              @change="setParam('mode', ($event.target as HTMLSelectElement).value)">
        <option value="distort">distort</option>
        <option value="undistort">undistort</option>
      </select>
    </div>
    <div class="nkd-ld-row" v-for="f in SLIDERS" :key="f.k" :title="tipFor(f.k)">
      <span class="nkd-ld-lbl">{{ labelFor(f) }}</span>
      <input type="range" class="nkd-modal-rng nkd-ld-grow"
             :min="f.min" :max="f.max" :step="f.step" :value="(P as any)[f.k]"
             :data-default="f.def"
             @input="setParam(f.k, parseFloat(($event.target as HTMLInputElement).value))" />
      <span class="nkd-ld-val">{{ Number((P as any)[f.k]).toFixed(f.dp) }}</span>
    </div>
    <div class="nkd-ld-row">
      <span class="nkd-ld-lbl">Edges</span>
      <select class="nkd-modal-sel nkd-ld-grow" :value="P.edge_mode"
              @change="setParam('edge_mode', ($event.target as HTMLSelectElement).value)">
        <option v-for="e in EDGES" :key="e" :value="e">{{ e }}</option>
      </select>
    </div>
    <div class="nkd-ld-row nkd-ld-end">
      <button class="nkd-modal-btn" @click="resetLens">↺ Reset lens</button>
    </div>
  </div>

  <Teleport v-if="footerLeft" :to="footerLeft">
    <span class="nkd-modal-status" :class="{ bad: report.startsWith('need') || report.startsWith('that') || report.startsWith('preview') }">
      {{ report }}
    </span>
  </Teleport>

  <Teleport v-if="footerRight" :to="footerRight">
    <button class="nkd-modal-btn" @click="undo" title="Remove the last point">↶ Undo</button>
    <button class="nkd-modal-btn" @click="finishLine" title="End this trace (or double-click)">Finish trace</button>
    <button class="nkd-modal-btn" @click="newLine">+ New</button>
    <button class="nkd-modal-btn" @click="clearAll">Clear</button>
    <button class="nkd-modal-btn" :class="{ on: showFrame }" @click="showFrame = !showFrame; redraw()"
            title="Outline the output frame and flag the corners the warp leaves empty">Frame</button>
    <button class="nkd-modal-btn" :class="{ on: showGrid }" @click="showGrid = !showGrid; redraw()">Grid</button>
    <button class="nkd-modal-btn" :class="{ on: showPreview }" @click="showPreview = !showPreview; redraw()"
            title="Toggle the lens preview — off shows the untouched photo">Preview</button>
    <label class="nkd-modal-lbl" title="Darken the photo beneath the traces">Dim
      <input type="range" class="nkd-modal-rng" min="0" max="0.8" step="0.05" data-default="0"
             v-model.number="dim" @input="redraw" />
    </label>
    <button class="nkd-modal-btn" @click="resetView">Reset view</button>
    <button class="nkd-modal-btn" :class="{ on: showPanel }" @click="showPanel = !showPanel">Params</button>
    <button class="nkd-modal-btn" :class="{ on: fitK2 }" @click="fitK2 = !fitK2"
            title="Also fit k2. Needs traces at several distances from the centre, otherwise it overfits.">+k2</button>
    <button class="nkd-modal-btn" @click="solve" title="Find the k that straightens the traces">⌖ Solve</button>
  </Teleport>
</template>

<style scoped>
/* Chrome styling lives in the shared stylesheet (.nkd-modal-*). */
.nkd-ld-wrap { position: relative; flex: 1 1 auto; min-height: 0; }
.nkd-ld-layer { position: absolute; inset: 0; display: block; }
.nkd-ld-ui { cursor: crosshair; touch-action: none; }

.nkd-ld-panel {
  flex: 0 0 250px; overflow-y: auto;
  background: #1a1c22; border-left: 1px solid rgba(255,255,255,0.07);
  padding: 8px 10px; display: flex; flex-direction: column; gap: 5px;
}
.nkd-ld-row { display: flex; align-items: center; gap: 8px; }
.nkd-ld-end { justify-content: flex-end; margin-top: 4px; }
/* 96px, not 82: the zoom label carries a direction arrow and must not wrap. */
.nkd-ld-lbl { color: rgba(255,255,255,0.55); flex: 0 0 96px; font-size: 11px; }
.nkd-ld-grow { flex: 1 1 auto; width: auto; min-width: 0; }
.nkd-ld-val {
  flex: 0 0 46px; text-align: right; color: #4ab4ff;
  font-variant-numeric: tabular-nums; font-size: 11px;
}
</style>
