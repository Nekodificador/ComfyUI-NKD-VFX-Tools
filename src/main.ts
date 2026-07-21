/**
 * NKD Relight – Vue 3 extension entry point.
 *
 * Built with Vite into web/js/relighting_widget.js.
 * ComfyUI scripts are external, resolved at runtime in the browser.
 */

import { createApp } from "vue";
import { app as comfyApp } from "../../scripts/app.js";
// @ts-ignore – resolved at runtime by ComfyUI
import { api } from "../../scripts/api.js";
import RelightingCanvas from "@/components/RelightingCanvas.vue";

const NODE_NAME = "RelightingNode";
const EXT_NAME  = "NKD.Relighting.Vue";

function keepDomWidgetSized(node: any, container: HTMLElement): () => void {
  const MAX_MARGIN = 40;
  let enforcingW = false;
  let goodMargin = 15;
  const vueMode = () => !!(window as any).LiteGraph?.vueNodesMode;
  const clamp = () => {
    if (enforcingW) return;
    if (vueMode()) { if (container.style.width) container.style.width = ""; return; }
    const nodeW = node.size?.[0]; if (!nodeW) return;
    const host = container.parentElement;
    const hostW = host ? host.clientWidth : 0;
    const broken = hostW > 0 && (hostW > nodeW * 1.2 || hostW < nodeW * 0.7);
    if (!broken) {
      if (container.style.width) { enforcingW = true; container.style.width = ""; requestAnimationFrame(() => { enforcingW = false; }); }
      const cw = container.clientWidth;
      if (cw > 0 && cw <= nodeW && cw >= nodeW - MAX_MARGIN) goodMargin = nodeW - cw;
      return;
    }
    const ref = Math.round(nodeW - goodMargin);
    if (ref > 0 && Math.abs(container.clientWidth - ref) > 2) {
      enforcingW = true; container.style.boxSizing = "border-box"; container.style.width = ref + "px";
      requestAnimationFrame(() => { enforcingW = false; });
    }
  };
  clamp();
  const ro = new ResizeObserver(clamp);
  ro.observe(container);
  const origResize = node.onResize;
  node.onResize = function () { origResize?.apply(this, arguments); clamp(); };
  const iv = window.setInterval(clamp, 250);
  return () => { ro.disconnect(); clearInterval(iv); };
}

