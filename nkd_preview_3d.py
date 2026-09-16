"""
😺NKD Preview 3D — a 3D viewport that exports what it renders.

Why this exists rather than using core's Preview3D: core renders the model over a
bg_image against a camera_info, but the result is a dead end — you cannot feed the
aligned render into the rest of the graph (inpainting, relight, compositing).

The render happens in the browser (WebGL), so the capture is taken client-side at
prompt-serialization time and uploaded to temp; `viewport` carries the resulting
paths back here. That means anything arriving over a *link* (width/height) is not
knowable to the client until a run reports it back — the first run after wiring one
uses the widget's own value. This is inherent to capturing before execution.

Coordinate convention matches core exactly (right-handed, Y-up, camera looks down
local -Z), so camera_info interoperates with 😺NKD fSpy Camera, Load3D and any
future core camera node.
"""

import asyncio
import hashlib
import json
import os
import uuid

import numpy as np
import torch
from PIL import Image as PILImage
from typing_extensions import override

import folder_paths
try:
    from .nkd_vfx_helpers import _safe_join
except ImportError:  # `python nkd_preview_3d.py` (self-check) runs it bare
    from nkd_vfx_helpers import _safe_join
import nodes
from comfy_api.latest import ComfyExtension, Types, io
from comfy_api.latest._io import ComfyTypeIO, comfytype
from comfy_extras.nodes_save_3d import get_mesh_batch_item, save_glb
from server import PromptServer

# Pushed to the widget on execute; the JS listens for this event.
_EVENT_SCENE = "nkd-preview3d-scene"

# The viewport renders in the browser, so the model only reaches it when this node
# pushes the scene DURING execution, while the capture rides in on `viewport`,
# taken when the prompt was serialised. That ordering means the capture is always
# one run behind the model: empty on the first run with a given model, and stale
# (a plausible render of the PREVIOUS geometry) whenever the mesh changes. So
# after pushing the scene we ask for a fresh capture and wait for it.
_CAPTURE_ROUTE = "/nkd/vfx/preview3d/capture"
_CAPTURE_TIMEOUT = 60.0     # a heavy GLB has to download and parse first
# token -> (loop, future). The LOOP has to ride along: ComfyUI runs the graph in a
# worker thread under its own asyncio.run (execution.py), so the future is created
# on a different loop from the aiohttp server's. Calling set_result straight from
# the route marks the future done on a loop that is never woken, and the waiter
# sits there until it times out.
_PENDING_CAPTURES: dict = {}


def _resolve_capture(loop, fut, value) -> None:
    loop.call_soon_threadsafe(lambda: None if fut.done() else fut.set_result(value))

try:
    from aiohttp import web as _web

    @PromptServer.instance.routes.post(_CAPTURE_ROUTE)
    async def _nkd_preview3d_capture(request):
        data = await request.json()
        entry = _PENDING_CAPTURES.get(str(data.get("token", "")))
        if entry is None or entry[1].done():
            return _web.json_response({"ok": False})   # timed out, or a stale reply
        _resolve_capture(entry[0], entry[1], data.get("viewport") or "")
        return _web.json_response({"ok": True})
except Exception:  # not inside ComfyUI (standalone tests import this module bare)
    pass


async def _fresh_capture(payload: dict) -> str:
    """Push the scene, then wait for the viewport to render it and send back a capture.

    Returns "" when nobody answers, which is the honest outcome for a headless run:
    the caller keeps whatever was serialised. Waiting on a browser that is not there
    would stall every API run for the whole timeout, so a missing client skips the
    wait instead of discovering it by timing out.
    """
    if not getattr(PromptServer.instance, "sockets", None):
        PromptServer.instance.send_sync(_EVENT_SCENE, payload)
        return ""

    token = uuid.uuid4().hex
    loop = asyncio.get_running_loop()
    fut = loop.create_future()
    _PENDING_CAPTURES[token] = (loop, fut)
    try:
        PromptServer.instance.send_sync(_EVENT_SCENE, dict(payload, capture_token=token))
        return await asyncio.wait_for(fut, timeout=_CAPTURE_TIMEOUT)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        return ""
    finally:
        _PENDING_CAPTURES.pop(token, None)


