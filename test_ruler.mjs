// node test_ruler.mjs   (after `npm run build`) — the Preview 3D edge rulers' maths.
import assert from 'node:assert/strict'
import { rulerMarks, rulerDrag, roundTo } from './web/js/nkd_ruler.js'

const LENS = { unitPx: 8, minor: 1, major: 10, decimals: 0, min: 2, max: 2000 }
const ROLL = { unitPx: 8, minor: 1, major: 10, decimals: 0, min: -180, max: 180 }
const DOLLY = { unitPx: 60, log: true, min: 0.01, max: 10000 }
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`)

// 1. The value sits under the middle mark, and neighbours are unitPx apart, growing to the end.
let m = rulerMarks(35, 200, LENS)
near(m.find(t => t.at === 100) ? 100 : NaN, 100)
const at = v => m.find(t => Math.abs(t.at - (100 + (v - 35) * 8)) < 1e-9)
assert.ok(at(36) && at(34) && at(36).at > at(34).at)
assert.deepEqual(m.filter(t => t.major).map(t => t.text), ['30', '40'])
// a fractional value: ticks stay on whole mm, none on the mark
m = rulerMarks(35.5, 200, LENS)
near(m.find(t => t.text === '40').at, 100 + 4.5 * 8)

// 2. Nothing past the range, and no "-0".
m = rulerMarks(2, 200, LENS)
assert.ok(m.every(t => t.at >= 100 - 1e-9), 'no ticks below min')
m = rulerMarks(0, 200, ROLL)
assert.ok(m.some(t => t.text === '0') && !m.some(t => t.text === '-0'))

// 3. Drag: the scale follows the pointer (towards the end = smaller), there and back is exact,
//    Shift is a tenth, and the range clamps.
near(rulerDrag(35, 80, LENS), 25)
near(rulerDrag(rulerDrag(35, 80, LENS), -80, LENS), 35)
near(rulerDrag(35, 80, LENS, 0.1), 34)
assert.equal(rulerDrag(3, 800, LENS), 2)
assert.equal(rulerDrag(170, -800, ROLL), 180)
// CONTROL: a drag that ignored the gain would land on 25 here too.
assert.notEqual(rulerDrag(35, 80, LENS, 0.1), rulerDrag(35, 80, LENS))

// 4. Incremental = no jump when the gain changes mid-drag: 40px coarse then 40px fine.
near(rulerDrag(rulerDrag(35, 40, LENS), 40, LENS, 0.1), 35 - 5 - 0.5)

// 5. Log: one unitPx is one doubling wherever you are, and it is exactly reversible.
near(rulerDrag(4, 60, DOLLY), 2)
near(rulerDrag(400, 60, DOLLY), 200, 1e-9)
near(rulerDrag(rulerDrag(3.9, 137, DOLLY), -137, DOLLY), 3.9, 1e-12)
m = rulerMarks(3.9, 220, DOLLY)
near(m.find(t => t.text === '2').at, 110 + Math.log2(2 / 3.9) * 60)
assert.ok(m.find(t => t.text === '5') && m.filter(t => !t.major).length > 0)
assert.deepEqual(rulerMarks(0, 220, DOLLY), [], 'log of zero draws nothing instead of NaN')
assert.deepEqual(rulerMarks(35, 0, LENS), [])

// 6. roundTo never returns -0.
assert.ok(Object.is(roundTo(-0.04, 1), 0))
assert.equal(roundTo(34.96, 1), 35)

console.log('test_ruler: all passed')
