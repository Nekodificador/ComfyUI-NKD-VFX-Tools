"""😺NKD Relight — Lambert + Blinn-Phong relighting of a photo from its
normal/depth passes, with screen-space shadows marched over the depth pass.

The light rig is edited in the node's WebGL preview and travels as JSON in
the `lights_config` widget; the GPU pipeline below is the reference the
frontend shader and its JS fallback mirror (tracer constants must stay in
sync in all three).

V3 node (comfy_api.latest). node_id and every input name are unchanged from
the V1 version so saved workflows keep their links and the frontend keeps
matching on "RelightingNode".
"""
import torch
import torch.nn.functional as F
import json
import base64
import math

# comfy_api only exists inside ComfyUI. Everything above the _HAS_COMFY guard
# must import standalone so demo() runs with no PYTHONPATH tricks.
try:
    from comfy_api.latest import io
    _HAS_COMFY = True
except ImportError:  # pragma: no cover - standalone test path
    _HAS_COMFY = False


# ── GPU relighting pipeline (no ComfyUI dependency) ───────────────────────────

# Fixed tracer constants — kept in sync with the WebGL/JS frontend tracer.
_SHADOW_STEPS = 24
_SHADOW_BIAS = 0.012   # constant depth bias to avoid self-shadowing acne
_SHADOW_SLOPE = 0.030  # extra bias that grows with march distance


def _parse_state(lights_config):
    """lights_config JSON → (lights, ambient_intensity, ambient_color, delit_mix,
    roughness_strength, shadows). Accepts the legacy bare-array format."""
    try:
        state = json.loads(lights_config) if lights_config else {}
    except json.JSONDecodeError:
        state = {}

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
    return lights, ambient_intensity, ambient_color, delit_mix, roughness_strength, shadows


MASK_SLOTS = 4  # mask_1..mask_4 — one per RGBA channel of the preview's packed texture


def _light_mask(light, masks):
    """Per-light occlusion factor from the mask the light selected, or None.

    `masks` is the MASK_SLOTS-long list of (B,H,W) tensors (None = slot not
    wired). An unwired slot is "no mask": the light is unaffected whatever
    Invert says — mirrored by the preview, which zeroes the selector for
    unwired slots.
    """
    if not masks:
        return None
    idx = int(light.get("mask", 0) or 0)
    if idx < 1 or idx > len(masks) or masks[idx - 1] is None:
        return None
    m = masks[idx - 1]
    if light.get("maskInvert", False):
        m = 1.0 - m
    amt = max(0.0, min(1.0, float(light.get("maskAmount", 1.0))))
    if amt < 1.0:
        m = 1.0 - amt + amt * m  # mix(1, m, amt): partial exclusion
    return m


def _match_mask(mask, target_h, target_w, batch):
    """MASK (B,H,W) → float (B or 1,H,W) at the rgb resolution, broadcastable."""
    m = mask.float()
    if m.dim() == 2:
        m = m.unsqueeze(0)
    if m.shape[1] != target_h or m.shape[2] != target_w:
        m = _match_size(m.unsqueeze(-1), target_h, target_w).squeeze(-1)
    if m.shape[0] != batch and m.shape[0] != 1:
        m = m[:1]  # ponytail: batch mismatch → first mask for the whole batch
    return m.clamp(0.0, 1.0)