class NKDMask3D:
    """A mask painted on the model in the viewport: one value per vertex, 0..1.

    The viewport ships it as a grey PNG, one pixel per vertex, 1024 to a row; this is
    the unpacked form the bake reads, matched to the mesh by vertex count.
    """
    def __init__(self, values: torch.Tensor):
        self.values = values.reshape(-1).float().clamp(0.0, 1.0)

    @property
    def count(self) -> int:
        return int(self.values.numel())


@comfytype(io_type="NKD_MASK3D")
class NKDMask3DType(ComfyTypeIO):
    Type = NKDMask3D


def _unpack_mask3d(image: torch.Tensor, count: int) -> NKDMask3D:
    """Grey image (1,H,W,C) packed row-major, one pixel per vertex -> per-vertex values."""
    flat = image[0, ..., 0].reshape(-1)
    if flat.numel() < count:
        raise ValueError(f"mask3d image holds {flat.numel()} values, the model has {count} vertices")
    return NKDMask3D(flat[:count])


@comfytype(io_type="TRIMESH")
class TrimeshIO(ComfyTypeIO):
    """Hunyuan3DWrapper & co. hand over a live trimesh.Trimesh under this io_type.

    Declared here only so the cable plugs into model_file; no trimesh import needed —
    the object arrives already built and exports itself.
    """
    Type = object


def _tensor_to_temp_png(image, prefix: str) -> str:
    """Write an IMAGE tensor's first frame to the temp dir. Returns an annotated path."""
    array = (image[0].cpu().numpy() * 255).astype(np.uint8)
    temp_dir = folder_paths.get_temp_directory()
    os.makedirs(temp_dir, exist_ok=True)  # may not exist yet, or have been cleaned
    filename = f"{prefix}_{uuid.uuid4().hex}.png"
    PILImage.fromarray(array).save(os.path.join(temp_dir, filename), compress_level=1)
    return filename


def _stable_temp_name(path: str, ext: str) -> str:
    """Rename a freshly written temp file to one derived from its CONTENT.

    The viewport reloads whenever the URL changes, and a uuid name changes on every
    single run, so identical geometry was being re-downloaded and re-parsed on each
    queue: a visible flash, and a pile of temp files. Same bytes now means the same
    name, which the browser and the widget can both skip.
    """
    with open(path, "rb") as f:
        digest = hashlib.sha1(f.read()).hexdigest()[:16]
    name = f"nkd_preview3d_{digest}{ext}"
    target = os.path.join(os.path.dirname(path), name)
    if os.path.exists(target):
        os.remove(path)          # already written by an earlier run, byte for byte
    else:
        os.replace(path, target)
    return name


def _mesh_to_temp_glb(mesh) -> str:
    """Write a MESH to a temp .glb so the viewport can fetch it. Returns the filename.

    The mesh-producing nodes (Convert MoGe Point Map to Mesh, Convert DA3 Geometry to
    Mesh) hand over geometry in memory, not a file, and they only ever emit a
    single-item batch — per-image vertex counts differ, so they can't stack. Core's
    own GLB writer does the packing; there is no reason for a second one here.
    """
    vertices, faces, colors, uvs, normals = get_mesh_batch_item(mesh, 0)
    if vertices.shape[0] == 0 or faces.shape[0] == 0:
        raise ValueError("😺NKD Preview 3D was handed an empty mesh.")

    texture = getattr(mesh, "texture", None)
    tex_img = None
    if texture is not None:
        array = (texture[0, ..., :3].clamp(0.0, 1.0).cpu().numpy() * 255).astype(np.uint8)
        tex_img = PILImage.fromarray(array)

    temp_dir = folder_paths.get_temp_directory()
    os.makedirs(temp_dir, exist_ok=True)
    filename = f"nkd_preview3d_{uuid.uuid4().hex}.glb"
    save_glb(vertices, faces, os.path.join(temp_dir, filename),
             uvs=uvs, vertex_colors=colors, texture_image=tex_img,
             normals=normals, unlit=getattr(mesh, "unlit", False))
    return _stable_temp_name(os.path.join(temp_dir, filename), ".glb")


