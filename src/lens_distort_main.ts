/**
 * 😺NKD Lens Distort — Vue 3 extension entry point.
 *
 * The node keeps its normal widgets; a button opens the plumb-line editor in the
 * shared NKD chrome (src/nkd_modal.ts). Solving writes k1/k2 straight back into
 * the node's widgets, so the editor is a way to FILL the widgets, never a
 * separate source of truth.
 *
 * The photo comes from the backend on execute (event "nkd-lens-source"), with a
 * fallback to a directly-connected Load Image — same two-tier approach as fSpy,
 * because the input here is usually a generated image with no filename anywhere.
 */
import { createApp } from "vue";
import { app as comfyApp } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import LensDistortWidget from "@/LensDistortWidget.vue";
import { openNkdModal, type NkdModal } from "@/nkd_modal";

const NODE_NAME = "NKDLensDistort";
const EXT_NAME = "NKD.LensDistort.Vue";

console.log("[NKD Lens Distort] rev 2026-07-27a");

function imageUrl(value: string): string {
  if (!value || typeof value !== "string") return "";
  let subfolder = "", filename = value;
  const slash = value.lastIndexOf("/");
  if (slash >= 0) { subfolder = value.slice(0, slash); filename = value.slice(slash + 1); }
  const q = `/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`;
  return (api as any).apiURL ? (api as any).apiURL(q) : q;
}

function rgbToDataUrl(bytes: Uint8Array, w: number, h: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const im = ctx.createImageData(w, h);
  for (let i = 0, j = 0, n = w * h; i < n; i++) {
    im.data[j++] = bytes[i * 3];
    im.data[j++] = bytes[i * 3 + 1];
    im.data[j++] = bytes[i * 3 + 2];
    im.data[j++] = 255;
  }
  ctx.putImageData(im, 0, 0);
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
    // Defs re-register within a session; a second wrap would stack onNodeCreated
    // and leave orphaned widgets behind (measured on Preview 3D).
    if (nodeType.prototype.__nkdLensDistortWrapped) return;
    nodeType.prototype.__nkdLensDistortWrapped = true;

    const origCreated: (() => void) | undefined = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (this: any) {
      const result = origCreated?.apply(this, arguments as any);
      const self = this;

      const stateWidget = this.widgets?.find((w: any) => w.name === "lens_state");
      hideWidget(stateWidget);
      const sIdx = this.inputs?.findIndex((inp: any) => inp.name === "lens_state");
      if (sIdx !== undefined && sIdx >= 0) this.removeInput(sIdx);

      const wid = (name: string) => self.widgets?.find((w: any) => w.name === name);

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
      api.addEventListener("nkd-lens-source", onSource);

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

      let vueApp: any = null, modal: NkdModal | null = null;
      function teardown() { try { vueApp?.unmount(); } catch {} vueApp = null; modal = null; }

      function openEditor() {
        if (vueApp) return;
        const url = sentUrl || upstreamUrl();
        if (!url) {
          comfyApp.extensionManager?.toast?.add?.({
            severity: "warn", summary: "Lens Distort",
            detail: "Connect an image and run this node once (blue play) to load the photo into the editor.",
            life: 6000,
          });
        }
        modal = openNkdModal({
          title: "😺 Lens Distort — plumb lines",
          hint: "click along something straight (3+ points) · double-click ends a trace · shift-click removes a point · right-drag pans · scroll zooms",
          onClose: () => teardown(),
        });

        // Snapshot every lens widget so the editor opens on the node's real
        // state, and hand back a setter so edits flow straight to the widgets.
        const PARAM_NAMES = ["mode", "k1", "k2", "k3", "p1", "p2", "center_x", "center_y",
                             "squeeze", "zoom", "ca_red", "ca_blue", "ca_falloff",
                             "vignette_amount", "vignette_falloff", "edge_mode"];
        const params: Record<string, any> = {};
        for (const p of PARAM_NAMES) { const w = wid(p); if (w) params[p] = w.value; }

        vueApp = createApp(LensDistortWidget, {
          initialUrl: url,
          initialState: stateWidget?.value || "",
          params,
          footerLeft: modal.footerLeft,
          footerRight: modal.footerRight,
          onChange: (json: string) => { if (stateWidget) stateWidget.value = json; self.setDirtyCanvas(true); },
          // The editor never owns the coefficients — it drives the node's widgets.
          onParam: (name: string, value: any) => {
            const w = wid(name);
            if (!w || w.value === value) return;
            w.value = value;
            w.callback?.(value);
            self.setDirtyCanvas(true, true);
          },
        });
        vueApp.mount(modal.body);
        // After mount: <Teleport> fills the footer during the initial render, so
        // adding the primary earlier would leave it left of the editor controls.
        modal.addPrimary("Apply & close");
      }

      this.addWidget("button", "⌖ Open Lens Editor", null, openEditor);

      const origRemoved = this.onRemoved;
      this.onRemoved = function (this: any) {
        api.removeEventListener("nkd-lens-source", onSource);
        modal?.close();
        teardown();
        origRemoved?.apply(this, arguments as any);
      };

      return result;
    };
  },
});
