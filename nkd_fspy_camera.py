"""😺NKD fSpy Camera — solve a camera from vanishing lines drawn over a photo, inside ComfyUI.

Implements the standard 2-point vanishing-point camera solve, the technique fSpy popularised
(https://fspy.io). This package is GPL-3.0, same as fSpy and ComfyUI. The interactive handles
live in the Vue widget (web/); this backend is the authoritative solver used on execute and
mirrors the JS math (algorithm parity). It emits a native LOAD3D_CAMERA dict for Preview3D,
plus the photo passthrough and the focal/FOV scalars.

v1 scope: 2-point solver, orientation + FOV only (no absolute position — fSpy can't know scene scale
without a reference distance). Camera is placed at `distance` looking at the origin with the solved
orientation.
"""

import json
import math

import numpy as np
import torch

from comfy_api.latest import ComfyExtension, io
from typing_extensions import override

# Default widget state: two vanishing-point control pairs (each = 2 line segments = 4 points),
# in Relative coords (origin top-left, y down). Rough sensible starting positions.
_DEFAULT_STATE = {
    "mode": "2point",
    "vp1": [[0.15, 0.35], [0.45, 0.30], [0.15, 0.65], [0.45, 0.70]],   # two ~horizontal lines
    "vp2": [[0.55, 0.30], [0.85, 0.35], [0.55, 0.70], [0.85, 0.65]],   # two ~horizontal lines (other dir)
    "principalPoint": {"mode": "center"},                              # or {"mode":"manual","x":..,"y":..}
    # fSpy-style axis assignment: which world axis (+/-) each vanishing point maps to; 3rd is derived.
    # Default: VP1->+X, VP2->+Z leaves +Y as the (vertical) up axis — the Three.js Y-up convention.
    "vp1Axis": "x+",
    "vp2Axis": "z+",
    "origin": [0.5, 0.5],                                             # scene anchor: where world origin projects
    "distance": 5.0,                                                   # nominal camera distance (orientation-only)
}

_AXIS_IDX = {"x": 0, "y": 1, "z": 2}


def _assignment_matrix(col_u, col_v, col_w, a1, a2):
    """Place the VP camera-space directions onto the chosen world axes -> world->cam matrix (or None)."""
    i1, s1 = _AXIS_IDX[a1[0]], (1.0 if a1[1] == "+" else -1.0)
    i2, s2 = _AXIS_IDX[a2[0]], (1.0 if a2[1] == "+" else -1.0)
    if i1 == i2:
        return None                                    # both VPs assigned to the same axis
    i3 = ({0, 1, 2} - {i1, i2}).pop()
    M = np.zeros((3, 3), dtype=np.float64)             # columns = images of world axes in camera space
    M[:, i1] = s1 * col_u
    M[:, i2] = s2 * col_v
    M[:, i3] = col_w
    if np.linalg.det(M) < 0:                           # keep it a proper (right-handed) rotation
        M[:, i3] = -col_w
    return M


def _mat_to_quat_xyzw(R):
    """3x3 rotation matrix -> normalized quaternion (x, y, z, w). Shepperd's method."""
    t = R[0, 0] + R[1, 1] + R[2, 2]
    if t > 0.0:
        s = math.sqrt(t + 1.0) * 2.0
        w, x, y, z = 0.25 * s, (R[2, 1] - R[1, 2]) / s, (R[0, 2] - R[2, 0]) / s, (R[1, 0] - R[0, 1]) / s
    elif R[0, 0] > R[1, 1] and R[0, 0] > R[2, 2]:
        s = math.sqrt(1.0 + R[0, 0] - R[1, 1] - R[2, 2]) * 2.0
        w, x, y, z = (R[2, 1] - R[1, 2]) / s, 0.25 * s, (R[0, 1] + R[1, 0]) / s, (R[0, 2] + R[2, 0]) / s
    elif R[1, 1] > R[2, 2]:
        s = math.sqrt(1.0 + R[1, 1] - R[0, 0] - R[2, 2]) * 2.0
        w, x, y, z = (R[0, 2] - R[2, 0]) / s, (R[0, 1] + R[1, 0]) / s, 0.25 * s, (R[1, 2] + R[2, 1]) / s
    else:
        s = math.sqrt(1.0 + R[2, 2] - R[0, 0] - R[1, 1]) * 2.0
        w, x, y, z = (R[1, 0] - R[0, 1]) / s, (R[0, 2] + R[2, 0]) / s, (R[1, 2] + R[2, 1]) / s, 0.25 * s
    q = np.array([x, y, z, w], dtype=np.float64)
    return q / max(np.linalg.norm(q), 1e-12)


