/**
 * The contact shadow's depth range and its fragment rule, free of three so the GPU self-check
 * (test_contact_shadow.html) builds its rig from the SHIPPED pieces instead of a copy.
 *
 * The capture camera sits on the floor (y = 0) looking straight up. Two cases:
 *
 *  - The object stands on or above the floor. Only the thin slab above its base casts, fading
 *    with height: an AO-style contact, not a silhouette.
 *  - The object goes THROUGH the floor. Where it does, the camera starts inside it, and the
 *    first surface above is the inner side of whatever closes the object overhead — usually far
 *    beyond the slab, so those texels used to stay empty and the shadow came out as a hollow
 *    ring around the cut. A back face seen first means "this point of the floor is inside the
 *    object": that is the intersection, and it gets the full contact.
 */
export interface ContactRange {
  /** Camera far plane, in scene units above the floor. */
  far: number
  /** Where the slab ends, as a fraction of `far` (the depth the shader reads is 0..1 over it). */
  slabN: number
  /** The object crosses the floor: back faces count as contact. */
  sunk: boolean
}

export function contactRange(minY: number, maxY: number, slabWanted: number): ContactRange {
  const height = maxY - minY
  // Capped at the model's own height: a slab taller than the object is just its silhouette.
  const slab = Math.min(Math.max(slabWanted, 1e-3), height || 1)
  // Measured from the base, not the floor, so a lifted object keeps a (weaker) shadow.
  const reach = Math.max(minY, 0) + slab
  const sunk = minY < -1e-4 * Math.max(height, 1e-6) && maxY > 0
  // Sunk, the far plane has to reach the object's top or the inner faces it needs are clipped.
  const far = sunk ? Math.max(maxY * 1.001 + 1e-4, reach) : reach
  return { far, slabN: reach / far, sunk }
}

/** The line of three's MeshDepthMaterial fragment shader this replaces. */
export const CONTACT_FRAG_FIND = 'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );'
/** Needs `uniform float darkness, slabN, sunk;` and a DoubleSide material.
 *  ponytail: assumes a closed mesh. An open sheet facing up that crosses the floor shows its
 *  back to this camera and reads as "inside" — a per-texel parity count would fix that. */
export const CONTACT_FRAG_UNIFORMS = 'uniform float darkness;\nuniform float slabN;\nuniform float sunk;\n'
export const CONTACT_FRAG = `
	float nkdZ = fragCoordZ / slabN;
	if ( gl_FrontFacing ) {
		// Past the slab a front face casts nothing but is NOT discarded: it still has to win the
		// depth test, or the back face behind it would be read as "the camera is inside".
		gl_FragColor = vec4( vec3( 0.0 ), max( 1.0 - nkdZ, 0.0 ) * darkness );
	} else {
		if ( sunk < 0.5 ) discard;
		gl_FragColor = vec4( vec3( 0.0 ), darkness );
	}`
