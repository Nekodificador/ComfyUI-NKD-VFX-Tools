/** Which clipping planes the model's materials should carry, for the crop box and the floor.
 *
 *  Both features clip the same meshes, so one place decides what the materials get. three
 *  bakes the plane COUNT into the shader, which is why the caller compares lengths and only
 *  then sets needsUpdate — and why "nothing to clip" has to be null rather than an empty
 *  array: an empty one still counts as a clipped material.
 *
 *  Generic over the plane type so this stays free of three and can be asserted on its own.
 */
/** The floor's half-space, in the form three reads: it KEEPS what satisfies
 *  normal · p + constant >= 0 and clips the rest. Pointing up with constant 0 keeps y >= 0,
 *  which is where the shadow catcher sits. Flip the sign and the object loses its top half
 *  instead, which is why this ships as numbers a test can check. */
export const FLOOR_HALF_SPACE = { normal: [0, 1, 0] as [number, number, number], constant: 0 }

export function clipPlanesFor<T>(opts: {
  /** The crop box's six half-spaces. */
  cropPlanes: T[]
  /** The floor's half-space, keeping what is above it. */
  floorPlane: T
  crop: boolean
  floor: boolean
  /** Spark draws splats from its own shader, where clipping planes never arrive; the floor
   *  reaches those through the shadow catcher's depth write instead. */
  isSplat: boolean
}): T[] | null {
  if (opts.isSplat) return null
  const planes: T[] = []
  if (opts.crop) planes.push(...opts.cropPlanes)
  if (opts.floor) planes.push(opts.floorPlane)
  return planes.length ? planes : null
}
