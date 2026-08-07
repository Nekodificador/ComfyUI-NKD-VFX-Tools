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
import { attachFineRange, isFine, FINE_GAIN } from './fine_drag'
import { groundHit, viewZSpan } from './depth_range'
import { smoothNormalsByPosition } from './smooth_normals'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js'
import { RectAreaLightHelper } from 'three/examples/jsm/helpers/RectAreaLightHelper.js'
import { computed, defineComponent, h, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'

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
// `widget` is the generic fold-back channel: the viewport owns these controls now, and the
// node's widget is where the value persists and what the next run executes.
const emit = defineEmits<{
  calibrated: [near: number, far: number]
  widget: [name: string, value: unknown]
  popout: []
}>()

const host = ref<HTMLDivElement | null>(null)
// Popped out into the shared NKD modal: same live instance, moved there by the node entry
// (verified: re-parenting the mount container keeps the WebGL context, the loaded model and
// the camera — no second renderer, no reload). Only the LAYOUT changes.
const popped = ref(false)
const viewWrap = ref<HTMLDivElement | null>(null)
// Letterbox size in the popped layout. The export aspect stays the contract — filling a
// viewport-shaped box would frame something other than what the node actually outputs.
const fitW = ref(0)
const fitH = ref(0)
const showGrid = ref(true)
const status = ref('')
// Camera lock. A solved camera (fSpy) is a match to the plate — one stray orbit
// throws the match away and there is no undo, so an injected camera locks by
// default. Without one there is nothing to protect, so the camera stays free.
const camLocked = ref(false)
const hasCamera = ref(false)      // camera_info is wired and arriving
// Once the user has had an opinion, stop re-locking on every graph run —
// otherwise unlocking would only last until the next execute.
let lockChosenByUser = false
let gizmoDragging = false
let detachFine: (() => void) | null = null
let detachGizmoFine: (() => void) | null = null
// One tab open at a time: each panel is one row of chrome, and remeasureChrome in main.ts
// only counts the first .nkd-panel it finds.
const activePanel = ref<'' | 'light' | 'object' | 'occlude' | 'depth'>('')
const togglePanel = (p: 'light' | 'object' | 'occlude' | 'depth') => { activePanel.value = activePanel.value === p ? '' : p }

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
// Height above the floor that casts, in SCENE UNITS. A contact is a physical distance — the
// few centimetres where a sole, a blade tip or a cape hem is actually near the ground. It used
// to be a fraction of the model's bounding box, which made it depend on the tallest thing in
// the model: raising a sword thickened the slab and smeared its whole silhouette on the floor.
const contactSlab = ref(0.05)
// Occlusion is a MATTE (depth-key), not physical: the injected map is thresholded and the
// chosen grey band hides the object — no 3D calibration. occFrom/occTo pick the band, invert
// flips the map. Only meaningful with a scene_depth connected. Serialised with the widget.
const occlude = ref(false)
const depthInvertUI = ref(false)
const occFrom = ref(0.5)
const occTo = ref(1.0)

// Depth range. The values themselves belong to the node's scene_depth_near/far widgets, but
// tuning them THERE costs a graph run per nudge — so the Depth tab drives them here (live
// preview + ground gizmo) and folds each change back into the widgets, the same channel
// Auto Z always used. Mirrors of the uniforms, which Vue cannot observe.
const dNearUI = ref(1)
const dFarUI = ref(30)
// Paint the depth pass in the viewport while the panel is open. OFF to start:
// opening the Depth tab used to replace the viewport with the depth map on the
// spot, and with no object loaded that is a black screen with no clue as to why
// — the tab reads as broken. Off, the panel opens on the scene you were already
// looking at with the near/far planes drawn on the ground, which is what you
// need to set the range in the first place; tick Preview to check the map. The
// value is saved with the widget, so anyone who likes it on keeps it on.
const depthView = ref(false)
const showRange = ref(true)    // draw where the near/far planes cut the ground
// Auto Z as a MODE, not a one-shot: the fit depends on where the camera is (the object's
// distance with no map; the floor rays with one), so orbiting invalidates it the moment it
// is applied. On = re-fit on every render. Off = the last fit stays put, which is what the
// old one-shot button did, so the toggle covers both.
const autoZ = ref(false)
const autoErr = ref('')        // why the last fit was skipped, shown in the panel
const rangeHint = ref('')      // why the ground lines are not being drawn
// While Auto is on, Near/Far edit these instead: the fit is the base and these pad it.
const nearOff = ref(0)
const farOff = ref(0)
// With no scene map the depth export historically auto-fitted to the model's own bounds:
// stable-looking, but the range moves with every orbit and cannot be dialled. Manual swaps
// that for the same dNear/dFar the scene-map path uses. Off = the old behaviour, untouched.
const depthManual = ref(false)
const objZ = ref('')           // the object's view-z span — what near/far have to bracket

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
// Which axes the gizmo hands you: the world's, or the object's own. three's own default is
// 'world'. NOTE it has no say over Scale — TransformControls hard-codes `space = 'local'` for
// scale mode ("scale always oriented to local rotation"), so this only moves Move and Rotate.
const gizmoSpace = ref<'world' | 'local'>('world')
// Splat→mesh converters (Tripo & co.) often ship the texture baked into an UNLIT material or the
// emissive channel, so the object self-lights and ignores shadows. Unbake rebuilds a lit
// MeshStandard using that texture as albedo, so lights and shadows land on it.
const unbake = ref(false)
// Splat meshes are a faceted triangle soup → harsh per-face shading. Smooth averages face normals
// per spatial-grid cell (fast, O(n)); 0 = original, higher = coarser cells = softer shading.
const smooth = ref(0)
// glTF mandates FLAT normals when a mesh ships no NORMAL attribute, and GLTFLoader obeys by
// setting flatShading (three 0.180, GLTFLoader.js:3581) — which is exactly how a Hunyuan3D mesh
// (POSITION + TEXCOORD_0, no normals) arrives: hard facets. Auto-smooth averages them per shared
// vertex, the same thing a DCC's auto-smooth does. Meshes WITH authored normals are left alone.
const autoSmooth = ref(true)

const renderer = shallowRef<THREE.WebGLRenderer | null>(null)
const scene = new THREE.Scene()
const DEFAULT_FOV = 35
const camera = new THREE.PerspectiveCamera(DEFAULT_FOV, 1, 0.01, 10000)
// Full-frame 36mm back, so the millimetre readout is the same number the fSpy node
// solves: its focalMm = 36 / (2·tan(fovH/2)) is algebraically identical to three's
// vertical form once the aspect is folded in. three's own default gauge is 35, which
// would read ~3% short of every other lens figure in the pack.
camera.filmGauge = 36
// Mirror of the camera's focal length in 35mm-equivalent mm, which Vue cannot observe.
// The camera stays the single source of truth (camera.fov is what cameraInfo() reports
// and what the export renders through); this ref only exists so the field can show it.
// Millimetres, not degrees, because that is what a lens is labelled with — you match a
// plate by knowing it was shot on a 24mm, and nobody reads a spec sheet in degrees.
const focal = ref(camera.getFocalLength())
// The ↺ target: DEFAULT_FOV expressed in mm at the CURRENT format. Reads props.aspect
// directly so it re-runs when the export size changes — a fixed angle is a different
// focal length on a different film back.
const defaultFocal = computed(() =>
  0.5 * (36 / Math.max(props.aspect.w / props.aspect.h, 1)) / Math.tan(THREE.MathUtils.degToRad(DEFAULT_FOV / 2)))
// Dutch angle, in degrees. Unlike fov this one has no home on the camera: OrbitControls
// re-runs lookAt(target) every frame, which rebuilds the orientation from camera.up — so
// a roll written into camera.rotation.z would be wiped before it was ever drawn. Rolling
// UP is the version lookAt cannot undo, and it survives orbiting for free.
const roll = ref(0)
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
// The map's greys, read once per map. The floor fit used to re-draw and re-read the image
// on every call; with Auto re-fitting each frame that would be a 256×256 drawImage +
// getImageData per frame, for pixels that cannot change until the map itself does.
let depthPixels: { data: Uint8ClampedArray; w: number; h: number } | null = null
// Monocular maps are disparity unless the node says otherwise. A ref, not a plain let, so the
// Depth panel can show it — renderDepthPass reads it into the uniform on every pass anyway.
const sceneDepthInverseSpace = ref(true)
const hasSceneDepth = ref(false) // mirrors sceneDepthTexture for the template (plain let, not reactive)

/** Is this panel ON SCREEN — one definition, used by the template AND by everything that has to
 *  react to a panel appearing. They used to be separate: the template asked `popped || tab`, the
 *  render loop and the light-joystick redraw asked `tab` alone. Identical while tabs were the only
 *  way to show a panel, and silently wrong the moment the sidebar showed all four at once (the
 *  depth preview never painted, and the light sphere stayed blank until you dragged it). */
const objectPanelOpen = computed(() => popped.value || activePanel.value === 'object')
const lightPanelOpen = computed(() => popped.value || activePanel.value === 'light')
const depthPanelOpen = computed(() => popped.value || activePanel.value === 'depth')
const occludePanelOpen = computed(() =>
  (popped.value && hasSceneDepth.value) || activePanel.value === 'occlude')

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

// Window-depth fallback for the no-scene-map, no-manual-range case. A singleton: the depth
// pass now runs every frame in preview, and a per-frame new/dispose is pure churn.
const meshDepthMaterial = new THREE.MeshDepthMaterial()

// ── Depth range gizmo ─ a camera-facing plane projects to the SAME rectangle at any
// distance, so drawing the near/far planes themselves would stack two identical rectangles
// on screen and show nothing. Their intersection with the ground (y=0, where fSpy puts the
// origin) is a line that does move with distance — that is what reads from the camera.
let rangeGizmo: THREE.Group | null = null
let nearLine: THREE.Line | null = null
let farLine: THREE.Line | null = null

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

// Backdrop colour when no bg_image is wired. It is a real quad, not the clear colour, so it
// lands in the exported composite — which is the point: a mesh with holes (MoGe, DA3) exports
// this behind them. The isolated `object` pass skips the backdrop entirely, so its alpha and
// the mask are untouched whatever this is set to. Default = the old hardcoded grey.
const bgColor = ref('#111318')
// Draw the wired plate, or just its colour? Off keeps the environment lighting the photo
// gives (that is the point — grab its colours as GI) while leaving the photo out of the
// viewport AND out of the export, since both go through the same quad.
const showBg = ref(true)
const hasBgImage = ref(false) // mirrors bgTexture for the template (bgTexture is a plain let)
// Was a plate wired the last time a payload landed? Only the RISING edge (none -> wired)
// re-shows the backdrop. Reacting to every run instead would make the hide button useless,
// and never reacting leaves a plate you just connected invisible with its toggle buried —
// the same flank rule the camera lock already uses.
let bgWired = false

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
  initRangeGizmo()

  bgMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({ color: bgColor.value, depthWrite: false, depthTest: false })
  )
  bgScene.add(bgMesh)

  // Same geometry and scale as the backdrop, so its depth lands on the same pixels.
  bgDepthMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgDepthMaterial)
  bgDepthScene.add(bgDepthMesh)

  camera.position.set(2, 1.5, 3)
  camera.lookAt(0, 0, 0)
  updateEnvironment() // no plate yet → the white fill, so Env does something from the start
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
// The canvas only exists once the panel is in the DOM, so the redraw has to follow the panel
// being SHOWN — not the tab being clicked, which never happens in the sidebar.
watch(lightPanelOpen, (on) => { if (on) void nextTick(drawSphere) }, { immediate: true })

