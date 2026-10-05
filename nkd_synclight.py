"""😺NKD SyncLight — change the light in ONE view, get every view relit.

Wraps SyncLight (Serrano-Lozano et al., NeurIPS 2026, Apache-2.0): a
multi-view diffusion model (SDXL UNet with MVDream-style 3D attention,
Latent Bridge Matching) that relights a set of views of the same scene from a
single edit made on the reference view. No camera poses needed; trained on
pairs, it generalises to any number of views, so a handful of video frames
works as "views".

Three V3 nodes:
  NKDSyncLightLoader   weights (HF hub or models/synclight) -> NKD_SYNCLIGHT
  NKDSyncLightLightmap mask + on/off + intensity + colour   -> NKD_LIGHTMAP
                       (chain several to edit several lights)
  NKDSyncLightRelight  reference + other views + lightmap   -> relit IMAGE batch

Lightmap channels (H, W, 4), see synclight_core/NOTICE for provenance:
  0 activation  -1 turn the light off · 0 no change · 1 set it to 1..3
  1 intensity   L in [-1, 1], intensity = (L + 1) / 2
  2, 3 colour   CIELAB a/128, b/128
"""
from __future__ import annotations

import logging
import os

import numpy as np
import torch
from typing_extensions import override
from comfy_api.latest import ComfyExtension, io

import folder_paths
import comfy.model_management as mm

HF_REPO = "davidserra9/synclight"
_HF_LABEL = f"{HF_REPO} (Hugging Face)"
_SUBDIR = "synclight"
folder_paths.add_model_folder_path(_SUBDIR, os.path.join(folder_paths.models_dir, _SUBDIR))

SyncLightModel = io.Custom("NKD_SYNCLIGHT")
Lightmap = io.Custom("NKD_LIGHTMAP")

_log = logging.getLogger(__name__)


def _local_models():
    """Sub-folders of models/synclight that hold a .yaml and a weights file."""
    found = []
    for root in folder_paths.get_folder_paths(_SUBDIR):
        if not os.path.isdir(root):
            continue
        for name in sorted(os.listdir(root)):
            d = os.path.join(root, name)
            if os.path.isdir(d):
                files = os.listdir(d)
                if any(f.endswith(".yaml") for f in files) and any(
                        f.endswith((".safetensors", ".ckpt")) for f in files):
                    found.append(name)
    return found


def _resolve_model(choice):
    if choice == _HF_LABEL:
        return HF_REPO
    for root in folder_paths.get_folder_paths(_SUBDIR):
        d = os.path.join(root, choice)
        if os.path.isdir(d):
            return d
    raise FileNotFoundError(f"SyncLight weights folder '{choice}' not found in models/{_SUBDIR}")


def _srgb_to_lab(rgb):
    """rgb: 3 floats 0..1 (sRGB, D65) -> (L, a, b)."""
    c = np.asarray(rgb, dtype=np.float64)
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    m = np.array([[0.4124564, 0.3575761, 0.1804375],
                  [0.2126729, 0.7151522, 0.0721750],
                  [0.0193339, 0.1191920, 0.9503041]])
    xyz = (m @ lin) / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 216 / 24389, np.cbrt(xyz), (24389 / 27 * xyz + 16) / 116)
    return 116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])


