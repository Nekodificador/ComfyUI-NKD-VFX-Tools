/**
 * Ghost view for the camera pins: the object drawn see-through with a yellow line on every
 * contour that tells its shape — the outer silhouette, an edge where one part covers another
 * (a wheel inside its arch) and a crease where the surface turns sharply.
 *
 * Screen-space, from two buffers the viewer renders first: the object's colour alone, and an
 * AUX buffer with what the edges are measured on. A mesh writes its view-space normal and 1/z
 * there; a splat (no surface, so no normal) writes Spark's log-normalised depth over coverage.
 * Edges are therefore the same technique for both, and a splat simply gets no creases.
 *
 * Why 1/z: in a perspective view 1/z is AFFINE in screen space on any plane, so its second
 * difference is exactly zero on a flat face however tilted it is. Plain depth curves on a
 * tilted plane and lit up whole floors in yellow. The second difference is divided by the
 * nearest 1/z in the stencil, which makes the threshold relative — the same setting works on
 * a 2-unit character and on a MoGe room.
 *
 * No three import: strings only, so test_ghost_edges.html can build the same materials from the
 * shipped file. Kept in GLSL1 syntax: three translates it, and gl_FragColor is what its
 * colorspace chunk writes to.
 */

/** Mesh aux pass. Smooth vertex normals when the geometry has them; FLAT (no normal
 *  attribute) takes them from the derivatives instead of reading a zero vector. Double-sided
 *  and flipped to face the camera, so an open shell does not flicker between the two. */
export const AUX_VERT = /* glsl */ `
#include <clipping_planes_pars_vertex>
varying vec3 vPos;
#ifndef FLAT
varying vec3 vNormal;
#endif
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vPos = mvPosition.xyz;
#ifndef FLAT
  vNormal = normalize(normalMatrix * normal);
#endif
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}
`

export const AUX_FRAG = /* glsl */ `
#include <clipping_planes_pars_fragment>
varying vec3 vPos;
#ifndef FLAT
varying vec3 vNormal;
#endif
#ifdef PEEL
// Depth peeling, one layer: keep only what lies BEHIND the front aux buffer by more than
// peelSlack (view units). Absolute and sized to the object, not just the half-float rounding:
// models with a double skin (inner and outer panels a hair apart) otherwise peel to the inner
// one in alternate pixels, and that speckle reads as hatching all over the part.
uniform sampler2D tFront;
uniform vec2 peelTexel;
uniform float peelSlack;
#endif
void main() {
  #include <clipping_planes_fragment>
#ifdef PEEL
  float front = texture2D(tFront, gl_FragCoord.xy * peelTexel).a;
  if (front <= 0.0 || -vPos.z <= 1.0 / front * (1.0 + 2e-3) + peelSlack) discard;
#endif
#ifdef FLAT
  vec3 n = normalize(cross(dFdx(vPos), dFdy(vPos)));
#else
  vec3 n = normalize(vNormal);
#endif
  if (dot(n, vPos) > 0.0) n = -n;
  gl_FragColor = vec4(n, 1.0 / max(-vPos.z, 1e-6));
}
`

export const COMPOSITE_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`

export const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tGhost;
uniform sampler2D tAux;
uniform sampler2D tBack;  // the layer behind the front one (meshes only)
uniform bool back;
uniform vec3 backColor;
uniform vec2 texel;       // 1 / buffer size
uniform float thick;      // stencil reach in buffer pixels (follows the pixel ratio)
uniform float opacity;
uniform float depthThr;   // relative second difference of 1/z
uniform float normalThr;  // 1 - cos(crease angle)
uniform bool splat;
uniform float logNear;    // log2(near + 1), the range Spark normalised the splat depth with
uniform float logFar;
uniform vec3 edgeColor;
varying vec2 vUv;

// 1/z at a texel, 0 where there is no object.
float invZ(vec4 t, bool sp) {
  if (sp) {
    if (t.a < 0.5) return 0.0;
    float d = clamp(t.r / t.a, 0.0, 1.0);
    return 1.0 / max(exp2(d * (logFar - logNear) + logNear) - 1.0, 1e-6);
  }
  return t.a;
}

float crease(vec4 c, vec4 t, bool sp) {
  if (sp || c.a <= 0.0 || t.a <= 0.0) return 0.0;
  return smoothstep(normalThr, normalThr * 1.5, 1.0 - dot(c.xyz, t.xyz));
}

float edgesOf(sampler2D t, bool sp) {
  vec2 o = texel * thick;
  vec4 c = texture2D(t, vUv);
  vec4 l = texture2D(t, vUv - vec2(o.x, 0.0));
  vec4 r = texture2D(t, vUv + vec2(o.x, 0.0));
  vec4 d = texture2D(t, vUv - vec2(0.0, o.y));
  vec4 u = texture2D(t, vUv + vec2(0.0, o.y));
  float wc = invZ(c, sp), wl = invZ(l, sp), wr = invZ(r, sp), wd = invZ(d, sp), wu = invZ(u, sp);
  float wmax = max(wc, max(max(wl, wr), max(wd, wu)));
  if (wmax <= 0.0) return 0.0;
  float s = max(abs(wl + wr - 2.0 * wc), abs(wd + wu - 2.0 * wc)) / wmax;
  float e = smoothstep(depthThr, depthThr * 1.5, s);
  return max(e, max(max(crease(c, l, sp), crease(c, r, sp)), max(crease(c, d, sp), crease(c, u, sp))));
}

void main() {
  float edge = edgesOf(tAux, splat);
  // Hidden contours: the same test on the peeled layer, dashed (diagonal stripes read as dashes
  // on a line of any direction) and dimmer, and never over a visible one.
  float hidden = 0.0;
  if (back) {
    float dash = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / (8.0 * thick)));
    hidden = edgesOf(tBack, false) * dash * (1.0 - edge) * 0.8;
  }
  vec4 g = texture2D(tGhost, vUv);
  // The ghost buffer was blended over a cleared target, so its colour is premultiplied.
  vec3 col = g.a > 0.0 ? g.rgb / g.a : vec3(0.0);
  // Spark writes display (sRGB) values whatever the target (its default viewpoint keeps
  // encodeLinear off), so a splat's ghost would be encoded twice and come out washed out.
  if (splat) col = sRGBTransferEOTF(vec4(col, 1.0)).rgb;
  float a = g.a * opacity;
  gl_FragColor = vec4(mix(mix(col, backColor, hidden), edgeColor, edge), max(a, max(edge, hidden)));
  #include <colorspace_fragment>
}
`

/** One "Detail" knob for both thresholds: 0 keeps only the strong contours, 1 shows the
 *  subtle ones. Crease angle 60° → 12°, relative depth jump 4% → 0.4%. */
export function edgeThresholds(detail: number) {
  const t = Math.min(1, Math.max(0, detail))
  const deg = 60 - 48 * t
  return {
    normalThr: 1 - Math.cos((deg * Math.PI) / 180),
    depthThr: 0.04 * Math.pow(0.1, t),
  }
}