def _string_to_model_ref(path: str) -> dict:
    """Resolve a bare path string to an /api/view ref.

    Widget-typed paths live under input, but Hy3DExportMesh and friends return paths
    relative to the OUTPUT dir — serve whichever actually exists. Defaulting to input
    keeps the historical behaviour.
    """
    path = path.replace("\\", "/")
    subfolder, _, name = path.rpartition("/")
    in_p = _safe_join(folder_paths.get_input_directory(), subfolder, name)
    out_p = _safe_join(folder_paths.get_output_directory(), subfolder, name)
    if in_p and os.path.isfile(in_p):
        ftype = "input"
    elif out_p and os.path.isfile(out_p):
        ftype = "output"
    elif in_p is None and out_p is None:
        raise ValueError("model_file must point inside the input or output folder")
    else:
        ftype = "input"  # not there (yet): historical default, the viewer reports the 404
    return {"filename": name, "type": ftype, "subfolder": subfolder}


def _trimesh_to_temp_glb(mesh) -> str:
    """Write a live TRIMESH to a temp .glb so the viewport can fetch it. Returns the filename.

    Vertex colours ride in `visual.vertex_attributes['color']`, and trimesh's own GLB exporter
    assumes VEC4 there. Generators overwhelmingly emit RGB, and that combination does not quietly
    degrade to a grey mesh — it RAISES (`cannot reshape array of size N into shape (4)`), which
    would surface as a failed node. Promote the array to RGBA for the duration of the export.

    Promoted in place and restored afterwards rather than on a copy: the mesh is the graph's
    object, shared with anything else wired to that output, so neither a dtype change nor a
    hundred-megabyte duplicate of a million-triangle mesh belongs here.
    """
    temp_dir = folder_paths.get_temp_directory()
    os.makedirs(temp_dir, exist_ok=True)
    filename = f"nkd_preview3d_{uuid.uuid4().hex}.glb"
    path = os.path.join(temp_dir, filename)

    attrs = getattr(getattr(mesh, "visual", None), "vertex_attributes", None)
    colour = attrs.get("color") if attrs else None
    promoted = colour is not None and np.asarray(colour).shape[-1] == 3
    if promoted:
        from trimesh.visual.color import to_rgba  # only reachable when a trimesh actually arrived
        attrs["color"] = to_rgba(np.asarray(colour))
    try:
        mesh.export(path, file_type="glb")
    finally:
        if promoted:
            attrs["color"] = colour
    return _stable_temp_name(path, ".glb")


def _outputs_are_consumed(prompt, unique_id) -> bool:
    """Whether any node in the prompt reads an output of node `unique_id`.

    A link serializes as [source_node_id, output_index]; ids arrive as strings from
    the client but may be compared against ints, so match on str.
    """
    if not prompt or unique_id is None:
        return False
    me = str(unique_id)
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        for value in (node.get("inputs") or {}).values():
            if isinstance(value, list) and len(value) == 2 and str(value[0]) == me:
                return True
    return False


