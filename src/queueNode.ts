// Run one node and its upstream dependencies, nothing else.
//
// `app.queuePrompt` has no "just this node" form, so the serialised graph is
// intercepted for a single call and trimmed to the node plus whatever feeds it.
// Upstream stays cached by the executor, so this costs one node, not a render.
//
// web/js/perspective_dewarp_widget.js carries its own copy: it is a hand-written
// vanilla extension outside this Vite bundle, and wiring a runtime import across
// that boundary is more fragile than the duplication.
import { app as comfyApp } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

function collectUpstream(nodeId: string, output: any, into: any): void {
  if (into[nodeId] || !output[nodeId]) return;
  into[nodeId] = output[nodeId];
  for (const value of Object.values(output[nodeId].inputs ?? {})) {
    if (Array.isArray(value)) collectUpstream(String(value[0]), output, into);
  }
}

export async function queueNode(node: any, label = "NKD"): Promise<void> {
  // The original method, not a bound copy, so it can be restored and still
  // called with the right receiver.
  const origQueue = (api as any).queuePrompt;
  try {
    (api as any).queuePrompt = async function (index: number, prompt: any) {
      (api as any).queuePrompt = origQueue;          // one call only
      if (prompt?.output) {
        const filtered = {};
        collectUpstream(String(node.id), prompt.output, filtered);
        prompt = { ...prompt, output: filtered };
      }
      return origQueue.call(api, index, prompt);
    };
    await comfyApp.queuePrompt(0, 1);
  } catch (err) {
    (api as any).queuePrompt = origQueue;
    console.error(`[${label}] queue failed:`, err);
    (comfyApp as any).extensionManager?.toast?.add?.({
      severity: "error", summary: "Queue Failed", detail: String(err), life: 6000,
    });
  }
}
