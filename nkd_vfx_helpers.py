"""Shared pure helpers for NKD VFX Tools.

Self-contained mask/resize/blend utilities used by the perspective dewarp nodes,
kept here so the pack has no external imports beyond numpy/torch.
"""
from typing import Optional, Tuple
import numpy as np
import torch
import torch.nn.functional as F


def _probe(module_name: str) -> bool:
    import importlib.util
    return importlib.util.find_spec(module_name) is not None


_HAS_CV2 = _probe("cv2")


# ---------------------------------------------------------------------------
# Image / mask resize
# ---------------------------------------------------------------------------

def _resize(image: torch.Tensor, width: int, height: int, mode: str = "bilinear") -> torch.Tensor:
    if image.shape[1] == height and image.shape[2] == width:
        return image
    x = image.permute(0, 3, 1, 2)
    # `area` does not accept align_corners; bicubic/bilinear do.
    if mode == "area":
        x = F.interpolate(x, size=(height, width), mode="area")
    else:
        x = F.interpolate(x, size=(height, width), mode=mode, align_corners=False)
    if mode == "bicubic":
        x = x.clamp(0.0, 1.0)
    return x.permute(0, 2, 3, 1)


def _resize_auto(image: torch.Tensor, width: int, height: int) -> torch.Tensor:
    """Pick the right filter based on direction: area for downscale, bicubic for upscale."""
    if image.shape[1] == height and image.shape[2] == width:
        return image
    src_pixels = image.shape[1] * image.shape[2]
    dst_pixels = height * width
    if dst_pixels < src_pixels:
        return _resize(image, width, height, mode="area")
    return _resize(image, width, height, mode="bicubic")


def _resize_mask(mask: torch.Tensor, width: int, height: int) -> torch.Tensor:
    if mask.dim() == 2:
        mask = mask.unsqueeze(0)
    if mask.shape[1] == height and mask.shape[2] == width:
        return mask
    x = mask.unsqueeze(1).float()
    x = F.interpolate(x, size=(height, width), mode="bilinear", align_corners=False)
    return x.squeeze(1)


# ---------------------------------------------------------------------------
# MaskGrow — morphological dilation + blur on mask edges
# ---------------------------------------------------------------------------

def _mask_grow(mask: torch.Tensor, expand: int, blur: int) -> torch.Tensor:
    if mask.dim() == 2:
        mask = mask.unsqueeze(0)
    if expand <= 0 and blur <= 0:
        return mask.float()

    # ComfyUI hands masks over on CPU; morphology + separable blur at native
    # resolution there takes seconds on large images. Hop to the GPU for the
    # heavy passes and return on the original device.
    orig_device = mask.device
    work_device = orig_device
    if orig_device.type == "cpu" and torch.cuda.is_available():
        work_device = torch.device("cuda")

    m = mask.to(work_device).unsqueeze(1).float()

    if expand > 0:
        # Chunked max-pool dilation: ~log(expand) passes instead of `expand`
        # iterations of a 3×3 kernel. Square structuring element either way.
        remaining = expand
        for k in (32, 8, 2, 1):
            while remaining >= k:
                m = F.pad(m, (k, k, k, k), mode="replicate")
                m = F.max_pool2d(m, kernel_size=2 * k + 1, stride=1, padding=0)
                remaining -= k
        m = m.clamp(0.0, 1.0)

    if blur > 0:
        # Box blur ×3 passes per axis approximates a gaussian, separable and fast.
        k = blur | 1
        pad = k // 2
        box = torch.ones(1, 1, 1, k, device=m.device, dtype=m.dtype) / k
        for _ in range(3):
            m = F.pad(m, (pad, pad, 0, 0), mode="replicate")
            m = F.conv2d(m, box, padding=0)
        box_v = box.transpose(2, 3)
        for _ in range(3):
            m = F.pad(m, (0, 0, pad, pad), mode="replicate")
            m = F.conv2d(m, box_v, padding=0)
        m = m.clamp(0.0, 1.0)

    return m.squeeze(1).to(orig_device)


# ---------------------------------------------------------------------------
# Resolution helpers
# ---------------------------------------------------------------------------

def _megapixels_to_pixels(value) -> int:
    return int(float(value) * 1_048_576)


def _alpha_hardness(alpha: torch.Tensor, hardness: float) -> torch.Tensor:
    """Histogram remap on the alpha (LayerStyle-style black/white point):
    raises the black point and lowers the white point symmetrically, collapsing
    the low-alpha fringe where the original background bleeds through as a halo.
    0 = identity, 1 = hard cut at 0.5."""
    if hardness <= 0.0:
        return alpha
    bp = min(hardness * 0.5, 0.499)
    wp = 1.0 - bp
    return ((alpha - bp) / (wp - bp)).clamp(0.0, 1.0)


# ---------------------------------------------------------------------------
# Post blend — color match (Reinhard, LAB) + optional Poisson seamless clone.
# Ported from NKD Klein Postsampling. LAB conversion stays in float32 numpy
# (cv2's COLOR_RGB2LAB rounds through uint8 and loses precision).
# ---------------------------------------------------------------------------

