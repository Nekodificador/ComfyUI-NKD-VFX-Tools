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
    look = _parse_look(state if isinstance(state, dict) else {})
    return lights, ambient_intensity, ambient_color, delit_mix, roughness_strength, shadows, look


# "Look" post-process defaults. All neutral: the identity, so workflows saved
# before the section existed render bit-identical.
LOOK_DEFAULTS = {
    "exposure": 0.0,      # stops, colour *= 2^ev
    "temperature": 0.0,   # -1 cool .. +1 warm
    "tint": 0.0,          # -1 magenta .. +1 green
    "saturation": 1.0,    # 0 grey .. 2 boosted
    "hazeAmount": 0.0,    # 0..1, scaled by distance (depth: near = white)
    "hazeColor": "#c8d0dc",
    "hazeStart": 0.0,     # distance (1 - depth) where haze begins to ramp in
    "hazeEnd": 1.0,       # distance where it reaches hazeAmount. End < Start = haze NEAR, fading
                          # out toward Start (signed ramp). Start = End = 0 → uniform haze
    "hazeLit": 0.0,       # 0..1: how much the haze takes the colour of the lights reaching it
}
HAZE_EPS = 1e-4


def _haze_ramp(start, end):
    """(start, span) for the haze ramp, span SIGNED: End < Start runs the ramp the
    other way (full haze at dist <= End, none at dist >= Start, gradual between).
    Start = End is a hard step that must INCLUDE dist == Start (Start = End = 0 →
    every pixel hazed), so only then the start is nudged back by HAZE_EPS; a real
    span stays exact. Mirrored by hazeRamp() in the Vue widget."""
    span = end - start
    if abs(span) <= HAZE_EPS:
        return start - HAZE_EPS, HAZE_EPS
    return start, span
WB_GAIN = 0.25  # ponytail: linear RGB gains, not Kelvin; enough to match a plate by eye


def _parse_look(state):
    look = {}
    for k, d in LOOK_DEFAULTS.items():
        v = state.get(k, d)
        look[k] = v if k == "hazeColor" else float(v)
    return look


def _apply_look(color, depth_s, look, fog=None):
    """Post-process on the lit colour (B,H,W,3), depth (B,H,W) near = white.
    Order: exposure → white balance → saturation → haze. Haze is last so the
    colour you pick is the colour that lands on the plate. Mirrored in the
    GLSL shader and the JS fallback of RelightingCanvas.vue.

    fog: (B,H,W,3) light reaching the haze itself — ambient plus each light's
    colour × intensity × attenuation, no normals, no shadows. With hazeLit the
    haze colour is scaled by it, so a point light leaves a halo of its colour
    and a directional one tints the whole veil."""
    c = color * (2.0 ** look["exposure"])
    t, g = look["temperature"], look["tint"]
    wb = torch.tensor([1.0 + WB_GAIN * t, 1.0 + WB_GAIN * g, 1.0 - WB_GAIN * t],
                      dtype=c.dtype, device=c.device)
    c = c * wb
    luma = (c[..., 0] * 0.299 + c[..., 1] * 0.587 + c[..., 2] * 0.114).unsqueeze(-1)
    c = luma + (c - luma) * look["saturation"]
    if look["hazeAmount"] > 0.0:
        haze = torch.tensor(_hex_to_rgb(look["hazeColor"]), dtype=c.dtype, device=c.device)
        if fog is not None and look["hazeLit"] > 0.0:
            haze = haze * (1.0 + (fog - 1.0) * look["hazeLit"])  # mix(1, fog, lit) per pixel
        dist = 1.0 - depth_s
        start, span = _haze_ramp(look["hazeStart"], look["hazeEnd"])
        ramp = (dist - start) / span
        f = (look["hazeAmount"] * ramp.clamp(0.0, 1.0)).unsqueeze(-1)
        c = c + (haze - c) * f
    return c.clamp(0.0, 1.0)


MASK_SLOTS = 4  # mask_1..mask_4 — one per RGBA channel of the preview's packed texture


