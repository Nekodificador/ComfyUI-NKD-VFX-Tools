/**
 * 😺NKD fSpy Camera — Vue 3 extension entry point.
 * The node stays compact: an "Open Viewer" button opens a full-screen editor modal (mounted on
 * document.body, so it escapes LiteGraph's node transform). The reference photo is whatever the
 * backend resolved, pushed to us on execute — reading a filename off the upstream node only ever
 * worked for a directly-connected Load Image. Built with Vite into web/js/fspy_camera_widget.js.
 */

import { createApp } from "vue";
import { app as comfyApp } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import FSpyWidget from "@/FSpyWidget.vue";

const NODE_NAME = "NKDfSpyCamera";
const EXT_NAME = "NKD.fSpyCamera.Vue";

function imageUrl(value: string): string {
  if (!value || typeof value !== "string") return "";
  let subfolder = "", filename = value;
  const slash = value.lastIndexOf("/");
  if (slash >= 0) { subfolder = value.slice(0, slash); filename = value.slice(slash + 1); }
  const q = `/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`;
  return (api as any).apiURL ? (api as any).apiURL(q) : q;
}

/** Raw RGB bytes (as sent by the backend) -> data URL the viewer can load like any image. */
function rgbToDataUrl(bytes: Uint8Array, w: number, h: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const img = ctx.createImageData(w, h);
  for (let i = 0, j = 0, n = w * h; i < n; i++) {
    img.data[j++] = bytes[i * 3];
    img.data[j++] = bytes[i * 3 + 1];
    img.data[j++] = bytes[i * 3 + 2];
    img.data[j++] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

function hideWidget(w: any) {
  if (!w) return;
  w.type = "hidden"; w.hidden = true;
  if (w.options) w.options.hidden = true;
  w.computedHeight = 0; w.computeSize = () => [0, -4];
}

comfyApp.registerExtension({
  name: EXT_NAME,
  async beforeRegisterNodeDef(nodeType: any, nodeData: { name: string }): Promise<void> {
    if (nodeData.name !== NODE_NAME) return;
    // Defs re-register within a session; a second wrap would mount a second widget
    // per node and orphan the first (see preview3d_main.ts — measured there).
    if (nodeType.prototype.__nkdFspyWrapped) return;
    nodeType.prototype.__nkdFspyWrapped = true;

    const origCreated: (() => void) | undefined = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (this: any) {
      const result = origCreated?.apply(this, arguments as any);
      const self = this;

      const stateWidget = this.widgets?.find((w: any) => w.name === "fspy_state");
      hideWidget(stateWidget);
      const sIdx = this.inputs?.findIndex((inp: any) => inp.name === "fspy_state");
      if (sIdx !== undefined && sIdx >= 0) this.removeInput(sIdx);

      // The photo the backend actually resolved, pushed on execute. Preferred over the
      // upstream guess below, which only works when a Load Image is wired directly.
      let sentUrl = "";
      const onSource = (e: any) => {
        const d = e?.detail;
        if (!d || String(d.node_id) !== String(self.id)) return;
        try {
          const bin = atob(d.img);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          sentUrl = rgbToDataUrl(bytes, d.width, d.height);
        } catch { /* ignore malformed */ }
      };
      api.addEventListener("nkd-fspy-source", onSource);

      // Fallback: read the filename off a directly-connected Load Image. Anything that
      // processes the image has no such widget — that's what the sent photo is for.
      function upstreamUrl(): string {
        const slot = self.inputs?.find((i: any) => i.name === "image");
        if (!slot || slot.link == null) return "";
        const links: any = comfyApp.graph.links;
        const link = links instanceof Map ? links.get(slot.link) : links[slot.link];
        if (!link) return "";
        const up = comfyApp.graph.getNodeById?.(link.origin_id) ?? (comfyApp.graph as any)._nodes_by_id?.[link.origin_id];
        const w = up?.widgets?.find((x: any) => x?.name === "image");
        return w && typeof w.value === "string" ? imageUrl(w.value) : "";
      }

      const status = this.addWidget("text", "fSpy", "(abre el visor)", null);
      status.disabled = true;
      // Only fspy_state must serialize — keep the status/button out of widgets_values so the
      // positional mapping can never drift (robust reload + sharing the workflow).
      status.serialize = false;
      if (status.options) status.options.serialize = false;
      const setStatus = (s: { ok: boolean; fovV: number; focal: number }) => {
        status.value = s.ok ? `FOV ${s.fovV.toFixed(1)}° · ${s.focal.toFixed(1)}mm` : "sin resolver";
        self.setDirtyCanvas(true);
      };

      let vueApp: any = null, host: HTMLElement | null = null;
      function teardown() { try { vueApp?.unmount(); } catch {} if (host?.parentNode) host.remove(); vueApp = null; host = null; }
      function openViewer() {
        if (vueApp) return;                        // already open
        const url = sentUrl || upstreamUrl();
        if (!url) comfyApp.extensionManager?.toast?.add?.({ severity: "warn", summary: "fSpy Camera", detail: "Connect an image to the input and run this node once (blue play) to load the photo.", life: 6000 });
        host = document.createElement("div");
        document.body.appendChild(host);
        vueApp = createApp(FSpyWidget, {
          initialUrl: url,
          initialState: stateWidget?.value || "",
          onChange: (json: string) => { if (stateWidget) stateWidget.value = json; self.setDirtyCanvas(true); },
          onClose: (summary: { ok: boolean; fovV: number; focal: number }) => { setStatus(summary); teardown(); },
        });
        vueApp.mount(host);
      }

      this.addWidget("button", "🎥 Open fSpy Viewer", null, openViewer);

      const origRemoved = this.onRemoved;
      this.onRemoved = function (this: any) {
        api.removeEventListener("nkd-fspy-source", onSource);
        teardown();
        origRemoved?.apply(this, arguments as any);
      };

      return result;
    };
  },
});
