/**
 * Putting a pointer back into UNSCALED canvas space.
 *
 * three's ViewHelper mixes two coordinate systems in `handleClick`: it takes the corner of its
 * gizmo from `domElement.offsetWidth` (layout pixels, no CSS transform) but the pointer's frame
 * from `getBoundingClientRect()` (which DOES include one). LiteGraph draws the graph canvas
 * under a CSS zoom, so on any graph zoom but 1 the clickable area drifts away from the drawn
 * gizmo. Its `render()` uses offsetWidth alone, so unscaled space is the one to agree on.
 *
 * Three-free so it can be asserted from node (same reason as depth_range.ts).
 */
export type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number }

/** The CSS zoom the element is drawn under, measured rather than assumed. */
export function zoomOf(rect: { width: number }, offsetWidth: number): number {
  const z = offsetWidth ? rect.width / offsetWidth : 1
  return z > 0 ? z : 1
}

/** The same point expressed as if the element were drawn at zoom 1. */
export function unzoomedClient(
  rect: { left: number; top: number; width: number },
  offsetWidth: number,
  clientX: number,
  clientY: number
): { clientX: number; clientY: number } {
  const z = zoomOf(rect, offsetWidth)
  return { clientX: rect.left + (clientX - rect.left) / z, clientY: rect.top + (clientY - rect.top) / z }
}

/** The element's rect at zoom 1 — the frame that agrees with offsetWidth/offsetHeight. */
export function unscaledRect(
  rect: { left: number; top: number },
  offsetWidth: number,
  offsetHeight: number
): Rect {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.left + offsetWidth,
    bottom: rect.top + offsetHeight,
    width: offsetWidth,
    height: offsetHeight,
  }
}

/** Half-size of the orthographic frustum that matches a lens AT a given distance — what makes
 *  the swap to the axis view seamless: the plane you are looking at keeps its size on screen,
 *  only the convergence goes away. Everything nearer or further legitimately changes size;
 *  that IS the point of an orthographic view. */
export function orthoFrustum(fovDeg: number, aspect: number, dist: number): { halfW: number; halfH: number } {
  const halfH = Math.tan((fovDeg * Math.PI) / 360) * dist
  return { halfW: halfH * aspect, halfH }
}