def _relight(rgb, normals, depth, albedo, roughness, lights_config, unique_id="",
             masks=None):
    """Whole node body minus the ComfyUI wrapper: resize passes, push the preview
    passes to the frontend, run the GPU pipeline.

    masks: dict {"mask_1": MASK, ...} from the Autogrow input (unwired slots absent).
    """
    (lights, ambient_intensity, ambient_color, delit_mix,
     roughness_strength, shadows) = _parse_state(lights_config)

    # Resize all passes to match rgb resolution (stays on device)
    target_h, target_w = rgb.shape[1], rgb.shape[2]
    if normals.shape[1] != target_h or normals.shape[2] != target_w:
        normals = _match_size(normals, target_h, target_w)
    if depth.shape[1] != target_h or depth.shape[2] != target_w:
        depth = _match_size(depth, target_h, target_w)
    if albedo is not None and (albedo.shape[1] != target_h or albedo.shape[2] != target_w):
        albedo = _match_size(albedo, target_h, target_w)
    if roughness is not None and (roughness.shape[1] != target_h or roughness.shape[2] != target_w):
        roughness = _match_size(roughness, target_h, target_w)

    # Masks by slot, resized to rgb; None where nothing is wired
    mask_list = [None] * MASK_SLOTS
    for k in range(MASK_SLOTS):
        m = (masks or {}).get(f"mask_{k + 1}")
        if m is not None:
            mask_list[k] = _match_mask(m, target_h, target_w, rgb.shape[0])

    # Send downscaled pass data to frontend (GPU resize → CPU only for encoding)
    if unique_id:
        _send_passes_to_frontend(unique_id, rgb, normals, depth, albedo, roughness, mask_list)

    # Full batched relighting on GPU
    return _relight_gpu(
        rgb, normals, depth, albedo, roughness,
        lights, ambient_intensity, ambient_color, delit_mix, roughness_strength,
        shadows, mask_list
    )


def _relight_gpu(rgb, normals, depth, albedo, roughness,
                 lights, ambient_intensity, ambient_color, delit_mix, roughness_strength,
                 shadows=None, masks=None):
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
    amb_rgb = torch.tensor(_hex_to_rgb(ambient_color), dtype=torch.float32, device=dev)
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
        diffuse, specular, sdir = _calc_light_gpu(
            normals_xyz, depth_s, light, roughness_s, H, W, dev, yc, xc
        )
        l_rgb = torch.tensor(
            _hex_to_rgb(light.get("color", "#ffffff")), dtype=torch.float32, device=dev
        )
        l_int = float(light.get("intensity", 1.0))
        contrib = (diffuse + specular) if roughness_s is not None else diffuse
        # Screen-space shadow: march along the depth pass toward the light.
        # Global switch is the master; each light can opt out (castShadow).
        if shadows_on and sdir is not None and light.get("castShadow", True):
            shadow_factor = _shadow_factor_gpu(depth_s, xc, yc, sdir, shadows, dev)
            contrib = contrib * shadow_factor
        # Per-light mask: confines this light (and its shadow) to a region
        mask_factor = _light_mask(light, masks)
        if mask_factor is not None:
            contrib = contrib * mask_factor
        # contrib: (B,H,W) → (B,H,W,1) * (1,1,1,3) → (B,H,W,3) added in-place
        light_accum.add_(contrib.unsqueeze(-1) * (l_rgb * l_int))

    result = (effective_base * light_accum).clamp(0.0, 1.0)
    # Preserve alpha channel if present
    if rgb.shape[-1] == 4:
        result = torch.cat([result, rgb_f[..., 3:4]], dim=-1)
    return result.to(rgb.dtype)


def _calc_light_gpu(normals, depth, light, roughness, H, W, dev, yc, xc):
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


def _shadow_factor_gpu(depth_s, xc, yc, sdir, shadows, dev):
    """March the depth pass from each surface point toward the light.

    No geometry: the depth pass is treated as a height field. If a closer
    surface "pokes above" the ray on its way to the light, the point is
    occluded. Returns a (B,H,W) factor in [0,1] (1 = fully lit).

    sdir = (su, sv, sz): screen-space marching direction. su/sv may be
    scalars (directional) or (B,H,W) tensors (point); sz likewise.
    """
    B, H, W = depth_s.shape
    steps = _SHADOW_STEPS
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
        surplus = scene_z - ray_z - (_SHADOW_BIAS + _SHADOW_SLOPE * t)
        occ = torch.maximum(occ, (surplus / window).clamp(0.0, 1.0))

    return 1.0 - strength * occ


