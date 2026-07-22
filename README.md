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

### 😺NKD Relight

Relight a photo from its depth and normal passes. Add lights, drag them around a sphere,
and the image updates live on the node without queueing anything. You get screen-space
shadows, ambient colour, and material response if you also feed albedo and roughness.

Inputs are `rgb`, `normals` and `depth`. Albedo and roughness are optional, but they're
what gives you believable speculars.

The point is to settle the lighting before the model gets a say. Relight the plate, then
send it downstream as your img2img base or ControlNet reference, and the generation
inherits your key light instead of inventing one.

> Use whichever depth/normal nodes you already have. This package ships no models.

<!-- video: relight -->

### 😺NKD Lens Blur

Depth of field driven by a depth map. Click where the focus should land, set the aperture
and how deep the field is, and the blur falls off in front of and behind that plane.
Preview updates on the node.

This is lens language a prompt can't ask for reliably: an actual focus plane, an actual
fall-off. Use it as a finishing pass on a generated frame, or on the plate beforehand so
the model keeps the background soft.

Inputs: `rgb` + `depth`.

<!-- video: lens blur -->

### 😺NKD Preview 3D

A 3D viewport inside a node. Load a **GLB/GLTF model or a gaussian splat**
(`.ply`, `.spz`, `.splat`, `.ksplat`), drop a photo behind it as a backdrop, orbit until
the placement looks right. The node exports what you framed:

| Output | What it's for |
| --- | --- |
| `image` | Model composited over the backdrop |
| `object` | The model alone, on transparency |
| `mask` | Where the model is, for inpainting or compositing |
| `depth` | Depth of the render, matched to your scene's depth map |
| `camera_info` | The viewport camera, to drive other 3D nodes |

So you block the shot in 3D and walk away with exactly the control signals a diffusion
graph wants: a mask to inpaint into, a depth map for ControlNet, the object on alpha, the
composite as an img2img base. Where the object sits and how big it reads is your decision,
already made, before the model sees anything.

Lighting comes off the backdrop itself, plus a key light you aim with a joystick, with
soft shadows. The Object panel handles position, rotation, scale and pivot with
scrub-drag fields.

Feed it a solved camera from **fSpy Camera** and the model sits in the photo's real
perspective. Feed it the backdrop's depth map and the exported depth lines up with the
scene, so the object composites at the right distance. There's an **Auto Z** button that
works out the near/far calibration for you.

<!-- video: preview 3d -->

### 😺NKD fSpy Camera

Drag two pairs of vanishing lines over a photo, along the edges of a floor, a table, a
building, and the node solves the camera that took it. Outputs a camera for Preview 3D,
plus focal length and field of view.

It recovers the photo's real lens, so anything you add downstream shares its perspective
and sits in the shot rather than floating on top of it.

The idea comes straight from [fSpy](https://fspy.io), the open source camera matching app,
and from the workflow its Blender importer made standard: match the camera to the photo
first, then build inside that camera. This node brings the same 2-point solve into ComfyUI
so you don't have to leave the graph to do it.

<!-- video: fspy -->

### 😺NKD Perspective Unwarp / Rewarp

https://github.com/user-attachments/assets/8550c726-3662-4e8a-a6cb-7772bd3b9b21

Two nodes for editing anything flat that you're seeing at an angle: a poster on a wall, a
label, a sign, a screen.

Inpainting that poster in place means asking the model to draw text in perspective, which
it does badly. Flatten it first and all it has to draw is a flat poster, which it does
well. The geometry goes back afterwards, exactly as it was.

1. **Unwarp:** drag the four corners of the region on the node. You get it flattened
   head-on, ready to paint into.
2. Edit that flat image however you like. Inpaint, img2img, a fresh generation.
3. **Rewarp:** connect it back and your edit returns to the photo in the original
   perspective, feathered in, with colour matching and seam clean-up. Or output it on
   transparency and composite it elsewhere.

Wire the focal length in from fSpy Camera and the flattened aspect ratio comes out true
instead of estimated.

<!-- video: unwarp / rewarp -->

### 😺NKD Mask Scheduler

Turns one mask into a batch that fades over a list of values. Pair it with a curve node
and the mask's strength follows that curve across your steps or frames, so your control
can tighten or let go over time instead of sitting at one fixed weight the whole run.

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
