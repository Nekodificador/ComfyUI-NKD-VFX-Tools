<script setup lang="ts">
/**
 * 😺NKD Preview 3D — WebGL viewport that exports its own render.
 *
 * Deliberately independent of core's Load3D: we own the scene graph so the export
 * path is ours. Notes on the traps this avoids (all measured on core's viewer):
 *  - The background is a screen-space quad in its own scene. Its scale divides by the
 *    canvas size, which is 0 mid-resize, so guard for a non-finite aspect or the plane's
 *    matrix goes NaN and the backdrop corrupts.
 *  - One in-flight model load at a time, tracked by generation. Overlapping loads
 *    dispose each other's texture and leave the scene empty at capture time.
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js'
import { RectAreaLightHelper } from 'three/examples/jsm/helpers/RectAreaLightHelper.js'
import { defineComponent, h, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'

// Scrub-drag number field, the only control that works on a LiteGraph canvas: HORIZONTAL
// drag to change (vertical sliders fight the canvas), Shift while dragging = ×0.1 fine
// (the Blender/Comfy convention), plain click = type the exact value.
const DragNumber = defineComponent({
  props: {
    modelValue: { type: Number, required: true },
    step: { type: Number, default: 0.01 }, // units per dragged pixel
    min: { type: Number, default: -Infinity },
    max: { type: Number, default: Infinity },
    decimals: { type: Number, default: 2 },
    resetTo: { type: Number, default: null }, // when set, a ↺ appears while the value differs
  },
  emits: ['update:modelValue'],
  setup(p, { emit }) {
    const editing = ref(false)
    const text = ref('')
    let lastX = 0
    let cur = 0 // internal accumulator: the prop lags a tick behind emits mid-drag
    let moved = false
    const clamp = (v: number) => Math.min(p.max, Math.max(p.min, v))
    const commit = () => {
      const v = parseFloat(text.value.replace(',', '.'))
      if (Number.isFinite(v)) emit('update:modelValue', clamp(v))
      editing.value = false
    }
    const onDown = (e: PointerEvent) => {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      lastX = e.clientX
      cur = p.modelValue
      moved = false
    }
    const onMove = (e: PointerEvent) => {
      if (!(e.buttons & 1)) return
      const dx = e.clientX - lastX
      if (!moved && Math.abs(e.clientX - lastX) < 3) return
      lastX = e.clientX
      moved = true
      // Incremental, not from-drag-start: toggling Shift mid-drag must not jump.
      cur = clamp(cur + dx * p.step * (e.shiftKey ? 0.1 : 1))
      emit('update:modelValue', cur)
    }
    const onUp = () => {
      if (moved) return
      text.value = String(+p.modelValue.toFixed(6))
      editing.value = true
    }
    return () =>
      editing.value
        ? h('input', {
            class: 'nkd-drag nkd-drag-edit',
            value: text.value,
            onInput: (e: Event) => (text.value = (e.target as HTMLInputElement).value),
            onBlur: commit,
            onKeydown: (e: KeyboardEvent) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') editing.value = false
              e.stopPropagation() // keep typing away from ComfyUI's shortcuts
            },
            onVnodeMounted: (vn: any) => {
              vn.el.focus()
              vn.el.select()
            },
          })
        : h(
            'div',
            { class: 'nkd-drag', onPointerdown: onDown, onPointermove: onMove, onPointerup: onUp },
            [
              Number.isFinite(p.modelValue) ? p.modelValue.toFixed(p.decimals) : '0',
              p.resetTo != null && p.modelValue !== p.resetTo
                ? h('span', {
                    class: 'nkd-drag-reset',
                    title: 'Reset',
                    // stopPropagation so the reset click doesn't start a scrub-drag or open edit.
                    onPointerdown: (e: PointerEvent) => {
                      e.stopPropagation()
                      e.preventDefault()
                      emit('update:modelValue', clamp(p.resetTo as number))
                    },
                  }, '↺')
                : null,
            ]
          )
  },
})

/**
 * `aspect` is a reactive object, not a plain prop: it mirrors the width/height LiteGraph
 * widgets, which Vue cannot observe on their own. The viewport tracks it so what you see
 * framed here is what capture() exports.
 */
const props = defineProps<{ apiBase: string; aspect: { w: number; h: number } }>()
const emit = defineEmits<{ calibrated: [near: number, far: number] }>()

const host = ref<HTMLDivElement | null>(null)
const showGrid = ref(true)
const status = ref('')
// One tab open at a time: each panel is one row of chrome, and remeasureChrome in main.ts
// only counts the first .nkd-panel it finds.
const activePanel = ref<'' | 'light' | 'object' | 'occlude'>('')
const togglePanel = (p: 'light' | 'object' | 'occlude') => { activePanel.value = activePanel.value === p ? '' : p }

// Look-dev state. It lives here rather than in node widgets on purpose: the render — and
// the capture taken from it — happens in this browser, so a light change needs no round
// trip to the backend. Serialised with the node.
const env = ref(1.0) // strength of the backdrop lighting the model
const lightAz = ref(45)
const lightEl = ref(35)
const lightInt = ref(2.0)
const shadows = ref(true)
const shadowSoft = ref(3)
const shadowStr = ref(0.5)
// Contact shadow: a soft grounding blob rendered from below (three's RTT technique),
// independent of the key light — anchors the object to the floor regardless of key dir.
const contact = ref(false)
const contactStr = ref(0.8)
const contactBlur = ref(1.5)
const contactSpread = ref(0.25) // fraction of object height that casts — low = tight AO contact
// Occlusion is a MATTE (depth-key), not physical: the injected map is thresholded and the
// chosen grey band hides the object — no 3D calibration. occFrom/occTo pick the band, invert
// flips the map. Only meaningful with a scene_depth connected. Serialised with the widget.
const occlude = ref(false)
const depthInvertUI = ref(false)
const occFrom = ref(0.5)
const occTo = ref(1.0)

// Fill lights on TOP of the directional key: soft area (RectAreaLight, LTC) lights the user
// grows. Point/spot were dropped — three can't blur a point's shadow and the area gives the
// soft fill + shadow the whole feature is for. Each aims at a target (default: the origin).
type LightCfg = {
  id: number
  x: number; y: number; z: number
  tx: number; ty: number; tz: number // aim target
  color: string
  intensity: number
  size: number  // area edge (scene units) — also the shadow softness
  shadow: boolean
}
const lights = reactive<LightCfg[]>([])
const selectedLightId = ref<number | null>(null)
let lightSeq = 1

// Object transform, applied on TOP of whatever Model Info handed over (that stays on the
// model itself; this lives on a wrapper group). Rotation/scale happen around a chosen
// pivot — 'bottom' keeps a grounded object on the ground while it scales.
const objPos = reactive({ x: 0, y: 0, z: 0 })
const objRot = reactive({ x: 0, y: 0, z: 0 }) // degrees
const objScale = ref(1)
const pivotMode = ref<'bottom' | 'center' | 'origin'>('bottom')
const gizmoMode = ref<'off' | 'translate' | 'rotate' | 'scale'>('off')
// Splat→mesh converters (Tripo & co.) often ship the texture baked into an UNLIT material or the
// emissive channel, so the object self-lights and ignores shadows. Unbake rebuilds a lit
// MeshStandard using that texture as albedo, so lights and shadows land on it.
const unbake = ref(false)
// Splat meshes are a faceted triangle soup → harsh per-face shading. Smooth averages face normals
// per spatial-grid cell (fast, O(n)); 0 = original, higher = coarser cells = softer shading.
const smooth = ref(0)

const renderer = shallowRef<THREE.WebGLRenderer | null>(null)
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 10000)
let controls: OrbitControls | null = null
let transformControls: TransformControls | null = null
let gizmoHelper: THREE.Object3D | null = null // what actually gets added to the scene in r0.18x
const gizmoLightId = ref<number | null>(null) // when the gizmo is dragging a light body
const gizmoTargetId = ref<number | null>(null) // when the gizmo is dragging a light's aim target
let extraLightsGroup: THREE.Group | null = null
const lightObjs = new Map<number, { light: THREE.Light; caster?: THREE.SpotLight; helper?: THREE.Object3D; target?: THREE.Object3D }>()
let rectLibReady = false

// Background lives in its own scene, drawn before the model with depth off.
const bgScene = new THREE.Scene()
const bgCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1)
let bgMesh: THREE.Mesh | null = null
let bgTexture: THREE.Texture | null = null

// The backdrop's depth, written into the depth buffer so the photo can occlude the model.
// A separate colourless pass rather than folding it into the background material: that keeps
// three's colour-space handling of the photo untouched.
const bgDepthScene = new THREE.Scene()
let bgDepthMesh: THREE.Mesh | null = null
let sceneDepthTexture: THREE.Texture | null = null
let sceneDepthInverseSpace = true // monocular maps are disparity unless the node says otherwise
const hasSceneDepth = ref(false) // mirrors sceneDepthTexture for the template (plain let, not reactive)

const DEPTH_FRAG = `
uniform sampler2D depthMap;
uniform float invert;
uniform float occFrom;
uniform float occTo;
in vec2 vUvD;
out vec4 fragColor;
void main() {
  float d = texture(depthMap, vUvD).r;
  if (invert > 0.5) d = 1.0 - d;
  float dc = clamp(d, 0.0, 1.0);
  // MATTE occlusion (depth-key), NOT physical: the injected map is used directly as a
  // foreground mask. Where the (post-invert) grey lands inside the chosen [occFrom, occTo]
  // band, the scene counts as FOREGROUND and hides the object — depth 0 (nearest) rejects
  // it whatever its own 3D depth. Outside the band, depth 1 (farthest) lets it through.
  float occ = step(occFrom, dc) * step(dc, occTo);
  gl_FragDepth = occ > 0.5 ? 0.0 : 1.0;
  // The depth EXPORT's base layer is the scene map VERBATIM (post-invert, near = white).
  fragColor = vec4(vec3(dc), 1.0);
}
`

const bgDepthMaterial = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  uniforms: {
    depthMap: { value: null },
    invert: { value: 0 },
    occFrom: { value: 0.5 }, // occlude where the (post-invert) grey is in [occFrom, occTo]
    occTo: { value: 1.0 },   // near = white = 1, so [0.5,1] hides behind the nearer half
    // dNear/dFar drive the depth EXPORT's object tone (linearDepthMaterial), not occlusion.
    dNear: { value: 1 },
    dFar: { value: 30 },
  },
  vertexShader: `
    out vec2 vUvD;
    void main() {
      vUvD = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: DEPTH_FRAG,
  // Colour on: the quad only ever draws inside the depth EXPORT, where its greyscale IS
  // the scene layer of the composited depth map. It never occludes the colour renders.
  colorWrite: true,
  depthWrite: true,
  // Depth writes only happen while DEPTH_TEST is enabled — turning the test off (the obvious
  // choice for a pass that should never be rejected) silently discards every write. Keep the
  // test on and let it always pass instead. Measured: with depthTest:false, nothing occludes.
  depthTest: true,
  depthFunc: THREE.AlwaysDepth,
})

// Object depth for the composited export: view-z remapped into the scene map's own
// grey-vs-distance curve, so the object's tone matches the scene's at the same distance.
// Monocular maps are INVERSE depth (disparity): grey ~ 1/z, falling off fast near the
// camera — a linear remap there paints a mid-room object near-white (measured). `inv`
// picks the curve; dNear/dFar anchor it, same values that place the map in scene units.
const linearDepthMaterial = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  uniforms: { dNear: { value: 1 }, dFar: { value: 30 }, inv: { value: 1 } },
  vertexShader: `
    out float vZ;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vZ = -mv.z;
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: `
    uniform float dNear;
    uniform float dFar;
    uniform float inv;
    in float vZ;
    out vec4 fragColor;
    void main() {
      float z = max(vZ, 1e-4);
      float g = inv > 0.5
        ? (1.0 / z - 1.0 / dFar) / (1.0 / dNear - 1.0 / dFar)
        : (dFar - z) / (dFar - dNear);
      fragColor = vec4(vec3(clamp(g, 0.0, 1.0)), 1.0);
    }
  `,
})

let grid: THREE.GridHelper | null = null
let pivotGroup: THREE.Group | null = null // wraps the model; carries the user transform
let pivotP = new THREE.Vector3() // pivot point in group-local space, cached
let keyLight: THREE.DirectionalLight | null = null
let shadowCatcher: THREE.Mesh | null = null

