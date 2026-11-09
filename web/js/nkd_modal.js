const E="nkd-modal-styles",C=`
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
`;function N(){if(document.getElementById(E))return;const a=document.createElement("style");a.id=E,a.textContent=C,document.head.appendChild(a)}function p(a){const t=document.createElement("div");return t.className=a,t}function I(a){N();const t=p("nkd-modal-overlay"),s=p("nkd-modal-panel");s.style.width=a.width??"92vw",s.style.height=a.height??"92vh",s.style.maxWidth=a.maxWidth??"1800px";const i=p("nkd-modal-head"),o=document.createElement("span");o.textContent=a.title;const e=document.createElement("span");e.className="nkd-modal-hint",e.textContent=a.hint??"";const r=document.createElement("button");r.className="nkd-modal-x",r.textContent="✕",r.title="Close (Esc)",i.append(o,e,p("nkd-modal-spacer"),r);const h=p("nkd-modal-body"),m=p("nkd-modal-foot"),k=p("nkd-modal-foot-left"),u=p("nkd-modal-foot-right");m.append(k,p("nkd-modal-spacer"),u),s.append(i,h,m),t.append(s),document.body.appendChild(t);let f=!1;function c(d="dismiss"){var l;f||(f=!0,window.removeEventListener("keydown",n,!0),t.remove(),(l=a.onClose)==null||l.call(a,d))}function n(d){d.key==="Escape"&&(d.stopPropagation(),d.preventDefault(),c("dismiss"))}return r.onclick=()=>c("dismiss"),a.closeOnEsc!==!1&&window.addEventListener("keydown",n,!0),a.closeOnBackdrop!==!1&&t.addEventListener("pointerdown",d=>{d.target===t&&c("dismiss")}),{overlay:t,panel:s,head:i,body:h,footer:m,footerLeft:k,footerRight:u,setTitle:d=>{o.textContent=d},setHint:d=>{e.textContent=d},addPrimary(d,l){const b=L(d,()=>{l==null||l(),c("save")});return b.classList.add("primary"),u.appendChild(b),b},close:c}}function L(a,t,s){const i=document.createElement("button");return i.className="nkd-modal-btn",i.textContent=a,s&&(i.title=s),i.onclick=t,i}function D(a,t,s,i){let o=t;const e=L(a,()=>{o=!o,e.classList.toggle("on",o),s(o)},i);return e.classList.toggle("on",o),e}const S=.1;function K(a,t,s,i){const o=document.createElement("label");o.className="nkd-modal-lbl",i&&(o.title=i);const e=document.createElement("input");e.type="range",e.className="nkd-modal-rng",e.min=String(t.min),e.max=String(t.max),e.step="any",e.value=String(t.value),t.width&&(e.style.width=`${t.width}px`);const r=t.format?document.createElement("span"):null;r&&(r.className="nkd-modal-num");const h=t.fine??t.step/10,m=n=>Math.max(t.min,Math.min(t.max,n)),k=(n,d)=>{const l=d?h:t.step;return Math.round(Math.round(m(n)/l)*l*1e6)/1e6},u=n=>{r&&(r.textContent=t.format(n))},f=(n,d)=>{const l=k(n,d);e.value=String(l),u(l),s(l)};e.addEventListener("pointerdown",n=>{if(n.button!==0||e.disabled)return;n.preventDefault(),e.focus();try{e.setPointerCapture(n.pointerId)}catch{}const d=e.getBoundingClientRect(),l=t.max-t.min,b=Math.max(1,d.width);let g=n.shiftKey?parseFloat(e.value):m(t.min+(n.clientX-d.left)/b*l);f(g,n.shiftKey);let v=n.clientX;const w=x=>{g=m(g+(x.clientX-v)/b*l*(x.shiftKey?S:1)),v=x.clientX,f(g,x.shiftKey)},y=x=>{e.removeEventListener("pointermove",w),e.removeEventListener("pointerup",y),e.removeEventListener("pointercancel",y);try{e.releasePointerCapture(x.pointerId)}catch{}};e.addEventListener("pointermove",w),e.addEventListener("pointerup",y),e.addEventListener("pointercancel",y)}),e.addEventListener("keydown",n=>{const d=n.key==="ArrowRight"||n.key==="ArrowUp"?1:n.key==="ArrowLeft"||n.key==="ArrowDown"?-1:0;if(!d)return;n.preventDefault();const l=n.shiftKey?h:t.step;f(parseFloat(e.value)+d*l,n.shiftKey)});const c=document.createElement("span");return c.className="nkd-modal-lbl-txt",c.textContent=a,o.append(c,e),r&&o.appendChild(r),u(t.value),o.sync=n=>{e.value=String(n),u(n)},o.setDisabled=n=>{e.disabled=n,o.style.opacity=n?"0.45":""},o}function M(a,t,s,i){const o=document.createElement("select");o.className="nkd-modal-sel",i&&(o.title=i);for(const e of a){const r=document.createElement("option");r.value=e.value,r.textContent=e.label,o.appendChild(r)}return o.value=t,o.onchange=()=>s(o.value),o.addEventListener("wheel",e=>{e.preventDefault(),e.stopPropagation();const r=o.selectedIndex+(e.deltaY<0?1:-1);r<0||r>=o.options.length||(o.selectedIndex=r,o.dispatchEvent(new Event("change")))},{passive:!1}),o}export{N as ensureNkdModalStyles,L as nkdButton,M as nkdSelect,K as nkdSlider,D as nkdToggle,I as openNkdModal};
