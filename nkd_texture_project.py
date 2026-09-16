"""Projection painting: reproject inpainted viewport renders back onto a mesh.

The loop this serves — render a view in 😺NKD Preview 3D, inpaint it, project it
back — is the one Stable Projectorz and hunzmusic/ComfyUI-Hunyuan3DTools both
implement. What is different here is the SHAPE of it, borrowed from Impact Pack's
SEGS: every view is packaged as one cable (😺NKD Projection Pass), the packages
fan into ONE bake node, and the merge happens once, at the end.

Why batch and not an accumulator that grows run after run: the merge normalises
by the total weight,

    colour = sum(colour_i * w_i) / sum(w_i)

so accumulating incrementally makes the result depend on the ORDER you happened
to paint in — a good early view ends up buried under a mediocre later one unless
the weight buffer is carried between runs. Doing every pass in one node makes the
normalisation correct by construction, keeps the node a pure function of its
inputs (so ComfyUI's cache works, and there is no state on disk or in the
browser), and lets you re-bake all views at once when you change the falloff.
`demo()` block 6 pins the order-independence.

v0 paints VERTEX COLOURS, not a UV texture. That is deliberate: it needs no
rasteriser, no atlas and no shader work, so it validates the whole loop. The UV
path is the same projection maths reading a UV-space position map instead of the
vertex list.

Known limit, by design in v0: the projection assumes the mesh sits where its own
coordinates put it. The Preview 3D object panel's transform lives in the widget
and never reaches Python, so bake with the object at Reset.
"""

import math
from dataclasses import dataclass, field, fields
from typing import Optional

import torch
import torch.nn.functional as F

try:
    from .nkd_vfx_helpers import _gaussian, _mask_grow, _resize_mask, _work_device
    from .nkd_camera_delta import _quat, _vec
except ImportError:  # pragma: no cover - standalone (pack dir on sys.path)
    from nkd_vfx_helpers import _gaussian, _mask_grow, _resize_mask, _work_device
    from nkd_camera_delta import _quat, _vec

# comfy_api only exists inside ComfyUI. Everything above the _HAS_COMFY guard
# must import standalone so demo() runs with no PYTHONPATH tricks.
try:
    from typing_extensions import override
    from comfy_api.latest import ComfyExtension, io
    from comfy_api.latest._io import comfytype, ComfyTypeIO
    _HAS_COMFY = True
except ImportError:  # pragma: no cover - standalone test path
    _HAS_COMFY = False


# Slots the bake node grows. Impact needs a separate SEGSConcat because SEGSPaste
# takes a single SEGS; Autogrow (already used by the Relight for its per-light
# masks) makes that node unnecessary here.
PASS_SLOTS = 8

# Shown when an existing texture is resampled down to a smaller texture_size.
# Fewer texels per triangle makes each chart's padding a bigger share of it, and
# padding is the part a bake cannot reproduce exactly: at 1024 a 19827-face model
# averages about 30 texels a face, so a four-texel gutter is half the triangle.
WARN_DOWNSCALED = (
    "\n  WARNING: the mesh's own texture is {w}x{h} and this resampled it down. Set "
    "texture_size to {want} to keep its detail, and to keep small charts bigger "
    "than their padding."
)

# Shown when a mesh that already carries a texture falls through to the vertex
# colour path. It is the one outcome that silently wrecks a good model, so it
# gets a line of its own rather than a parenthesis.
WARN_TEXTURE_LOST = (
    "\n  WARNING: this mesh already had a texture. Vertex colours cannot carry its "
    "detail, and a viewer may show them instead of it. Bake after Unwrap Mesh UVs "
    "and Bake Texture From Voxel, not on the raw shape."
)


# How far a repainted chart's colour is carried into the UV gutter. Four texels is
# the usual padding an atlas ships with, and it is what bilinear and the first mip
# reach for at a chart edge.
_GUTTER_PAD = 4

# Width, in cosine, of the ramp above angle_threshold over which a projection goes
# from "not trusted at all" to "fully trusted". 0.15 is about nine degrees at the
# default 75: enough that the edge where a surface turns away from the camera
# fades into the existing texture instead of being cut with a knife.
_FACING_RAMP = 0.15

# Unpainted vertices with no colour of their own fall back to this.
_NEUTRAL = 0.5


@dataclass
class NKDProjPass:
    """One inpainted view plus the camera it was rendered from."""
    image: torch.Tensor                      # (H, W, 3), 0..1
    camera: dict                             # camera_info from the viewport
    mask: Optional[torch.Tensor] = None      # (H, W) where this pass may paint
    silhouette: Optional[torch.Tensor] = None  # (H, W) where the render has model at all
    weight: float = 1.0
    label: str = "pass"
    mirror: str = "none"                     # symmetry axis this VIEW also paints across

    def to(self, device):
        """Move every tensor this carries onto `device`.

        One place that knows the fields. Two call sites were moving `image` and
        `mask` by hand, so adding `silhouette` left it on the CPU and grid_sample
        blew up on the mismatch. A field added later is covered for free.
        """
        for f in fields(self):
            value = getattr(self, f.name)
            if isinstance(value, torch.Tensor):
                setattr(self, f.name, value.to(device))
        return self


# --------------------------------------------------------------------------
# Projection
# --------------------------------------------------------------------------

def _qconj(q):
    return torch.stack([-q[0], -q[1], -q[2], q[3]])


def _qrot(q, v):
    """Rotate rows of v (N,3) by unit quaternion q (xyzw)."""
    u, w = q[:3], q[3]
    return (2.0 * (v @ u).unsqueeze(-1) * u
            + (w * w - u.dot(u)) * v
            + 2.0 * w * torch.cross(u.expand_as(v), v, dim=-1))


def _project(points, camera, width, height):
    """World points (N,3) -> NDC in [-1,1] (x right, y up), distance in front of
    the camera, and the camera position.

    three.js convention, which is what the viewport reports: the camera looks
    down its local -Z and `fov` is VERTICAL, in degrees.

    Aspect is taken from the IMAGE, not from camera_info: capture() swaps the
    camera's aspect to the export size and puts it back afterwards, so the
    reported one is the viewport's shape, not the frame's.
    """
    dev, dt = points.device, points.dtype
    cam = camera if isinstance(camera, dict) else {}
    pos = torch.tensor(_vec(cam.get("position")), device=dev, dtype=dt)
    q = torch.tensor(_quat(cam), device=dev, dtype=dt)

    v = _qrot(_qconj(q), points - pos)
    z = -v[:, 2]
    tan_h = math.tan(math.radians(float(cam.get("fov", 35.0))) * 0.5)
    safe = z.clamp(min=1e-6)
    ndc = torch.stack([v[:, 0] / (safe * tan_h * (width / height)),
                       v[:, 1] / (safe * tan_h)], dim=-1)
    return ndc, z, pos


def _nearest_z(ndc, z, front, res):
    """Cheapest self-occlusion test there is: splat every vertex into a coarse
    z-buffer and keep the closest per cell. A vertex materially behind the
    closest thing in its cell is hidden.

    The resolution is derived from the vertex count so a few vertices land per
    cell — at the render's own resolution a 38k-vertex mesh is sparser than one
    vertex per pixel and the buffer would be full of holes. Matching the cell
    size to the vertex density is not a compromise for vertex colours: the
    colour resolution IS the vertex resolution.

    ponytail: point z-buffer, no triangles. Its ceiling is thin geometry — a
    cape a few vertices thick can fail to hide what is behind it. Upgrade path
    is the viewport's depth pass (already exported) once the UV bake needs it.
    """
    ix = (((ndc[:, 0] + 1.0) * 0.5) * res).long().clamp(0, res - 1)
    iy = (((1.0 - ndc[:, 1]) * 0.5) * res).long().clamp(0, res - 1)
    flat = iy * res + ix
    zbuf = torch.full((res * res,), float("inf"), device=z.device, dtype=z.dtype)
    if front.any():
        zbuf.scatter_reduce_(0, flat[front], z[front], reduce="amin", include_self=True)
    return zbuf[flat]


def _sample(plane, ndc, padding):
    """Bilinear sample of a (C,H,W) plane at NDC points -> (N,C).

    grid_sample's y runs DOWN from -1, the viewport's NDC y runs up: hence -y.
    """
    grid = torch.stack([ndc[:, 0], -ndc[:, 1]], dim=-1).view(1, 1, -1, 2)
    out = F.grid_sample(plane.unsqueeze(0), grid, mode="bilinear",
                        padding_mode=padding, align_corners=False)
    return out[0, :, 0, :].transpose(0, 1)


