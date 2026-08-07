"""
😺NKD Camera Delta Prompt — two cameras in, one prompt string out.

Built for the family of "the camera has moved by: {...}" LoRAs (flux2-klein
mlsharp-3d-repair and friends), which condition on a camera delta written as
JSON *inside the text prompt*.

    Referring to the scene in image 1, restore the perspective of the scene in
    image 2. Repair the perspective and missing areas. The camera has moved by:
    {"x":0,"y":0,"z":0,"pitch":0,"yaw":0,"roll":0}

WHAT IS AND IS NOT KNOWN ABOUT THAT JSON
----------------------------------------
The template is the *only* thing its author published. Asked directly on the
model card whether the units are metres or normalised, and whether the angles
are degrees or radians, they never answered (discussions #1 and #6), and there
is no non-zero example anywhere in the public record. So the numbers below are
OUR convention, not a match to their training data:

  * angles in DEGREES  — what both existing third-party implementations chose
    (SwarmUI-SharpSplat, comfyui_camera_movement_to_prompt)
  * pitch/yaw/roll decomposed YXZ, three.js's camera order
  * translation in SCENE UNITS, whatever the upstream camera used

That is why `space`, `scale`, `flip_z` and `flip_rotation` exist. They are
calibration knobs, not configurability for its own sake: nobody knows the right
answer, so the values have to be dialled in against the actual model. Wrong
sign is the failure you will hit first — the author was reported as saying the
transform comes "from threejs" (-Z forward), while the ml-sharp scenes it is
applied to are OpenCV (+Z forward), and those disagree on exactly that axis.

The zero case is reproduced verbatim, since it is the one known-good sample:
`{"x":0,"y":0,"z":0,"pitch":0,"yaw":0,"roll":0}`.

Coordinates in: the pack's usual frame (right-handed, Y-up, camera looks down
local -Z), so 😺NKD Preview 3D, 😺NKD fSpy Camera and core's Load3D all wire in.
"""

import json
import math

# comfy_api only exists inside ComfyUI. Everything above the _HAS_COMFY guard
# must import standalone so demo() runs with no PYTHONPATH tricks.
try:
    from typing_extensions import override
    from comfy_api.latest import ComfyExtension, io
    _HAS_COMFY = True
except ImportError:  # pragma: no cover - standalone test path
    _HAS_COMFY = False


DEFAULT_TEMPLATE = (
    "Referring to the scene in image 1, restore the perspective of the scene in "
    "image 2. Repair the perspective and missing areas. The camera has moved by: "
    "{camera}"
)


def _vec(d, default=(0.0, 0.0, 0.0)):
    if not isinstance(d, dict):
        return list(default)
    return [float(d.get(k, default[i])) for i, k in enumerate("xyz")]


def _quat(d):
    """Unit quaternion (x, y, z, w) from a camera_info payload. Falls back to
    identity: a camera dict without one is a still-booting viewport, not a
    reason to fail a whole prompt."""
    q = d.get("quaternion") if isinstance(d, dict) else None
    if not isinstance(q, dict):
        return [0.0, 0.0, 0.0, 1.0]
    v = [float(q.get(k, 0.0)) for k in ("x", "y", "z", "w")]
    n = math.sqrt(sum(c * c for c in v))
    return [0.0, 0.0, 0.0, 1.0] if n < 1e-12 else [c / n for c in v]


def _qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ]


def _qconj(q):
    """Inverse, for unit quaternions only — which _quat guarantees."""
    return [-q[0], -q[1], -q[2], q[3]]


def _qrot(q, v):
    """Rotate a vector by a quaternion: q * (v,0) * q^-1."""
    t = _qmul(_qmul(q, [v[0], v[1], v[2], 0.0]), _qconj(q))
    return t[:3]


