/**
 * 😺NKD Preview 3D — ComfyUI extension entry.
 *
 * The viewport renders in the browser, so the export is captured here at prompt time
 * and uploaded to temp; `viewport` carries the paths to the backend. ComfyUI awaits
 * widget.serializeValue, which is what makes an async capture possible at all.
 */
// @ts-ignore — resolved by ComfyUI at runtime, external in the build
import { app as comfyApp } from '../../scripts/app.js'
// @ts-ignore
import { api } from '../../scripts/api.js'
import { createApp, h, reactive } from 'vue'

import Preview3DWidget from './Preview3DWidget.vue'
import { openNkdModal, type NkdModal } from './nkd_modal'

const NODE_NAME = 'NKDPreview3D'
const EXT_NAME = 'NKD.Preview3D.Vue'
const EVENT_SCENE = 'nkd-preview3d-scene'

// Version stamp: printed once at load so a cached stale bundle is immediately visible.
const REV = 'rev 2026-07-31 (pop-out viewer; auto-smooth normals; depth controls in the viewport)'
console.log(`[NKD Preview 3D] ${REV}`)

const VIEW_W = 360
// Node body reaches a touch past the content — the canvas renderer reserves the widget
// row slightly short and would clip the viewport's bottom border otherwise.
const ROW_SAFETY = 8

/**
 * Width keeper ported verbatim from NKD Sigmas Curve (proven on the classic renderer):
 * the host can collapse or balloon on selection/re-layout, and node.size[0] is the one
 * reference that survives. Height needs no keeper — it is deterministic (see below).
 */
function keepDomWidgetSized(node: any, container: HTMLElement): () => void {
  const MAX_MARGIN = 40
  let enforcingW = false
  let goodMargin = 15
  const vueMode = () => !!(window as any).LiteGraph?.vueNodesMode
  const clamp = () => {
    if (enforcingW) return
    if (vueMode()) { if (container.style.width) container.style.width = ''; return }
    const nodeW = node.size?.[0]; if (!nodeW) return
    const host = container.parentElement
    const hostW = host ? host.clientWidth : 0
    const broken = hostW > 0 && (hostW > nodeW * 1.2 || hostW < nodeW * 0.7)
    if (!broken) {
      if (container.style.width) { enforcingW = true; container.style.width = ''; requestAnimationFrame(() => { enforcingW = false }) }
      const cw = container.clientWidth
      if (cw > 0 && cw <= nodeW && cw >= nodeW - MAX_MARGIN) goodMargin = nodeW - cw
      return
    }
    const ref = Math.round(nodeW - goodMargin)
    if (ref > 0 && Math.abs(container.clientWidth - ref) > 2) {
      enforcingW = true; container.style.boxSizing = 'border-box'; container.style.width = ref + 'px'
      requestAnimationFrame(() => { enforcingW = false })
    }
  }
  clamp()
  const ro = new ResizeObserver(clamp)
  ro.observe(container)
  const origResize = node.onResize
  node.onResize = function () { origResize?.apply(this, arguments); clamp() }
  const iv = window.setInterval(clamp, 250)
  return () => { ro.disconnect(); clearInterval(iv) }
}


// djb2 over a string — cheap, good enough to tell two renders apart. Length is mixed in to
// shrink the already-tiny collision chance for same-length data URLs.
function hashStr(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return `${s.length}:${h >>> 0}`
}