# --------------------------------------------------------------------------
# Bake
# --------------------------------------------------------------------------

def _srgb_to_linear(c):
    return torch.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _reflect(v, origin, normal):
    """Mirror rows of v (N,3) across the plane through `origin` with unit `normal`."""
    return v - 2.0 * ((v - origin) @ normal).unsqueeze(-1) * normal


def bake_projection(points, normals, passes, base=None, angle_threshold=75.0,
                       falloff=6.0, occlusion=True, occlusion_bias=0.02,
                       density=4.0, to_linear=False, mirror=None):
    # `mirror` is a dict {axis: (origin, normal)}; each pass picks its own axis.
    """Merge every pass onto a set of points with normals.

    The points are mesh vertices or the covered texels of a UV atlas: the
    projection does not care which, so both bakes share this one kernel.

    Returns (colours (N,3) in 0..1, painted (N,) bool, per-pass share).

    `mirror` maps an axis name to an (origin, normal) plane. A pass whose `mirror`
    names one of them projects every point twice, as itself and as its reflection,
    and a reflection that lands on painted surface hands its colour back to the
    point. On a symmetric model that paints both headlights from one view, or the
    far side of a head from the near one. It is per PASS because a frontal view
    already covers both sides and mirroring it only doubles it up; the side view
    is the one that needs reflecting. The reflected image of the model coincides
    with the model, so reflected points are tested for visibility among
    themselves, exactly like the direct ones.

    `to_linear` converts the sampled image colours from sRGB before blending. A
    render is sRGB; a texture image is too, and a viewer decodes it, so the
    texture path leaves it alone. glTF's COLOR_0 is LINEAR, and core writes and
    reads it as-is, so the vertex-colour path has to convert or the paint lands
    twice as bright as the colours around it (measured on a real model: 2.06x).

    The weight of a pass at a vertex is cos(view angle) ** falloff, zeroed when
    the vertex faces away past the threshold, is off-frame, is occluded, or the
    pass's mask says not to paint there. The high exponent (Hunyuan3DTools uses
    6) is what makes the most head-on view win outright instead of every view
    averaging into mud.
    """
    n_v = points.shape[0]
    num = torch.zeros((n_v, 3), device=points.device, dtype=points.dtype)
    den = torch.zeros((n_v,), device=points.device, dtype=points.dtype)
    # How much of each point the passes COVER, 0..1, kept apart from `den`. The
    # weights are normalised against each other, so on their own they can only
    # say which pass wins, never how much to keep of the texture underneath: a
    # texel with a weight of 0.0003 would be replaced outright. Coverage is the
    # absolute version, without the falloff exponent, and it is what blends the
    # result into the existing texture at every edge.
    cover = torch.zeros((n_v,), device=points.device, dtype=points.dtype)
    cos_min = math.cos(math.radians(max(0.0, min(89.9, angle_threshold))))
    res = int(max(16, min(1024, math.sqrt(max(n_v, 1) / max(density, 0.5)))))
    shares = []

    for p in passes:
      img = p.image
      height, width = img.shape[0], img.shape[1]
      reach = 0
      views = [(points, normals)]
      plane = (mirror or {}).get(str(p.mirror).upper())
      if plane is not None:
          origin, normal = plane
          views.append((_reflect(points, origin, normal),
                        _reflect(normals, torch.zeros_like(origin), normal)))
      for points_v, normals_v in views:
        ndc, z, cam_pos = _project(points_v, p.camera, width, height)

        front = z > 1e-6
        w = front & (ndc.abs().amax(dim=-1) <= 1.0)
        w = w.to(points_v.dtype)

        to_cam = cam_pos - points_v
        to_cam = to_cam / to_cam.norm(dim=-1, keepdim=True).clamp(min=1e-9)
        facing = (normals_v * to_cam).sum(dim=-1)
        # Soft gate on the angle: 0 at the threshold, 1 a ramp above it.
        gate = ((facing - cos_min) / _FACING_RAMP).clamp(0.0, 1.0)
        a = w * gate                                   # absolute coverage
        w = w * gate * facing.clamp(min=0.0) ** falloff

        if occlusion:
            nearest = _nearest_z(ndc, z, front, res)
            # Relative bias: the tolerance has to scale with distance, a fixed
            # epsilon that works at 2 units is invisible at 200.
            visible = (z <= nearest * (1.0 + occlusion_bias) + 1e-4).to(points_v.dtype)
            w, a = w * visible, a * visible

        if p.mask is not None:
            m = _sample(p.mask.unsqueeze(0), ndc, "zeros")[:, 0].clamp(0.0, 1.0)
            w, a = w * m, a * m
        if p.silhouette is not None:
            # Nothing outside the rendered model is the model. Without this, a texel
            # that projects just off the silhouette, or onto a hole in the render,
            # is painted with the backdrop.
            sil = _sample(p.silhouette.unsqueeze(0), ndc, "zeros")[:, 0].clamp(0.0, 1.0)
            w, a = w * sil, a * sil

        w = w * float(p.weight)
        colour = _sample(img.permute(2, 0, 1), ndc, "border")
        if to_linear:
            colour = _srgb_to_linear(colour.clamp(0.0, 1.0))
        num += colour * w.unsqueeze(-1)
        den += w
        cover += a
        reach += int((w > 1e-8).sum().item())
      shares.append((p.label, reach))

    painted = den > 1e-8
    out = (base.clone() if base is not None
           else torch.full((n_v, 3), _NEUTRAL, device=points.device, dtype=points.dtype))
    if painted.any():
        proj = num[painted] / den[painted].unsqueeze(-1)
        blend = cover[painted].clamp(0.0, 1.0).unsqueeze(-1)
        out[painted] = out[painted] * (1.0 - blend) + proj * blend
    return out.clamp(0.0, 1.0), painted, shares


# --------------------------------------------------------------------------
# Geometry
# --------------------------------------------------------------------------

def _placed(parts, info):
    """`parts` with the Load3D placement applied, for projecting against.

    The viewport renders the model AT this transform, so that is where the camera
    saw it; projecting the untransformed vertices lands the paint somewhere else
    entirely. Only the geometry used for projection moves. The mesh that comes out
    keeps its own coordinates, because the placement still lives on the wire and
    whatever shows the result will apply it again.
    """
    t = info[0] if isinstance(info, (list, tuple)) and info else info
    if not isinstance(t, dict):
        return parts
    pos = torch.tensor(_vec(t.get("position")), dtype=torch.float32)
    quat = torch.tensor(_quat(t), dtype=torch.float32)
    scale = torch.tensor(_vec(t.get("scale"), (1.0, 1.0, 1.0)), dtype=torch.float32)
    if (torch.equal(pos, torch.zeros(3)) and torch.equal(scale, torch.ones(3))
            and torch.equal(quat, torch.tensor([0.0, 0.0, 0.0, 1.0]))):
        return parts                      # identity: leave the tensors untouched

    out = dict(parts)
    out["vertices"] = _qrot(quat, parts["vertices"] * scale) + pos
    normals = parts["normals"]
    if normals is not None:
        # Inverse transpose of the TRS: a non-uniform scale tilts a normal the
        # OTHER way from the surface, so dividing is what keeps it perpendicular.
        safe = torch.where(scale.abs() < 1e-9, torch.ones_like(scale), scale)
        normals = _qrot(quat, normals / safe)
        out["normals"] = normals / normals.norm(dim=-1, keepdim=True).clamp(min=1e-9)
    return out



def _mirror_plane(axis, info=None):
    """(origin, unit normal) of the model's symmetry plane, in PLACED space.

    The plane is model-space `axis = 0`. A Load3D placement moves and turns the
    model, so the plane goes with it: through the placed origin, along the rotated
    axis. Uniform scale leaves a plane a plane; a non-uniform one would not, and
    that case is not handled.
    """
    idx = {"X": 0, "Y": 1, "Z": 2}.get(str(axis).upper())
    if idx is None:
        return None
    normal = torch.zeros(3); normal[idx] = 1.0
    origin = torch.zeros(3)
    t = info[0] if isinstance(info, (list, tuple)) and info else info
    if isinstance(t, dict):
        origin = torch.tensor(_vec(t.get("position")), dtype=torch.float32)
        normal = _qrot(torch.tensor(_quat(t), dtype=torch.float32), normal.unsqueeze(0))[0]
    return origin, normal / normal.norm().clamp(min=1e-9)