def _euler_yxz(q):
    """Quaternion -> (pitch, yaw, roll) in radians, YXZ order.

    Same decomposition as three.js Euler.setFromRotationMatrix for 'YXZ', which
    is the order a camera is naturally described in: yaw about world up, then
    pitch, then roll about the view axis. Gimbal-locked (straight up or down)
    the split between yaw and roll is arbitrary, so roll is pinned to 0 and all
    the rotation is reported as yaw — same choice three.js makes.
    """
    x, y, z, w = q
    m = (
        (1 - 2 * (y * y + z * z), 2 * (x * y - z * w),     2 * (x * z + y * w)),
        (2 * (x * y + z * w),     1 - 2 * (x * x + z * z), 2 * (y * z - x * w)),
        (2 * (x * z - y * w),     2 * (y * z + x * w),     1 - 2 * (x * x + y * y)),
    )
    pitch = math.asin(max(-1.0, min(1.0, -m[1][2])))
    if abs(m[1][2]) < 0.9999999:
        yaw = math.atan2(m[0][2], m[2][2])
        roll = math.atan2(m[1][0], m[1][1])
    else:
        yaw = math.atan2(-m[2][0], m[0][0])
        roll = 0.0
    return pitch, yaw, roll


def _num(v, decimals):
    """Round, then drop trailing zeros — so an unmoved camera prints exactly the
    `{"x":0,...}` of the published template, the one sample known to work, while
    a real move still prints as `1.5` rather than `1.500`. `-0` normalises to
    `0`: a sign on a zero is noise in a text prompt."""
    v = round(v, decimals)
    if v == 0:
        return "0"
    s = f"{v:.{decimals}f}".rstrip("0").rstrip(".")
    return s or "0"


def camera_delta(cam_from, cam_to, space="camera", scale=1.0, decimals=3,
                 flip_z=False, flip_rotation=False):
    """The move from `cam_from` to `cam_to` as the LoRA's JSON string.

    Rotation is always relative — how much the camera turned in its own frame,
    which is what pitch/yaw/roll of a camera mean. Only the translation changes
    frame with `space`: `camera` gives it in the FROM camera's axes (+X right,
    +Y up, -Z forward), `world` leaves it in scene axes.
    """
    p0, p1 = _vec(cam_from.get("position") if isinstance(cam_from, dict) else None), \
             _vec(cam_to.get("position") if isinstance(cam_to, dict) else None)
    q0, q1 = _quat(cam_from), _quat(cam_to)

    d = [p1[i] - p0[i] for i in range(3)]
    if space == "camera":
        d = _qrot(_qconj(q0), d)
    d = [c * scale for c in d]
    if flip_z:
        d[2] = -d[2]

    pitch, yaw, roll = _euler_yxz(_qmul(_qconj(q0), q1))
    rot = [math.degrees(a) for a in (pitch, yaw, roll)]
    if flip_rotation:
        rot = [-a for a in rot]

    keys = ("x", "y", "z", "pitch", "yaw", "roll")
    vals = d + rot
    # Hand-built rather than json.dumps: the numbers are pre-formatted strings so
    # the zero case matches the template byte for byte, and dumps would quote them.
    return "{" + ",".join(
        f'{json.dumps(k)}:{_num(v, decimals)}' for k, v in zip(keys, vals)
    ) + "}"


