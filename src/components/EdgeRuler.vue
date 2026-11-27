<script setup lang="ts">
/**
 * A graduated ruler on an edge of the Preview 3D frame: drag the scale under the fixed middle
 * mark. Shift = fine, double-click or the button = reset, arrows step one small tick.
 * Presentational: `value` in, `input` out — the owner holds the truth (camera.fov, camera.up).
 * Look and interaction after the edge rulers of nomadoor's Panorama Studio (MIT).
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { rulerDrag, rulerMarks, roundTo, type RulerScale } from '../ruler'

const props = withDefaults(defineProps<{
  value: number
  scale: RulerScale
  name: string
  text: string
  vertical?: boolean
  /** Vertical: the side of the frame it sits on; the numbers go on the outer side. */
  side?: 'left' | 'right'
  /** null = nothing to reset to (no button, no double-click). */
  resetTo?: number | null
  /** Decimals of the values sent. */
  precision?: number
  disabled?: boolean
}>(), { vertical: false, side: 'left', resetTo: null, precision: 1, disabled: false })
const emit = defineEmits<{ input: [v: number] }>()

const track = ref<HTMLElement | null>(null)
const length = ref(0)
const marks = computed(() => rulerMarks(props.value, length.value, props.scale))
// Numbers only where the ticks are fully opaque: the scale fades out over its outer fifths.
const labels = computed(() => marks.value.filter(m => m.text && m.at > length.value * 0.12 && m.at < length.value * 0.88))
const along = (at: number) => (props.vertical ? { top: at + 'px' } : { left: at + 'px' })
const atDefault = computed(() => props.resetTo === null || props.value === props.resetTo)

// offsetHeight, not getBoundingClientRect: the modal is unscaled today, but a ruler measured
// through a CSS transform would space its ticks for a size nobody sees.
const measure = () => {
  const t = track.value
  if (t) length.value = props.vertical ? t.offsetHeight : t.offsetWidth
}
let ro: ResizeObserver | null = null
onMounted(() => { measure(); ro = new ResizeObserver(measure); if (track.value) ro.observe(track.value) })
onBeforeUnmount(() => ro?.disconnect())

// `raw` is the unrounded value the drag is at: rounding what is SENT but accumulating on the
// raw is what lets a Shift drag move by less than one rounding step per pixel.
let drag: { id: number; at: number; raw: number; sent: number } | null = null
const coord = (e: PointerEvent) => (props.vertical ? e.clientY : e.clientX)
function down(e: PointerEvent) {
  if (props.disabled || e.button !== 0 || drag) return
  e.preventDefault()
  drag = { id: e.pointerId, at: coord(e), raw: props.value, sent: props.value }
  try { track.value?.setPointerCapture(e.pointerId) } catch { /* synthetic pointer */ }
}
function move(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.id) return
  const at = coord(e)
  drag.raw = rulerDrag(drag.raw, at - drag.at, props.scale, e.shiftKey ? 0.1 : 1)
  drag.at = at
  const next = roundTo(drag.raw, props.precision)
  if (next !== drag.sent) { drag.sent = next; emit('input', next) }
}
const end = () => { drag = null }
function reset() { if (!props.disabled && props.resetTo !== null) emit('input', props.resetTo) }
function key(e: KeyboardEvent) {
  const dir = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[e.key]
  if (!dir || props.disabled) return
  e.preventDefault(); e.stopPropagation()
  // One small tick (a tenth with Shift) is unitPx-per-tick pixels of drag the other way.
  const tick = (props.scale.log ? 0.1 : props.scale.minor ?? 1) * props.scale.unitPx
  emit('input', roundTo(rulerDrag(props.value, -dir * tick, props.scale, e.shiftKey ? 0.1 : 1), props.precision))
}
</script>

<template>
  <div class="nkd-ruler" :class="[vertical ? 'is-v' : 'is-h', vertical ? 'is-' + side : '', { 'is-off': disabled }]"
       @pointerdown.stop @wheel.stop>
    <div ref="track" class="nkd-ruler-track" role="slider" :tabindex="disabled ? -1 : 0"
         :aria-label="name" :aria-valuenow="value" :aria-valuetext="text"
         @pointerdown="down" @pointermove="move" @pointerup="end" @pointercancel="end"
         @lostpointercapture="end" @dblclick="reset" @keydown="key">
      <div class="nkd-ruler-scale">
        <i v-for="(m, i) in marks" :key="i" class="nkd-ruler-tick" :class="{ major: m.major }" :style="along(m.at)" />
      </div>
      <span v-for="m in labels" :key="m.text" class="nkd-ruler-num" :style="along(m.at)">{{ m.text }}</span>
      <i class="nkd-ruler-mark" />
    </div>
    <div class="nkd-ruler-head"><span>{{ name }}</span><b>{{ text }}</b></div>
    <button v-if="resetTo !== null" class="nkd-ruler-reset" :disabled="disabled || atDefault"
            :title="`Reset ${name}`" @click="reset"><i class="pi pi-replay" /></button>
  </div>
