"""😺NKD Perspective Unwarp / Rewarp — corner-pin perspective dewarp.

Unwarp flattens a four-corner quad of the image to a fronto-parallel 2D image
and emits an NKD_WARPDATA cable carrying the homography. Rewarp inverts it and
composites the edited flat image back into the original, feathered at the quad
edge. The warp uses torch grid_sample — no cv2 in the core path (cv2 stays
optional, only for seamless_edges via the copied _post_blend).
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Tuple

import numpy as np
import torch
import torch.nn.functional as F

# Relative import when loaded as a ComfyUI package; absolute fallback for the
# standalone test runner (which puts the pack dir on sys.path).
try:
    from .nkd_vfx_helpers import (
        _alpha_hardness,
        _HAS_CV2,
        _mask_grow,
        _megapixels_to_pixels,
        _post_blend,
        _resize_auto,
    )
except ImportError:  # pragma: no cover - standalone test path
    from nkd_vfx_helpers import (
        _alpha_hardness,
        _HAS_CV2,
        _mask_grow,
        _megapixels_to_pixels,
        _post_blend,
        _resize_auto,
    )

# comfy_api only exists inside ComfyUI. The pure geometry/pipeline functions
# below must import standalone (for tests), so the node classes + comfytype that
# depend on comfy_api are guarded behind _HAS_COMFY at the bottom of the module.
try:
    from typing_extensions import override
    from comfy_api.latest import ComfyExtension, io, ui
    from comfy_api.latest._io import comfytype, ComfyTypeIO
    _HAS_COMFY = True
except ImportError:  # pragma: no cover - standalone test path
    _HAS_COMFY = False


def _homography(src, dst) -> np.ndarray:
    """3x3 homography H mapping src[i] -> dst[i] for four 2D correspondences.
    Solved as the null-space of the 8x9 DLT system (SVD). Normalised so H[2,2]=1."""
    src = np.asarray(src, dtype=np.float64)
    dst = np.asarray(dst, dtype=np.float64)
    A = []
    for (x, y), (u, v) in zip(src, dst):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y, -u])
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y, -v])
    A = np.asarray(A, dtype=np.float64)
    _, _, Vt = np.linalg.svd(A)
    H = Vt[-1].reshape(3, 3)
    return H / H[2, 2]


def _warp_image(image: torch.Tensor, H_out_to_in: np.ndarray, out_h: int, out_w: int):
    """Sample `image` [B,H,W,C] into an out_h x out_w frame using a homography
    that maps OUTPUT pixel coords -> INPUT pixel coords. Returns
    (warped [B,out_h,out_w,C], mask [B,out_h,out_w]) where mask=1 for output
    pixels whose source landed inside the input image rectangle."""
    b, in_h, in_w, c = image.shape
    device = image.device
    H = torch.as_tensor(H_out_to_in, dtype=torch.float32, device=device)

    ys, xs = torch.meshgrid(
        torch.arange(out_h, device=device, dtype=torch.float32),
        torch.arange(out_w, device=device, dtype=torch.float32),
        indexing="ij",
    )
    ones = torch.ones_like(xs)
    P = torch.stack([xs + 0.5, ys + 0.5, ones], dim=-1)      # output pixel centres [oh,ow,3]
    src = P @ H.T                                            # [oh,ow,3]
    sx = src[..., 0] / src[..., 2]
    sy = src[..., 1] / src[..., 2]

    # align_corners=False normalisation: continuous pixel s -> (s/dim)*2 - 1
    gx = (sx / in_w) * 2.0 - 1.0
    gy = (sy / in_h) * 2.0 - 1.0
    grid = torch.stack([gx, gy], dim=-1).unsqueeze(0).expand(b, -1, -1, -1)

    x = image.permute(0, 3, 1, 2)                            # [B,C,H,W]
    # Bicubic keeps warped edges crisp when the quad is larger than the working
    # image (the common upscale on rewarp); bilinear reads soft/blocky there.
    # Bicubic can overshoot, so clamp back to valid pixel range.
    warped = F.grid_sample(x, grid, mode="bicubic",
                           padding_mode="zeros", align_corners=False)
    warped = warped.permute(0, 2, 3, 1).clamp(0.0, 1.0)      # [B,oh,ow,C]

    inside = ((sx >= 0) & (sx <= in_w) & (sy >= 0) & (sy <= in_h)).float()
    mask = inside.unsqueeze(0).expand(b, -1, -1).contiguous()
    return warped, mask


def _aspect_auto(quad: np.ndarray) -> float:
    """Estimate width/height from mean opposite-edge lengths. quad = [TL,TR,BR,BL]."""
    tl, tr, br, bl = quad
    w = (np.linalg.norm(tr - tl) + np.linalg.norm(br - bl)) / 2.0
    h = (np.linalg.norm(bl - tl) + np.linalg.norm(br - tr)) / 2.0
    return float(w / max(h, 1e-6))


def _aspect_metric(quad: np.ndarray, focal_px: float, cx: float, cy: float) -> float:
    """True width/height of a real-world rectangle from its 4 image corners and
    camera intrinsics (Zhang & He single-view rectification). quad=[TL,TR,BR,BL].
    K = [[f,0,cx],[0,f,cy],[0,0,1]]."""
    # Zhang & He label corners row-major (m1,m2 top; m3,m4 bottom) = TL,TR,BL,BR.
    # Our pack convention is [TL,TR,BR,BL], so map m3<-BL (quad[3]), m4<-BR (quad[2]).
    tl, tr, br, bl = quad
    m1, m2, m3, m4 = (np.array([p[0], p[1], 1.0]) for p in (tl, tr, bl, br))
    k2 = np.dot(np.cross(m1, m4), m3) / np.dot(np.cross(m2, m4), m3)
    k3 = np.dot(np.cross(m1, m4), m2) / np.dot(np.cross(m3, m4), m2)
    n2 = k2 * m2 - m1
    n3 = k3 * m3 - m1
    K = np.array([[focal_px, 0.0, cx], [0.0, focal_px, cy], [0.0, 0.0, 1.0]])
    Kinv = np.linalg.inv(K)
    W = Kinv.T @ Kinv
    num = float(n2 @ W @ n2)
    den = float(n3 @ W @ n3)
    if den <= 1e-12 or num <= 0.0:
        return _aspect_auto(quad)                       # degenerate -> fall back
    return float(np.sqrt(num / den))


def _output_size(aspect: float, resolution_mode: str, longest_side: int,
                 megapixels: float) -> Tuple[int, int]:
    """Return (out_w, out_h) ints for the flattened image from the resolved
    aspect (w/h) and the chosen resolution control."""
    aspect = max(aspect, 1e-3)
    if resolution_mode == "Megapixels":
        total = max(1.0, _megapixels_to_pixels(megapixels))
        h = (total / aspect) ** 0.5
        w = h * aspect
    else:  # Longest Side
        if aspect >= 1.0:
            w = float(longest_side)
            h = w / aspect
        else:
            h = float(longest_side)
            w = h * aspect
    return max(16, int(round(w))), max(16, int(round(h)))


# Inset default quad (relative); consumed by the node's widget default.
_DEFAULT_STATE = {"corners": [[0.15, 0.15], [0.85, 0.2], [0.8, 0.85], [0.2, 0.8]]}


def _quad_area(quad: np.ndarray) -> float:
    """Absolute shoelace area of the 4-point polygon."""
    x, y = quad[:, 0], quad[:, 1]
    return 0.5 * abs(float((x * np.roll(y, -1) - np.roll(x, -1) * y).sum()))


def _parse_corners(state_json: str, width: int, height: int):
    """Parse the widget's JSON into a pixel-space quad [TL,TR,BR,BL].
    Returns (quad[4,2] float64, ok). On bad/degenerate input, returns the
    full-image quad and ok=False (caller warns and proceeds)."""
    full = np.array([[0, 0], [width, 0], [width, height], [0, height]], dtype=np.float64)
    try:
        pts = json.loads(state_json)["corners"]
        quad = np.array([[float(p[0]) * width, float(p[1]) * height] for p in pts],
                        dtype=np.float64)
        if quad.shape != (4, 2):
            return full, False
    except (ValueError, TypeError, KeyError, IndexError):
        return full, False
    # Degenerate: near-zero area (collinear/zero) -> reject.
    if _quad_area(quad) < 0.01 * width * height:
        return full, False
    return quad, True


@dataclass
class NKDWarpData:
    background: torch.Tensor        # [B,H,W,C] original image, CPU
    H_flat_to_orig: np.ndarray      # 3x3 homography flat px -> orig px
    quad: np.ndarray                # [4,2] corners in orig px, TL,TR,BR,BL
    original_size: Tuple[int, int]  # (H, W)
    output_size: Tuple[int, int]    # (out_w, out_h)


def _unwarp_pipeline(image, corners_json, aspect_source, focal_length_mm,
                     manual_ratio_w, manual_ratio_h, resolution_mode,
                     longest_side, megapixels):
    """Core Unwarp logic, ComfyUI-independent. Returns (flat_image, NKDWarpData)."""
    _, ih, iw, _ = image.shape
    quad, ok = _parse_corners(corners_json, iw, ih)
    if not ok:
        logging.warning("NKD Perspective Unwarp: invalid/degenerate corners — "
                        "using the full image.")

    if aspect_source == "Manual":
        aspect = float(manual_ratio_w) / max(float(manual_ratio_h), 1e-6)
    elif aspect_source == "Metric":
        if focal_length_mm and focal_length_mm > 0.0:
            focal_px = float(focal_length_mm) / 36.0 * iw     # 35mm-equiv horizontal
            aspect = _aspect_metric(quad, focal_px, iw / 2.0, ih / 2.0)
        else:
            logging.warning("NKD Perspective Unwarp: Metric aspect needs a focal "
                            "length — falling back to Auto.")
            aspect = _aspect_auto(quad)
    else:  # Auto
        aspect = _aspect_auto(quad)

    out_w, out_h = _output_size(aspect, resolution_mode, longest_side, megapixels)
    flat_src = np.array([[0, 0], [out_w, 0], [out_w, out_h], [0, out_h]],
                        dtype=np.float64)
    H_flat_to_orig = _homography(flat_src, quad)
    flat, _ = _warp_image(image, H_flat_to_orig, out_h, out_w)

    data = NKDWarpData(
        background=image.cpu(),
        H_flat_to_orig=H_flat_to_orig,
        quad=quad,
        original_size=(ih, iw),
        output_size=(out_w, out_h),
    )
    return flat, data


def _rewarp_pipeline(flat_image, data: "NKDWarpData", feather, edge_hardness,
                     match_colors, seamless_edges, transparent_bg=False):
    """Core Rewarp logic. Warp the edited flat image back into the original frame
    through the inverse homography and composite, feathered at the quad edge.
    Returns (image, mask). With transparent_bg the image is RGBA — the warped
    element on a transparent background (no compositing, no post blend)."""
    ih, iw = data.original_size
    device = flat_image.device
    # The edit may have been resized (sampler snaps to /8, an upscaler, etc.).
    # The homography is defined in the flat frame's native dims, so restore them.
    out_w, out_h = data.output_size
    if flat_image.shape[1] != out_h or flat_image.shape[2] != out_w:
        flat_image = _resize_auto(flat_image, out_w, out_h)
    bg = data.background.to(device)
    # Batch align: one background repeated to match a batched edit.
    if bg.shape[0] == 1 and flat_image.shape[0] > 1:
        bg = bg.repeat(flat_image.shape[0], 1, 1, 1)

    H_orig_to_flat = np.linalg.inv(data.H_flat_to_orig)
    warped, mask = _warp_image(flat_image, H_orig_to_flat, ih, iw)   # into orig frame

    if feather > 0:
        f = int(feather)
        # Feather INWARD only: recede the quad edge by f, blur, then clamp back to
        # the quad. A symmetric feather spreads alpha past the quad into the
        # zero-padded (black) area outside it, which blends into the background as a
        # dark halo ("shadow"). Keeping the ramp inside the quad avoids that.
        receded = 1.0 - _mask_grow(1.0 - mask, f, 0)
        mask = _mask_grow(receded, 0, f) * mask
    mask = _alpha_hardness(mask, float(edge_hardness))
    alpha = mask.unsqueeze(-1)

    if transparent_bg:
        # The warped element on transparency (straight alpha) for external comp —
        # no background, so match_colors / seamless (which blend against it) don't apply.
        out = torch.cat([warped[..., :3], alpha], dim=-1)
        return out, mask

    out = warped[..., :3] * alpha + bg[..., :3] * (1.0 - alpha)

    if seamless_edges and not _HAS_CV2:
        logging.warning("NKD Perspective Rewarp: seamless_edges needs OpenCV "
                        "(pip install opencv-python) — skipping.")
        seamless_edges = False
    if match_colors > 0.0 or seamless_edges:
        out = _post_blend(bg, out, mask, float(match_colors), bool(seamless_edges))
    return out, mask


# --- ComfyUI node classes (require comfy_api; skipped in the standalone tests) ---
if _HAS_COMFY:

    @comfytype(io_type="NKD_WARPDATA")
    class NKDWarpDataType(ComfyTypeIO):
        Type = NKDWarpData

    class NKDPerspectiveUnwarp(io.ComfyNode):
        @classmethod
        def define_schema(cls) -> io.Schema:
            return io.Schema(
                node_id="NKDPerspectiveUnwarp",
                display_name="😺NKD Perspective Unwarp",
                category="😺NKD Nodes/3D",
                description=(
                    "Flatten a four-corner perspective region to a fronto-parallel 2D "
                    "image you can paint or inpaint. Drag the corners on the node, then "
                    "connect warp_data to 😺NKD Perspective Rewarp to put the edit back."
                ),
                is_output_node=True,
                inputs=[
                    io.Image.Input("image"),
                    # multiline=False on purpose: the JS widget hides this input and
                    # drives it from the on-image corner editor. A multiline String is a
                    # real DOM textarea that survives type='hidden'/computeSize and paints
                    # as a giant column below the node; single-line is a canvas widget that
                    # actually disappears when hidden.
                    io.String.Input("corners", default=json.dumps(_DEFAULT_STATE),
                                    socketless=True, multiline=False),
                    io.Combo.Input("aspect_source",
                                   options=["Auto", "Metric", "Manual"], default="Auto",
                                   display_name="Aspect Source",
                                   tooltip="Auto: estimate from the quad edges. Metric: true "
                                           "aspect from a connected focal length (fSpy). "
                                           "Manual: use the ratio below."),
                    io.Float.Input("focal_length_mm", optional=True, default=35.0,
                                   min=0.0, max=1000.0, step=0.1,
                                   display_name="Focal Length (mm)",
                                   tooltip="35mm-equivalent focal length for Metric mode "
                                           "(defaults to a 35mm lens). Wire this from "
                                           "😺NKD fSpy Camera's focal output for a real solve. "
                                           "0 falls back to Auto."),
                    io.Float.Input("manual_ratio_w", default=1.0, min=0.01, max=100.0,
                                   step=0.01, display_name="Manual Ratio W"),
                    io.Float.Input("manual_ratio_h", default=1.0, min=0.01, max=100.0,
                                   step=0.01, display_name="Manual Ratio H"),
                    io.Combo.Input("resolution_mode",
                                   options=["Longest Side", "Megapixels"],
                                   default="Longest Side", display_name="Resolution Mode"),
                    io.Int.Input("longest_side", default=1024, min=16, max=8192, step=16,
                                 display_name="Longest Side"),
                    io.Float.Input("megapixels", default=1.0, min=0.05, max=16.0, step=0.05,
                                   display_name="Megapixels"),
                ],
                outputs=[
                    io.Image.Output(display_name="image",
                                    tooltip="The flattened, fronto-parallel region."),
                    NKDWarpDataType.Output("warp_data",
                                           tooltip="Connect to 😺NKD Perspective Rewarp."),
                ],
            )

        @classmethod
        def execute(cls, image, corners, aspect_source, manual_ratio_w, manual_ratio_h,
                    resolution_mode, longest_side, megapixels,
                    focal_length_mm=35.0) -> io.NodeOutput:
            flat, data = _unwarp_pipeline(
                image, corners, aspect_source, focal_length_mm, manual_ratio_w,
                manual_ratio_h, resolution_mode, longest_side, megapixels)
            return io.NodeOutput(flat, data, ui=ui.PreviewImage(flat, cls=cls))

    class NKDPerspectiveRewarp(io.ComfyNode):
        @classmethod
        def define_schema(cls) -> io.Schema:
            return io.Schema(
                node_id="NKDPerspectiveRewarp",
                display_name="😺NKD Perspective Rewarp",
                category="😺NKD Nodes/3D",
                description=(
                    "Composite an edited flattened image back into the original photo "
                    "at its quad, feathered at the edge. Pair with 😺NKD Perspective "
                    "Unwarp via warp_data."
                ),
                inputs=[
                    io.Image.Input("image", tooltip="The edited flattened image."),
                    NKDWarpDataType.Input("warp_data"),
                    io.Int.Input("feather", default=8, min=0, max=256,
                                 display_name="Feather",
                                 tooltip="Soften the quad edge, in pixels."),
                    io.Float.Input("edge_hardness", default=0.0, min=0.0, max=1.0, step=0.05,
                                   display_name="Edge Hardness",
                                   tooltip="Firm the blend edge to stop the original from "
                                           "ghosting through as a halo."),
                    io.Float.Input("match_colors", default=0.0, min=0.0, max=1.0, step=0.05,
                                   display_name="Match Colors",
                                   tooltip="Pull the edit's colors back toward the original."),
                    io.Boolean.Input("seamless_edges", default=False,
                                     display_name="Seamless Edges",
                                     tooltip="Extra seam-erase pass. Requires OpenCV."),
                    io.Boolean.Input("transparent_bg", default=False,
                                     display_name="Transparent Background",
                                     tooltip="Output the warped element on transparency (RGBA) "
                                             "instead of compositing it onto the original — for "
                                             "external compositing. Skips Match Colors / "
                                             "Seamless Edges (they blend against the background)."),
                ],
                outputs=[
                    io.Image.Output(display_name="image",
                                    tooltip="Original photo with the edited region warped back, "
                                            "or the element on transparency (RGBA) if "
                                            "Transparent Background is on."),
                    io.Mask.Output(display_name="mask",
                                   tooltip="The quad's alpha (feathered), for compositing."),
                ],
            )

        @classmethod
        def execute(cls, image, warp_data, feather, edge_hardness, match_colors,
                    seamless_edges, transparent_bg=False) -> io.NodeOutput:
            out, mask = _rewarp_pipeline(image, warp_data, feather, edge_hardness,
                                         match_colors, seamless_edges, transparent_bg)
            return io.NodeOutput(out, mask)

    class NKDPerspectiveDewarpExtension(ComfyExtension):
        @override
        async def get_node_list(self) -> list[type[io.ComfyNode]]:
            return [NKDPerspectiveUnwarp, NKDPerspectiveRewarp]

    async def comfy_entrypoint() -> NKDPerspectiveDewarpExtension:
        return NKDPerspectiveDewarpExtension()

    NODE_CLASS_MAPPINGS = {
        "NKDPerspectiveUnwarp": NKDPerspectiveUnwarp,
        "NKDPerspectiveRewarp": NKDPerspectiveRewarp,
    }
    NODE_DISPLAY_NAME_MAPPINGS = {
        "NKDPerspectiveUnwarp": "😺NKD Perspective Unwarp",
        "NKDPerspectiveRewarp": "😺NKD Perspective Rewarp",
    }
