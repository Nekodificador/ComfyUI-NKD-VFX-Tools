# 😺NKD Relight

https://github.com/user-attachments/assets/ebd779d3-cc0e-48b2-9b8f-a5b5c573941a

Relight a photo from its depth and normal passes. Add lights, drag them around a sphere,
and the image updates live on the node without queueing anything. You get screen-space
shadows, ambient colour, and material response if you also feed albedo and roughness.

Inputs are `rgb`, `normals` and `depth`. Albedo and roughness are optional, but they're
what gives you believable speculars.

**Masks per light.** Wire a mask into `mask_1` and a fresh slot appears (up to four). Each
light then has a *Mask* picker: confine a rim light to the subject, a fill to the background,
or light a silhouette only. *Invert* flips the mask, so one subject mask serves both a light
on the subject and another on everything else. *Mask amount* lets some of the light leak
outside. Feather the mask upstream with your usual mask nodes; white means lit.

**Shadows per light.** Every light has its own *Shadow* switch. The *Shadows* section stays
the master switch and holds the tracer settings (strength, softness, range), shared by all
lights so the scene reads as one.

**Look.** A last section for matching a reference plate once the lights are set: exposure,
white balance (temperature and tint), saturation, and haze. Haze uses the depth pass, so it
can be atmospheric: *Start* and *End* set where along the depth it fades in. Put *End* below
*Start* to haze the foreground instead, or set both to zero for an even wash over the whole
image. *Lit* lets the haze take the colour of the lights reaching it: a point light
leaves a halo of its colour in the fog, a directional one tints the whole veil, and
unlit fog goes dark, the way real haze behaves. Every slider resets on double-click, Shift
makes any drag ten times finer, and *Reset* next to *Clear* puts the whole node back to its
defaults, lights included.

The point is to settle the lighting before the model gets a say. Relight the plate, then
send it downstream as your img2img base or ControlNet reference, and the generation
inherits your key light instead of inventing one.

> Use whichever depth/normal nodes you already have. This package ships no models.

<!-- video: relight -->

---

[← All 😺NKD VFX Tools nodes](../README.md)