</template>

<style scoped>
.nkd-ruler { position: absolute; color: rgba(255, 255, 255, 0.72); font: 11px/1 system-ui, sans-serif; user-select: none; }
.nkd-ruler.is-v { width: 22px; }
.nkd-ruler.is-h { height: 22px; }
.nkd-ruler.is-off { opacity: 0.35; }
.nkd-ruler-track { position: absolute; inset: 0; touch-action: none; border-radius: 6px; outline: none; }
.is-v .nkd-ruler-track { cursor: ns-resize; }
.is-h .nkd-ruler-track { cursor: ew-resize; }
.is-off .nkd-ruler-track { cursor: default; }
/* The band that takes the pointer is wider than the ticks. */
.nkd-ruler-track::before { content: ''; position: absolute; }
.is-v .nkd-ruler-track::before { inset: 0 -10px; }
.is-h .nkd-ruler-track::before { inset: -10px 0; }
.nkd-ruler:not(.is-off) .nkd-ruler-track:hover, .nkd-ruler-track:focus-visible { background: rgba(255, 255, 255, 0.08); }
.nkd-ruler-scale { position: absolute; inset: 0; overflow: hidden; }
.is-v .nkd-ruler-scale { mask: linear-gradient(180deg, transparent, #000 20%, #000 80%, transparent);
  -webkit-mask: linear-gradient(180deg, transparent, #000 20%, #000 80%, transparent); }
.is-h .nkd-ruler-scale { mask: linear-gradient(90deg, transparent, #000 20%, #000 80%, transparent);
  -webkit-mask: linear-gradient(90deg, transparent, #000 20%, #000 80%, transparent); }
.nkd-ruler-tick { position: absolute; background: rgba(255, 255, 255, 0.5); }
.is-v .nkd-ruler-tick { left: 7px; right: 7px; height: 1px; margin-top: -0.5px; }
.is-v .nkd-ruler-tick.major { left: 3px; right: 3px; }
.is-h .nkd-ruler-tick { top: 7px; bottom: 7px; width: 1px; margin-left: -0.5px; }
.is-h .nkd-ruler-tick.major { top: 3px; bottom: 3px; }
.nkd-ruler-mark { position: absolute; background: #fff; border-radius: 1px; pointer-events: none; }
.is-v .nkd-ruler-mark { top: 50%; left: -2px; right: -2px; height: 2px; margin-top: -1px; }
.is-h .nkd-ruler-mark { left: 50%; top: -2px; bottom: -2px; width: 2px; margin-left: -1px; }
.nkd-ruler-num { position: absolute; font-size: 10px; color: rgba(255, 255, 255, 0.7); white-space: nowrap;
  pointer-events: none; font-variant-numeric: tabular-nums; }
.is-v .nkd-ruler-num { transform: translateY(-50%); }
.is-left .nkd-ruler-num { right: 26px; }
.is-right .nkd-ruler-num { left: 26px; }
.is-h .nkd-ruler-num { top: 25px; transform: translateX(-50%); }
.nkd-ruler-head { position: absolute; display: flex; align-items: center; white-space: nowrap; }
.nkd-ruler-head b { color: #fff; font-weight: 600; font-variant-numeric: tabular-nums; }
.is-v .nkd-ruler-head { bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%); flex-direction: column; gap: 4px; }
.is-h .nkd-ruler-head { right: calc(100% + 10px); top: 50%; transform: translateY(-50%); gap: 8px; }
.nkd-ruler-reset { position: absolute; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 999px;
  background: transparent; color: rgba(255, 255, 255, 0.72); cursor: pointer;
  display: flex; align-items: center; justify-content: center; }
.nkd-ruler-reset .pi { font-size: 11px; }
.nkd-ruler-reset:hover:not(:disabled) { background: rgba(255, 255, 255, 0.14); color: #fff; }
.nkd-ruler-reset:disabled { opacity: 0.3; cursor: default; }
.is-v .nkd-ruler-reset { top: calc(100% + 6px); left: 50%; transform: translateX(-50%); }
.is-h .nkd-ruler-reset { left: calc(100% + 8px); top: 50%; transform: translateY(-50%); }
</style>