def _light_mask(light, masks, xc=None, yc=None, depth_s=None, sdir=None):
    """Per-light occlusion factor from the mask the light selected, or None.

    `masks` is the MASK_SLOTS-long list of (B,H,W) tensors (None = slot not
    wired). An unwired slot is "no mask": the light is unaffected whatever
    Invert says — mirrored by the preview, which zeroes the selector for
    unwired slots.

    maskProject > 0 turns the mask into a gobo: it is read displaced along the
    light's screen direction by the pixel's depth, so the pattern slides over
    near surfaces relative to far ones (parallax) instead of sitting glued to
    the screen. 0 = the plain screen-space mask, bit for bit.
    """
    if not masks:
        return None
    idx = int(light.get("mask", 0) or 0)
    if idx < 1 or idx > len(masks) or masks[idx - 1] is None:
        return None
    m = masks[idx - 1]
    k = float(light.get("maskProject", 0.0) or 0.0)
    if k > 0.0 and sdir is not None and depth_s is not None:
        su, sv = sdir[0], sdir[1]
        u = xc - su * depth_s * k                      # (B,H,W)
        v = yc - sv * depth_s * k
        grid = torch.stack([u * 2.0 - 1.0, v * 2.0 - 1.0], dim=-1)
        B = depth_s.shape[0]
        m_in = m.unsqueeze(1).expand(B, 1, *m.shape[1:]) if m.shape[0] == 1 else m.unsqueeze(1)
        m = F.grid_sample(m_in, grid, mode="bilinear", padding_mode="border",
                          align_corners=False).squeeze(1)  # same sampler as the shadow tracer
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
     roughness_strength, shadows, look) = _parse_state(lights_config)

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
        shadows, mask_list, look
    )


