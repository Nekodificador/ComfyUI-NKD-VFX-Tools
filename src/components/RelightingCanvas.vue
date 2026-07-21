<template>
  <div class="rl-root">
    <!-- Preview canvas area -->
    <div class="rl-canvas-wrap" ref="canvasWrap" :style="{ aspectRatio: canvasAspectRatio }">
      <canvas ref="canvas" class="rl-canvas" @mousedown="onCanvasMouseDown" @click="onCanvasClick" @mousemove="onCanvasMove" @mouseup="onMouseUp" />
      <!-- Draggable point-light indicators -->
      <div
        v-for="light in pointLights"
        :key="light.id"
        class="rl-light-dot"
        :class="{ selected: light.id === selectedId }"
        :style="dotStyle(light)"
        @mousedown.stop="!$event.shiftKey && startDrag($event, light)"
        @click.stop="$event.shiftKey ? removeLight(light.id) : (!didDrag && !pendingDblClick && selectLight(light.id))"
        @dblclick.stop="toggleArcs(light.id)"
      />
      <!-- Processing overlay -->
      <Transition name="rl-fade">
        <div v-if="isProcessing" class="rl-processing-overlay">
          <div class="rl-processing-pill">
            <span class="rl-processing-dot" />
            <span class="rl-processing-dot" />
            <span class="rl-processing-dot" />
          </div>
        </div>
      </Transition>
    </div>

    <!-- Controls -->
    <div class="rl-controls">
      <!-- Light add buttons -->
      <div class="rl-btnbar">
        <button class="rl-btn" :disabled="lights.length >= 3" @click="addLight('point')">+ Point</button>
        <button class="rl-btn" :disabled="lights.length >= 3" @click="addLight('directional')">+ Dir</button>
        <button class="rl-btn rl-btn-ghost" :disabled="lights.length === 0" @click="clearLights">Clear</button>
      </div>

      <!-- Per-light collapsible rows -->
      <div
        v-for="(light, idx) in lights"
        :key="light.id"
        class="rl-section rl-light"
        :class="{ selected: light.id === selectedId }"
      >
        <div class="rl-sec-head" @click="selectLight(light.id)">
          <span class="rl-chev" :class="{ open: light.id === selectedId }">▸</span>
          <span class="rl-light-icon">{{ light.type === 'point' ? '💡' : '☀️' }}</span>
          <span class="rl-sec-title">{{ light.type === 'point' ? 'Point' : 'Dir' }} {{ (idx as number) + 1 }}</span>
          <input class="rl-swatch" type="color" v-model="light.color" @input="emit" @click.stop />
          <button class="rl-x" @click.stop="removeLight(light.id)">×</button>
        </div>

        <div class="rl-sec-body" v-if="light.id === selectedId">
          <div class="rl-field">
            <span class="rl-flabel">Intensity</span>
            <input class="rl-range" :style="rangeStyle(light.intensity, 0, 2)" type="range" min="0" max="2" step="0.05" v-model.number="light.intensity" @input="emit" @click.stop />
            <span class="rl-fval">{{ light.intensity.toFixed(2) }}</span>
          </div>
          <template v-if="light.type === 'point'">
            <div class="rl-field">
              <span class="rl-flabel">Depth</span>
              <input class="rl-range" :style="rangeStyle(light.z, 0, 2)" type="range" min="0" max="2" step="0.01" v-model.number="light.z" @input="emit" @click.stop />
              <span class="rl-fval">{{ light.z.toFixed(2) }}</span>
            </div>
            <div class="rl-field">
              <span class="rl-flabel">Radius</span>
              <input class="rl-range" :style="rangeStyle(light.radius, 0.05, 2)" type="range" min="0.05" max="2" step="0.05" v-model.number="light.radius" @input="emit" @click.stop />
              <span class="rl-fval">{{ light.radius.toFixed(2) }}</span>
            </div>
          </template>
          <template v-else>
            <div class="rl-field">
              <span class="rl-flabel">Horizontal</span>
              <input class="rl-range" :style="rangeStyle(light.azimuth, -180, 180)" type="range" min="-180" max="180" step="1" v-model.number="light.azimuth" @input="emit" @click.stop />
              <span class="rl-fval">{{ Math.round(light.azimuth) }}°</span>
            </div>
            <div class="rl-field">
              <span class="rl-flabel">Vertical</span>
              <input class="rl-range" :style="rangeStyle(light.elevation, -90, 90)" type="range" min="-90" max="90" step="1" v-model.number="light.elevation" @input="emit" @click.stop />
              <span class="rl-fval">{{ Math.round(light.elevation) }}°</span>
            </div>
          </template>
        </div>
      </div>

      <!-- Ambient section -->
      <div class="rl-section">
        <div class="rl-sec-head" @click="toggleSection('ambient')">
          <span class="rl-chev" :class="{ open: openSections.ambient }">▸</span>
          <span class="rl-sec-title">Ambient</span>
          <input class="rl-swatch" type="color" v-model="ambientColor" @input="emit" @click.stop />
        </div>
        <div class="rl-sec-body" v-if="openSections.ambient">
          <div class="rl-field">
            <span class="rl-flabel">Intensity</span>
            <input class="rl-range" :style="rangeStyle(ambientIntensity, 0, 1)" type="range" min="0" max="1" step="0.01" v-model.number="ambientIntensity" @input="emit" />
            <span class="rl-fval">{{ ambientIntensity.toFixed(2) }}</span>
          </div>
        </div>
      </div>

      <!-- Material section (only when albedo/roughness passes exist) -->
      <div class="rl-section" v-if="hasAlbedo || hasRoughness">
        <div class="rl-sec-head" @click="toggleSection('material')">
          <span class="rl-chev" :class="{ open: openSections.material }">▸</span>
          <span class="rl-sec-title">Material</span>
        </div>
        <div class="rl-sec-body" v-if="openSections.material">
          <div class="rl-field" v-if="hasAlbedo">
            <span class="rl-flabel">Delight</span>
            <input class="rl-range" :style="rangeStyle(delitMix, 0, 1)" type="range" min="0" max="1" step="0.01" v-model.number="delitMix" @input="emit" />
            <span class="rl-fval">{{ delitMix.toFixed(2) }}</span>
          </div>
          <div class="rl-field" v-if="hasRoughness">
            <span class="rl-flabel">Roughness</span>
            <input class="rl-range" :style="rangeStyle(roughnessStrength, 0, 2)" type="range" min="0" max="2" step="0.01" v-model.number="roughnessStrength" @input="emit" />
            <span class="rl-fval">{{ roughnessStrength.toFixed(2) }}</span>
          </div>
        </div>
      </div>

      <!-- Shadows section -->
      <div class="rl-section">
        <div class="rl-sec-head" @click="toggleSection('shadows')">
          <span class="rl-chev" :class="{ open: openSections.shadows }">▸</span>
          <span class="rl-sec-title">Shadows</span>
          <label class="rl-switch" @click.stop>
            <input type="checkbox" v-model="shadowsEnabled" @change="emit" />
            <span class="rl-switch-track"><span class="rl-switch-thumb"></span></span>
          </label>
        </div>
        <div class="rl-sec-body" v-if="openSections.shadows" :class="{ disabled: !shadowsEnabled }">
          <div class="rl-field">
            <span class="rl-flabel">Strength</span>
            <input class="rl-range" :style="rangeStyle(shadowStrength, 0, 1)" :disabled="!shadowsEnabled" type="range" min="0" max="1" step="0.01" v-model.number="shadowStrength" @input="emit" />
            <span class="rl-fval">{{ shadowStrength.toFixed(2) }}</span>
          </div>
          <div class="rl-field">
            <span class="rl-flabel">Softness</span>
            <input class="rl-range" :style="rangeStyle(shadowSoftness, 0, 1)" :disabled="!shadowsEnabled" type="range" min="0" max="1" step="0.01" v-model.number="shadowSoftness" @input="emit" />
            <span class="rl-fval">{{ shadowSoftness.toFixed(2) }}</span>
          </div>
          <div class="rl-field">
            <span class="rl-flabel">Range</span>
            <input class="rl-range" :style="rangeStyle(shadowRange, 0.01, 0.5)" :disabled="!shadowsEnabled" type="range" min="0.01" max="0.5" step="0.01" v-model.number="shadowRange" @input="emit" />
            <span class="rl-fval">{{ shadowRange.toFixed(2) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from "vue";

interface Light {
  id: number;
  type: "point" | "directional";
  color: string;
  intensity: number;
  x: number;
  y: number;
  z: number;
  azimuth: number;
  elevation: number;
  radius: number;
  falloff: number;
}

interface State {
  lights: Light[];
  ambientIntensity: number;
  ambientColor: string;
  delitMix: number;
  roughnessStrength: number;
  shadowsEnabled: boolean;
  shadowStrength: number;
  shadowSoftness: number;
  shadowRange: number;
}

interface PassData {
  rgb: string;
  normals: string;
  depth: string;
  albedo?: string;
  roughness?: string;
  width: number;
  height: number;
}

const props = defineProps<{ onChange: (json: string) => void }>();

const lights              = ref<Light[]>([]);
const selectedId          = ref<number | null>(null);
const ambientIntensity    = ref(0.2);
const ambientColor        = ref("#ffffff");
const delitMix            = ref(0.0);
const roughnessStrength   = ref(1.0);
const shadowsEnabled      = ref(false);
const shadowStrength      = ref(0.6);
const shadowSoftness      = ref(0.3);
const shadowRange         = ref(0.15);

// Tracer constants — kept in sync with the Python backend tracer.
const SHADOW_STEPS  = 24;
const SHADOW_BIAS   = 0.012;
const SHADOW_SLOPE  = 0.030;

const canvas            = ref<HTMLCanvasElement | null>(null);
const canvasWrap        = ref<HTMLDivElement | null>(null);
const canvasAspectRatio = ref("16 / 9");

// Pass data received from backend — kept outside Vue reactivity (large buffers)
let passRgb:       Uint8Array | null = null;
let passNormals:   Uint8Array | null = null;
let passDepth:     Uint8Array | null = null;
let passAlbedo:    Uint8Array | null = null;
let passRoughness: Uint8Array | null = null;
let passW = 0;
let passH = 0;
const hasAlbedo    = ref(false);
const hasRoughness = ref(false);
const isProcessing = ref(false);

const pointLights = computed(() => lights.value.filter((l: Light) => l.type === "point"));

// ── Collapsible section state (UI only, not serialised into lights_config) ────
const openSections = ref<{ ambient: boolean; material: boolean; shadows: boolean }>({
  ambient: false,
  material: false,
  shadows: false,
});
function toggleSection(key: "ambient" | "material" | "shadows") {
  openSections.value[key] = !openSections.value[key];
}

// Fill percentage for ComfyUI-style sliders (drives the --rl-fill CSS var)
function rangeStyle(v: number, min: number, max: number) {
  const pct = Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
  return { "--rl-fill": pct + "%" };
}

// ── RAF-batched redraw ──────────────────────────────────────────────────────
let rafId: number | null = null;
function scheduleRedraw() {
  if (rafId !== null) return;
  rafId = requestAnimationFrame(() => { rafId = null; drawPreview(); });
}

// ── Arc visibility toggle ───────────────────────────────────────────────────
const hiddenArcs = ref(new Set<number>());

function toggleArcs(id: number) {
  pendingDblClick = true;
  setTimeout(() => { pendingDblClick = false; }, 300);
  const s = hiddenArcs.value;
  s.has(id) ? s.delete(id) : s.add(id);
  hiddenArcs.value = new Set(s);
  scheduleRedraw();
}

// ── Drag state ─────────────────────────────────────────────────────────────
let dragging: Light | null = null;
let didDrag = false;
let pendingDblClick = false;

function startDrag(_e: MouseEvent, light: Light) {
  selectedId.value = light.id;
  dragging = light;
  didDrag = false;
  const onMove = (ev: MouseEvent) => {
    if (!canvasWrap.value) return;
    didDrag = true;
    const rect = canvasWrap.value.getBoundingClientRect();
    light.x = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    light.y = Math.max(0, Math.min(1, (ev.clientY - rect.top)  / rect.height));
    emit();
  };
  const onUp = () => {
    dragging = null;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function onMouseUp() {
  dragging = null;
}

function onCanvasMove(e: MouseEvent) {
  if (!dragging || !(e.buttons & 1)) { dragging = null; return; }
}

// ── Canvas widget state ─────────────────────────────────────────────────────
let widgetCx = 0, widgetCy = 0, widgetR = 0;
let widgetWasDown = false;
let canvasDisplayScale = 1;

function onCanvasMouseDown(e: MouseEvent) {
  widgetWasDown = false;
  const cv = canvas.value;
  if (!cv) return;
  const cvRect = cv.getBoundingClientRect();
  const sx = (e.clientX - cvRect.left) * (cv.width  / cvRect.width);
  const sy = (e.clientY - cvRect.top)  * (cv.height / cvRect.height);

  // ── Sphere widget (selected directional light) ────────────────────────────
  if (widgetR > 0) {
    const ddx = sx - widgetCx, ddy = sy - widgetCy;
    if (ddx * ddx + ddy * ddy <= widgetR * widgetR) {
      const light = lights.value.find((l: Light) => l.id === selectedId.value && l.type === "directional");
      if (light) {
        widgetWasDown = true;
        let prevX = e.clientX, prevY = e.clientY;
        const onMove = (ev: MouseEvent) => {
          const ddx2 = (ev.clientX - prevX) * (cv.width  / cvRect.width);
          const ddy2 = (ev.clientY - prevY) * (cv.height / cvRect.height);
          prevX = ev.clientX; prevY = ev.clientY;
          const sens = 90 / widgetR;
          light.azimuth   = Math.round(((light.azimuth  + ddx2 * sens) % 360 + 360 + 180) % 360 - 180);
          light.elevation = Math.round(Math.max(-90, Math.min(90, light.elevation + ddy2 * sens)));
          emit();
        };
        const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        return;
      }
    }
  }

  // ── Arc widgets (point lights) — 3 sectors of 120° each ─────────────────
  const s   = canvasDisplayScale;
  const arc = { innerR: 18 * s, maxLW: 22 * s, tol: 4 * s };
  const B1 = Math.PI / 6;
  const B2 = 5 * Math.PI / 6;
  const B3 = 3 * Math.PI / 2;

  const makeDrag = (
    getV: () => number, setV: (v: number) => void,
    min: number, max: number, invert = false
  ) => {
    widgetWasDown = true;
    let prevY = e.clientY;
    const sens = (max - min) / (60 * cvRect.height / cv.height);
    const onMove = (ev: MouseEvent) => {
      const delta = (ev.clientY - prevY) * sens;
      setV(Math.max(min, Math.min(max, getV() + (invert ? delta : -delta))));
      prevY = ev.clientY;
      emit();
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  for (const light of lights.value) {
    if (light.type !== "point") continue;
    const lx   = light.x * cv.width;
    const ly   = light.y * cv.height;
    const ddx  = sx - lx, ddy = sy - ly;
    const dist = Math.sqrt(ddx * ddx + ddy * ddy);

    const a = Math.atan2(ddy, ddx);
    const aN = a < 0 ? a + 2 * Math.PI : a;

    const isIntensity = aN >= B3 || aN < B1;
    const isDepth     = aN >= B1 && aN < B2;
    const isRadius    = aN >= B2 && aN < B3;

    const inBand = dist >= arc.innerR - arc.tol && dist <= arc.innerR + arc.maxLW + arc.tol;
    if (inBand) {
      if (isIntensity) {
        selectedId.value = light.id;
        makeDrag(() => light.intensity, v => { light.intensity = v; }, 0, 2);
        return;
      }
      if (isDepth) {
        selectedId.value = light.id;
        makeDrag(() => light.z, v => { light.z = v; }, 0, 2, true);
        return;
      }
      if (isRadius) {
        selectedId.value = light.id;
        makeDrag(() => light.radius, v => { light.radius = v; }, 0.05, 2);
        return;
      }
    }
  }
}

function onCanvasClick(e: MouseEvent) {
  if (widgetWasDown) { widgetWasDown = false; return; }
  if (!canvasWrap.value) return;
  const sel = lights.value.find((l: Light) => l.id === selectedId.value);
  if (!sel || sel.type !== "point") return;
  const rect = canvasWrap.value.getBoundingClientRect();
  sel.x = (e.clientX - rect.left) / rect.width;
  sel.y = (e.clientY - rect.top)  / rect.height;
  emit();
}

// ── Light management ────────────────────────────────────────────────────────
function addLight(type: "point" | "directional") {
  if (lights.value.length >= 3) return;
  const light: Light = {
    id: Date.now(),
    type,
    color: "#ffffff",
    intensity: 1.0,
    x: 0.3 + lights.value.length * 0.2,
    y: 0.5,
    z: 0.5,
    azimuth: 0,
    elevation: 45,
    radius: 0.5,
    falloff: 2.0,
  };
  lights.value.push(light);
  selectedId.value = light.id;
  emit();
}

function removeLight(id: number) {
  lights.value = lights.value.filter((l: Light) => l.id !== id);
  if (selectedId.value === id) selectedId.value = null;
  hiddenArcs.value.delete(id);
  emit();
}

function clearLights() {
  lights.value = [];
  selectedId.value = null;
  hiddenArcs.value.clear();
  emit();
}

function selectLight(id: number) {
  selectedId.value = selectedId.value === id ? null : id;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  return [
    parseInt(h.substring(0, 2), 16) / 255,
    parseInt(h.substring(2, 4), 16) / 255,
    parseInt(h.substring(4, 6), 16) / 255,
  ];
}

// ═══════════════════════════════════════════════════════════════════════════
// WebGL pixel shader — replaces the JS pixel loop in renderShader
// ═══════════════════════════════════════════════════════════════════════════

// WebGL state lives outside Vue reactivity (no need to observe these)
let glOffscreen: OffscreenCanvas | null = null;
let gl: WebGLRenderingContext | null = null;
let glProgram: WebGLProgram | null = null;
let glQuadBuf: WebGLBuffer | null = null;
let glTextures: { rgb: WebGLTexture | null; normals: WebGLTexture | null; depth: WebGLTexture | null; albedo: WebGLTexture | null; roughness: WebGLTexture | null } = { rgb: null, normals: null, depth: null, albedo: null, roughness: null };
let glLocs: Record<string, WebGLUniformLocation | null> = {};
let glAPos = -1;
let glReady = false;
let glW = 0, glH = 0;
let texturesDirty = false;

const VERT_SRC = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// GLSL fragment shader — Lambertian + Blinn-Phong, max 3 lights
// Uses UNPACK_FLIP_Y_WEBGL so vUv.y=0 = image bottom, vUv.y=1 = image top.
// imgUv converts to image-space coords (y=0 at top) for light position math.
const FRAG_SRC = `
precision highp float;
varying vec2 vUv;

uniform sampler2D uRgb;
uniform sampler2D uNormals;
uniform sampler2D uDepth;
uniform sampler2D uAlbedo;
uniform sampler2D uRoughness;

uniform int   uHasAlbedo;
uniform int   uHasRoughness;
uniform float uAmbR;
uniform float uAmbG;
uniform float uAmbB;
uniform float uAmbientIntensity;
uniform float uDelitMix;
uniform float uRoughnessStrength;
uniform int   uLightCount;

// Screen-space shadow uniforms
uniform int   uShadowOn;
uniform float uShadowStrength;
uniform float uShadowSoftness;
uniform float uShadowRange;

// Flat light arrays (max 3) — avoids struct array issues in GLSL ES 1.00
uniform int   uLType[3];
uniform float uLColorR[3];
uniform float uLColorG[3];
uniform float uLColorB[3];
uniform float uLIntensity[3];
uniform float uLX[3];
uniform float uLY[3];
uniform float uLZ[3];
uniform float uLRadius[3];
uniform float uLAzimuth[3];
uniform float uLElevation[3];

// Screen-space shadow tracer — marches the depth pass toward the light.
// uv0/d0: surface image-UV + depth. sdir: screen-space dir toward the light
// (v down, +z toward camera). Returns occlusion in [0,1] (0 = fully lit).
const int SHADOW_STEPS = 24;
const float SHADOW_BIAS  = 0.012;
const float SHADOW_SLOPE = 0.030;

float traceShadow(vec2 uv0, float d0, vec3 sdir) {
  if (uShadowOn == 0 || uShadowStrength <= 0.0) return 0.0;
  float occ = 0.0;
  float window = uShadowSoftness * 0.5 + 1e-3;
  for (int s = 1; s <= SHADOW_STEPS; s++) {
    float t = (float(s) / float(SHADOW_STEPS)) * uShadowRange;
    vec2 p = uv0 + sdir.xy * t;
    float rayZ = d0 + sdir.z * t;
    // imgUv → depth-texture UV (textures uploaded with UNPACK_FLIP_Y)
    vec3 dd = texture2D(uDepth, vec2(p.x, 1.0 - p.y)).rgb;
    float sceneZ = (dd.r + dd.g + dd.b) / 3.0;
    float surplus = sceneZ - rayZ - (SHADOW_BIAS + SHADOW_SLOPE * t);
    occ = max(occ, clamp(surplus / window, 0.0, 1.0));
  }
  return occ;
}

vec3 calcLight(int i, vec3 N, vec2 imgUv, float dVal, float smoothness, float shininess) {
  float contrib         = 0.0;
  float att             = 1.0;
  vec3  ld              = vec3(0.0);
  float lightSolidAngle = 0.0;
  vec3  sdir            = vec3(0.0);

  if (uLType[i] == 0) {
    // Directional light — uniform direction across all pixels
    float az = uLAzimuth[i];
    float el = uLElevation[i];
    ld = normalize(vec3(cos(el) * sin(az), sin(el), cos(el) * cos(az)));
    // Screen-space marching dir matches point lights: ld is in the same mixed
    // space as imgUv (N has been pre-flipped via N.y = -N.y), so no Y flip here.
    sdir = ld;
    contrib = max(dot(N, ld), 0.0);
  } else {
    // Point light — per-pixel direction and attenuation
    vec3 toLight = vec3(uLX[i] - imgUv.x, uLY[i] - imgUv.y, uLZ[i] - dVal);
    float dist = max(length(toLight), 1.0e-8);
    ld = toLight / dist;
    // Marching dir already in image-UV space (v down, +z toward camera)
    sdir = ld;
    // Windowed falloff: att reaches exactly 0 at dist=radius, so the radius
    // defines the boundary of the lit region without affecting brightness within it.
    float nd = dist / uLRadius[i];
    att = pow(max(1.0 - nd * nd, 0.0), 2.0);
    // Map radius slider [0.05, 2.0] → softness [0.1, 1.0].
    lightSolidAngle = clamp((uLRadius[i] - 0.05) / 1.95, 0.0, 1.0);
    // Wrapped diffuse: large radius adds fill light near the shadow terminator,
    // matching the behaviour of a large physical light source (softbox, window).
    // Normalization by (1+w) keeps full brightness on the lit side unchanged.
    float w = lightSolidAngle * 1.0;
    float rawDot = dot(N, ld);
    contrib = max(rawDot + w, 0.0) / (1.0 + w) * att;
  }

  // Blinn-Phong specular: H = normalize(L + V), view direction V = (0, 0, 1)
  if (uHasRoughness == 1) {
    vec3 H = normalize(ld + vec3(0.0, 0.0, 1.0));
    float ndoth = max(dot(N, H), 0.0);
    // Larger solid angle → lower effective shininess → softer, broader highlight.
    // Directional lights: lightSolidAngle = 0.0, so effShininess = shininess (unchanged).
    float effShininess = (uLType[i] == 1)
        ? shininess * (1.0 - lightSolidAngle * 0.95) + 1.0
        : shininess;
    float spec = pow(ndoth, effShininess) * smoothness * smoothness * att;
    contrib += spec;
  }

  // Screen-space shadow attenuation
  float shadow = traceShadow(imgUv, dVal, sdir);
  contrib *= (1.0 - uShadowStrength * shadow);

  return contrib * vec3(uLColorR[i], uLColorG[i], uLColorB[i]) * uLIntensity[i];
}

void main() {
  // vUv: (0,0)=bottom-left, (1,1)=top-right (OpenGL convention)
  // imgUv: (0,0)=top-left, y increases downward (matches light.x/y coordinates)
  vec2 imgUv = vec2(vUv.x, 1.0 - vUv.y);

  vec3 rgb  = texture2D(uRgb,     vUv).rgb;
  vec3 norm = texture2D(uNormals, vUv).rgb;
  vec3 dep  = texture2D(uDepth,   vUv).rgb;

  // Decode normal: [0,1] → [-1,1], flip Y (OpenGL Y-up convention)
  vec3 N = norm * 2.0 - 1.0;
  N.y = -N.y;
  N = normalize(N);

  // Depth: luminance
  float dVal = (dep.r + dep.g + dep.b) / 3.0;

  // Roughness → smoothness + shininess
  float smoothness = 1.0;
  float shininess  = 129.0;
  if (uHasRoughness == 1) {
    vec3 rouRaw = texture2D(uRoughness, vUv).rgb;
    float roughVal = clamp((rouRaw.r + rouRaw.g + rouRaw.b) / 3.0 * uRoughnessStrength, 0.0, 1.0);
    smoothness = 1.0 - roughVal;
    shininess  = smoothness * smoothness * 128.0 + 1.0;
  }

  // Base color with delit mix
  vec3 base = rgb;
  if (uHasAlbedo == 1 && uDelitMix > 0.0) {
    vec3 alb = texture2D(uAlbedo, vUv).rgb;
    base = mix(rgb, alb, uDelitMix);
  }

  // Ambient seed
  vec3 lightAccum = vec3(uAmbR, uAmbG, uAmbB) * uAmbientIntensity;

  // Accumulate lights (unrolled to avoid GLSL ES loop-variable restrictions)
  if (uLightCount > 0) lightAccum += calcLight(0, N, imgUv, dVal, smoothness, shininess);
  if (uLightCount > 1) lightAccum += calcLight(1, N, imgUv, dVal, smoothness, shininess);
  if (uLightCount > 2) lightAccum += calcLight(2, N, imgUv, dVal, smoothness, shininess);

  gl_FragColor = vec4(clamp(base * lightAccum, 0.0, 1.0), 1.0);
}`;

function compileShader(g: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = g.createShader(type);
  if (!sh) return null;
  g.shaderSource(sh, src);
  g.compileShader(sh);
  if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) {
    console.error("[NKD-Relight] Shader compile error:", g.getShaderInfoLog(sh));
    g.deleteShader(sh);
    return null;
  }
  return sh;
}

function initWebGL(w: number, h: number): boolean {
  try {
    glOffscreen = new OffscreenCanvas(w, h);
    const ctx = glOffscreen.getContext("webgl", { preserveDrawingBuffer: true, antialias: false });
    if (!ctx) { glReady = false; return false; }
    gl = ctx as WebGLRenderingContext;

    const vert = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
    const frag = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vert || !frag) { glReady = false; return false; }

    glProgram = gl.createProgram()!;
    gl.attachShader(glProgram, vert);
    gl.attachShader(glProgram, frag);
    gl.linkProgram(glProgram);
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    if (!gl.getProgramParameter(glProgram, gl.LINK_STATUS)) {
      console.error("[NKD-Relight] Program link error:", gl.getProgramInfoLog(glProgram));
      glReady = false; return false;
    }

    // Full-screen quad: two triangles covering NDC [-1,1]²
    glQuadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, glQuadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1,  -1, 1,
       1, -1,  1,  1,  -1, 1,
    ]), gl.STATIC_DRAW);

    // Allocate textures for all 5 passes
    const mkTex = () => {
      const t = gl!.createTexture()!;
      gl!.bindTexture(gl!.TEXTURE_2D, t);
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR);
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
      return t;
    };
    glTextures = { rgb: mkTex(), normals: mkTex(), depth: mkTex(), albedo: mkTex(), roughness: mkTex() };

    // Cache uniform locations
    gl.useProgram(glProgram);
    const u = (name: string) => gl!.getUniformLocation(glProgram!, name);
    glLocs = {
      uRgb: u("uRgb"), uNormals: u("uNormals"), uDepth: u("uDepth"),
      uAlbedo: u("uAlbedo"), uRoughness: u("uRoughness"),
      uHasAlbedo: u("uHasAlbedo"), uHasRoughness: u("uHasRoughness"),
      uAmbR: u("uAmbR"), uAmbG: u("uAmbG"), uAmbB: u("uAmbB"),
      uAmbientIntensity: u("uAmbientIntensity"),
      uDelitMix: u("uDelitMix"), uRoughnessStrength: u("uRoughnessStrength"),
      uShadowOn: u("uShadowOn"), uShadowStrength: u("uShadowStrength"),
      uShadowSoftness: u("uShadowSoftness"), uShadowRange: u("uShadowRange"),
      uLightCount: u("uLightCount"),
      uLType0: u("uLType[0]"), uLType1: u("uLType[1]"), uLType2: u("uLType[2]"),
      uLColorR: u("uLColorR"), uLColorG: u("uLColorG"), uLColorB: u("uLColorB"),
      uLIntensity: u("uLIntensity"),
      uLX: u("uLX"), uLY: u("uLY"), uLZ: u("uLZ"), uLRadius: u("uLRadius"),
      uLAzimuth: u("uLAzimuth"), uLElevation: u("uLElevation"),
    };

    // Bind texture units once
    gl.uniform1i(glLocs.uRgb, 0);
    gl.uniform1i(glLocs.uNormals, 1);
    gl.uniform1i(glLocs.uDepth, 2);
    gl.uniform1i(glLocs.uAlbedo, 3);
    gl.uniform1i(glLocs.uRoughness, 4);

    glAPos = gl.getAttribLocation(glProgram, "aPos");
    glW = w; glH = h;
    glReady = true;
    return true;
  } catch (e) {
    console.warn("[NKD-Relight] WebGL init failed, falling back to JS shader:", e);
    glReady = false;
    return false;
  }
}

