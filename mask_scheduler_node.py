"""
NKD Mask Scheduler — generate (or ramp) a mask whose strength follows a schedule.

Designed to pair with 😺NKD Sigmas Curve: feed its "floats" output (a list of
values, one per step, e.g. a curve going 1.0 → 0.0) into `schedule` and this
node emits a MASK batch where mask[i] = base * schedule[i]. So on the first
step the mask can be at 100% and fade to 0% on the last, following whatever
shape the curve draws.

`mask` is optional: leave it unplugged and the node is *generative* — it makes
a solid mask of `width`×`height` and schedules that (no Create Solid Mask
needed). Plug a mask in and it schedules that mask instead.

The `schedule` input also accepts a single float, or any FLOAT list from other
nodes.
"""

import torch


class NKDMaskScheduler:
    CATEGORY = "😺NKD Nodes/Sampling"
    FUNCTION = "schedule"
    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("mask",)
    DESCRIPTION = (
        "Generate a mask that follows a schedule of floats (e.g. the 'floats' "
        "output of NKD Sigmas Curve). Emits one mask per schedule value, scaled "
        "by that value — 1.0 → full mask, 0.0 → empty. Leave 'mask' unplugged to "
        "generate a solid width×height mask; plug one in to schedule it instead."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "schedule": ("FLOAT", {"forceInput": True}),
                "width":    ("INT", {"default": 512, "min": 1, "max": 8192, "tooltip": "Width of the generated mask (used when no 'mask' is plugged in)."}),
                "height":   ("INT", {"default": 512, "min": 1, "max": 8192, "tooltip": "Height of the generated mask (used when no 'mask' is plugged in)."}),
                "value":    ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "Base value of the generated solid mask before scheduling."}),
            },
            "optional": {
                "mask":      ("MASK", {"tooltip": "Optional. If plugged in, this mask is scheduled instead of a generated solid one."}),
                "normalize": ("BOOLEAN", {"default": True,  "tooltip": "Divide the schedule by its max so the peak maps to 100% (handles sigma magnitudes ≠ 1)."}),
                "invert":    ("BOOLEAN", {"default": False, "tooltip": "Flip the schedule: 0 → 100% mask, 1 → 0% mask."}),
            },
        }

    def schedule(self, schedule, width=512, height=512, value=1.0, mask=None, normalize=True, invert=False):
        # NKD Sigmas Curve passes its list as a single FLOAT value; a plain
        # FLOAT wire arrives as a scalar. Accept both.
        if isinstance(schedule, (int, float)):
            vals = [float(schedule)]
        else:
            vals = [float(v) for v in schedule]
        if not vals:
            vals = [1.0]

        # No mask plugged in → generate a solid one (generative mode).
        if mask is None:
            base = torch.full((1, int(height), int(width)), float(value))
        else:
            # ponytail: use the first frame if a batched mask is fed; per-frame
            # pairing would be a separate node. base → (1, H, W).
            base = mask[0:1] if mask.dim() == 3 else mask.unsqueeze(0)

        t = torch.tensor(vals, dtype=base.dtype, device=base.device)  # (N,)
        if normalize:
            peak = float(t.max())
            if peak > 0.0:
                t = t / peak
        t = t.clamp(0.0, 1.0)
        if invert:
            t = 1.0 - t

        out = base * t.view(-1, 1, 1)  # (N, H, W)
        return (out,)


if __name__ == "__main__":
    # self-check: 1.0→0.0 schedule ramps a solid mask from full to empty
    node = NKDMaskScheduler()
    m = torch.ones(1, 4, 4)
    out, = node.schedule([1.0, 0.5, 0.0], mask=m)
    assert out.shape == (3, 4, 4), out.shape
    assert torch.allclose(out[0], torch.ones(4, 4))
    assert torch.allclose(out[1], torch.full((4, 4), 0.5))
    assert torch.allclose(out[2], torch.zeros(4, 4))
    # normalize: sigma-scale [2, 1, 0] → peak maps to 100%
    out2, = node.schedule([2.0, 1.0, 0.0], mask=m, normalize=True)
    assert torch.allclose(out2[0], torch.ones(4, 4))
    assert torch.allclose(out2[1], torch.full((4, 4), 0.5))
    # invert flips endpoints
    out3, = node.schedule([1.0, 0.0], mask=m, normalize=False, invert=True)
    assert torch.allclose(out3[0], torch.zeros(4, 4))
    assert torch.allclose(out3[1], torch.ones(4, 4))
    # generative: no mask → solid width×height scheduled
    out4, = node.schedule([1.0, 0.0], width=6, height=4, value=1.0, normalize=False)
    assert out4.shape == (2, 4, 6), out4.shape
    assert torch.allclose(out4[0], torch.ones(4, 6))
    assert torch.allclose(out4[1], torch.zeros(4, 6))
    print("NKDMaskScheduler self-check OK")