def _rel_to_image_plane(p, aspect):
    """Relative [0,1] (y-down, top-left) -> fSpy ImagePlane (centered, y-up, aspect-corrected)."""
    rx, ry = p
    if aspect <= 1.0:                                   # tall: x in [-aspect,aspect], y in [-1,1]
        return np.array([(-1.0 + 2.0 * rx) * aspect, 1.0 - 2.0 * ry])
    return np.array([-1.0 + 2.0 * rx, (1.0 - 2.0 * ry) / aspect])   # wide: x in [-1,1], y in [-1/a,1/a]


def _line_intersection(a1, a2, b1, b2):
    """Intersection of line (a1,a2) with line (b1,b2). Returns None if near-parallel."""
    d1 = a2 - a1
    d2 = b2 - b1
    denom = d1[0] * d2[1] - d1[1] * d2[0]
    if abs(denom) < 1e-12:
        return None
    t = ((b1[0] - a1[0]) * d2[1] - (b1[1] - a1[1]) * d2[0]) / denom
    return a1 + t * d1


def solve_2vp(state, width, height):
    """fSpy 2-point solve. Returns dict(rotation 3x3 camera->world, fov_v, fov_h rad) or None."""
    aspect = width / height
    conv = lambda p: _rel_to_image_plane(p, aspect)
    vp1 = [conv(p) for p in state["vp1"]]
    vp2 = [conv(p) for p in state["vp2"]]
    Fu = _line_intersection(vp1[0], vp1[1], vp1[2], vp1[3])
    Fv = _line_intersection(vp2[0], vp2[1], vp2[2], vp2[3])
    if Fu is None or Fv is None:
        return None

    pp = state.get("principalPoint", {"mode": "center"})
    P = np.array([0.0, 0.0]) if pp.get("mode") != "manual" else conv([pp["x"], pp["y"]])

    f_sq = -float(np.dot(Fu - P, Fv - P))               # f² = -(Fu-P)·(Fv-P) for orthogonal VPs
    if f_sq <= 0.0:
        return None
    f = math.sqrt(f_sq)

    OFu = np.array([Fu[0] - P[0], Fu[1] - P[1], -f])
    OFv = np.array([Fv[0] - P[0], Fv[1] - P[1], -f])
    col_u = OFu / np.linalg.norm(OFu)
    col_v = OFv / np.linalg.norm(OFv)
    col_w = np.cross(col_u, col_v)
    Moc = _assignment_matrix(col_u, col_v, col_w, state.get("vp1Axis", "x+"), state.get("vp2Axis", "z+"))
    if Moc is None:                                     # both VPs on the same axis
        return None
    R_cam_to_world = Moc.T                              # world->cam transposed

    half_h = 1.0 if aspect <= 1.0 else 1.0 / aspect
    half_w = aspect if aspect <= 1.0 else 1.0
    fov_v = 2.0 * math.atan(half_h / f)
    fov_h = 2.0 * math.atan(half_w / f)
    return {"R": R_cam_to_world, "fov_v": fov_v, "fov_h": fov_h, "f": f, "aspect": aspect}


def _build_camera_info(solve, distance, origin):
    """Solve result -> LOAD3D_CAMERA dict. Camera is placed so the world origin projects to `origin`
    (Relative coords) — the scene anchor / ground height — at `distance`, preserving orientation."""
    R = solve["R"]
    f = solve["f"]
    aspect = solve["aspect"]
    Po = _rel_to_image_plane(origin, aspect)             # where the origin should project (image plane)
    s = distance / math.sqrt(Po[0] ** 2 + Po[1] ** 2 + f ** 2)
    origin_cam = np.array([s * Po[0], s * Po[1], -s * f])
    pos = -R @ origin_cam                                # camPos so origin projects to Po
    target = pos - distance * R[:, 2]                    # look along the optical axis (forward = -R[:,2])
    q = _mat_to_quat_xyzw(R)
    xyz = lambda v: {"x": float(v[0]), "y": float(v[1]), "z": float(v[2])}
    return {
        "position": xyz(pos), "target": xyz(target),
        "quaternion": {"x": float(q[0]), "y": float(q[1]), "z": float(q[2]), "w": float(q[3])},
        "fov": float(math.degrees(solve["fov_v"])), "aspect": float(aspect),
        "zoom": 1.0, "cameraType": "perspective",
    }


