import torch
import torch.nn.functional as F
import json
import base64
import math

from server import PromptServer


class NKDLensBlurNode:
    CATEGORY = "😺NKD Nodes/Utils"
    FUNCTION = "apply_lens_blur"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("blurred_image",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "rgb":   ("IMAGE",),
                "depth": ("IMAGE",),
            },
            "optional": {
                "blur_config": ("STRING", {"default": "{}"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            }
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        bc = kwargs.get("blur_config", "{}")
        try:
            return json.dumps(json.loads(bc), sort_keys=True)
        except (json.JSONDecodeError, TypeError):
            return bc

    def apply_lens_blur(self, rgb, depth, blur_config="{}", unique_id=""):
        try:
            state = json.loads(blur_config) if blur_config else {}
        except json.JSONDecodeError:
            state = {}

        blur_strength  = float(state.get("blurStrength",  1.0))
        field_of_depth = float(state.get("fieldOfDepth",  0.1))
        focus_x        = float(state.get("focusX",        0.5))
        focus_y        = float(state.get("focusY",        0.5))

        # focalDepth: the frontend already computes auto+offset and stores the
        # final value. Fall back to sampling + offset if not present.
        focal_offset = float(state.get("focalOffset", 0.0))
        if "focalDepth" in state:
            focal_depth = float(state["focalDepth"])   # already includes offset
        else:
            focal_depth = float(
                max(0.0, min(1.0, self._sample_depth(depth, focus_x, focus_y) + focal_offset))
            )

        target_h, target_w = rgb.shape[1], rgb.shape[2]
        if depth.shape[1] != target_h or depth.shape[2] != target_w:
            depth = self._match_size(depth, target_h, target_w)

        if unique_id:
            self._send_passes_to_frontend(unique_id, rgb, depth)

        result = self._blur_gpu(rgb, depth, focal_depth, field_of_depth, blur_strength)
        return (result,)

    def _sample_depth(self, depth, nx: float, ny: float) -> float:
        H, W = depth.shape[1], depth.shape[2]
        px = max(0, min(W - 1, round(nx * (W - 1))))
        py = max(0, min(H - 1, round(ny * (H - 1))))
        lum = depth[0, py, px, :3].float().mean().item()
        return float(lum)

    # ------------------------------------------------------------------

    def _blur_gpu(self, rgb, depth, focal_depth: float, field_of_depth: float, blur_strength: float):
        B, H, W, C = rgb.shape
        dev = rgb.device

        # Depth as single-channel scalar (B, H, W)
        depth_s = depth[..., :3].float().mean(dim=-1)

        # In-focus band: [focal_depth - half, focal_depth + half]
        # Pixels within the band get 0 blur; outside, blur grows with distance from band edge.
        half = field_of_depth / 2.0
        lo   = focal_depth - half
        hi   = focal_depth + half

        dist_lo = (lo - depth_s).clamp(min=0.0)
        dist_hi = (depth_s - hi).clamp(min=0.0)
        dist_from_band = dist_lo + dist_hi

        # Smoothstep curve: softer ramp than linear at the band edges
        raw          = (dist_from_band * blur_strength).clamp(0.0, 1.0)
        blur_amount  = raw * raw * (3.0 - 2.0 * raw)

        # Spatially blur the blur_amount map to eliminate hard focal-band rings
        blur_amount = self._smooth_blur_map(blur_amount, sigma=2.0, dev=dev)

        # Kernel bank: N=8 sigmas from 0 to sigma_max
        sigma_max = min(max(H, W) * 0.025, 15.0)
        N = 8
        sigmas = [sigma_max * i / (N - 1) for i in range(N)]

        # Work only on RGB channels — alpha is never blurred
        rgb_f = rgb.float()
        x     = rgb_f[..., :3].permute(0, 3, 1, 2)  # (B, 3, H, W)
        Crgb  = 3

        # All levels in one fused conv2d call:
        # Treat each (level, channel) pair as an independent group so CUDA
        # launches a single kernel instead of N sequential ones.
        # x_rep: (B, N*3, H, W) — replicate the image N times along the channel dim
        x_rep = x.repeat(1, N, 1, 1)  # (B, N*3, H, W)

        # Build the combined weight tensor (N*3, 1, 1, K_max) for the row pass
        # and (N*3, 1, K_max, 1) for the col pass.
        # Each level gets its own 1-D Gaussian (zero-padded to K_max).
        max_radius = max(1, int(math.ceil(3.0 * max(s for s in sigmas if s >= 0.5))))
        K = 2 * max_radius + 1
        pad_w = min(max_radius, W // 2 - 1) if W > 2 else 0
        pad_h = min(max_radius, H // 2 - 1) if H > 2 else 0

        row_weights = torch.zeros(N * Crgb, 1, 1, K, device=dev)
        col_weights = torch.zeros(N * Crgb, 1, K, 1, device=dev)

        coords = torch.arange(K, dtype=torch.float32, device=dev) - max_radius
        for li, sigma in enumerate(sigmas):
            if sigma < 0.5:
                g = torch.zeros(K, device=dev)
                g[max_radius] = 1.0
            else:
                g = torch.exp(-0.5 * (coords / sigma) ** 2)
                g = g / g.sum()
            for c in range(Crgb):
                idx = li * Crgb + c
                row_weights[idx, 0, 0, :] = g
                col_weights[idx, 0, :, 0] = g

        # Replicate-pad before each pass so border pixels are extended, not zeroed.
        # This prevents the dark-edge vignette caused by zero-padding in F.conv2d.
        out = F.pad(x_rep, (pad_w, pad_w, 0, 0), mode='replicate')
        out = F.conv2d(out, row_weights, padding=0, groups=N * Crgb)
        out = F.pad(out, (0, 0, pad_h, pad_h), mode='replicate')
        out = F.conv2d(out, col_weights, padding=0, groups=N * Crgb)
        # out: (B, N*3, H, W) — reshape to (B, N, 3, H, W)
        stack = out.view(B, N, Crgb, H, W)

        idx_f  = blur_amount * (N - 1)
        idx_lo = idx_f.long().clamp(0, N - 2)
        idx_hi = (idx_lo + 1).clamp(0, N - 1)
        t      = (idx_f - idx_lo.float()).clamp(0.0, 1.0)

        # Gather the two bracketing levels per pixel
        # idx: (B, H, W) → expand to (B, 3, H, W) for indexing along dim 1 (levels)
        idx_lo_e = idx_lo.unsqueeze(1).expand(B, Crgb, H, W)  # (B, 3, H, W)
        idx_hi_e = idx_hi.unsqueeze(1).expand(B, Crgb, H, W)
        t_e      = t.unsqueeze(1).expand(B, Crgb, H, W)

        # stack: (B, N, 3, H, W) → (B, 3, H, W, N) for gather on last dim
        stack_p = stack.permute(0, 2, 3, 4, 1)
        lo = stack_p.gather(4, idx_lo_e.unsqueeze(-1)).squeeze(-1)
        hi = stack_p.gather(4, idx_hi_e.unsqueeze(-1)).squeeze(-1)

        result = torch.lerp(lo, hi, t_e).clamp(0.0, 1.0)  # (B, 3, H, W)
        result = result.permute(0, 2, 3, 1)                 # (B, H, W, 3)

        # Re-attach original alpha channel untouched
        if C == 4:
            result = torch.cat([result, rgb_f[..., 3:4]], dim=-1)

        return result.to(rgb.dtype)

    def _smooth_blur_map(self, blur_map, sigma: float, dev):
        radius = max(1, int(math.ceil(3.0 * sigma)))
        size   = 2 * radius + 1
        coords = torch.arange(size, dtype=torch.float32, device=dev) - radius
        g      = torch.exp(-0.5 * (coords / sigma) ** 2)
        g      = g / g.sum()
        x   = blur_map.unsqueeze(1)   # (B, 1, H, W)
        pad = min(radius, min(blur_map.shape[1], blur_map.shape[2]) // 2 - 1)
        pad = max(pad, 0)
        x = F.pad(x, (pad, pad, 0, 0), mode='replicate')
        x = F.conv2d(x, g.view(1, 1, 1, size), padding=0)
        x = F.pad(x, (0, 0, pad, pad), mode='replicate')
        x = F.conv2d(x, g.view(1, 1, size, 1), padding=0)
        return x.squeeze(1).clamp(0.0, 1.0)

    def _apply_separable_gaussian(self, x, sigma: float, C: int, H: int, W: int, dev):
        radius = max(1, int(math.ceil(3.0 * sigma)))
        size   = 2 * radius + 1

        coords = torch.arange(size, dtype=torch.float32, device=dev) - radius
        g      = torch.exp(-0.5 * (coords / sigma) ** 2)
        g      = g / g.sum()

        pad_h = min(radius, H // 2 - 1) if H > 2 else 0
        pad_w = min(radius, W // 2 - 1) if W > 2 else 0

        # Row pass: kernel (C, 1, 1, K)
        k_row = g.view(1, 1, 1, size).expand(C, 1, 1, size)
        out   = F.conv2d(x, k_row, padding=(0, pad_w), groups=C)

        # Col pass: kernel (C, 1, K, 1)
        k_col = g.view(1, 1, size, 1).expand(C, 1, size, 1)
        out   = F.conv2d(out, k_col, padding=(pad_h, 0), groups=C)

        return out

    def _send_passes_to_frontend(self, unique_id, rgb, depth):
        max_size = 512
        H, W = rgb.shape[1], rgb.shape[2]
        scale = min(max_size / H, max_size / W, 1.0)
        nh = int(H * scale) if scale < 1.0 else H
        nw = int(W * scale) if scale < 1.0 else W

        def prepare(t):
            s = t[0:1].permute(0, 3, 1, 2).float()
            if scale < 1.0:
                s = F.interpolate(s, size=(nh, nw), mode="bilinear", align_corners=False)
            return s.squeeze(0).permute(1, 2, 0)

        def to_b64(t):
            arr = t.clamp(0.0, 1.0).mul(255).byte().cpu().numpy()
            return base64.b64encode(arr.tobytes()).decode("ascii")

        r = prepare(rgb)
        d = prepare(depth)
        ph, pw = r.shape[0], r.shape[1]

        PromptServer.instance.send_sync("nkd-blur-passes", {
            "node_id": unique_id,
            "passes": {
                "rgb":    to_b64(r),
                "depth":  to_b64(d),
                "width":  pw,
                "height": ph,
            },
        })

    def _match_size(self, tensor, target_h: int, target_w: int):
        t = tensor.permute(0, 3, 1, 2).float()
        t = F.interpolate(t, size=(target_h, target_w), mode="bilinear", align_corners=False)
        return t.permute(0, 2, 3, 1).to(tensor.dtype)
