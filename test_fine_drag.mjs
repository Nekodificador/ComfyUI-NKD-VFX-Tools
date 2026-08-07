/**
 * Self-check for the fine-adjust drag.  node test_fine_drag.mjs
 * (run `npm run build` first — it imports the built module.)
 *
 * The regression this exists for: the previous version let the browser drag the
 * slider and rescaled the resulting `input` event by 0.1. That cannot travel
 * further than a tenth of the range, because the value the browser reports comes
 * from where the cursor sits *on the track* — once it reaches the end there is
 * no more delta to scale. On Lens Distort's Center X (−1…1) it stopped dead at
 * 0.2 and no amount of mouse movement would go further.
 *
 * So the test drags a long way and asserts the value actually gets there. Enough
 * of a DOM is faked to run in node: pointer capture and layout are the two
 * things a range input needs and neither exists here.
 */
import { attachFineRange, FINE_GAIN } from "./web/js/nkd_fine_drag.js";

let failures = 0;
const ok = (cond, msg) => { if (!cond) { console.error("  ✗ " + msg); failures++; } };
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg} (${a} vs ${b})`);

/** The slice of <input type="range"> the module actually touches. */
function makeSlider({ min, max, step, value, width = 200, dataDefault }) {
  const listeners = {};
  const el = {
    tagName: "INPUT", type: "range", disabled: false,
    min: String(min), max: String(max), step: String(step), value: String(value),
    dataset: dataDefault === undefined ? {} : { default: String(dataDefault) },
    focus() {}, setPointerCapture() {}, releasePointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height: 20 }),
    addEventListener(t, f) { (listeners[t] ??= []).push(f); },
    removeEventListener(t, f) { listeners[t] = (listeners[t] ?? []).filter((g) => g !== f); },
    dispatchEvent(ev) { for (const f of listeners[ev.type] ?? []) f(ev); return true; },
    _fire(t, ev) { for (const f of [...(listeners[t] ?? [])]) f(ev); },
  };
  return el;
}

/** A root that dispatches straight at the capture-phase listeners. */
function makeRoot() {
  const caps = {};
  return {
    addEventListener(t, f) { (caps[t] ??= []).push(f); },
    removeEventListener(t, f) { caps[t] = (caps[t] ?? []).filter((g) => g !== f); },
    send(t, ev) { for (const f of [...(caps[t] ?? [])]) f(ev); },
  };
}

const ptr = (target, clientX, shiftKey = false, detail = 1) => ({
  target, clientX, clientY: 0, shiftKey, button: 0, buttons: 1, pointerId: 1, detail,
  preventDefault() {}, stopPropagation() {},
});

/** Press at `from`, move through `xs`, release. Returns the final value. */
function drag(root, el, from, xs, shiftKey) {
  root.send("pointerdown", ptr(el, from, shiftKey));
  for (const x of xs) el._fire("pointermove", ptr(el, x, shiftKey));
  el._fire("pointerup", ptr(el, xs[xs.length - 1] ?? from, shiftKey));
  return parseFloat(el.value);
}

// ── The regression: a fine drag must not hit a ceiling. ──────────────────
// Center X on Lens Distort: −1…1 over a 200px track, grabbed at the middle.
{
  const root = makeRoot();
  const el = makeSlider({ min: -1, max: 1, step: 0.005, value: 0 });
  const detach = attachFineRange(root);

  // Sweep 2000px to the right — ten track-widths, which is exactly what the old
  // version could not do anything with past the first one.
  const xs = [];
  for (let x = 110; x <= 2100; x += 10) xs.push(x);
  const got = drag(root, el, 100, xs, true);

  // 2000px at 0.1 gain on a 200px/2.0 track = 2.0 of travel, so it saturates at
  // the maximum. The point is that it gets there at all: the old ceiling was
  // 0.2, and anything at or below that is the bug coming back.
  ok(got > 0.2 + 1e-9, `fine drag capped at ${got} — the 0.2 ceiling is back`);
  near(got, 1, 1e-6, "fine drag should reach the maximum over ten track widths");

  // Same gesture without Shift saturates too, only sooner.
  el.value = "0";
  near(drag(root, el, 100, xs, false), 1, 1e-6, "coarse drag should reach the maximum");
  detach();
}

// ── Shift really is a tenth, and toggling it mid-drag does not jump. ─────
{
  const root = makeRoot();
  const detach = attachFineRange(root);
  const el = makeSlider({ min: 0, max: 100, step: 0.1, value: 50 });

  // 20px of a 200px track over a span of 100 = 10 coarse, 1 fine.
  el.value = "50";
  near(drag(root, el, 100, [120], false), 60, 1e-6, "coarse gain");
  el.value = "50";
  near(drag(root, el, 100, [120], true), 51, 1e-6, "fine gain");
  ok(Math.abs(FINE_GAIN - 0.1) < 1e-12, "FINE_GAIN is a tenth");

  // Shift pressed halfway: the value must carry on from where it was, not snap
  // to wherever the cursor has got to.
  el.value = "50";
  root.send("pointerdown", ptr(el, 100, false));
  el._fire("pointermove", ptr(el, 120, false));        // +10 coarse → 60
  const mid = parseFloat(el.value);
  near(mid, 60, 1e-6, "coarse leg");
  el._fire("pointermove", ptr(el, 140, true));         // +20px fine → +1 → 61
  el._fire("pointerup", ptr(el, 140, true));
  near(parseFloat(el.value), 61, 1e-6, "toggling Shift mid-drag must not jump");
  detach();
}

// ── Pressing with Shift adjusts from the current value, not the cursor. ──
{
  const root = makeRoot();
  const detach = attachFineRange(root);
  const el = makeSlider({ min: 0, max: 100, step: 1, value: 90 });
  // Press at the far LEFT of the track: a plain press jumps there, a Shift press
  // must leave the value alone.
  el.value = "90";
  drag(root, el, 0, [], true);
  near(parseFloat(el.value), 90, 1e-6, "shift-press must not jump to the cursor");
  el.value = "90";
  drag(root, el, 0, [], false);
  near(parseFloat(el.value), 0, 1e-6, "plain press should jump to the cursor");
  detach();
}

// ── Quantization: the step is honoured, and integers stay integers. ──────
{
  const root = makeRoot();
  const detach = attachFineRange(root);

  // An integer-stepped control counts things; a tenth of a step is not a thing.
  const iter = makeSlider({ min: 0, max: 100, step: 1, value: 50 });
  drag(root, iter, 100, [103], true);                  // a nudge, in fine mode
  ok(Number.isInteger(parseFloat(iter.value)),
     `integer-stepped slider went fractional: ${iter.value}`);

  // A fractional step gets a tenth of itself while fine.
  const fine = makeSlider({ min: 0, max: 1, step: 0.01, value: 0.5 });
  drag(root, fine, 100, [101], true);
  const v = parseFloat(fine.value);
  near(Math.round(v * 1000) / 1000, v, 1e-9, "fine value should land on a thousandth");

  // The step attribute must be left exactly as it was found.
  ok(iter.step === "1" && fine.step === "0.01",
     `step not restored after the drag: ${iter.step} / ${fine.step}`);
  detach();
}

// ── Double-click resets to the declared default. ─────────────────────────
{
  const root = makeRoot();
  const detach = attachFineRange(root);

  const withDef = makeSlider({ min: 0.25, max: 4, step: 0.01, value: 3.2, dataDefault: 1 });
  let inputs = 0;
  withDef.addEventListener("input", () => inputs++);
  root.send("dblclick", ptr(withDef, 180));
  near(parseFloat(withDef.value), 1, 1e-9, "double-click should restore the default");
  ok(inputs > 0, "the reset must fire an input event or the framework never sees it");

  // No declared default: leave it alone rather than guess.
  const noDef = makeSlider({ min: 0, max: 1, step: 0.01, value: 0.42 });
  root.send("dblclick", ptr(noDef, 10));
  near(parseFloat(noDef.value), 0.42, 1e-9, "a slider with no default must not move");

  // The second press of a double-click must not drag the value to the cursor.
  const guard = makeSlider({ min: 0, max: 1, step: 0.01, value: 0.5, dataDefault: 0.5 });
  root.send("pointerdown", ptr(guard, 200, false, 2));
  near(parseFloat(guard.value), 0.5, 1e-9, "second click of a double-click must not jump");
  detach();
}

// ── Detaching really detaches. ───────────────────────────────────────────
{
  const root = makeRoot();
  const detach = attachFineRange(root);
  detach();
  const el = makeSlider({ min: 0, max: 1, step: 0.1, value: 0.5 });
  root.send("pointerdown", ptr(el, 200));
  near(parseFloat(el.value), 0.5, 1e-9, "detached listener still moved the value");
}

if (failures) { console.error(`\nfine_drag: ${failures} check(s) failed`); process.exit(1); }
console.log("fine_drag ok");
