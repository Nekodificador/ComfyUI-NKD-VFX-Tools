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
            Number.isFinite(p.modelValue) ? p.modelValue.toFixed(p.decimals) : '0'
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
const modelName = ref('')
// One tab open at a time: each panel is one row of chrome, and remeasureChrome in main.ts
// only counts the first .nkd-panel it finds.
const activePanel = ref<'' | 'light' | 'object'>('')
const togglePanel = (p: 'light' | 'object') => { activePanel.value = activePanel.value === p ? '' : p }

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

// Object transform, applied on TOP of whatever Model Info handed over (that stays on the
// model itself; this lives on a wrapper group). Rotation/scale happen around a chosen
// pivot — 'bottom' keeps a grounded object on the ground while it scales.
const objPos = reactive({ x: 0, y: 0, z: 0 })
const objRot = reactive({ x: 0, y: 0, z: 0 }) // degrees
const objScale = ref(1)
const pivotMode = ref<'bottom' | 'center' | 'origin'>('bottom')

const renderer = shallowRef<THREE.WebGLRenderer | null>(null)
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 10000)
let controls: OrbitControls | null = null

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
uniform float camNear;
uniform float camFar;
uniform float dNear;
uniform float dFar;
in vec2 vUvD;
out vec4 fragColor;
void main() {
  float d = texture(depthMap, vUvD).r;
  if (invert > 0.5) d = 1.0 - d;
  // A monocular depth map has no scale: dNear/dFar are what tie its 0..1 to scene units.
  float z = mix(dFar, dNear, clamp(d, 0.0, 1.0));
  z = max(z, camNear + 1e-4);
  // Window depth is linear in 1/z under a perspective projection — this is what makes the
  // value comparable with what the model writes, even though this quad is drawn orthographically.
  float w = clamp((1.0 / z - 1.0 / camNear) / (1.0 / camFar - 1.0 / camNear), 0.0, 1.0);
  gl_FragDepth = w;
  // The depth EXPORT's base layer is the scene map VERBATIM (post-invert, near = white).
  // It is the reference: the map arrives already calculated, so the OBJECT remaps into
  // its dNear/dFar space — never the scene through the camera's nonlinear window depth,
  // which crushes a full-range map into near-black.
  fragColor = vec4(vec3(clamp(d, 0.0, 1.0)), 1.0);
}
`

const bgDepthMaterial = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  uniforms: {
    depthMap: { value: null },
    invert: { value: 0 },
    camNear: { value: 0.01 },
    camFar: { value: 10000 },
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

// The scene depth NEVER occludes the colour renders: the object composites over the
// backdrop by design, and the depth map exists only so the depth EXPORT can composite
// the object's depth into the scene's (making them read as one space downstream).
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
  }
  r.render(scene, camera)
  r.autoClear = true
}

function loop() {
  controls?.update()
  renderFrame()
  raf = requestAnimationFrame(loop)
}

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
        if (child instanceof THREE.Mesh) child.castShadow = true
      })
    }
    ;(pivotGroup ?? scene).add(model)
    recomputePivot()
    applyObjectTransform()
    modelName.value = ref.filename
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

function resetObjectTransform() {
  objPos.x = objPos.y = objPos.z = 0
  objRot.x = objRot.y = objRot.z = 0
  objScale.value = 1
  applyObjectTransform()
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

  if (grid) grid.visible = false // never bake the grid into an export
  // The viewport renders at devicePixelRatio, but the export must be EXACTLY width×height
  // pixels — at ratio 2 the PNG would come out doubled.
  r.setPixelRatio(1)
  r.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  fitBackground()

  // 1. The full composite: model over the backdrop.
  renderFrame()
  const scene_ = r.domElement.toDataURL('image/png')

  // 2. The model alone on transparency. Its alpha is also the mask, so one render serves
  //    both — no reason to draw the same thing twice. The shadow catcher stays out: its
  //    shadow would bleed into the mask, which is meant to be the silhouette. The shadow
  //    lives in the composite above.
  const catcherWasVisible = !!shadowCatcher?.visible
  if (shadowCatcher) shadowCatcher.visible = false
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
  scene.traverse((child) => {
    if (child instanceof THREE.Mesh && child !== sparkRenderer) {
      originals.set(child, child.material)
      child.material = overrideMat
    }
  })
  r.setClearColor(0x000000, 1)
  r.autoClear = false
  r.clear()
  if (sceneDepthTexture) {
    bgDepthMaterial.uniforms.camNear.value = camera.near
    bgDepthMaterial.uniforms.camFar.value = camera.far
    r.render(bgDepthScene, bgCamera)
    r.clearDepth() // the object composites OVER the scene layer, never clips against it
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
  if (grid) grid.visible = gridWasVisible
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
  emit('calibrated', +near.toFixed(3), +far.toFixed(2))
  status.value = `Auto Z: near ${near.toFixed(2)} / far ${far.toFixed(1)}`
  window.setTimeout(() => { if (status.value.startsWith('Auto Z:')) status.value = '' }, 4000)
}

/** Payload pushed by the backend on execute. */
async function loadScene(payload: any) {
  await setModel(payload.model ?? null)
  await setBackground(payload.bg_image ?? null)
  await setSceneDepth(payload.scene_depth ?? null)
  bgDepthMaterial.uniforms.invert.value = payload.scene_depth_invert ? 1 : 0
  sceneDepthInverseSpace = payload.scene_depth_inverse_space !== false
  if (typeof payload.scene_depth_near === 'number') {
    bgDepthMaterial.uniforms.dNear.value = payload.scene_depth_near
  }
  if (typeof payload.scene_depth_far === 'number') {
    bgDepthMaterial.uniforms.dFar.value = payload.scene_depth_far
  }
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
    if (typeof s.shadows === 'boolean') shadows.value = s.shadows
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
  bgTexture?.dispose()
  sceneDepthTexture?.dispose()
  bgDepthMaterial.dispose()
  envRT?.dispose()
  pmrem?.dispose()
  renderer.value?.dispose()
  renderer.value = null
}

onMounted(() => {
  const el = host.value!
  const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
  r.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  r.setClearColor(0x000000, 0)
  r.shadowMap.enabled = true
  // PCF, not PCFSoft: PCFSoft's kernel is fixed and ignores shadow.radius outright, so the
  // softness control would move nothing. Measured — PCF spreads with radius, PCFSoft doesn't.
  r.shadowMap.type = THREE.PCFShadowMap
  el.appendChild(r.domElement)
  renderer.value = r

  initScene()
  controls = new OrbitControls(camera, r.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.12
  // The key light's world position depends on the camera yaw — track it while orbiting.
  controls.addEventListener('change', applyLighting)

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
      <button :class="{ on: showGrid }" @click="toggleGrid">Grid</button>
      <button @click="frameModel">Frame</button>
      <button v-if="hasSceneDepth" @click="autoCalibrateDepth"
        title="Fit scene_depth_near/far against the fSpy ground plane">Auto Z</button>
      <button :class="{ on: activePanel === 'light' }" @click="togglePanel('light')">Light</button>
      <button :class="{ on: activePanel === 'object' }" @click="togglePanel('object')">Object</button>
      <span class="nkd-name">{{ modelName }}</span>
      <span v-if="status" class="nkd-status">{{ status }}</span>
    </div>
    <div v-if="activePanel === 'light'" class="nkd-panel" @pointerdown.stop @wheel.stop>
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
      </div>
    </div>
    <div v-if="activePanel === 'object'" class="nkd-panel" @pointerdown.stop @wheel.stop>
      <div class="nkd-obj">
        <div class="nkd-obj-row">
          <span class="nkd-obj-tag">Pivot</span>
          <select :value="pivotMode" @change="setPivotMode(($event.target as HTMLSelectElement).value as any)">
            <option value="bottom">Bottom</option>
            <option value="center">Center</option>
            <option value="origin">Origin</option>
          </select>
          <button class="nkd-obj-reset" @click="resetObjectTransform">Reset</button>
        </div>
        <div class="nkd-obj-row">
          <span class="nkd-obj-tag">Pos</span>
          <DragNumber :model-value="objPos.x" :step="0.01" @update:model-value="(v: number) => { objPos.x = v; applyObjectTransform() }" />
          <DragNumber :model-value="objPos.y" :step="0.01" @update:model-value="(v: number) => { objPos.y = v; applyObjectTransform() }" />
          <DragNumber :model-value="objPos.z" :step="0.01" @update:model-value="(v: number) => { objPos.z = v; applyObjectTransform() }" />
        </div>
        <div class="nkd-obj-row">
          <span class="nkd-obj-tag">Rot</span>
          <DragNumber :model-value="objRot.x" :step="0.5" :decimals="1" @update:model-value="(v: number) => { objRot.x = v; applyObjectTransform() }" />
          <DragNumber :model-value="objRot.y" :step="0.5" :decimals="1" @update:model-value="(v: number) => { objRot.y = v; applyObjectTransform() }" />
          <DragNumber :model-value="objRot.z" :step="0.5" :decimals="1" @update:model-value="(v: number) => { objRot.z = v; applyObjectTransform() }" />
        </div>
        <div class="nkd-obj-row">
          <span class="nkd-obj-tag">Scale</span>
          <DragNumber :model-value="objScale" :step="0.005" :min="0.001" :decimals="3" @update:model-value="(v: number) => { objScale = v; applyObjectTransform() }" />
        </div>
      </div>
    </div>
    <div
      ref="host"
      class="nkd-view"
      :style="{ aspectRatio: `${aspect.w} / ${aspect.h}` }"
      @contextmenu.prevent
    />
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
}
.nkd-bar button:hover { border-color: #4ab4ff; }
.nkd-bar button.on { border-color: #4ab4ff; color: #4ab4ff; }
.nkd-name { color: rgba(255, 255, 255, 0.45); font-size: 10px; margin-left: auto;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 45%; }
.nkd-status { color: #ffd166; font-size: 10px; }
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
  flex: 1 1 0; min-width: 0; width: 0;
  background: #252830; border: 1px solid #3a3d46; border-radius: 4px;
  color: #c8d0e0; font-size: 11px; padding: 2px 6px; text-align: center;
  cursor: ew-resize; user-select: none; touch-action: none;
}
.nkd-obj-row :deep(.nkd-drag:hover) { border-color: #4ab4ff; }
.nkd-obj-row :deep(.nkd-drag-edit) { cursor: text; user-select: text; text-align: left; }
.nkd-obj-row :deep(.nkd-drag-edit:focus) { outline: none; border-color: #4ab4ff; }
.nkd-obj-reset {
  flex: 0 0 auto; background: #252830; border: 1px solid #3a3d46; border-radius: 4px;
  color: #c8d0e0; font-size: 10px; padding: 2px 8px; cursor: pointer;
}
.nkd-obj-reset:hover { border-color: #4ab4ff; }
/* aspect-ratio (bound inline, from the width/height widgets) gives the box a real height
   from CSS alone — width in, height out, same formula the node reserves with. Deriving it
   from the canvas instead (height:auto) feeds the canvas's own attributes back into
   layout: a first frame sized 1x1 before the element has a width renders a giant square. */
.nkd-view { width: 100%; flex: 0 0 auto; overflow: hidden; background: #111318; font-size: 0; }
.nkd-view :deep(canvas) { width: 100%; height: 100%; display: block; }
</style>
