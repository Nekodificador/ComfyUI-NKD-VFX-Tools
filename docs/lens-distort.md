# 😺NKD Lens Distort

Barrel and pincushion, chromatic aberration, vignette and anamorphic squeeze, with a
switch between adding the distortion and removing it.

Two jobs, really. One is a look: give a clean render the bend, the colour fringing at the
edges and the falloff of a real lens, so it stops reading as computer-generated. The other
is geometry: straighten a wide-angle photo so straight lines are straight again, work on
it, and put the lens back exactly as it was.

Open the editor and you get a live preview of the whole model with every parameter to
hand. You can also **solve the distortion from the photo itself**: trace a few things you
know are straight in the real world — a roofline, a kerb, a doorframe — and it finds the
coefficients that straighten them. Three points minimum per trace, since two points make a
straight line whatever the lens is doing.

For inpainting, the round trip is lossless where it counts. Straightening a fisheye pushes
the outer ring of the frame out of shot, so rebuilding the photo from the straightened
version always loses it. Instead the original is carried along and only the masked region
is pasted back, leaving every other pixel of the plate untouched:

1. **Undistort** the photo. Lines go straight, the model has an easy job.
2. Inpaint it — crop and stitch in between if you want the detail.
3. **Distort** back with `lens_data` connected. Your edit lands in the original photo, in
   its original lens, and nothing else is disturbed.

<!-- video: lens distort -->

---

[← All 😺NKD VFX Tools nodes](../README.md)
