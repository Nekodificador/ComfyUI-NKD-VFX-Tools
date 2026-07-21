import torch
import torch.nn.functional as F
import numpy as np
import json
import base64
import math

from server import PromptServer


class RelightingNode:
    CATEGORY = "😺NKD Nodes/Utils"
    FUNCTION = "apply_relighting"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("relit_image",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "rgb": ("IMAGE",),
                "normals": ("IMAGE",),
                "depth": ("IMAGE",),
            },
            "optional": {
                "albedo": ("IMAGE",),
                "roughness": ("IMAGE",),
                "lights_config": ("STRING", {"default": "{}"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            }
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        lc = kwargs.get("lights_config", "{}")
        try:
            return json.dumps(json.loads(lc), sort_keys=True)
        except (json.JSONDecodeError, TypeError):
            return lc

    def apply_relighting(self, rgb, normals, depth,
                         albedo=None, roughness=None, lights_config="{}", unique_id=""):
        try:
            state = json.loads(lights_config) if lights_config else {}
        except json.JSONDecodeError:
            state = {}

        # Support legacy bare-array format
        if isinstance(state, list):
            lights = state
            ambient_intensity = 0.2
            ambient_color = "#ffffff"
            delit_mix = 0.0
            roughness_strength = 1.0
        else:
            lights = state.get("lights", [])
            ambient_intensity = state.get("ambientIntensity", 0.2)
            ambient_color = state.get("ambientColor", "#ffffff")
            delit_mix = state.get("delitMix", 0.0)
            roughness_strength = state.get("roughnessStrength", 1.0)

        # Screen-space shadow params (computed from the depth pass, no geometry)
        shadows = {
            "enabled": bool(state.get("shadowsEnabled", False)) if isinstance(state, dict) else False,
            "strength": float(state.get("shadowStrength", 0.6)) if isinstance(state, dict) else 0.6,
            "softness": float(state.get("shadowSoftness", 0.3)) if isinstance(state, dict) else 0.3,
            "range": float(state.get("shadowRange", 0.15)) if isinstance(state, dict) else 0.15,
        }

        # Resize all passes to match rgb resolution (stays on device)
        target_h, target_w = rgb.shape[1], rgb.shape[2]
        if normals.shape[1] != target_h or normals.shape[2] != target_w:
            normals = self._match_size(normals, target_h, target_w)
        if depth.shape[1] != target_h or depth.shape[2] != target_w:
            depth = self._match_size(depth, target_h, target_w)
        if albedo is not None and (albedo.shape[1] != target_h or albedo.shape[2] != target_w):
            albedo = self._match_size(albedo, target_h, target_w)
        if roughness is not None and (roughness.shape[1] != target_h or roughness.shape[2] != target_w):
            roughness = self._match_size(roughness, target_h, target_w)

        # Send downscaled pass data to frontend (GPU resize → CPU only for encoding)
        if unique_id:
            self._send_passes_to_frontend(unique_id, rgb, normals, depth, albedo, roughness)

        # Full batched relighting on GPU
        output = self._relight_gpu(
            rgb, normals, depth, albedo, roughness,
            lights, ambient_intensity, ambient_color, delit_mix, roughness_strength,
            shadows
        )
        return (output,)

    # ── GPU relighting pipeline ────────────────────────────────────────────────

    def _relight_gpu(self, rgb, normals, depth, albedo, roughness,
                     lights, ambient_intensity, ambient_color, delit_mix, roughness_strength,
                     shadows=None):
        """Batched Lambertian + Blinn-Phong relighting, all ops on device."""
        B, H, W, _ = rgb.shape
        dev = rgb.device
        rgb_f = rgb.float()

        # Decode normals: [0,1] → [-1,1], flip Y (OpenGL Y-up convention)
        normals_xyz = normals[..., :3].float() * 2.0 - 1.0
        normals_xyz[..., 1] *= -1.0
        normals_xyz = normals_xyz / normals_xyz.norm(dim=-1, keepdim=True).clamp(min=1e-8)

        # Depth: luminance of first 3 channels
        depth_s = depth[..., :3].float().mean(dim=-1)  # (B, H, W)

        # Roughness: luminance, scaled by roughness_strength
        roughness_s = None
        if roughness is not None:
            roughness_s = (roughness[..., :3].float().mean(dim=-1) * roughness_strength).clamp(0.0, 1.0)

        # Base color: blend rgb and albedo by delit_mix
        if albedo is not None and delit_mix > 0.0:
            effective_base = ((1.0 - delit_mix) * rgb_f + delit_mix * albedo.float())[..., :3]
        else:
            effective_base = rgb_f[..., :3]

        # Ambient seed
        amb_rgb = torch.tensor(self._hex_to_rgb(ambient_color), dtype=torch.float32, device=dev)
        light_accum = (amb_rgb * ambient_intensity).view(1, 1, 1, 3).expand(B, H, W, 3).clone()

        # Screen-space shadows need the per-pixel UV grids too
        shadows_on = bool(shadows and shadows.get("enabled"))

        # UV grids for point lights / shadows — computed once, shared across lights
        has_point = any(l.get("type", "point") == "point" for l in lights)
        if has_point or shadows_on:
            yc = torch.linspace(0, 1, H, device=dev).view(H, 1).expand(H, W).unsqueeze(0)  # (1,H,W)
            xc = torch.linspace(0, 1, W, device=dev).view(1, W).expand(H, W).unsqueeze(0)  # (1,H,W)
        else:
            yc = xc = None

        for light in lights:
            diffuse, specular, sdir = self._calc_light_gpu(
                normals_xyz, depth_s, light, roughness_s, H, W, dev, yc, xc
            )
            l_rgb = torch.tensor(
                self._hex_to_rgb(light.get("color", "#ffffff")), dtype=torch.float32, device=dev
            )
            l_int = float(light.get("intensity", 1.0))
            contrib = (diffuse + specular) if roughness_s is not None else diffuse
            # Screen-space shadow: march along the depth pass toward the light
            if shadows_on and sdir is not None:
                shadow_factor = self._shadow_factor_gpu(depth_s, xc, yc, sdir, shadows, dev)
                contrib = contrib * shadow_factor
            # contrib: (B,H,W) → (B,H,W,1) * (1,1,1,3) → (B,H,W,3) added in-place
            light_accum.add_(contrib.unsqueeze(-1) * (l_rgb * l_int))

        result = (effective_base * light_accum).clamp(0.0, 1.0)
        # Preserve alpha channel if present
        if rgb.shape[-1] == 4:
            result = torch.cat([result, rgb_f[..., 3:4]], dim=-1)
        return result.to(rgb.dtype)

    def _calc_light_gpu(self, normals, depth, light, roughness, H, W, dev, yc, xc):
        """Returns (diffuse, specular, sdir) as (B,H,W) tensors on device.

        sdir is the screen-space marching direction toward the light
        (su, sv, sz) used by the shadow tracer, in image-UV space where
        v increases downward and +z points toward the camera.
        """
        B = normals.shape[0]
        lt = light.get("type", "point")
        zero = torch.zeros(B, H, W, device=dev, dtype=torch.float32)

        if lt == "directional":
            az = math.radians(float(light.get("azimuth", 0)))
            el = math.radians(float(light.get("elevation", 45)))
            # Light direction vector (constant across all pixels)
            ldx = math.cos(el) * math.sin(az)
            ldy = math.sin(el)
            ldz = math.cos(el) * math.cos(az)
            # Screen-space marching dir matches point lights: ld is in the same
            # mixed space as image-UV (normals have been Y-flipped already), so
            # no extra Y flip here.
            sdir = (ldx, ldy, ldz)
            diffuse = (
                normals[..., 0] * ldx + normals[..., 1] * ldy + normals[..., 2] * ldz
            ).clamp(min=0.0)
            if roughness is None:
                return diffuse, zero, sdir
            # Blinn-Phong: H = normalize(L + V), V = (0,0,1) — H is constant for directional
            hx, hy, hz = ldx, ldy, ldz + 1.0
            hlen = max(math.sqrt(hx*hx + hy*hy + hz*hz), 1e-8)
            ndoth = (
                normals[..., 0] * (hx / hlen) +
                normals[..., 1] * (hy / hlen) +
                normals[..., 2] * (hz / hlen)
            ).clamp(min=0.0)
            smoothness = (1.0 - roughness).clamp(0.0, 1.0)
            shininess = (smoothness.pow(2) * 128.0 + 1.0).clamp(min=1.0)
            specular = torch.pow(ndoth, shininess) * smoothness.pow(2)
            return diffuse, specular, sdir

        elif lt == "point":
            lx = float(light.get("x", 0.5))
            ly = float(light.get("y", 0.5))
            lz = float(light.get("z", 0.5))
            radius = float(light.get("radius", 1.0))

            # Per-pixel light vectors (xc/yc broadcast over batch)
            dx = lx - xc                          # (1, H, W)
            dy = ly - yc                          # (1, H, W)
            dz = lz - depth                       # (B, H, W)
            dist = (dx.pow(2) + dy.pow(2) + dz.pow(2)).sqrt().clamp(min=1e-8)  # (B,H,W)

            ldx_t = dx.expand_as(dist) / dist     # (B, H, W)
            ldy_t = dy.expand_as(dist) / dist
            ldz_t = dz / dist
            # Marching dir already in image-UV space (v down, +z toward camera)
            sdir = (ldx_t, ldy_t, ldz_t)

            dot_raw = (
                normals[..., 0] * ldx_t + normals[..., 1] * ldy_t + normals[..., 2] * ldz_t
            )
            # Windowed falloff: att reaches exactly 0 at dist=radius, so the radius
            # defines the boundary of the lit region without affecting brightness within it.
            nd = dist / radius
            att = ((1.0 - nd.pow(2)).clamp(min=0.0)).pow(2)

            # Map radius slider [0.05, 2.0] → softness [0.1, 1.0].
            softness = max(0.0, min(1.0, (radius - 0.05) / 1.95))

            # Wrapped diffuse: large radius adds fill light near the shadow terminator.
            # Normalization by (1+w) keeps full brightness on the lit side unchanged.
            w = softness * 1.0
            diffuse = (dot_raw + w).clamp(min=0.0) / (1.0 + w) * att

            if roughness is None:
                return diffuse, zero, sdir

            # Blinn-Phong: H = normalize(L + V), per-pixel since L varies
            hz_t = ldz_t + 1.0
            hlen_t = (ldx_t.pow(2) + ldy_t.pow(2) + hz_t.pow(2)).sqrt().clamp(min=1e-8)
            ndoth = (
                normals[..., 0] * ldx_t / hlen_t +
                normals[..., 1] * ldy_t / hlen_t +
                normals[..., 2] * hz_t  / hlen_t
            ).clamp(min=0.0)
            smoothness = (1.0 - roughness).clamp(0.0, 1.0)
            shininess = (smoothness.pow(2) * 128.0 + 1.0).clamp(min=1.0)
            # Larger softness → lower effective shininess → broader, softer highlight
            eff_shininess = shininess * (1.0 - softness * 0.95) + 1.0
            specular = torch.pow(ndoth, eff_shininess) * smoothness.pow(2) * att
            return diffuse, specular, sdir

        return zero, zero, None

    # ── Screen-space shadows ────────────────────────────────────────────────────

    # Fixed tracer constants — kept in sync with the WebGL/JS frontend tracer.
    _SHADOW_STEPS = 24
    _SHADOW_BIAS = 0.012   # constant depth bias to avoid self-shadowing acne
    _SHADOW_SLOPE = 0.030  # extra bias that grows with march distance

    def _shadow_factor_gpu(self, depth_s, xc, yc, sdir, shadows, dev):
        """March the depth pass from each surface point toward the light.

        No geometry: the depth pass is treated as a height field. If a closer
        surface "pokes above" the ray on its way to the light, the point is
        occluded. Returns a (B,H,W) factor in [0,1] (1 = fully lit).

        sdir = (su, sv, sz): screen-space marching direction. su/sv may be
        scalars (directional) or (B,H,W) tensors (point); sz likewise.
        """
        B, H, W = depth_s.shape
        steps = self._SHADOW_STEPS
        rng = max(1e-4, float(shadows.get("range", 0.15)))
        strength = max(0.0, min(1.0, float(shadows.get("strength", 0.6))))
        softness = max(0.0, min(1.0, float(shadows.get("softness", 0.3))))
        if strength <= 0.0:
            return torch.ones(B, H, W, device=dev, dtype=torch.float32)

        su, sv, sz = sdir
        depth_in = depth_s.unsqueeze(1)            # (B,1,H,W) for grid_sample
        d0 = depth_s                               # (B,H,W) ray origin depth
        occ = torch.zeros(B, H, W, device=dev, dtype=torch.float32)
        window = softness * 0.5 + 1e-3             # ramp width of the penumbra

        for i in range(1, steps + 1):
            t = (i / steps) * rng
            u = (xc + su * t).expand(B, H, W)      # (B,H,W) image-UV in [0,1]
            v = (yc + sv * t).expand(B, H, W)
            ray_z = d0 + sz * t                    # depth of the ray at this step
            grid = torch.stack([u * 2.0 - 1.0, v * 2.0 - 1.0], dim=-1)  # (B,H,W,2)
            scene_z = F.grid_sample(
                depth_in, grid, mode="bilinear",
                padding_mode="border", align_corners=False
            ).squeeze(1)                           # (B,H,W)
            surplus = scene_z - ray_z - (self._SHADOW_BIAS + self._SHADOW_SLOPE * t)
            occ = torch.maximum(occ, (surplus / window).clamp(0.0, 1.0))

        return 1.0 - strength * occ

    # ── Frontend preview ───────────────────────────────────────────────────────

    def _send_passes_to_frontend(self, unique_id, rgb, normals, depth, albedo, roughness):
        """GPU-resize passes then transfer to CPU only for base64 encoding."""
        max_size = 512
        H, W = rgb.shape[1], rgb.shape[2]
        scale = min(max_size / H, max_size / W, 1.0)
        nh = int(H * scale) if scale < 1.0 else H
        nw = int(W * scale) if scale < 1.0 else W

        def prepare(t):
            if t is None:
                return None
            s = t[0:1].permute(0, 3, 1, 2).float()  # (1,C,H,W)
            if scale < 1.0:
                s = F.interpolate(s, size=(nh, nw), mode="bilinear", align_corners=False)
            return s.squeeze(0).permute(1, 2, 0)  # (H,W,C) — still on device

        r  = prepare(rgb)
        n  = prepare(normals)
        d  = prepare(depth)
        a  = prepare(albedo)
        ro = prepare(roughness)

        def to_b64(t):
            if t is None:
                return None
            arr = t.clamp(0.0, 1.0).mul(255).byte().cpu().numpy()
            return base64.b64encode(arr.tobytes()).decode("ascii")

        ph, pw = r.shape[0], r.shape[1]
        data = {
            "rgb":     to_b64(r),
            "normals": to_b64(n),
            "depth":   to_b64(d),
            "width":   pw,
            "height":  ph,
        }
        if a is not None:
            data["albedo"] = to_b64(a)
        if ro is not None:
            data["roughness"] = to_b64(ro)

        PromptServer.instance.send_sync("nkd-relight-passes", {
            "node_id": unique_id,
            "passes": data,
        })

    # ── Utilities ──────────────────────────────────────────────────────────────

    def _match_size(self, tensor, target_h, target_w):
        """Resize a BHWC image tensor to target dimensions using bilinear interpolation."""
        t = tensor.permute(0, 3, 1, 2)
        t = F.interpolate(t, size=(target_h, target_w), mode="bilinear", align_corners=False)
        return t.permute(0, 2, 3, 1)

    def _hex_to_rgb(self, hc):
        hc = hc.lstrip("#")
        if len(hc) == 3:
            hc = "".join([c * 2 for c in hc])
        try:
            return (
                int(hc[0:2], 16) / 255.0,
                int(hc[2:4], 16) / 255.0,
                int(hc[4:6], 16) / 255.0,
            )
        except (ValueError, IndexError):
            return (1.0, 1.0, 1.0)