// ── Contact shadow (RTT) ─ three's webgl_shadow_contact technique: an ortho camera under
// the object renders its depth into a target, two blur passes soften it, and a ground plane
// shows the result. Recomputed only when the object moves (contactDirty) — light-independent.
let contactGroup: THREE.Group | null = null
let contactRT: THREE.WebGLRenderTarget | null = null
let contactRTBlur: THREE.WebGLRenderTarget | null = null
let contactPlane: THREE.Mesh | null = null
let contactBlurPlane: THREE.Mesh | null = null
let contactCam: THREE.OrthographicCamera | null = null
let contactDepthMat: THREE.MeshDepthMaterial | null = null
let contactHBlur: THREE.ShaderMaterial | null = null
let contactVBlur: THREE.ShaderMaterial | null = null
let contactDirty = true
const CONTACT_RES = 512

// Separable 9-tap gaussian, ported from three's Horizontal/VerticalBlurShader.
const BLUR_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`
const blurFrag = (axis: 'x' | 'y') => `
  uniform sampler2D tDiffuse; uniform float amount; varying vec2 vUv;
  void main() {
    vec4 sum = vec4(0.0);
    vec2 d = ${axis === 'x' ? 'vec2(amount, 0.0)' : 'vec2(0.0, amount)'};
    sum += texture2D(tDiffuse, vUv - 4.0*d) * 0.051;
    sum += texture2D(tDiffuse, vUv - 3.0*d) * 0.0918;
    sum += texture2D(tDiffuse, vUv - 2.0*d) * 0.12245;
    sum += texture2D(tDiffuse, vUv - 1.0*d) * 0.1531;
    sum += texture2D(tDiffuse, vUv) * 0.1633;
    sum += texture2D(tDiffuse, vUv + 1.0*d) * 0.1531;
    sum += texture2D(tDiffuse, vUv + 2.0*d) * 0.12245;
    sum += texture2D(tDiffuse, vUv + 3.0*d) * 0.0918;
    sum += texture2D(tDiffuse, vUv + 4.0*d) * 0.051;
    gl_FragColor = sum;
  }