def _vertex_normals(verts, faces):
    """Area-weighted smooth vertex normals, in torch.

    Written here rather than taken from trimesh because the meshes this node is
    aimed at (Trellis2, Pixal3D) arrive as a core MESH of plain tensors, and the
    pack ships no dependencies.
    """
    tri = verts[faces]
    face_n = torch.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0], dim=-1)
    out = torch.zeros_like(verts)
    out.index_add_(0, faces.reshape(-1), face_n.repeat_interleave(3, dim=0))
    return out / out.norm(dim=-1, keepdim=True).clamp(min=1e-9)


# --------------------------------------------------------------------------
# Nodes
# --------------------------------------------------------------------------

if _HAS_COMFY:

    import os

    import numpy as np

    import folder_paths
    from comfy_api.latest import Types
    from comfy_extras.nodes_save_3d import get_mesh_batch_item

    try:
        from .nkd_preview_3d import TrimeshIO, _string_to_model_ref
        from .nkd_vfx_helpers import _safe_join
    except ImportError:  # pragma: no cover - standalone (pack dir on sys.path)
        from nkd_preview_3d import TrimeshIO, _string_to_model_ref
        from nkd_vfx_helpers import _safe_join

    # Core already ships the UV-space rasteriser, the gutter fill and the UV
    # normalisation that ApplyTextureToMesh uses, all in torch. Writing any of
    # them again here would be a second implementation to keep in sync, and
    # _normalize_uvs_to_unit in particular has to be the SAME one or this node's
    # texture and core's would disagree about where a texel lives.
    try:
        from comfy_extras.nodes_mesh_postprocess import (
            _interp_vertex_attr, _normalize_uvs_to_unit, _rasterize_uv_barycentric,
            _seam_fill,
        )
        _HAS_UV_BAKE = True
    except ImportError:  # pragma: no cover - older core
        _HAS_UV_BAKE = False

    def _model_path(path: str) -> str:
        """Absolute path for a model reference, kept inside input/output."""
        ref = _string_to_model_ref(path)
        root = (folder_paths.get_input_directory() if ref["type"] == "input"
                else folder_paths.get_output_directory())
        full = _safe_join(root, ref["subfolder"], ref["filename"])
        if not full or not os.path.isfile(full):
            raise ValueError(f"no model file at {path!r} under the input or output folder")
        return full

    def _load_mesh_file(path=None, file_obj=None, file_type=None):
        """Load a model file, from a path or straight from bytes, as one Trimesh.

        NOT trimesh.load(..., force="mesh"): that is exactly what drops COLOR_0 on
        a generator's GLB (see the Hy3D Load Mesh note in CLAUDE.md). Load the
        scene and flatten it, which keeps the colours and the node transforms.
        """
        import trimesh

        loaded = (trimesh.load(path, process=False) if path is not None
                  else trimesh.load(file_obj=file_obj, file_type=file_type, process=False))
        if hasattr(loaded, "geometry"):
            parts = list(loaded.geometry.values())
            # One geometry is the normal case; taking it directly avoids putting a
            # textured mesh through a material merge that has nothing to merge.
            loaded = parts[0] if len(parts) == 1 else loaded.dump(concatenate=True)
        if not hasattr(loaded, "faces"):
            raise ValueError("that file has no faces to paint (a gaussian splat or "
                             "a point cloud carries no surface)")
        return loaded

    def _mesh_parts(model):
        """Whatever plugged into `mesh` -> tensors, plus the MESH it came from.

        Same set the viewport accepts, so anything you can look at you can paint.
        `source` is the original core MESH when there was one, so everything this
        node does not touch (metallic roughness, unlit, material) survives.
        """
        # Types.MESH before any duck-typing: it carries .vertices and .faces too,
        # so "looks like a mesh" would swallow it and hand torch tensors to code
        # expecting trimesh's numpy arrays.
        if isinstance(model, Types.MESH):
            vertices, faces, colors, uvs, normals = get_mesh_batch_item(model, 0)
            texture = model.texture[0] if model.texture is not None else None
            return {"vertices": vertices, "faces": faces, "uvs": uvs,
                    "colors": colors, "normals": normals, "texture": texture,
                    "source": model}

        if isinstance(model, Types.File3D):
            # A File3D is just as often a BytesIO as a path (Trellis2 and friends
            # hand one over without ever touching disk), so read it as a stream
            # rather than resolving a filename that may not exist.
            model = _load_mesh_file(file_obj=model.get_data(),
                                    file_type=model.format or "glb")
        elif not (hasattr(model, "vertices") and hasattr(model, "faces")):
            if not isinstance(model, str) or not model.strip():
                raise ValueError("mesh input is empty: wire a mesh, a TRIMESH or a model file")
            model = _load_mesh_file(_model_path(model))

        as_t = lambda a, dt=torch.float32: torch.tensor(np.asarray(a), dtype=dt)
        visual = getattr(model, "visual", None)
        uv = getattr(visual, "uv", None)
        # A GLB comes back with a PBRMaterial, whose base colour is on
        # `baseColorTexture`; only the older SimpleMaterial calls it `image`.
        # Reading just one of the two silently loses the texture we are repainting.
        material = getattr(visual, "material", None)
        image = getattr(material, "baseColorTexture", None)
        if image is None:
            image = getattr(material, "image", None)
        colors = getattr(visual, "vertex_colors", None)
        if colors is None:
            # A glTF with COLOR_0 *and* a material comes back as TextureVisuals, and
            # then the colours are not on `vertex_colors` at all: trimesh parks them
            # in `vertex_attributes['color']` (same place _trimesh_to_temp_glb in
            # nkd_preview_3d has to look). Miss this and every unpainted vertex of a
            # vertex-coloured model goes neutral grey.
            colors = (getattr(visual, "vertex_attributes", None) or {}).get("color")
        if colors is not None:
            colors = np.asarray(colors)
            if colors.dtype.kind in "ui":
                colors = colors.astype(np.float32) / 255.0
            colors = colors[:, :3]
        return {
            "vertices": as_t(model.vertices),
            "faces": as_t(model.faces, torch.int64),
            # trimesh keeps UVs with v UP (it flips glTF's on import,
            # exchange/gltf/__init__.py:1670, and back on export). Core's rasteriser
            # and the texture's pixel rows both run v DOWN, so hand it 1-v or every
            # chart bakes into its vertically mirrored spot in the atlas: the face
            # looks "untouched" because its texels were never written, and the
            # jacket gets the face.
            "uvs": None if uv is None else as_t(uv) * torch.tensor([1.0, -1.0]) + torch.tensor([0.0, 1.0]),
            "colors": None if colors is None or len(colors) != len(model.vertices)
                      else as_t(colors),
            "normals": as_t(model.vertex_normals),
            "texture": None if image is None else as_t(np.asarray(image)[..., :3]) / 255.0,
            "source": None,
        }

    def bake_to_texture(parts, passes, texture_size, device, **kw):
        """Repaint the mesh's existing UV layout. Returns (texture HWC, painted, total, shares).

        Only covered texels go through the projection: a texel with no triangle on
        it has no position to project, and feeding the empty ones in would also
        pollute the hidden-surface buffer with points that are not on the surface.
        """
        faces = parts["faces"].long()
        uv_np = _normalize_uvs_to_unit(parts["uvs"].cpu().numpy().astype(np.float32))

        face_idx, bary, cov = _rasterize_uv_barycentric(
            faces.cpu().numpy(), uv_np, texture_size)
        # The rasteriser always lands on comfy's own device, whatever `device`
        # the passes came in on, so take ITS device as the one everything meets
        # on. Assuming they agree works right up until they do not.
        device = face_idx.device
        verts = parts["vertices"].to(device)
        faces = faces.to(device)
        normals = parts["normals"]
        normals = (_vertex_normals(verts, faces) if normals is None
                   else normals.to(device))
        for p in passes:
            p.to(device)
        if kw.get("mirror"):
            kw["mirror"] = {k: (o.to(device), n.to(device)) for k, (o, n) in kw["mirror"].items()}

        pos_map = _interp_vertex_attr(verts, faces, face_idx, bary, cov)
        nrm_map = _interp_vertex_attr(normals, faces, face_idx, bary, cov)

        base = parts["texture"]
        had_texture = base is not None
        size = int(texture_size)
        if base is None:
            tex = torch.full((size, size, 3), _NEUTRAL, device=device)
        else:
            tex = base.to(device)
            if tex.shape[0] != size or tex.shape[1] != size:
                tex = F.interpolate(tex.permute(2, 0, 1).unsqueeze(0), size=(size, size),
                                    mode="bilinear", align_corners=False)[0].permute(1, 2, 0)
            tex = tex.contiguous()

        idx = cov.reshape(-1).nonzero(as_tuple=True)[0]
        flat = tex.reshape(-1, 3)
        colours, painted, shares = bake_projection(
            pos_map.reshape(-1, 3)[idx], nrm_map.reshape(-1, 3)[idx], passes,
            base=flat[idx], **kw)
        flat[idx] = colours
        tex = flat.view(size, size, 3)

        # Bilinear and mip sampling reach past a chart's edge, so a repainted chart
        # needs its padding repainted too.
        #
        # But ONLY around what we repainted. A mesh that arrived with a texture
        # arrived with a gutter that already matched it, and the fill is nearest
        # covered texel: between two neighbouring charts of different colours it
        # hands the padding to whichever is nearer, which is not always the one it
        # belonged to. Run over the whole atlas it rewrites two thirds of the
        # padding, and with thousands of small charts almost everything is padding.
        # Measured on a 19827-face model: 0% of covered texels changed, 65% of
        # uncovered ones did, up to full range.
        touched = torch.zeros(size * size, dtype=torch.bool, device=tex.device)
        touched[idx] = painted
        touched = touched.view(size, size)
        if had_texture:
            halo = F.max_pool2d(touched.view(1, 1, size, size).float(),
                                _GUTTER_PAD * 2 + 1, stride=1, padding=_GUTTER_PAD)
            need = (halo[0, 0] > 0) & ~cov
            # Seed from what we REPAINTED, not from coverage: inside the halo the
            # nearest covered texel can belong to a neighbouring chart we never
            # touched, which is the same wrong-chart bleed in miniature.
            seed = touched
        else:
            need, seed = ~cov, cov         # nothing to preserve: fill it all
        if need.any():
            filled = torch.as_tensor(_seam_fill(tex.cpu().numpy(), seed.cpu().numpy()),
                                     dtype=torch.float32).to(tex.device)
            tex = torch.where(need.unsqueeze(-1), filled, tex)
        # Always back on the CPU: the caller stores it in a MESH, and the rasteriser's
        # device is an internal detail nobody downstream should have to know.
        return tex.clamp(0.0, 1.0).cpu(), int(painted.sum().item()), int(idx.numel()), shares

    @comfytype(io_type="NKD_PROJ")
    class NKDProjType(ComfyTypeIO):
        Type = NKDProjPass

    class NKDProjectionPass(io.ComfyNode):
        @classmethod
        def define_schema(cls) -> io.Schema:
            return io.Schema(
                node_id="NKDProjectionPass",
                display_name="😺NKD Projection Pass",
                category="😺NKD Nodes/3D",
                description="Packages one inpainted viewport render and the camera it "
                            "came from into a single cable, ready to fan into "
                            "😺NKD Bake Projection. One of these per view.",
                inputs=[
                    io.Image.Input("image",
                                   tooltip="The edited view. Same framing as the render "
                                           "that produced camera_info. Resolution may "
                                           "differ, the projection is normalised."),
                    io.Load3DCamera.Input("camera_info",
                                          tooltip="camera_info from the 😺NKD Preview 3D "
                                                  "that rendered this view."),
                    io.Mask.Input("silhouette", optional=True,
                                  tooltip="Where the render has model at all: the `mask` "
                                          "output of the same 😺NKD Preview 3D. Wire it. "
                                          "Without it a surface that projects just off the "
                                          "model, or onto a gap in it, is painted with the "
                                          "backdrop."),
                    io.Int.Input("silhouette_erode", default=4, min=0, max=64, step=1,
                                 optional=True,
                                 tooltip="Pulls the silhouette in by this many pixels. Its "
                                         "edge pixels are a blend of model and backdrop, and "
                                         "they sit where the surface is most edge on, which "
                                         "is where a projection is least trustworthy."),
                    io.Mask.Input("mask", optional=True,
                                  tooltip="Where this pass is allowed to paint, normally "
                                          "the same mask you inpainted with. Without one "
                                          "the whole view projects, which overwrites good "
                                          "texels with re-rendered ones."),
                    io.Float.Input("weight", default=1.0, min=0.0, max=10.0, step=0.05,
                                   tooltip="Multiplies this pass's say in the merge. 0 "
                                           "mutes it without unwiring."),
                    io.Combo.Input("mirror", options=["none", "X", "Y", "Z"], default="none",
                                   optional=True,
                                   tooltip="Also paint across the model's symmetry plane, in "
                                           "its own space: X mirrors left and right. For a "
                                           "SIDE view, so one pass does both headlights or "
                                           "carries the near side of a head to the far side. "
                                           "Leave a frontal view at none: it already covers "
                                           "both sides."),
                    io.Int.Input("feather", default=8, min=0, max=256, step=1,
                                 tooltip="Softens the mask inwards, so the blend never "
                                         "reaches surface you did not paint."),
                ],
                outputs=[NKDProjType.Output(display_name="projection")],
            )

        @classmethod
        def execute(cls, image, camera_info, weight=1.0, feather=8, mask=None,
                    silhouette=None, silhouette_erode=4, mirror="none") -> io.NodeOutput:
            img = image[0, ..., :3].float()
            height, width = img.shape[0], img.shape[1]

            sil = None
            if silhouette is not None:
                sil = silhouette[0] if silhouette.dim() == 3 else silhouette
                if sil.shape[0] != height or sil.shape[1] != width:
                    sil = _resize_mask(sil.unsqueeze(0), width, height)[0]
                sil = sil.float().clamp(0.0, 1.0)
                if silhouette_erode > 0:
                    # Erode by dilating the hole (_mask_grow only grows), then feather
                    # the same distance back INWARDS: blur, and clip to the eroded
                    # edge so the ramp never reaches out past it. The seam where the
                    # projection stops is now a fade, not a cut.
                    n = int(silhouette_erode)
                    hard = (1.0 - _mask_grow(1.0 - sil.unsqueeze(0), n, 0)[0]).clamp(0.0, 1.0)
                    soft = _gaussian(hard.view(1, 1, height, width), n)[0, 0]
                    sil = (soft * hard).clamp(0.0, 1.0)

            m = None
            if mask is not None:
                m = mask[0] if mask.dim() == 3 else mask
                if m.shape[0] != height or m.shape[1] != width:
                    m = _resize_mask(m.unsqueeze(0), width, height)[0]
                m = m.float().clamp(0.0, 1.0)
                if feather > 0:
                    # Blur, then clip back to the hard mask: the falloff lands
                    # inside the painted region instead of spilling outside it,
                    # same idiom as the lens-distort composite.
                    soft = _gaussian(m.view(1, 1, height, width), int(feather))[0, 0]
                    m = (soft * m).clamp(0.0, 1.0)

            return io.NodeOutput(NKDProjPass(image=img, camera=camera_info or {},
                                             mask=m, silhouette=sil, weight=float(weight),
                                             mirror=str(mirror)))

    class NKDBakeProjection(io.ComfyNode):
        @classmethod
        def define_schema(cls) -> io.Schema:
            return io.Schema(
                node_id="NKDBakeProjection",
                display_name="😺NKD Bake Projection",
                category="😺NKD Nodes/3D",
                description="Merges every projection pass onto the mesh, all at once, so "
                            "the result does not depend on the order you painted in. "
                            "Repaints the UV texture when the mesh has one, and falls "
                            "back to vertex colours when it does not.",
                inputs=[
                    io.MultiType.Input(
                        TrimeshIO.Input("mesh"),
                        types=[io.Mesh, io.File3DGLB, io.File3DGLTF, io.File3DAny],
                        tooltip="The mesh being painted: a MESH from Trellis2, Pixal3D or "
                                "any mesh builder, a TRIMESH, or a GLB/GLTF. Bake with it "
                                "at Reset in the viewport's Object panel, since a "
                                "transform made there stays in the browser.",
                    ),
                    io.Autogrow.Input(
                        "passes",
                        template=io.Autogrow.TemplateNames(
                            NKDProjType.Input("pass"),
                            names=[f"pass_{k + 1}" for k in range(PASS_SLOTS)],
                            min=0,
                        ),
                        optional=True,
                        tooltip="One 😺NKD Projection Pass per view. A slot fed by a muted "
                                "group is skipped, so Ctrl+M is the per-view switch.",
                    ),
                    io.Load3DModelInfo.Input("model_3d_info", optional=True,
                                             tooltip="The placement the viewport rendered the "
                                                     "model at, straight from the same Load3D. "
                                                     "Without it the bake projects onto where "
                                                     "the mesh sits untransformed, which is not "
                                                     "where the camera saw it."),
                    io.Int.Input("texture_size", default=2048, min=64, max=8192, step=64,
                                 tooltip="Resolution of the repainted texture. Ignored on "
                                         "a mesh with no UVs, which gets vertex colours."),
                    io.Float.Input("angle_threshold", default=75.0, min=0.0, max=89.0, step=1.0,
                                   tooltip="Surface turned further than this from the "
                                           "camera is not painted by that pass. Grazing "
                                           "angles smear."),
                    io.Float.Input("falloff", default=6.0, min=1.0, max=16.0, step=0.5,
                                   tooltip="How sharply the most head-on view wins. Low "
                                           "values average the views into mud; high ones "
                                           "can show the switch between them."),
                    io.Boolean.Input("occlusion", default=True,
                                     tooltip="Skip surface hidden behind the model from "
                                             "that camera. Off is faster and fine on a "
                                             "convex shape."),
                    io.Float.Input("occlusion_bias", default=0.02, min=0.0, max=0.5, step=0.005,
                                   advanced=True,
                                   tooltip="Slack in the hidden-surface test, as a fraction "
                                           "of distance. Raise it if surface that should "
                                           "be painted comes out blank."),
                ],
                outputs=[
                    io.Mesh.Output(display_name="mesh"),
                    io.Image.Output(display_name="texture"),
                    io.String.Output(display_name="report"),
                ],
            )

        @classmethod
        def execute(cls, mesh, texture_size=2048, angle_threshold=75.0, falloff=6.0,
                    occlusion=True, occlusion_bias=0.02, passes=None,
                    model_3d_info=None) -> io.NodeOutput:
            # A wired-but-muted upstream group delivers None; unwired slots are
            # simply absent. Sorted so the report reads in slot order.
            items = sorted((passes or {}).items())
            live = [p for _, p in items if isinstance(p, NKDProjPass)]
            for name, p in items:
                if isinstance(p, NKDProjPass):
                    p.label = name

            parts = _mesh_parts(mesh)
            if not live:
                return io.NodeOutput(_rebuild(parts), _as_image(parts["texture"]),
                                     "no passes wired, mesh passed through")

            device = _work_device(live[0].image)
            for p in live:
                p.to(device)
            # One plane per axis any pass asked for, in placed space, on the device.
            planes = {}
            for p in live:
                ax = str(p.mirror).upper()
                if ax in ("X", "Y", "Z") and ax not in planes:
                    o, n = _mirror_plane(ax, model_3d_info)
                    planes[ax] = (o.to(device), n.to(device))
            knobs = dict(angle_threshold=angle_threshold, falloff=falloff,
                         occlusion=occlusion, occlusion_bias=occlusion_bias,
                         mirror=planes or None)

            # Placement applies to what we PROJECT against, never to what we return.
            geo = _placed(parts, model_3d_info)

            why = _no_uv_reason(parts)
            if why is None:
                tex, hit, total, shares = bake_to_texture(
                    geo, live, texture_size, device, **knobs)
                out = _rebuild(parts, texture=tex)
                what = f"texture {tex.shape[1]}x{tex.shape[0]}"
                was = parts["texture"]
                if was is not None and max(was.shape[:2]) > int(texture_size):
                    # Not a detail. Fewer texels per triangle means the padding
                    # around each chart is a bigger share of it, and that padding
                    # is the part a bake cannot reproduce exactly.
                    what += WARN_DOWNSCALED.format(
                        w=was.shape[1], h=was.shape[0], want=max(was.shape[0], was.shape[1]))
            else:
                verts = geo["vertices"].to(device)
                faces = geo["faces"].to(device).long()
                normals = geo["normals"]
                normals = (_vertex_normals(verts, faces) if normals is None
                           else normals.to(device))
                base = parts["colors"]
                colours, painted, shares = bake_projection(
                    verts, normals, live, base=None if base is None else base.to(device),
                    to_linear=True, **knobs)
                tex = parts["texture"]
                out = _rebuild(parts, colors=colours)
                hit, total = int(painted.sum().item()), verts.shape[0]
                what = f"vertex colours ({why})"
                if parts["texture"] is not None:
                    what += WARN_TEXTURE_LOST

            lines = [f"{len(live)} pass(es) into {what}",
                     f"{hit}/{total} painted ({100.0 * hit / max(total, 1):.1f}%)"]
            axes = {p.label: str(p.mirror).upper() for p in live}
            lines += [f"  {name}: {reach} reached"
                      + (f" (mirrored across {axes[name]})" if axes.get(name) in ("X", "Y", "Z") else "")
                      for name, reach in shares]
            return io.NodeOutput(out, _as_image(tex), "\n".join(lines))

    def _no_uv_reason(parts):
        """None when the texture bake can run, else why it cannot.

        Falling back to vertex colours on a mesh that has a UV texture wrecks it,
        so the one thing this must never do is decide quietly.
        """
        uvs = parts["uvs"]
        if uvs is None:
            if parts["texture"] is None and parts["colors"] is not None:
                return "no UVs, colour lives on the vertices"      # a vertex-coloured model: fine
            return ("no UVs on this mesh: bake after Unwrap Mesh UVs, not on the raw "
                    "shape a generator hands over")
        if uvs.shape[0] != parts["vertices"].shape[0]:
            return (f"UVs do not match the vertices ({uvs.shape[0]} vs "
                    f"{parts['vertices'].shape[0]}), so they cannot be rasterised")
        if not _HAS_UV_BAKE:
            return "this ComfyUI core has no UV rasteriser to bake with"
        return None

    def _as_image(texture):
        """A texture as an IMAGE batch. 1x1 grey when there is nothing to show, so
        the socket is always safe to wire."""
        if texture is None:
            return torch.full((1, 1, 1, 3), _NEUTRAL)
        return texture.detach().cpu().unsqueeze(0).clamp(0.0, 1.0)

    def _rebuild(parts, texture=None, colors=None):
        """A core MESH carrying the bake. Built by copying the input MESH when there
        was one, so metallic roughness, tangents and the unlit flag ride along
        untouched instead of being dropped on the floor."""
        import copy
        src = parts["source"]
        out = (copy.copy(src) if src is not None
               else Types.MESH(vertices=parts["vertices"].unsqueeze(0),
                               faces=parts["faces"].unsqueeze(0),
                               uvs=None if parts["uvs"] is None else parts["uvs"].unsqueeze(0),
                               normals=None if parts["normals"] is None
                                       else parts["normals"].unsqueeze(0)))
        if texture is not None:
            out.texture = texture.detach().cpu().unsqueeze(0)
        if colors is not None:
            out.vertex_colors = colors.detach().cpu().unsqueeze(0)
        if src is None and texture is None and colors is None and parts["colors"] is not None:
            out.vertex_colors = parts["colors"].unsqueeze(0)
        return out

    class NKDTextureProjectExtension(ComfyExtension):
        @override
        async def get_node_list(self) -> list[type[io.ComfyNode]]:
            return [NKDProjectionPass, NKDBakeProjection]

    async def comfy_entrypoint() -> ComfyExtension:
        return NKDTextureProjectExtension()


