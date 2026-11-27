const C="nkd-modal-styles",z=`
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

/* ── UI kit (nkd-ui-*): the editor look every NKD modal shares. Round borderless floats around
   the picture, a sidebar of cards on a 4/8px grid, a pill and a status line for the node.
   Additive: nothing above changes, an editor opts in by using these classes. The pill and the
   line live on the NODE, outside any modal, so a widget that uses them calls
   ensureNkdModalStyles() when it mounts. Shape language after nomadoor's Panorama Studio (MIT);
   reference implementation: Preview3DWidget.vue. ── */
.nkd-ui { --nkd-row: 24px; --nkd-lab: 64px; --nkd-fill: #2c2e36; --nkd-fill-hi: #3a3d48;
  --nkd-dim: #9aa1b2; --nkd-fg: #dcdce0; --nkd-note: #6f7686; --nkd-accent: #4ab4ff; --nkd-float: rgba(26,28,34,0.86); }
.nkd-ui, .nkd-ui *, .nkd-ui *::before, .nkd-ui *::after { box-sizing: border-box; }

/* On the node: the button that opens the editor, over the picture's bottom centre… */
.nkd-ui-pill {
  position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%); z-index: 3;
  height: 30px; padding: 0 14px 0 11px; border: 0; border-radius: 999px;
  background: rgba(26,28,34,0.86); color: #e6eaf2; cursor: pointer; white-space: nowrap;
  font: 600 12px/1 system-ui, sans-serif; display: inline-flex; align-items: center; gap: 7px;
  transition: background-color 120ms;
}
.nkd-ui-pill:hover { background: rgba(58,62,74,0.92); color: #fff; }
.nkd-ui-pill .pi { font-size: 12px; }
/* …and one status line under it: what the editor holds on the left, the size on the right. */
.nkd-ui-line {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; flex: 0 0 auto;
  height: 26px; padding: 0 8px; background: #1a1c22; font: 11px/1 system-ui, sans-serif; color: #8a93a6;
}
.nkd-ui-line > span { display: inline-flex; align-items: center; gap: 5px; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nkd-ui-line .pi { font-size: 11px; }
.nkd-ui-line > b { flex: none; color: #dcdce0; font-weight: 600; font-variant-numeric: tabular-nums; }

/* Floating groups: position them yourself (absolute, in the stage's margins — never on the picture). */
.nkd-ui-float { position: absolute; z-index: 3; display: inline-flex; align-items: center; gap: 2px; padding: 5px;
  background: var(--nkd-float, rgba(26,28,34,0.86)); border-radius: 999px; color: #c8d0e0; font: 11px/1 system-ui, sans-serif; }
.nkd-ui-float.col { flex-direction: column; border-radius: 20px; }
.nkd-ui-float button {
  min-width: 30px; height: 30px; padding: 0; border: 0; border-radius: 999px; flex: 0 0 auto;
  background: transparent; color: #c8d0e0; cursor: pointer; line-height: 1; font: inherit;
  display: flex; align-items: center; justify-content: center; gap: 6px; transition: background-color 120ms;
}
.nkd-ui-float button.txt { padding: 0 12px; font-weight: 600; }
.nkd-ui-float button .pi { font-size: 13px; line-height: 1; color: inherit; }
.nkd-ui-float button:hover { background: rgba(255,255,255,0.1); color: #fff; }
.nkd-ui-float button.on { background: #4ab4ff; color: #0c0d10; }
.nkd-ui-float button:disabled { opacity: 0.3; cursor: not-allowed; background: transparent; color: #c8d0e0; }
.nkd-ui-sep { width: 1px; height: 16px; margin: 0 3px; background: rgba(255,255,255,0.14); flex: 0 0 auto; }
.nkd-ui-float.col .nkd-ui-sep { width: 16px; height: 1px; margin: 3px 0; }

/* Sidebar of cards. 4px between rows and between controls in a row, 8px between blocks. */
.nkd-ui-side { min-height: 0; overflow: hidden auto; background: #1a1c22; border-left: 1px solid #2a2d36;
  padding: 8px; display: flex; flex-direction: column; gap: 8px; font: 11px/1.2 system-ui, sans-serif; color: var(--nkd-dim); }
.nkd-ui-card { background: #202229; border-radius: 12px; flex: 0 0 auto; }
.nkd-ui-card.sel { box-shadow: inset 0 0 0 1px rgba(74,180,255,0.55); }
.nkd-ui-cardhead { display: flex; align-items: center; gap: 7px; padding: 11px 12px 0; min-height: 33px;
  color: #fff; font: 600 13px/1 system-ui, sans-serif; }
.nkd-ui-cardhead > .pi { color: #8a93a6; font-size: 12px; }
.nkd-ui-cardhead > .grow { flex: 1 1 auto; min-width: 0; }
.nkd-ui-cardbody { padding: 10px 12px 12px; display: grid; grid-template-columns: minmax(0,1fr); gap: 4px; }
.nkd-ui-cardbody.off { opacity: 0.4; }
/* One row: label · control · value on the SAME columns in every card, so the tracks line up. */
.nkd-ui-row { display: grid; grid-template-columns: var(--nkd-lab) minmax(0,1fr) 38px; align-items: center;
  column-gap: 6px; min-height: 20px; }
.nkd-ui-row > :first-child { color: var(--nkd-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nkd-ui-row > :last-child:not(:nth-child(2)) { color: var(--nkd-fg); text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.nkd-ui-row.wide { grid-template-columns: var(--nkd-lab) minmax(0,1fr); min-height: var(--nkd-row); }
.nkd-ui-sub { font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--nkd-note);
  margin-top: 8px; display: flex; align-items: center; gap: 6px; min-height: 16px; }
.nkd-ui-sub:first-child { margin-top: 0; }
.nkd-ui-note { font-size: 10px; color: var(--nkd-note); line-height: 1.3; }
/* Fields, buttons and selects: one height, one fill, no outline until edited. */
.nkd-ui-btn, .nkd-ui-sel, .nkd-ui-field { height: var(--nkd-row); border: 1px solid transparent; border-radius: 6px;
  background: var(--nkd-fill); color: var(--nkd-fg); font: 11px/1 system-ui, sans-serif; padding: 0 8px; min-width: 0; }
.nkd-ui-btn, .nkd-ui-sel { cursor: pointer; }
.nkd-ui-btn:hover, .nkd-ui-sel:hover, .nkd-ui-field:hover { background: var(--nkd-fill-hi); }
.nkd-ui-btn.on { background: #4ab4ff; color: #0c0d10; }
.nkd-ui-btn.round { border-radius: 999px; padding: 0 12px; height: 22px; }
.nkd-ui-btn.icon { width: var(--nkd-row); padding: 0; flex: 0 0 auto; }
.nkd-ui-btn .pi { font-size: 10px; }
.nkd-ui-btn:disabled { opacity: 0.3; cursor: not-allowed; }
.nkd-ui-field:focus, .nkd-ui-sel:focus { outline: none; border-color: #4ab4ff; }
.nkd-ui-swatch { width: 28px; height: 20px; padding: 2px; border: 0; border-radius: 6px; background: var(--nkd-fill); cursor: pointer; flex: 0 0 auto; }
.nkd-ui-check { display: inline-flex; align-items: center; gap: 8px; min-height: 20px; color: var(--nkd-fg); cursor: pointer; }
.nkd-ui-check input, .nkd-ui input[type='checkbox'].nkd-ui-box { width: 14px; height: 14px; margin: 0; flex: 0 0 auto; accent-color: #4ab4ff; cursor: pointer; }
/* Sliders: thin track, small light thumb. Set --nkd-pct (0–100%) for a filled track. */
.nkd-ui-range { -webkit-appearance: none; appearance: none; width: 100%; height: 16px; margin: 0; background: transparent; cursor: pointer; touch-action: none; }
.nkd-ui-range::-webkit-slider-runnable-track { height: 4px; border-radius: 2px;
  background: linear-gradient(90deg, #7f8aa3 var(--nkd-pct, 0%), #3a3d48 var(--nkd-pct, 0%)); }
.nkd-ui-range::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; margin-top: -4px; border-radius: 50%; background: #c8d0e0; border: 0; }
.nkd-ui-range:hover::-webkit-slider-thumb { background: #fff; }
.nkd-ui-range::-moz-range-track { height: 4px; border-radius: 2px; background: #3a3d48; }
.nkd-ui-range::-moz-range-progress { height: 4px; border-radius: 2px; background: #7f8aa3; }
.nkd-ui-range::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%; background: #c8d0e0; border: 0; }
.nkd-ui-range:disabled { opacity: 0.3; cursor: default; }
/* A slider inside a floating bar: label, track, value in a line. */
.nkd-ui-barfield { display: inline-flex; align-items: center; gap: 8px; padding: 0 6px; color: #9aa1b2; white-space: nowrap; }
.nkd-ui-barfield > span:last-child:not(:first-child) { color: #dcdce0; font-variant-numeric: tabular-nums; min-width: 52px; text-align: right; }
.nkd-ui-barfield .nkd-ui-range { width: 140px; }

/* Shortcuts sheet, over the stage. */
.nkd-ui-help { position: absolute; z-index: 4; overflow: auto; background: rgba(27,28,30,0.97); border-radius: 12px;
  padding: 16px 20px; color: #dcdce0; font: 12px/1.3 system-ui, sans-serif; }
.nkd-ui-help-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; color: #8e8f93; }
.nkd-ui-help-head b { color: #fff; font-size: 15px; font-weight: 600; }
.nkd-ui-help-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 18px 40px; }
.nkd-ui-help h4 { margin: 0 0 4px; font-size: 13px; font-weight: 600; color: #fff; }
.nkd-ui-help-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 6px 0; border-top: 1px solid #2a2b2d; }
.nkd-ui-help-row > span:last-child { display: inline-flex; align-items: center; gap: 5px; color: #8e8f93; white-space: nowrap; }
.nkd-ui-help kbd, .nkd-ui kbd { font: 600 11px/1 system-ui, sans-serif; color: #dcdce0; background: #2c2c2e;
  border-radius: 5px; padding: 4px 7px; min-width: 22px; text-align: center; display: inline-block; }
`;function S(){if(document.getElementById(C))return;const i=document.createElement("style");i.id=C,i.textContent=z,document.head.appendChild(i)}function m(i){const e=document.createElement("div");return e.className=i,e}function M(i){S();const e=m("nkd-modal-overlay"),r=m("nkd-modal-panel");r.style.width=i.width??"92vw",r.style.height=i.height??"92vh",r.style.maxWidth=i.maxWidth??"1800px";const d=m("nkd-modal-head"),n=document.createElement("span");n.textContent=i.title;const a=document.createElement("span");a.className="nkd-modal-hint",a.textContent=i.hint??"";const t=document.createElement("button");t.className="nkd-modal-x",t.textContent="✕",t.title="Close (Esc)",d.append(n,a,m("nkd-modal-spacer"),t);const h=m("nkd-modal-body"),k=m("nkd-modal-foot"),b=m("nkd-modal-foot-left"),p=m("nkd-modal-foot-right");k.append(b,m("nkd-modal-spacer"),p),r.append(d,h,k),e.append(r),document.body.appendChild(e);let f=!1;function c(l="dismiss"){var s;f||(f=!0,window.removeEventListener("keydown",u,!0),e.remove(),(s=i.onClose)==null||s.call(i,l))}function u(l){var s;l.key==="Escape"&&(l.stopPropagation(),l.preventDefault(),!((s=o.beforeEsc)!=null&&s.call(o))&&c("dismiss"))}t.onclick=()=>c("dismiss"),i.closeOnEsc!==!1&&window.addEventListener("keydown",u,!0),i.closeOnBackdrop!==!1&&e.addEventListener("pointerdown",l=>{l.target===e&&c("dismiss")});const o={overlay:e,panel:r,head:d,body:h,footer:k,footerLeft:b,footerRight:p,setTitle:l=>{n.textContent=l},setHint:l=>{a.textContent=l},addPrimary(l,s){const x=L(l,()=>{s==null||s(),c("save")});return x.classList.add("primary"),p.appendChild(x),x},close:c};return o}function P(i,e,r={}){let d=e.parentElement;const n=m("");n.textContent=r.placeholder??"Open in the editor",n.style.cssText="display:flex;align-items:center;justify-content:center;width:100%;height:100%;box-sizing:border-box;color:rgba(255,255,255,0.35);font-size:11px;background:#111318;border:1px dashed #3a3d46;border-radius:4px;",d==null||d.appendChild(n),e.style.height="100%",e.style.flex="1 1 auto",i.body.appendChild(e);let a=!0,t=!1;const h=new Map,k=()=>{const u=[...h.values()];h.clear();for(const o of u)o()},b=()=>{var o;if(!a||e.parentElement===i.body)return;const u=e.parentElement;u&&(d=u,u.appendChild(n)),i.body.appendChild(e),(o=r.onReclaim)==null||o.call(r)},p=new MutationObserver(b);p.observe(i.body,{childList:!0});const f=()=>{t=!0},c=u=>{u.buttons||(t=!1,k())};return window.addEventListener("pointerdown",f,!0),window.addEventListener("pointerup",c,!0),window.addEventListener("pointercancel",c,!0),{write(u,o){a&&t?h.set(u,o):o()},flush:k,restore(){a&&(a=!1,p.disconnect(),window.removeEventListener("pointerdown",f,!0),window.removeEventListener("pointerup",c,!0),window.removeEventListener("pointercancel",c,!0),k(),d&&e.parentElement!==d&&d.appendChild(e),e.style.height="",e.style.flex="",n.remove())}}}function N(i,e,r,d=!1){const n=document.createElement("button");if(n.type="button",n.title=e,d)n.className="txt",n.textContent=i;else{const a=document.createElement("i");a.className=`pi pi-${i}`,n.appendChild(a)}return n.addEventListener("click",r),n}function T(i,e,r,...d){const n=m("nkd-ui nkd-ui-float"+(r?" col":""));n.style.cssText=e;for(const a of["pointerdown","mousedown","wheel","dblclick"])n.addEventListener(a,t=>t.stopPropagation());return n.append(...d),i.appendChild(n),n}function I(){const i=document.createElement("span");return i.className="nkd-ui-sep",i}function A(i,e,r){const d=m("nkd-ui nkd-ui-help");d.style.cssText="inset:14px 66px 14px 14px;display:none";const n=m("nkd-ui-help-head");n.innerHTML="<b>Shortcuts</b><span><kbd>?</kbd> or <kbd>Esc</kbd> to close</span>";const a=m("nkd-ui-help-cols");for(const[p,f]of r){const c=document.createElement("section"),u=document.createElement("h4");u.textContent=p,c.appendChild(u);for(const[o,l,s]of f){const x=m("nkd-ui-help-row"),w=document.createElement("span");w.textContent=o;const y=document.createElement("span");l.forEach((E,v)=>{v&&y.append("+");const g=document.createElement("kbd");g.textContent=E,y.appendChild(g)}),s&&y.append(s),x.append(w,y),c.appendChild(x)}a.appendChild(c)}d.append(n,a);for(const p of["pointerdown","mousedown","wheel","dblclick"])d.addEventListener(p,f=>f.stopPropagation());e.appendChild(d);let t=!1;const h=N("question","Shortcuts — ?",()=>k(!t)),k=p=>{t=p,d.style.display=p?"":"none",h.classList.toggle("on",p)};i.beforeEsc=()=>t?(k(!1),!0):!1;const b=p=>{if(!i.overlay.isConnected){window.removeEventListener("keydown",b,!0);return}if(p.key!=="?"||p.repeat)return;const f=document.activeElement;f&&(f.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(f.tagName))&&f.type!=="range"||(p.preventDefault(),p.stopPropagation(),k(!t))};return window.addEventListener("keydown",b,!0),h}function L(i,e,r){const d=document.createElement("button");return d.className="nkd-modal-btn",d.textContent=i,r&&(d.title=r),d.onclick=e,d}function K(i,e,r,d){let n=e;const a=L(i,()=>{n=!n,a.classList.toggle("on",n),r(n)},d);return a.classList.toggle("on",n),a}const D=.1;function O(i,e,r,d){const n=document.createElement("label"),a=!!e.kit;n.className=e.kit==="row"?"nkd-ui-row":e.kit==="bar"?"nkd-ui-barfield":"nkd-modal-lbl",d&&(n.title=d);const t=document.createElement("input");t.type="range",t.className=a?"nkd-ui-range":"nkd-modal-rng",t.min=String(e.min),t.max=String(e.max),t.step="any",t.value=String(e.value),e.width&&e.kit!=="row"&&(t.style.width=`${e.width}px`);const h=e.format?document.createElement("span"):null;h&&!a&&(h.className="nkd-modal-num");const k=e.fine??e.step/10,b=o=>Math.max(e.min,Math.min(e.max,o)),p=(o,l)=>{const s=l?k:e.step;return Math.round(Math.round(b(o)/s)*s*1e6)/1e6},f=o=>{h&&(h.textContent=e.format(o)),a&&t.style.setProperty("--nkd-pct",`${(o-e.min)/(e.max-e.min||1)*100}%`)},c=(o,l)=>{const s=p(o,l);t.value=String(s),f(s),r(s)};t.addEventListener("pointerdown",o=>{if(o.button!==0||t.disabled)return;o.preventDefault(),t.focus();try{t.setPointerCapture(o.pointerId)}catch{}const l=t.getBoundingClientRect(),s=e.max-e.min,x=Math.max(1,l.width);let w=o.shiftKey?parseFloat(t.value):b(e.min+(o.clientX-l.left)/x*s);c(w,o.shiftKey);let y=o.clientX;const E=g=>{w=b(w+(g.clientX-y)/x*s*(g.shiftKey?D:1)),y=g.clientX,c(w,g.shiftKey)},v=g=>{t.removeEventListener("pointermove",E),t.removeEventListener("pointerup",v),t.removeEventListener("pointercancel",v);try{t.releasePointerCapture(g.pointerId)}catch{}};t.addEventListener("pointermove",E),t.addEventListener("pointerup",v),t.addEventListener("pointercancel",v)}),t.addEventListener("keydown",o=>{const l=o.key==="ArrowRight"||o.key==="ArrowUp"?1:o.key==="ArrowLeft"||o.key==="ArrowDown"?-1:0;if(!l)return;o.preventDefault();const s=o.shiftKey?k:e.step;c(parseFloat(t.value)+l*s,o.shiftKey)}),t.addEventListener("dblclick",o=>{e.def==null||t.disabled||(o.preventDefault(),c(e.def,!1))});const u=document.createElement("span");return a||(u.className="nkd-modal-lbl-txt"),u.textContent=i,n.append(u,t),h&&n.appendChild(h),f(e.value),n.sync=o=>{t.value=String(o),f(o)},n.setDisabled=o=>{t.disabled=o,n.style.opacity=o?"0.45":""},n}function F(i,e,r,d){const n=document.createElement("select");n.className="nkd-modal-sel",d&&(n.title=d);for(const a of i){const t=document.createElement("option");t.value=a.value,t.textContent=a.label,n.appendChild(t)}return n.value=e,n.onchange=()=>r(n.value),n.addEventListener("wheel",a=>{a.preventDefault(),a.stopPropagation();const t=n.selectedIndex+(a.deltaY<0?1:-1);t<0||t>=n.options.length||(n.selectedIndex=t,n.dispatchEvent(new Event("change")))},{passive:!1}),n}export{S as ensureNkdModalStyles,L as nkdButton,T as nkdFloat,A as nkdHelp,N as nkdIcon,P as nkdPopOut,F as nkdSelect,I as nkdSep,O as nkdSlider,K as nkdToggle,M as openNkdModal};
