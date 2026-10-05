"""SyncLight inference on ComfyUI tensors (no PIL, no hard-coded .cuda()).

Mirrors src/synclight/inference/inference.py:evaluate from the upstream repo:
every view is resized to the closest of the training aspect buckets, encoded,
and the whole set goes through the model in a single pass.
"""
import numpy as np
import torch
import torch.nn.functional as F

# (width, height) buckets the model was trained on
ASPECT_BUCKETS = [
    (512, 2048), (1024, 1024), (2048, 512), (896, 1152), (1152, 896),
    (512, 1920), (640, 1536), (768, 1280), (1280, 768), (1536, 640), (1920, 512),
]


def pick_bucket(width, height):
    ar = width / height
    return min(ASPECT_BUCKETS, key=lambda wh: abs(wh[0] / wh[1] - ar))


def _resize(x, size_hw):
    """x: (B, C, H, W). Antialiased bicubic when shrinking."""
    if tuple(x.shape[-2:]) == tuple(size_hw):
        return x
    return F.interpolate(x, size=size_hw, mode="bicubic", align_corners=False,
                         antialias=True)


@torch.no_grad()
def relight(model, images, lightmap, steps=1):
    """images: (N, H, W, 3) float 0..1, reference view first.
    lightmap: (h, w, 4) float32 for the reference view (any resolution).
    Returns (N, H, W, 3) float 0..1 on the CPU, at the reference's size."""
    device = next(model.parameters()).device
    dtype = next(model.parameters()).dtype
    n, h, w, _ = images.shape
    bw, bh = pick_bucket(w, h)

    x = images.permute(0, 3, 1, 2).float()
    x = _resize(x, (bh, bw)).clamp(0, 1) * 2 - 1
    lm = torch.as_tensor(lightmap, dtype=torch.float32).permute(2, 0, 1).unsqueeze(0)
    lm = F.interpolate(lm, size=(bh, bw), mode="bilinear", align_corners=False)

    batch = {f"input{i + 1}": x[i:i + 1].to(device, dtype) for i in range(n)}
    batch["lightmap1"] = lm.to(device, dtype)

    # the lightmap is concatenated once per view
    model.conditioner.conditioners[0].config.image_keys = ["lightmap1"] * n
    model.source_key = [f"input{i + 1}" for i in range(n)]

    z = torch.cat([model.vae.encode(batch[k]) for k in model.source_key], dim=0)
    out = model.sample(z=z, num_steps=steps, conditioner_inputs=batch,
                       max_samples=1).clamp(-1, 1)
    out = ((out.float() + 1) / 2).cpu()
    out = _resize(out, (h, w)).clamp(0, 1)
    return out.permute(0, 2, 3, 1).contiguous()
