const w="nkd-modal-styles",L=`
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
.nkd-modal-rng { width: 80px; accent-color: #4ab4ff; cursor: pointer; touch-action: none; }
.nkd-modal-num {
  color: #c8d0e0; font-variant-numeric: tabular-nums;
  min-width: 52px; text-align: right;
}
.nkd-modal-sel {
  background: #252830; border: 1px solid #3a3d46; border-radius: 4px;
  color: #c8d0e0; padding: 3px 8px; font-size: 12px; cursor: pointer;
}
.nkd-modal-status { color: #4ab4ff; font-variant-numeric: tabular-nums; }
.nkd-modal-status.bad { color: #ff6b6b; }
`;function C(){if(document.getElementById(w))return;const d=document.createElement("style");d.id=w,d.textContent=L,document.head.appendChild(d)}function p(d){const n=document.createElement("div");return n.className=d,n}function S(d){C();const n=p("nkd-modal-overlay"),i=p("nkd-modal-panel");i.style.width=d.width??"92vw",i.style.height=d.height??"92vh",i.style.maxWidth=d.maxWidth??"1800px";const r=p("nkd-modal-head"),o=document.createElement("span");o.textContent=d.title;const e=document.createElement("span");e.className="nkd-modal-hint",e.textContent=d.hint??"";const l=document.createElement("button");l.className="nkd-modal-x",l.textContent="✕",l.title="Close (Esc)",r.append(o,e,p("nkd-modal-spacer"),l);const h=p("nkd-modal-body"),u=p("nkd-modal-foot"),k=p("nkd-modal-foot-left"),f=p("nkd-modal-foot-right");u.append(k,p("nkd-modal-spacer"),f),i.append(r,h,u),n.append(i),document.body.appendChild(n);let b=!1;function t(a="dismiss"){var c;b||(b=!0,window.removeEventListener("keydown",s,!0),n.remove(),(c=d.onClose)==null||c.call(d,a))}function s(a){a.key==="Escape"&&(a.stopPropagation(),a.preventDefault(),t("dismiss"))}return l.onclick=()=>t("dismiss"),d.closeOnEsc!==!1&&window.addEventListener("keydown",s,!0),d.closeOnBackdrop!==!1&&n.addEventListener("pointerdown",a=>{a.target===n&&t("dismiss")}),{overlay:n,panel:i,head:r,body:h,footer:u,footerLeft:k,footerRight:f,setTitle:a=>{o.textContent=a},setHint:a=>{e.textContent=a},addPrimary(a,c){const m=E(a,()=>{c==null||c(),t("save")});return m.classList.add("primary"),f.appendChild(m),m},close:t}}function E(d,n,i){const r=document.createElement("button");return r.className="nkd-modal-btn",r.textContent=d,i&&(r.title=i),r.onclick=n,r}function K(d,n,i,r){let o=n;const e=E(d,()=>{o=!o,e.classList.toggle("on",o),i(o)},r);return e.classList.toggle("on",o),e}const N=.1;function M(d,n,i,r){const o=document.createElement("label");o.className="nkd-modal-lbl",r&&(o.title=r);const e=document.createElement("input");e.type="range",e.className="nkd-modal-rng",e.min=String(n.min),e.max=String(n.max),e.step="any",e.value=String(n.value),n.width&&(e.style.width=`${n.width}px`);const l=n.format?document.createElement("span"):null;l&&(l.className="nkd-modal-num");const h=n.fine??n.step/10,u=t=>Math.max(n.min,Math.min(n.max,t)),k=(t,s)=>{const a=s?h:n.step;return Math.round(Math.round(u(t)/a)*a*1e6)/1e6},f=t=>{l&&(l.textContent=n.format(t))},b=(t,s)=>{const a=k(t,s);e.value=String(a),f(a),i(a)};return e.addEventListener("pointerdown",t=>{if(t.button!==0||e.disabled)return;t.preventDefault(),e.focus(),e.setPointerCapture(t.pointerId);const s=e.getBoundingClientRect(),a=n.max-n.min,c=Math.max(1,s.width);let m=t.shiftKey?parseFloat(e.value):u(n.min+(t.clientX-s.left)/c*a);b(m,t.shiftKey);let y=t.clientX;const v=x=>{m=u(m+(x.clientX-y)/c*a*(x.shiftKey?N:1)),y=x.clientX,b(m,x.shiftKey)},g=x=>{e.removeEventListener("pointermove",v),e.removeEventListener("pointerup",g),e.removeEventListener("pointercancel",g);try{e.releasePointerCapture(x.pointerId)}catch{}};e.addEventListener("pointermove",v),e.addEventListener("pointerup",g),e.addEventListener("pointercancel",g)}),e.addEventListener("keydown",t=>{const s=t.key==="ArrowRight"||t.key==="ArrowUp"?1:t.key==="ArrowLeft"||t.key==="ArrowDown"?-1:0;if(!s)return;t.preventDefault();const a=t.shiftKey?h:n.step;b(parseFloat(e.value)+s*a,t.shiftKey)}),o.append(document.createTextNode(d),e),l&&o.appendChild(l),f(n.value),o.sync=t=>{e.value=String(t),f(t)},o.setDisabled=t=>{e.disabled=t,o.style.opacity=t?"0.45":""},o}function z(d,n,i,r){const o=document.createElement("select");o.className="nkd-modal-sel",r&&(o.title=r);for(const e of d){const l=document.createElement("option");l.value=e.value,l.textContent=e.label,o.appendChild(l)}return o.value=n,o.onchange=()=>i(o.value),o}export{C as ensureNkdModalStyles,E as nkdButton,z as nkdSelect,M as nkdSlider,K as nkdToggle,S as openNkdModal};
