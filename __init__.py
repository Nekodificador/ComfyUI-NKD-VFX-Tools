"""
ComfyUI NKD VFX Tools
Relighting, depth-guided lens blur, mask scheduling, fSpy camera and
perspective dewarp nodes
"""

from .relighting_node    import RelightingNode
from .lens_blur_node     import NKDLensBlurNode
from .mask_scheduler_node import NKDMaskScheduler
from .nkd_fspy_camera    import NKDfSpyCamera
from .nkd_preview_3d     import NKDPreview3D
from .nkd_perspective_dewarp import NKDPerspectiveUnwarp, NKDPerspectiveRewarp

NODE_CLASS_MAPPINGS = {
    "RelightingNode":         RelightingNode,
    "NKDLensBlurNode":        NKDLensBlurNode,
    "NKDMaskScheduler":       NKDMaskScheduler,
    "NKDfSpyCamera":          NKDfSpyCamera,
    "NKDPreview3D":           NKDPreview3D,
    "NKDPerspectiveUnwarp":   NKDPerspectiveUnwarp,
    "NKDPerspectiveRewarp":   NKDPerspectiveRewarp,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "RelightingNode":         "😺NKD Relight",
    "NKDLensBlurNode":        "😺NKD Lens Blur",
    "NKDMaskScheduler":       "😺NKD Mask Scheduler",
    "NKDfSpyCamera":          "😺NKD fSpy Camera",
    "NKDPreview3D":           "😺NKD Preview 3D",
    "NKDPerspectiveUnwarp":   "😺NKD Perspective Unwarp",
    "NKDPerspectiveRewarp":   "😺NKD Perspective Rewarp",
}

WEB_DIRECTORY = "./web/js"

__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', 'WEB_DIRECTORY']
