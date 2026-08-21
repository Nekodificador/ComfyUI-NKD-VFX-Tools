# 😺NKD Perspective Unwarp / Rewarp

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

---

[← All 😺NKD VFX Tools nodes](../README.md)
