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

import json
import os
import uuid

import numpy as np
import torch
from PIL import Image as PILImage
from typing_extensions import override

import folder_paths
import nodes
from comfy_api.latest import ComfyExtension, Types, io
from server import PromptServer

# Pushed to the widget on execute; the JS listens for this event.
_EVENT_SCENE = "nkd-preview3d-scene"


def _tensor_to_temp_png(image, prefix: str) -> str:
    """Write an IMAGE tensor's first frame to the temp dir. Returns an annotated path."""
    array = (image[0].cpu().numpy() * 255).astype(np.uint8)
    temp_dir = folder_paths.get_temp_directory()
    os.makedirs(temp_dir, exist_ok=True)  # may not exist yet, or have been cleaned
    filename = f"{prefix}_{uuid.uuid4().hex}.png"
    PILImage.fromarray(array).save(os.path.join(temp_dir, filename), compress_level=1)
    return filename


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
                    types=[io.File3DGLB, io.File3DGLTF, io.File3DAny, io.File3DSplatAny,
                           io.File3DPLY, io.File3DSPLAT, io.File3DSPZ, io.File3DKSPLAT],
                    tooltip="A 3D model (GLB/GLTF) or gaussian splat (.ply/.spz/.splat/.ksplat) "
                            "from an upstream node, or a path under the input folder.",
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
            ],
            # unique_id targets this node's viewport; prompt tells whether anything reads
            # the outputs. Without declaring them here both read back None, silently.
            hidden=[io.Hidden.unique_id, io.Hidden.prompt],
        )

    @classmethod
    def execute(cls, model_file, width, height, viewport="", **kwargs) -> io.NodeOutput:
        camera_info = kwargs.get("camera_info", None)
        bg_image = kwargs.get("bg_image", None)
        model_3d_info = kwargs.get("model_3d_info", None)

        # An upstream node hands over a File3D; save it where the browser can fetch it.
        if isinstance(model_file, Types.File3D):
            filename = f"nkd_preview3d_{uuid.uuid4().hex}.{model_file.format}"
            model_file.save_to(os.path.join(folder_paths.get_temp_directory(), filename))
            model_ref = {"filename": filename, "type": "temp", "subfolder": ""}
        elif model_file:
            path = str(model_file).replace("\\", "/")
            subfolder, _, name = path.rpartition("/")
            model_ref = {"filename": name, "type": "input", "subfolder": subfolder}
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
        PromptServer.instance.send_sync(_EVENT_SCENE, {
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
            return io.NodeOutput(None, None, None, None, camera_info)

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
        # The viewport's live camera wins: the user may have orbited since the solve.
        return io.NodeOutput(output_image, object_rgba, output_mask, depth_image,
                             capture.get("camera_info") or camera_info)


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
    print("nkd_preview_3d demo OK")


if __name__ == "__main__":
    demo()