function uploadPassTextures() {
  if (!gl || !glReady) return;
  // UNPACK_FLIP_Y_WEBGL: first row of data (image top) maps to texture t=1 (screen top)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);

  const upload = (tex: WebGLTexture | null, data: Uint8Array | null) => {
    if (!tex) return;
    gl!.bindTexture(gl!.TEXTURE_2D, tex);
    if (data) {
      gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGB, passW, passH, 0, gl!.RGB, gl!.UNSIGNED_BYTE, data);
    } else {
      // Upload a 1x1 black pixel as placeholder for optional passes
      gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGB, 1, 1, 0, gl!.RGB, gl!.UNSIGNED_BYTE, new Uint8Array(3));
    }
  };

  upload(glTextures.rgb,      passRgb);
  upload(glTextures.normals,  passNormals);
  upload(glTextures.depth,    passDepth);
  upload(glTextures.albedo,   passAlbedo);
  upload(glTextures.roughness, passRoughness);

  texturesDirty = false;
}

function renderWebGL(ctx: CanvasRenderingContext2D, W: number, H: number) {
  if (!gl || !glProgram || !glOffscreen) return;

  // Resize offscreen canvas if pass dimensions changed
  if (glW !== W || glH !== H) {
    glOffscreen.width  = W;
    glOffscreen.height = H;
    gl.viewport(0, 0, W, H);
    glW = W; glH = H;
    texturesDirty = true;
  }

  if (texturesDirty) uploadPassTextures();

  gl.useProgram(glProgram);
  gl.viewport(0, 0, W, H);

  // Bind textures to units 0–4
  const bindTex = (unit: number, tex: WebGLTexture | null) => {
    gl!.activeTexture(gl!.TEXTURE0 + unit);
    gl!.bindTexture(gl!.TEXTURE_2D, tex);
  };
  bindTex(0, glTextures.rgb);
  bindTex(1, glTextures.normals);
  bindTex(2, glTextures.depth);
  bindTex(3, glTextures.albedo);
  bindTex(4, glTextures.roughness);

  // Global uniforms
  const [ar, ag, ab] = hexToRgb(ambientColor.value);
  gl.uniform1f(glLocs.uAmbR, ar);
  gl.uniform1f(glLocs.uAmbG, ag);
  gl.uniform1f(glLocs.uAmbB, ab);
  gl.uniform1f(glLocs.uAmbientIntensity, ambientIntensity.value);
  gl.uniform1f(glLocs.uDelitMix, delitMix.value);
  gl.uniform1f(glLocs.uRoughnessStrength, roughnessStrength.value);
  gl.uniform1i(glLocs.uHasAlbedo,    hasAlbedo.value    ? 1 : 0);
  gl.uniform1i(glLocs.uHasRoughness, hasRoughness.value ? 1 : 0);
  gl.uniform1i(glLocs.uShadowOn,       shadowsEnabled.value ? 1 : 0);
  gl.uniform1f(glLocs.uShadowStrength, shadowStrength.value);
  gl.uniform1f(glLocs.uShadowSoftness, shadowSoftness.value);
  gl.uniform1f(glLocs.uShadowRange,    shadowRange.value);

  // Per-light uniforms — padded to 3 elements
  const ls = lights.value;
  const count = ls.length;
  gl.uniform1i(glLocs.uLightCount, count);

  const lType: number[] = [0, 0, 0];
  const lR: number[] = [1, 1, 1], lG: number[] = [1, 1, 1], lB: number[] = [1, 1, 1];
  const lInt: number[] = [0, 0, 0];
  const lX: number[] = [0, 0, 0], lY: number[] = [0, 0, 0], lZ: number[] = [0, 0, 0];
  const lRad: number[] = [1, 1, 1];
  const lAz: number[] = [0, 0, 0], lEl: number[] = [0, 0, 0];

  for (let i = 0; i < count; i++) {
    const l = ls[i];
    lType[i] = l.type === "directional" ? 0 : 1;
    const [r, g, b] = hexToRgb(l.color);
    lR[i] = r; lG[i] = g; lB[i] = b;
    lInt[i] = l.intensity;
    lX[i] = l.x; lY[i] = l.y; lZ[i] = l.z;
    lRad[i] = l.radius;
    lAz[i] = l.azimuth  * Math.PI / 180;
    lEl[i] = l.elevation * Math.PI / 180;
  }

  // Integer arrays need individual uniform1i calls in WebGL 1.0
  gl.uniform1i(glLocs.uLType0, lType[0]);
  gl.uniform1i(glLocs.uLType1, lType[1]);
  gl.uniform1i(glLocs.uLType2, lType[2]);
  gl.uniform1fv(glLocs.uLColorR, lR);
  gl.uniform1fv(glLocs.uLColorG, lG);
  gl.uniform1fv(glLocs.uLColorB, lB);
  gl.uniform1fv(glLocs.uLIntensity, lInt);
  gl.uniform1fv(glLocs.uLX, lX);
  gl.uniform1fv(glLocs.uLY, lY);
  gl.uniform1fv(glLocs.uLZ, lZ);
  gl.uniform1fv(glLocs.uLRadius, lRad);
  gl.uniform1fv(glLocs.uLAzimuth, lAz);
  gl.uniform1fv(glLocs.uLElevation, lEl);

  // Draw full-screen quad
  gl.bindBuffer(gl.ARRAY_BUFFER, glQuadBuf);
  gl.enableVertexAttribArray(glAPos);
  gl.vertexAttribPointer(glAPos, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);

  // Blit WebGL result into the 2D canvas
  ctx.drawImage(glOffscreen, 0, 0, W, H);
}

