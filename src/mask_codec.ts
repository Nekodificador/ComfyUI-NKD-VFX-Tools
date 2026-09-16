/** The 3D mask as it is stored in the workflow file.
 *
 * One bit per vertex (the mask is painted 0/1), then the bytes run-length encoded as
 * (byte, run) pairs, then base64. A painted region on a 700k-vertex model is a few KB;
 * the worst case, paint scattered everywhere, is about 100 KB. No three, no DOM: `atob`
 * and `btoa` are the only platform calls, and node has them too.
 */

export interface MaskBlob { count: number; rle: string }

/** Pack the per-vertex arrays, in order, into a blob. Null when nothing is painted. */
export function encodeMaskBits(arrays: ArrayLike<number>[]): MaskBlob | null {
  let count = 0
  for (const a of arrays) count += a.length
  const bits = new Uint8Array(Math.ceil(count / 8))
  let k = 0, any = false
  for (const a of arrays) for (let i = 0; i < a.length; i++, k++) {
    if (a[i] >= 0.5) { bits[k >> 3] |= 1 << (k & 7); any = true }
  }
  if (!any) return null
  const out: number[] = []
  for (let i = 0; i < bits.length;) {
    const b = bits[i]; let n = 1
    while (i + n < bits.length && bits[i + n] === b && n < 255) n++
    out.push(b, n); i += n
  }
  let bin = ''
  for (let i = 0; i < out.length; i += 8192) bin += String.fromCharCode(...out.slice(i, i + 8192))
  return { count, rle: btoa(bin) }
}

/** Unpack a blob to one byte per vertex (0 or 1). Null if the blob is not one of ours. */
export function decodeMaskBits(m: MaskBlob): Uint8Array | null {
  if (!m || typeof m.count !== 'number' || typeof m.rle !== 'string' || m.count < 0) return null
  let bin: string
  try { bin = atob(m.rle) } catch { return null }
  const bytes = new Uint8Array(Math.ceil(m.count / 8))
  let k = 0
  for (let i = 0; i + 1 < bin.length; i += 2) {
    const b = bin.charCodeAt(i), n = bin.charCodeAt(i + 1)
    for (let j = 0; j < n && k < bytes.length; j++) bytes[k++] = b
  }
  if (k !== bytes.length) return null              // truncated: not this model's mask
  const out = new Uint8Array(m.count)
  for (let v = 0; v < m.count; v++) out[v] = (bytes[v >> 3] >> (v & 7)) & 1
  return out
}