def _pack_masks(masks, batch_h, batch_w):
    """Pack the MASK_SLOTS per-light masks into one (1,H,W,4) tensor for the preview:
    one channel per slot, 0 where nothing is wired. The preview reads a slot by a
    one-hot selector, so one texture serves every light."""
    if not masks or all(m is None for m in masks):
        return None, [False] * MASK_SLOTS
    ref = next(m for m in masks if m is not None)
    chans = []
    for m in masks:
        chans.append(m[0:1] if m is not None else torch.zeros(1, batch_h, batch_w, device=ref.device))
    return torch.stack(chans, dim=-1), [m is not None for m in masks]


def _send_passes_to_frontend(unique_id, rgb, normals, depth, albedo, roughness, masks=None):
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
    packed, slots = _pack_masks(masks, H, W)
    mk = prepare(packed)

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
    if mk is not None:
        data["masks"] = to_b64(mk)  # RGBA, one slot per channel
        data["maskSlots"] = slots

    from server import PromptServer  # type: ignore  # only inside ComfyUI
    PromptServer.instance.send_sync("nkd-relight-passes", {
        "node_id": unique_id,
        "passes": data,
    })


def _match_size(tensor, target_h, target_w):
    """Resize a BHWC image tensor to target dimensions using bilinear interpolation."""
    t = tensor.permute(0, 3, 1, 2)
    t = F.interpolate(t, size=(target_h, target_w), mode="bilinear", align_corners=False)
    return t.permute(0, 2, 3, 1)


def _hex_to_rgb(hc):
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


# ── ComfyUI node ──────────────────────────────────────────────────────────────

if _HAS_COMFY:

    class RelightingNode(io.ComfyNode):
        @classmethod
        def define_schema(cls) -> io.Schema:
            return io.Schema(
                node_id="RelightingNode",
                display_name="😺NKD Relight",
                category="😺NKD Nodes/Utils",
                description="Relight a photo from its normal and depth passes. Place point "
                            "and directional lights in the live preview; screen-space "
                            "shadows are marched over the depth pass, no geometry needed.",
                inputs=[
                    io.Image.Input("rgb", tooltip="The photo to relight."),
                    io.Image.Input("normals", tooltip="Normal pass, OpenGL convention (Y up)."),
                    io.Image.Input("depth", tooltip="Depth pass, near = white."),
                    io.Image.Input("albedo", optional=True,
                                   tooltip="Delit base colour. Enables the Delight slider."),
                    io.Image.Input("roughness", optional=True,
                                   tooltip="Roughness pass, white = rough. Enables specular."),
                    # Written by the preview widget. NOT multiline: a multiline String is a
                    # real DOM textarea that survives the widget-hiding tricks (measured on
                    # Preview 3D).
                    io.String.Input("lights_config", default="{}", multiline=False, optional=True),
                    # mask_1..mask_4: a fresh slot appears as you wire one. Each light picks
                    # a slot in the preview to confine its light (and shadow) to that region.
                    io.Autogrow.Input(
                        "masks",
                        template=io.Autogrow.TemplateNames(
                            io.Mask.Input("mask"),
                            names=[f"mask_{k + 1}" for k in range(MASK_SLOTS)],
                            min=0,
                        ),
                        optional=True,
                        tooltip="Masks a light can be confined to (pick one per light in the "
                                "editor). Feather them upstream; white = lit.",
                    ),
                ],
                outputs=[io.Image.Output(display_name="relit_image")],
                hidden=[io.Hidden.unique_id],
            )

        @classmethod
        def fingerprint_inputs(cls, lights_config="{}", **kwargs):
            # Normalise the JSON so key order / whitespace never forces a re-run.
            try:
                return json.dumps(json.loads(lights_config), sort_keys=True)
            except (json.JSONDecodeError, TypeError):
                return lights_config

        @classmethod
        def execute(cls, rgb, normals, depth, albedo=None, roughness=None,
                    lights_config="{}", masks=None) -> io.NodeOutput:
            uid = cls.hidden.unique_id
            out = _relight(rgb, normals, depth, albedo, roughness, lights_config,
                           unique_id=str(uid) if uid is not None else "",
                           masks=masks)
            return io.NodeOutput(out)


