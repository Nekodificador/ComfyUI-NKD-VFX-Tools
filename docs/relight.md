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

The point is to settle the lighting before the model gets a say. Relight the plate, then
send it downstream as your img2img base or ControlNet reference, and the generation
inherits your key light instead of inventing one.

> Use whichever depth/normal nodes you already have. This package ships no models.

<!-- video: relight -->

---

[← All 😺NKD VFX Tools nodes](../README.md)
