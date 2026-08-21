# 😺NKD Relight

https://github.com/user-attachments/assets/ebd779d3-cc0e-48b2-9b8f-a5b5c573941a

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

---

[← All 😺NKD VFX Tools nodes](../README.md)