# ---------------------------------------------------------------------------
# Self-check:  python relighting_node.py
# ---------------------------------------------------------------------------

def demo() -> None:
    torch.manual_seed(0)
    H = W = 16

    def enc(n):  # world normal → encoded pass (the pipeline flips Y on decode)
        x, y, z = n
        l = math.sqrt(x * x + y * y + z * z)
        return torch.tensor([(x / l + 1) / 2, (-y / l + 1) / 2, (z / l + 1) / 2])

    rgb = torch.full((1, H, W, 3), 0.5)
    facing = enc((0, 0, 1)).view(1, 1, 1, 3).expand(1, H, W, 3).clone()
    flat_depth = torch.zeros(1, H, W, 3)

    # 1. No lights: output is base × ambient (0.5 × 0.2 = 0.1), legacy list and dict alike.
    for cfg in ("{}", "[]", '{"lights": []}'):
        out = _relight(rgb, facing, flat_depth, None, None, cfg)
        assert out.shape == rgb.shape and torch.allclose(out, torch.full_like(out, 0.1), atol=1e-6), cfg

    # 2. Directional light straight at a camera-facing surface: diffuse = 1,
    #    so out = 0.5 × (0.2 + 1.0) = 0.6. Fixes the sign convention of the decode.
    cfg = json.dumps({"lights": [{"type": "directional", "azimuth": 0, "elevation": 0,
                                  "intensity": 1.0, "color": "#ffffff"}]})
    out = _relight(rgb, facing, flat_depth, None, None, cfg)
    assert torch.allclose(out, torch.full_like(out, 0.6), atol=1e-6), out[0, 0, 0]

    # 3. Same light, surface facing away (normal -Z): diffuse clamps to 0 → ambient only.
    away = enc((0, 0, -1)).view(1, 1, 1, 3).expand(1, H, W, 3).clone()
    out = _relight(rgb, away, flat_depth, None, None, cfg)
    assert torch.allclose(out, torch.full_like(out, 0.1), atol=1e-6)

    # 4. Screen-space shadow: a wall (depth 1) on the right half, light from the right
    #    (az 90 → ld = +X). A pixel next to the wall marches into it and darkens; a pixel
    #    far to the left is out of range and stays lit. Same light with shadows off:
    #    both pixels equal — the control that proves the darkening came from the tracer.
    tilted = enc((1, 0, 1)).view(1, 1, 1, 3).expand(1, H, W, 3).clone()
    wall = torch.zeros(1, H, W, 3)
    wall[:, :, W // 2:, :] = 1.0
    light = {"type": "directional", "azimuth": 90, "elevation": 0, "intensity": 1.0}
    on = json.dumps({"lights": [light], "shadowsEnabled": True, "shadowStrength": 0.6,
                     "shadowSoftness": 0.3, "shadowRange": 0.15})
    off = json.dumps({"lights": [light], "shadowsEnabled": False})
    o_on = _relight(rgb, tilted, wall, None, None, on)
    o_off = _relight(rgb, tilted, wall, None, None, off)
    near, far = W // 2 - 1, 0
    assert torch.allclose(o_off[0, 0, near], o_off[0, 0, far]), "control: no shadows → equal"
    assert o_on[0, 0, near, 0] < o_off[0, 0, near, 0] - 0.05, "next to the wall must darken"
    assert torch.allclose(o_on[0, 0, far], o_off[0, 0, far], atol=1e-6), "out of range stays lit"

    # 5. Passes at another resolution are resized to rgb, and a 4-channel rgb keeps alpha.
    small = enc((0, 0, 1)).view(1, 1, 1, 3).expand(1, 4, 4, 3).clone()
    rgba = torch.cat([rgb, torch.full((1, H, W, 1), 0.25)], dim=-1)
    out = _relight(rgba, small, torch.zeros(1, 4, 4, 3), None, None, cfg)
    assert out.shape == (1, H, W, 4) and torch.allclose(out[..., 3], torch.full((1, H, W), 0.25))
    assert torch.allclose(out[..., :3], torch.full((1, H, W, 3), 0.6), atol=1e-6)

    # 6. Per-light mask. Left half masked out (mask 0), right half lit (mask 1), light of
    #    block 2 → left = ambient only (0.1), right = full (0.6). Invert swaps the halves.
    #    An UNWIRED slot is "no mask" whatever Invert says (mirrors the preview).
    half = torch.zeros(1, H, W)
    half[:, :, W // 2:] = 1.0
    L = {"type": "directional", "azimuth": 0, "elevation": 0, "intensity": 1.0}
    def run(**light_extra):
        cfg = json.dumps({"lights": [dict(L, **light_extra)]})
        return _relight(rgb, facing, flat_depth, None, None, cfg, masks={"mask_2": half})
    o = run(mask=2)
    assert torch.allclose(o[0, :, :W // 2], torch.full((H, W // 2, 3), 0.1), atol=1e-6)
    assert torch.allclose(o[0, :, W // 2:], torch.full((H, W // 2, 3), 0.6), atol=1e-6)
    o = run(mask=2, maskInvert=True)
    assert torch.allclose(o[0, :, :W // 2], torch.full((H, W // 2, 3), 0.6), atol=1e-6)
    assert torch.allclose(o[0, :, W // 2:], torch.full((H, W // 2, 3), 0.1), atol=1e-6)
    o = run(mask=2, maskAmount=0.5)  # half exclusion: 0.5 × (0.2 + 0.5) = 0.35 on the left
    assert torch.allclose(o[0, :, :W // 2], torch.full((H, W // 2, 3), 0.35), atol=1e-6)
    for extra in (dict(mask=0), dict(mask=3), dict(mask=3, maskInvert=True)):
        assert torch.allclose(run(**extra), torch.full((1, H, W, 3), 0.6), atol=1e-6), extra
    # A mask at another resolution and batch 1 against rgb batch 2 still lands per pixel.
    small_half = torch.zeros(1, 4, 4); small_half[:, :, 2:] = 1.0
    o = _relight(rgb.repeat(2, 1, 1, 1), facing.repeat(2, 1, 1, 1), flat_depth.repeat(2, 1, 1, 1),
                 None, None, json.dumps({"lights": [dict(L, mask=1)]}), masks={"mask_1": small_half})
    assert o.shape[0] == 2 and float(o[1, 0, 0, 0]) < 0.15 and float(o[1, 0, W - 1, 0]) > 0.55

    # 7. Per-light shadow toggle: castShadow=false under the global switch equals shadows
    #    off (block 4's setup). castShadow absent keeps the old behaviour (shadow cast).
    no_cast = json.dumps({"lights": [dict(light, castShadow=False)], "shadowsEnabled": True,
                          "shadowStrength": 0.6, "shadowSoftness": 0.3, "shadowRange": 0.15})
    assert torch.equal(_relight(rgb, tilted, wall, None, None, no_cast), o_off)
    assert torch.equal(_relight(rgb, tilted, wall, None, None, on), o_on)

    # 8. Preview packing: wired slots land in their channel, unwired ones are zero.
    packed, slots = _pack_masks([None, half, None, 1.0 - half], H, W)
    assert packed.shape == (1, H, W, 4) and slots == [False, True, False, True]
    assert float(packed[0, 0, W - 1, 1]) == 1.0 and float(packed[0, 0, 0, 3]) == 1.0
    assert float(packed[..., 0].abs().sum()) == 0.0 and float(packed[..., 2].abs().sum()) == 0.0
    assert _pack_masks([None] * 4, H, W) == (None, [False] * 4)

    print("relighting_node self-check OK")


if __name__ == "__main__":
    demo()