def _parse_hex(s):
    s = s.strip().lstrip("#")
    if len(s) == 3:
        s = "".join(ch * 2 for ch in s)
    try:
        return [int(s[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    except ValueError:
        return [1.0, 1.0, 1.0]


class NKDSyncLightLoader(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="NKDSyncLightLoader",
            display_name="😺NKD SyncLight Loader",
            category="😺NKD Nodes/Light",
            description="Loads SyncLight. Weights come from the Hugging Face hub "
                        "(downloaded once, cached) or from a folder in models/synclight "
                        "holding the .yaml and .safetensors. The SDXL VAE is fetched "
                        "from stabilityai/stable-diffusion-xl-base-1.0 the first time.",
            inputs=[
                io.Combo.Input("weights", options=[_HF_LABEL] + _local_models(),
                               default=_HF_LABEL,
                               tooltip="Hugging Face repo, or a folder under models/synclight."),
                io.Combo.Input("precision", options=["bfloat16", "float32"], default="bfloat16",
                               tooltip="bfloat16 is what the model was released for. "
                                       "float32 doubles the memory."),
            ],
            outputs=[SyncLightModel.Output(display_name="model")],
        )

    @classmethod
    def execute(cls, weights, precision) -> io.NodeOutput:
        try:
            from .synclight_core.loader import get_model
        except ImportError as e:
            raise RuntimeError(
                "NKD SyncLight needs `diffusers`, `einops`, `pyyaml`, `huggingface_hub` and "
                f"`pydantic` in ComfyUI's Python environment ({e}). "
                "Install with: pip install diffusers einops pyyaml huggingface_hub pydantic") from e
        dtype = torch.bfloat16 if precision == "bfloat16" else torch.float32
        # loaded on the CPU; the relight node moves it to the GPU while it runs
        model = get_model(_resolve_model(weights), torch_dtype=dtype, device="cpu")
        return io.NodeOutput(model)


class NKDSyncLightLightmap(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="NKDSyncLightLightmap",
            display_name="😺NKD SyncLight Lightmap",
            category="😺NKD Nodes/Light",
            description="Describes the light edit on the reference view: where the light "
                        "is (mask), whether it goes on or off, how strong and what colour. "
                        "Chain the `lightmap` output into `previous` to edit several lights.",
            inputs=[
                io.Mask.Input("mask", tooltip="Where the light source is in the REFERENCE view "
                                              "(the lamp, the window…), not the area it lights."),
                io.Combo.Input("action", options=["turn on / set", "turn off"], default="turn on / set"),
                io.Float.Input("intensity", default=0.8, min=0.0, max=1.0, step=0.01,
                               tooltip="Target brightness of the light. Ignored when turning off."),
                io.String.Input("color", default="#ffffff",
                                tooltip="Light colour as hex. Only its hue/saturation counts; "
                                        "brightness is the intensity slider. Ignored when turning off."),
                Lightmap.Input("previous", optional=True,
                               tooltip="Lightmap to add this light to. Where both touch a pixel, "
                                       "this node wins."),
            ],
            outputs=[Lightmap.Output(display_name="lightmap")],
        )

    @classmethod
    def execute(cls, mask, action, intensity, color, previous=None) -> io.NodeOutput:
        m = mask if mask.dim() == 3 else mask.unsqueeze(0)
        m = (m[0].float().cpu().numpy() > 0.5)
        h, w = m.shape
        if previous is not None:
            lm = previous.copy()
            if lm.shape[:2] != (h, w):
                import torch.nn.functional as F
                t = torch.from_numpy(lm).permute(2, 0, 1).unsqueeze(0)
                lm = F.interpolate(t, size=(h, w), mode="nearest")[0].permute(1, 2, 0).numpy().copy()
        else:
            lm = np.zeros((h, w, 4), dtype=np.float32)

        if action == "turn off":
            lm[m] = np.array([-1, 0, 0, 0], dtype=np.float32)
        else:
            _, a, b = _srgb_to_lab(_parse_hex(color))
            lm[m] = np.array([1.0, 2.0 * intensity - 1.0,
                              np.clip(a / 128.0, -1, 1), np.clip(b / 128.0, -1, 1)],
                             dtype=np.float32)
        return io.NodeOutput(lm)


class NKDSyncLightRelight(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="NKDSyncLightRelight",
            display_name="😺NKD SyncLight Relight",
            category="😺NKD Nodes/Light",
            description="Applies the lightmap edit made on `reference` to the reference and "
                        "to every extra view of the same static scene, consistently, in one "
                        "pass. The output batch is [reference, views…] in that order.",
            inputs=[
                SyncLightModel.Input("model"),
                io.Image.Input("reference", tooltip="The view the lightmap was drawn on "
                                                    "(first image of this batch is used)."),
                Lightmap.Input("lightmap"),
                io.Image.Input("views", optional=True,
                               tooltip="Other views of the same static scene (batch). "
                                       "For video: the next frames. All views are processed together, "
                                       "so memory grows with their number."),
                io.Int.Input("steps", default=1, min=1, max=8,
                             tooltip="1 is what the authors recommend."),
                io.Boolean.Input("offload", default=True,
                                 tooltip="Move the model back to the CPU after running to free VRAM."),
            ],
            outputs=[io.Image.Output(display_name="images")],
        )

    @classmethod
    def execute(cls, model, reference, lightmap, steps, offload, views=None) -> io.NodeOutput:
        from .synclight_core.runner import relight

        ref = reference[:1]
        if views is not None:
            if views.shape[0] and views.shape[-1] != ref.shape[-1]:
                raise ValueError("reference and views must have the same channel count")
            imgs = torch.cat([ref, views[..., :3]], dim=0)
        else:
            imgs = ref
        imgs = imgs[..., :3]

        device = mm.get_torch_device()
        mm.unload_all_models()
        mm.soft_empty_cache()
        model.to(device)
        try:
            out = relight(model, imgs, lightmap, steps=steps)
        finally:
            if offload:
                model.to("cpu")
                mm.soft_empty_cache()
        return io.NodeOutput(out)


class NKDSyncLightExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [NKDSyncLightLoader, NKDSyncLightLightmap, NKDSyncLightRelight]


async def comfy_entrypoint() -> NKDSyncLightExtension:
    return NKDSyncLightExtension()


NODE_CLASS_MAPPINGS = {
    "NKDSyncLightLoader": NKDSyncLightLoader,
    "NKDSyncLightLightmap": NKDSyncLightLightmap,
    "NKDSyncLightRelight": NKDSyncLightRelight,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "NKDSyncLightLoader": "😺NKD SyncLight Loader",
    "NKDSyncLightLightmap": "😺NKD SyncLight Lightmap",
    "NKDSyncLightRelight": "😺NKD SyncLight Relight",
}