`
let pmrem: THREE.PMREMGenerator | null = null
let envRT: THREE.WebGLRenderTarget | null = null
let model: THREE.Object3D | null = null
let modelIsSplat = false
let sparkRenderer: THREE.Object3D | null = null // Spark's draw pass; nothing paints splats without it
let loadGeneration = 0
let raf = 0
let ro: ResizeObserver | null = null

const C = { bg: 0x111318 }

function initScene() {
  scene.background = null
  grid = new THREE.GridHelper(10, 10, 0x4ab4ff, 0x2a2d36)
  ;(grid.material as THREE.Material).opacity = 0.35
  ;(grid.material as THREE.Material).transparent = true
  scene.add(grid)

  // Low ambient only: the backdrop's own colour does the filling, via scene.environment.
  scene.add(new THREE.AmbientLight(0xffffff, 0.15))

  pivotGroup = new THREE.Group()
  scene.add(pivotGroup)

  keyLight = new THREE.DirectionalLight(0xffffff, lightInt.value)
  keyLight.castShadow = true
  keyLight.shadow.mapSize.set(2048, 2048)
  keyLight.shadow.bias = -0.0015
  keyLight.shadow.blurSamples = 25 // VSM gaussian samples for the soft blur
  scene.add(keyLight)
  scene.add(keyLight.target)

  // Catches the key light's shadow and nothing else, so the model drops a shadow onto the
  // photo. fSpy puts the origin on the ground, which is why y=0 is the right plane.
  shadowCatcher = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.ShadowMaterial({ opacity: shadowStr.value })
  )
  shadowCatcher.rotation.x = -Math.PI / 2
  shadowCatcher.receiveShadow = true
  scene.add(shadowCatcher)

  applyLighting()
  initContactShadow()
  initExtraLights()

  bgMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({ color: C.bg, depthWrite: false, depthTest: false })
  )
  bgScene.add(bgMesh)

  // Same geometry and scale as the backdrop, so its depth lands on the same pixels.
  bgDepthMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgDepthMaterial)
  bgDepthScene.add(bgDepthMesh)

  camera.position.set(2, 1.5, 3)
  camera.lookAt(0, 0, 0)
}

/** Cover-fit the backdrop quad. Bails on a non-finite aspect rather than writing NaN.
 *  The depth quad gets the same scale — any mismatch and the occlusion lands off-register. */
function fitBackground() {
  if (!renderer.value) return
  const image = bgTexture?.image ?? sceneDepthTexture?.image
  if (!image) return
  const size = renderer.value.getSize(new THREE.Vector2())
  const imageAspect = image.width / image.height
  const targetAspect = size.x / size.y
  if (!isFinite(imageAspect) || !isFinite(targetAspect) || targetAspect <= 0) return
  const sx = imageAspect > targetAspect ? imageAspect / targetAspect : 1
  const sy = imageAspect > targetAspect ? 1 : targetAspect / imageAspect
  bgMesh?.scale.set(sx, sy, 1)
  bgDepthMesh?.scale.set(sx, sy, 1)
}

/** Draws the backdrop, then its depth (if any), then the model — which is depth-tested
 *  against it, so the photo can occlude the model. `drawBackdrop` off keeps the depth
 *  occlusion while leaving the colour out, which is what the isolated-object capture wants. */
/** Push the look-dev state onto the scene. Called on every control change. */
function applyLighting() {
  scene.environmentIntensity = env.value
  if (keyLight) {
    // The joystick is CAMERA-relative on the horizontal axis: az 0 = from the viewer,
    // 90 = from screen-right. Add the camera's yaw so an injected (fSpy) or orbited
    // camera still reads the widget as a frontal perspective. Elevation stays global.
    const fwd = camera.getWorldDirection(new THREE.Vector3())
    const camYaw = Math.atan2(-fwd.x, -fwd.z)
    const az = THREE.MathUtils.degToRad(lightAz.value) + camYaw
    const el = THREE.MathUtils.degToRad(lightEl.value)
    // Far enough out that the shadow frustum covers the model whatever its scale.
    const d = 30
    keyLight.position.set(
      d * Math.cos(el) * Math.sin(az),
      d * Math.sin(el),
      d * Math.cos(el) * Math.cos(az)
    )
    keyLight.target.position.set(0, 0, 0)
    keyLight.intensity = lightInt.value
    keyLight.castShadow = shadows.value
    keyLight.shadow.radius = shadowSoft.value // spreads the PCF kernel; needs PCFShadowMap
    const cam = keyLight.shadow.camera as THREE.OrthographicCamera
    cam.left = -12; cam.right = 12; cam.top = 12; cam.bottom = -12
    cam.near = 0.5; cam.far = 80
    cam.updateProjectionMatrix()
  }
  if (shadowCatcher) {
    ;(shadowCatcher.material as THREE.ShadowMaterial).opacity = shadowStr.value
    shadowCatcher.visible = shadows.value
  }
  drawSphere()
}

// ── Key-light sphere joystick (same control as Relight's directional widget) ──
const sphereCv = ref<HTMLCanvasElement | null>(null)
const SPHERE_R = 42

function drawSphere() {
  const cv = sphereCv.value
  if (!cv) return // panel closed; redrawn when it opens
  const ctx = cv.getContext('2d')
  if (!ctx) return
  const cx = cv.width / 2
  const cy = cv.height / 2
  const r = SPHERE_R
  ctx.clearRect(0, 0, cv.width, cv.height)

  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.clip()
  const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.05, cx, cy, r)
  grad.addColorStop(0, 'rgba(65,65,92,0.94)')
  grad.addColorStop(1, 'rgba(10,10,20,0.94)')
  ctx.fillStyle = grad
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2)
  ctx.strokeStyle = 'rgba(110,110,150,0.28)'
  ctx.lineWidth = 1
  for (const latDeg of [0, 30, -30, 60, -60]) {
    const latRad = (latDeg * Math.PI) / 180
    const ry = Math.cos(latRad) * r
    ctx.beginPath()
    ctx.ellipse(cx, cy - Math.sin(latRad) * r, ry, ry * 0.22, 0, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.beginPath()
  ctx.ellipse(cx, cy, r * 0.22, r, 0, 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(cx - r * 0.32, cy - r * 0.38, r * 0.16, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(255,255,255,0.09)'
  ctx.fill()
  ctx.restore()

  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(140,140,180,0.6)'
  ctx.lineWidth = 1.5
  ctx.stroke()

  // Same frame as the key light: +elevation is up, azimuth 0 points at the viewer.
  const az = THREE.MathUtils.degToRad(lightAz.value)
  const el = THREE.MathUtils.degToRad(lightEl.value)
  const dotX = cx + (r - 4) * Math.cos(el) * Math.sin(az)
  const dotY = cy - (r - 4) * Math.sin(el)
  const behind = Math.cos(el) * Math.cos(az) < 0

  ctx.beginPath()
  ctx.moveTo(cx, cy)
  ctx.lineTo(dotX, dotY)
  ctx.strokeStyle = behind ? 'rgba(74,180,255,0.27)' : 'rgba(74,180,255,0.73)'
  ctx.lineWidth = 1.5
  ctx.stroke()

  const ch = r * 0.08
  ctx.strokeStyle = 'rgba(180,180,200,0.4)'
  ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(cx - ch, cy); ctx.lineTo(cx + ch, cy); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(cx, cy - ch); ctx.lineTo(cx, cy + ch); ctx.stroke()

  ctx.beginPath()
  ctx.arc(dotX, dotY, 5, 0, Math.PI * 2)
  ctx.fillStyle = behind ? 'rgba(74,180,255,0.33)' : '#4ab4ff'
  ctx.fill()
  ctx.strokeStyle = behind ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.9)'
  ctx.lineWidth = 1
  ctx.stroke()
}

function onSphereDown(e: PointerEvent) {
  const cv = sphereCv.value
  if (!cv) return
  e.preventDefault()
  cv.setPointerCapture(e.pointerId)
  let prevX = e.clientX
  let prevY = e.clientY
  const sens = 90 / SPHERE_R // degrees per pixel, same feel as Relight's widget
  const onMove = (ev: PointerEvent) => {
    lightAz.value = Math.round((((lightAz.value + (ev.clientX - prevX) * sens) % 360) + 540) % 360 - 180)
    lightEl.value = Math.round(Math.max(-90, Math.min(90, lightEl.value - (ev.clientY - prevY) * sens)))
    prevX = ev.clientX
    prevY = ev.clientY
    applyLighting()
  }
  const onUp = () => {
    cv.removeEventListener('pointermove', onMove)
    cv.removeEventListener('pointerup', onUp)
  }
  cv.addEventListener('pointermove', onMove)
  cv.addEventListener('pointerup', onUp)
}

// The panel is v-if'd, so the canvas only exists while it is open.
watch(activePanel, (p) => { if (p === 'light') void nextTick(drawSphere) })

/** The backdrop as an environment, so the model picks up the scene's colour.
 *  A flat photo is not a 360 capture — this is a colour cast, not true reflections. */
function updateEnvironment() {
  const r = renderer.value
  if (!r) return
  envRT?.dispose()
  envRT = null
  scene.environment = null
  if (!bgTexture) return
  pmrem = pmrem ?? new THREE.PMREMGenerator(r)
  pmrem.compileEquirectangularShader()
  // Clone: the backdrop quad draws from this same texture, and switching its mapping to
  // equirect would wreck how the photo itself is drawn.
  const equirect = bgTexture.clone()
  equirect.mapping = THREE.EquirectangularReflectionMapping
  envRT = pmrem.fromEquirectangular(equirect)
  equirect.dispose()
  scene.environment = envRT.texture
  scene.environmentIntensity = env.value
}

function initContactShadow() {
  contactRT = new THREE.WebGLRenderTarget(CONTACT_RES, CONTACT_RES)
  contactRT.texture.generateMipmaps = false
  contactRTBlur = new THREE.WebGLRenderTarget(CONTACT_RES, CONTACT_RES)
  contactRTBlur.texture.generateMipmaps = false

  contactGroup = new THREE.Group()
  contactGroup.visible = false
  scene.add(contactGroup)

  // 1×1 plane lying in XZ; scaled to the object footprint at render time.
  const geo = new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2)
  contactPlane = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ map: contactRT.texture, transparent: true, depthWrite: false, opacity: 1 })
  )
  contactPlane.rotation.x = Math.PI // the depth buffer is captured upside down
  contactPlane.renderOrder = 2
  contactPlane.position.y = 0.001 // hair above the floor so it never z-fights the grid
  contactGroup.add(contactPlane)

  contactBlurPlane = new THREE.Mesh(geo)
  contactBlurPlane.visible = false
  contactGroup.add(contactBlurPlane)

  // Looks straight up from y=0; near/far span the object's height, set per render.
  contactCam = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1)
  contactCam.rotation.x = Math.PI / 2
  contactGroup.add(contactCam)

  // MeshDepthMaterial patched to paint black with distance-faded alpha (near = dark).
  contactDepthMat = new THREE.MeshDepthMaterial()
  contactDepthMat.depthTest = false
  contactDepthMat.depthWrite = false
  const darkness = { value: contactStr.value }
  ;(contactDepthMat as any).userData.darkness = darkness
  contactDepthMat.onBeforeCompile = (shader) => {
    shader.uniforms.darkness = darkness
    shader.fragmentShader =
      'uniform float darkness;\n' +
      shader.fragmentShader.replace(
        'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
        'gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * darkness );'
      )
  }

  const blurUniforms = () => ({ tDiffuse: { value: null }, amount: { value: 1 / CONTACT_RES } })
  contactHBlur = new THREE.ShaderMaterial({ uniforms: blurUniforms(), vertexShader: BLUR_VERT, fragmentShader: blurFrag('x') })
  contactVBlur = new THREE.ShaderMaterial({ uniforms: blurUniforms(), vertexShader: BLUR_VERT, fragmentShader: blurFrag('y') })
}

/** Centre the contact rig under the object and size it to the footprint. y stays at the
 *  fSpy floor (0), so the shadow lands on the ground even as the object floats/scales. */
function updateContactBounds() {
  if (!contactGroup || !contactCam || !contactPlane || !contactBlurPlane || !model) return
  const box = new THREE.Box3().setFromObject(model)
  if (box.isEmpty()) return
  const c = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())
  const foot = Math.max(size.x, size.z) * 1.15 + 0.02
  // AO-style contact: capture only the LOWER slab of the object (contactSpread × height up
  // from the floor). Arms/limbs above it are clipped, so the shadow stays a tight grounding
  // footprint instead of the full spread-out silhouette.
  const slab = Math.max(size.y * contactSpread.value, 0.03)
  contactGroup.position.set(c.x, 0, c.z)
  contactCam.left = -foot / 2; contactCam.right = foot / 2
  contactCam.top = foot / 2; contactCam.bottom = -foot / 2
  contactCam.far = slab
  contactCam.updateProjectionMatrix()
  contactPlane.scale.set(foot, 1, foot)
  contactBlurPlane.scale.set(foot, 1, foot)
}

function blurContact(amount: number) {
  const r = renderer.value
  if (!r || !contactBlurPlane || !contactHBlur || !contactVBlur || !contactRT || !contactRTBlur || !contactCam) return
  contactBlurPlane.visible = true
  contactBlurPlane.material = contactHBlur
  contactHBlur.uniforms.tDiffuse.value = contactRT.texture
  contactHBlur.uniforms.amount.value = amount / CONTACT_RES
  r.setRenderTarget(contactRTBlur)
  r.render(contactBlurPlane, contactCam)
  contactBlurPlane.material = contactVBlur
  contactVBlur.uniforms.tDiffuse.value = contactRTBlur.texture
  contactVBlur.uniforms.amount.value = amount / CONTACT_RES
  r.setRenderTarget(contactRT)
  r.render(contactBlurPlane, contactCam)
  contactBlurPlane.visible = false
}

/** Render the grounding shadow into contactRT. Splats have no mesh depth → skipped. */
function renderContactShadow() {
  const r = renderer.value
  if (!r || !contactGroup || !contactCam || !contactDepthMat || !contactRT || !model || modelIsSplat) return
  updateContactBounds()
  ;(contactDepthMat as any).userData.darkness.value = contactStr.value

  const prevRT = r.getRenderTarget()
  const prevClear = r.getClearColor(new THREE.Color())
  const prevAlpha = r.getClearAlpha()
  const wasGrid = grid?.visible; const wasCatcher = shadowCatcher?.visible
  if (grid) grid.visible = false // only the object should cast into the map
  if (shadowCatcher) shadowCatcher.visible = false
  // Keep the group visible so the blur plane (its child) can render; hide only the
  // display plane so it doesn't capture itself into the depth map.
  contactGroup.visible = true
  if (contactPlane) contactPlane.visible = false

  scene.overrideMaterial = contactDepthMat
  r.setRenderTarget(contactRT)
  r.setClearColor(0x000000, 0) // transparent = no shadow; the depth mat writes black + alpha
  r.clear()
  r.render(scene, contactCam)
  scene.overrideMaterial = null

  blurContact(contactBlur.value)
  blurContact(contactBlur.value * 0.4)

  r.setRenderTarget(prevRT)
  r.setClearColor(prevClear, prevAlpha)
  if (grid) grid.visible = !!wasGrid
  if (shadowCatcher) shadowCatcher.visible = !!wasCatcher
  if (contactPlane) contactPlane.visible = true
  contactGroup.visible = contact.value
}

/** Lay the matte into the depth buffer (colour off): occluder-band pixels get depth 0 so the
 *  object is rejected there. Only called in the composite pass when Occlude is on. */
function layBackdropDepth() {
  const r = renderer.value
  if (!r) return
  bgDepthMaterial.colorWrite = false
  r.render(bgDepthScene, bgCamera)
  bgDepthMaterial.colorWrite = true
}

// By default the scene depth never occludes the colour renders (the object composites over
// the backdrop). With Occlude on, the composite pass lays the photo's depth first so nearer
// foreground hides the model. The mask/object pass (drawBackdrop=false) never occludes — the
// silhouette must stay whole.
function renderFrame(drawBackdrop = true) {
  const r = renderer.value
  if (!r) return
  r.autoClear = false
  r.clear()
  if (drawBackdrop) {
    const tone = r.toneMapping
    r.toneMapping = THREE.NoToneMapping
    r.render(bgScene, bgCamera)
    r.toneMapping = tone
    if (occlude.value && sceneDepthTexture) layBackdropDepth()
  }
  r.render(scene, camera)
  r.autoClear = true
}

// The active LiteGraph canvas zoom. The widget renders at this scale so it stays crisp when
// the graph is zoomed in (the zoom is a CSS transform the renderer can't otherwise see).
function lgScale(): number {
  const a = (window as any).comfyAPI?.app?.app ?? (window as any).app
  const s = a?.canvas?.ds?.scale
  return typeof s === 'number' && s > 0 ? s : 1
}

let lastScale = 0
function loop() {
  controls?.update()
  // Re-fit the resolution when the canvas zoom changes — a CSS transform that fires no
  // ResizeObserver, so it must be polled. Reading a number (no layout reflow) is cheap.
  const s = lgScale()
  if (Math.abs(s - lastScale) > 0.001) { lastScale = s; resize() }
  if (contact.value && contactDirty) { renderContactShadow(); contactDirty = false }
  renderFrame()
  raf = requestAnimationFrame(loop)
}

// Toggling on/off shows or hides the ground plane; turning on forces a fresh bake.
watch(contact, (on) => {
  if (contactGroup) contactGroup.visible = on
  if (on) contactDirty = true
})
// Darkness/blur/spread changes only need a re-bake, not a transform recompute.
watch([contactStr, contactBlur, contactSpread], () => { contactDirty = true })

/**
 * The box's height comes from CSS (aspect-ratio bound to the width/height widgets), so
 * the element has a natural height derived from its width — the same formula the node
 * entry uses to reserve vertical space (Sigmas Curve architecture: node and content
 * agree by construction, no dependence on the host handing a height down). Bail while
 * the element has no width: sizing the canvas to 1x1 and letting layout see it is what
 * produced a giant square before.
 */
function resize() {
  const r = renderer.value
  const el = host.value
  if (!r || !el) return
  const w = el.clientWidth
  const h = el.clientHeight || Math.round((w * props.aspect.h) / props.aspect.w)
  if (w < 1 || h < 1) return
  // The displayed size is clientWidth × the LiteGraph canvas zoom (a CSS transform that
  // clientWidth doesn't see). Render at dpr × zoom × 2 so the buffer matches the on-screen
  // pixels with 2× supersampling — crisp at any zoom. Capped so a big zoom can't allocate a
  // giant target. updateStyle=false keeps the canvas CSS at 100%; only the backing buffer grows.
  const MAX_BUF = 4096
  const target = Math.min(window.devicePixelRatio, 2) * lgScale() * 2
  const ratio = Math.max(0.5, Math.min(target, MAX_BUF / Math.max(w, h)))
  r.setPixelRatio(ratio)
  r.setSize(w, h, false)
  camera.aspect = props.aspect.w / props.aspect.h
  camera.updateProjectionMatrix()
  fitBackground()
}

// width/height folded back from the backend (or edited on the node) re-fit the canvas.
// The CSS aspect-ratio change resizes the host, so the ResizeObserver also fires; this
// watch is the belt for frames where the width happens to stay identical.
watch(() => [props.aspect.w, props.aspect.h], () => resize())

function viewUrl(ref: { filename: string; type: string; subfolder: string }) {
  const q = new URLSearchParams({
    filename: ref.filename,
    type: ref.type,
    subfolder: ref.subfolder || '',
    rand: String(Math.random()),
  })
  return `${props.apiBase}/view?${q}`
}

async function setBackground(ref: { filename: string; type: string; subfolder: string } | null) {
  if (!ref) {
    bgTexture?.dispose()
    bgTexture = null
    if (bgMesh) {
      const m = bgMesh.material as THREE.MeshBasicMaterial
      m.map = null
      m.color.set(C.bg)
      m.needsUpdate = true
      bgMesh.scale.set(1, 1, 1)
    }
    return
  }
  const texture = await new THREE.TextureLoader().loadAsync(viewUrl(ref))
  texture.colorSpace = THREE.SRGBColorSpace
  bgTexture?.dispose()
  bgTexture = texture
  if (bgMesh) {
    const m = bgMesh.material as THREE.MeshBasicMaterial
    m.map = texture
    m.color.set(0xffffff)
    m.needsUpdate = true
  }
  fitBackground()
  updateEnvironment()
}

// Gaussian splats render through Spark (same library the native Load3D uses): a
// SplatMesh is a regular Object3D in our scene, so no conversion to geometry.
// Dynamically imported — GLB-only users never pay for the extra chunk.
const SPLAT_EXTS = /\.(splat|spz|ksplat)$/i

/** PLY is ambiguous: Preview Splat & co. serialise gaussians as .ply too. A splat PLY
 *  declares gaussian properties (f_dc_*, opacity, scale_*) in its ASCII header — read
 *  just the first chunk, never the whole file. */
async function isGaussianPly(url: string): Promise<boolean> {
  const resp = await fetch(url)
  const reader = resp.body?.getReader()
  if (!reader) return false
  const dec = new TextDecoder('ascii')
  let text = ''
  while (text.length < 16384) {
    const { value, done } = await reader.read()
    if (value) text += dec.decode(value, { stream: true })
    if (done || text.includes('end_header')) break
  }
  void reader.cancel().catch(() => {})
  const end = text.indexOf('end_header')
  const header = end >= 0 ? text.slice(0, end) : text
  return /property\s+\S+\s+(f_dc_0|opacity|scale_0)\b/.test(header)
}

/** Log what materials a freshly-loaded model uses — surfaces the "baked / unlit" case. */
function logModelMaterials() {
  if (!model || modelIsSplat) return
  const types = new Set<string>()
  let unlit = 0
  let emissiveBaked = 0
  model.traverse((c) => {
    if (!(c instanceof THREE.Mesh)) return
    const m: any = Array.isArray(c.material) ? c.material[0] : c.material
    if (!m) return
    types.add(m.type)
    if (m.type === 'MeshBasicMaterial') unlit++
    if (m.emissiveMap && !m.map) emissiveBaked++
  })
  console.log(
    `[NKD Preview 3D] model materials: ${[...types].join(', ') || '(none)'}; ` +
    `unlit=${unlit}, emissive-baked=${emissiveBaked}` +
    (unlit || emissiveBaked ? ' — self-lit, will not receive shadows. Try Unbake in the Object panel.' : '')
  )
}

/** Rebuild lit materials from baked/unlit ones so the model responds to lights and shadows.
 *  Reversible: the source material is stashed on the mesh and restored when Unbake is off. */
function applyUnbake() {
  if (!model || modelIsSplat) return
  model.traverse((c) => {
    if (!(c instanceof THREE.Mesh)) return
    const mesh = c as THREE.Mesh
    if (unbake.value) {
      if (!mesh.userData.nkdOrigMat) mesh.userData.nkdOrigMat = mesh.material
      const src: any = Array.isArray(mesh.userData.nkdOrigMat) ? mesh.userData.nkdOrigMat[0] : mesh.userData.nkdOrigMat
      // Use whatever carries the colour — baseColor map first, else the emissive bake.
      const tex = src?.map ?? src?.emissiveMap ?? null
      if (tex) tex.colorSpace = THREE.SRGBColorSpace
      const lit = new THREE.MeshStandardMaterial({
        map: tex,
        color: src?.map ? (src.color?.clone?.() ?? new THREE.Color(0xffffff)) : new THREE.Color(0xffffff),
        vertexColors: !!src?.vertexColors,
        roughness: 0.85,
        metalness: 0.0,
        side: src?.side ?? THREE.FrontSide,
      })
      if (!mesh.geometry.attributes.normal) mesh.geometry.computeVertexNormals() // lit shading needs normals
      mesh.material = lit
    } else if (mesh.userData.nkdOrigMat) {
      ;(mesh.material as THREE.Material)?.dispose?.()
      mesh.material = mesh.userData.nkdOrigMat
      delete mesh.userData.nkdOrigMat
    }
  })
}
watch(unbake, applyUnbake)

/** Fast normal smoothing for millions-of-tris splat meshes. Welds ONLY coincident vertices (a
 *  tiny `cell` epsilon — distinct surface vertices stay distinct, so no blocky "decimation"
 *  look), averaging the area-weighted face normals sharing each position into a true smooth
 *  vertex normal. Then blends the original (faceted) normal toward that smooth one by `blend`
 *  (0..1), so the slider softens facets gradually. One accumulate pass + one write pass. */
function gridSmoothNormals(geo: THREE.BufferGeometry, cell: number, blend: number) {
  const pos = geo.attributes.position
  const idx = geo.index
  const vcount = pos.count
  const triCount = (idx ? idx.count : vcount) / 3
  if (!geo.attributes.normal) geo.computeVertexNormals() // baseline to blend from
  const orig = geo.attributes.normal
  const inv = 1 / cell
  const acc = new Map<string, [number, number, number]>()
  const key = (i: number) =>
    Math.round(pos.getX(i) * inv) + ',' + Math.round(pos.getY(i) * inv) + ',' + Math.round(pos.getZ(i) * inv)
  const bump = (i: number, nx: number, ny: number, nz: number) => {
    const k = key(i), e = acc.get(k)
    if (e) { e[0] += nx; e[1] += ny; e[2] += nz } else acc.set(k, [nx, ny, nz])
  }
  for (let t = 0; t < triCount; t++) {
    const ia = idx ? idx.getX(t * 3) : t * 3, ib = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, ic = idx ? idx.getX(t * 3 + 2) : t * 3 + 2
    const ax = pos.getX(ia), ay = pos.getY(ia), az = pos.getZ(ia)
    const ux = pos.getX(ib) - ax, uy = pos.getY(ib) - ay, uz = pos.getZ(ib) - az
    const vx = pos.getX(ic) - ax, vy = pos.getY(ic) - ay, vz = pos.getZ(ic) - az
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx // area-weighted
    bump(ia, nx, ny, nz); bump(ib, nx, ny, nz); bump(ic, nx, ny, nz)
  }
  const out = new Float32Array(vcount * 3)
  for (let i = 0; i < vcount; i++) {
    const ox = orig.getX(i), oy = orig.getY(i), oz = orig.getZ(i)
    const e = acc.get(key(i))
    let sx = ox, sy = oy, sz = oz
    if (e) {
      const l = Math.hypot(e[0], e[1], e[2]) || 1
      sx = e[0] / l; sy = e[1] / l; sz = e[2] / l
      if (sx * ox + sy * oy + sz * oz < 0) { sx = -sx; sy = -sy; sz = -sz } // align to the original hemisphere
    }
    let bx = ox + (sx - ox) * blend, by = oy + (sy - oy) * blend, bz = oz + (sz - oz) * blend
    const bl = Math.hypot(bx, by, bz) || 1
    out[i * 3] = bx / bl; out[i * 3 + 1] = by / bl; out[i * 3 + 2] = bz / bl
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(out, 3))
}

/** Laplacian diffusion of the normal field over an INDEXED mesh: each iteration replaces every
 *  vertex normal with the average of the normals of the triangles it belongs to (its one-ring),
 *  so bumpy normals flatten toward the local surface trend. Reduces GEOMETRIC bumpiness in the
 *  shading, not just faceting. Typed-array only (no Map/strings) → fast. More iterations = softer. */
function laplacianSmoothNormals(geo: THREE.BufferGeometry, iterations: number) {
  const idx = geo.index!
  const tri = idx.array
  const tcount = idx.count / 3
  const vcount = geo.attributes.position.count
  if (!geo.attributes.normal) geo.computeVertexNormals()
  const na = geo.attributes.normal
  const N = new Float32Array(vcount * 3)
  for (let i = 0; i < vcount; i++) { N[i * 3] = na.getX(i); N[i * 3 + 1] = na.getY(i); N[i * 3 + 2] = na.getZ(i) }
  const acc = new Float32Array(vcount * 3)
  for (let it = 0; it < iterations; it++) {
    acc.fill(0)
    for (let t = 0; t < tcount; t++) {
      const a3 = tri[t * 3] * 3, b3 = tri[t * 3 + 1] * 3, c3 = tri[t * 3 + 2] * 3
      const sx = N[a3] + N[b3] + N[c3], sy = N[a3 + 1] + N[b3 + 1] + N[c3 + 1], sz = N[a3 + 2] + N[b3 + 2] + N[c3 + 2]
      acc[a3] += sx; acc[a3 + 1] += sy; acc[a3 + 2] += sz
      acc[b3] += sx; acc[b3 + 1] += sy; acc[b3 + 2] += sz
      acc[c3] += sx; acc[c3 + 1] += sy; acc[c3 + 2] += sz
    }
    for (let i = 0; i < vcount; i++) {
      const i3 = i * 3, x = acc[i3], y = acc[i3 + 1], z = acc[i3 + 2]
      const l = Math.hypot(x, y, z)
      if (l > 1e-9) { N[i3] = x / l; N[i3 + 1] = y / l; N[i3 + 2] = z / l }
    }
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(N, 3))
}

/** Smooth the faceted shading of a splat-derived mesh. Reversible (pristine geometry stashed,
 *  restored at 0). Runs on a clone so the original normals survive. Always uses the grid average:
 *  it welds by POSITION cell, so it works whether or not the mesh is indexed — a "native
 *  computeVertexNormals" fast path silently does nothing when the index doesn't actually share
 *  vertices (the usual splat case), which read as "the slider has no effect". */
function applySmoothNormals() {
  if (!model || modelIsSplat) return
  const amount = smooth.value
  model.traverse((c) => {
    if (!(c instanceof THREE.Mesh)) return
    const mesh = c as THREE.Mesh
    if (!mesh.userData.nkdOrigGeom) mesh.userData.nkdOrigGeom = mesh.geometry
    const orig = mesh.userData.nkdOrigGeom as THREE.BufferGeometry
    if (mesh.geometry !== orig) mesh.geometry.dispose()
    if (amount <= 0) { mesh.geometry = orig; return }
    const g = orig.clone()
    if (g.index) {
      laplacianSmoothNormals(g, Math.max(1, Math.round(amount / 7))) // amount 0..200 → ~1..29 passes
    } else {
      if (!g.boundingBox) g.computeBoundingBox()
      const s = g.boundingBox!.getSize(new THREE.Vector3())
      gridSmoothNormals(g, Math.max((Math.max(s.x, s.y, s.z) || 1) * 1e-4, 1e-7), amount / 100)
    }
    // The lit material must use these vertex normals; unlit (MeshBasic) ignores them → enable Unbake.
    const mat: any = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    if (mat && mat.flatShading) { mat.flatShading = false; mat.needsUpdate = true }
    mesh.geometry = g
  })
}

/** One load in flight; a newer call wins and the stale one drops its result. */
async function setModel(ref: { filename: string; type: string; subfolder: string } | null) {
  const generation = ++loadGeneration
  if (!ref) return
  status.value = 'Loading model…'
  try {
    let loaded: THREE.Object3D
    let loadedIsSplat = false
    const url = viewUrl(ref)
    const isPly = /\.ply$/i.test(ref.filename)
    if (SPLAT_EXTS.test(ref.filename) || (isPly && (await isGaussianPly(url)))) {
      const { SplatMesh, SparkRenderer } = await import('@sparkjsdev/spark')
      // Spark does NOT auto-create its renderer (checked in the dist): without a
      // SparkRenderer in the scene a SplatMesh loads fine and draws nothing.
      if (!sparkRenderer && renderer.value) {
        sparkRenderer = new SparkRenderer({ renderer: renderer.value })
        scene.add(sparkRenderer)
      }
      const splat = new SplatMesh({ url })
      await splat.initialized
      console.log(`[NKD Preview 3D] splat loaded: ${(splat as any).packedSplats?.numSplats ?? '?'} splats`)
      // Gaussian splats use the OpenCV frame (Y down): flip 180° about X to three's Y-up.
      // On a wrapper group, so Model Info / the Object panel never stomp the correction.
      splat.rotation.x = Math.PI
      loaded = new THREE.Group()
      loaded.add(splat)
      loadedIsSplat = true
    } else if (isPly) {
      throw new Error('PLY without gaussian data — mesh PLY is not supported, use GLB')
    } else {
      loaded = (await new GLTFLoader().loadAsync(url)).scene
    }
    if (generation !== loadGeneration) return // superseded; leave the newer load alone
    if (model) {
      model.removeFromParent()
      model = null
    }
    model = loaded
    modelIsSplat = loadedIsSplat
    model.name = 'NKDModel'
    if (!modelIsSplat) {
      model.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.castShadow = true
          // Receive too, or the object shows no self-shadowing (an arm over the body) and the
          // per-light Size (shadow.radius) has nothing to soften on the model itself.
          child.receiveShadow = true
        }
      })
      logModelMaterials()
      applyUnbake() // re-apply if Unbake was left on for the previous model
      applySmoothNormals()
    }
    ;(pivotGroup ?? scene).add(model)
    recomputePivot()
    applyObjectTransform()
    status.value = ''
  } catch (e: any) {
    if (generation === loadGeneration) status.value = `Model failed: ${e?.message ?? e}`
  }
}

function applyCameraInfo(info: any) {
  if (!info?.position) return
  camera.position.set(info.position.x, info.position.y, info.position.z)
  if (info.quaternion) {
    camera.quaternion.set(info.quaternion.x, info.quaternion.y, info.quaternion.z, info.quaternion.w)
  }
  if (typeof info.fov === 'number') camera.fov = info.fov
  if (typeof info.zoom === 'number') camera.zoom = info.zoom
  camera.updateProjectionMatrix()
  if (controls && info.target) {
    controls.target.set(info.target.x, info.target.y, info.target.z)
    controls.update()
  }
  applyLighting() // the camera-relative key light must follow the injected yaw
}

function applyModelInfo(list: any) {
  const t = Array.isArray(list) ? list[0] : list
  if (!t || !model) return
  if (t.position) model.position.set(t.position.x, t.position.y, t.position.z)
  if (t.quaternion) model.quaternion.set(t.quaternion.x, t.quaternion.y, t.quaternion.z, t.quaternion.w)
  if (t.scale) model.scale.set(t.scale.x, t.scale.y, t.scale.z)
  // The inner placement moved — the bbox (and so the pivot) moved with it.
  recomputePivot()
  applyObjectTransform()
}

// ── Object transform (pivot-aware) ──────────────────────────────────────────
// Model Info's transform stays on the model; the user's lives on pivotGroup as
// world = T(pos) ∘ [rotate/scale about pivotP]. 'bottom' pivots at the bbox's
// floor centre, so a grounded object scales up without leaving the ground.

/** Model bbox in group-local space: measured with the group forced to identity,
 *  because Box3.setFromObject works off world matrices. */
function recomputePivot() {
  const g = pivotGroup
  if (!g || !model) return
  if (pivotMode.value === 'origin') {
    pivotP.set(0, 0, 0)
    return
  }
  const saved = { p: g.position.clone(), q: g.quaternion.clone(), s: g.scale.clone() }
  g.position.set(0, 0, 0)
  g.quaternion.identity()
  g.scale.set(1, 1, 1)
  g.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(model)
  g.position.copy(saved.p)
  g.quaternion.copy(saved.q)
  g.scale.copy(saved.s)
  g.updateMatrixWorld(true)
  if (box.isEmpty()) {
    pivotP.set(0, 0, 0)
    return
  }
  box.getCenter(pivotP)
  if (pivotMode.value === 'bottom') pivotP.y = box.min.y
}

function applyObjectTransform() {
  const g = pivotGroup
  if (!g) return
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(objRot.x),
    THREE.MathUtils.degToRad(objRot.y),
    THREE.MathUtils.degToRad(objRot.z)
  ))
  const s = Math.max(0.001, objScale.value)
  g.quaternion.copy(q)
  g.scale.setScalar(s)
  // position = t + p − q·(s·p) ⇒ points map to q·s·(x−p) + p + t: about the pivot.
  g.position.set(objPos.x, objPos.y, objPos.z)
    .add(pivotP)
    .sub(pivotP.clone().multiplyScalar(s).applyQuaternion(q))
  contactDirty = true // the footprint moved — re-bake the grounding shadow
}

function setPivotMode(m: 'bottom' | 'center' | 'origin') {
  // Switching pivot must not move the object: fold the placement difference the new
  // pivot introduces back into the position offset. Only future edits feel the change.
  const before = pivotGroup?.position.clone()
  pivotMode.value = m
  recomputePivot()
  applyObjectTransform()
  if (pivotGroup && before) {
    objPos.x += before.x - pivotGroup.position.x
    objPos.y += before.y - pivotGroup.position.y
    objPos.z += before.z - pivotGroup.position.z
    applyObjectTransform()
  }
}

// The gizmo drags pivotGroup directly. Decompose its pose back into the panel values so the
// two never diverge, inverting applyObjectTransform's position formula so a later panel edit
// (which re-runs that formula) reproduces the exact same pose — no jump.
function readbackGizmo() {
  // The gizmo may be dragging a light's aim target — route the position into tx/ty/tz.
  if (gizmoTargetId.value != null) {
    const e = lightObjs.get(gizmoTargetId.value)
    const cfg = lights.find((c) => c.id === gizmoTargetId.value)
    if (e?.target && cfg) {
      cfg.tx = +e.target.position.x.toFixed(3)
      cfg.ty = +e.target.position.y.toFixed(3)
      cfg.tz = +e.target.position.z.toFixed(3)
      applyLightCfg(cfg)
    }
    return
  }
  // The gizmo may be dragging a light body instead of the object — route the position back.
  if (gizmoLightId.value != null) {
    const e = lightObjs.get(gizmoLightId.value)
    const cfg = lights.find((c) => c.id === gizmoLightId.value)
    if (e && cfg) {
      cfg.x = +e.light.position.x.toFixed(3)
      cfg.y = +e.light.position.y.toFixed(3)
      cfg.z = +e.light.position.z.toFixed(3)
      applyLightCfg(cfg) // re-aim at the origin + refresh helper/caster
    }
    return
  }
  const g = pivotGroup
  if (!g) return
  const q = g.quaternion.clone()
  const s = g.scale.x
  objScale.value = s
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ')
  objRot.x = +THREE.MathUtils.radToDeg(e.x).toFixed(2)
  objRot.y = +THREE.MathUtils.radToDeg(e.y).toFixed(2)
  objRot.z = +THREE.MathUtils.radToDeg(e.z).toFixed(2)
  const off = pivotP.clone().multiplyScalar(s).applyQuaternion(q) // q·(s·pivotP)
  objPos.x = +(g.position.x - pivotP.x + off.x).toFixed(4)
  objPos.y = +(g.position.y - pivotP.y + off.y).toFixed(4)
  objPos.z = +(g.position.z - pivotP.z + off.z).toFixed(4)
  contactDirty = true
}

function setGizmoMode(m: 'off' | 'translate' | 'rotate' | 'scale') {
  gizmoMode.value = m
  gizmoLightId.value = null // switching to the object (or off) releases any light/target
  gizmoTargetId.value = null
  if (!transformControls || !gizmoHelper) return
  if (m === 'off' || !pivotGroup) {
    transformControls.detach()
    transformControls.enabled = false
    gizmoHelper.removeFromParent() // out of the scene so its updateMatrixWorld can't run unattached
  } else {
    transformControls.attach(pivotGroup)
    transformControls.setMode(m)
    transformControls.enabled = true
    gizmoHelper.visible = true
    if (!gizmoHelper.parent) scene.add(gizmoHelper)
  }
}

// ── Extra lights rig ─────────────────────────────────────────────────────────
function initExtraLights() {
  extraLightsGroup = new THREE.Group()
  scene.add(extraLightsGroup)
}

/** Build the RectAreaLight + helper + aim-target proxy for a cfg and register them. */
function makeLightObjects(cfg: LightCfg) {
  if (!extraLightsGroup) return
  if (!rectLibReady) { RectAreaLightUniformsLib.init(); rectLibReady = true }
  const light = new THREE.RectAreaLight(cfg.color, cfg.intensity, cfg.size, cfg.size)
  const helper = new RectAreaLightHelper(light)
  light.add(helper) // the RectAreaLightHelper must be a child of the light it visualises
  const target = new THREE.Object3D() // RectAreaLight has no target; a proxy the gizmo can grab
  extraLightsGroup.add(target)
  light.name = `nkdLight${cfg.id}`
  extraLightsGroup.add(light)
  lightObjs.set(cfg.id, { light, helper, target })
  applyLightCfg(cfg)
}

/** Push a cfg onto its live objects. The RectAreaLight gives the soft LTC fill; since three's
 *  area lights can't cast, a paired spot caster provides the (soft) shadow when Shadow is on. */
function applyLightCfg(cfg: LightCfg) {
  const e = lightObjs.get(cfg.id)
  if (!e) return
  const l = e.light as any
  l.position.set(cfg.x, cfg.y, cfg.z)
  l.color.set(cfg.color)
  l.intensity = cfg.intensity
  // Aim at the user's target. If the target coincides with the light position the direction is
  // zero-length (NaN), so aim straight down instead until one of them is moved.
  const degenerate = cfg.x === cfg.tx && cfg.y === cfg.ty && cfg.z === cfg.tz
  const aimX = degenerate ? cfg.x : cfg.tx
  const aimY = degenerate ? cfg.y - 1 : cfg.ty
  const aimZ = degenerate ? cfg.z : cfg.tz
  // Keep the target proxy on the real target coords so the gizmo grabs it in the right place.
  if (e.target) { e.target.position.set(cfg.tx, cfg.ty, cfg.tz); e.target.updateMatrixWorld() }
  l.width = Math.max(cfg.size, 0.1)
  l.height = Math.max(cfg.size, 0.1)
  l.lookAt(aimX, aimY, aimZ)
  // Paired spot caster for the shadow. Size scales the softness (radius ×2.5 so it reads).
  if (cfg.shadow && !e.caster) {
    const c = new THREE.SpotLight(cfg.color, cfg.intensity)
    c.penumbra = 0.5
    c.angle = 1.2 // wide enough to cover the object at the origin
    c.castShadow = true
    c.shadow.mapSize.set(1024, 1024)
    c.shadow.bias = -0.001
    c.shadow.blurSamples = 25
    extraLightsGroup!.add(c)
    extraLightsGroup!.add(c.target)
    e.caster = c
  } else if (!cfg.shadow && e.caster) {
    e.caster.removeFromParent()
    e.caster.target.removeFromParent()
    e.caster.dispose()
    e.caster = undefined
  }
  if (e.caster) {
    e.caster.position.set(cfg.x, cfg.y, cfg.z)
    e.caster.color.set(cfg.color)
    e.caster.intensity = cfg.intensity
    e.caster.shadow.radius = cfg.size * 2.5
    e.caster.target.position.set(aimX, aimY, aimZ)
    e.caster.target.updateMatrixWorld()
  }
  if ((e.helper as any)?.update) (e.helper as any).update()
}

function selectLight(id: number) {
  selectedLightId.value = selectedLightId.value === id ? null : id
}

function addLight() {
  // Born at the origin — centred in frame and right under the gizmo, so it can be grabbed
  // and dragged out into the scene. It aims down until moved off the origin.
  const cfg: LightCfg = {
    id: lightSeq++, x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0, color: '#ffffff',
    intensity: 8, size: 3, shadow: true,
  }
  lights.push(cfg)
  makeLightObjects(cfg)
  selectedLightId.value = cfg.id
}

function removeLight(id: number) {
  const e = lightObjs.get(id)
  if (e) {
    const l = e.light as any
    e.helper?.removeFromParent?.()
    e.target?.removeFromParent?.()
    l.target?.removeFromParent?.()
    l.removeFromParent?.()
    l.dispose?.()
    if (e.caster) { e.caster.target.removeFromParent(); e.caster.removeFromParent(); e.caster.dispose() }
    lightObjs.delete(id)
  }
  const idx = lights.findIndex((c) => c.id === id)
  if (idx >= 0) lights.splice(idx, 1)
  if (gizmoLightId.value === id || gizmoTargetId.value === id) setGizmoMode('off')
  if (selectedLightId.value === id) selectedLightId.value = null
}

/** Attach the translate gizmo to a light so it can be dragged in the viewport. */
function gizmoLight(id: number) {
  const e = lightObjs.get(id)
  if (!transformControls || !gizmoHelper || !e) return
  if (gizmoLightId.value === id) { setGizmoMode('off'); return } // toggle off
  transformControls.attach(e.light)
  transformControls.setMode('translate')
  transformControls.enabled = true
  gizmoHelper.visible = true
  if (!gizmoHelper.parent) scene.add(gizmoHelper)
  gizmoMode.value = 'off' // the object-gizmo buttons are not the active target now
  gizmoTargetId.value = null
  gizmoLightId.value = id
}

/** Attach the translate gizmo to a light's aim target (spot/area). */
function gizmoLightTarget(id: number) {
  const e = lightObjs.get(id)
  if (!transformControls || !gizmoHelper || !e?.target) return
  if (gizmoTargetId.value === id) { setGizmoMode('off'); return } // toggle off
  transformControls.attach(e.target)
  transformControls.setMode('translate')
  transformControls.enabled = true
  gizmoHelper.visible = true
  if (!gizmoHelper.parent) scene.add(gizmoHelper)
  gizmoMode.value = 'off'
  gizmoLightId.value = null
  gizmoTargetId.value = id
}

function setHelpersVisible(v: boolean) {
  for (const e of lightObjs.values()) if (e.helper) e.helper.visible = v
}


function cameraInfo() {
  const q = camera.quaternion
  const t = controls?.target ?? new THREE.Vector3()
  const xyz = (v: THREE.Vector3 | THREE.Euler) => ({ x: v.x, y: v.y, z: v.z })
  return {
    position: xyz(camera.position),
    target: xyz(t),
    quaternion: { x: q.x, y: q.y, z: q.z, w: q.w },
    fov: camera.fov,
    zoom: camera.zoom,
    cameraType: 'perspective',
    aspect: camera.aspect,
    near: camera.near,
    far: camera.far,
  }
}

/** Render scene / mask / normal at an exact size, off the live viewport size. */
async function capture(width: number, height: number) {
  const r = renderer.value
  if (!r) throw new Error('viewport not ready')
  const prevSize = r.getSize(new THREE.Vector2())
  const prevAspect = camera.aspect
  const prevRatio = r.getPixelRatio()
  const gridWasVisible = !!grid?.visible
  const gizmoWasVisible = !!gizmoHelper?.visible

  if (grid) grid.visible = false // never bake the grid into an export
  if (gizmoHelper) gizmoHelper.visible = false // nor the transform gizmo
  setHelpersVisible(false) // nor the light helpers
  // The viewport renders at devicePixelRatio, but the export must be EXACTLY width×height
  // pixels — at ratio 2 the PNG would come out doubled.
  r.setPixelRatio(1)
  r.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  fitBackground()

  // 1. The full composite: model over the backdrop (with the grounding shadow, and the
  //    photo's depth occluding the model if Occlude is on). Re-bake the contact shadow so
  //    it matches the export camera exactly.
  if (contact.value) { renderContactShadow(); contactDirty = false }
  renderFrame()
  const scene_ = r.domElement.toDataURL('image/png')

  // 2. The model alone on transparency. Its alpha is also the mask, so one render serves
  //    both — no reason to draw the same thing twice. The shadow catcher stays out: its
  //    shadow would bleed into the mask, which is meant to be the silhouette. The shadow
  //    lives in the composite above.
  const catcherWasVisible = !!shadowCatcher?.visible
  if (shadowCatcher) shadowCatcher.visible = false
  // The grounding shadow is not part of the silhouette (nor of the depth surface below) —
  // hide it for the mask AND the depth pass; restored with the catcher at the end.
  const contactWasVisible = !!contactGroup?.visible
  if (contactGroup) contactGroup.visible = false
  r.setClearColor(0x000000, 0)
  renderFrame(false)
  const object = r.domElement.toDataURL('image/png')

  // 3. Depth. With a scene map connected: the map is the BASE LAYER, exported verbatim —
  //    it arrives already calculated and is the reference — and the object's depth is
  //    remapped into ITS dNear/dFar space (linear view-z) and composited ON TOP, depth
  //    buffer cleared in between so the object always wins where it has pixels, mirroring
  //    the colour composite. Without a scene map: MeshDepthMaterial fitted tight around
  //    the model, as always (near white / far black, no inversion anywhere).
  const prevNear = camera.near
  const prevFar = camera.far
  // The catcher stays hidden here too: as depth it would read as a huge surface the scene
  // never had (the real ground is already in the photo's own depth).
  const originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>()
  const depthMaterial = new THREE.MeshDepthMaterial()
  let overrideMat: THREE.Material = depthMaterial
  if (sceneDepthTexture) {
    const dNear = bgDepthMaterial.uniforms.dNear.value
    const dFar = bgDepthMaterial.uniforms.dFar.value
    linearDepthMaterial.uniforms.dNear.value = dNear
    linearDepthMaterial.uniforms.dFar.value = dFar
    linearDepthMaterial.uniforms.inv.value = sceneDepthInverseSpace ? 1 : 0
    overrideMat = linearDepthMaterial
    // The tuning aid for scene_depth_near/far: anything nearer than dNear clamps to
    // pure white (an fSpy scene lives in small units, so the defaults often saturate).
    if (model) {
      const box = new THREE.Box3().setFromObject(model)
      if (!box.isEmpty()) {
        const sphere = box.getBoundingSphere(new THREE.Sphere())
        const dist = camera.position.distanceTo(sphere.center)
        const zMin = Math.max(0, dist - sphere.radius)
        const zMax = dist + sphere.radius
        console.log(
          `[NKD Preview 3D] depth export: object spans view-z ${zMin.toFixed(2)}..${zMax.toFixed(2)}; ` +
          `scene_depth_near/far = ${dNear}/${dFar}` +
          (zMax < dNear ? ' — ALL nearer than near: object clamps to pure white, lower scene_depth_near' : '')
        )
      }
    }
  } else if (model) {
    // Tight near/far only matter for MeshDepthMaterial's window-depth output.
    const box = new THREE.Box3().setFromObject(model)
    if (!box.isEmpty()) {
      const sphere = box.getBoundingSphere(new THREE.Sphere())
      const dist = camera.position.distanceTo(sphere.center)
      camera.near = Math.max(1e-4, dist - sphere.radius)
      camera.far = Math.max(camera.near + 1e-4, dist + sphere.radius)
      camera.updateProjectionMatrix()
    }
  }
  // Splats stay OUT of the depth pass: SparkRenderer extends THREE.Mesh, so the material
  // override would either corrupt its draw or paint coloured splats into the depth PNG.
  // A splat model contributes no depth in v1 — the scene layer still exports.
  const sparkWasVisible = sparkRenderer?.visible ?? false
  if (sparkRenderer) sparkRenderer.visible = false
  const modelWasVisible = model?.visible ?? false
  if (modelIsSplat && model) model.visible = false
  // Override ONLY the model's meshes, not the whole scene: light helpers (RectAreaLightHelper
  // et al.) and the gizmo run their own updateMatrixWorld that reads material.color, which
  // MeshDepthMaterial lacks — swapping their material there throws. Everything non-model is
  // hidden in this pass anyway, so it never needed the depth material.
  if (model && !modelIsSplat) {
    model.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        originals.set(child, child.material)
        child.material = overrideMat
      }
    })
  }
  r.setClearColor(0x000000, 1)
  r.autoClear = false
  r.clear()
  if (sceneDepthTexture) {
    r.render(bgDepthScene, bgCamera)
    // Occlude on: keep the scene depth so the object is depth-tested against it (masked by
    // nearer scene geometry) — the depth output occludes just like the colour composite.
    // Off: clear it so the object always wins (composite-over, the original behaviour).
    if (!occlude.value) r.clearDepth()
  }
  r.render(scene, camera)
  r.autoClear = true
  const depth = r.domElement.toDataURL('image/png')
  originals.forEach((mat, mesh) => { mesh.material = mat })
  depthMaterial.dispose()
  if (sparkRenderer) sparkRenderer.visible = sparkWasVisible
  if (modelIsSplat && model) model.visible = modelWasVisible

  camera.near = prevNear
  camera.far = prevFar
  if (shadowCatcher) shadowCatcher.visible = catcherWasVisible
  if (contactGroup) contactGroup.visible = contactWasVisible
  if (grid) grid.visible = gridWasVisible
  if (gizmoHelper) gizmoHelper.visible = gizmoWasVisible
  setHelpersVisible(true)
  r.setClearColor(0x000000, 0)
  r.setPixelRatio(prevRatio)
  r.setSize(prevSize.x, prevSize.y, false)
  camera.aspect = prevAspect
  camera.updateProjectionMatrix()
  fitBackground()

  return { scene: scene_, object, depth, camera_info: cameraInfo() }
}

async function setSceneDepth(ref: { filename: string; type: string; subfolder: string } | null) {
  if (!ref) {
    sceneDepthTexture?.dispose()
    sceneDepthTexture = null
    bgDepthMaterial.uniforms.depthMap.value = null
    hasSceneDepth.value = false
    return
  }
  const texture = await new THREE.TextureLoader().loadAsync(viewUrl(ref))
  // Read the map's raw values: a colour transform here would shift every distance.
  texture.colorSpace = THREE.NoColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  sceneDepthTexture?.dispose()
  sceneDepthTexture = texture
  bgDepthMaterial.uniforms.depthMap.value = texture
  hasSceneDepth.value = true
  fitBackground()
}

function median(arr: number[]) {
  const s = [...arr].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Auto-fit scene_depth_near/far against the fSpy ground plane. For pixels in the lower
 *  band of the frame we know BOTH the map's grey and the true view distance (ray to y=0
 *  with the calibrated camera). In inverse space 1/z is LINEAR in the grey (1/z = a + b·d),
 *  so a robust Theil–Sen line through the samples yields dFar = 1/a, dNear = 1/(a+b).
 *  Furniture in the band contaminates single samples; the median fit shrugs them off. */
function autoCalibrateDepth() {
  const img = sceneDepthTexture?.image as CanvasImageSource | undefined
  if (!img) return
  const fail = (why: string) => { status.value = `Auto Z failed: ${why}` }
  const cw = 256
  const ch = 256
  const cv = document.createElement('canvas')
  cv.width = cw
  cv.height = ch
  const ctx = cv.getContext('2d')
  if (!ctx) return
  ctx.drawImage(img, 0, 0, cw, ch)
  const px = ctx.getImageData(0, 0, cw, ch).data
  const invert = bgDepthMaterial.uniforms.invert.value > 0.5
  // The map is cover-fitted on screen; undo that fit to read the right texel per pixel.
  const sx = bgDepthMesh?.scale.x ?? 1
  const sy = bgDepthMesh?.scale.y ?? 1
  const fwd = camera.getWorldDirection(new THREE.Vector3())
  const ds: number[] = []
  const ys: number[] = []
  for (let gy = 0; gy < 15; gy++) {
    for (let gx = 0; gx < 19; gx++) {
      const nx = -0.9 + gx * 0.1
      const ny = -0.95 + gy * 0.05 // lower band: where the floor lives
      const lx = nx / sx
      const ly = ny / sy
      if (Math.abs(lx) > 1 || Math.abs(ly) > 1) continue
      const dir = new THREE.Vector3(nx, ny, 0.5).unproject(camera).sub(camera.position).normalize()
      const t = -camera.position.y / dir.y
      if (!(t > 0) || !isFinite(t)) continue // this pixel's ray never lands on the floor
      const z = t * dir.dot(fwd) // view depth, the same axis vZ measures
      if (!(z > 1e-3)) continue
      const u = (lx + 1) / 2
      const v = (ly + 1) / 2
      let d = px[(Math.round((1 - v) * (ch - 1)) * cw + Math.round(u * (cw - 1))) * 4] / 255
      if (invert) d = 1 - d
      ds.push(d)
      ys.push(1 / z)
    }
  }
  if (ds.length < 30) return fail('not enough floor in view')
  if (Math.max(...ds) - Math.min(...ds) < 0.08) return fail('floor greys are flat')
  const slopes: number[] = []
  for (let k = 0; k < 1200 && slopes.length < 400; k++) {
    const i = (Math.random() * ds.length) | 0
    const j = (Math.random() * ds.length) | 0
    if (Math.abs(ds[i] - ds[j]) < 0.05) continue
    slopes.push((ys[i] - ys[j]) / (ds[i] - ds[j]))
  }
  if (!slopes.length) return fail('degenerate samples')
  const b = median(slopes)
  const a = median(ds.map((d, i) => ys[i] - b * d))
  const near = 1 / (a + b)
  const far = a > 1e-6 ? 1 / a : 10000 // a≈0: the darkest grey sits at infinity
  if (!(b > 0) || !isFinite(near) || near <= 0 || !(far > near)) return fail('no clean floor fit')
  // Apply locally NOW: capture runs before the backend folds the widgets back.
  bgDepthMaterial.uniforms.dNear.value = +near.toFixed(3)
  bgDepthMaterial.uniforms.dFar.value = +far.toFixed(2)
  syncDepthUI()
  emit('calibrated', +near.toFixed(3), +far.toFixed(2))
  status.value = `Auto Z: near ${near.toFixed(2)} / far ${far.toFixed(1)}`
  window.setTimeout(() => { if (status.value.startsWith('Auto Z:')) status.value = '' }, 4000)
}

// Mirror the invert uniform into the panel (loadScene sets it from the node's widget).
function syncDepthUI() {
  depthInvertUI.value = bgDepthMaterial.uniforms.invert.value > 0.5
}
function setDepthInvertUI(b: boolean) {
  depthInvertUI.value = b
  bgDepthMaterial.uniforms.invert.value = b ? 1 : 0
}
function setOccFrom(v: number) { occFrom.value = v; bgDepthMaterial.uniforms.occFrom.value = v }
function setOccTo(v: number) { occTo.value = v; bgDepthMaterial.uniforms.occTo.value = v }

/** Payload pushed by the backend on execute. */
async function loadScene(payload: any) {
  await setModel(payload.model ?? null)
  await setBackground(payload.bg_image ?? null)
  await setSceneDepth(payload.scene_depth ?? null)
  bgDepthMaterial.uniforms.invert.value = payload.scene_depth_invert ? 1 : 0
  // Still tracked for the depth EXPORT's object-tone remap (linearDepthMaterial), not occlusion.
  sceneDepthInverseSpace = payload.scene_depth_inverse_space !== false
  if (typeof payload.scene_depth_near === 'number') {
    bgDepthMaterial.uniforms.dNear.value = payload.scene_depth_near
  }
  if (typeof payload.scene_depth_far === 'number') {
    bgDepthMaterial.uniforms.dFar.value = payload.scene_depth_far
  }
  syncDepthUI()
  if (payload.camera_info) applyCameraInfo(payload.camera_info)
  if (payload.model_3d_info) applyModelInfo(payload.model_3d_info)
}

function toggleGrid() {
  showGrid.value = !showGrid.value
  if (grid) grid.visible = showGrid.value
}

function frameModel() {
  if (!model) return
  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3()).length()
  const center = box.getCenter(new THREE.Vector3())
  if (!isFinite(size) || size <= 0) return
  controls?.target.copy(center)
  camera.position.copy(center).add(new THREE.Vector3(0.6, 0.4, 1).normalize().multiplyScalar(size * 1.4))
  camera.updateProjectionMatrix()
  controls?.update()
}

function forceResize(): boolean {
  const el = host.value
  if (!el || el.clientWidth < 1 || el.clientHeight < 1) return false
  resize()
  return true
}

function serialise(): string {
  return JSON.stringify({
    showGrid: showGrid.value,
    camera: cameraInfo(),
    env: env.value,
    lightAz: lightAz.value,
    lightEl: lightEl.value,
    lightInt: lightInt.value,
    shadows: shadows.value,
    shadowSoft: shadowSoft.value,
    shadowStr: shadowStr.value,
    contact: contact.value,
    contactStr: contactStr.value,
    contactBlur: contactBlur.value,
    contactSpread: contactSpread.value,
    occlude: occlude.value,
    occFrom: occFrom.value,
    occTo: occTo.value,
    unbake: unbake.value,
    smooth: smooth.value,
    lights: lights.map((c) => ({ ...c })),
    object: {
      pos: { ...objPos },
      rot: { ...objRot },
      scale: objScale.value,
      pivot: pivotMode.value,
    },
  })
}

function deserialise(json: string) {
  try {
    const s = JSON.parse(json)
    if (typeof s.showGrid === 'boolean') {
      showGrid.value = s.showGrid
      if (grid) grid.visible = s.showGrid
    }
    const num = (v: any, target: { value: number }) => {
      if (typeof v === 'number') target.value = v
    }
    num(s.env, env)
    num(s.lightAz, lightAz)
    num(s.lightEl, lightEl)
    num(s.lightInt, lightInt)
    num(s.shadowSoft, shadowSoft)
    num(s.shadowStr, shadowStr)
    num(s.contactStr, contactStr)
    num(s.contactBlur, contactBlur)
    num(s.contactSpread, contactSpread)
    if (typeof s.shadows === 'boolean') shadows.value = s.shadows
    if (typeof s.contact === 'boolean') contact.value = s.contact
    if (typeof s.occlude === 'boolean') occlude.value = s.occlude
    if (typeof s.unbake === 'boolean') unbake.value = s.unbake
    if (typeof s.smooth === 'number') { smooth.value = s.smooth; applySmoothNormals() }
    if (typeof s.occFrom === 'number') setOccFrom(s.occFrom)
    if (typeof s.occTo === 'number') setOccTo(s.occTo)
    if (Array.isArray(s.lights)) {
      for (const id of [...lightObjs.keys()]) removeLight(id) // clear any current rig
      lights.length = 0
      lightSeq = 1
      for (const c of s.lights) {
        if (!c || typeof c !== 'object') continue // old point/spot lights load as fill too
        const cfg: LightCfg = {
          id: lightSeq++,
          x: +c.x || 0, y: +c.y || 0, z: +c.z || 0,
          tx: +c.tx || 0, ty: +c.ty || 0, tz: +c.tz || 0,
          color: typeof c.color === 'string' ? c.color : '#ffffff',
          intensity: +c.intensity || 0,
          size: typeof c.size === 'number' ? c.size : 3,
          shadow: !!c.shadow,
        }
        lights.push(cfg)
        makeLightObjects(cfg)
      }
      selectedLightId.value = null
    }
    if (contactGroup) contactGroup.visible = contact.value
    if (s.object) {
      const o = s.object
      if (o.pos) Object.assign(objPos, o.pos)
      if (o.rot) Object.assign(objRot, o.rot)
      if (typeof o.scale === 'number') objScale.value = o.scale
      if (o.pivot === 'bottom' || o.pivot === 'center' || o.pivot === 'origin') pivotMode.value = o.pivot
      // The model may not be loaded yet — setModel recomputes the pivot and re-applies.
      recomputePivot()
      applyObjectTransform()
    }
    applyLighting()
    if (s.camera) applyCameraInfo(s.camera)
  } catch {
    /* a malformed blob must not take the viewport down */
  }
}

function cleanup() {
  cancelAnimationFrame(raf)
  ro?.disconnect()
  controls?.dispose()
  transformControls?.dispose()
  for (const id of [...lightObjs.keys()]) removeLight(id)
  bgTexture?.dispose()
  sceneDepthTexture?.dispose()
  bgDepthMaterial.dispose()
  contactRT?.dispose()
  contactRTBlur?.dispose()
  contactDepthMat?.dispose()
  contactHBlur?.dispose()
  contactVBlur?.dispose()
  envRT?.dispose()
  pmrem?.dispose()
  renderer.value?.dispose()
  renderer.value = null
}

onMounted(() => {
  const el = host.value!
  const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
  r.setPixelRatio(Math.max(window.devicePixelRatio, 2)) // resize() refines this with the canvas zoom
  r.setClearColor(0x000000, 0)
  r.shadowMap.enabled = true
  // VSM, not PCF: PCF honours shadow.radius for directional/spot but IGNORES it for point
  // lights (the cube-shadow path has no radius blur), so a point light's Size did nothing.
  // VSM blurs the shadow map by shadow.radius for EVERY light type, point included.
  r.shadowMap.type = THREE.VSMShadowMap
  el.appendChild(r.domElement)
  renderer.value = r

  initScene()
  controls = new OrbitControls(camera, r.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.12
  // The key light's world position depends on the camera yaw — track it while orbiting.
  controls.addEventListener('change', applyLighting)

  // Transform gizmo: drag the object in the viewport. r0.18x's TransformControls is a Controls
  // (not an Object3D) — add its getHelper() to the scene, not the control itself.
  transformControls = new TransformControls(camera, r.domElement)
  transformControls.addEventListener('dragging-changed', (e: any) => {
    if (controls) controls.enabled = !e.value // don't orbit while dragging a handle
  })
  transformControls.addEventListener('objectChange', readbackGizmo)
  gizmoHelper = (transformControls as any).getHelper?.() ?? (transformControls as unknown as THREE.Object3D)
  // NOT added to the scene until a gizmo mode is active: the helper's updateMatrixWorld runs
  // on every render regardless of visibility, and with no object attached it throws
  // (undefined.clone()). It joins the scene only in setGizmoMode/gizmoLight.
  transformControls.enabled = false

  ro = new ResizeObserver(() => resize())
  ro.observe(el)
  resize()
  loop()
})

onBeforeUnmount(cleanup)

defineExpose({ capture, loadScene, serialise, deserialise, cleanup, forceResize })
</script>

<template>
  <div class="nkd-p3d">
    <div class="nkd-bar">
      <button :class="{ on: activePanel === 'object' }" @click="togglePanel('object')">Object</button>
      <button :class="{ on: activePanel === 'light' }" @click="togglePanel('light')">Light</button>
      <button v-if="hasSceneDepth" :class="{ on: activePanel === 'occlude' }" @click="togglePanel('occlude')"
        title="Depth occlusion: key out foreground from the injected depth map">Occlude</button>
      <button v-if="hasSceneDepth" @click="autoCalibrateDepth"
        title="Fit the exported depth's object tone against the fSpy ground plane">Auto Z</button>
      <span v-if="status" class="nkd-status">{{ status }}</span>
    </div>
    <div v-if="activePanel === 'light'" class="nkd-panel nkd-panel-col" @pointerdown.stop @wheel.stop>
      <div class="nkd-light-main">
      <div class="nkd-sphere-box">
        <canvas ref="sphereCv" width="92" height="92" class="nkd-sphere" @pointerdown="onSphereDown" />
        <span>{{ lightAz }}° / {{ lightEl }}°</span>
      </div>
      <div class="nkd-sliders">
        <label>Env<input type="range" min="0" max="4" step="0.05" v-model.number="env" @input="applyLighting"><span>{{ env.toFixed(2) }}</span></label>
        <label>Int<input type="range" min="0" max="8" step="0.05" v-model.number="lightInt" @input="applyLighting"><span>{{ lightInt.toFixed(2) }}</span></label>
        <label class="nkd-check">
          <input type="checkbox" v-model="shadows" @change="applyLighting"> Shadows
        </label>
        <label>Soft<input type="range" min="0" max="12" step="0.5" v-model.number="shadowSoft" :disabled="!shadows" @input="applyLighting"><span>{{ shadowSoft }}</span></label>
        <label>Str<input type="range" min="0" max="1" step="0.02" v-model.number="shadowStr" :disabled="!shadows" @input="applyLighting"><span>{{ shadowStr.toFixed(2) }}</span></label>
        <label class="nkd-check">
          <input type="checkbox" v-model="contact"> Contact shadow
        </label>
        <label>Dark<input type="range" min="0" max="1" step="0.02" v-model.number="contactStr" :disabled="!contact"><span>{{ contactStr.toFixed(2) }}</span></label>
        <label>Blur<input type="range" min="0" max="8" step="0.1" v-model.number="contactBlur" :disabled="!contact"><span>{{ contactBlur.toFixed(1) }}</span></label>
        <label>Size<input type="range" min="0.08" max="1" step="0.02" v-model.number="contactSpread" :disabled="!contact"><span>{{ contactSpread.toFixed(2) }}</span></label>
        <label class="nkd-check" title="For baked/unlit models (Tripo, splat→mesh): move the texture to albedo so the object takes lights and shadows">
          <input type="checkbox" v-model="unbake"> Unbake → relight
        </label>
        <label title="Diffuse the surface normals to soften bumpy splat-mesh shading. 0 = original; higher = smoother (and slower — it's a full mesh pass per step). Applied on release. Needs Unbake (lit material) to show.">Smooth<input type="range" min="0" max="200" step="5" v-model.number="smooth" @change="applySmoothNormals()"><span>{{ smooth }}</span></label>
      </div>
      </div>
      <div class="nkd-lights">
        <div class="nkd-obj-row">
          <span class="nkd-obj-tag">Fill</span>
          <button class="nkd-gizmo" @click="addLight()" title="Add a soft fill light">+ Fill light</button>
        </div>
        <div v-for="(l, i) in lights" :key="l.id" class="nkd-light-item">
          <div class="nkd-obj-row">
            <button class="nkd-gizmo" :class="{ on: selectedLightId === l.id }" @click="selectLight(l.id)">Fill {{ i + 1 }}</button>
            <button class="nkd-obj-reset" @click="removeLight(l.id)" title="Delete light">✕</button>
          </div>
          <template v-if="selectedLightId === l.id">
            <div class="nkd-obj-row">
              <span class="nkd-obj-tag">Pos</span>
              <DragNumber :model-value="l.x" :step="0.05" :reset-to="0" @update:model-value="(v: number) => { l.x = v; applyLightCfg(l) }" />
              <DragNumber :model-value="l.y" :step="0.05" :reset-to="0" @update:model-value="(v: number) => { l.y = v; applyLightCfg(l) }" />
              <DragNumber :model-value="l.z" :step="0.05" :reset-to="0" @update:model-value="(v: number) => { l.z = v; applyLightCfg(l) }" />
              <button class="nkd-gizmo nkd-gizmo-icon" :class="{ on: gizmoLightId === l.id }" @click="gizmoLight(l.id)" title="Move light in the viewport">⤢</button>
            </div>
            <div class="nkd-obj-row">
              <span class="nkd-obj-tag">Aim</span>
              <DragNumber :model-value="l.tx" :step="0.05" :reset-to="0" @update:model-value="(v: number) => { l.tx = v; applyLightCfg(l) }" />
              <DragNumber :model-value="l.ty" :step="0.05" :reset-to="0" @update:model-value="(v: number) => { l.ty = v; applyLightCfg(l) }" />
              <DragNumber :model-value="l.tz" :step="0.05" :reset-to="0" @update:model-value="(v: number) => { l.tz = v; applyLightCfg(l) }" />
              <button class="nkd-gizmo nkd-gizmo-icon" :class="{ on: gizmoTargetId === l.id }" @click="gizmoLightTarget(l.id)" title="Move aim target in the viewport">⤢</button>
            </div>
            <div class="nkd-sliders">
              <label>Int<input type="range" min="0" max="150" step="1" v-model.number="l.intensity" @input="applyLightCfg(l)"><span>{{ l.intensity.toFixed(0) }}</span></label>
              <label title="Light size — bigger area, softer light and softer shadow">Size<input type="range" min="0" max="12" step="0.1" v-model.number="l.size" @input="applyLightCfg(l)"><span>{{ l.size.toFixed(1) }}</span></label>
            </div>
            <div class="nkd-obj-row">
              <span class="nkd-obj-tag">Color</span>
              <input type="color" class="nkd-color" v-model="l.color" @input="applyLightCfg(l)">
              <label class="nkd-check" style="flex:1 1 0"><input type="checkbox" v-model="l.shadow" @change="applyLightCfg(l)"> Soft shadow</label>
            </div>
          </template>
        </div>
      </div>
    </div>
    <div v-if="activePanel === 'occlude'" class="nkd-panel" @pointerdown.stop @wheel.stop>
      <div class="nkd-sliders">
        <label class="nkd-check"><input type="checkbox" v-model="occlude"> Occlusion (depth-key matte)</label>
        <label title="Front of the occluding grey band. Near reads as white, so a band ending at 1 keys out the foreground">From<input type="range" min="0" max="1" step="0.01" v-model.number="occFrom" :disabled="!occlude" @input="setOccFrom(occFrom)"><span>{{ occFrom.toFixed(2) }}</span></label>
        <label title="Back of the occluding grey band. Everything between From and To hides the object">To<input type="range" min="0" max="1" step="0.01" v-model.number="occTo" :disabled="!occlude" @input="setOccTo(occTo)"><span>{{ occTo.toFixed(2) }}</span></label>
        <label class="nkd-check"><input type="checkbox" :checked="depthInvertUI" @change="setDepthInvertUI(($event.target as HTMLInputElement).checked)"> Invert depth map</label>
      </div>
    </div>
    <div v-if="activePanel === 'object'" class="nkd-panel" @pointerdown.stop @wheel.stop>
      <div class="nkd-obj">
        <div class="nkd-obj-row">
          <span class="nkd-obj-tag">Gizmo</span>
          <button class="nkd-gizmo" :class="{ on: gizmoMode === 'translate' }" @click="setGizmoMode(gizmoMode === 'translate' ? 'off' : 'translate')">Move</button>
          <button class="nkd-gizmo" :class="{ on: gizmoMode === 'rotate' }" @click="setGizmoMode(gizmoMode === 'rotate' ? 'off' : 'rotate')">Rotate</button>
          <button class="nkd-gizmo" :class="{ on: gizmoMode === 'scale' }" @click="setGizmoMode(gizmoMode === 'scale' ? 'off' : 'scale')">Scale</button>
        </div>
        <div class="nkd-obj-row">
          <span class="nkd-obj-tag">Pivot</span>
          <select :value="pivotMode" @change="setPivotMode(($event.target as HTMLSelectElement).value as any)">
            <option value="bottom">Bottom</option>
            <option value="center">Center</option>
            <option value="origin">Origin</option>
          </select>
        </div>
        <div class="nkd-obj-row">
          <span class="nkd-obj-tag">Pos</span>
          <DragNumber :model-value="objPos.x" :step="0.01" :reset-to="0" @update:model-value="(v: number) => { objPos.x = v; applyObjectTransform() }" />
          <DragNumber :model-value="objPos.y" :step="0.01" :reset-to="0" @update:model-value="(v: number) => { objPos.y = v; applyObjectTransform() }" />
          <DragNumber :model-value="objPos.z" :step="0.01" :reset-to="0" @update:model-value="(v: number) => { objPos.z = v; applyObjectTransform() }" />
        </div>
        <div class="nkd-obj-row">
          <span class="nkd-obj-tag">Rot</span>
          <DragNumber :model-value="objRot.x" :step="0.5" :decimals="1" :reset-to="0" @update:model-value="(v: number) => { objRot.x = v; applyObjectTransform() }" />
          <DragNumber :model-value="objRot.y" :step="0.5" :decimals="1" :reset-to="0" @update:model-value="(v: number) => { objRot.y = v; applyObjectTransform() }" />
          <DragNumber :model-value="objRot.z" :step="0.5" :decimals="1" :reset-to="0" @update:model-value="(v: number) => { objRot.z = v; applyObjectTransform() }" />
        </div>
        <div class="nkd-obj-row">
          <span class="nkd-obj-tag">Scale</span>
          <DragNumber :model-value="objScale" :step="0.005" :min="0.001" :decimals="3" :reset-to="1" @update:model-value="(v: number) => { objScale = v; applyObjectTransform() }" />
        </div>
      </div>
    </div>
    <div
      ref="host"
      class="nkd-view"
      :style="{ aspectRatio: `${aspect.w} / ${aspect.h}` }"
      @contextmenu.prevent
    >
      <div class="nkd-overlay" @pointerdown.stop>
        <button :class="{ on: showGrid }" @click="toggleGrid" title="Toggle grid">▦</button>
        <button @click="frameModel" title="Frame model">⛶</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* No height here on purpose: the node reserves space with the SAME width×aspect formula
   this content resolves to naturally (Sigmas Curve architecture). A height:100% would
   depend on the host chain handing a height down — the link that breaks in the wild. */
.nkd-p3d { display: flex; flex-direction: column; width: 100%;
  box-sizing: border-box; border: 1px solid #2a2d36; border-radius: 6px; overflow: hidden; }
.nkd-p3d, .nkd-p3d *, .nkd-p3d *::before, .nkd-p3d *::after { box-sizing: border-box; }
.nkd-bar {
  display: flex; align-items: center; gap: 6px; padding: 5px 6px;
  background: #1a1c22; border-bottom: 1px solid #3a3d46; flex: 0 0 auto;
}
.nkd-bar button {
  background: #252830; border: 1px solid #3a3d46; border-radius: 4px;
  color: #c8d0e0; font-size: 11px; padding: 3px 9px; cursor: pointer;
  white-space: nowrap; flex: 0 0 auto;
}
.nkd-bar button:hover { border-color: #4ab4ff; }
.nkd-bar button.on { border-color: #4ab4ff; color: #4ab4ff; }
.nkd-status { color: #ffd166; font-size: 10px; margin-left: auto;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nkd-panel {
  display: flex; align-items: center; gap: 10px;
  padding: 6px; background: #1a1c22; border-bottom: 1px solid #3a3d46; flex: 0 0 auto;
}
.nkd-sphere-box {
  display: flex; flex-direction: column; align-items: center; gap: 1px;
  color: rgba(255, 255, 255, 0.45); font-size: 9px; flex: 0 0 auto;
}
.nkd-sphere { cursor: grab; touch-action: none; }
.nkd-sphere:active { cursor: grabbing; }
.nkd-sliders { flex: 1 1 auto; min-width: 0; display: grid; gap: 2px; }
.nkd-panel label {
  display: flex; align-items: center; gap: 5px;
  color: rgba(255, 255, 255, 0.45); font-size: 10px;
}
.nkd-panel label > span { color: #c8d0e0; min-width: 32px; text-align: right; }
.nkd-panel input[type='range'] { flex: 1 1 auto; min-width: 0; height: 3px; accent-color: #4ab4ff; }
.nkd-panel input[type='range']:disabled { opacity: 0.3; }
.nkd-check { color: #c8d0e0 !important; }
.nkd-obj { flex: 1 1 auto; min-width: 0; display: grid; gap: 3px; }
.nkd-obj-row { display: flex; align-items: center; gap: 5px; }
.nkd-obj-tag { color: rgba(255, 255, 255, 0.45); font-size: 10px; flex: 0 0 34px; }
.nkd-obj-row select {
  flex: 1 1 0; min-width: 0; width: 0;
  background: #252830; border: 1px solid #3a3d46; border-radius: 4px;
  color: #c8d0e0; font-size: 11px; padding: 2px 5px;
}
.nkd-obj-row select:focus { outline: none; border-color: #4ab4ff; }
.nkd-obj-row :deep(.nkd-drag) {
  position: relative;
  flex: 1 1 0; min-width: 0; width: 0;
  background: #252830; border: 1px solid #3a3d46; border-radius: 4px;
  color: #c8d0e0; font-size: 11px; padding: 2px 6px; text-align: center;
  cursor: ew-resize; user-select: none; touch-action: none;
}
.nkd-obj-row :deep(.nkd-drag-reset) {
  position: absolute; right: 3px; top: 50%; transform: translateY(-50%);
  font-size: 10px; line-height: 1; color: rgba(255, 255, 255, 0.35);
  cursor: pointer; padding: 0 1px;
}
.nkd-obj-row :deep(.nkd-drag-reset:hover) { color: #4ab4ff; }
.nkd-obj-row :deep(.nkd-drag:hover) { border-color: #4ab4ff; }
.nkd-obj-row :deep(.nkd-drag-edit) { cursor: text; user-select: text; text-align: left; }
.nkd-obj-row :deep(.nkd-drag-edit:focus) { outline: none; border-color: #4ab4ff; }
.nkd-obj-reset {
  flex: 0 0 auto; background: #252830; border: 1px solid #3a3d46; border-radius: 4px;
  color: #c8d0e0; font-size: 10px; padding: 2px 8px; cursor: pointer;
}
.nkd-obj-reset:hover { border-color: #4ab4ff; }
.nkd-gizmo {
  flex: 1 1 0; min-width: 0; background: #252830; border: 1px solid #3a3d46;
  border-radius: 4px; color: #c8d0e0; font-size: 10px; padding: 2px 4px; cursor: pointer;
}
.nkd-gizmo:hover { border-color: #4ab4ff; }
.nkd-gizmo.on { border-color: #4ab4ff; color: #4ab4ff; }
.nkd-gizmo-icon { flex: 0 0 auto; width: 26px; }
/* Light rig: the panel goes column so the extra-lights list sits under the key controls. */
.nkd-panel-col { flex-direction: column; align-items: stretch; }
.nkd-light-main { display: flex; align-items: center; gap: 10px; width: 100%; }
.nkd-lights { display: grid; gap: 4px; width: 100%;
  border-top: 1px solid #3a3d46; padding-top: 6px; margin-top: 2px; }
.nkd-light-item { display: grid; gap: 3px; border: 1px solid #2a2d36; border-radius: 4px; padding: 4px; }
.nkd-light-item .nkd-obj-tag { text-transform: capitalize; }
.nkd-color { width: 28px; height: 20px; padding: 0; flex: 0 0 auto;
  border: 1px solid #3a3d46; border-radius: 4px; background: #252830; cursor: pointer; }
/* aspect-ratio (bound inline, from the width/height widgets) gives the box a real height
   from CSS alone — width in, height out, same formula the node reserves with. Deriving it
   from the canvas instead (height:auto) feeds the canvas's own attributes back into
   layout: a first frame sized 1x1 before the element has a width renders a giant square. */
.nkd-view { position: relative; width: 100%; flex: 0 0 auto; overflow: hidden; background: #111318; font-size: 0; }
.nkd-view :deep(canvas) { width: 100%; height: 100%; display: block; }
/* In-viewer controls: grid toggle + frame, kept out of the tab bar so it stays panel-only. */
.nkd-overlay { position: absolute; top: 6px; left: 6px; display: flex; gap: 4px; z-index: 5; }
.nkd-overlay button {
  width: 24px; height: 24px; padding: 0; font-size: 13px; line-height: 1;
  display: flex; align-items: center; justify-content: center;
  background: rgba(26, 28, 34, 0.72); border: 1px solid rgba(90, 100, 120, 0.5);
  border-radius: 4px; color: #c8d0e0; cursor: pointer;
}
.nkd-overlay button:hover { border-color: #4ab4ff; color: #4ab4ff; }
.nkd-overlay button.on { border-color: #4ab4ff; color: #4ab4ff; }
</style>