/** Flat white 2:1 equirect for the no-plate case. NOT 1×1: PMREM sizes its cube off
 *  image.width/4, and a source that small gives a negative max mip — three then emits
 *  `#define CUBEUV_TEXEL_HEIGHT 1` (an int) and the standard-material shader fails to
 *  compile, which renders the whole scene black. 64×32 is 8 kB and mips cleanly. */
function whiteEquirect() {
  return new THREE.DataTexture(new Uint8Array(64 * 32 * 4).fill(255), 64, 32)
}

/** The backdrop as an environment, so the model picks up the scene's colour.
 *  A flat photo is not a 360 capture — this is a colour cast, not true reflections.
 *  With nothing wired it is a flat white equirect, so Env reads as a plain global fill
 *  on the geometry instead of doing nothing at all. Same PMREM path either way — one
 *  code path, one slider. Follows the WIRE, not `showBg`: hiding the plate while keeping
 *  its colours as light is exactly what the toggle is for. */
function updateEnvironment() {
  const r = renderer.value
  if (!r) return
  envRT?.dispose()
  envRT = null
  pmrem = pmrem ?? new THREE.PMREMGenerator(r)
  pmrem.compileEquirectangularShader()
  // Clone: the backdrop quad draws from this same texture, and switching its mapping to
  // equirect would wreck how the photo itself is drawn.
  const equirect = bgTexture ? bgTexture.clone() : whiteEquirect()
  equirect.needsUpdate = true
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

  // 1×1 plane lying in XZ; scaled to the object footprint at render time. This geometry maps
  // u→+X and v→+Z, exactly how contactCam (looking up, up-vector +Z) records the footprint.
  // Its winding faces DOWN, so it draws with BackSide — rotating it face-up instead would
  // mirror Z and land the shadow front-to-back reversed (test_contact_shadow.mjs).
  const geo = new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2)
  contactPlane = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({
      map: contactRT.texture, transparent: true, depthWrite: false, opacity: 1,
      side: THREE.BackSide,
    })
  )
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
  // Depth testing is what makes this an AO footprint rather than a silhouette: the camera
  // looks UP, so nearest = closest to the ground, and each texel keeps the LOWEST surface
  // above it. Without it the material is opaque-with-NormalBlending, which three resolves to
  // NoBlending, so the last-drawn fragment simply overwrites — and three sorts opaque draws
  // front-to-back, i.e. the HIGHEST geometry last. A cape hanging over the boots then erases
  // their contact and stamps its own faint silhouette instead (test_contact_shadow.html).
  contactDepthMat.depthTest = true
  contactDepthMat.depthWrite = true
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
  // AO-style contact: only the thin slab just above the object's base casts. Everything higher
  // is clipped, so a tilted blade contributes its tip rather than sweeping its whole outline
  // across the floor.
  // The slab is measured from box.min.y, not from the floor: a model whose feet do not sit
  // exactly on y=0 would otherwise lose its shadow entirely (measured: alpha 0 once lifted by
  // more than the slab). Anchoring it to the base keeps the contact and lets it fade with
  // height, which is what leaving the ground should look like.
  // Capped at the model's own height: a slab taller than the object is just its full silhouette.
  const slab = Math.min(Math.max(contactSlab.value, 1e-3), size.y || 1)
  contactGroup.position.set(c.x, 0, c.z)
  contactCam.left = -foot / 2; contactCam.right = foot / 2
  contactCam.top = foot / 2; contactCam.bottom = -foot / 2
  contactCam.far = Math.max(box.min.y, 0) + slab
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
  // Only the object may cast into the map. Everything else in the scene is UI that happens to
  // be 3D — the transform gizmo, the light helpers, the depth range lines — and the override
  // material strips their own look, so they land as plain dark blobs on the floor.
  const wasGrid = grid?.visible; const wasCatcher = shadowCatcher?.visible
  const wasGizmo = !!gizmoHelper?.visible; const wasRange = !!rangeGizmo?.visible
  const wasHelpers = helpersVisible()
  if (grid) grid.visible = false
  if (shadowCatcher) shadowCatcher.visible = false
  if (gizmoHelper) gizmoHelper.visible = false
  if (rangeGizmo) rangeGizmo.visible = false
  setHelpersVisible(false)
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
  if (gizmoHelper) gizmoHelper.visible = wasGizmo
  if (rangeGizmo) rangeGizmo.visible = wasRange
  setHelpersVisible(wasHelpers)
  if (contactPlane) contactPlane.visible = true
  contactGroup.visible = contact.value
}

const _fwd = new THREE.Vector3()
const _dir = new THREE.Vector3()
const X_AXIS = new THREE.Vector3(1, 0, 0)

function initRangeGizmo() {
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-0.5, 0, 0),
    new THREE.Vector3(0.5, 0, 0),
  ])
  const line = (color: number) => {
    // depthTest ON. It was off at first so the lines would show over the depth map, and that
    // made them LIE: a line lying on the floor behind the object was painted over it — worst
    // from a top-down view, where the whole floor is behind everything. The depth preview
    // does not need the exception anyway: it clears the buffer after the scene map (unless
    // Occlude is on, where being masked by the foreground is right).
    const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color }))
    l.renderOrder = 999 // still last, so it wins ties against the grid rather than dropping out
    return l
  }
  nearLine = line(0x4ab4ff)
  farLine = line(0xff5555)
  rangeGizmo = new THREE.Group()
  rangeGizmo.add(nearLine, farLine)
  rangeGizmo.visible = false
  scene.add(rangeGizmo)
}

/** Place one range line where the plane at view distance `d` cuts y=0.
 *  Returns false when there is no line to draw, so the panel can say why. */
function placeRangeLine(l: THREE.Line | null, d: number) {
  if (!l) return false
  const hit = groundHit([camera.position.x, camera.position.y, camera.position.z],
                        [_fwd.x, _fwd.y, _fwd.z], d)
  if (!hit) { l.visible = false; return false }
  l.visible = true
  // A hair above the ground: the grid sits at exactly y=0 too, and two coplanar lines
  // z-fight where they cross. 0.2% of the distance is invisible and settles it.
  l.position.set(hit.point[0], hit.point[1] + d * 0.002, hit.point[2])
  l.quaternion.setFromUnitVectors(X_AXIS, _dir.set(hit.dir[0], hit.dir[1], hit.dir[2]))
  // Long enough to cross the frame at that distance however oblique the ground is.
  l.scale.setScalar(6 * d * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect)
  return true
}

/** The object's own view-z span — the interval near/far have to bracket. */
function objectZSpan(): { lo: number; hi: number } | null {
  if (!model) return null
  const box = new THREE.Box3().setFromObject(model)
  if (box.isEmpty()) return null
  camera.getWorldDirection(_fwd)
  const span = viewZSpan(
    [box.min.x, box.min.y, box.min.z], [box.max.x, box.max.y, box.max.z],
    [camera.position.x, camera.position.y, camera.position.z], [_fwd.x, _fwd.y, _fwd.z],
  )
  return isFinite(span.lo) && isFinite(span.hi) ? span : null
}