if _HAS_COMFY:

    class NKDCameraDeltaPrompt(io.ComfyNode):
        @classmethod
        def define_schema(cls) -> io.Schema:
            return io.Schema(
                node_id="NKDCameraDeltaPrompt",
                display_name="😺NKD Camera Delta Prompt",
                category="😺NKD Nodes/3D",
                description="Writes the move between two cameras as the JSON a "
                            "'the camera has moved by: {...}' LoRA expects, "
                            "substituted into your prompt.",
                inputs=[
                    io.Load3DCamera.Input(
                        "camera_from",
                        tooltip="The camera of image 1 — where the shot started. "
                                "Typically the solved plate camera (😺NKD fSpy Camera), "
                                "or the camera_info you fed into Preview 3D."),
                    io.Load3DCamera.Input(
                        "camera_to",
                        tooltip="The camera of image 2 — where you moved to. "
                                "Typically Preview 3D's camera_info output, after "
                                "unlocking the camera and orbiting."),
                    io.String.Input(
                        "template", default=DEFAULT_TEMPLATE, multiline=True,
                        tooltip="Your prompt. '{camera}' is replaced by the JSON. "
                                "Leave it out and you get the prompt unchanged; set "
                                "the template to just {camera} to get the JSON alone."),
                    io.Combo.Input(
                        "space", options=["camera", "world"], default="camera",
                        tooltip="Frame for x/y/z. 'camera': the FROM camera's own axes "
                                "(+X right, +Y up, -Z forward), so the numbers read as "
                                "'moved right / up / back'. 'world': raw scene axes. "
                                "UNVERIFIED against the LoRA — nobody published which "
                                "one it was trained on. Try both."),
                    io.Float.Input(
                        "scale", default=1.0, min=-1000.0, max=1000.0, step=0.01,
                        tooltip="Multiplies x/y/z. Your scene units are almost certainly "
                                "not the LoRA's: it was trained on COLMAP poses, which "
                                "have arbitrary scale. This is the dial for that."),
                    io.Int.Input(
                        "decimals", default=3, min=0, max=6,
                        tooltip="Decimal places. Trailing zeros are dropped, so an "
                                "unmoved camera always prints the template's exact "
                                '{"x":0,...} whatever this is set to.'),
                    io.Boolean.Input(
                        "flip_z", default=False,
                        tooltip="Negate z. The first thing to try when the repair pushes "
                                "the scene the wrong way: three.js has -Z forward, OpenCV "
                                "has +Z forward, and the two disagree on exactly this axis."),
                    io.Boolean.Input(
                        "flip_rotation", default=False,
                        tooltip="Negate pitch/yaw/roll, for when the camera turns the "
                                "opposite way to what you asked. To reverse the move "
                                "entirely, swap the two camera cables instead."),
                ],
                outputs=[
                    io.String.Output(display_name="prompt",
                                     tooltip="The template with {camera} filled in."),
                ],
            )

        @classmethod
        def execute(cls, camera_from, camera_to, template=DEFAULT_TEMPLATE,
                    space="camera", scale=1.0, decimals=3, flip_z=False,
                    flip_rotation=False) -> io.NodeOutput:
            js = camera_delta(camera_from, camera_to, space=space, scale=scale,
                              decimals=decimals, flip_z=flip_z,
                              flip_rotation=flip_rotation)
            return io.NodeOutput(template.replace("{camera}", js))

    class NKDCameraDeltaExtension(ComfyExtension):
        @override
        async def get_node_list(self) -> list[type[io.ComfyNode]]:
            return [NKDCameraDeltaPrompt]

    async def comfy_entrypoint() -> ComfyExtension:
        return NKDCameraDeltaExtension()


# ---------------------------------------------------------------------------
# Self-check
# ---------------------------------------------------------------------------

def _cam(pos=(0, 0, 0), axis=(0, 1, 0), deg=0.0):
    a = math.radians(deg) / 2
    n = math.sqrt(sum(c * c for c in axis)) or 1.0
    return {
        "position": {"x": pos[0], "y": pos[1], "z": pos[2]},
        "quaternion": {"x": axis[0] / n * math.sin(a), "y": axis[1] / n * math.sin(a),
                       "z": axis[2] / n * math.sin(a), "w": math.cos(a)},
    }


def _parse(js):
    return json.loads(js)


