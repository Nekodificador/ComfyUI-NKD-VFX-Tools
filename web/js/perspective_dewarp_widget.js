import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE = "NKDPerspectiveUnwarp";
const EXT = "NKD.PerspectiveDewarp";
const ORDER = ["TL", "TR", "BR", "BL"];
const DEFAULT = { corners: [[0.15, 0.15], [0.85, 0.2], [0.8, 0.85], [0.2, 0.8]] };
// Per edge: the two corner indices it spans, and — for each — the perpendicular
// corner it slides toward, so a side stretch keeps the perspective lines' angles.
// Corner order: TL=0, TR=1, BR=2, BL=3.
const EDGES = [
  { c: [0, 1], anchor: [3, 2] },  // top
  { c: [1, 2], anchor: [0, 3] },  // right
  { c: [2, 3], anchor: [1, 0] },  // bottom
  { c: [3, 0], anchor: [2, 1] },  // left
];

// Resolve the image filename on the node feeding `image` -> a /view URL.
function imageUrl(node) {
  const inp = node.inputs?.find((i) => i.name === "image");
  if (!inp || inp.link == null) return "";
  const links = app.graph.links;
  const link = links instanceof Map ? links.get(inp.link) : links[inp.link];
  if (!link) return "";
  const src = app.graph.getNodeById?.(link.origin_id) || app.graph._nodes_by_id?.[link.origin_id];
  const w = src?.widgets?.find((x) => x?.name === "image");
  if (!w || typeof w.value !== "string") return "";
  let dir = "", file = w.value;
  const s = file.lastIndexOf("/");
  if (s >= 0) { dir = file.slice(0, s); file = file.slice(s + 1); }
  const u = `/view?filename=${encodeURIComponent(file)}&type=input&subfolder=${encodeURIComponent(dir)}`;
  return api.apiURL ? api.apiURL(u) : u;
}

function hide(w) {
  if (!w) return;
  w.type = "hidden"; w.hidden = true;
  if (w.options) w.options.hidden = true;
  w.computedHeight = 0;
  w.computeSize = () => [0, -4];
}

// Show/hide a widget by name, remembering its original type so it can come back.
function toggleWidget(w, show) {
  if (!w) return;
  if (w._origType === undefined) { w._origType = w.type; w._origCompute = w.computeSize; }
  if (show) {
    w.type = w._origType; w.computeSize = w._origCompute; w.hidden = false;
    if (w.options) w.options.hidden = false;
  } else {
    w.type = "hidden"; w.hidden = true; w.computeSize = () => [0, -4];
    if (w.options) w.options.hidden = true;
  }
}

// Only surface the inputs the current aspect_source / resolution_mode needs.
function updateVisibility(node) {
  const get = (n) => node.widgets?.find((w) => w.name === n);
  const aspect = get("aspect_source")?.value;
  const res = get("resolution_mode")?.value;
  toggleWidget(get("focal_length_mm"), aspect === "Metric");
  toggleWidget(get("manual_ratio_w"), aspect === "Manual");
  toggleWidget(get("manual_ratio_h"), aspect === "Manual");
  toggleWidget(get("longest_side"), res === "Longest Side");
  toggleWidget(get("megapixels"), res === "Megapixels");
  node.setSize([node.size[0], node.computeSize()[1]]);
  node.setDirtyCanvas(true, true);
}

// --- small vec + homography helpers (unit square -> quad, for the grid) --------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];

// Intersection point of line (a,b) with line (c,d). null if near-parallel.
function lineIntersect(a, b, c, d) {
  const rx = b[0] - a[0], ry = b[1] - a[1];
  const sx = d[0] - c[0], sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den;
  return [a[0] + t * rx, a[1] + t * ry];
}

