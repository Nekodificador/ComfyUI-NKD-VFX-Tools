// node test_mask_codec.mjs  (after npm run build): the workflow-file mask codec.
import { encodeMaskBits, decodeMaskBits } from './web/js/nkd_mask_codec.js'

const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1) } }

// 1. Round trip on a 700k-vertex mask with a painted blob and scattered specks,
//    split across two "meshes" the way a multi-mesh model would be.
const n = 690543
const src = new Float32Array(n)
for (let i = 120000; i < 160000; i++) src[i] = 1          // a blob
for (let i = 0; i < n; i += 9973) src[i] = 1              // specks
for (let i = 400000; i < 400050; i++) src[i] = 0.7        // soft values round to 1
const cut = 300001
const blob = encodeMaskBits([src.subarray(0, cut), src.subarray(cut)])
assert(blob && blob.count === n, 'count')
const back = decodeMaskBits(blob)
assert(back && back.length === n, 'length')
for (let i = 0; i < n; i++) assert(back[i] === (src[i] >= 0.5 ? 1 : 0), `vertex ${i} changed`)
console.log(`round trip ok: ${n} vertices -> ${blob.rle.length} chars in the workflow`)
assert(blob.rle.length < 20000, 'a blob plus specks should stay small in the file')

// 2. Nothing painted is nothing stored.
assert(encodeMaskBits([new Float32Array(1000)]) === null, 'empty mask must encode to null')

// 3. Everything painted still round-trips (the least compressible sane case).
const full = new Float32Array(100001).fill(1)
const fb = encodeMaskBits([full]); const fd = decodeMaskBits(fb)
assert(fd && fd.every((v) => v === 1), 'all-ones round trip')

// 4. A blob for a different vertex count is refused, not misapplied.
assert(decodeMaskBits({ count: n + 7, rle: blob.rle }) === null, 'a count mismatch must be refused')
assert(decodeMaskBits({ count: n, rle: 'not base64 at all!!' }) === null, 'garbage must be refused')
console.log('test_mask_codec OK')
