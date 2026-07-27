/**
 * 😺NKD fine-adjust modifier — hold Shift for tenth-speed dragging.
 *
 * Shift is not a choice, it is the convention this pack already set: the
 * Preview 3D DragNumber has used Shift = x0.1 since it was written, and Shift is
 * what Blender, After Effects and Nuke use for precision. This module extends
 * the same feel to plain <input type="range"> sliders and to the 3D gizmo, so
 * one modifier behaves identically everywhere.
 *
 * Incremental, never measured from the start of the drag — the same rule
 * DragNumber follows. Toggling Shift halfway through a drag must not make the
 * value jump; it just changes how fast it moves from wherever it already is.
 *
 * No imports, so this file copies into any other ComfyUI-NKD-* pack as-is.
 */

export const FINE_GAIN = 0.1;

let shiftHeld = false;
if (typeof window !== "undefined") {
  // Capture phase: ComfyUI's own shortcut handling must not swallow it first.
  window.addEventListener("keydown", (e) => { if (e.key === "Shift") shiftHeld = true; }, true);
  window.addEventListener("keyup", (e) => { if (e.key === "Shift") shiftHeld = false; }, true);
  // A drag can end with the window losing focus (alt-tab) while Shift is down;
  // without this the whole UI would stay stuck in fine mode.
  window.addEventListener("blur", () => { shiftHeld = false; });
}

/** True while the fine-adjust modifier is held. */
export function isFine(): boolean { return shiftHeld; }

interface Anchor { shift: boolean; val: number; raw: number; step: string }

/**
 * Make every <input type="range"> under `root` respect the fine modifier.
 *
 * Delegated and capture-phase on purpose: the listener rewrites the element's
 * value BEFORE the control's own bubble-phase handler (v-model included) reads
 * it, so not one of the ~26 slider templates in this pack needs touching.
 *
 * Returns a detach function.
 */
export function attachFineRange(root: HTMLElement): () => void {
  const anchors = new WeakMap<HTMLInputElement, Anchor>();

  const isRange = (t: EventTarget | null): t is HTMLInputElement =>
    !!t && (t as HTMLInputElement).tagName === "INPUT" && (t as HTMLInputElement).type === "range";

  const reset = (e: Event) => {
    if (isRange(e.target)) {
      const a = anchors.get(e.target);
      if (a) e.target.step = a.step;          // leave the control as we found it
      anchors.delete(e.target);
    }
  };

  const onInput = (e: Event) => {
    const el = e.target;
    if (!isRange(el)) return;
    const raw = parseFloat(el.value);
    if (!Number.isFinite(raw)) return;

    let a = anchors.get(el);
    if (!a || a.shift !== shiftHeld) {
      // Re-anchor on every Shift transition, KEEPING the value we are already
      // at and only re-basing the pointer reference. That is what stops the
      // value snapping to wherever the cursor drifted to while fine mode was
      // lagging behind it. On the first event of a drag there is no previous
      // value, so val = raw and the control tracks the pointer exactly.
      a = { shift: shiftHeld, val: a ? a.val : raw, raw, step: a?.step ?? (el.step || "any") };
      anchors.set(el, a);
      // The step attribute quantises the value, so a tenth-speed drag would be
      // swallowed whole by it. Loosen it while fine, restore it after.
      const base = parseFloat(a.step);
      if (shiftHeld && Number.isFinite(base) && base > 0) {
        // Integer-stepped controls stay integer: some of them count iterations,
        // and 2.5 passes is not a thing.
        el.step = String(Number.isInteger(base) && base >= 1 ? 1 : base * FINE_GAIN);
      } else {
        el.step = a.step;
      }
    }

    // Gain 1 is NOT a no-op path to skip: coarse has to stay offset-based too,
    // or releasing Shift would jump the value to the pointer. Offset-based with
    // gain 1 tracks the pointer exactly, just carrying whatever lag fine mode
    // built up — which is what every app does.
    const gain = shiftHeld ? FINE_GAIN : 1;
    const min = parseFloat(el.min !== "" ? el.min : "0");
    const max = parseFloat(el.max !== "" ? el.max : "100");
    let v = a.val + (raw - a.raw) * gain;
    if (Number.isFinite(min)) v = Math.max(v, min);
    if (Number.isFinite(max)) v = Math.min(v, max);
    const q = parseFloat(el.step);
    if (Number.isFinite(q) && q > 0) v = Math.round(v / q) * q;
    el.value = String(v);
    // Carry the value forward so the next event measures from here, not from a
    // stale anchor — this is the "incremental" part.
    a.val = parseFloat(el.value);
    a.raw = raw;
  };

  root.addEventListener("pointerdown", reset, true);
  root.addEventListener("change", reset, true);
  root.addEventListener("input", onInput, true);
  return () => {
    root.removeEventListener("pointerdown", reset, true);
    root.removeEventListener("change", reset, true);
    root.removeEventListener("input", onInput, true);
  };
}