# --------------------------------------------------------------------------
# Self-check
# --------------------------------------------------------------------------

def _cam(pos, fov=60.0):
    """Camera at `pos` looking down -Z (identity quaternion), i.e. towards the
    origin from +Z."""
    return {"position": {"x": pos[0], "y": pos[1], "z": pos[2]},
            "quaternion": {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0}, "fov": fov}


def _cam_orbit(dist, deg, fov=60.0):
    """Camera orbited `deg` about +Y, still looking at the origin.

    A yaw of a about Y takes the camera's local -Z onto (-sin a, 0, -cos a),
    which is exactly the direction from (d sin a, 0, d cos a) back to the
    origin — so position and orientation stay consistent. deg=0 is _cam on +Z.
    """
    a = math.radians(deg)
    h = a * 0.5
    return {"position": {"x": dist * math.sin(a), "y": 0.0, "z": dist * math.cos(a)},
            "quaternion": {"x": 0.0, "y": math.sin(h), "z": 0.0, "w": math.cos(h)},
            "fov": fov}


def _grid(n, half=0.5):
    """n x n vertices filling the z=0 plane, for tests that need real density."""
    t = torch.linspace(-half, half, n)
    gy, gx = torch.meshgrid(t, t, indexing="ij")
    return torch.stack([gx.reshape(-1), gy.reshape(-1),
                        torch.zeros(n * n)], dim=-1)


