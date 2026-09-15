// Check: a camera orientation with a dutch angle round-trips through the roll readback.
// The widget derives roll from camera.quaternion, then rebuilds the orientation via
// camera.up + lookAt(target) (what OrbitControls.update does). Both must agree.
import * as THREE from 'three'

function rollFromCamera(cam) {
  const dir = cam.getWorldDirection(new THREE.Vector3())
  const ref = new THREE.Vector3(0, 1, 0).addScaledVector(dir, -dir.y)
  if (ref.lengthSq() < 1e-8) return 0
  ref.normalize()
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion)
  const sin = new THREE.Vector3().crossVectors(ref, up).dot(dir)
  return THREE.MathUtils.radToDeg(Math.atan2(sin, ref.dot(up)))
}

let fails = 0
for (const rollDeg of [0, 12.5, -30, 179]) {
  for (const [yaw, pitch] of [[0, -0.3], [2.1, 0.4], [-1.0, 0.0]]) {
    // Build a solved-camera orientation: yaw/pitch then roll about the view axis.
    const cam = new THREE.PerspectiveCamera()
    cam.position.set(1, 2, 3)
    cam.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'))
    cam.updateMatrixWorld(true)
    const dir = cam.getWorldDirection(new THREE.Vector3())
    const target = cam.position.clone().addScaledVector(dir, 5)
    // Tilt it the way applyRoll does — that is the convention the readback must invert.
    cam.up.set(0, 1, 0).applyAxisAngle(dir, THREE.MathUtils.degToRad(rollDeg))
    cam.lookAt(target)
    cam.updateMatrixWorld(true)
    const qWanted = cam.quaternion.clone()

    const r = rollFromCamera(cam)
    if (Math.abs(r - rollDeg) > 1e-6) { console.log('roll mismatch', rollDeg, r); fails++ }

    // Rebuild the way OrbitControls does and demand the same orientation back.
    cam.up.set(0, 1, 0).applyAxisAngle(dir, THREE.MathUtils.degToRad(r))
    cam.lookAt(target)
    if (qWanted.angleTo(cam.quaternion) > 1e-6) { console.log('orientation lost', rollDeg, yaw, pitch); fails++ }
  }
}
// Control: without the roll readback (up left at world +Y) a dutch angle IS lost.
{
  const cam = new THREE.PerspectiveCamera()
  cam.quaternion.setFromEuler(new THREE.Euler(-0.3, 0.5, THREE.MathUtils.degToRad(25), 'YXZ'))
  cam.updateMatrixWorld(true)
  const dir = cam.getWorldDirection(new THREE.Vector3())
  const q = cam.quaternion.clone()
  cam.up.set(0, 1, 0)
  cam.lookAt(dir.multiplyScalar(5))
  if (q.angleTo(cam.quaternion) < 0.1) { console.log('control failed: roll survived without the fix'); fails++ }
}
console.log(fails ? `FAIL (${fails})` : 'OK')
process.exit(fails ? 1 : 0)