def _rgb_to_lab(rgb):
    lin = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    M = np.array([
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ], dtype=np.float32)
    xyz = lin @ M.T / np.array([0.95047, 1.0, 1.08883], dtype=np.float32)
    delta = (6.0 / 29.0)
    delta3 = delta ** 3

    def f(t):
        return np.where(t > delta3, np.cbrt(t), t / (3.0 * delta * delta) + 4.0 / 29.0)

    fx, fy, fz = f(xyz[..., 0]), f(xyz[..., 1]), f(xyz[..., 2])
    L = 116.0 * fy - 16.0
    a = 500.0 * (fx - fy)
    b = 200.0 * (fy - fz)
    return np.stack([L, a, b], axis=-1).astype(np.float32)


def _lab_to_rgb(lab):
    L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    fy = (L + 16.0) / 116.0
    fx = a / 500.0 + fy
    fz = fy - b / 200.0
    delta = 6.0 / 29.0

    def f_inv(t):
        return np.where(t > delta, t ** 3, 3.0 * delta * delta * (t - 4.0 / 29.0))

    xyz = np.stack([
        f_inv(fx) * 0.95047,
        f_inv(fy) * 1.0,
        f_inv(fz) * 1.08883,
    ], axis=-1)
    M_inv = np.array([
        [3.2404542, -1.5371385, -0.4985314],
        [-0.9692660, 1.8760108, 0.0415560],
        [0.0556434, -0.2040259, 1.0572252],
    ], dtype=np.float32)
    lin = np.clip(xyz @ M_inv.T, 0.0, None)
    rgb = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * (lin ** (1.0 / 2.4)) - 0.055)
    return np.clip(rgb, 0.0, 1.0).astype(np.float32)


def _reinhard_match(orig_rgb, gen_rgb, mask, strength):
    """Pull the edited region's colour statistics toward the original's, over the
    EDITED (masked) region — that's where the model's drift lives. Measuring the
    background instead is a no-op whenever the composite keeps the original outside
    the mask (inpaint / stitch / dewarp), so match the foreground. Returns gen
    unchanged when the edit region is too small to estimate statistics reliably."""
    if strength <= 0.0:
        return gen_rgb
    fg = mask > 0.5
    if fg.sum() < 100:
        return gen_rgb
    orig_lab = _rgb_to_lab(orig_rgb)
    gen_lab = _rgb_to_lab(gen_rgb)
    o_mean = orig_lab[fg].mean(axis=0)
    o_std = orig_lab[fg].std(axis=0) + 1e-5
    g_mean = gen_lab[fg].mean(axis=0)
    g_std = gen_lab[fg].std(axis=0) + 1e-5
    matched = (gen_lab - g_mean) / g_std * o_std + o_mean
    matched_rgb = _lab_to_rgb(matched)
    blended = matched_rgb * strength + gen_rgb * (1.0 - strength)
    return np.clip(blended, 0.0, 1.0)


def _seamless_clone(orig_rgb, gen_rgb, mask):
    """Poisson blend gen onto orig inside `mask`. The clamped-edge guard on the
    binary mask prevents the OpenCV crash you get when the mask touches the
    image boundary, and the bounding-rect centre matches what seamlessClone
    computes internally — using numpy min/max instead shifts the result by 1px."""
    import cv2
    o_u8 = (np.clip(orig_rgb, 0, 1) * 255).astype(np.uint8)
    g_u8 = (np.clip(gen_rgb, 0, 1) * 255).astype(np.uint8)
    binary = (mask > 0.1).astype(np.uint8) * 255
    binary[0, :] = 0; binary[-1, :] = 0
    binary[:, 0] = 0; binary[:, -1] = 0
    m3 = mask[..., np.newaxis]
    x, y, w, h = cv2.boundingRect(binary)
    if w == 0 or h == 0:
        return np.clip(orig_rgb * (1.0 - m3) + gen_rgb * m3, 0, 1)
    center = (x + w // 2, y + h // 2)
    try:
        cloned = cv2.seamlessClone(g_u8, o_u8, binary, center, cv2.NORMAL_CLONE)
        cloned = cloned.astype(np.float32) / 255.0
        return np.clip(orig_rgb * (1.0 - m3) + cloned * m3, 0, 1)
    except Exception:
        return np.clip(orig_rgb * (1.0 - m3) + gen_rgb * m3, 0, 1)


def _post_blend(orig: torch.Tensor, composite: torch.Tensor, mask: torch.Tensor,
                match_strength: float, seamless: bool) -> torch.Tensor:
    """Re-blend composite over orig with Reinhard color match + optional Poisson.
    `mask` is the full-res alpha [B, H, W]. Per-item loop: cv2/numpy domain.
    An empty mask returns the composite unchanged so seamlessClone never hits a
    zero rect."""
    out = composite.clone()
    for i in range(composite.shape[0]):
        m = mask[min(i, mask.shape[0] - 1)].detach().clamp(0, 1).cpu().numpy().astype(np.float32)
        if m.sum() < 1:
            continue
        o = orig[min(i, orig.shape[0] - 1), :, :, :3].detach().clamp(0, 1).cpu().numpy().astype(np.float32)
        c = composite[i, :, :, :3].detach().clamp(0, 1).cpu().numpy().astype(np.float32)
        matched = _reinhard_match(o, c, m, match_strength)
        if seamless:
            res = _seamless_clone(o, matched, m)
        else:
            m3 = m[..., np.newaxis]
            res = np.clip(o * (1.0 - m3) + matched * m3, 0, 1)
        out[i, :, :, :3] = torch.from_numpy(np.ascontiguousarray(res)).to(
            device=composite.device, dtype=composite.dtype)
    return out