/** Per-frame while the Depth tab is open. Nothing else pays for it. */
function updateDepthGizmo() {
  // So the gizmo and the readout follow the camera even when the preview is off (the
  // beauty view renders through renderFrame, which never touches the range).
  refreshAutoRange()
  const span = objectZSpan() // also refreshes _fwd, which placeRangeLine reads
  objZ.value = span ? `${span.lo.toFixed(2)} – ${span.hi.toFixed(2)}` : ''
  if (!rangeGizmo) return
  rangeGizmo.visible = showRange.value
  if (!showRange.value) { rangeHint.value = ''; return }
  camera.getWorldDirection(_fwd)
  // Both, always — `a || b` would short-circuit and leave the far line unplaced.
  const a = placeRangeLine(nearLine, dNearUI.value)
  const b = placeRangeLine(farLine, dFarUI.value)
  const drawn = a || b
  // Looking (nearly) straight down there is no such line to draw: every point of the floor
  // is at the same view distance. Say it, rather than leave the user hunting for a line.
  rangeHint.value = drawn ? '' : 'ground lines need a less vertical camera'
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

/**
 * The depth render — ONE implementation for the export and for the live preview, so what
 * the Depth tab shows is literally what the depth output will be.
 *
 * With a scene map connected it is the BASE LAYER, drawn verbatim (it arrives already
 * calculated and is the reference), and the object's depth is remapped into ITS
 * dNear/dFar curve and composited on top — the buffer cleared in between so the object
 * wins where it has pixels, mirroring the colour composite. With no map: the same manual
 * range when Manual is on, else MeshDepthMaterial fitted tight around the model (near
 * white / far black), which is the historic behaviour.
 *
 * `forExport` hides the range gizmo; the preview wants it drawn over the map.
 */

/**
 * Whether the depth pass would come out with anything in it.
 *
 * Exactly the two things it draws: the injected scene map, and the model's own
 * meshes. Splats are deliberately not among them — SparkRenderer is hidden for
 * the pass — so a scene holding only a splat is as empty here as one holding
 * nothing, however much of it you can see in the viewport.
 *
 * Only the live preview asks. The export renders the pass regardless: a blank
 * depth map is a legitimate output for a scene with no geometry, and silently
 * substituting the colour frame there would be a lie about what was rendered.
 */
function depthHasSubject(): boolean {
  return !!sceneDepthTexture || (!!model && !modelIsSplat)
}

function renderDepthPass(forExport: boolean) {
  const r = renderer.value
  if (!r) return
  // Fit HERE, not on a timer: capture() has just switched the camera to the export aspect,
  // so the range is fitted to the camera the depth is actually taken from.
  refreshAutoRange()
  const prevNear = camera.near
  const prevFar = camera.far
  const prevClear = r.getClearColor(new THREE.Color())
  const prevAlpha = r.getClearAlpha()
  const gridWasVisible = !!grid?.visible
  const gizmoWasVisible = !!gizmoHelper?.visible
  // The catcher would read as a huge surface the scene never had (the real ground is
  // already in the photo's own depth), and the grounding shadow is not a depth surface.
  const catcherWasVisible = !!shadowCatcher?.visible
  const contactWasVisible = !!contactGroup?.visible
  const rangeWasVisible = !!rangeGizmo?.visible
  if (grid) grid.visible = false
  if (gizmoHelper) gizmoHelper.visible = false
  if (shadowCatcher) shadowCatcher.visible = false
  if (contactGroup) contactGroup.visible = false
  if (forExport && rangeGizmo) rangeGizmo.visible = false
  setHelpersVisible(false)

  const originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>()
  let overrideMat: THREE.Material = meshDepthMaterial
  // Auto implies the range: there is no point fitting a range the pass would ignore.
  if (sceneDepthTexture || depthManual.value || autoZ.value) {
    linearDepthMaterial.uniforms.dNear.value = bgDepthMaterial.uniforms.dNear.value
    linearDepthMaterial.uniforms.dFar.value = bgDepthMaterial.uniforms.dFar.value
    linearDepthMaterial.uniforms.inv.value = sceneDepthInverseSpace.value ? 1 : 0
    overrideMat = linearDepthMaterial
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

  originals.forEach((mat, mesh) => { mesh.material = mat })
  if (sparkRenderer) sparkRenderer.visible = sparkWasVisible
  if (modelIsSplat && model) model.visible = modelWasVisible
  camera.near = prevNear
  camera.far = prevFar
  camera.updateProjectionMatrix()
  if (grid) grid.visible = gridWasVisible
  if (gizmoHelper) gizmoHelper.visible = gizmoWasVisible
  if (shadowCatcher) shadowCatcher.visible = catcherWasVisible
  if (contactGroup) contactGroup.visible = contactWasVisible
  if (rangeGizmo) rangeGizmo.visible = rangeWasVisible
  setHelpersVisible(true)
  r.setClearColor(prevClear, prevAlpha)
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
  // The Depth panel shows the depth pass itself rather than a second little canvas: same
  // code as the export, full size, and the range gizmo drawn over it.
  if (depthPanelOpen.value) {
    updateDepthGizmo()
    // Only paint the depth pass when it would actually contain something. With
    // nothing to measure it renders a flat void, and a viewport that goes black
    // reads as a broken tab rather than as "there is no geometry here yet" —
    // which is exactly the wrong message while you are still loading a model.
    // Falling back to the normal frame keeps the near/far gizmo on a scene you
    // can see, and the pass takes over by itself the moment there is depth.
    if (depthView.value && depthHasSubject()) renderDepthPass(false)
    else renderFrame()
  } else {
    if (rangeGizmo) rangeGizmo.visible = false
    renderFrame()
  }
  raf = requestAnimationFrame(loop)
}

// Toggling on/off shows or hides the ground plane; turning on forces a fresh bake.
watch(contact, (on) => {
  if (contactGroup) contactGroup.visible = on
  if (on) contactDirty = true
})
// Darkness/blur/spread changes only need a re-bake, not a transform recompute.
watch([contactStr, contactBlur, contactSlab], () => { contactDirty = true })

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
  // Popped out the box no longer derives its height from the node width, so fit the export
  // aspect into whatever the modal gives us. Computed here rather than left to CSS because
  // the renderer needs the number NOW — reading it back off the element would race Vue's
  // style flush, and the fitted size is what we just decided anyway.
  if (popped.value && viewWrap.value) {
    const bw = viewWrap.value.clientWidth, bh = viewWrap.value.clientHeight
    if (bw > 1 && bh > 1) {
      const s = Math.min(bw / props.aspect.w, bh / props.aspect.h)
      fitW.value = Math.floor(props.aspect.w * s)
      fitH.value = Math.floor(props.aspect.h * s)
    }
  } else if (fitW.value) { fitW.value = 0; fitH.value = 0 }
  const w = popped.value && fitW.value ? fitW.value : el.clientWidth
  const h = popped.value && fitH.value ? fitH.value
    : (el.clientHeight || Math.round((w * props.aspect.h) / props.aspect.w))
  if (w < 1 || h < 1) return
  // The displayed size is clientWidth × the LiteGraph canvas zoom (a CSS transform that
  // clientWidth doesn't see). Render at dpr × zoom × 2 so the buffer matches the on-screen
  // pixels with 2× supersampling — crisp at any zoom. Capped so a big zoom can't allocate a
  // giant target. updateStyle=false keeps the canvas CSS at 100%; only the backing buffer grows.
  const MAX_BUF = 4096
  // In the modal the widget is out of the LiteGraph canvas, so its zoom transform no longer
  // applies — feeding it here would size the buffer for a scale nothing is drawing at.
  const MAX_BUF_SCALE = popped.value ? 1 : lgScale()
  const target = Math.min(window.devicePixelRatio, 2) * MAX_BUF_SCALE * 2
  const ratio = Math.max(0.5, Math.min(target, MAX_BUF / Math.max(w, h)))
  r.setPixelRatio(ratio)
  r.setSize(w, h, false)
  camera.aspect = props.aspect.w / props.aspect.h
  camera.updateProjectionMatrix()
  syncLens()          // a new format turns the same angle into a different focal length
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

/** The ONE writer of the backdrop quad's material. The photo draws only when it is wired
 *  AND `showBg` is on; otherwise the flat colour, so a holed mesh still has something
 *  behind it. Everything — viewport and export — goes through this quad, so hiding it
 *  here hides it everywhere. Scale stays with fitBackground: a cover-fit is >= the screen,
 *  and over-scaling a solid colour is invisible. */
function applyBackdrop() {
  if (!bgMesh) return
  const m = bgMesh.material as THREE.MeshBasicMaterial
  const show = !!bgTexture && showBg.value
  m.map = show ? bgTexture : null
  m.color.set(show ? 0xffffff : bgColor.value)
  m.needsUpdate = true
}

async function setBackground(ref: { filename: string; type: string; subfolder: string } | null) {
  if (!ref) {
    bgTexture?.dispose()
    bgTexture = null
    hasBgImage.value = false
    bgWired = false        // so re-connecting a plate later counts as a fresh edge
    applyBackdrop()
    bgMesh?.scale.set(1, 1, 1)
    updateEnvironment() // back to the white fill; without this the unwired plate kept lighting
    return
  }
  const texture = await new THREE.TextureLoader().loadAsync(viewUrl(ref))
  texture.colorSpace = THREE.SRGBColorSpace
  bgTexture?.dispose()
  bgTexture = texture
  hasBgImage.value = true
  if (!bgWired) showBg.value = true   // just connected: show it. Before applyBackdrop, which reads it.
  bgWired = true
  applyBackdrop()
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
function gridSmoothNormals(geo: THREE.BufferGeometry, cell: number, blend: number,
                           alignToOriginal = true) {
  const pos = geo.attributes.position
  if (!geo.attributes.normal) geo.computeVertexNormals() // baseline to blend from
  const na = geo.attributes.normal
  // Read through the accessors rather than .array: GLTFLoader hands back an
  // InterleavedBufferAttribute whenever the glTF packs attributes into one bufferView.
  const P = new Float32Array(pos.count * 3), O = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    P[i * 3] = pos.getX(i); P[i * 3 + 1] = pos.getY(i); P[i * 3 + 2] = pos.getZ(i)
    O[i * 3] = na.getX(i); O[i * 3 + 1] = na.getY(i); O[i * 3 + 2] = na.getZ(i)
  }
  const out = smoothNormalsByPosition(P, geo.index ? geo.index.array : null, O, cell, blend, alignToOriginal)
  geo.setAttribute('normal', new THREE.BufferAttribute(out, 3))
}

/** Weld tolerance for a mesh: small enough to merge only genuinely coincident vertices. */
function weldCell(geo: THREE.BufferGeometry) {
  if (!geo.boundingBox) geo.computeBoundingBox()
  const s = geo.boundingBox!.getSize(new THREE.Vector3())
  return Math.max((Math.max(s.x, s.y, s.z) || 1) * 1e-4, 1e-7)
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

/** Give a mesh that shipped NO normals the smooth shading a DCC's auto-smooth would.
 *
 *  TWO separate defects land here, and only the weld fixes both:
 *
 *  1. No NORMAL attribute. The glTF spec says a client MUST calculate FLAT normals in that case
 *     and GLTFLoader obeys (flatShading, three 0.180 GLTFLoader.js:3581). Hunyuan3D exports
 *     POSITION + TEXCOORD_0 only, so it lands as hard facets.
 *  2. UV seams. The unwrap duplicates every vertex on a seam, and `computeVertexNormals` averages
 *     per INDEX — it cannot cross one. Measured on a Hunyuan head: 64% of the mesh is seam-split
 *     and 12798 co-located pairs ended up with normals more than 10° apart, the worst by 180°.
 *     Those are the patch outlines that survive after (1) is fixed.
 *
 *  So the weld is by POSITION, always — `computeVertexNormals` is not a valid fast path here even
 *  when the index looks shared. `alignToOriginal` is off for the same reason: the pre-weld normal
 *  is the wrong side of the discontinuity being erased. No crease threshold either — measured on
 *  the same mesh, 25% of positions span more than 60°, so three's `toCreasedNormals` default would
 *  leave a quarter of the mesh split (and its hash cell is 51× coarser than the weld used here).
 *
 *  An authored normal set is never second-guessed; only meshes that ship none are touched. */
function applyAutoSmooth() {
  if (!model || modelIsSplat) return
  model.traverse((c) => {
    if (!(c instanceof THREE.Mesh)) return
    const mesh = c as THREE.Mesh
    // Write into the pristine geometry — Smooth may have swapped a clone into mesh.geometry.
    const geo = (mesh.userData.nkdOrigGeom as THREE.BufferGeometry) ?? mesh.geometry
    if (mesh.userData.nkdNoNormals === undefined) mesh.userData.nkdNoNormals = !geo.attributes.normal
    if (!mesh.userData.nkdNoNormals) return
    if (autoSmooth.value) gridSmoothNormals(geo, weldCell(geo), 1, false)
    else geo.deleteAttribute('normal') // back to how it loaded: no normals, flat by spec
    const mat: any = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    if (mat) { mat.flatShading = !autoSmooth.value; mat.needsUpdate = true }
  })
}
watch(autoSmooth, () => { applyAutoSmooth(); applySmoothNormals() })

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
      applyAutoSmooth() // before Unbake/Smooth: both read the normals this may have just written
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

/** A shown photo backdrop wins: tinting the quad would tint the photo. The colour is still
 *  stored, ready for when the image is unwired — or hidden with the toggle. */
function setBgColor(v: string) {
  bgColor.value = v
  applyBackdrop()
}

/** Show/hide the wired plate. The environment is untouched on purpose. */
function toggleBg() {
  showBg.value = !showBg.value
  applyBackdrop()
}

/** Focal length in 35mm-equivalent millimetres — the lens. Short exaggerates perspective,
 *  long compresses it. Matching the plate's lens is what makes a composite sit.
 *  three owns the film-back maths: setFocalLength writes camera.fov and reprojects. */
function setFocal(mm: number) {
  camera.setFocalLength(mm)
  // Show what was ASKED, not the read-back. The mm→fov→mm round trip drifts by up to
  // 4.5e-13 (measured over the field's whole range), which is invisible in the readout
  // but is enough for the ↺ affordance's exact compare to keep showing after you click
  // it. The field has already clamped the value, so this cannot show an unreachable one.
  focal.value = mm
}
/** camera.fov is the truth; refresh the mm mirror from it. Must run whenever the ASPECT
 *  changes too, not just the angle: the same fov on a different format is a different
 *  focal length. */
function syncLens() { focal.value = camera.getFocalLength() }

/** Tilt the horizon. The view axis is the roll axis, so the direction is read from the
 *  camera itself and stays valid wherever the orbit has taken it. */
function applyRoll(v = roll.value) {
  roll.value = v
  const dir = camera.getWorldDirection(new THREE.Vector3())
  camera.up.set(0, 1, 0).applyAxisAngle(dir, THREE.MathUtils.degToRad(v))
  if (controls) controls.update()
  else camera.lookAt(0, 0, 0)
}

function applyCameraInfo(info: any) {
  if (!info?.position) return
  camera.position.set(info.position.x, info.position.y, info.position.z)
  if (info.quaternion) {
    camera.quaternion.set(info.quaternion.x, info.quaternion.y, info.quaternion.z, info.quaternion.w)
  }
  if (typeof info.fov === 'number') { camera.fov = info.fov; syncLens() }  // the wire format stays degrees
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

/** Re-selecting the active mode turns the gizmo OFF. That toggle is the only way to dismiss it
 *  now that Q switches space, so it has to behave identically from a button and from a key —
 *  which is why it lives here instead of being written out at each of the seven call sites. */
function toggleGizmoMode(m: 'translate' | 'rotate' | 'scale') {
  setGizmoMode(gizmoMode.value === m ? 'off' : m)
}

function setGizmoSpace(s: 'world' | 'local') {
  gizmoSpace.value = s
  transformControls?.setSpace(s)
}
function toggleGizmoSpace() { setGizmoSpace(gizmoSpace.value === 'world' ? 'local' : 'world') }

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
/** They are only ever toggled as a group, so one of them speaks for all. Needed because
 *  capture() hides them and then calls renderContactShadow, which must put back what it
 *  found — restoring them to `true` there would bake the helpers into the exported frame. */
function helpersVisible() {
  for (const e of lightObjs.values()) if (e.helper) return e.helper.visible
  return true
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
  // Nor the depth-range lines: they live in `scene`, so the colour composite would bake
  // them in. renderDepthPass hides them for the depth pass on its own.
  const rangeWasVisible = !!rangeGizmo?.visible
  if (rangeGizmo) rangeGizmo.visible = false
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

  // 3. Depth — the exact pass the Depth tab previews, gizmo excluded.
  renderDepthPass(true)
  const depth = r.domElement.toDataURL('image/png')

  if (shadowCatcher) shadowCatcher.visible = catcherWasVisible
  if (contactGroup) contactGroup.visible = contactWasVisible
  if (grid) grid.visible = gridWasVisible
  if (gizmoHelper) gizmoHelper.visible = gizmoWasVisible
  if (rangeGizmo) rangeGizmo.visible = rangeWasVisible
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
    depthPixels = null
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
  depthPixels = readDepthPixels(texture.image as CanvasImageSource)
  bgDepthMaterial.uniforms.depthMap.value = texture
  hasSceneDepth.value = true
  fitBackground()
}

/** One 256×256 read of the map, cached for the floor fit. */
function readDepthPixels(img: CanvasImageSource | undefined) {
  if (!img) return null
  const w = 256
  const h = 256
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const ctx = cv.getContext('2d', { willReadFrequently: false })
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, w, h)
  return { data: ctx.getImageData(0, 0, w, h).data, w, h }
}

// Columns in the floor-sampling grid. Also the pair stride of the Theil–Sen fit: one column
// apart is the same row (same distance, no information), one stride apart is the next row.
const SAMPLE_COLS = 19

function median(arr: number[]) {
  const s = [...arr].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

type AutoFit = { near: number; far: number } | { error: string }

/** Auto-fit scene_depth_near/far against the fSpy ground plane. For pixels in the lower
 *  band of the frame we know BOTH the map's grey and the true view distance (ray to y=0
 *  with the calibrated camera). In inverse space 1/z is LINEAR in the grey (1/z = a + b·d),
 *  so a robust Theil–Sen line through the samples yields dFar = 1/a, dNear = 1/(a+b).
 *  Furniture in the band contaminates single samples; the median fit shrugs them off.
 *  Silent and side-effect free: with Auto on this runs every frame. */
function fitRangeToSceneDepth(): AutoFit {
  const px = depthPixels
  if (!px) return { error: 'no depth map' }
  const cw = px.w
  const ch = px.h
  const invert = bgDepthMaterial.uniforms.invert.value > 0.5
  // The map is cover-fitted on screen; undo that fit to read the right texel per pixel.
  const sx = bgDepthMesh?.scale.x ?? 1
  const sy = bgDepthMesh?.scale.y ?? 1
  const fwd = camera.getWorldDirection(new THREE.Vector3())
  const ds: number[] = []
  const ys: number[] = []
  for (let gy = 0; gy < 15; gy++) {
    for (let gx = 0; gx < SAMPLE_COLS; gx++) {
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
      let d = px.data[(Math.round((1 - v) * (ch - 1)) * cw + Math.round(u * (cw - 1))) * 4] / 255
      if (invert) d = 1 - d
      ds.push(d)
      ys.push(1 / z)
    }
  }
  if (ds.length < 30) return { error: 'not enough floor in view' }
  if (Math.max(...ds) - Math.min(...ds) < 0.08) return { error: 'floor greys are flat' }
  // Theil–Sen, but over a DETERMINISTIC set of pairs. Random pairs (the first version)
  // give a slightly different fit each call, which is invisible for a one-shot button and
  // intolerable once Auto re-fits every frame: the range would jitter, and with it the
  // gizmo and the widget write-back, on a camera that is not even moving. Striding by the
  // grid's row width pairs samples from different rows, which is where the depth spread is.
  const slopes: number[] = []
  for (let s = SAMPLE_COLS; s < ds.length; s += SAMPLE_COLS) {
    for (let i = 0; i + s < ds.length; i++) {
      if (Math.abs(ds[i] - ds[i + s]) < 0.05) continue
      slopes.push((ys[i] - ys[i + s]) / (ds[i] - ds[i + s]))
    }
  }
  if (!slopes.length) return { error: 'degenerate samples' }
  const b = median(slopes)
  const a = median(ds.map((d, i) => ys[i] - b * d))
  const near = 1 / (a + b)
  const far = a > 1e-6 ? 1 / a : 10000 // a≈0: the darkest grey sits at infinity
  if (!(b > 0) || !isFinite(near) || near <= 0 || !(far > near)) return { error: 'no clean floor fit' }
  return { near, far }
}

/** No scene map to fit against: bracket the object's own view-z span instead, which is the
 *  range that spends the full 0..1 on the object — and which moves with the camera, so it
 *  is the fit that actually wants re-running continuously. */
function fitRangeToObject(): AutoFit {
  const span = objectZSpan()
  if (!span) return { error: 'no model' }
  return { near: span.lo, far: span.hi }
}

const computeAutoRange = (): AutoFit =>
  (sceneDepthTexture ? fitRangeToSceneDepth() : fitRangeToObject())

/** With Auto on, the fit is the BASE and Near/Far are offsets on top of it — pad the front,
 *  give the back some headroom, without losing the tracking. Called from the render paths,
 *  so the export is fitted to the camera it is actually being taken from. */
function refreshAutoRange() {
  if (!autoZ.value) return
  const fit = computeAutoRange()
  if ('error' in fit) { autoErr.value = fit.error; return }
  autoErr.value = ''
  applyDepthRange(fit.near + nearOff.value, fit.far + farOff.value, true)
}

function toggleAutoZ() {
  autoZ.value = !autoZ.value
  if (autoZ.value) refreshAutoRange()
  // Turning it OFF freezes: dNear/dFar keep the last fitted value and the fields go back to
  // editing them as absolutes. Nothing jumps, so the toggle doubles as a one-shot fit —
  // which is why Manual is forced on here: without it the no-map path would fall back to
  // the historic auto-fit curve and the picture WOULD jump. The checkbox reappears ticked,
  // so it is one click to go back to the old behaviour.
  else {
    autoErr.value = ''
    depthManual.value = true
    flushWriteback()
  }
}

// The node's widgets are persistence and display only — the uniform is what renders. So the
// continuous path writes the uniform every frame and the widgets at most every 300 ms;
// emitting per frame would repaint the canvas 60×/s for a value nothing reads that fast.
let writebackTimer = 0
function queueWriteback() {
  if (writebackTimer) return
  writebackTimer = window.setTimeout(flushWriteback, 300)
}
function flushWriteback() {
  if (writebackTimer) { clearTimeout(writebackTimer); writebackTimer = 0 }
  emit('calibrated', dNearUI.value, dFarUI.value)
}

/** The one write point for the range: uniform (what renders NOW — capture runs before the
 *  backend folds anything back) + mirror + the node's own widgets, via the same event Auto Z
 *  has always used. `deferred` batches the widget write for the per-frame callers. */
function applyDepthRange(near: number, far: number, deferred = false) {
  const n = Math.max(0.01, near)
  const f = Math.max(n + 0.02, far)
  bgDepthMaterial.uniforms.dNear.value = n
  bgDepthMaterial.uniforms.dFar.value = f
  // Guarded so a still camera does not re-render the panel every frame.
  if (Math.abs(dNearUI.value - n) > 1e-4) dNearUI.value = n
  if (Math.abs(dFarUI.value - f) > 1e-4) dFarUI.value = f
  if (deferred) queueWriteback()
  else flushWriteback()
}
// With Auto on the fields edit the OFFSET, not the value: same two controls, and the
// refresh on the next frame turns them back into an absolute range.
function setDepthNear(v: number) {
  if (autoZ.value) { nearOff.value = v; refreshAutoRange() }
  else applyDepthRange(v, dFarUI.value)
}
function setDepthFar(v: number) {
  if (autoZ.value) { farOff.value = v; refreshAutoRange() }
  else applyDepthRange(dNearUI.value, v)
}

// Mirror the uniforms into the panel (loadScene sets them from the node's widgets).
function syncDepthUI() {
  depthInvertUI.value = bgDepthMaterial.uniforms.invert.value > 0.5
  dNearUI.value = bgDepthMaterial.uniforms.dNear.value
  dFarUI.value = bgDepthMaterial.uniforms.dFar.value
}
/** Both entry points (the Depth tab and the Occlude tab, where the post-invert grey is what
 *  the band keys off) route through here, so there is one state and one fold-back. */
function setDepthInvertUI(b: boolean) {
  depthInvertUI.value = b
  bgDepthMaterial.uniforms.invert.value = b ? 1 : 0
  emit('widget', 'scene_depth_invert', b)
}
/** Which curve the map's grey follows, so the object can be remapped onto it. The node's combo
 *  is the persisted form, hence the string rather than the boolean used everywhere else here. */
function setDepthSpace(inverse: boolean) {
  sceneDepthInverseSpace.value = inverse
  emit('widget', 'scene_depth_space', inverse ? 'inverse (disparity)' : 'linear (metric)')
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
  sceneDepthInverseSpace.value = payload.scene_depth_inverse_space !== false
  if (typeof payload.scene_depth_near === 'number') {
    bgDepthMaterial.uniforms.dNear.value = payload.scene_depth_near
  }
  if (typeof payload.scene_depth_far === 'number') {
    bgDepthMaterial.uniforms.dFar.value = payload.scene_depth_far
  }
  syncDepthUI()
  // React only to the CONNECTED/DISCONNECTED edge, not to every run: re-locking
  // on each execute would make unlocking useless.
  const injected = !!payload.camera_info
  if (injected !== hasCamera.value) {
    hasCamera.value = injected
    if (injected) {
      if (!lockChosenByUser) camLocked.value = true
    } else {
      camLocked.value = false      // nothing to protect -> free camera
      lockChosenByUser = false     // a future solve locks by default again
    }
    applyControlsEnabled()
  }
  if (payload.camera_info) applyCameraInfo(payload.camera_info)
  if (payload.model_3d_info) applyModelInfo(payload.model_3d_info)
}

function toggleGrid() {
  showGrid.value = !showGrid.value
  if (grid) grid.visible = showGrid.value
}

/** Single owner of controls.enabled: the lock AND the gizmo drag both suppress
 *  orbiting, so neither may write the flag directly or they undo each other. */
function applyControlsEnabled() {
  if (controls) controls.enabled = !camLocked.value && !gizmoDragging
}

function toggleCamLock() {
  camLocked.value = !camLocked.value
  lockChosenByUser = true
  applyControlsEnabled()
  status.value = camLocked.value ? 'Camera locked' : 'Camera free'
}

function frameModel() {
  // Framing moves the camera, which is exactly what the lock exists to prevent.
  if (camLocked.value) { status.value = 'Camera is locked — unlock to reframe'; return }
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
    camLocked: camLocked.value,
    camera: cameraInfo(),
    roll: roll.value,
    bgColor: bgColor.value,
    showBg: showBg.value,
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
    contactSlab: contactSlab.value,
    occlude: occlude.value,
    occFrom: occFrom.value,
    occTo: occTo.value,
    depthView: depthView.value,
    showRange: showRange.value,
    depthManual: depthManual.value,
    autoZ: autoZ.value,
    nearOff: nearOff.value,
    farOff: farOff.value,
    // The node's widgets own these; kept here so the tab reads true after a reload, before
    // the first run pushes them back.
    dNear: dNearUI.value,
    dFar: dFarUI.value,
    depthInvert: depthInvertUI.value,
    depthInverseSpace: sceneDepthInverseSpace.value,
    unbake: unbake.value,
    smooth: smooth.value,
    autoSmooth: autoSmooth.value,
    lights: lights.map((c) => ({ ...c })),
    object: {
      pos: { ...objPos },
      rot: { ...objRot },
      scale: objScale.value,
      pivot: pivotMode.value,
      gizmoSpace: gizmoSpace.value,
    },
  })
}

function deserialise(json: string) {
  try {
    const s = JSON.parse(json)
    if (typeof s.camLocked === 'boolean') {
      // A saved lock state IS the user's opinion — keep it across reloads and
      // don't let the next camera injection override it.
      camLocked.value = s.camLocked
      lockChosenByUser = true
      applyControlsEnabled()
    }
    // showBg first: setBgColor writes the quad through applyBackdrop, which reads it.
    if (typeof s.showBg === 'boolean') showBg.value = s.showBg
    // A saved `false` can only have been produced by clicking the hide button, and that
    // button only exists while a plate is wired — so it proves one was. Seeding the flank
    // with it is what stops the first run after a reload from undoing a deliberate hide.
    // No new serialised field, so workflows saved before this behave the same way.
    bgWired = s.showBg === false
    if (typeof s.bgColor === 'string') setBgColor(s.bgColor)
    else applyBackdrop()
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
    // Absolute since 2026-07-31. States saved before that carry `contactSpread`, a fraction of
    // the model height, and are simply dropped — the slab is a taste knob, not worth a migration.
    num(s.contactSlab, contactSlab)
    if (typeof s.shadows === 'boolean') shadows.value = s.shadows
    if (typeof s.contact === 'boolean') contact.value = s.contact
    if (typeof s.occlude === 'boolean') occlude.value = s.occlude
    if (typeof s.unbake === 'boolean') unbake.value = s.unbake
    if (typeof s.smooth === 'number') { smooth.value = s.smooth; applySmoothNormals() }
    // Absent in workflows saved before auto-smooth existed: those keep the default (on), so a
    // normal-less mesh that used to render faceted now renders smooth. The watcher re-applies.
    if (typeof s.autoSmooth === 'boolean') autoSmooth.value = s.autoSmooth
    if (typeof s.depthInvert === 'boolean') setDepthInvertUI(s.depthInvert)
    if (typeof s.depthInverseSpace === 'boolean') setDepthSpace(s.depthInverseSpace)
    if (typeof s.occFrom === 'number') setOccFrom(s.occFrom)
    if (typeof s.occTo === 'number') setOccTo(s.occTo)
    if (typeof s.depthView === 'boolean') depthView.value = s.depthView
    if (typeof s.showRange === 'boolean') showRange.value = s.showRange
    if (typeof s.depthManual === 'boolean') depthManual.value = s.depthManual
    if (typeof s.autoZ === 'boolean') autoZ.value = s.autoZ
    if (typeof s.nearOff === 'number') nearOff.value = s.nearOff
    if (typeof s.farOff === 'number') farOff.value = s.farOff
    // Restore the display only — no emit: the node restores its own widgets, and the next
    // run pushes them back through loadScene anyway.
    if (typeof s.dNear === 'number') bgDepthMaterial.uniforms.dNear.value = s.dNear
    if (typeof s.dFar === 'number') bgDepthMaterial.uniforms.dFar.value = s.dFar
    syncDepthUI()
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
      // Absent in workflows saved before the toggle existed: those keep three's default, world.
      if (o.gizmoSpace === 'world' || o.gizmoSpace === 'local') setGizmoSpace(o.gizmoSpace)
      // The model may not be loaded yet — setModel recomputes the pivot and re-applies.
      recomputePivot()
      applyObjectTransform()
    }
    applyLighting()
    if (s.camera) applyCameraInfo(s.camera)
    // After the camera: the roll axis is the view direction, which the line above just set.
    if (typeof s.roll === 'number') applyRoll(s.roll)
  } catch {
    /* a malformed blob must not take the viewport down */
  }
}

/** Maya's tool cluster: Q select, W move, E rotate, R scale.
 *
 *  Q and E are free, but **w and r are ComfyUI's** (`Workspace.ToggleSidebarTab.workflows` and
 *  `Comfy.RefreshNodeDefinitions` — checked against the shipped keybinding table, not guessed).
 *  Refresh in particular is the one that re-runs beforeRegisterNodeDef, so letting it through
 *  would be actively harmful. The handler therefore has to CONSUME the key.
 *
 *  That is why it listens on `window` in CAPTURE: ComfyUI binds on `document` (one capture, one
 *  bubble), and window precedes document on the way down, so this runs first whatever the
 *  registration order. Scope keeps it polite — only while the pointer is over the viewport, or
 *  while the modal is open — so the keys behave exactly as they do in a DCC and stay ComfyUI's
 *  everywhere else. */
const GIZMO_KEYS: Record<string, 'translate' | 'rotate' | 'scale'> = {
  w: 'translate', e: 'rotate', r: 'scale',
}
let pointerInView = false
function onViewEnter() { pointerInView = true }
function onViewLeave() { pointerInView = false }
function onGizmoKey(ev: KeyboardEvent) {
  if (!popped.value && !pointerInView) return
  if (ev.repeat || ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey) return
  const key = (ev.key || '').toLowerCase()
  const mode = GIZMO_KEYS[key]
  if (!mode && key !== 'q') return
  // Typing a value into a DragNumber must stay typing — 'w' is a character there, not a tool.
  const el = document.activeElement as HTMLElement | null
  if (el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
             el.tagName === 'SELECT')) return
  ev.preventDefault()
  ev.stopPropagation()
  if (mode) toggleGizmoMode(mode)
  else toggleGizmoSpace()
}