async function uploadTempImage(dataUrl: string, prefix: string) {
  const blob = await fetch(dataUrl).then((r) => r.blob())
  const name = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.png`
  const body = new FormData()
  body.append('image', new File([blob], name, { type: 'image/png' }))
  body.append('subfolder', 'nkd_threed')
  body.append('type', 'temp')
  const resp = await api.fetchApi('/upload/image', { method: 'POST', body })
  if (resp.status !== 200) throw new Error(`upload failed: ${resp.status} ${resp.statusText}`)
  const data = await resp.json()
  return `nkd_threed/${data.name} [temp]`
}

comfyApp.registerExtension({
  name: EXT_NAME,
  async beforeRegisterNodeDef(nodeType: any, nodeData: any) {
    if (nodeData.name !== NODE_NAME) return
    // Node defs get re-registered within a session (Manager & co. re-run
    // registerNodesFromDefs), and each pass wraps this same prototype again.
    // Stacked wraps mount one viewport per wrap; the orphan keeps its WebGL
    // loop alive as a frozen ghost that ignores the node. Measured: 1 node,
    // 2 mounted viewers, 1 survivor after node removal.
    if (nodeType.prototype.__nkdP3dWrapped) return
    nodeType.prototype.__nkdP3dWrapped = true

    const origCreated = nodeType.prototype.onNodeCreated
    nodeType.prototype.onNodeCreated = function () {
      const result = origCreated?.apply(this, arguments)
      const node = this

      // Natural height: the content resolves its own height from width×aspect (CSS
      // aspect-ratio), and the node reserves the SAME amount by formula. No height is
      // handed down through the host chain — the link that breaks in the wild.
      const container = document.createElement('div')
      container.style.cssText = 'width:100%;box-sizing:border-box;overflow:hidden;'

      // LiteGraph widgets are plain objects — Vue can't observe them. Mirror width/height
      // into a reactive object so the viewport's aspect tracks them, and what you frame
      // here is what gets exported.
      const aspect = reactive({ w: 4, h: 3 })
      const readAspect = () => {
        const w = Number(node.widgets?.find((x: any) => x.name === 'width')?.value)
        const h = Number(node.widgets?.find((x: any) => x.name === 'height')?.value)
        if (w > 0 && h > 0 && (aspect.w !== w || aspect.h !== h)) {
          aspect.w = w
          aspect.h = h
          // The reserve formula just changed — re-lock the node height to it.
          node.setSize([node.size[0], node.computeSize()[1]])
          node.setDirtyCanvas(true, true)
        }
      }

      // Auto Z writes the fitted anchors into the node's own widgets, the same fold-back
      // path width/height use — what you see in the node is what the next run executes.
      const setWidget = (name: string, value: unknown) => {
        const w = node.widgets?.find((x: any) => x.name === name)
        if (w) w.value = value
      }
      const onCalibrated = (near: number, far: number) => {
        setWidget('scene_depth_near', near)
        setWidget('scene_depth_far', far)
        node.setDirtyCanvas(true, true)
      }
      // Same fold-back for the depth controls that moved into the viewport: the widget stays
      // the persisted value and what the next run executes, it just has no row on the node.
      const onWidget = (name: string, value: unknown) => {
        setWidget(name, value)
        node.setDirtyCanvas(true, true)
      }
      // ── Pop-out ────────────────────────────────────────────────────────────────────
      // ONE live instance, moved. Verified with a probe before building on it: re-parenting
      // the mount container with appendChild keeps the WebGL context (never lost), the loaded
      // scene and the camera, and an orbit right after the move stays finite. A second
      // renderer would mean reloading the model and two copies of every setting to keep in
      // sync — the failure mode this pack keeps designing away from.
      // NOTE this is NOT Vue's <Teleport>: teleporting the component's own root while the app
      // stays mounted elsewhere is what broke fSpy's fullscreen. Moving the whole mount
      // container is a different operation, and it holds.
      let modal: NkdModal | null = null
      let placeholder: HTMLDivElement | null = null
      let nodeSlot: HTMLElement | null = null
      const popOut = () => {
        if (modal) return
        modal = openNkdModal({
          title: '😺 NKD Preview 3D',
          hint: 'same scene as the node — orbit, light and frame it here',
          onClose: () => {
            // Put the viewport back before anything else: the node is left with a hole
            // otherwise, and the widget's height is still reserved for it.
            if (nodeSlot && container.parentElement !== nodeSlot) nodeSlot.appendChild(container)
            container.style.height = ''  // back to the node's width×aspect formula
            container.style.flex = ''
            placeholder?.remove()
            placeholder = null
            modal = null   // cleared BEFORE the re-measure, which is a no-op while it is set
            vp()?.setPopped(false)
            requestAnimationFrame(() => { remeasureChrome(); node.setDirtyCanvas(true, true) })
          },
        })
        // Leave something in the node's reserved row, or it reads as a broken empty box.
        nodeSlot = container.parentElement as HTMLElement | null
        if (nodeSlot) {
          placeholder = document.createElement('div')
          placeholder.textContent = 'Open in the viewer'
          placeholder.style.cssText =
            'display:flex;align-items:center;justify-content:center;width:100%;height:100%;' +
            'box-sizing:border-box;color:rgba(255,255,255,0.35);font-size:11px;' +
            'background:#111318;border:1px dashed #3a3d46;border-radius:4px;'
          nodeSlot.appendChild(placeholder)
        }
        // In the node the height comes from width×aspect; in the modal it must fill the body,
        // which is what lets the sidebar run full height and the viewport take the rest.
        // .nkd-modal-body is a flex row, so claim the space as a flex child too.
        container.style.height = '100%'
        container.style.flex = '1 1 auto'
        modal.body.appendChild(container)
        vp()?.setPopped(true)
      }

      const vueApp = createApp({
        render: () => h(Preview3DWidget, {
          ref: 'vp', apiBase: api.apiURL(''), aspect, onCalibrated, onWidget, onPopout: popOut,
        }),
      })
      const mounted: any = vueApp.mount(container)
      const vp = () => mounted.$refs.vp

      // The depth range, the invert flag and the map's space are edited in the viewport's Depth
      // tab — live, against the preview. Nothing in the graph produces those numbers, so the
      // rows on the node were duplicate controls with no upstream: hide them and leave the node
      // to what you actually wire, width and height. The widgets still hold and serialise the
      // value; the viewport writes them through onWidget/onCalibrated.
      for (const name of ['scene_depth_invert', 'scene_depth_near', 'scene_depth_far',
                          'scene_depth_space']) {
        const w = node.widgets?.find((x: any) => x.name === name)
        if (!w) continue
        w.type = 'hidden'
        w.hidden = true // the Vue renderer keys off .hidden, not .type
        w.computedHeight = 0
        w.computeSize = () => [0, -4]
        // Drop the phantom socket too, but never one that is already wired — an existing
        // graph driving these from a math node would lose the link on load.
        const i = node.inputs?.findIndex((inp: any) => inp.name === name)
        if (i !== undefined && i >= 0 && !node.inputs[i].link) node.removeInput(i)
      }

      // The viewport channel is internal plumbing — never show it as a text box.
      const viewportWidget = node.widgets?.find((w: any) => w.name === 'viewport')
      if (viewportWidget) {
        viewportWidget.type = 'hidden'
        // The Vue widget renderer keys off .hidden, not .type — without it the widget
        // still paints as a single-line text box full of capture JSON (Sigmas pattern).
        viewportWidget.hidden = true
        viewportWidget.computedHeight = 0
        viewportWidget.computeSize = () => [0, -4]
        // If the def declared it multiline (older defs), the widget is a DOM textarea whose
        // ELEMENT outlives every layout-level hiding above and renders as a tall solid
        // column below the node — THE ghost column. Kill the element itself.
        if (viewportWidget.element?.style) viewportWidget.element.style.display = 'none'
        // socketless=True is not honored by the V3 frontend: it still creates a phantom
        // STRING input socket for the widget. Remove it (Sigmas pattern).
        const vpIdx = node.inputs?.findIndex((inp: any) => inp.name === 'viewport')
        if (vpIdx !== undefined && vpIdx >= 0) node.removeInput(vpIdx)

        // Stable when the render is unchanged: uploads produce unique filenames, so
        // re-capturing every queue makes `viewport` differ each time and the node (plus
        // everything downstream — a seed-locked sampler included) re-runs for nothing. We
        // hash the rendered pixels + camera + size; an identical render returns the SAME
        // paths, so ComfyUI sees unchanged inputs and caches instead of re-executing.
        let lastRenderHash = ''
        let lastValue = ''
        viewportWidget.serializeValue = async () => {
          const api_ = vp()
          if (!api_) return lastValue
          const width = node.widgets?.find((w: any) => w.name === 'width')?.value ?? 1024
          const height = node.widgets?.find((w: any) => w.name === 'height')?.value ?? 1024
          try {
            const shot = await api_.capture(width, height)
            const hash = hashStr(
              `${width}x${height}|${JSON.stringify(shot.camera_info)}|` +
              `${shot.scene}${shot.object}${shot.depth}`
            )
            // Nothing moved since the last capture → reuse the already-uploaded paths so the
            // widget value is byte-identical and the node stays cached.
            if (hash === lastRenderHash && lastValue) return lastValue
            const [image, object, depth] = await Promise.all([
              uploadTempImage(shot.scene, 'scene'),
              uploadTempImage(shot.object, 'scene_object'),
              uploadTempImage(shot.depth, 'scene_depth'),
            ])
            lastRenderHash = hash
            lastValue = JSON.stringify({ image, object, depth, camera_info: shot.camera_info })
            return lastValue
          } catch (e) {
            console.error('[NKD Preview 3D] capture failed:', e)
            return lastValue // keep the last good render rather than dropping to no-capture
          }
        }
      }

      // Sigmas Curve architecture: the widget's height is a FORMULA (node width × the
      // export aspect + measured chrome), reported identically through min/max/height so
      // litegraph reserves exactly that. The content resolves the same height naturally
      // from CSS (width:100% + aspect-ratio), so node and content agree by construction —
      // nothing depends on the host handing a height down, which is the chain that broke.
      // chromeH = toolbar + light panel (when open) + border; measured from the real DOM.
      let chromeH = 50 // safe overestimate until the first measure
      const widgetHeight = () =>
        Math.round(((node.size?.[0] || VIEW_W) * aspect.h) / aspect.w) + chromeH + ROW_SAFETY

      // IMPORTANT: do NOT set domWidget.computeSize — _arrangeWidgets calls it with zero
      // args; without it the layouter falls through to computeLayoutSize, which reads
      // these three options. (Same trap Sigmas Curve documents.)
      const domWidget = node.addDOMWidget('nkd_p3d_view', 'NKD_PREVIEW_3D', container, {
        getValue: () => (vp() ? vp().serialise() : ''),
        setValue: (v: string) => vp()?.deserialise(v),
        serialize: false,
        hideOnZoom: false,
        getMinHeight: widgetHeight,
        getMaxHeight: widgetHeight,
        getHeight: widgetHeight,
        // Diagnosis tap (localStorage.nkdP3dDebug='1'): logs only when the numbers move.
        onDraw: (w: any) => {
          if (localStorage.getItem('nkdP3dDebug') !== '1') return
          const host = container.parentElement
          const inner = container.firstElementChild as HTMLElement | null
          const line = `formula=${widgetHeight()} alloc=${w?.computedHeight} nodeH=${node.size?.[1]} host=${host?.clientHeight} container=${container.clientHeight} inner=${inner?.offsetHeight}`
          if (line !== (node as any).__nkdDbg) {
            ;(node as any).__nkdDbg = line
            console.log('[NKD P3D]', line)
          }
        },
      })

      const unclamp = keepDomWidgetSized(node, container)

      // Lock the node's height to the formula on every resize: the user drives the
      // width, the height follows. This is what keeps the border wrapping the content.
      const origResize = node.onResize
      node.onResize = function (size: number[]) {
        origResize?.apply(this, arguments)
        if (size[0] < VIEW_W) size[0] = VIEW_W
        size[1] = this.computeSize(size[0])[1]
      }

      // Safety net: node.computeSize() never reports less than the widget needs. Call
      // the original with NO args — newer LiteGraph's computeSize(out?) takes an output
      // array, not a width.
      const origComputeSize = node.computeSize.bind(node)
      node.computeSize = function (): [number, number] {
        const sz: [number, number] = origComputeSize()
        const needed = widgetHeight()
        // Everything above the DOM widget (slots + plain widgets) is sz[1] minus what
        // computeLayoutSize reserved for us — but simplest proven floor: never less
        // than the formula itself.
        if (sz[1] < needed) sz[1] = needed
        return sz
      }

      // Measure the real chrome (toolbar + panel + border) and re-lock the node height
      // when it changes — e.g. the Light panel opening/closing. offsetHeight, not
      // getBoundingClientRect: the latter includes the canvas zoom transform.
      const remeasureChrome = () => {
        // Popped out, the panels are a full-height sidebar in the modal. Measuring THAT and
        // feeding it to the node's height formula would inflate the node to the modal's size
        // while its row is showing a placeholder. The node keeps the height it had.
        if (modal) return
        const bar = container.querySelector('.nkd-bar') as HTMLElement | null
        const panel = container.querySelector('.nkd-panel') as HTMLElement | null
        const measured = (bar?.offsetHeight ?? 0) + (panel?.offsetHeight ?? 0) + 2
        if (bar && measured > 2 && measured !== chromeH) {
          chromeH = measured
          node.setSize([node.size[0], node.computeSize()[1]])
          node.setDirtyCanvas(true, true)
        }
      }
      // The container's natural height changes when the panel toggles or the aspect
      // changes — both are re-measure moments. Quiet once sizes settle (no feedback:
      // setSize never changes the container's natural height).
      const chromeRO = new ResizeObserver(remeasureChrome)
      chromeRO.observe(container)
      // The host pins the container's height to the allocation, so a panel toggle only
      // grows the INNER element — watch it too or the toggle never re-measures and the
      // viewport sits clipped until a manual node resize.
      if (container.firstElementChild) chromeRO.observe(container.firstElementChild)

      requestAnimationFrame(() => {
        remeasureChrome()
        node.setSize([node.size[0], node.computeSize()[1]])
        node.setDirtyCanvas(true, true)
      })
      // The backend pushes the resolved scene on execute. node.id is -1 until the graph
      // assigns it, so it must be read at event time, never captured now.
      const onScene = (e: any) => {
        const d = e?.detail
        if (!d || String(d.node_id) !== String(node.id)) return
        void vp()?.loadScene(d)
        // width/height may arrive over a link, which the viewport cannot resolve before
        // execution — fold back what the backend actually ran with.
        const setW = (name: string, value: number) => {
          const w = node.widgets?.find((x: any) => x.name === name)
          if (w && typeof value === 'number' && w.value !== value) w.value = value
        }
        setW('width', d.width)
        setW('height', d.height)
        // Assigning .value fires no callback, and onDrawBackground never runs under Vue
        // nodes — so a linked width/height would never reach the viewport. Read it here.
        readAspect()
      }
      api.addEventListener(EVENT_SCENE, onScene)

      // Primary: the widget's own callback, for edits made on the node.
      for (const name of ['width', 'height']) {
        const w = node.widgets?.find((x: any) => x.name === name)
        if (!w) continue
        const origCb = w.callback
        w.callback = function (value: any) {
          const r = origCb?.apply(this, arguments)
          readAspect()
          return r
        }
      }
      // Fallback: a value set programmatically (the backend folding back a linked
      // width/height) fires no callback, so re-read on the canvas frame.
      const origDrawBg = node.onDrawBackground
      node.onDrawBackground = function () {
        origDrawBg?.apply(this, arguments)
        readAspect()
      }

      // First layout: pick up the widgets' aspect and fit the canvas once the host has size.
      requestAnimationFrame(() => { readAspect(); vp()?.forceResize() })

      // onNodeCreated runs before LiteGraph restores saved widget values.
      const origConfigure = node.onConfigure
      node.onConfigure = function () {
        origConfigure?.apply(this, arguments)
        const saved = domWidget?.value
        if (saved) vp()?.deserialise(saved)
      }

      const origRemoved = node.onRemoved
      node.onRemoved = function () {
        api.removeEventListener(EVENT_SCENE, onScene)
        // Deleting the node with the viewer open would otherwise leave an orphan overlay
        // covering the screen with no way to shut it.
        modal?.close()
        unclamp()
        chromeRO.disconnect()
        vp()?.cleanup()
        vueApp.unmount()
        origRemoved?.apply(this, arguments)
      }

      return result
    }
  },
})