def _flat(rgb, size=64):
    return torch.tensor(rgb, dtype=torch.float32).view(1, 1, 3).expand(size, size, 3).contiguous()


def demo():
    # A quad in the z=0 plane facing +Z, plus one vertex parked behind it.
    front = torch.tensor([[-0.5, -0.5, 0.0], [0.5, -0.5, 0.0],
                          [-0.5, 0.5, 0.0], [0.5, 0.5, 0.0]], dtype=torch.float32)
    n_front = torch.tensor([[0.0, 0.0, 1.0]] * 4, dtype=torch.float32)
    cam_z = _cam((0.0, 0.0, 3.0))

    # 1. A head-on pass paints every vertex with the image colour.
    red = NKDProjPass(image=_flat([1.0, 0.0, 0.0]), camera=cam_z, label="p1")
    col, painted, _ = bake_projection(front, n_front, [red])
    assert painted.all(), "head-on quad left vertices unpainted"
    assert torch.allclose(col, torch.tensor([1.0, 0.0, 0.0]).expand(4, 3), atol=1e-5), col

    # 2. Facing away is rejected: same camera, normals flipped.
    col2, painted2, _ = bake_projection(front, -n_front, [red])
    assert not painted2.any(), "painted vertices whose normals face away"
    assert torch.equal(col2, torch.full((4, 3), _NEUTRAL)), "unpainted did not go neutral"

    # 3. Off-frame is rejected, and the base colour survives there.
    far_off = front + torch.tensor([40.0, 0.0, 0.0])
    base = torch.tensor([[0.2, 0.3, 0.4]]).expand(4, 3).contiguous()
    col3, painted3, _ = bake_projection(far_off, n_front, [red], base=base)
    assert not painted3.any(), "painted a vertex outside the frame"
    assert torch.equal(col3, base), "off-frame vertices lost their existing colour"

    # 4. Occlusion. A vertex 1 unit BEHIND a DENSE plane, facing the camera,
    #    must be rejected — and the control with occlusion off must accept it,
    #    so the test cannot pass by some other rejection.
    #    Dense on purpose: the z-buffer only knows what a vertex landed in its
    #    cell, so four corner vertices would leave the middle of the frame empty
    #    and the hidden vertex would be the nearest thing in its own cell. That
    #    is the sparse failure mode _nearest_z documents, not a bug to hide.
    sheet = _grid(40)
    n_sheet = torch.tensor([[0.0, 0.0, 1.0]], dtype=torch.float32).expand(len(sheet), 3)
    occluded = torch.cat([sheet, torch.tensor([[0.0, 0.0, -1.0]])])
    n_occ = torch.cat([n_sheet, torch.tensor([[0.0, 0.0, 1.0]])])
    _, p_on, _ = bake_projection(occluded, n_occ, [red], occlusion=True)
    _, p_off, _ = bake_projection(occluded, n_occ, [red], occlusion=False)
    assert not p_on[-1], "the hidden vertex was painted"
    assert p_off[-1], "control: with occlusion off the hidden vertex must be painted"
    assert p_on[:-1].all(), "occlusion test rejected the visible front face"

    # 5. The mask confines a pass. Left half white, right half black; the quad's
    #    left vertices land on the white half.
    mask = torch.zeros(64, 64)
    mask[:, :32] = 1.0
    masked = NKDProjPass(image=_flat([0.0, 1.0, 0.0]), camera=cam_z, mask=mask, label="m")
    _, p_mask, _ = bake_projection(front, n_front, [masked])
    assert p_mask[0] and p_mask[2], "mask rejected vertices inside the white half"
    assert not p_mask[1] and not p_mask[3], "mask painted outside the white half"

    # 6. THE claim this whole design rests on: the merge is order-independent.
    #    Two passes at different angles, swapped, must agree.
    side = NKDProjPass(image=_flat([0.0, 0.0, 1.0]), camera=_cam_orbit(3.0, 45.0), label="p2")
    a, _, _ = bake_projection(front, n_front, [red, side], occlusion=False)
    b, _, _ = bake_projection(front, n_front, [side, red], occlusion=False)
    assert torch.allclose(a, b, atol=1e-6), f"merge depends on pass order: {(a - b).abs().max()}"

    # 7. And it is a real blend, not one pass winning by default — otherwise 6
    #    would hold trivially.
    assert not torch.allclose(a, col, atol=1e-3), "second pass contributed nothing"

    # 8. falloff decides how hard the head-on view wins. The quad faces the
    #    red camera dead on and the blue one at 45 deg, so more falloff = redder.
    soft, _, _ = bake_projection(front, n_front, [red, side], falloff=1.0, occlusion=False)
    hard, _, _ = bake_projection(front, n_front, [red, side], falloff=12.0, occlusion=False)
    assert hard[:, 0].mean() > soft[:, 0].mean() + 0.05, \
        f"falloff did not sharpen the pick: {soft[:, 0].mean()} vs {hard[:, 0].mean()}"

    # 9. No passes at all leaves the mesh bit for bit alone.
    col9, painted9, _ = bake_projection(front, n_front, [], base=base)
    assert torch.equal(col9, base) and not painted9.any(), "empty bake touched the colours"

    # 10. A rotated camera projects correctly: the quad seen edge-on from +X is
    #     a line, so nothing faces that camera. Turn the normals to +X and it
    #     paints — which is what proves the quaternion is applied, not ignored.
    n_x = torch.tensor([[1.0, 0.0, 0.0]] * 4, dtype=torch.float32)
    sidecam = NKDProjPass(image=_flat([1.0, 1.0, 0.0]), camera=_cam_orbit(3.0, 90.0), label="x")
    _, p_edge, _ = bake_projection(front, n_front, [sidecam], occlusion=False)
    colx, p_face, _ = bake_projection(front, n_x, [sidecam], occlusion=False)
    assert not p_edge.any(), "edge-on quad was painted from the side camera"
    assert p_face.all(), "quad facing +X was not painted by the +X camera"
    assert torch.allclose(colx, torch.tensor([1.0, 1.0, 0.0]).expand(4, 3), atol=1e-5), colx

    # 11. Weight 0 mutes a pass without unwiring it.
    red0 = NKDProjPass(image=_flat([1.0, 0.0, 0.0]), camera=cam_z, weight=0.0, label="z")
    _, p_zero, _ = bake_projection(front, n_front, [red0])
    assert not p_zero.any(), "weight 0 still painted"

    # 12. Smooth vertex normals, computed here because a core MESH arrives as
    #     bare tensors and the pack ships no dependencies. Two triangles meeting
    #     at 90 degrees must average to the diagonal at the shared edge.
    v = torch.tensor([[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]])
    f = torch.tensor([[0, 1, 2], [0, 3, 1]])
    n = _vertex_normals(v, f)
    assert torch.allclose(n.norm(dim=-1), torch.ones(4), atol=1e-6), "normals not unit"
    assert torch.allclose(n[2], torch.tensor([0., 0., 1.]), atol=1e-6), n[2]
    assert torch.allclose(n[3], torch.tensor([0., 1., 0.]), atol=1e-6), n[3]
    shared = n[0] / n[0].norm()
    assert abs(shared[1] - shared[2]) < 1e-6 and shared[1] > 0.5,         f"the shared vertex did not average the two faces: {shared}"

    # 13. The UV texture bake, which is the main path. Needs ComfyUI for core's
    #     rasteriser, so it is skipped standalone.
    #     A flat plane with uv = xy: no seam, no poles, nothing to argue about.
    #     A sphere is the WRONG fixture here and cost real time: trimesh's
    #     uv_sphere ships no UVs at all, and recomputed equirect ones cannot be
    #     correct on it because its seam vertices are not duplicated, so
    #     triangles crossing u=0/1 smear across the whole atlas. The speckled
    #     result looked like a bake bug and was a fixture bug.
    if _HAS_COMFY and _HAS_UV_BAKE:
        k = 9
        t = torch.linspace(-0.5, 0.5, k)
        gy, gx = torch.meshgrid(t, t, indexing="ij")
        pv = torch.stack([gx.reshape(-1), gy.reshape(-1), torch.zeros(k * k)], -1)
        puv = torch.stack([gx.reshape(-1) + 0.5, gy.reshape(-1) + 0.5], -1)
        quads = [[r * k + c, r * k + c + 1, (r + 1) * k + c,
                  r * k + c + 1, (r + 1) * k + c + 1, (r + 1) * k + c]
                 for r in range(k - 1) for c in range(k - 1)]
        pf = torch.tensor(quads, dtype=torch.int64).reshape(-1, 3)
        pn = _vertex_normals(pv, pf)
        assert torch.allclose(pn[0], torch.tensor([0., 0., 1.]), atol=1e-6),             f"fixture winding faces away from the camera: {pn[0]}"

        parts = {"vertices": pv, "faces": pf, "uvs": puv, "normals": pn,
                 "colors": None, "texture": torch.full((32, 32, 3), 0.25), "source": None}
        red = NKDProjPass(image=_flat([1.0, 0.0, 0.0]), camera=_cam_orbit(3.0, 0.0, fov=40.0),
                          label="uv")
        dev = torch.device("cpu")
        tex, hit, total, _ = bake_to_texture(dict(parts), [red], 32, dev, occlusion=False)
        assert hit == total == 32 * 32, f"a plane facing the camera left texels unpainted: {hit}/{total}"
        assert torch.allclose(tex, torch.tensor([1.0, 0.0, 0.0]).expand(32, 32, 3), atol=1e-4),             f"texels did not take the pass colour: {tex.reshape(-1, 3)[0]}"

        # Facing away, the texture has to come back untouched, gutter fill included.
        parts_away = dict(parts, normals=-pn)
        tex2, hit2, _, _ = bake_to_texture(parts_away, [red], 32, dev, occlusion=False)
        assert hit2 == 0, "painted a plane whose normals face away"
        assert torch.allclose(tex2, torch.full((32, 32, 3), 0.25), atol=1e-4),             "an unpainted bake altered the existing texture"

    # 14. The Load3D placement. The viewport renders the model transformed, so the
    #     bake has to project against the transformed geometry or the paint lands
    #     wherever the raw mesh happens to fall. Reported by Neko as "the bake is
    #     still broken" with model_3d_info wired from the same Load3D.
    plane = _grid(9)
    plane_n = torch.tensor([[0.0, 0.0, 1.0]], dtype=torch.float32).expand(len(plane), 3)
    side = NKDProjPass(image=_flat([1.0, 0.0, 0.0]), camera=_cam_orbit(3.0, 90.0), label="p")

    # Face the plane at +Z and it is edge on to a camera out on +X: nothing painted.
    _, before, _ = bake_projection(plane, plane_n, [side], occlusion=False)
    assert not before.any(), "control: an edge-on plane must not be painted"

    # A quarter turn about Y aims it at that camera. Same pass, same mesh, and now
    # it must paint, which only happens if the placement reached the projection.
    quarter = {"position": {"x": 0.0, "y": 0.0, "z": 0.0},
               "quaternion": {"x": 0.0, "y": math.sin(math.radians(45.0)),
                              "z": 0.0, "w": math.cos(math.radians(45.0))},
               "scale": {"x": 1.0, "y": 1.0, "z": 1.0}}
    placed = _placed({"vertices": plane, "normals": plane_n}, [quarter])
    _, after, _ = bake_projection(placed["vertices"], placed["normals"], [side], occlusion=False)
    assert after.all(), f"the placed plane was not painted: {int(after.sum())}/{len(after)}"

    # Identity must be the SAME tensors, not a copy that drifts.
    ident = _placed({"vertices": plane, "normals": plane_n},
                    [{"position": {"x": 0, "y": 0, "z": 0}, "scale": {"x": 1, "y": 1, "z": 1},
                      "quaternion": {"x": 0, "y": 0, "z": 0, "w": 1}}])
    assert ident["vertices"] is plane, "an identity placement rebuilt the vertices"

    # A non-uniform scale tilts normals the opposite way from the surface: squashing
    # z must leave a +Z normal pointing +Z, not scaled off.
    squashed = _placed({"vertices": plane, "normals": torch.tensor([[1.0, 0.0, 1.0]])},
                       [{"scale": {"x": 1.0, "y": 1.0, "z": 0.25}}])
    n = squashed["normals"][0]
    assert abs(n.norm().item() - 1.0) < 1e-6, f"placed normal is not unit: {n}"
    assert n[2] > n[0], f"a squashed axis must tilt the normal TOWARDS it, got {n}"

    # 15. The silhouette gate. A render is a model on a backdrop, and every pixel
    #     of that backdrop is a colour the model never had. Without this gate the
    #     paint takes it (black patches from the viewport background, skin smeared
    #     onto clothing) wherever a surface projects off the model or onto a gap.
    sheet = _grid(40)
    sheet_n = torch.tensor([[0.0, 0.0, 1.0]], dtype=torch.float32).expand(len(sheet), 3)
    cam = _cam_orbit(3.0, 0.0)

    # Silhouette covering only the left half of the frame: the right half of the
    # plane must come back unpainted even though it faces the camera squarely.
    sil = torch.zeros(64, 64)
    sil[:, :32] = 1.0
    gated = NKDProjPass(image=_flat([1.0, 0.0, 0.0]), camera=cam, silhouette=sil, label="s")
    _, hit_gated, _ = bake_projection(sheet, sheet_n, [gated], occlusion=False)
    open_ = NKDProjPass(image=_flat([1.0, 0.0, 0.0]), camera=cam, label="o")
    _, hit_open, _ = bake_projection(sheet, sheet_n, [open_], occlusion=False)
    assert hit_open.all(), "control: with no silhouette the whole plane is painted"
    assert not hit_gated.all() and hit_gated.any(),         f"the silhouette gate painted all or nothing: {int(hit_gated.sum())}/{len(hit_gated)}"
    # The mask is sampled bilinearly, so the texel straddling the edge hands out a
    # partial weight either side of it. Judge away from that one-texel transition.
    inside, outside = sheet[:, 0] < -0.05, sheet[:, 0] > 0.05
    assert hit_gated[inside].all(), "the gate rejected surface inside the silhouette"
    assert not hit_gated[outside].any(),         f"the gate painted {int(hit_gated[outside].sum())} points outside the silhouette"

    # 16. A pass has to move EVERY tensor it carries. Two call sites used to move
    #     `image` and `mask` by name, so adding `silhouette` left it behind and
    #     grid_sample died on a cpu/cuda mismatch. Checked by reflection over the
    #     dataclass, so a field added tomorrow is covered without touching this.
    probe = NKDProjPass(image=_flat([1.0, 0.0, 0.0]), camera=_cam((0.0, 0.0, 3.0)),
                        mask=torch.ones(4, 4), silhouette=torch.ones(4, 4))
    tensor_fields = [f.name for f in fields(probe)
                     if isinstance(getattr(probe, f.name), torch.Tensor)]
    assert set(tensor_fields) >= {"image", "mask", "silhouette"}, tensor_fields

    # A move to the same device can hand back the very same object, so the probe
    # moves DTYPE instead: that always produces a new tensor, and a field the call
    # skipped keeps the old one.
    for name in tensor_fields:
        setattr(probe, name, getattr(probe, name).to(torch.float64))
    probe.to(torch.float32)
    for name in tensor_fields:
        assert getattr(probe, name).dtype == torch.float32,             f"pass.to() skipped the field {name!r}"

    # 17. The atlas row convention: v runs DOWN, row = v * H. Every earlier UV
    #     fixture (uv = xy on a centred plane, probes at v = 0.5) was symmetric
    #     under a vertical mirror and could not see this. A plane whose UVs fill
    #     only the TOP half of the atlas must paint rows < H/2 and nothing below.
    if _HAS_COMFY and _HAS_UV_BAKE:
        k = 9
        t9 = torch.linspace(-0.5, 0.5, k)
        gy, gx = torch.meshgrid(t9, t9, indexing="ij")
        pv = torch.stack([gx.reshape(-1), gy.reshape(-1), torch.zeros(k * k)], -1)
        puv = torch.stack([gx.reshape(-1) + 0.5, (gy.reshape(-1) + 0.5) * 0.45], -1)
        quads = [[r * k + c, r * k + c + 1, (r + 1) * k + c,
                  r * k + c + 1, (r + 1) * k + c + 1, (r + 1) * k + c]
                 for r in range(k - 1) for c in range(k - 1)]
        pf = torch.tensor(quads, dtype=torch.int64).reshape(-1, 3)
        parts = {"vertices": pv, "faces": pf, "uvs": puv, "normals": _vertex_normals(pv, pf),
                 "colors": None, "texture": torch.zeros(32, 32, 3), "source": None}
        red = NKDProjPass(image=_flat([1.0, 0.0, 0.0]), camera=_cam_orbit(3.0, 0.0, fov=40.0))
        tex, hit, _, _ = bake_to_texture(parts, [red], 32, torch.device("cpu"), occlusion=False)
        rows_red = (tex[..., 0] > 0.5).any(dim=1)
        assert rows_red[:14].all(), f"top rows (small v) were not painted: {rows_red[:16].tolist()}"
        # The gutter halo carries the colour _GUTTER_PAD rows past the last covered
        # one (row 14), so judge below that. A mirror would paint rows 17..31.
        assert not rows_red[15 + _GUTTER_PAD + 1:].any(),             "rows below v=0.5 were painted: the atlas is vertically mirrored"

    # 18. The edge is a fade, not a cut. A weight of 0.0003 used to replace the
    #     texel outright, because weights are normalised against each other and
    #     say nothing about the texture underneath. Coverage does.
    # One point on the optical axis, so the angle is exact: at the quad's corners
    # perspective tilts to_cam by up to 0.15 in cosine, the whole width of the ramp.
    axis = torch.zeros((1, 3)); up = torch.tensor([[0.0, 0.0, 1.0]])
    grey = torch.full((1, 3), 0.5)
    red = NKDProjPass(image=_flat([1.0, 0.0, 0.0]), camera=cam_z, label="r")
    c_on, _, _ = bake_projection(axis, up, [red], base=grey, occlusion=False)
    assert torch.allclose(c_on, torch.tensor([[1.0, 0.0, 0.0]]), atol=1e-5), c_on
    # 70 degrees: inside the ramp above the 75 degree threshold, so a partial blend.
    ang = math.radians(70.0)
    tilted = torch.tensor([[math.sin(ang), 0.0, math.cos(ang)]])
    c_edge, p_edge, _ = bake_projection(axis, tilted, [red], base=grey, occlusion=False)
    assert p_edge.all(), "the ramp rejected a surface inside the threshold"
    r_edge = c_edge[0, 0].item()
    expect = (math.cos(ang) - math.cos(math.radians(75.0))) / _FACING_RAMP
    assert abs(r_edge - (0.5 + 0.5 * expect)) < 1e-3, f"edge blend {r_edge:.3f}, expected {0.5 + 0.5 * expect:.3f}"
    # Past the threshold: untouched and not painted.
    ang2 = math.radians(80.0)
    away = torch.tensor([[math.sin(ang2), 0.0, math.cos(ang2)]])
    c_out, p_out, _ = bake_projection(axis, away, [red], base=grey, occlusion=False)
    assert not p_out.any() and torch.equal(c_out, grey), "past the threshold must leave the base alone"
    # A half-strength mask is a half blend, and two such passes add up to full.
    half = NKDProjPass(image=_flat([1.0, 0.0, 0.0]), camera=cam_z, mask=torch.full((64, 64), 0.5))
    c_half, _, _ = bake_projection(axis, up, [half], base=grey, occlusion=False)
    assert abs(c_half[0, 0].item() - 0.75) < 1e-4, f"half mask should give 0.75 red, got {c_half[0]}"
    c_two, _, _ = bake_projection(axis, up, [half, half], base=grey, occlusion=False)
    assert abs(c_two[0, 0].item() - 1.0) < 1e-4, f"two half passes should reach full, got {c_two[0]}"

    # 19. Vertex colours are linear. A mid-grey sRGB pass (0.5) painted onto them
    #     must land as 0.214, the linear value a viewer will encode back to 0.5.
    #     The texture path keeps 0.5: texture images are sRGB and decoded on load.
    axis = torch.zeros((1, 3)); up = torch.tensor([[0.0, 0.0, 1.0]])
    grey_pass = NKDProjPass(image=_flat([0.5, 0.5, 0.5]), camera=cam_z)
    lin, _, _ = bake_projection(axis, up, [grey_pass], occlusion=False, to_linear=True)
    assert abs(lin[0, 0].item() - 0.2140) < 2e-3, f"sRGB 0.5 should bake to linear 0.214, got {lin[0]}"
    raw, _, _ = bake_projection(axis, up, [grey_pass], occlusion=False)
    assert abs(raw[0, 0].item() - 0.5) < 1e-5, f"the texture path must not convert, got {raw[0]}"

    # 20. Mirror. The image is red on its left half, blue on its right, and a mask
    #     lets only the RIGHT half paint. Points at x<0 project to the left (red)
    #     but are masked out, so without a mirror they stay grey. With mirror X
    #     their reflection lands on the right, and the ONLY colour they can get is
    #     blue: the mirrored one, never the direct one.
    sheet = _grid(40)
    sheet_n = torch.tensor([[0.0, 0.0, 1.0]], dtype=torch.float32).expand(len(sheet), 3)
    split = torch.zeros(64, 64, 3); split[:, :32, 0] = 1.0; split[:, 32:, 2] = 1.0
    right_only = torch.zeros(64, 64); right_only[:, 32:] = 1.0
    two_tone = NKDProjPass(image=split, camera=_cam((0.0, 0.0, 3.0)), mask=right_only)
    grey = torch.full((len(sheet), 3), 0.5)
    planes = {"X": _mirror_plane("X")}
    left = sheet[:, 0] < -0.05
    right = sheet[:, 0] > 0.05

    c_no, p_no, _ = bake_projection(sheet, sheet_n, [two_tone], base=grey, occlusion=False)
    assert not p_no[left].any(), "control: masked-out left side must stay unpainted without a mirror"
    assert p_no[right].all(), "control: the right side must be painted"

    # The planes are offered by the bake; a pass only uses one if IT asks. Same
    # planes, pass left at "none": nothing may change.
    c_off, p_off, _ = bake_projection(sheet, sheet_n, [two_tone], base=grey, occlusion=False, mirror=planes)
    assert torch.equal(c_off, c_no), "a pass with mirror=none must ignore the bake's planes"
    two_tone.mirror = "X"
    c_mi, p_mi, _ = bake_projection(sheet, sheet_n, [two_tone], base=grey, occlusion=False, mirror=planes)
    assert p_mi[left].all(), "mirror X did not reach the left side"
    blue = torch.tensor([0.0, 0.0, 1.0])
    assert torch.allclose(c_mi[left], blue.expand(int(left.sum()), 3), atol=1e-4), \
        f"mirrored points must carry the MIRRORED colour (blue), got {c_mi[left][0]}"
    assert torch.allclose(c_mi[right], blue.expand(int(right.sum()), 3), atol=1e-4), \
        "the direct side changed under a mirror"

    # The plane follows the placement: rotated a quarter turn about Z, the model's X
    # axis is world Y, so the mirror normal must be Y and the origin the placement.
    o, n = _mirror_plane("X", [{"position": {"x": 1.0, "y": 2.0, "z": 3.0},
                                "quaternion": {"x": 0.0, "y": 0.0, "z": math.sin(math.pi / 4),
                                               "w": math.cos(math.pi / 4)}}])
    assert torch.allclose(o, torch.tensor([1.0, 2.0, 3.0])) and torch.allclose(n.abs(), torch.tensor([0.0, 1.0, 0.0]), atol=1e-6), (o, n)
    assert _mirror_plane("none") is None

    print("nkd_texture_project self-check OK")


if __name__ == "__main__":
    demo()
