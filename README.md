# How to use it

A quick and silly guide until the example workflows are ready. Enjoy the Spanish accent!

https://github.com/user-attachments/assets/a9621694-62a4-43cf-85c8-52dffc6df7f1


# 😺 NKD VFX Tools

https://github.com/user-attachments/assets/f442473d-7b4b-4a6d-b2b9-d89e340be24a

VFX craft, wired into an AI pipeline.

These aren't compositing nodes. They exist so you can art-direct what the model generates,
using what VFX has always used to control an image: light, camera, perspective, depth and
3D placement.

Diffusion models invent well and obey badly. Asking a prompt for "the same room, lit from
the left, shot on a 35mm, statue over there" turns into a negotiation you usually lose. So
do it the other way round. Block the shot first: place the light, solve the real camera,
put the object where you want it, flatten the wall. Then hand the model an image and
control maps that already say where everything goes, and generating becomes closer to a
render than to a lottery.

Every node carries its own viewport, so you set things by eye and see what you get. No
guessing at numbers and re-queueing the graph to find out.

All nodes live under **😺NKD Nodes** in the node menu.

---

## Install

**ComfyUI Manager:** search for `NKD VFX Tools` and install.

**Manual:**

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Nekodificador/ComfyUI-NKD-VFX-Tools
```

Restart ComfyUI. Nothing to download, no extra setup.

---

## The nodes

| Node | What it does |
|---|---|
| [😺NKD Relight](docs/relight.md) | Relight a photo from its depth and normal passes. Drag lights around a sphere and the image updates live on the node. |
| [😺NKD Lens Blur](docs/lens-blur.md) | Depth of field driven by a depth map. Click where focus lands, set the aperture, and the blur falls off either side of that plane. |
| [😺NKD Preview 3D](docs/preview-3d.md) | A 3D viewport inside a node, for GLB/GLTF models, gaussian splats and meshes straight off a mesh builder. |
| [😺NKD fSpy Camera](docs/fspy-camera.md) | Drag two pairs of vanishing lines over a photo and it solves the camera that took it. |
| [😺NKD Camera Delta Prompt](docs/camera-delta-prompt.md) | Writes the move between two cameras as the JSON a camera-move LoRA expects, dropped into your prompt. |
| [😺NKD Perspective Unwarp / Rewarp](docs/perspective-unwarp-rewarp.md) | Flatten anything you are seeing at an angle, edit it head-on, then put it back at the same angle. |
| [😺NKD Lens Distort](docs/lens-distort.md) | Barrel and pincushion, chromatic aberration, vignette and anamorphic squeeze, applied or removed. |
| [😺NKD Mask Scheduler](docs/mask-scheduler.md) | Turns one mask into a batch that fades over a list of values, so its strength can follow a curve. |

---

## Requirements

ComfyUI with a recent frontend, and `numpy`. Everything else ships with ComfyUI.

Perspective Rewarp's *Seamless Edges* option uses OpenCV if you have it. Without it, the
rest of the node works fine.

---

## Credits

😺NKD fSpy Camera owes its whole existence to [fSpy](https://fspy.io) and its
[Blender importer](https://github.com/stuffmatic/fSpy-Blender), by stuffmatic. It carries
the name as credit and implements the same 2-point vanishing-point solve. fSpy is GPL-3.0
and so is this package. Not affiliated with or endorsed by the fSpy project.

Gaussian splat rendering uses [Spark](https://github.com/sparkjsdev/spark) (MIT). 3D
viewport built on [three.js](https://threejs.org) (MIT).

---

## License

Copyright (C) 2026 Nekodificador.

GPL-3.0. See [LICENSE](LICENSE).

Same licence as ComfyUI itself. Use it, modify it, build on it. If you distribute
something built on this code, that has to be free software too, so the work stays with the
community it came from. Running it, including on a paid service, is not distribution and
carries no such obligation.