// Solve the 3x3 homography mapping the unit square [(0,0),(1,0),(1,1),(0,1)] to
// the four dst points, via Gaussian elimination on the 8x8 DLT system.
function homography(dst) {
  const src = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c || Math.abs(A[c][c]) < 1e-12) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = b.map((v, i) => v / A[i][i]);
  return [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
}
function applyH(H, u, v) {
  const x = H[0][0] * u + H[0][1] * v + H[0][2];
  const y = H[1][0] * u + H[1][1] * v + H[1][2];
  const w = H[2][0] * u + H[2][1] * v + H[2][2];
  return [x / w, y / w];
}

function openModal(node, cornersWidget) {
  const url = imageUrl(node);
  const state = (() => {
    try { const s = JSON.parse(cornersWidget.value); if (s?.corners?.length === 4) return s; } catch {}
    return JSON.parse(JSON.stringify(DEFAULT));
  })();

  const view = { s: 1, tx: 0, ty: 0 };   // screen = baseScreen * s + (tx,ty)
  let gridN = 4;                          // grid divisions (0 = off)
  let dim = 0.35;                         // darken the image beneath the overlay (0..0.8)
  let inited = false;                     // first-resize view framing done?

  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:100000;display:flex;flex-direction:column;" +
    "background:#000c;backdrop-filter:blur(3px);font:12px system-ui,sans-serif;color:#c8d0e0";
  const head = document.createElement("div");
  head.style.cssText = "padding:8px 14px;background:#1a1c22;display:flex;align-items:center;gap:10px;flex-wrap:wrap";
  const title = document.createElement("span");
  title.textContent = "😺 Perspective Unwarp";
  const hint = document.createElement("span");
  hint.style.cssText = "color:#ffffff66;font-size:11px";
  hint.textContent = "corners distort · sides stretch · scroll zoom · drag empty to pan";
  const spacer = document.createElement("span");
  spacer.style.cssText = "flex:1 1 auto";
  head.append(title, hint, spacer);

  const mkBtn = (label, fn) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = "background:#252830;border:1px solid #3a3d46;color:#c8d0e0;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:12px";
    b.onclick = fn; return b;
  };
  const gridLbl = document.createElement("span");
  gridLbl.style.cssText = "color:#8a92a4;min-width:56px;text-align:center";
  const refreshGridLbl = () => { gridLbl.textContent = gridN > 0 ? `Grid ${gridN}` : "Grid off"; };
  refreshGridLbl();
  const gridMinus = mkBtn("−", () => { gridN = Math.max(0, gridN - 1); refreshGridLbl(); draw(); });
  const gridPlus = mkBtn("+", () => { gridN = Math.min(16, gridN + 1); refreshGridLbl(); draw(); });
  const resetView_ = mkBtn("Reset view", () => { resetView(); draw(); });
  const resetPts = mkBtn("↺ Reset points", () => {
    state.corners = JSON.parse(JSON.stringify(DEFAULT.corners));
    draw();
  });
  // Darken slider (like fSpy Camera): dims the photo so the quad and grid read clearly.
  const dimWrap = document.createElement("label");
  dimWrap.style.cssText = "display:flex;align-items:center;gap:6px;color:#8a92a4";
  dimWrap.title = "Darken the image beneath the overlay";
  const dimRng = document.createElement("input");
  dimRng.type = "range"; dimRng.min = "0"; dimRng.max = "0.8"; dimRng.step = "0.05";
  dimRng.value = String(dim); dimRng.style.width = "80px";
  dimRng.oninput = () => { dim = parseFloat(dimRng.value); draw(); };
  dimWrap.append(document.createTextNode("Darken"), dimRng);
  const closeBtn = mkBtn("Save & close", () => save());
  closeBtn.style.borderColor = "#4ab4ff"; closeBtn.style.color = "#4ab4ff";
  head.append(gridMinus, gridLbl, gridPlus, dimWrap, resetPts, resetView_, closeBtn);

  const wrap = document.createElement("div");
  wrap.style.cssText = "position:relative;flex:1 1 auto;min-height:0;background:#0b0d12;display:flex";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "width:100%;height:100%;touch-action:none;cursor:crosshair";
  wrap.appendChild(canvas);
  overlay.append(head, wrap);
  document.body.appendChild(overlay);

  const ctx = canvas.getContext("2d");
  const dpr = Math.max(window.devicePixelRatio || 1, 1);
  const imgObj = new Image(); imgObj.crossOrigin = "anonymous";
  let imgW = 16, imgH = 9;
  if (url) { imgObj.onload = () => { imgW = imgObj.naturalWidth; imgH = imgObj.naturalHeight; draw(); }; imgObj.src = url; }

  // Letterbox rect (CSS px) mapping relative [0,1] -> base screen, before view.
  function baseFit() {
    const cw = canvas.width / dpr, ch = canvas.height / dpr;
    const r = Math.min(cw / imgW, ch / imgH);
    const w = imgW * r, h = imgH * r;
    return [(cw - w) / 2, (ch - h) / 2, w, h];
  }
  function toScreen(rel) {
    const [ox, oy, w, h] = baseFit();
    return [(ox + rel[0] * w) * view.s + view.tx, (oy + rel[1] * h) * view.s + view.ty];
  }
  function toRel(sx, sy) {
    const [ox, oy, w, h] = baseFit();
    const bx = (sx - view.tx) / view.s, by = (sy - view.ty) / view.s;
    return [(bx - ox) / w, (by - oy) / h];
  }
  // Frame the image at ~82% with margin all round, so handles dragged off-image
  // (e.g. stretching a side past the edge) stay on-canvas and reachable.
  function resetView() {
    const cw = canvas.width / dpr, ch = canvas.height / dpr;
    view.s = 0.82;
    view.tx = (cw / 2) * (1 - view.s);
    view.ty = (ch / 2) * (1 - view.s);
  }
  const edgeMidScreen = (e) => {
    const a = toScreen(state.corners[e.c[0]]), b = toScreen(state.corners[e.c[1]]);
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  };

  function resize() {
    const r = wrap.getBoundingClientRect();
    canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
    canvas.style.width = r.width + "px"; canvas.style.height = r.height + "px";
    if (!inited && r.width > 2) { inited = true; resetView(); }
    draw();
  }

  // Magnifier: a zoomed inset of the source image around an image-space point,
  // with a crosshair at the exact spot — so a big handle never hides the corner.
  const MAG = 168, MAG_SRC = 34;   // inset size (CSS px) / source window (image px)
  function drawMagnifier(rel, hx, hy) {
    if (!url) return;
    const [ox, oy, w, h] = baseFit();
    const cw = canvas.width / dpr, ch = canvas.height / dpr;
    // Place near the handle, flipping to stay on-canvas.
    let bx = hx + 20, by = hy - MAG - 20;
    if (bx + MAG > cw - 8) bx = hx - MAG - 20;
    if (bx < 8) bx = 8;
    if (by < 8) by = hy + 20;
    if (by + MAG > ch - 8) by = ch - MAG - 8;
    const ix = rel[0] * imgW, iy = rel[1] * imgH;
    ctx.save();
    ctx.beginPath(); ctx.rect(bx, by, MAG, MAG); ctx.clip();
    ctx.fillStyle = "#0b0d12"; ctx.fillRect(bx, by, MAG, MAG);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(imgObj, ix - MAG_SRC / 2, iy - MAG_SRC / 2, MAG_SRC, MAG_SRC, bx, by, MAG, MAG);
    ctx.restore();
    ctx.strokeStyle = "#4ab4ff"; ctx.lineWidth = 2; ctx.strokeRect(bx, by, MAG, MAG);
    const cx = bx + MAG / 2, cy = by + MAG / 2;
    ctx.strokeStyle = "rgba(255,80,80,0.95)"; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - 12, cy); ctx.lineTo(cx + 12, cy);
    ctx.moveTo(cx, cy - 12); ctx.lineTo(cx, cy + 12);
    ctx.stroke();
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cw = canvas.width / dpr, ch = canvas.height / dpr;
    ctx.clearRect(0, 0, cw, ch); ctx.fillStyle = "#0b0d12"; ctx.fillRect(0, 0, cw, ch);
    const [ox, oy, w, h] = baseFit();
    if (url) {
      const sx = ox * view.s + view.tx, sy = oy * view.s + view.ty;
      ctx.drawImage(imgObj, sx, sy, w * view.s, h * view.s);
      if (dim > 0) { ctx.fillStyle = `rgba(0,0,0,${dim})`; ctx.fillRect(sx, sy, w * view.s, h * view.s); }
    }

    // Internal perspective grid (projective, so it matches real lines).
    if (gridN > 1) {
      const H = homography(state.corners);
      ctx.strokeStyle = "rgba(74,180,255,0.28)"; ctx.lineWidth = 1;
      for (let i = 1; i < gridN; i++) {
        const t = i / gridN;
        let a = toScreen(applyH(H, t, 0)), b = toScreen(applyH(H, t, 1));   // vertical
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        a = toScreen(applyH(H, 0, t)); b = toScreen(applyH(H, 1, t));       // horizontal
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
    }

    // Quad outline.
    ctx.strokeStyle = "#4ab4ff"; ctx.lineWidth = 2; ctx.beginPath();
    state.corners.forEach((p, i) => {
      const [x, y] = toScreen(p);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.closePath(); ctx.stroke();

    // Edge (side) handles — small diamonds at the midpoints.
    EDGES.forEach((e) => {
      const [x, y] = edgeMidScreen(e);
      ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4);
      ctx.fillStyle = "#7ec8ff"; ctx.strokeStyle = "rgba(0,0,0,0.7)"; ctx.lineWidth = 1.5;
      ctx.fillRect(-4, -4, 8, 8); ctx.strokeRect(-4, -4, 8, 8);
      ctx.restore();
    });

    // Corner handles — hollow rings (so the corner shows through) + a centre dot.
    state.corners.forEach((p, i) => {
      const [x, y] = toScreen(p);
      ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(74,180,255,0.15)"; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = "#4ab4ff"; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
      ctx.fillStyle = "#fff"; ctx.font = "11px system-ui"; ctx.fillText(ORDER[i], x + 11, y - 9);
    });

    // Magnifier while dragging a handle.
    if (drag) {
      const rel = drag.kind === "corner" ? state.corners[drag.i] : (drag.lastRel || [0.5, 0.5]);
      const [hx, hy] = toScreen(rel);
      drawMagnifier(rel, hx, hy);
    }
  }

  let drag = null;   // {kind:'corner'|'edge'|'pan', ...}
  const evScreen = (e) => {
    const b = canvas.getBoundingClientRect();
    return [e.clientX - b.left, e.clientY - b.top];
  };

  canvas.onpointerdown = (e) => {
    const [mx, my] = evScreen(e);
    // Corners take priority over edges.
    for (let i = 0; i < 4; i++) {
      const [x, y] = toScreen(state.corners[i]);
      if (Math.hypot(x - mx, y - my) < 14) {
        drag = { kind: "corner", i }; canvas.setPointerCapture(e.pointerId); draw(); return;
      }
    }
    for (let k = 0; k < EDGES.length; k++) {
      const [x, y] = edgeMidScreen(EDGES[k]);
      if (Math.hypot(x - mx, y - my) < 12) {
        drag = { kind: "edge", e: EDGES[k], lastRel: toRel(mx, my) };
        canvas.setPointerCapture(e.pointerId); draw(); return;
      }
    }
    // Empty space -> pan.
    drag = { kind: "pan", lastX: mx, lastY: my };
    canvas.setPointerCapture(e.pointerId);
  };

  canvas.onpointermove = (e) => {
    if (!drag) return;
    const [mx, my] = evScreen(e);
    if (drag.kind === "corner") {
      state.corners[drag.i] = toRel(mx, my);   // unclamped: corners may sit off-image
    } else if (drag.kind === "edge") {
      const r = toRel(mx, my);
      const delta = sub(r, drag.lastRel);
      drag.lastRel = r;
      // Slide the whole side while keeping the perspective. The side keeps aiming at
      // ITS vanishing point: where this side and the opposite side meet (the opposite
      // side runs through the two anchors). Move the side's midpoint by the drag, draw
      // the new side-line through that VP, then re-intersect it with each rail (the two
      // adjacent edges the corners ride on). Both corners land on one line → no tilt;
      // each stays on its rail → adjacent angles preserved. The rails do NOT pass
      // through this VP, so the intersections are proper finite points.
      const [c0, c1] = drag.e.c;
      const [a0, a1] = drag.e.anchor;
      const P0 = state.corners[c0], P1 = state.corners[c1];
      const A0 = state.corners[a0], A1 = state.corners[a1];
      const mid = [(P0[0] + P1[0]) / 2 + delta[0], (P0[1] + P1[1]) / 2 + delta[1]];
      // VP where this side meets the opposite side (null when they're parallel).
      const vp = lineIntersect(P0, P1, A0, A1);
      // Second point of the new side-line: the VP, or (sides parallel) a point that
      // keeps the side parallel to itself.
      const q = vp || [mid[0] + (P1[0] - P0[0]), mid[1] + (P1[1] - P0[1])];
      const n0 = lineIntersect(mid, q, P0, A0);
      const n1 = lineIntersect(mid, q, P1, A1);
      if (n0) state.corners[c0] = n0;
      if (n1) state.corners[c1] = n1;
    } else if (drag.kind === "pan") {
      view.tx += mx - drag.lastX; view.ty += my - drag.lastY;
      drag.lastX = mx; drag.lastY = my;
    }
    draw();
  };

  const end = (e) => {
    if (!drag) return;
    drag = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch {}
    draw();
  };
  canvas.onpointerup = end; canvas.onpointerleave = end;

  // Scroll to zoom toward the cursor.
  canvas.onwheel = (e) => {
    e.preventDefault();
    const [mx, my] = evScreen(e);
    const k = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const ns = Math.max(0.2, Math.min(20, view.s * k));
    const f = ns / view.s;
    view.tx = mx - (mx - view.tx) * f;
    view.ty = my - (my - view.ty) * f;
    view.s = ns;
    draw();
  };

  function save() {
    cornersWidget.value = JSON.stringify(state);
    node.setDirtyCanvas(true, true);
    ro.disconnect();
    window.removeEventListener("keydown", onKey, true);
    overlay.remove();
  }
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); save(); } };
  window.addEventListener("keydown", onKey, true);
  overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) save(); });

  const ro = new ResizeObserver(resize); ro.observe(wrap);
  resize();
}

