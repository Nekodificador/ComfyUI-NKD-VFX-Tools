/**
 * Edge-ruler maths for the Preview 3D viewer: a graduated scale that slides under a fixed
 * middle mark, so the value under the mark is the value. No three, no DOM, no state — its own
 * vite entry (nkd_ruler) so `node test_ruler.mjs` asserts on the shipped functions.
 *
 * Interaction and look adapted from the edge rulers of nomadoor's Panorama Studio
 * (github.com/nomadoor/ComfyUI-Panorama-Stickers, MIT): web_src/studio/frame_layout.js.
 *
 * A LINEAR scale counts in the value's own units (mm, degrees). A LOG scale counts in
 * doublings, for a quantity with no natural zero or step (a distance): the same drag always
 * multiplies by the same factor, wherever you are on it.
 */
export interface RulerScale {
  /** Pixels per unit: per value unit when linear, per doubling when log. */
  unitPx: number
  min: number
  max: number
  log?: boolean
  /** Linear only: value units between small ticks, and between numbered ones. */
  minor?: number
  major?: number
  /** Decimals of the tick numbers. */
  decimals?: number
}

export interface RulerMark { at: number; major: boolean; text: string }

const toU = (s: RulerScale, v: number) => (s.log ? Math.log2(v) : v)
const fromU = (s: RulerScale, u: number) => (s.log ? 2 ** u : u)
const clamp = (s: RulerScale, v: number) => Math.min(s.max, Math.max(s.min, v))
const label = (v: number, d: number) => { const t = v.toFixed(d); return Number(t) === 0 ? (0).toFixed(d) : t }

// Log ticks: the 1-2-5 of each decade numbered, the other digits as small ticks.
const LOG_STEPS = [1, 1.5, 2, 3, 4, 5, 6, 7, 8, 9]
const LOG_MAJOR = [1, 2, 5]

/** Marks of a ruler `length` px long whose middle shows `value`. `at` is px from the ruler's
 *  start; values grow towards the end (right, or down). Nothing is drawn past [min, max]. */
export function rulerMarks(value: number, length: number, s: RulerScale): RulerMark[] {
  const out: RulerMark[] = []
  if (!(length > 0 && s.unitPx > 0) || !isFinite(value) || (s.log && !(value > 0))) return out
  const u0 = toU(s, value), half = length / 2 / s.unitPx
  const lo = Math.max(s.min, fromU(s, u0 - half)), hi = Math.min(s.max, fromU(s, u0 + half))
  const push = (v: number, major: boolean, text: string) =>
    out.push({ at: length / 2 + (toU(s, v) - u0) * s.unitPx, major, text })
  if (s.log) {
    for (let k = Math.floor(Math.log10(lo)); k <= Math.ceil(Math.log10(hi)); k++) {
      for (const m of LOG_STEPS) {
        const v = m * 10 ** k
        if (v < lo * (1 - 1e-9) || v > hi * (1 + 1e-9)) continue
        const major = LOG_MAJOR.includes(m)
        push(v, major, major ? String(+v.toPrecision(3)) : '')
      }
    }
    return out
  }
  const minor = s.minor ?? 1, maj = s.major ?? 10
  for (let k = Math.ceil(lo / minor - 1e-6); k <= Math.floor(hi / minor + 1e-6); k++) {
    const v = k * minor, r = v / maj
    const major = Math.abs(r - Math.round(r)) < 1e-6
    push(v, major, major ? label(Math.round(r) * maj, s.decimals ?? 0) : '')
  }
  return out
}

/** The value after dragging the scale `deltaPx` towards its end: the scale moves WITH the
 *  pointer, so smaller values come under the mark. Call it per pointer move with the previous
 *  result — incremental, so `gain` (Shift = 0.1) can change mid-drag without a jump. */
export function rulerDrag(value: number, deltaPx: number, s: RulerScale, gain = 1): number {
  return clamp(s, fromU(s, toU(s, clamp(s, value)) - (deltaPx / s.unitPx) * gain))
}

export const roundTo = (v: number, decimals: number) => { const f = 10 ** decimals; return Math.round(v * f) / f + 0 }