function destroyWebGL() {
  if (!gl) return;
  Object.values(glTextures).forEach(t => t && gl!.deleteTexture(t));
  if (glQuadBuf) gl.deleteBuffer(glQuadBuf);
  if (glProgram) gl.deleteProgram(glProgram);
  glOffscreen = null; gl = null; glProgram = null; glReady = false;
}

// ═══════════════════════════════════════════════════════════════════════════
// JS pixel-loop fallback (used when WebGL is unavailable)
// ═══════════════════════════════════════════════════════════════════════════
function renderShaderFallback(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const imgData = ctx.createImageData(W, H);
  const out = imgData.data;
  const pw = passW, ph = passH;
  const rgb = passRgb!, norm = passNormals!, dep = passDepth!;
  const alb = passAlbedo, rou = passRoughness;
  const mix = delitMix.value, rStr = roughnessStrength.value;
  const [ar, ag, ab] = hexToRgb(ambientColor.value);
  const ambInt = ambientIntensity.value;

  const lightParams = lights.value.map(l => ({
    type: l.type, color: hexToRgb(l.color), intensity: l.intensity,
    x: l.x, y: l.y, z: l.z, radius: l.radius,
    azimuth: l.azimuth * Math.PI / 180, elevation: l.elevation * Math.PI / 180,
  }));

  // Screen-space shadow setup (parity with WebGL/Python tracer)
  const shOn   = shadowsEnabled.value;
  const shStr  = shadowStrength.value;
  const shWin  = shadowSoftness.value * 0.5 + 1e-3;
  const shRng  = shadowRange.value;
  const sampleDepth = (u: number, v: number): number => {
    const ix = Math.max(0, Math.min(pw - 1, Math.round(u * pw)));
    const iy = Math.max(0, Math.min(ph - 1, Math.round(v * ph)));
    const di = (iy * pw + ix) * 3;
    return (dep[di] + dep[di+1] + dep[di+2]) / (3 * 255);
  };
  const traceShadow = (u0: number, v0: number, d0: number, sx: number, sy: number, sz: number): number => {
    if (!shOn || shStr <= 0) return 0;
    let occ = 0;
    for (let s = 1; s <= SHADOW_STEPS; s++) {
      const t = (s / SHADOW_STEPS) * shRng;
      const sceneZ = sampleDepth(u0 + sx * t, v0 + sy * t);
      const rayZ = d0 + sz * t;
      const surplus = sceneZ - rayZ - (SHADOW_BIAS + SHADOW_SLOPE * t);
      occ = Math.max(occ, Math.min(1, Math.max(0, surplus / shWin)));
    }
    return occ;
  };

  for (let y = 0; y < H; y++) {
    const sy = Math.min(Math.floor(y * ph / H), ph - 1);
    for (let x = 0; x < W; x++) {
      const sx = Math.min(Math.floor(x * pw / W), pw - 1);
      const pi = (sy * pw + sx) * 3;
      const r = rgb[pi] / 255, g = rgb[pi+1] / 255, b = rgb[pi+2] / 255;
      let nx = (norm[pi] / 255) * 2 - 1;
      let ny = -((norm[pi+1] / 255) * 2 - 1);
      let nz = (norm[pi+2] / 255) * 2 - 1;
      const nL = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
      nx /= nL; ny /= nL; nz /= nL;
      const dVal = (dep[pi] + dep[pi+1] + dep[pi+2]) / (3 * 255);
      let smoothness = 1.0, shininess = 129.0;
      if (rou) {
        const rv = Math.min((rou[pi] + rou[pi+1] + rou[pi+2]) / (3 * 255) * rStr, 1.0);
        smoothness = 1.0 - rv;
        shininess = smoothness * smoothness * 128.0 + 1.0;
      }
      let baseR = r, baseG = g, baseB = b;
      if (alb && mix > 0) {
        baseR = (1 - mix) * r + mix * alb[pi] / 255;
        baseG = (1 - mix) * g + mix * alb[pi+1] / 255;
        baseB = (1 - mix) * b + mix * alb[pi+2] / 255;
      }
      let lR = ambInt * ar, lG = ambInt * ag, lB = ambInt * ab;
      const pu = sx / pw, pv = sy / ph;
      for (const lp of lightParams) {
        let contrib = 0, att = 1.0, ldx = 0, ldy = 0, ldz = 0, lightSolidAngle = 0.0;
        let sdx = 0, sdy = 0, sdz = 0;
        if (lp.type === "directional") {
          ldx = Math.cos(lp.elevation) * Math.sin(lp.azimuth);
          ldy = Math.sin(lp.elevation);
          ldz = Math.cos(lp.elevation) * Math.cos(lp.azimuth);
          sdx = ldx; sdy = ldy; sdz = ldz;
          contrib = Math.max(nx * ldx + ny * ldy + nz * ldz, 0);
        } else {
          const dx = lp.x - pu, dy = lp.y - pv, dz = lp.z - dVal;
          const dist = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1e-8;
          ldx = dx/dist; ldy = dy/dist; ldz = dz/dist;
          sdx = ldx; sdy = ldy; sdz = ldz;
          const nd = dist / lp.radius;
          att = Math.max(1 - nd * nd, 0) ** 2;
          lightSolidAngle = Math.min(1, Math.max(0, (lp.radius - 0.05) / 1.95));
          const w = lightSolidAngle * 1.0;
          const rawDot = nx*ldx + ny*ldy + nz*ldz;
          contrib = Math.max(rawDot + w, 0) / (1 + w) * att;
        }
        if (rou) {
          const hx = ldx, hy = ldy, hz = ldz + 1.0;
          const hLen = Math.sqrt(hx*hx + hy*hy + hz*hz) || 1e-8;
          const ndoth = Math.max(nx*(hx/hLen) + ny*(hy/hLen) + nz*(hz/hLen), 0);
          const effShininess = lp.type === "point"
              ? shininess * (1.0 - lightSolidAngle * 0.95) + 1.0
              : shininess;
          contrib += Math.pow(ndoth, effShininess) * smoothness * smoothness * att;
        }
        if (shOn) {
          const occ = traceShadow(pu, pv, dVal, sdx, sdy, sdz);
          contrib *= (1 - shStr * occ);
        }
        lR += contrib * lp.color[0] * lp.intensity;
        lG += contrib * lp.color[1] * lp.intensity;
        lB += contrib * lp.color[2] * lp.intensity;
      }
      const oi = (y * W + x) * 4;
      out[oi]   = Math.min(255, Math.max(0, baseR * lR * 255));
      out[oi+1] = Math.min(255, Math.max(0, baseG * lG * 255));
      out[oi+2] = Math.min(255, Math.max(0, baseB * lB * 255));
      out[oi+3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);
}

// ── Canvas preview ───────────────────────────────────────────────────────────
function drawPreview() {
  const cv = canvas.value;
  if (!cv) return;
  const wrap = canvasWrap.value;
  const W = wrap ? wrap.clientWidth  : 320;
  const H = wrap ? wrap.clientHeight : 180;
  cv.width  = W;
  cv.height = H;

  const ctx = cv.getContext("2d");
  if (!ctx) return;

  if (passRgb && passNormals && passDepth && passW > 0 && passH > 0) {
    cv.width  = passW;
    cv.height = passH;

    if (glReady) {
      renderWebGL(ctx, passW, passH);
    } else if (!glReady && passRgb) {
      // Try to init WebGL once we have pass dimensions
      if (initWebGL(passW, passH)) {
        renderWebGL(ctx, passW, passH);
      } else {
        renderShaderFallback(ctx, passW, passH);
      }
    }
  } else {
    renderFallback(ctx, W, H);
  }

  canvasDisplayScale = wrap && wrap.clientWidth > 0 ? cv.width / wrap.clientWidth : 1;

  // HUD
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.font = "11px monospace";
  ctx.fillText(`Lights: ${lights.value.length}/3`, 8, 16);
  if (glReady) {
    ctx.fillStyle = "rgba(100,220,100,0.5)";
    ctx.font = "10px monospace";
    ctx.fillText("WebGL", cv.width - 44, 14);
  }
  if (!passRgb) {
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.font = "10px monospace";
    ctx.fillText("Execute graph to enable real-time preview", 8, H - 8);
  }

  drawSemicircleWidgets(ctx, cv.width, cv.height);
  const selDir = lights.value.find((l: Light) => l.id === selectedId.value && l.type === "directional");
  if (selDir) {
    drawDirectionalWidget(ctx, selDir, cv.width, cv.height);
  } else {
    widgetR = 0;
  }
}

// ── Arc widgets for point lights ─────────────────────────────────────────────
function drawSemicircleWidgets(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const s      = canvasDisplayScale;
  const innerR = 18 * s;
  const MIN_LW =  3 * s;
  const MAX_LW = 22 * s;
  const HG     = 3 * Math.PI / 180;

  const INT_A1 = -Math.PI / 2 + HG,    INT_A2 = Math.PI / 6 - HG;
  const DEP_A1 =  Math.PI / 6 + HG,    DEP_A2 = 5 * Math.PI / 6 - HG;
  const RAD_A1 = 5 * Math.PI / 6 + HG, RAD_A2 = 3 * Math.PI / 2 - HG;

  ctx.save();
  ctx.lineCap = "butt";

  for (const light of lights.value) {
    if (light.type !== "point") continue;
    if (hiddenArcs.value.has(light.id)) continue;
    const lx  = light.x * W;
    const ly  = light.y * H;
    const sel = light.id === selectedId.value;
    const [lr, lg, lb] = hexToRgb(light.color);
    const cr = Math.round(lr * 255), cg = Math.round(lg * 255), cb = Math.round(lb * 255);
    const alphaTrack = sel ? 0.13 : 0.07;
    const alphaFill  = sel ? 0.62 : 0.22;

    const drawArc = (norm: number, a1: number, a2: number) => {
      const lw = MIN_LW + norm * (MAX_LW - MIN_LW);
      const r  = innerR + lw / 2;
      ctx.beginPath();
      ctx.arc(lx, ly, innerR + MAX_LW / 2, a1, a2, false);
      ctx.strokeStyle = `rgba(${cr},${cg},${cb},${alphaTrack})`;
      ctx.lineWidth   = MAX_LW;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(lx, ly, r, a1, a2, false);
      ctx.strokeStyle = `rgba(${cr},${cg},${cb},${alphaFill})`;
      ctx.lineWidth   = lw;
      ctx.stroke();
    };

    drawArc(light.intensity / 2,             INT_A1, INT_A2);
    drawArc(light.z / 2,                     DEP_A1, DEP_A2);
    drawArc((light.radius - 0.05) / 1.95,    RAD_A1, RAD_A2);

    if (sel) {
      ctx.fillStyle    = "rgba(210,210,230,0.82)";
      ctx.font         = `${Math.round(9 * s)}px sans-serif`;
      ctx.textAlign    = "center";
      ctx.textBaseline = "middle";
      const off = innerR + MAX_LW + 9 * s;
      const label = (text: string, mid: number) =>
        ctx.fillText(text, lx + off * Math.cos(mid), ly + off * Math.sin(mid));
      label(`I ${light.intensity.toFixed(2)}`, (INT_A1 + INT_A2) / 2);
      label(`D ${light.z.toFixed(2)}`,         (DEP_A1 + DEP_A2) / 2);
      label(`R ${light.radius.toFixed(2)}`,    (RAD_A1 + RAD_A2) / 2);
    }
  }

  ctx.restore();
}

// ── Directional-light sphere joystick ───────────────────────────────────────
function drawDirectionalWidget(ctx: CanvasRenderingContext2D, light: Light, W: number, H: number) {
  const r  = Math.max(30, Math.min(50, Math.min(W, H) * 0.09));
  const cx = W - r - 12;
  const cy = H - r - 12;
  widgetCx = cx; widgetCy = cy; widgetR = r;

  const lw = Math.max(0.5, r * 0.02);

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();

  const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.05, cx, cy, r);
  grad.addColorStop(0, "rgba(65,65,92,0.94)");
  grad.addColorStop(1, "rgba(10,10,20,0.94)");
  ctx.fillStyle = grad;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

  ctx.strokeStyle = "rgba(110,110,150,0.28)";
  ctx.lineWidth = lw;
  for (const latDeg of [0, 30, -30, 60, -60]) {
    const latRad = latDeg * Math.PI / 180;
    const ry = Math.cos(latRad) * r;
    ctx.beginPath();
    ctx.ellipse(cx, cy - Math.sin(latRad) * r, ry, ry * 0.22, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.ellipse(cx, cy, r * 0.22, r, 0, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();
  ctx.save();

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(140,140,180,0.6)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const az = light.azimuth   * Math.PI / 180;
  const el = light.elevation * Math.PI / 180;
  const dotX = cx + (r - 4) * Math.cos(el) * Math.sin(az);
  const dotY = cy + (r - 4) * Math.sin(el);

  const isBehind = Math.cos(el) * Math.cos(az) < 0;
  const alpha = isBehind ? "44" : "bb";

  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(dotX, dotY);
  ctx.strokeStyle = light.color + alpha;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const ch = r * 0.08;
  ctx.strokeStyle = "rgba(180,180,200,0.4)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(cx - ch, cy); ctx.lineTo(cx + ch, cy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx, cy - ch); ctx.lineTo(cx, cy + ch); ctx.stroke();

  ctx.beginPath();
  ctx.arc(dotX, dotY, 5, 0, Math.PI * 2);
  ctx.fillStyle = isBehind ? light.color + "55" : light.color;
  ctx.fill();
  ctx.strokeStyle = isBehind ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.9)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx - r * 0.32, cy - r * 0.38, r * 0.16, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.09)";
  ctx.fill();

  ctx.restore();
}

function renderFallback(ctx: CanvasRenderingContext2D, W: number, H: number) {
  ctx.fillStyle = "#111827";
  ctx.fillRect(0, 0, W, H);

  ctx.globalCompositeOperation = "screen";
  for (const light of lights.value) {
    if (light.type === "point") {
      const gx = light.x * W, gy = light.y * H;
      const gr = light.radius * W * Math.max(light.intensity, 0.1);
      const grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
      grad.addColorStop(0, light.color + "99");
      grad.addColorStop(1, "transparent");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    } else {
      const az = light.azimuth * Math.PI / 180;
      const el = light.elevation * Math.PI / 180;
      const elFactor = Math.sin(el);
      const sx = W / 2 - Math.sin(az) * W * 0.7;
      const sy = H / 2 + Math.cos(az) * H * 0.7;
      const ex = W / 2 + Math.sin(az) * W * 0.7;
      const ey = H / 2 - Math.cos(az) * H * 0.7;
      const grad = ctx.createLinearGradient(sx, sy, ex, ey);
      // elFactor = sin(elevation) is NEGATIVE for lights below the horizon
      // (e.g. -46°); Math.round(negative).toString(16) yields "-7a" → an invalid
      // color like "#ffffff-7a" that throws in addColorStop. Clamp to [0,255].
      const hex2 = (f: number) =>
        Math.max(0, Math.min(255, Math.round(f))).toString(16).padStart(2, "0");
      grad.addColorStop(0, light.color + hex2(elFactor * 0xaa));
      grad.addColorStop(0.5, light.color + hex2(elFactor * 0x44));
      grad.addColorStop(1, "transparent");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    }
  }
  ctx.globalCompositeOperation = "source-over";

  if (ambientIntensity.value > 0) {
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = ambientIntensity.value * 0.3;
    ctx.fillStyle = ambientColor.value;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }
}

// ── Pass data ingestion ────────────────────────────────────────────────────
function setPasses(data: PassData) {
  passW = data.width;
  passH = data.height;
  canvasAspectRatio.value = `${passW} / ${passH}`;

  passRgb     = decodeB64(data.rgb);
  passNormals = decodeB64(data.normals);
  passDepth   = decodeB64(data.depth);
  passAlbedo  = data.albedo   ? decodeB64(data.albedo)   : null;
  passRoughness = data.roughness ? decodeB64(data.roughness) : null;

  hasAlbedo.value    = passAlbedo    !== null;
  hasRoughness.value = passRoughness !== null;

  // If WebGL context doesn't exist yet, init it now that we know the dimensions
  if (!glReady) {
    initWebGL(passW, passH);
  }
  texturesDirty = true;

  isProcessing.value = false;
  nextTick(drawPreview);
}

function decodeB64(b64: string): Uint8Array {
  const bin = atob(b64);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

// ── Serialisation ───────────────────────────────────────────────────────────
function serialise(): string {
  const state: State = {
    lights: lights.value,
    ambientIntensity: ambientIntensity.value,
    ambientColor: ambientColor.value,
    delitMix: delitMix.value,
    roughnessStrength: roughnessStrength.value,
    shadowsEnabled: shadowsEnabled.value,
    shadowStrength: shadowStrength.value,
    shadowSoftness: shadowSoftness.value,
    shadowRange: shadowRange.value,
  };
  return JSON.stringify(state);
}

function deserialise(json: string) {
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) {
      lights.value = parsed;
    } else {
      lights.value              = parsed.lights              ?? [];
      ambientIntensity.value    = parsed.ambientIntensity    ?? 0.2;
      ambientColor.value        = parsed.ambientColor        ?? "#ffffff";
      delitMix.value            = parsed.delitMix            ?? 0.0;
      roughnessStrength.value   = parsed.roughnessStrength   ?? 1.0;
      shadowsEnabled.value      = parsed.shadowsEnabled      ?? false;
      shadowStrength.value      = parsed.shadowStrength      ?? 0.6;
      shadowSoftness.value      = parsed.shadowSoftness      ?? 0.3;
      shadowRange.value         = parsed.shadowRange         ?? 0.15;
    }
    nextTick(drawPreview);
  } catch {
    // ignore
  }
}

// ── Light dot visual style ────────────────────────────────────────────────
function dotStyle(light: Light) {
  const f = Math.min(light.z / 2, 1);
  const size = 10 + f * 16;
  const opacity = 0.35 + f * 0.65;
  const glow = 3 + f * 15;
  return {
    left:      light.x * 100 + '%',
    top:       light.y * 100 + '%',
    background: light.color,
    width:     size + 'px',
    height:    size + 'px',
    opacity,
    boxShadow: `0 0 ${glow}px ${light.color}`,
  };
}

function emit() {
  scheduleRedraw();
  props.onChange(serialise());
}

function setProcessing(val: boolean) {
  isProcessing.value = val;
}

defineExpose({ serialise, deserialise, setPasses, setProcessing });

onMounted(() => {
  nextTick(drawPreview);
});

onUnmounted(() => {
  destroyWebGL();
  if (rafId !== null) cancelAnimationFrame(rafId);
});
</script>

<style scoped>
.rl-root {
  width: 100%;
  background: var(--comfy-menu-bg, #111827);
  border-radius: 8px;
  overflow: hidden;
  font-family: var(--font-family, "Inter", sans-serif);
  font-size: 12px;
  color: var(--fg-color, #e5e7eb);
  box-sizing: border-box;
}
/* Universal border-box inside the widget — prevents fixed-width children
   from overflowing the node and "bleeding" past its border. */
.rl-root, .rl-root * , .rl-root *::before, .rl-root *::after {
  box-sizing: border-box;
}

.rl-canvas-wrap {
  position: relative;
  width: 100%;
  background: #0f172a;
  overflow: hidden;
  cursor: crosshair;
}

.rl-canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.rl-light-dot {
  position: absolute;
  border-radius: 50%;
  border: 2px solid #555;
  transform: translate(-50%, -50%);
  cursor: move;
  pointer-events: auto;
  transition: border-color 0.15s;
}
.rl-light-dot.selected { border-color: #fff; }

.rl-controls {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

/* ── Light add buttons ─────────────────────────────────────────────────────── */
.rl-btnbar {
  display: flex;
  gap: 6px;
  min-width: 0;
}
.rl-btn {
  flex: 1 1 0;
  min-width: 0;
  padding: 5px 6px;
  font-size: 11px;
  border: 1px solid var(--border-color, #374151);
  border-radius: 5px;
  background: var(--comfy-input-bg, #1e293b);
  color: var(--input-text, #e5e7eb);
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
}
.rl-btn:hover:not(:disabled) { border-color: var(--p-primary-color, #3b82f6); }
.rl-btn:disabled { opacity: 0.4; cursor: default; }
.rl-btn-ghost { background: transparent; }

/* ── Collapsible sections ──────────────────────────────────────────────────── */
.rl-section {
  border: 1px solid var(--border-color, #374151);
  border-radius: 6px;
  background: var(--comfy-menu-bg, #1f2937);
  overflow: hidden;
  min-width: 0;
}
.rl-light.selected { border-color: var(--p-primary-color, #3b82f6); }

.rl-sec-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  cursor: pointer;
  user-select: none;
  min-width: 0;
}
.rl-sec-head:hover { background: rgba(127, 127, 127, 0.08); }

.rl-chev {
  flex-shrink: 0;
  font-size: 9px;
  color: var(--descrip-text, #9ca3af);
  transition: transform 0.15s;
}
.rl-chev.open { transform: rotate(90deg); }

.rl-light-icon { flex-shrink: 0; font-size: 13px; }

.rl-sec-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  color: var(--fg-color, #e5e7eb);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rl-sec-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 7px 8px 8px;
  border-top: 1px solid var(--border-color, #374151);
  min-width: 0;
}
.rl-sec-body.disabled { opacity: 0.45; }

/* ── Slider field row (ComfyUI-style) ──────────────────────────────────────── */
.rl-field {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.rl-flabel {
  flex-shrink: 0;
  width: 62px;
  font-size: 10px;
  color: var(--descrip-text, #9ca3af);
}
.rl-fval {
  flex-shrink: 0;
  width: 38px;
  text-align: right;
  font-size: 10px;
  color: var(--fg-color, #cbd5e1);
  font-variant-numeric: tabular-nums;
}

/* Range: thin filled track + small thumb, themed to ComfyUI */
.rl-range {
  flex: 1 1 auto;
  min-width: 0;
  height: 14px;
  margin: 0;
  background: transparent;
  cursor: pointer;
  -webkit-appearance: none;
  appearance: none;
}
.rl-range:disabled { cursor: default; }
/* WebKit / Chromium (ComfyUI desktop): fill via --rl-fill gradient on the track */
.rl-range::-webkit-slider-runnable-track {
  height: 5px;
  border-radius: 3px;
  background: linear-gradient(
    to right,
    var(--p-primary-color, #3b82f6) 0 var(--rl-fill, 0%),
    var(--comfy-input-bg, #0f172a) var(--rl-fill, 0%) 100%
  );
}
.rl-range::-webkit-slider-thumb {
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
/* Firefox: native progress fill */
.rl-range::-moz-range-track {
  height: 5px;
  border-radius: 3px;
  background: var(--comfy-input-bg, #0f172a);
}
.rl-range::-moz-range-progress {
  height: 5px;
  border-radius: 3px;
  background: var(--p-primary-color, #3b82f6);
}
.rl-range::-moz-range-thumb {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--fg-color, #e5e7eb);
  border: 1px solid var(--border-color, #1f2937);
}

/* ── Color swatch ──────────────────────────────────────────────────────────── */
.rl-swatch {
  flex-shrink: 0;
  width: 22px;
  height: 18px;
  padding: 0;
  border: 1px solid var(--border-color, #374151);
  border-radius: 4px;
  background: none;
  cursor: pointer;
}
.rl-swatch::-webkit-color-swatch-wrapper { padding: 0; }
.rl-swatch::-webkit-color-swatch { border: none; border-radius: 3px; }

/* ── Remove (×) button ─────────────────────────────────────────────────────── */
.rl-x {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--descrip-text, #9ca3af);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.rl-x:hover { background: var(--error-text, #b91c1c); color: #fff; }

/* ── Toggle switch ─────────────────────────────────────────────────────────── */
.rl-switch {
  position: relative;
  flex-shrink: 0;
  width: 30px;
  height: 16px;
  cursor: pointer;
}
.rl-switch input {
  position: absolute;
  inset: 0;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
.rl-switch-track {
  display: block;
  width: 30px;
  height: 16px;
  border-radius: 8px;
  background: var(--comfy-input-bg, #374151);
  transition: background 0.15s;
}
.rl-switch-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--fg-color, #e5e7eb);
  transition: left 0.15s;
}
.rl-switch input:checked + .rl-switch-track { background: var(--p-primary-color, #2563eb); }
.rl-switch input:checked + .rl-switch-track .rl-switch-thumb { left: 16px; }

/* ── Processing overlay ──────────────────────────────────────────────────── */
.rl-processing-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  pointer-events: none;
  z-index: 10;
}

.rl-processing-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(15, 23, 42, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  padding: 10px 18px;
}

.rl-processing-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #60a5fa;
  animation: rl-bounce 1.1s ease-in-out infinite;
}
.rl-processing-dot:nth-child(2) { animation-delay: 0.18s; }
.rl-processing-dot:nth-child(3) { animation-delay: 0.36s; }

@keyframes rl-bounce {
  0%, 80%, 100% { transform: scale(0.7); opacity: 0.4; }
  40%           { transform: scale(1.15); opacity: 1; }
}

/* Fade transition */
.rl-fade-enter-active, .rl-fade-leave-active { transition: opacity 0.18s ease; }
.rl-fade-enter-from,  .rl-fade-leave-to      { opacity: 0; }
</style>