def demo():
    ident = _cam()

    # 1. The one known-good sample: an unmoved camera reproduces the published
    #    template byte for byte, including integer zeros rather than 0.000.
    assert camera_delta(ident, _cam()) == \
        '{"x":0,"y":0,"z":0,"pitch":0,"yaw":0,"roll":0}', camera_delta(ident, _cam())

    # 2. From a camera at rest, camera-space and world-space agree, and a step
    #    along world +X reads as +X (screen-right).
    for sp in ("camera", "world"):
        d = _parse(camera_delta(ident, _cam(pos=(2, 0, 0)), space=sp))
        assert (d["x"], d["y"], d["z"]) == (2, 0, 0), (sp, d)

    # 3. ...and they part company as soon as the FROM camera is turned. Yawed
    #    90 degrees left, the camera's own forward is world -X, so a step along
    #    world +X is a step BACKWARD: local +Z, since -Z is forward.
    yawed = _cam(axis=(0, 1, 0), deg=90)
    moved = _cam(pos=(2, 0, 0), axis=(0, 1, 0), deg=90)
    dc = _parse(camera_delta(yawed, moved, space="camera"))
    dw = _parse(camera_delta(yawed, moved, space="world"))
    assert abs(dc["z"] - 2) < 1e-6 and abs(dc["x"]) < 1e-6, dc
    assert (dw["x"], dw["y"], dw["z"]) == (2, 0, 0), dw

    # 4. Rotation is the RELATIVE turn, so the same 90 degree yaw on both
    #    cameras cancels to nothing.
    assert _parse(camera_delta(yawed, moved))["yaw"] == 0

    # 5. Sign conventions, stated so a future edit cannot quietly flip them:
    #    +yaw turns left, +pitch looks up, +roll is right-handed about -Z.
    d = _parse(camera_delta(ident, _cam(axis=(0, 1, 0), deg=30)))
    assert abs(d["yaw"] - 30) < 1e-6 and d["pitch"] == 0 and d["roll"] == 0, d
    d = _parse(camera_delta(ident, _cam(axis=(1, 0, 0), deg=20)))
    assert abs(d["pitch"] - 20) < 1e-6 and d["yaw"] == 0, d
    d = _parse(camera_delta(ident, _cam(axis=(0, 0, 1), deg=15)))
    assert abs(d["roll"] - 15) < 1e-6, d

    # 6. Straight up is gimbal lock: pitch must still read -90 and nothing may
    #    come back NaN, which is what an unguarded asin(-1.0000001) would give.
    d = _parse(camera_delta(ident, _cam(axis=(1, 0, 0), deg=-90)))
    assert abs(d["pitch"] + 90) < 1e-6 and d["roll"] == 0, d

    # 7. The calibration knobs each move one thing and nothing else.
    mv = _cam(pos=(1, 2, 3))
    assert _parse(camera_delta(ident, mv, scale=0.5))["z"] == 1.5
    fz = _parse(camera_delta(ident, mv, flip_z=True))
    assert (fz["x"], fz["y"], fz["z"]) == (1, 2, -3), fz
    turned = _cam(axis=(0, 1, 0), deg=30)
    assert _parse(camera_delta(ident, turned, flip_rotation=True))["yaw"] == -30
    assert _parse(camera_delta(ident, turned, flip_rotation=True))["x"] == 0

    # 8. Swapping the cables reverses the move — the documented way to invert,
    #    which is why there is no invert widget.
    a, b = _cam(pos=(1, 0, 0)), _cam(pos=(4, 0, 0))
    assert _parse(camera_delta(a, b, space="world"))["x"] == 3
    assert _parse(camera_delta(b, a, space="world"))["x"] == -3

    # 9. Rounding: decimals cuts precision, trailing zeros never survive, and a
    #    value that rounds to zero prints "0" rather than "-0".
    tiny = _cam(pos=(1.23456, -0.0004, 0))
    assert _parse(camera_delta(ident, tiny, decimals=2))["x"] == 1.23
    assert '"y":0,' in camera_delta(ident, tiny, decimals=2)
    assert "-0" not in camera_delta(ident, tiny, decimals=2)

    # 10. Template substitution, including the two degenerate templates.
    js = camera_delta(ident, ident)
    assert DEFAULT_TEMPLATE.replace("{camera}", js).endswith(js)
    assert "{camera}".replace("{camera}", js) == js
    assert "no placeholder".replace("{camera}", js) == "no placeholder"

    # 11. A half-built camera_info (viewport still booting) must degrade to
    #     zeros, not blow up a whole prompt at execute time.
    assert camera_delta({}, {"position": {"x": 0}}) == \
        '{"x":0,"y":0,"z":0,"pitch":0,"yaw":0,"roll":0}'

    print("nkd_camera_delta self-check OK")


if __name__ == "__main__":
    demo()