comfyApp.registerExtension({
  name: EXT_NAME,

  async beforeRegisterNodeDef(
    nodeType: any,
    nodeData: { name: string },
    _app: any
  ): Promise<void> {
    if (nodeData.name !== NODE_NAME) return;
    // Defs re-register within a session; a second wrap would mount a second widget
    // per node and orphan the first (see preview3d_main.ts — measured there).
    if (nodeType.prototype.__nkdRelightWrapped) return;
    nodeType.prototype.__nkdRelightWrapped = true;

    const origCreated: (() => void) | undefined =
      nodeType.prototype.onNodeCreated;

    nodeType.prototype.onNodeCreated = function (this: any) {
      const result = origCreated?.apply(this, arguments as any);
      const nodeRef = this;

      // ── Hide the serialised lights_config STRING widget ───────────────
      const configWidget = this.widgets?.find(
        (w: any) => w.name === "lights_config"
      );
      if (configWidget) {
        // Hide visually but keep serializable. `.hidden` (NOT type="hidden") fully
        // removes the row in both renderers — without it the frontend still draws the
        // widget's label row and the canvas below overlaps it. Serialization is
        // unaffected by the flag.
        configWidget.hidden = true;
        configWidget.computedHeight = 0;
        configWidget.computeSize    = () => [0, -4];
        if (configWidget.inputEl) configWidget.inputEl.style.display = "none";
        if (configWidget.labelEl) configWidget.labelEl.style.display = "none";
      }

      // ── Build container for the Vue app ──────────────────────────────
      const container = document.createElement("div");
      container.style.cssText =
        "width:100%;box-sizing:border-box;overflow:hidden;";

      // Aspect ratio of the preview canvas (height/width). Updated when
      // passes arrive. Default: 16:9.
      let previewAspect = 9 / 16;

      // Measured height of the whole widget (canvas + controls). Filled by a
      // ResizeObserver below so collapsible sections / expanded lights auto-fit
      // the node instead of being clipped. Falls back to an estimate until the
      // first measurement lands.
      let measuredH = 0;
      const CONTROLS_FALLBACK = 110;

      // Callback: Vue component → hidden widget + dirty canvas.
      // Never force a resize here — the user controls node size manually.
      const onChange = (json: string) => {
        if (configWidget) configWidget.value = json;
        nodeRef.setDirtyCanvas(true);
      };

      const vueApp = createApp(RelightingCanvas, { onChange });
      const instance = vueApp.mount(container) as InstanceType<
        typeof RelightingCanvas
      >;

      // ── Register DOM widget ──────────────────────────────────────────
      const domWidget = this.addDOMWidget(
        "relighting_editor",
        "RELIGHTING_EDITOR",
        container,
        {
          getValue: (): string => instance.serialise(),
          setValue: (val: string): void => {
            instance.deserialise(val);
            if (configWidget) configWidget.value = val;
          },
          serialize: false,
        }
      );
      const _nkdW = keepDomWidgetSized(this, container);

      const MIN_W = 300;
      // Small margin so the node body reaches past the content — the canvas renderer
      // reserves the widget row a touch short, which would clip the editor's bottom.
      const ROW_SAFETY = 8;
      if (domWidget) {
        // width is supplied by LiteGraph as the current node width
        domWidget.computeSize = (width: number) => {
          const w = Math.max(width ?? MIN_W, MIN_W);
          const h = (measuredH > 0
            ? measuredH
            : Math.round(w * previewAspect) + CONTROLS_FALLBACK) + ROW_SAFETY;
          return [w, h];
        };
      }

      // ── Auto-fit node height to actual content ───────────────────────────
      // Collapsible sections and expanded lights change the controls height.
      // Measure the inner root element (its height is content-driven, unlike
      // the outer container which ComfyUI may force to the widget height) and
      // grow/shrink the node to match, so the UI is never clipped or bleeding.
      const inner = (container.firstElementChild as HTMLElement | null) ?? container;
      let resizeRAF = 0;
      const ro = new ResizeObserver(() => {
        const h = inner.offsetHeight;
        if (h > 0 && Math.abs(h - measuredH) > 1) {
          measuredH = h;
          if (resizeRAF) cancelAnimationFrame(resizeRAF);
          resizeRAF = requestAnimationFrame(() => {
            resizeRAF = 0;
            if (!nodeRef.size) return;
            const needed = nodeRef.computeSize();
            const [curW, curH] = nodeRef.size;
            if (Math.abs(needed[1] - curH) > 1) {
              nodeRef.setSize([curW, needed[1]]);
              nodeRef.setDirtyCanvas(true, true);
            }
          });
        }
      });
      ro.observe(inner);

      // Restore saved state
      const saved = configWidget?.value;
      if (saved && saved !== "[]" && saved !== "{}") instance.deserialise(saved);

      // ── Listen for pass data from backend ──────────────────────────
      const passHandler = (e: Event) => {
        const msg = (e as CustomEvent).detail;
        // Evaluate nodeRef.id lazily: onNodeCreated fires before LiteGraph
        // assigns a real ID, so capturing it early would give "-1".
        if (String(msg?.node_id) === String(nodeRef.id) && msg?.passes) {
          const p = msg.passes;
          // Update the preview aspect ratio; the ResizeObserver re-fits the
          // node height once the canvas re-lays out at the new proportions.
          if (p.width > 0 && p.height > 0) previewAspect = p.height / p.width;
          instance.setPasses(p);  // also clears the processing overlay
        }
      };

      // ── Processing feedback ─────────────────────────────────────────
      // Show overlay when this specific node starts executing.
      // Hide on completion, error, or when execution finishes entirely
      // (executing fires with node=null at the end of the queue).
      const executingHandler = (e: Event) => {
        const { node } = (e as CustomEvent).detail ?? {};
        if (String(node) === String(nodeRef.id)) {
          instance.setProcessing(true);
        } else {
          // Another node is now executing (or queue finished) — ours is done.
          instance.setProcessing(false);
        }
      };
      const doneHandler = () => instance.setProcessing(false);

      api.addEventListener("nkd-relight-passes", passHandler);
      api.addEventListener("executing",          executingHandler);
      api.addEventListener("executed",           doneHandler);
      api.addEventListener("execution_error",    doneHandler);

      // Clean up Vue app and listeners when node is removed
      const origRemoved = this.onRemoved;
      this.onRemoved = function (this: any) {
        _nkdW();
        ro.disconnect();
        if (resizeRAF) cancelAnimationFrame(resizeRAF);
        api.removeEventListener("nkd-relight-passes", passHandler);
        api.removeEventListener("executing",          executingHandler);
        api.removeEventListener("executed",           doneHandler);
        api.removeEventListener("execution_error",    doneHandler);
        vueApp.unmount();
        origRemoved?.apply(this, arguments as any);
      };

      return result;
    };
  },
});