class NKDPreview3D(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="NKDPreview3D",
            display_name="😺NKD Preview 3D",
            category="😺NKD Nodes/3D",
            description="3D viewport that exports its render. Place a model against a "
                        "background photo and a solved camera, then feed the resulting "
                        "image/mask/normal into the rest of the graph.",
            is_output_node=True,
            inputs=[
                io.MultiType.Input(
                    io.String.Input("model_file", default="", multiline=False),
                    types=[io.Mesh, TrimeshIO, io.File3DGLB, io.File3DGLTF, io.File3DAny,
                           io.File3DSplatAny, io.File3DPLY, io.File3DSPLAT, io.File3DSPZ,
                           io.File3DKSPLAT],
                    tooltip="A 3D model (GLB/GLTF), a MESH straight from a mesh-building node "
                            "(MoGe, DA3...), a TRIMESH (Hunyuan3D wrapper), a gaussian splat "
                            "(.ply/.spz/.splat/.ksplat) from an upstream node, or a path under "
                            "the input or output folder.",
                ),
                io.Load3DCamera.Input("camera_info", optional=True,
                                      tooltip="Solved camera, e.g. from 😺NKD fSpy Camera."),
                io.Image.Input("bg_image", optional=True,
                               tooltip="Backdrop photo, shown behind the model and composited "
                                       "into the exported image."),
                io.Load3DModelInfo.Input("model_3d_info", optional=True,
                                         tooltip="Position/rotation/scale to place the model."),
                io.Image.Input("scene_depth", optional=True,
                               tooltip="Depth of the backdrop photo (Depth Anything, Marigold...). "
                                       "Composited into the depth output as its base layer, so the "
                                       "model reads as sitting in the scene. Never clips the render. "
                                       "Must line up with bg_image."),
                io.Boolean.Input("scene_depth_invert", default=False,
                                 tooltip="On if your depth map reads far as white. This node's own "
                                         "depth output, and most disparity maps, read near as white.",
                                 advanced=True),
                io.Float.Input("scene_depth_near", default=1.0, min=0.01, max=1000.0, step=0.1,
                               tooltip="Scene distance the map's nearest value stands for. A depth "
                                       "map has no scale of its own, so these two numbers are what "
                                       "tie it to the 3D scene — tune them until the model sits at "
                                       "the right depth.",
                               advanced=True),
                io.Float.Input("scene_depth_far", default=30.0, min=0.02, max=10000.0, step=0.5,
                               tooltip="Scene distance the map's farthest value stands for.",
                               advanced=True),
                io.Combo.Input("scene_depth_space", options=["inverse (disparity)", "linear (metric)"],
                               default="inverse (disparity)", advanced=True,
                               tooltip="How the map's greys relate to distance. Monocular estimators "
                                       "(Depth Anything, MiDaS...) emit INVERSE depth: grey falls off "
                                       "fast near the camera, slowly far away. The object's exported "
                                       "grey follows the same curve, so its tone matches the scene's "
                                       "at the same distance. Pick linear only for metric z maps."),
                io.Int.Input("width", default=1024, min=1, max=8192, step=1),
                io.Int.Input("height", default=1024, min=1, max=8192, step=1),
                # Filled by the viewport at prompt time: JSON with the capture's temp paths.
                # NOT multiline: multiline creates a DOM textarea whose element survives the
                # frontend's hide-this-widget tricks and renders as a tall solid column below
                # the node. Single-line is a canvas widget — hidden means gone (same pattern
                # as Sigmas Curve's curve_data).
                io.String.Input("viewport", default="", socketless=True, multiline=False),
            ],
            outputs=[
                io.Image.Output(display_name="image",
                                tooltip="The full composite: model over the backdrop."),
                io.Image.Output(display_name="object",
                                tooltip="The model alone, RGBA with straight alpha, for compositing."),
                io.Mask.Output(display_name="mask",
                               tooltip="The model's silhouette, white — ready to drive an inpaint."),
                io.Image.Output(display_name="depth",
                                tooltip="Depth, near white to far black. The model's depth composited "
                                        "over the scene's depth map (when one is connected)."),
                io.Load3DCamera.Output(display_name="camera_info"),
                io.Mask.Output(display_name="paint_mask",
                               tooltip="The 3D mask you painted on the model, seen from this "
                                       "camera: white where an inpaint may touch. Pixel-aligned "
                                       "with `image`. Black when nothing is painted."),
                NKDMask3DType.Output(display_name="mask3d",
                                     tooltip="The same painted mask, whole, for 😺NKD Bake "
                                             "Projection: it then paints only inside it, "
                                             "whichever view the paint came from."),
            ],
            # unique_id targets this node's viewport; prompt tells whether anything reads
            # the outputs. Without declaring them here both read back None, silently.
            hidden=[io.Hidden.unique_id, io.Hidden.prompt],
        )

    @classmethod
    async def execute(cls, model_file, width, height, viewport="", **kwargs) -> io.NodeOutput:
        camera_info = kwargs.get("camera_info", None)
        bg_image = kwargs.get("bg_image", None)
        model_3d_info = kwargs.get("model_3d_info", None)

        # An upstream node hands over geometry in memory; save it where the browser can fetch it.
        if isinstance(model_file, Types.MESH):
            model_ref = {"filename": _mesh_to_temp_glb(model_file), "type": "temp", "subfolder": ""}
        elif isinstance(model_file, Types.File3D):
            filename = f"nkd_preview3d_{uuid.uuid4().hex}.{model_file.format}"
            written = os.path.join(folder_paths.get_temp_directory(), filename)
            model_file.save_to(written)
            model_ref = {"filename": _stable_temp_name(written, f".{model_file.format}"),
                         "type": "temp", "subfolder": ""}
        elif not isinstance(model_file, str) and hasattr(model_file, "export"):
            # TRIMESH (Hunyuan3D wrapper): a live trimesh.Trimesh, exported by its own writer.
            model_ref = {"filename": _trimesh_to_temp_glb(model_file),
                         "type": "temp", "subfolder": ""}
        elif model_file:
            model_ref = _string_to_model_ref(str(model_file))
        else:
            model_ref = None

        bg_ref = None
        if bg_image is not None:
            bg_ref = {"filename": _tensor_to_temp_png(bg_image, "nkd_bg"),
                      "type": "temp", "subfolder": ""}

        scene_depth = kwargs.get("scene_depth", None)
        depth_ref = None
        if scene_depth is not None:
            depth_ref = {"filename": _tensor_to_temp_png(scene_depth, "nkd_scene_depth"),
                         "type": "temp", "subfolder": ""}

        # The viewport cannot learn a linked width/height/camera on its own — it renders
        # before execution. Hand over what we actually ran with so it can catch up.
        fresh = await _fresh_capture({
            "node_id": str(cls.hidden.unique_id),
            "model": model_ref,
            "bg_image": bg_ref,
            "camera_info": camera_info,
            "model_3d_info": model_3d_info,
            "scene_depth": depth_ref,
            "scene_depth_invert": bool(kwargs.get("scene_depth_invert", False)),
            "scene_depth_near": float(kwargs.get("scene_depth_near", 1.0)),
            "scene_depth_far": float(kwargs.get("scene_depth_far", 30.0)),
            "scene_depth_inverse_space": str(kwargs.get("scene_depth_space", "inverse")).startswith("inverse"),
            "width": width,
            "height": height,
        })
        # The viewport just rendered THIS model; prefer that over the serialised
        # capture, which was taken before the model existed in the browser.
        if fresh:
            viewport = fresh

        capture = None
        if viewport:
            try:
                capture = json.loads(viewport)
            except (ValueError, TypeError):
                capture = None

        if not capture:
            if _outputs_are_consumed(cls.hidden.prompt, cls.hidden.unique_id):
                # Passing None on surfaces far downstream as an unreadable error, so say it here.
                raise RuntimeError(
                    "😺NKD Preview 3D has no render to export yet. The viewport captures when "
                    "the prompt is queued, so run it once with the model loaded. If this "
                    "persists, the viewport failed to initialise — check the browser console."
                )
            return io.NodeOutput(None, None, None, None, camera_info, None, None)

        load_image = nodes.LoadImage()
        output_image, _ = load_image.load_image(image=capture["image"])
        # One render gives both the isolated model and its silhouette. LoadImage hands back
        # RGB plus 1-alpha, so alpha is the subject — white, the way inpainting wants it.
        object_rgb, inverse_alpha = load_image.load_image(image=capture["object"])
        output_mask = 1.0 - inverse_alpha
        # Straight alpha (not premultiplied), matching NKD Perspective Rewarp.
        object_rgba = torch.cat([object_rgb[..., :3], output_mask.unsqueeze(-1)], dim=-1)
        # Already near-white / far-black: three's BasicDepthPacking emits 1.0 - z, and the
        # viewport clears to black so empty space sits at the far end. Nothing to flip.
        depth_image, _ = load_image.load_image(image=capture["depth"])
        # The painted 3D mask, if any. Absent means nothing painted: a black mask, no 3D mask.
        paint_mask = torch.zeros_like(output_mask)
        mask3d = None
        if capture.get("paint_mask"):
            pm, _ = load_image.load_image(image=capture["paint_mask"])
            paint_mask = pm[..., 0]
        m3 = capture.get("mask3d")
        if isinstance(m3, dict) and m3.get("image"):
            packed, _ = load_image.load_image(image=m3["image"])
            mask3d = _unpack_mask3d(packed, int(m3.get("count", 0)))
        # The viewport's live camera wins: the user may have orbited since the solve.
        return io.NodeOutput(output_image, object_rgba, output_mask, depth_image,
                             capture.get("camera_info") or camera_info, paint_mask, mask3d)


