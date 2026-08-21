# 😺NKD fSpy Camera

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

---

[← All 😺NKD VFX Tools nodes](../README.md)
