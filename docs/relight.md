# 😺NKD Relight

https://github.com/user-attachments/assets/ebd779d3-cc0e-48b2-9b8f-a5b5c573941a

Relight a photo from its depth and normal passes. Add lights, drag them around a sphere,
and the image updates live on the node without queueing anything. You get screen-space
shadows, ambient colour, and material response if you also feed albedo and roughness.

Inputs are `rgb`, `normals` and `depth`. Albedo and roughness are optional, but they're
what gives you believable speculars.

**Masks per light.** Wire a mask into `mask_1` and a fresh slot appears (up to four). Each
light then lists its masks and you choose how each one is used. As a **silhouette** the mask
sits on the screen: isolate a rim light to the subject, or invert it for a fill on everything
but the subject. As a **gobo** it is the cut-out a real light shines through: wire a window
pattern, blinds or foliage and the pattern slides with depth along the light, so it bends over
the nose and drifts across the shoulder instead of sitting flat on the screen (*Project* sets
how far). One light can mix both, say a window gobo confined to the subject's silhouette. With
two or more masks in use, *Combine* picks *Intersect* (lit only where every mask agrees) or
*Union* (lit where any does); an inverted mask subtracts. *Mask amount* lets some light leak
outside. Feather the masks upstream with your usual mask nodes; white means lit.

**Rim from a silhouette.** Pick a mask under *Rim mask* and the light outlines that
silhouette. It reads the mask, not the normals, so it works when your normal pass is too soft
for a proper backlight. The falloff comes from the same fast blur as Mask Ops, so it stays smooth
at any width. A light from the side rims the edge that faces it; a light straight
behind the subject gives a full halo; and the rim fades as the light comes round to the
front, since a rim needs a light behind. *Rim* is the strength, *Rim width* how far it reaches
into the subject, *Rim softness* the shape of the fade (a tight bright line to a long tail),
and *Rim spread* how far round the outline it wraps. *Rim surface* also asks the normal pass
for the surface to turn away from the camera, so the rim thickens where the form curves away
and fades on flat parts.

**Point lights.** Each one shows its three radial sliders (intensity, depth, radius) only
while the pointer is near it, so the picture stays clear and you get just the dot.

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

**Large editor.** The window button on the node opens the same node in a full-size editor: the image on the left, every light and section open at once on the right. Nothing reloads and nothing is duplicated; closing it hands the node back as it was. *Run node* queues it from inside. Hold *Original* (in either view) to see the plate without the relight.

The point is to settle the lighting before the model gets a say. Relight the plate, then
send it downstream as your img2img base or ControlNet reference, and the generation
inherits your key light instead of inventing one.

> Use whichever depth/normal nodes you already have. This package ships no models.

<!-- video: relight -->

---

[← All 😺NKD VFX Tools nodes](../README.md)