function cleanup() {
  window.removeEventListener('keydown', onGizmoKey, true)
  detachFine?.()
  detachGizmoFine?.()
  cancelAnimationFrame(raf)
  // A pending write-back would emit into a node that is being torn down.
  if (writebackTimer) { clearTimeout(writebackTimer); writebackTimer = 0 }
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

  // Hold Shift for tenth-speed dragging on every slider in every panel.
  detachFine = attachFineRange(el.closest('.nkd-p3d') as HTMLElement ?? el)

  initScene()
  controls = new OrbitControls(camera, r.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.12
  // The key light's world position depends on the camera yaw — track it while orbiting.
  controls.addEventListener('change', applyLighting)
  // deserialise() may have restored a locked state before controls existed.
  applyControlsEnabled()

  // Transform gizmo: drag the object in the viewport. r0.18x's TransformControls is a Controls
  // (not an Object3D) — add its getHelper() to the scene, not the control itself.
  transformControls = new TransformControls(camera, r.domElement)
  // deserialise() can restore a space before this exists (same reason applyControlsEnabled is
  // re-run after the OrbitControls are built), so push the current value in now.
  transformControls.setSpace(gizmoSpace.value)
  transformControls.addEventListener('dragging-changed', (e: any) => {
    gizmoDragging = !!e.value        // don't orbit while dragging a handle
    applyControlsEnabled()           // …without clobbering the camera lock
  })
  // Fine-drag the gizmo by damping the POINTER, never the object.
  //
  // Damping the object's transform in objectChange is the obvious approach and
  // it is WRONG: TransformControlsPlane.updateMatrixWorld does
  // `this.position.copy(this.worldPosition)`, so the plane every offset is
  // measured against follows the object; rotation speed is additionally
  // `20 / distance(object, camera)`. Writing a damped transform therefore moves
  // the ruler that produced it — positive feedback, and the object accelerates
  // off to infinity (reported, then confirmed in the three.js source).
  //
  // Damping the input has no such loop: TransformControls stays completely
  // self-consistent and simply believes the pointer travelled less. Capture
  // phase on the same element it listens to (bubble), so we shadow clientX/Y
  // before getPointer() reads them.
  let realXY: { x: number; y: number } | null = null
  let virtXY: { x: number; y: number } | null = null
  const dampPointer = (e: PointerEvent) => {
    if (!gizmoDragging) { realXY = null; virtXY = null; return }
    if (!realXY || !virtXY) {
      realXY = { x: e.clientX, y: e.clientY }
      virtXY = { x: e.clientX, y: e.clientY }
      return
    }
    const g = isFine() ? FINE_GAIN : 1
    virtXY.x += (e.clientX - realXY.x) * g
    virtXY.y += (e.clientY - realXY.y) * g
    realXY.x = e.clientX
    realXY.y = e.clientY
    if (virtXY.x === e.clientX && virtXY.y === e.clientY) return   // never damped
    const vx = virtXY.x, vy = virtXY.y
    Object.defineProperty(e, 'clientX', { get: () => vx, configurable: true })
    Object.defineProperty(e, 'clientY', { get: () => vy, configurable: true })
  }
  r.domElement.addEventListener('pointermove', dampPointer, true)
  detachGizmoFine = () => r.domElement.removeEventListener('pointermove', dampPointer, true)

  transformControls.addEventListener('objectChange', readbackGizmo)
  gizmoHelper = (transformControls as any).getHelper?.() ?? (transformControls as unknown as THREE.Object3D)
  // NOT added to the scene until a gizmo mode is active: the helper's updateMatrixWorld runs
  // on every render regardless of visibility, and with no object attached it throws
  // (undefined.clone()). It joins the scene only in setGizmoMode/gizmoLight.
  transformControls.enabled = false

  ro = new ResizeObserver(() => resize())
  ro.observe(el)
  // Popped out the view's size is DERIVED from the wrapper, so observing only the view would
  // never see the modal being resized — the box that changes is the one above it.
  if (viewWrap.value) ro.observe(viewWrap.value)
  window.addEventListener('keydown', onGizmoKey, true)
  resize()
  loop()
})