def _send_source_to_widget(unique_id, image, event: str = "nkd-fspy-source") -> None:
    """Push the RESOLVED input image to this node's viewer, so partial-executing the node
    loads the photo even when the source isn't a directly-connected Load Image (the widget
    can only read a filename off a Load Image; anything that processes the image has none).
    Raw RGB bytes (<=1024px) as base64 — no ui.PreviewImage, so no thumbnails."""
    if not unique_id:
        return
    try:
        from server import PromptServer  # type: ignore
        import base64
    except Exception:
        return
    t = image[0:1, ..., :3]
    h, w = int(t.shape[1]), int(t.shape[2])
    # Vanishing lines are placed by eye; 1024 keeps edges readable without a huge payload.
    scale = min(1024.0 / h, 1024.0 / w, 1.0)
    s = t.permute(0, 3, 1, 2).float()
    if scale < 1.0:
        s = torch.nn.functional.interpolate(s, size=(int(h * scale), int(w * scale)), mode="area")
    s = s.squeeze(0).permute(1, 2, 0)  # HWC
    ph, pw = int(s.shape[0]), int(s.shape[1])
    arr = s.clamp(0.0, 1.0).mul(255).byte().cpu().numpy()
    b64 = base64.b64encode(arr.tobytes()).decode("ascii")
    PromptServer.instance.send_sync(
        event, {"node_id": str(unique_id), "img": b64, "width": pw, "height": ph,
                "src_width": w, "src_height": h})


class NKDfSpyCamera(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="NKDfSpyCamera",
            display_name="😺NKD fSpy Camera",
            category="😺NKD Nodes/3D",
            is_output_node=True,  # runnable on its own (blue play) → loads the resolved
                                  # upstream image into the viewer
            description="Draw vanishing lines over a photo to solve the camera (fSpy 2-point). "
                        "Wire `camera_info` into Preview3D and `image` into its `bg_image`.",
            inputs=[
                io.Image.Input("image", tooltip="Reference photo (e.g. from a Load Image node). "
                                                "Also passed through to Preview3D's bg_image."),
                # Hidden in the JS widget; stores the vanishing-line control points.
                io.String.Input("fspy_state", default=json.dumps(_DEFAULT_STATE), socketless=True, multiline=True),
            ],
            outputs=[
                io.Load3DCamera.Output(display_name="camera_info"),
                io.Image.Output(display_name="image"),
                io.Float.Output(display_name="fov_vertical"),
                io.Float.Output(display_name="focal_length_mm"),
                io.Int.Output(display_name="width"),
                io.Int.Output(display_name="height"),
            ],
            hidden=[io.Hidden.unique_id],  # to target this node's viewer
        )

    @classmethod
    def execute(cls, image, fspy_state) -> io.NodeOutput:
        img_tensor = image
        height, width = int(image.shape[1]), int(image.shape[2])
        _send_source_to_widget(getattr(getattr(cls, "hidden", None), "unique_id", None), image)
        try:
            state = json.loads(fspy_state) if fspy_state else dict(_DEFAULT_STATE)
        except (ValueError, TypeError):
            state = dict(_DEFAULT_STATE)

        solve = solve_2vp(state, width, height)
        aspect = width / height
        if solve is None:                                # degenerate lines -> neutral fallback, don't crash
            half_h = 1.0 if aspect <= 1.0 else 1.0 / aspect
            f_fb = half_h / math.tan(math.radians(45.0) / 2.0)
            solve = {"R": np.eye(3), "fov_v": math.radians(45.0),
                     "fov_h": 2.0 * math.atan((aspect if aspect <= 1.0 else 1.0) / f_fb), "f": f_fb}
        solve["aspect"] = aspect

        origin = state.get("origin", [0.5, 0.5])
        camera_info = _build_camera_info(solve, float(state.get("distance", 5.0)), origin)
        fov_v_deg = math.degrees(solve["fov_v"])
        focal_mm = 36.0 / (2.0 * math.tan(solve["fov_h"] / 2.0))   # 35mm-equivalent horizontal
        return io.NodeOutput(camera_info, img_tensor, fov_v_deg, focal_mm, width, height)


class NKDfSpyCameraExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [NKDfSpyCamera]


async def comfy_entrypoint() -> NKDfSpyCameraExtension:
    return NKDfSpyCameraExtension()


NODE_CLASS_MAPPINGS = {"NKDfSpyCamera": NKDfSpyCamera}
NODE_DISPLAY_NAME_MAPPINGS = {"NKDfSpyCamera": "😺NKD fSpy Camera"}


def demo():
    """Self-check: geometry + solver on hand-constructed cases (parity anchor for the JS solver)."""
    # line intersection
    xi = _line_intersection(np.array([0.0, 0.0]), np.array([2.0, 2.0]),
                            np.array([0.0, 2.0]), np.array([2.0, 0.0]))
    assert np.allclose(xi, [1.0, 1.0]), xi

    # rel->image plane: square image center maps to origin; corners to (±1,±1)
    assert np.allclose(_rel_to_image_plane([0.5, 0.5], 1.0), [0.0, 0.0])
    assert np.allclose(_rel_to_image_plane([1.0, 0.0], 1.0), [1.0, 1.0])   # top-right, y-up

    # Known symmetric case: build lines whose VPs land at (±1, 0) in a square image plane.
    # Point (1,0) in image plane == relative (1.0, 0.5); (-1,0) == (0.0, 0.5).
    # Two lines through each VP (a vertical + a diagonal) so intersection is exact.
    state = {
        "mode": "2point",
        "vp1": [[1.0, 0.5], [1.0, 0.9], [1.0, 0.5], [0.7, 0.7]],   # both pass through rel (1,0.5)->(1,0)
        "vp2": [[0.0, 0.5], [0.0, 0.9], [0.0, 0.5], [0.3, 0.7]],   # both pass through rel (0,0.5)->(-1,0)
        "principalPoint": {"mode": "center"}, "vp1Axis": "x+", "vp2Axis": "y+",
    }
    s = solve_2vp(state, 1000, 1000)
    assert s is not None
    # Fu=(1,0), Fv=(-1,0), P=0 -> f=1 -> vertical FOV = 2*atan(1/1) = 90°
    assert abs(math.degrees(s["fov_v"]) - 90.0) < 1e-3, math.degrees(s["fov_v"])
    R = s["R"]
    assert np.allclose(R @ R.T, np.eye(3), atol=1e-9), "rotation not orthonormal"
    assert abs(np.linalg.det(R) - 1.0) < 1e-9, np.linalg.det(R)

    sc = {**s, "aspect": 1.0}
    ci = _build_camera_info(sc, 5.0, [0.5, 0.5])         # origin centered -> camera looks at origin
    q = ci["quaternion"]
    assert abs((q["x"]**2 + q["y"]**2 + q["z"]**2 + q["w"]**2) - 1.0) < 1e-9
    assert abs(ci["fov"] - 90.0) < 1e-3
    pos = np.array([ci["position"]["x"], ci["position"]["y"], ci["position"]["z"]])
    tgt = np.array([ci["target"]["x"], ci["target"]["y"], ci["target"]["z"]])
    assert abs(np.linalg.norm(pos) - 5.0) < 1e-6, pos     # camera distance == distance
    assert np.linalg.norm(tgt) < 1e-6, tgt                # centered origin -> aims at world origin
    # Moving the anchor keeps the camera distance but shifts position (different look target).
    ci2 = _build_camera_info(sc, 5.0, [0.5, 0.85])
    pos2 = np.array([ci2["position"]["x"], ci2["position"]["y"], ci2["position"]["z"]])
    assert abs(np.linalg.norm(pos2) - 5.0) < 1e-6, pos2
    assert np.linalg.norm(pos2 - pos) > 1e-3, "anchor move should shift the camera"
    print("nkd_fspy_camera demo OK")


if __name__ == "__main__":
    demo()