app.registerExtension({
  name: EXT,
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE) return;
    const orig = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = orig?.apply(this, arguments);
      const cornersWidget = this.widgets?.find((w) => w.name === "corners");
      hide(cornersWidget);
      const idx = this.inputs?.findIndex((i) => i.name === "corners");
      if (idx !== undefined && idx >= 0) this.removeInput(idx);
      const node = this;
      this.addWidget("button", "📐 Edit corners", null, () => {
        if (!imageUrl(node)) {
          app.extensionManager?.toast?.add?.({
            severity: "warn", summary: "Perspective Unwarp",
            detail: "Connect an image (Load Image) to the input first.", life: 5000,
          });
          return;
        }
        openModal(node, cornersWidget);
      });

      // Wire the combos so hiding follows selection, then apply the initial state.
      for (const name of ["aspect_source", "resolution_mode"]) {
        const w = this.widgets?.find((x) => x.name === name);
        if (!w) continue;
        const prev = w.callback;
        w.callback = function () {
          const rr = prev?.apply(this, arguments);
          updateVisibility(node);
          return rr;
        };
      }
      updateVisibility(this);
      return r;
    };
    // A workflow loaded from disk restores widget values after creation — re-apply
    // visibility so a saved Metric/Manual/Megapixels selection shows the right rows.
    const origConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = origConfigure?.apply(this, arguments);
      updateVisibility(this);
      return r;
    };
  },
});
