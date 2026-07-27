"""😺NKD Lens Distort — Brown-Conrady lens distortion, lateral chromatic
aberration and vignette in one node with a distort/undistort switch.

The node emits an NKD_LENSDATA cable carrying the exact coefficients (plus the
zoom and the reference frame size), so the return trip undoes precisely what the
outbound trip did — wire lens_data from the undistort node into the distort node
instead of retyping the numbers into a second set of widgets.

Direction convention follows nkd_perspective_dewarp._warp_image: the sampling
grid maps OUTPUT pixels back to SOURCE pixels. Brown-Conrady's closed form goes
ideal -> distorted, which is exactly what "undistort" needs (the output frame is
ideal space, the source is the distorted plate). "distort" is the other
direction and has no closed form, so it is solved by fixed-point iteration —
the same trick OpenCV's undistortPoints uses.

Normalised coordinates are isotropic: x and y are both divided by the frame's
half-diagonal, so r = 1 at the corners and a given k1 means the same amount of
barrel on 16:9 as on 1:1. Scaling each axis to [-1,1] independently (the naive
approach) makes the distortion elliptical on non-square frames.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional, Tuple

import torch
import torch.nn.functional as F

# comfy_api only exists inside ComfyUI. Everything above the _HAS_COMFY guard
# must import standalone so demo() runs with no PYTHONPATH tricks.
try:
    from typing_extensions import override
    from comfy_api.latest import ComfyExtension, io
    from comfy_api.latest._io import comfytype, ComfyTypeIO
    _HAS_COMFY = True
except ImportError:  # pragma: no cover - standalone test path
    _HAS_COMFY = False


# Fixed-point iterations for the inverse model. 5 is well past convergence for
# the |k1| <= 0.5 range the widgets allow; beyond ~0.7 no iteration count saves
# you, the map folds over itself.
_INV_ITERS = 5

_EDGE_MODES = {"black": "zeros", "edge": "border", "reflect": "reflection"}


@dataclass
class NKDLensData:
    """Coefficients + framing needed to reproduce (or undo) one lens warp."""
    k1: float
    k2: float
    k3: float
    p1: float
    p2: float
    center_x: float
    center_y: float
    squeeze: float
    zoom: float
    ref_width: int
    ref_height: int


# ---------------------------------------------------------------------------
# The distortion model
# ---------------------------------------------------------------------------

def _distort_norm(x, y, k1, k2, k3, p1, p2):
    """Brown-Conrady forward: ideal normalised coords -> distorted ones."""
    r2 = x * x + y * y
    radial = 1.0 + r2 * (k1 + r2 * (k2 + r2 * k3))
    xd = x * radial + (2.0 * p1 * x * y + p2 * (r2 + 2.0 * x * x))
    yd = y * radial + (p1 * (r2 + 2.0 * y * y) + 2.0 * p2 * x * y)
    return xd, yd


def _fold_radius(k1: float, k2: float, k3: float,
                 r_max: float = 1.8, n: int = 512) -> float:
    """Radius at which the forward map stops being injective.

    d/dr [r * radial(r)] = 1 + 3k1 r^2 + 5k2 r^4 + 7k3 r^6. Where that hits zero
    the mapping turns around and two different source radii land on the same
    distorted radius, so no inverse exists past it. A pure barrel folds at
    r = 1/sqrt(3|k1|), i.e. inside the frame (corner r = 1) as soon as
    |k1| > 1/3 — real territory, not a pathological case. Found by scanning
    rather than solving the sextic: it runs once per grid, on 512 samples.
    """
    r = torch.linspace(0.0, r_max, n)
    r2 = r * r
    deriv = 1.0 + r2 * (3.0 * k1 + r2 * (5.0 * k2 + r2 * 7.0 * k3))
    folded = (deriv <= 0.0).nonzero()
    if folded.numel() == 0:
        return r_max
    return float(r[folded[0].item()].item())


def _solve_radius(rd, k1, k2, k3, r_fold: float, iters: int = 24):
    """Invert r * radial(r) = rd by bisection on [0, r_fold].

    Not the fixed point r <- rd / radial(r): that is only a contraction for
    pincushion, and on barrel it stalls — at k1 = -0.5 it parks at 0.38 in
    normalised units, hundreds of pixels off, however long you run it.

    Not Newton either: the derivative vanishes at the fold, so for a radius near
    it Newton overshoots to the far bracket and then back, cycling forever
    instead of converging. Bisection has no derivative and the map is monotone
    on [0, r_fold] by construction, so 24 halvings land within ~1e-7 always.
    """
    # Past the fold the forward map simply has no preimage — the lens cannot
    # produce a radius that large. Clamp the request to the largest radius it
    # CAN produce, so those pixels smear along the edge instead of tearing.
    rf2 = r_fold * r_fold
    rd_max = r_fold * (1.0 + rf2 * (k1 + rf2 * (k2 + rf2 * k3)))
    target = rd.clamp(max=max(rd_max, 0.0))

    lo = torch.zeros_like(target)
    hi = torch.full_like(target, r_fold)
    for _ in range(iters):
        mid = 0.5 * (lo + hi)
        m2 = mid * mid
        f = mid * (1.0 + m2 * (k1 + m2 * (k2 + m2 * k3)))
        below = f < target
        lo = torch.where(below, mid, lo)
        hi = torch.where(below, hi, mid)
    return 0.5 * (lo + hi)


def _undistort_norm(xd, yd, k1, k2, k3, p1, p2, iters: int = _INV_ITERS):
    """Inverse of _distort_norm: radial part solved exactly by Newton, the small
    tangential part peeled off by an outer fixed point (it converges in one pass
    when p1 = p2 = 0, which is the usual case)."""
    r_fold = _fold_radius(k1, k2, k3)
    outer = 1 if (p1 == 0.0 and p2 == 0.0) else max(iters, 2)
    x, y = xd, yd
    for _ in range(outer):
        r2 = x * x + y * y
        dx = 2.0 * p1 * x * y + p2 * (r2 + 2.0 * x * x)
        dy = p1 * (r2 + 2.0 * y * y) + 2.0 * p2 * x * y
        tx, ty = xd - dx, yd - dy
        rd = torch.sqrt(tx * tx + ty * ty)
        r = _solve_radius(rd, k1, k2, k3, r_fold)
        # At the exact centre rd = 0 and the direction is undefined; the source
        # is the centre too, so scale 1 is the right answer there.
        safe = rd.clamp(min=1e-9)
        scale = torch.where(rd > 1e-9, r / safe, torch.ones_like(rd))
        x, y = tx * scale, ty * scale
    return x, y


def _frame_norm(h: int, w: int, lens: NKDLensData, device, dtype=torch.float32):
    """Per-output-pixel normalised coords (corner radius 1) plus the constants
    needed to map back to source pixels."""
    aspect = w / float(h)
    r_ref = math.sqrt(aspect * aspect + 1.0)     # half-diagonal, half-height units
    cxp = w * 0.5 + lens.center_x * w * 0.5      # optical centre, pixels
    cyp = h * 0.5 + lens.center_y * h * 0.5
    s = 2.0 / h                                  # pixels -> half-height units

    ys, xs = torch.meshgrid(
        torch.arange(h, device=device, dtype=dtype),
        torch.arange(w, device=device, dtype=dtype),
        indexing="ij",
    )
    u = (xs + 0.5 - cxp) * s / r_ref             # pixel centres, as _warp_image
    v = (ys + 0.5 - cyp) * s / r_ref
    return u, v, r_ref, cxp, cyp, s


def _ca_scale(u, v, ca: float, falloff: float):
    """Per-pixel channel scale for lateral chromatic aberration.

    Scaling the sampling radius by a constant `ca` already makes the fringe
    radial — the displacement is r*(ca-1), so exactly zero at the optical centre
    and largest at the corners (measured: 0.005 px at the centre vs 2.0 px at the
    edge for ca=1.01). What a constant cannot do is shape the RAMP, and real
    glass does not ramp linearly: the fringe stays invisible across most of the
    frame and then climbs hard in the outer third.

    `falloff` is that exponent: displacement ∝ r^falloff, normalised so the
    corner always lands on `ca` whatever the exponent. falloff = 1 reproduces
    the old linear behaviour exactly, so existing workflows do not shift.
    """
    if ca == 1.0:
        return 1.0
    if falloff == 1.0:
        return ca
    r = torch.sqrt(u * u + v * v).clamp(0.0, 1.0)
    return 1.0 + (ca - 1.0) * r.pow(max(falloff - 1.0, 0.0))


def _sample_grid(h: int, w: int, lens: NKDLensData, mode: str, ca: float,
                 device, dtype=torch.float32, ca_falloff: float = 1.0) -> torch.Tensor:
    """Build the [1,h,w,2] grid_sample grid for one channel scale `ca`."""
    u, v, r_ref, cxp, cyp, s = _frame_norm(h, w, lens, device, dtype)
    ca = _ca_scale(u, v, ca, ca_falloff)

    zoom = max(abs(lens.zoom), 1e-6)
    sq = max(abs(lens.squeeze), 1e-6)
    # Squeeze is the anamorphic x compression: it comes out of x before the
    # (circular) model and goes back in afterwards. Being a conjugation, it
    # inverts itself and needs no special casing per mode.
    #
    # Zoom does not. It is defined in RECTIFIED space, which is the output side
    # in undistort mode but the source side in distort mode — so it is applied
    # before the model in one and after it in the other. Applying it the same
    # way in both would make the return trip zoom twice instead of cancelling.
    if mode == "undistort":
        x = (u / zoom / sq) * ca
        y = (v / zoom) * ca
        xs_, ys_ = _distort_norm(x, y, lens.k1, lens.k2, lens.k3, lens.p1, lens.p2)
    else:
        x = (u / sq) * ca
        y = v * ca
        xs_, ys_ = _undistort_norm(x, y, lens.k1, lens.k2, lens.k3, lens.p1, lens.p2)
        xs_, ys_ = xs_ * zoom, ys_ * zoom

    spx = (xs_ * sq) * r_ref / s + cxp
    spy = ys_ * r_ref / s + cyp
    # align_corners=False normalisation, matching _warp_image.
    gx = (spx / w) * 2.0 - 1.0
    gy = (spy / h) * 2.0 - 1.0
    return torch.stack([gx, gy], dim=-1).unsqueeze(0)


def _warp(image: torch.Tensor, grid: torch.Tensor, padding_mode: str) -> torch.Tensor:
    """grid_sample a [B,H,W,C] image with a [1,h,w,2] grid. Bicubic to keep the
    warp crisp, clamped because bicubic overshoots (same call as _warp_image)."""
    b = image.shape[0]
    x = image.permute(0, 3, 1, 2)
    out = F.grid_sample(x, grid.expand(b, -1, -1, -1), mode="bicubic",
                        padding_mode=padding_mode, align_corners=False)
    return out.permute(0, 2, 3, 1).clamp(0.0, 1.0)


def _vignette(image: torch.Tensor, lens: NKDLensData, amount: float,
              falloff: float) -> torch.Tensor:
    """Darken towards the corners. Polynomial (r^falloff), not cos^4 — one
    controllable slider is what every grading tool actually ships."""
    if amount <= 0.0:
        return image
    b, h, w, c = image.shape
    u, v, _, _, _, _ = _frame_norm(h, w, lens, image.device, torch.float32)
    r = torch.sqrt(u * u + v * v).clamp(0.0, 1.0)
    m = (1.0 - amount * r.pow(falloff)).clamp(0.0, 1.0)[None, ..., None]
    out = image.clone()
    # Alpha is coverage, not light — vignetting it would eat the matte.
    rgb = min(c, 3)
    out[..., :rgb] = out[..., :rgb] * m
    return out


def _apply_lens(image: torch.Tensor, lens: NKDLensData, mode: str,
                ca_red: float, ca_blue: float, edge_mode: str,
                vignette_amount: float, vignette_falloff: float,
                ca_falloff: float = 1.0) -> torch.Tensor:
    """Full pipeline on a [B,H,W,C] float image in 0..1."""
    if image.dim() != 4:
        raise ValueError(f"expected a [B,H,W,C] image tensor, got {tuple(image.shape)}")
    b, h, w, c = image.shape
    src_dtype = image.dtype
    x = image.float()
    padding_mode = _EDGE_MODES.get(edge_mode, "zeros")

    has_ca = c >= 3 and (abs(ca_red - 1.0) > 1e-9 or abs(ca_blue - 1.0) > 1e-9)
    grid_g = _sample_grid(h, w, lens, mode, 1.0, x.device)

    if not has_ca:
        out = _warp(x, grid_g, padding_mode)
    else:
        # Each channel samples a slightly different radius: that separation at
        # the frame edge IS lateral chromatic aberration. Green is the reference.
        grid_r = _sample_grid(h, w, lens, mode, ca_red, x.device, ca_falloff=ca_falloff)
        grid_b = _sample_grid(h, w, lens, mode, ca_blue, x.device, ca_falloff=ca_falloff)
        r = _warp(x[..., 0:1], grid_r, padding_mode)
        g = _warp(x[..., 1:2], grid_g, padding_mode)
        bl = _warp(x[..., 2:3], grid_b, padding_mode)
        parts = [r, g, bl]
        if c > 3:  # alpha rides with green, it has no wavelength
            parts.append(_warp(x[..., 3:], grid_g, padding_mode))
        out = torch.cat(parts, dim=-1)

    out = _vignette(out, lens, vignette_amount, vignette_falloff)
    return out.to(src_dtype)


# ---------------------------------------------------------------------------
# Node
# ---------------------------------------------------------------------------

if _HAS_COMFY:

    # Same push the fSpy editor uses: the plumb-line editor needs the RESOLVED
    # input image, and reading a filename off the upstream node only ever works
    # for a directly-connected Load Image. Reused rather than re-written.
    try:
        from .nkd_fspy_camera import _send_source_to_widget
    except ImportError:  # pragma: no cover - standalone (pack dir on sys.path)
        from nkd_fspy_camera import _send_source_to_widget

    @comfytype(io_type="NKD_LENSDATA")
    class NKDLensDataType(ComfyTypeIO):
        Type = NKDLensData

    class NKDLensDistort(io.ComfyNode):
        @classmethod
        def define_schema(cls) -> io.Schema:
            return io.Schema(
                node_id="NKDLensDistort",
                display_name="😺NKD Lens Distort",
                category="😺NKD Nodes/3D",
                # Runnable on its own (blue play) so the editor can load the
                # resolved upstream image without running the whole graph.
                is_output_node=True,
                description=(
                    "Brown-Conrady lens distortion with chromatic aberration and "
                    "vignette. Set mode to Undistort to straighten a plate before "
                    "solving or generating, then feed lens_data into a second copy "
                    "in Distort mode to put the exact same lens back on the result. "
                    "Open the editor to trace features that should be straight and "
                    "solve k1/k2 from them."
                ),
                inputs=[
                    io.Image.Input("image"),
                    # Plumb-line control points, driven by the JS editor.
                    # multiline=False on purpose — a multiline String is a real DOM
                    # textarea that survives being hidden and paints as a giant
                    # column under the node.
                    io.String.Input("lens_state", default="{}", socketless=True,
                                    multiline=False),
                    io.Combo.Input("mode", options=["distort", "undistort"],
                                   default="distort", display_name="Mode",
                                   tooltip="Distort: bend a clean image as a lens would. "
                                           "Undistort: straighten a real plate."),
                    io.Float.Input("k1", default=0.0, min=-0.75, max=0.75, step=0.001,
                                   tooltip="Main barrel (negative) / pincushion (positive)."),
                    io.Float.Input("k2", default=0.0, min=-0.5, max=0.5, step=0.001,
                                   tooltip="Edge correction. Opposite sign to k1 gives "
                                           "moustache distortion."),
                    io.Float.Input("k3", default=0.0, min=-0.25, max=0.25, step=0.001,
                                   tooltip="Extreme-corner term. Only matters near fisheye."),
                    io.Float.Input("p1", default=0.0, min=-0.05, max=0.05, step=0.0005,
                                   tooltip="Tangential: vertical decentring of the lens "
                                           "elements. Keep tiny."),
                    io.Float.Input("p2", default=0.0, min=-0.05, max=0.05, step=0.0005,
                                   tooltip="Tangential: horizontal decentring. Keep tiny."),
                    io.Float.Input("center_x", default=0.0, min=-1.0, max=1.0, step=0.005,
                                   display_name="Center X",
                                   tooltip="Optical centre offset, fraction of half-width."),
                    io.Float.Input("center_y", default=0.0, min=-1.0, max=1.0, step=0.005,
                                   display_name="Center Y",
                                   tooltip="Optical centre offset, fraction of half-height."),
                    io.Float.Input("squeeze", default=1.0, min=0.25, max=4.0, step=0.01,
                                   display_name="Anamorphic Squeeze",
                                   tooltip="Anamorphic factor. 1.0 for spherical lenses, "
                                           "2.0 for a classic anamorphic."),
                    io.Float.Input("zoom", default=1.0, min=0.25, max=4.0, step=0.005,
                                   display_name="Zoom (direction follows Mode)",
                                   tooltip="Covers the empty corners the warp leaves. WHICH WAY "
                                           "depends on Mode: in Undistort raise it above 1, in "
                                           "Distort LOWER it below 1. That is not a quirk — zoom "
                                           "is measured in the rectified image, which is what "
                                           "makes it cancel exactly when lens_data feeds the "
                                           "return trip. Open the editor and switch Frame on to "
                                           "see the gaps you are covering."),
                    io.Float.Input("ca_red", default=1.0, min=0.98, max=1.02, step=0.0002,
                                   display_name="CA Red",
                                   tooltip="Radial scale of the red channel. 1.0 is off; "
                                           "1.002 is already a visible edge fringe."),
                    io.Float.Input("ca_blue", default=1.0, min=0.98, max=1.02, step=0.0002,
                                   display_name="CA Blue",
                                   tooltip="Radial scale of the blue channel."),
                    io.Float.Input("ca_falloff", default=1.0, min=1.0, max=6.0, step=0.05,
                                   display_name="CA Falloff",
                                   tooltip="How the fringe ramps out from the centre. 1 is "
                                           "linear; higher keeps the middle of the frame clean "
                                           "and concentrates the colour split in the corners, "
                                           "the way real glass behaves. The corner amount is "
                                           "always CA Red/Blue, whatever the exponent."),
                    io.Float.Input("vignette_amount", default=0.0, min=0.0, max=1.0, step=0.01,
                                   display_name="Vignette Amount"),
                    io.Float.Input("vignette_falloff", default=2.5, min=0.5, max=6.0, step=0.05,
                                   display_name="Vignette Falloff",
                                   tooltip="Higher keeps the centre clean and darkens only "
                                           "the corners."),
                    io.Combo.Input("edge_mode", options=["black", "edge", "reflect"],
                                   default="black", display_name="Edges",
                                   tooltip="What to sample where the warp reaches outside "
                                           "the frame."),
                    NKDLensDataType.Input(
                        "lens_data", optional=True,
                        tooltip="Connect the lens_data of the node that did the outbound "
                                "warp. When connected it OVERRIDES every coefficient "
                                "widget above (CA, vignette and edges stay local)."),
                ],
                outputs=[
                    io.Image.Output(display_name="image"),
                    NKDLensDataType.Output(
                        "lens_data",
                        tooltip="Wire into the node that reverses this warp."),
                ],
                hidden=[io.Hidden.unique_id],   # to target this node's editor
            )

        @classmethod
        def execute(cls, image, mode, k1, k2, k3, p1, p2, center_x, center_y,
                    squeeze, zoom, ca_red, ca_blue, vignette_amount,
                    vignette_falloff, edge_mode, lens_state="{}", ca_falloff=1.0,
                    lens_data: Optional[NKDLensData] = None) -> io.NodeOutput:
            h, w = int(image.shape[1]), int(image.shape[2])
            _send_source_to_widget(
                getattr(getattr(cls, "hidden", None), "unique_id", None),
                image, event="nkd-lens-source")
            if lens_data is not None:
                lens = lens_data
                ref_a = lens.ref_width / float(lens.ref_height)
                if abs(ref_a - w / float(h)) > 0.01:
                    # r is normalised against the current frame, so a different
                    # aspect means the return trip cannot cancel the outbound one.
                    import logging
                    logging.warning(
                        "[NKD Lens Distort] lens_data was captured at %dx%d (aspect "
                        "%.3f) but this image is %dx%d (aspect %.3f). The warp will "
                        "not cancel exactly — match the aspect to round-trip cleanly.",
                        lens.ref_width, lens.ref_height, ref_a, w, h, w / float(h))
            else:
                lens = NKDLensData(k1=k1, k2=k2, k3=k3, p1=p1, p2=p2,
                                   center_x=center_x, center_y=center_y,
                                   squeeze=squeeze, zoom=zoom,
                                   ref_width=w, ref_height=h)

            out = _apply_lens(image, lens, mode, ca_red, ca_blue, edge_mode,
                              vignette_amount, vignette_falloff, ca_falloff)
            return io.NodeOutput(out, lens)


# ---------------------------------------------------------------------------
# Self-check:  python nkd_lens_distort.py
# ---------------------------------------------------------------------------

def demo() -> None:
    torch.manual_seed(0)

    def lens(**kw):
        base = dict(k1=0.0, k2=0.0, k3=0.0, p1=0.0, p2=0.0, center_x=0.0,
                    center_y=0.0, squeeze=1.0, zoom=1.0,
                    ref_width=128, ref_height=96)
        base.update(kw)
        return NKDLensData(**base)

    # 1. The inverse really inverts the closed form out to the frame corner
    #    (r = 1), with tangential terms on, for barrel AND pincushion. Barrel is
    #    the case a fixed-point iteration silently fails at, so it is the one
    #    that matters here. Points past the fold radius are excluded: no inverse
    #    exists there, by construction, not by numerical failure.
    g = torch.linspace(-1.0, 1.0, 61)
    yy, xx = torch.meshgrid(g, g, indexing="ij")
    r = torch.hypot(xx, yy)
    for ks in (dict(k1=-0.30, k2=0.0, k3=0.0, p1=0.0, p2=0.0),          # barrel
               dict(k1=-0.35, k2=0.12, k3=-0.03, p1=0.004, p2=-0.003),  # moustache
               dict(k1=0.35, k2=-0.05, k3=0.0, p1=-0.002, p2=0.003)):   # pincushion
        dom = (r <= min(1.0, _fold_radius(ks["k1"], ks["k2"], ks["k3"]) - 1e-3))
        xd, yd = _distort_norm(xx, yy, **ks)
        xr, yr = _undistort_norm(xd, yd, **ks)
        err = torch.hypot(xr - xx, yr - yy)[dom].max().item()
        assert err < 1e-4, f"inverse failed for {ks}: max err {err}"

    # 1b. The fold radius is where the theory says it is, and nothing NaNs when
    #     the coefficients push the fold inside the visible frame.
    assert abs(_fold_radius(-0.48, 0.0, 0.0) - (1.0 / math.sqrt(3 * 0.48))) < 0.01
    wild = _undistort_norm(xx, yy, k1=-0.75, k2=0.0, k3=0.0, p1=0.0, p2=0.0)
    assert torch.isfinite(wild[0]).all() and torch.isfinite(wild[1]).all(), \
        "a folded map produced non-finite coordinates"

    # 2. Zero coefficients must be a true identity, not merely close — a
    #    half-pixel slip in the pixel-centre convention shows up right here.
    img = torch.rand(2, 96, 128, 3)
    ident = _apply_lens(img, lens(), "distort", 1.0, 1.0, "black", 0.0, 2.5)
    assert ident.shape == img.shape
    d = (ident - img).abs().max().item()
    assert d < 1e-4, f"identity warp shifted the image by {d}"

    # 3. Round trip through both modes lands back on the original geometry.
    #    Tolerance is loose: two bicubic resamples soften detail even when the
    #    mapping is exact, so this checks alignment, not sharpness.
    L = lens(k1=-0.25, k2=0.05)
    und = _apply_lens(img, L, "undistort", 1.0, 1.0, "edge", 0.0, 2.5)
    back = _apply_lens(und, L, "distort", 1.0, 1.0, "edge", 0.0, 2.5)
    core = (slice(None), slice(24, 72), slice(32, 96), slice(None))
    rt = (back[core] - img[core]).abs().mean().item()
    assert rt < 0.06, f"round trip drifted: mean abs {rt}"

    # 4. The two modes must bend opposite ways. Barrel compresses the edges, so
    #    in undistort mode an output corner reads from INSIDE the plate (the
    #    outer ring gets cropped — that is what zoom < 1 is for), while in
    #    distort mode it reads from OUTSIDE the frame, which is where the black
    #    corners of an added barrel come from.
    #    Reference is the identity grid, whose first sample sits at the centre
    #    of pixel 0 — (0.5/w)*2-1, not -1.0.
    ident_c = (0.5 / 128.0) * 2.0 - 1.0
    flat = _sample_grid(96, 128, lens(), "undistort", 1.0, img.device)
    assert abs(flat[0, 0, 0, 0].item() - ident_c) < 1e-5, "identity grid is not identity"
    und_c = _sample_grid(96, 128, lens(k1=-0.3), "undistort", 1.0, img.device)[0, 0, 0, 0].item()
    dis_c = _sample_grid(96, 128, lens(k1=-0.3), "distort", 1.0, img.device)[0, 0, 0, 0].item()
    assert und_c > ident_c + 0.05, f"barrel undistort should sample inward, got {und_c}"
    assert dis_c < ident_c - 0.05, f"barrel distort should sample outward, got {dis_c}"

    # 5. Isotropy: the same k1 on a wide frame and a square frame must bend the
    #    corner by the same fraction. This is what per-axis [-1,1] gets wrong.
    def corner_pull(w, h):
        L2 = NKDLensData(k1=-0.3, k2=0.0, k3=0.0, p1=0.0, p2=0.0, center_x=0.0,
                         center_y=0.0, squeeze=1.0, zoom=1.0,
                         ref_width=w, ref_height=h)
        gr = _sample_grid(h, w, L2, "undistort", 1.0, img.device)
        return gr[0, 0, 0, 0].item() / -1.0
    assert abs(corner_pull(128, 128) - corner_pull(192, 108)) < 0.02, \
        "distortion is not isotropic across aspect ratios"

    # 6. Chromatic aberration is RADIAL: it must grow towards the frame edge and
    #    leave the centre clean. Measured over bands rather than single pixels —
    #    one pixel can sit inside a flat patch and show nothing. The source is
    #    grey (R=G=B), so any channel split in the output is the CA itself.
    grey = torch.rand(1, 64, 64, 1).repeat(1, 1, 1, 3)
    ca = _apply_lens(grey, lens(), "distort", 1.02, 0.98, "edge", 0.0, 2.5)
    split = (ca[..., 0] - ca[..., 2]).abs()
    edge_split = split[:, :, :8].mean().item()
    mid_split = split[:, 28:36, 28:36].mean().item()
    assert edge_split > 4.0 * mid_split, \
        f"CA is not radial: edge {edge_split:.4f} vs centre {mid_split:.4f}"
    none = _apply_lens(grey, lens(), "distort", 1.0, 1.0, "edge", 0.0, 2.5)
    assert (none[..., 0] - none[..., 2]).abs().max().item() < 1e-6, \
        "CA at 1.0/1.0 still split the channels"

    # 7. Vignette darkens corners, preserves the centre, and leaves alpha alone.
    white = torch.ones(1, 64, 64, 4)
    vig = _vignette(white, lens(), 0.6, 2.5)
    assert abs(vig[0, 32, 32, 0].item() - 1.0) < 1e-3, "vignette dimmed the centre"
    assert vig[0, 0, 0, 0].item() < 0.5, "vignette did not darken the corner"
    assert abs(vig[0, 0, 0, 3].item() - 1.0) < 1e-6, "vignette ate the alpha"

    # 8. Zoom is undone by the return trip: a zoomed undistort followed by the
    #    same lens in distort mode restores the framing.
    Lz = lens(k1=-0.2, zoom=1.15)
    a = _apply_lens(img, Lz, "undistort", 1.0, 1.0, "edge", 0.0, 2.5)
    b = _apply_lens(a, Lz, "distort", 1.0, 1.0, "edge", 0.0, 2.5)
    zrt = (b[core] - img[core]).abs().mean().item()
    assert zrt < 0.06, f"zoom did not round trip: mean abs {zrt}"

    print("nkd_lens_distort self-check OK")


if __name__ == "__main__":
    demo()