def _relight_gpu(rgb, normals, depth, albedo, roughness,
                 lights, ambient_intensity, ambient_color, delit_mix, roughness_strength,
                 shadows=None, masks=None, look=None):
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
    # Light reaching the haze (see _apply_look). Only built when the Look asks for it.
    want_fog = look is not None and look["hazeAmount"] > 0.0 and look["hazeLit"] > 0.0
    fog_accum = light_accum.clone() if want_fog else None

    # Screen-space shadows need the per-pixel UV grids too
    shadows_on = bool(shadows and shadows.get("enabled"))

    # UV grids for point lights / shadows / projected masks — computed once, shared
    # across lights (two linspaces; not worth gating on who needs them)
    yc = torch.linspace(0, 1, H, device=dev).view(H, 1).expand(H, W).unsqueeze(0)  # (1,H,W)
    xc = torch.linspace(0, 1, W, device=dev).view(1, W).expand(H, W).unsqueeze(0)  # (1,H,W)

    for light in lights:
        diffuse, specular, sdir, att = _calc_light_gpu(
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
        mask_factor = _light_mask(light, masks, xc, yc, depth_s, sdir)
        if mask_factor is not None:
            contrib = contrib * mask_factor
        # contrib: (B,H,W) → (B,H,W,1) * (1,1,1,3) → (B,H,W,3) added in-place
        light_accum.add_(contrib.unsqueeze(-1) * (l_rgb * l_int))
        if fog_accum is not None:
            reach = att if att is not None else torch.ones(B, H, W, device=dev)
            if mask_factor is not None:
                reach = reach * mask_factor
            fog_accum.add_(reach.expand(B, H, W).unsqueeze(-1) * (l_rgb * l_int))

    result = (effective_base * light_accum).clamp(0.0, 1.0)
    if look is not None and look != LOOK_DEFAULTS:
        result = _apply_look(result, depth_s, look, fog_accum)
    # Preserve alpha channel if present
    if rgb.shape[-1] == 4:
        result = torch.cat([result, rgb_f[..., 3:4]], dim=-1)
    return result.to(rgb.dtype)


def _calc_light_gpu(normals, depth, light, roughness, H, W, dev, yc, xc):
    """Returns (diffuse, specular, sdir, att) as (B,H,W) tensors on device.
    att is the distance falloff of a point light (None for directional = 1).

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
            return diffuse, zero, sdir, None
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
        return diffuse, specular, sdir, None

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
            return diffuse, zero, sdir, att

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
        return diffuse, specular, sdir, att

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

    def prepare(t, channels=3):
        """(B,H,W,C) → (h,w,channels) on device. The preview uploads RGB textures,
        so a 1-channel pass (some depth nodes) is expanded and an RGBA one is
        cropped — otherwise texImage2D rejects the buffer and the preview goes black."""
        if t is None:
            return None
        s = t[0:1].permute(0, 3, 1, 2).float()  # (1,C,H,W)
        if s.shape[1] == 1 and channels > 1:
            s = s.expand(-1, channels, -1, -1)
        elif s.shape[1] > channels:
            s = s[:, :channels]
        if scale < 1.0:
            s = F.interpolate(s, size=(nh, nw), mode="bilinear", align_corners=False)
        return s.squeeze(0).permute(1, 2, 0)  # (H,W,C) — still on device

    r  = prepare(rgb)
    n  = prepare(normals)
    d  = prepare(depth)
    a  = prepare(albedo)
    ro = prepare(roughness)
    packed, slots = _pack_masks(masks, H, W)
    mk = prepare(packed, 4)

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

    # 6b. Gobo: maskProject reads the mask displaced by depth along the light's screen
    #     direction. Light from the right (sdir = +x), flat depth 0.5, project 0.4 → the
    #     mask slides 0.2 to the RIGHT: u=0.66 (lit before) goes dark, u=0.84 stays lit.
    #     Controls: project 0 is bit-identical to the plain mask, and a flat depth of 0
    #     gives no slide whatever the amount (parallax needs depth).
    tilted = enc((1, 0, 1)).view(1, 1, 1, 3).expand(1, H, W, 3).clone()
    gobo = lambda k, d: _relight(rgb, tilted, d, None, None, json.dumps({"lights": [
        {"type": "directional", "azimuth": 90, "elevation": 0, "intensity": 1.0,
         "color": "#ffffff", "mask": 1, "maskProject": k}]}), masks={"mask_1": half})[0, 0]
    mid_depth = torch.full((1, H, W, 3), 0.5)
    plain = gobo(0.0, mid_depth)
    assert torch.equal(plain, gobo(0.0, flat_depth)), "project 0 ignores depth"
    slid = gobo(0.4, mid_depth)
    lit_v, dark_v = float(plain[W - 1, 0]), float(plain[0, 0])
    assert lit_v > dark_v + 0.3, (lit_v, dark_v)
    assert abs(float(plain[10, 0]) - lit_v) < 1e-6 and abs(float(slid[10, 0]) - dark_v) < 1e-6, "u=0.66 goes dark"
    assert abs(float(slid[13, 0]) - lit_v) < 1e-6, "u=0.84 stays lit"
    assert torch.equal(gobo(0.4, flat_depth), gobo(0.0, flat_depth)), "no depth, no parallax"

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

    # 9. Look post-process. Defaults are the exact identity (old workflows unchanged);
    #    each control moves the pixel the way its label says; haze follows distance
    #    with the depth convention near = white (far pixel hazes, near pixel does not).
    base_cfg = {"lights": [{"type": "directional", "azimuth": 0, "elevation": 0,
                            "intensity": 1.0, "color": "#ffffff"}]}
    ref = _relight(rgb, facing, flat_depth, None, None, json.dumps(base_cfg))
    same = _relight(rgb, facing, flat_depth, None, None, json.dumps({**base_cfg, **LOOK_DEFAULTS}))
    assert torch.equal(ref, same)
    px = lambda cfg, d=flat_depth: _relight(rgb, facing, d, None, None, json.dumps({**base_cfg, **cfg}))[0, 0, 0]
    assert torch.allclose(px({"exposure": 1.0}), torch.full((3,), 1.0)), "1 stop over 0.6 clamps to 1"
    assert torch.allclose(px({"exposure": -1.0}), torch.full((3,), 0.3), atol=1e-6)
    warm = px({"temperature": 1.0}); assert warm[0] > warm[1] > warm[2], warm
    cool = px({"temperature": -1.0}); assert cool[2] > cool[1] > cool[0], cool
    grn = px({"tint": 1.0}); assert grn[1] > grn[0] and grn[1] > grn[2], grn
    tinted = px({"temperature": 1.0, "saturation": 0.0})
    assert torch.allclose(tinted, tinted[0].expand(3), atol=1e-6), "saturation 0 is grey"
    # Haze: depth 1 (near, white) on the left half, 0 (far) on the right.
    near_far = torch.zeros(1, H, W, 3); near_far[:, :, : W // 2] = 1.0
    hz = _relight(rgb, facing, near_far, None, None,
                  json.dumps({**base_cfg, "hazeAmount": 1.0, "hazeColor": "#ff0000"}))[0, 0]
    assert torch.allclose(hz[0], torch.tensor([0.6, 0.6, 0.6]), atol=1e-6), "near: untouched"
    assert torch.allclose(hz[W - 1], torch.tensor([1.0, 0.0, 0.0]), atol=1e-6), "far: full haze colour"
    assert torch.allclose(px({"hazeAmount": 0.5}, near_far), torch.tensor([0.6, 0.6, 0.6]), atol=1e-6)
    # Haze range: Start = End = 0 hazes the NEAR pixel too (uniform haze, Neko's case);
    # a range that starts beyond the far pixel's distance hazes nothing.
    uni = _relight(rgb, facing, near_far, None, None,
                   json.dumps({**base_cfg, "hazeAmount": 1.0, "hazeColor": "#ff0000",
                               "hazeStart": 0.0, "hazeEnd": 0.0}))[0, 0]
    assert torch.allclose(uni[0], uni[W - 1]) and torch.allclose(uni[0], torch.tensor([1.0, 0.0, 0.0]), atol=1e-6)
    # Mid-ramp: far pixel (dist 1) with Start 0.5 / End 1.5 → ramp 0.5 → 50/50 mix.
    mid = px({"hazeAmount": 1.0, "hazeColor": "#ff0000", "hazeStart": 0.5, "hazeEnd": 1.5}, near_far * 0)
    assert torch.allclose(mid, torch.tensor([0.8, 0.3, 0.3]), atol=1e-6), mid
    # Reversed range (End < Start): haze on the NEAR pixel, far pixel clean, and the
    # ramp between is gradual (Neko's report: it used to be a solid cut).
    rev = _relight(rgb, facing, near_far, None, None,
                   json.dumps({**base_cfg, "hazeAmount": 1.0, "hazeColor": "#ff0000",
                               "hazeStart": 1.0, "hazeEnd": 0.0}))[0, 0]
    assert torch.allclose(rev[0], torch.tensor([1.0, 0.0, 0.0]), atol=1e-6), rev[0]
    assert torch.allclose(rev[W - 1], torch.tensor([0.6, 0.6, 0.6]), atol=1e-6), rev[W - 1]
    rmid = px({"hazeAmount": 1.0, "hazeColor": "#ff0000", "hazeStart": 1.5, "hazeEnd": 0.5}, near_far * 0)
    assert torch.allclose(rmid, torch.tensor([0.8, 0.3, 0.3]), atol=1e-6), rmid
    # Lit haze: uniform white haze at full amount, ambient 0, one RED point light at
    # the top-left pixel (z = the flat depth). hazeLit 1 → the haze there IS the light
    # colour, and outside the light's radius it is black (fog in the dark is dark);
    # hazeLit 0 → the plain haze colour, whatever the lights (the control).
    pl = {"lights": [{"type": "point", "x": 0.0, "y": 0.0, "z": 0.0, "radius": 0.5,
                      "intensity": 1.0, "color": "#ff0000"}],
          "ambientIntensity": 0.0, "hazeAmount": 1.0, "hazeColor": "#ffffff",
          "hazeStart": 0.0, "hazeEnd": 0.0}
    lit = _relight(rgb, facing, flat_depth, None, None, json.dumps({**pl, "hazeLit": 1.0}))[0]
    assert torch.allclose(lit[0, 0], torch.tensor([1.0, 0.0, 0.0]), atol=1e-6), lit[0, 0]
    assert torch.allclose(lit[H - 1, W - 1], torch.zeros(3), atol=1e-6), lit[H - 1, W - 1]
    assert lit[0, W // 8, 0] > lit[0, W // 3, 0] > 0.0, "halo fades with distance"
    unlit = _relight(rgb, facing, flat_depth, None, None, json.dumps({**pl, "hazeLit": 0.0}))[0]
    assert torch.allclose(unlit, torch.ones_like(unlit)), "hazeLit 0 ignores the lights"
    # Directional light tints the whole veil evenly.
    dl = {**pl, "lights": [{"type": "directional", "azimuth": 0, "elevation": 0,
                            "intensity": 0.5, "color": "#00ff00"}], "hazeLit": 1.0}
    dv = _relight(rgb, facing, flat_depth, None, None, json.dumps(dl))[0]
    assert torch.allclose(dv, torch.tensor([0.0, 0.5, 0.0]).expand_as(dv), atol=1e-6), dv[0, 0]

    # 10. Preview passes always leave with 3 channels (4 for the packed masks), whatever
    #     came in: a 1-channel depth and an RGBA rgb both broke texImage2D and blacked
    #     the preview (reported by Neko on v1.9.0).
    sent = {}
    class _Srv:
        class instance:
            @staticmethod
            def send_sync(name, payload):
                sent.update(payload)
    import sys, types
    sys.modules["server"] = types.SimpleNamespace(PromptServer=_Srv)
    try:
        _send_passes_to_frontend("1", torch.rand(1, H, W, 4), facing, torch.rand(1, H, W, 1),
                                 None, None, [half, None, None, None])
    finally:
        del sys.modules["server"]
    import base64 as _b64
    n_bytes = lambda k: len(_b64.b64decode(sent["passes"][k]))
    assert sent["passes"]["width"] == W and sent["passes"]["height"] == H
    assert n_bytes("rgb") == H * W * 3 and n_bytes("depth") == H * W * 3, (n_bytes("rgb"), n_bytes("depth"))
    assert n_bytes("masks") == H * W * 4 and sent["passes"]["maskSlots"] == [True, False, False, False]

    print("relighting_node self-check OK")


if __name__ == "__main__":
    demo()
