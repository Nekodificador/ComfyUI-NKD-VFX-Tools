const k="nkd-modal-styles",y=`
.nkd-modal-overlay {
  position: fixed; inset: 0; z-index: 100000;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.8); backdrop-filter: blur(3px);
  font: 12px system-ui, sans-serif; color: #c8d0e0;
}
/* Framed panel, never edge-to-edge: the graph staying visible around the border
   is what keeps the editor feeling like part of the workflow. */
.nkd-modal-panel {
  display: flex; flex-direction: column;
  background: #111318; color: #c8d0e0;
  border: 1px solid #3a3d46; border-radius: 10px;
  box-shadow: 0 12px 48px rgba(0,0,0,0.7);
  overflow: hidden;
}
.nkd-modal-head {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; background: #1a1c22;
  border-bottom: 1px solid rgba(255,255,255,0.07); font-weight: 500;
}
.nkd-modal-hint { color: rgba(255,255,255,0.40); font-size: 11px; font-weight: 400; }
.nkd-modal-spacer { flex: 1 1 auto; }
.nkd-modal-x {
  background: transparent; border: none; color: #c8d0e0;
  font-size: 16px; cursor: pointer; padding: 2px 8px; border-radius: 4px;
}
.nkd-modal-x:hover { background: rgba(255,77,77,0.25); color: #ff6b6b; }
.nkd-modal-body { position: relative; flex: 1 1 auto; min-height: 0; background: #0b0d12; display: flex; }
.nkd-modal-body > canvas { display: block; width: 100%; height: 100%; touch-action: none; }
.nkd-modal-foot {
  display: flex; align-items: center; gap: 12px;
  padding: 8px 14px; background: #1a1c22;
  border-top: 1px solid rgba(255,255,255,0.07);
}
.nkd-modal-foot-left, .nkd-modal-foot-right { display: flex; align-items: center; gap: 12px; }

/* Shared controls. Vue templates use these class names directly instead of
   re-declaring the same rules in <style scoped>. */
.nkd-modal-btn {
  background: #252830; border: 1px solid #3a3d46; border-radius: 4px;
  color: #c8d0e0; padding: 4px 10px; font-size: 12px; cursor: pointer;
}
.nkd-modal-btn:hover { border-color: #4ab4ff; }
.nkd-modal-btn:disabled { opacity: 0.3; cursor: not-allowed; }
.nkd-modal-btn.on { border-color: #4ab4ff; color: #4ab4ff; background: rgba(74,180,255,0.12); }
.nkd-modal-btn.primary { border-color: #4ab4ff; color: #4ab4ff; font-weight: 500; padding: 5px 14px; }
.nkd-modal-btn.primary:hover { background: rgba(74,180,255,0.15); }
.nkd-modal-lbl { color: rgba(255,255,255,0.55); display: flex; align-items: center; gap: 6px; }
.nkd-modal-rng { width: 80px; accent-color: #4ab4ff; cursor: pointer; }
.nkd-modal-sel {
  background: #252830; border: 1px solid #3a3d46; border-radius: 4px;
  color: #c8d0e0; padding: 3px 8px; font-size: 12px; cursor: pointer;
}
.nkd-modal-status { color: #4ab4ff; font-variant-numeric: tabular-nums; }
.nkd-modal-status.bad { color: #ff6b6b; }
`;function v(){if(document.getElementById(k))return;const e=document.createElement("style");e.id=k,e.textContent=y,document.head.appendChild(e)}function i(e){const o=document.createElement("div");return o.className=e,o}function w(e){v();const o=i("nkd-modal-overlay"),a=i("nkd-modal-panel");a.style.width=e.width??"92vw",a.style.height=e.height??"92vh",a.style.maxWidth=e.maxWidth??"1800px";const d=i("nkd-modal-head"),n=document.createElement("span");n.textContent=e.title;const t=document.createElement("span");t.className="nkd-modal-hint",t.textContent=e.hint??"";const l=document.createElement("button");l.className="nkd-modal-x",l.textContent="✕",l.title="Close (Esc)",d.append(n,t,i("nkd-modal-spacer"),l);const f=i("nkd-modal-body"),p=i("nkd-modal-foot"),b=i("nkd-modal-foot-left"),m=i("nkd-modal-foot-right");p.append(b,i("nkd-modal-spacer"),m),a.append(d,f,p),o.append(a),document.body.appendChild(o);let g=!1;function c(r="dismiss"){var s;g||(g=!0,window.removeEventListener("keydown",x,!0),o.remove(),(s=e.onClose)==null||s.call(e,r))}function x(r){r.key==="Escape"&&(r.stopPropagation(),r.preventDefault(),c("dismiss"))}return l.onclick=()=>c("dismiss"),e.closeOnEsc!==!1&&window.addEventListener("keydown",x,!0),e.closeOnBackdrop!==!1&&o.addEventListener("pointerdown",r=>{r.target===o&&c("dismiss")}),{overlay:o,panel:a,head:d,body:f,footer:p,footerLeft:b,footerRight:m,setTitle:r=>{n.textContent=r},setHint:r=>{t.textContent=r},addPrimary(r,s){const u=h(r,()=>{s==null||s(),c("save")});return u.classList.add("primary"),m.appendChild(u),u},close:c}}function h(e,o,a){const d=document.createElement("button");return d.className="nkd-modal-btn",d.textContent=e,a&&(d.title=a),d.onclick=o,d}function E(e,o,a,d){let n=o;const t=h(e,()=>{n=!n,t.classList.toggle("on",n),a(n)},d);return t.classList.toggle("on",n),t}function C(e,o,a,d){const n=document.createElement("label");n.className="nkd-modal-lbl",d&&(n.title=d);const t=document.createElement("input");return t.type="range",t.className="nkd-modal-rng",t.min=String(o.min),t.max=String(o.max),t.step=String(o.step),t.value=String(o.value),t.oninput=()=>a(parseFloat(t.value)),n.append(document.createTextNode(e),t),n}function S(e,o,a,d){const n=document.createElement("select");n.className="nkd-modal-sel",d&&(n.title=d);for(const t of e){const l=document.createElement("option");l.value=t.value,l.textContent=t.label,n.appendChild(l)}return n.value=o,n.onchange=()=>a(n.value),n}export{v as ensureNkdModalStyles,h as nkdButton,S as nkdSelect,C as nkdSlider,E as nkdToggle,w as openNkdModal};