class NKDPreview3DExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [NKDPreview3D]


async def comfy_entrypoint() -> NKDPreview3DExtension:
    return NKDPreview3DExtension()


NODE_CLASS_MAPPINGS = {"NKDPreview3D": NKDPreview3D}
NODE_DISPLAY_NAME_MAPPINGS = {"NKDPreview3D": "😺NKD Preview 3D"}


def demo():
    """Self-check: the link-consumption probe decides whether a missing capture is fatal."""
    consumed = {
        "7": {"class_type": "PreviewImage", "inputs": {"images": ["3", 0]}},
        "3": {"class_type": "NKDPreview3D", "inputs": {"width": 1024}},
    }
    assert _outputs_are_consumed(consumed, "3") is True
    assert _outputs_are_consumed(consumed, 3) is True, "unique_id may arrive as an int"
    assert _outputs_are_consumed(consumed, "7") is False

    preview_only = {"3": {"class_type": "NKDPreview3D", "inputs": {"width": 1024}}}
    assert _outputs_are_consumed(preview_only, "3") is False, "previewing alone must not raise"

    assert _outputs_are_consumed(None, "3") is False
    assert _outputs_are_consumed({}, None) is False
    assert _outputs_are_consumed({"1": {"inputs": {"seed": 3}}}, "3") is False, "3 is a value, not a link"

    # A MESH arrives in memory; it only reaches the viewport if it becomes a real .glb.
    mesh = Types.MESH(
        vertices=torch.tensor([[[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]]]),
        faces=torch.tensor([[[0, 1, 2]]]),
        uvs=torch.tensor([[[0., 0.], [1., 0.], [0., 1.]]]),
        texture=torch.rand(1, 4, 4, 3),
    )
    path = os.path.join(folder_paths.get_temp_directory(), _mesh_to_temp_glb(mesh))
    with open(path, "rb") as f:
        assert f.read(4) == b"glTF", "the viewport loads it as a glTF binary"
    os.remove(path)

    # A bare string resolves against input first, then output (Hy3DExportMesh returns
    # output-relative paths like "3D/Hy3D_00005_.glb" — serving those as input 404s).
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        inp, outp = os.path.join(td, "in"), os.path.join(td, "out")
        os.makedirs(os.path.join(outp, "3D"))
        open(os.path.join(outp, "3D", "x.glb"), "wb").close()
        orig = folder_paths.get_input_directory, folder_paths.get_output_directory
        folder_paths.get_input_directory = lambda: inp
        folder_paths.get_output_directory = lambda: outp
        try:
            ref = _string_to_model_ref("3D\\x.glb")
            assert ref == {"filename": "x.glb", "type": "output", "subfolder": "3D"}
            os.makedirs(os.path.join(inp, "3D"))
            open(os.path.join(inp, "3D", "x.glb"), "wb").close()
            assert _string_to_model_ref("3D/x.glb")["type"] == "input", "input wins when both exist"
            assert _string_to_model_ref("nope.glb")["type"] == "input", "missing file keeps the old default"
        finally:
            folder_paths.get_input_directory, folder_paths.get_output_directory = orig

    # A TRIMESH carrying RGB vertex colours must come out as COLOR_0, not as an exception, and
    # the caller's mesh must be handed back exactly as it arrived — it is the graph's object.
    try:
        import trimesh
    except ImportError:
        print("  (trimesh not installed — skipping the TRIMESH colour check)")
    else:
        import struct
        verts = np.array([[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]])
        tm = trimesh.Trimesh(vertices=verts, faces=np.array([[0, 1, 2]]))
        rgb = np.array([[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]], dtype=np.float32)
        tm.visual = trimesh.visual.TextureVisuals(material=trimesh.visual.material.PBRMaterial())
        tm.visual.vertex_attributes["color"] = rgb

        path = os.path.join(folder_paths.get_temp_directory(), _trimesh_to_temp_glb(tm))
        with open(path, "rb") as f:
            blob = f.read()
        chunk = json.loads(blob[20:20 + struct.unpack("<I", blob[12:16])[0]])
        attrs = chunk["meshes"][0]["primitives"][0]["attributes"]
        assert "COLOR_0" in attrs, f"RGB vertex colours must survive the export, got {list(attrs)}"
        os.remove(path)

        kept = tm.visual.vertex_attributes["color"]
        assert kept.shape == rgb.shape and kept.dtype == rgb.dtype, \
            "the caller's mesh must be restored, not left promoted to RGBA"

    # The 3D mask rides as a grey image, one pixel per vertex, 1024 to a row. The last
    # row is padding; only `count` values are real.
    vals = torch.rand(2500)
    img = torch.zeros(1, 3, 1024, 3)
    img[0, ..., 0].reshape(-1)[:2500] = vals
    m3 = _unpack_mask3d(img, 2500)
    assert m3.count == 2500 and torch.allclose(m3.values, vals), "mask3d did not survive packing"
    try:
        _unpack_mask3d(img, 5000)
        raise AssertionError("a short image must not unpack to more vertices than it holds")
    except ValueError:
        pass

    # Content-addressed temp names: the viewport reloads whenever the ref changes, so
    # identical geometry has to keep the same name or it re-downloads every queue.
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        def write(data, tag):
            path = os.path.join(td, f"scratch_{tag}.glb")
            with open(path, "wb") as f:
                f.write(data)
            return _stable_temp_name(path, ".glb")

        a = write(b"glTF-same-bytes", "a")
        b = write(b"glTF-same-bytes", "b")
        c = write(b"glTF-other-bytes", "c")
        assert a == b, f"same bytes must give the same name: {a} vs {b}"
        assert a != c, "different bytes must not collide"
        assert os.path.isfile(os.path.join(td, a)), "the named file is missing"
        # The second write finds its target already there; it must clean up after
        # itself rather than leave the scratch file behind on every run.
        left = sorted(n for n in os.listdir(td) if n.startswith("scratch_"))
        assert left == [], f"temp scratch files were left behind: {left}"
        assert len(os.listdir(td)) == 2, f"expected exactly two named files: {os.listdir(td)}"

    # The capture hand-off crosses two event loops in two threads: ComfyUI runs the
    # graph under its own asyncio.run (execution.py) while aiohttp answers on the
    # server's loop. Reproduced with two real loops, because one loop hides it.
    #
    # The symptom is NOT a hang. A future resolved from the wrong loop schedules its
    # callbacks without waking that loop's selector, so the waiter sleeps until its
    # next timer fires, which is the wait_for timeout itself. That is why the node
    # took exactly 60 seconds and then fell back: the answer had arrived in
    # milliseconds and nobody was woken to read it. So measure the DELAY.
    import threading
    import time

    def _time_handoff(resolve, timeout):
        """Wait on a private loop in its own thread, like the executor does, and
        return how long the hand-off actually took."""
        ready, box, out = threading.Event(), {}, {}

        def run():
            async def main():
                loop = asyncio.get_running_loop()
                fut = loop.create_future()
                box["loop"], box["fut"] = loop, fut
                ready.set()
                t0 = time.perf_counter()
                try:
                    out["value"] = await asyncio.wait_for(fut, timeout)
                except asyncio.TimeoutError:
                    out["value"] = "TIMEOUT"
                out["elapsed"] = time.perf_counter() - t0
            asyncio.run(main())

        t = threading.Thread(target=run)
        t.start()
        ready.wait(5)

        async def server():
            await asyncio.sleep(0.05)      # let the waiter reach its await
            resolve(box["loop"], box["fut"])
        asyncio.run(server())
        t.join()
        return out

    fixed = _time_handoff(lambda loop, fut: _resolve_capture(loop, fut, "fresh"), 2.0)
    assert fixed["value"] == "fresh", f"the hand-off lost the capture: {fixed}"
    assert fixed["elapsed"] < 0.5, f"call_soon_threadsafe did not wake the waiter promptly: {fixed}"

    # CONTROL: set_result straight from the other loop. It must arrive LATE, or the
    # assertion above proves nothing about why call_soon_threadsafe is there.
    naive = _time_handoff(lambda loop, fut: fut.set_result("naive"), 1.0)
    assert naive["elapsed"] > 0.9,         f"control: a cross-loop set_result was expected to stall until the timeout, got {naive}"

    print("nkd_preview_3d demo OK")


if __name__ == "__main__":
    demo()
