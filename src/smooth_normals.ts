/**
 * Vertex-normal smoothing that welds by POSITION — no three import, no state, so it can be
 * asserted on from node and copied to another pack.
 *
 * Why welding by position rather than by index: a UV-unwrapped mesh DUPLICATES every vertex that
 * sits on a seam (same xyz, different uv), and `computeVertexNormals` averages per INDEX, so it
 * cannot cross one. Measured on a Hunyuan3D head: 38202 vertices for 24801 distinct positions —
 * 64% of the mesh is seam-split — and after computeVertexNormals 12798 co-located pairs disagreed
 * by more than 10°, the worst by 180°. Those disagreements ARE the visible seams.
 */

/** Sum the area-weighted face normals meeting at each position cell, then blend each vertex's
 *  normal toward that average.
 *
 *  @param position  xyz per vertex, flat.
 *  @param index     triangle indices, or null for a non-indexed (every-tri-owns-its-verts) mesh.
 *  @param orig      per-vertex normals to blend FROM (and, optionally, to orient against).
 *  @param cell      weld tolerance. Keep it tiny — it must merge only genuinely coincident
 *                   vertices, or distinct surfaces get averaged together and the mesh melts.
 *  @param blend     0 = keep `orig`, 1 = the welded average.
 *  @param alignToOriginal  Flip the average when it opposes `orig`. RIGHT for splat soup, whose
 *                   winding is inconsistent, so the accumulated normal can come out backwards.
 *                   WRONG for a seam weld: there `orig` is the wrong side of the very
 *                   discontinuity being erased, so aligning to it puts the seam straight back.
 */
export function smoothNormalsByPosition(
  position: ArrayLike<number>,
  index: ArrayLike<number> | null,
  orig: ArrayLike<number>,
  cell: number,
  blend: number,
  alignToOriginal: boolean,
): Float32Array {
  const vcount = position.length / 3
  const triCount = (index ? index.length : vcount) / 3
  const inv = 1 / cell
  const acc = new Map<string, [number, number, number]>()
  const key = (i: number) =>
    Math.round(position[i * 3] * inv) + ',' +
    Math.round(position[i * 3 + 1] * inv) + ',' +
    Math.round(position[i * 3 + 2] * inv)
  const bump = (i: number, nx: number, ny: number, nz: number) => {
    const k = key(i), e = acc.get(k)
    if (e) { e[0] += nx; e[1] += ny; e[2] += nz } else acc.set(k, [nx, ny, nz])
  }
  for (let t = 0; t < triCount; t++) {
    const ia = index ? index[t * 3] : t * 3
    const ib = index ? index[t * 3 + 1] : t * 3 + 1
    const ic = index ? index[t * 3 + 2] : t * 3 + 2
    const ax = position[ia * 3], ay = position[ia * 3 + 1], az = position[ia * 3 + 2]
    const ux = position[ib * 3] - ax, uy = position[ib * 3 + 1] - ay, uz = position[ib * 3 + 2] - az
    const vx = position[ic * 3] - ax, vy = position[ic * 3 + 1] - ay, vz = position[ic * 3 + 2] - az
    // Left unnormalised on purpose: the cross product's length is twice the triangle area, so
    // big triangles pull the average more than slivers do.
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    bump(ia, nx, ny, nz); bump(ib, nx, ny, nz); bump(ic, nx, ny, nz)
  }
  const out = new Float32Array(vcount * 3)
  for (let i = 0; i < vcount; i++) {
    const ox = orig[i * 3], oy = orig[i * 3 + 1], oz = orig[i * 3 + 2]
    const e = acc.get(key(i))
    let sx = ox, sy = oy, sz = oz
    const l = e ? Math.hypot(e[0], e[1], e[2]) : 0
    // Opposed faces cancel to nothing; normalising that gives a garbage direction, so keep the
    // original rather than shading the vertex black.
    if (e && l > 1e-12) {
      sx = e[0] / l; sy = e[1] / l; sz = e[2] / l
      if (alignToOriginal && sx * ox + sy * oy + sz * oz < 0) { sx = -sx; sy = -sy; sz = -sz }
    }
    const bx = ox + (sx - ox) * blend, by = oy + (sy - oy) * blend, bz = oz + (sz - oz) * blend
    const bl = Math.hypot(bx, by, bz) || 1
    out[i * 3] = bx / bl; out[i * 3 + 1] = by / bl; out[i * 3 + 2] = bz / bl
  }
  return out
}