onBeforeUnmount(cleanup)

/** The node entry moves the container; this only switches the layout and re-fits the canvas.
 *  Two frames of slack: the element has to land in its new parent and be laid out before the
 *  fit can measure anything (a fit against a 0-wide box is the documented NaN/blank trap). */
function setPopped(b: boolean) {
  popped.value = b
  requestAnimationFrame(() => requestAnimationFrame(() => resize()))
}

defineExpose({ capture, loadScene, serialise, deserialise, cleanup, forceResize, setPopped })
</script>

<template>
  <div class="nkd-p3d" :class="{ 'nkd-popped': popped }">
    <div class="nkd-bar">
      <!-- The tabs only exist to ration a node's width. In the sidebar every panel is already
           on screen, so they would just be four buttons that do nothing, eating viewport height. -->
      <template v-if="!popped">
        <button :class="{ on: activePanel === 'object' }" @click="togglePanel('object')">Object</button>
        <button :class="{ on: activePanel === 'light' }" @click="togglePanel('light')">Light</button>
        <button :class="{ on: activePanel === 'depth' }" @click="togglePanel('depth')"
          title="Depth output: near/far range, live preview and Auto Z">Depth</button>
        <button v-if="hasSceneDepth" :class="{ on: activePanel === 'occlude' }" @click="togglePanel('occlude')"
          title="Depth occlusion: key out foreground from the injected depth map">Occlude</button>
      </template>
      <label class="nkd-barfield" :title="hasCamera
        ? 'Focal length, 35mm-equivalent. A solved camera drives this — the next run puts its lens back.'
        : 'Focal length in 35mm-equivalent mm (full-frame 36mm back), the same figure the fSpy node solves. Short = wide and exaggerated, long = compressed. Drag to scrub, click to type.'">Lens
        <DragNumber :model-value="focal" :step="0.5" :min="2" :max="2000" :decimals="1"
                    :reset-to="defaultFocal" @update:model-value="setFocal" />mm
      </label>
      <label class="nkd-barfield" title="Camera roll (dutch angle), in degrees. Tilts the horizon; orbiting keeps it.">Roll
        <DragNumber :model-value="roll" :step="0.25" :min="-180" :max="180" :decimals="1"
                    :reset-to="0" @update:model-value="applyRoll" />
      </label>
      <input type="color" class="nkd-color" :value="bgColor"
             @input="setBgColor(($event.target as HTMLInputElement).value)"
             title="Backdrop colour, exported in the image output — it is what shows through the holes of a mesh with alpha (MoGe, DA3). A wired bg_image covers it.">
      <span v-if="status" class="nkd-status">{{ status }}</span>
    </div>
    <!-- Panels stay BETWEEN the bar and the view in DOM order, so the stacked node layout is
         byte-for-byte what it was. Popped out, this wrapper becomes the right-hand sidebar and
         every panel shows at once — the tabs only exist because a node is too narrow for that. -->
    <div class="nkd-side">
    <!-- Order here IS the sidebar order, and it matches the tab order: transform, light, depth,
         occlude. Done by moving the block rather than with CSS `order`, so what the DOM reads
         is what the screen shows. Harmless for the node, where only one panel exists at a time. -->
    <div v-if="objectPanelOpen" class="nkd-panel" @pointerdown.stop @wheel.stop>
      <div class="nkd-obj">
        <div class="nkd-obj-row">
          <span class="nkd-obj-tag">Gizmo</span>
          <button class="nkd-gizmo" :class="{ on: gizmoMode === 'translate' }" @click="toggleGizmoMode('translate')">Move</button>
          <button class="nkd-gizmo" :class="{ on: gizmoMode === 'rotate' }" @click="toggleGizmoMode('rotate')">Rotate</button>
          <button class="nkd-gizmo" :class="{ on: gizmoMode === 'scale' }" @click="toggleGizmoMode('scale')">Scale</button>
        </div>
        <div class="nkd-obj-row">
          <span class="nkd-obj-tag">Axes</span>
          <button class="nkd-gizmo" :class="{ on: gizmoSpace === 'world' }" @click="setGizmoSpace('world')"
                  title="Gizmo handles follow the WORLD axes. Toggle with Q over the viewport.">World</button>
          <button class="nkd-gizmo" :class="{ on: gizmoSpace === 'local' }" @click="setGizmoSpace('local')"
                  title="Gizmo handles follow the OBJECT's own axes — which is also how the Rot fields compose. Toggle with Q over the viewport.">Local</button>
          <span class="nkd-obj-hint" v-if="gizmoMode === 'scale'">Scale is always local</span>
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
    <div v-if="lightPanelOpen" class="nkd-panel nkd-panel-col" @pointerdown.stop @wheel.stop>
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
        <label title="Height above the object's base that casts, in scene units. A contact is a physical distance: keep it to the few centimetres where soles, blade tips and hems are actually near the ground — anything higher smears its whole outline across the floor.">Slab<input type="range" min="0.005" max="0.5" step="0.005" v-model.number="contactSlab" :disabled="!contact"><span>{{ contactSlab.toFixed(3) }}</span></label>
        <label class="nkd-check" title="For baked/unlit models (Tripo, splat→mesh): move the texture to albedo so the object takes lights and shadows">
          <input type="checkbox" v-model="unbake"> Unbake → relight
        </label>
        <label class="nkd-check" title="Meshes that ship no normals (Hunyuan3D and most mesh exporters) are flat-shaded by the glTF spec — hard facets. This averages them into smooth vertex normals, like a DCC's auto-smooth. Meshes with authored normals are left untouched. Off = the faceted low-poly look.">
          <input type="checkbox" v-model="autoSmooth"> Auto-smooth normals
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
    <div v-if="depthPanelOpen" class="nkd-panel nkd-panel-col" @pointerdown.stop @wheel.stop>
      <div class="nkd-obj-row">
        <span class="nkd-obj-tag">{{ autoZ ? 'Offset' : 'Range' }}</span>
        <label class="nkd-barfield" :title="autoZ
          ? 'Padding on the fitted near plane, in scene units. Negative pulls it towards the camera (headroom in front of the object).'
          : 'Scene distance the depth map\'s WHITE stands for. Anything nearer clamps to pure white.'">Near
          <DragNumber :model-value="autoZ ? nearOff : dNearUI" :step="0.02" :min="autoZ ? -1e6 : 0.01"
                      :reset-to="autoZ ? 0 : null" @update:model-value="setDepthNear" />
        </label>
        <label class="nkd-barfield" :title="autoZ
          ? 'Padding on the fitted far plane, in scene units. Positive pushes it away (headroom behind the object).'
          : 'Scene distance the depth map\'s BLACK stands for. Anything farther clamps to pure black.'">Far
          <DragNumber :model-value="autoZ ? farOff : dFarUI" :step="0.1" :min="autoZ ? -1e6 : 0.03"
                      :reset-to="autoZ ? 0 : null" @update:model-value="setDepthFar" />
        </label>
        <button class="nkd-gizmo" :class="{ on: autoZ }" @click="toggleAutoZ" :title="hasSceneDepth
          ? 'Keep the range fitted to the injected map against the fSpy ground plane, re-fitting as the camera moves. Off freezes the last fit.'
          : 'Keep the range fitted to the object\'s own distance span, re-fitting as the camera moves. Off freezes the last fit.'">Auto Z</button>
      </div>
      <div class="nkd-obj-row nkd-obj-wrap">
        <label class="nkd-check" title="Show the depth pass itself in the viewport — the exact render the depth output gets">
          <input type="checkbox" v-model="depthView"> Preview
        </label>
        <label class="nkd-check" title="Draw where the near (blue) and far (red) planes cut the ground. The planes themselves would project to the same rectangle at any distance, so the ground line is what actually moves.">
          <input type="checkbox" v-model="showRange"> Range on ground
        </label>
        <label v-if="!hasSceneDepth && !autoZ" class="nkd-check" title="Off: the depth output auto-fits to the model, so its range drifts with every orbit. On: it uses Near/Far above, like the scene-map path.">
          <input type="checkbox" v-model="depthManual"> Manual range
        </label>
        <label class="nkd-check" title="On if your depth map reads FAR as white. This node's own depth output, and most disparity maps, read near as white. Also drives the Occlude band, which keys off the post-invert grey.">
          <input type="checkbox" :checked="depthInvertUI"
                 @change="setDepthInvertUI(($event.target as HTMLInputElement).checked)"> Invert map
        </label>
        <label class="nkd-check nkd-spacesel" title="Which curve turns distance into grey for the OBJECT, so it composites onto your map instead of fighting it. Depth Anything, MiDaS and most monocular estimators emit disparity (grey follows 1/z); pick metric only for a map that is linear in distance. Get it wrong and the object sits at the wrong grey even when its 3D distance is right.">Space
          <select :value="sceneDepthInverseSpace ? 'inv' : 'lin'"
                  @change="setDepthSpace(($event.target as HTMLSelectElement).value === 'inv')">
            <option value="inv">disparity</option>
            <option value="lin">metric</option>
          </select>
        </label>
      </div>
      <div class="nkd-obj-row nkd-depth-info">
        <span>Object at z {{ objZ || '—' }}</span>
        <span v-if="autoZ">Range {{ dNearUI.toFixed(2) }} – {{ dFarUI.toFixed(2) }}</span>
        <span v-if="autoZ && autoErr" class="nkd-depth-warn">Auto Z: {{ autoErr }}</span>
        <span v-if="rangeHint" class="nkd-depth-warn">{{ rangeHint }}</span>
        <span v-else-if="!hasSceneDepth && !depthManual && !autoZ">auto-fit to model — Near/Far unused</span>
      </div>
    </div>
    <div v-if="occludePanelOpen" class="nkd-panel" @pointerdown.stop @wheel.stop>
      <div class="nkd-sliders">
        <label class="nkd-check"><input type="checkbox" v-model="occlude"> Occlusion (depth-key matte)</label>
        <label title="Front of the occluding grey band. Near reads as white, so a band ending at 1 keys out the foreground">From<input type="range" min="0" max="1" step="0.01" v-model.number="occFrom" :disabled="!occlude" @input="setOccFrom(occFrom)"><span>{{ occFrom.toFixed(2) }}</span></label>
        <label title="Back of the occluding grey band. Everything between From and To hides the object">To<input type="range" min="0" max="1" step="0.01" v-model.number="occTo" :disabled="!occlude" @input="setOccTo(occTo)"><span>{{ occTo.toFixed(2) }}</span></label>
        <label class="nkd-check"><input type="checkbox" :checked="depthInvertUI" @change="setDepthInvertUI(($event.target as HTMLInputElement).checked)"> Invert depth map</label>
      </div>
    </div>
    </div>
    <div class="nkd-viewwrap" ref="viewWrap">
    <div
      ref="host"
      class="nkd-view"
      :style="popped && fitW
        ? { aspectRatio: `${aspect.w} / ${aspect.h}`, width: fitW + 'px', height: fitH + 'px' }
        : { aspectRatio: `${aspect.w} / ${aspect.h}` }"
      @contextmenu.prevent
      @pointerenter="onViewEnter"
      @pointerleave="onViewLeave"
    >
      <div class="nkd-overlay" @pointerdown.stop>
        <!-- PrimeIcons, not emoji: ComfyUI already ships the font, so these are
             monochrome, inherit the button colour and match the host UI. A colour
             emoji ignores `color` and reads as a sticker next to the others. -->
        <button :class="{ on: showGrid }" @click="toggleGrid" title="Toggle grid">
          <i class="pi pi-th-large" />
        </button>
        <button v-if="hasBgImage" :class="{ on: showBg }" @click="toggleBg"
                :title="showBg
                  ? 'Backdrop image shown — click to hide it here AND in the export; its colours keep lighting the model'
                  : 'Backdrop image hidden (viewport and export) — it still lights the model. Click to show it'">
          <i :class="showBg ? 'pi pi-image' : 'pi pi-eye-slash'" />
        </button>
        <button :disabled="camLocked" @click="frameModel"
                :title="camLocked ? 'Camera locked — unlock to reframe' : 'Frame model'">
          <i class="pi pi-expand" />
        </button>
        <button :class="{ on: camLocked }" @click="toggleCamLock"
                :title="camLocked
                  ? (hasCamera ? 'Camera locked to the solved camera — click to orbit freely'
                               : 'Camera locked — click to orbit freely')
                  : 'Camera free — click to lock it'">
          <i :class="camLocked ? 'pi pi-lock' : 'pi pi-lock-open'" />
        </button>
        <!-- Gizmo controls, mirrored from the Object panel: same call, same toggle-off, one state.
             Reaching them without opening a panel is the point — the panel covers the model.
             Left to right they follow the KEYS: Q W E R. -->
        <span class="nkd-ovsep" />
        <button :class="{ on: gizmoSpace === 'local' }" @click="toggleGizmoSpace"
                :title="(gizmoSpace === 'world'
                  ? 'Gizmo axes: WORLD — click for the object\'s own axes'
                  : 'Gizmo axes: LOCAL, the object\'s own — click for world axes')
                  + ' — Q (hover the viewport). Does not affect Scale: three always orients scale to the object.'">
          <i :class="gizmoSpace === 'world' ? 'pi pi-globe' : 'pi pi-box'" />
        </button>
        <button :class="{ on: gizmoMode === 'translate' }" title="Move gizmo — W (hover the viewport)"
                @click="toggleGizmoMode('translate')">
          <i class="pi pi-arrows-alt" />
        </button>
        <button :class="{ on: gizmoMode === 'rotate' }" title="Rotate gizmo — E (hover the viewport)"
                @click="toggleGizmoMode('rotate')">
          <i class="pi pi-refresh" />
        </button>
        <button :class="{ on: gizmoMode === 'scale' }" title="Scale gizmo — R (hover the viewport)"
                @click="toggleGizmoMode('scale')">
          <i class="pi pi-arrow-up-right-and-arrow-down-left-from-center" />
        </button>
      </div>
      <div class="nkd-overlay nkd-overlay-r" @pointerdown.stop>
        <button v-if="!popped" @click="emit('popout')"
                title="Open in a large viewer — same scene, nothing reloads">
          <i class="pi pi-window-maximize" />
        </button>
      </div>
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
.nkd-obj-hint { color: rgba(255, 255, 255, 0.35); font-size: 9px; white-space: nowrap; }
.nkd-obj-row select {
  flex: 1 1 0; min-width: 0; width: 0;
  background: #252830; border: 1px solid #3a3d46; border-radius: 4px;
  color: #c8d0e0; font-size: 11px; padding: 2px 5px;
}
.nkd-obj-row select:focus { outline: none; border-color: #4ab4ff; }
/* One row of controls, so it has to survive a narrow node instead of running off the edge. */
.nkd-obj-wrap { flex-wrap: wrap; row-gap: 3px; }
.nkd-spacesel { display: flex; align-items: center; gap: 4px; }
/* The generic rule above makes a select fill its row (width:0; flex:1) — right for the pivot
   picker that owns a row, wrong for one sharing a row with four checkboxes. */
.nkd-obj-row .nkd-spacesel select { flex: 0 0 auto; width: auto; min-width: 74px; }
.nkd-obj-row :deep(.nkd-drag), .nkd-barfield :deep(.nkd-drag) {
  position: relative;
  flex: 1 1 0; min-width: 0; width: 0;
  background: #252830; border: 1px solid #3a3d46; border-radius: 4px;
  color: #c8d0e0; font-size: 11px; padding: 2px 6px; text-align: center;
  cursor: ew-resize; user-select: none; touch-action: none;
}
.nkd-obj-row :deep(.nkd-drag-reset), .nkd-barfield :deep(.nkd-drag-reset) {
  position: absolute; right: 3px; top: 50%; transform: translateY(-50%);
  font-size: 10px; line-height: 1; color: rgba(255, 255, 255, 0.35);
  cursor: pointer; padding: 0 1px;
}
.nkd-obj-row :deep(.nkd-drag-reset:hover), .nkd-barfield :deep(.nkd-drag-reset:hover) { color: #4ab4ff; }
.nkd-obj-row :deep(.nkd-drag:hover), .nkd-barfield :deep(.nkd-drag:hover) { border-color: #4ab4ff; }
.nkd-obj-row :deep(.nkd-drag-edit), .nkd-barfield :deep(.nkd-drag-edit) { cursor: text; user-select: text; text-align: left; }
.nkd-obj-row :deep(.nkd-drag-edit:focus), .nkd-barfield :deep(.nkd-drag-edit:focus) { outline: none; border-color: #4ab4ff; }
/* In the bar there is no column to fill: a fixed, narrow field instead of the panel's 1 1 0. */
.nkd-barfield { display: flex; align-items: center; gap: 4px; flex: 0 0 auto;
  color: rgba(255, 255, 255, 0.45); font-size: 10px; }
.nkd-barfield :deep(.nkd-drag) { flex: 0 0 46px; width: 46px; padding-right: 12px; }
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
.nkd-depth-info { color: rgba(255, 255, 255, 0.45); font-size: 10px; gap: 10px; }
.nkd-depth-warn { color: #ffd166; }
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

/* ── Popped out: viewport left, every panel stacked in a sidebar on the right ──────────
   A grid rather than a row, so the DOM order (bar → panels → view) that the node layout
   depends on can stay exactly as it is while the pieces land in different cells. */
.nkd-popped {
  display: grid; height: 100%; min-height: 0;
  grid-template-columns: minmax(0, 1fr) 300px;
  grid-template-rows: auto minmax(0, 1fr);
}
/* Everything that is not the picture lives in the right column: the bar on top of the panels,
   and the viewport spanning both rows so it gets the modal's full height. */
.nkd-popped .nkd-bar {
  grid-column: 2; grid-row: 1; flex-wrap: wrap; row-gap: 4px;
  border-left: 1px solid #3a3d46; border-bottom: 1px solid #3a3d46;
}
.nkd-popped .nkd-side {
  grid-column: 2; grid-row: 2; min-height: 0; overflow-y: auto;
  background: #1a1c22; border-left: 1px solid #3a3d46;
}
.nkd-popped .nkd-viewwrap {
  grid-column: 1; grid-row: 1 / span 2; min-width: 0; min-height: 0;
  display: flex; align-items: center; justify-content: center;
}
/* The status has no room to push to the far edge in a 300px column. */
.nkd-popped .nkd-status { margin-left: 0; flex: 1 1 100%; }
/* The panels are dividers in a column now, not a strip above the canvas. */
.nkd-popped .nkd-side .nkd-panel { border-bottom: 1px solid #2a2d36; }
.nkd-popped .nkd-side .nkd-panel:last-child { border-bottom: none; }
.nkd-view :deep(canvas) { width: 100%; height: 100%; display: block; }
/* In-viewer controls: grid toggle + frame, kept out of the tab bar so it stays panel-only. */
.nkd-overlay { position: absolute; top: 6px; left: 6px; display: flex; gap: 4px; z-index: 5; }
/* Pop-out sits opposite the view controls: it acts on the WINDOW, not on the scene. */
.nkd-overlay-r { left: auto; right: 6px; }
.nkd-ovsep { width: 1px; align-self: stretch; background: #3a3d46; margin: 0 2px; flex: 0 0 auto; }
.nkd-overlay button {
  width: 24px; height: 24px; padding: 0; font-size: 13px; line-height: 1;
  display: flex; align-items: center; justify-content: center;
  background: rgba(26, 28, 34, 0.72); border: 1px solid rgba(90, 100, 120, 0.5);
  border-radius: 4px; color: #c8d0e0; cursor: pointer;
}
.nkd-overlay button:hover { border-color: #4ab4ff; color: #4ab4ff; }
.nkd-overlay button.on { border-color: #4ab4ff; color: #4ab4ff; }
.nkd-overlay button:disabled { opacity: 0.3; cursor: not-allowed; }
.nkd-overlay button:disabled:hover { border-color: #3a3d46; color: inherit; }
/* PrimeIcons glyphs: size them here so the button box stays 24px whatever the
   host's base font is, and let them inherit the button's colour on hover/on. */
.nkd-overlay button .pi { font-size: 12px; line-height: 1; color: inherit; }
</style>
