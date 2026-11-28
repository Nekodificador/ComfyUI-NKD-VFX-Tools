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
/* The footer button that queues the node: ComfyUI's own Run colour, from the frontend's
   variable. Same meaning as the run button of a float (.nkd-ui-float button.run). */
.nkd-modal-btn.run { background: var(--color-brand-yellow, #f0ff41); border-color: transparent; color: #0c0d10; font-weight: 600; }
.nkd-modal-btn.run:hover { background: color-mix(in srgb, var(--color-brand-yellow, #f0ff41) 82%, #fff); border-color: transparent; }
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
/* The one that queues work on the server: ComfyUI's own Run colour, read from the frontend's
   variable so it follows the theme. Reserve it for that — one per editor at most. */
.nkd-ui-float button.run { background: var(--color-brand-yellow, #f0ff41); color: #0c0d10; }
.nkd-ui-float button.run:hover { background: color-mix(in srgb, var(--color-brand-yellow, #f0ff41) 82%, #fff); color: #0c0d10; }
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
`;function S(){if(document.getElementById(C))return;const i=document.createElement("style");i.id=C,i.textContent=z,document.head.appendChild(i)}function b(i){const e=document.createElement("div");return e.className=i,e}function I(i){S();const e=b("nkd-modal-overlay"),a=b("nkd-modal-panel");a.style.width=i.width??"92vw",a.style.height=i.height??"92vh",a.style.maxWidth=i.maxWidth??"1800px";const r=b("nkd-modal-head"),n=document.createElement("span");n.textContent=i.title;const d=document.createElement("span");d.className="nkd-modal-hint",d.textContent=i.hint??"";const t=document.createElement("button");t.className="nkd-modal-x",t.textContent="✕",t.title="Close (Esc)",r.append(n,d,b("nkd-modal-spacer"),t);const h=b("nkd-modal-body"),m=b("nkd-modal-foot"),k=b("nkd-modal-foot-left"),p=b("nkd-modal-foot-right");m.append(k,b("nkd-modal-spacer"),p),a.append(r,h,m),e.append(a),document.body.appendChild(e);let f=!1;function c(l="dismiss"){var s;f||(f=!0,window.removeEventListener("keydown",u,!0),e.remove(),(s=i.onClose)==null||s.call(i,l))}function u(l){var s;l.key==="Escape"&&(l.stopPropagation(),l.preventDefault(),!((s=o.beforeEsc)!=null&&s.call(o))&&c("dismiss"))}t.onclick=()=>c("dismiss"),i.closeOnEsc!==!1&&window.addEventListener("keydown",u,!0),i.closeOnBackdrop!==!1&&e.addEventListener("pointerdown",l=>{l.target===e&&c("dismiss")});const o={overlay:e,panel:a,head:r,body:h,footer:m,footerLeft:k,footerRight:p,setTitle:l=>{n.textContent=l},setHint:l=>{d.textContent=l},addPrimary(l,s){const x=L(l,()=>{s==null||s(),c("save")});return x.classList.add("primary"),p.appendChild(x),x},close:c};return o}function D(i,e,a={}){let r=e.parentElement;const n=b("");n.textContent=a.placeholder??"Open in the editor",n.style.cssText="display:flex;align-items:center;justify-content:center;width:100%;height:100%;box-sizing:border-box;color:rgba(255,255,255,0.35);font-size:11px;background:#111318;border:1px dashed #3a3d46;border-radius:4px;",r==null||r.appendChild(n),e.style.height="100%",e.style.flex="1 1 auto",i.body.appendChild(e);let d=!0,t=!1;const h=new Map,m=()=>{const u=[...h.values()];h.clear();for(const o of u)o()},k=()=>{var o;if(!d||e.parentElement===i.body)return;const u=e.parentElement;u&&(r=u,u.appendChild(n)),i.body.appendChild(e),(o=a.onReclaim)==null||o.call(a)},p=new MutationObserver(k);p.observe(i.body,{childList:!0});const f=()=>{t=!0},c=u=>{u.buttons||(t=!1,m())};return window.addEventListener("pointerdown",f,!0),window.addEventListener("pointerup",c,!0),window.addEventListener("pointercancel",c,!0),{write(u,o){d&&t?h.set(u,o):o()},flush:m,restore(){d&&(d=!1,p.disconnect(),window.removeEventListener("pointerdown",f,!0),window.removeEventListener("pointerup",c,!0),window.removeEventListener("pointercancel",c,!0),m(),r&&e.parentElement!==r&&r.appendChild(e),e.style.height="",e.style.flex="",n.remove())}}}function N(i,e,a,r=!1){const n=document.createElement("button");if(n.type="button",n.title=e,r)n.className="txt",n.textContent=i;else{const d=document.createElement("i");d.className=`pi pi-${i}`,n.appendChild(d)}return n.addEventListener("click",a),n}function M(i,e,a,...r){const n=b("nkd-ui nkd-ui-float"+(a?" col":""));n.style.cssText=e;for(const d of["pointerdown","mousedown","wheel","dblclick"])n.addEventListener(d,t=>t.stopPropagation());return n.append(...r),i.appendChild(n),n}function P(){const i=document.createElement("span");return i.className="nkd-ui-sep",i}function A(i,e,a){const r=b("nkd-ui nkd-ui-help");r.style.cssText="inset:14px 66px 14px 14px;display:none";const n=b("nkd-ui-help-head");n.innerHTML="<b>Shortcuts</b><span><kbd>?</kbd> or <kbd>Esc</kbd> to close</span>";const d=b("nkd-ui-help-cols");for(const[p,f]of a){const c=document.createElement("section"),u=document.createElement("h4");u.textContent=p,c.appendChild(u);for(const[o,l,s]of f){const x=b("nkd-ui-help-row"),w=document.createElement("span");w.textContent=o;const v=document.createElement("span");l.forEach((E,y)=>{y&&v.append("+");const g=document.createElement("kbd");g.textContent=E,v.appendChild(g)}),s&&v.append(s),x.append(w,v),c.appendChild(x)}d.appendChild(c)}r.append(n,d);for(const p of["pointerdown","mousedown","wheel","dblclick"])r.addEventListener(p,f=>f.stopPropagation());e.appendChild(r);let t=!1;const h=N("question","Shortcuts — ?",()=>m(!t)),m=p=>{t=p,r.style.display=p?"":"none",h.classList.toggle("on",p)};i.beforeEsc=()=>t?(m(!1),!0):!1;const k=p=>{if(!i.overlay.isConnected){window.removeEventListener("keydown",k,!0);return}if(p.key!=="?"||p.repeat)return;const f=document.activeElement;f&&(f.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(f.tagName))&&f.type!=="range"||(p.preventDefault(),p.stopPropagation(),m(!t))};return window.addEventListener("keydown",k,!0),h}function L(i,e,a){const r=document.createElement("button");return r.className="nkd-modal-btn",r.textContent=i,a&&(r.title=a),r.onclick=e,r}function K(i,e,a,r){let n=e;const d=L(i,()=>{n=!n,d.classList.toggle("on",n),a(n)},r);return d.classList.toggle("on",n),d}const T=.1;function R(i,e,a,r){const n=document.createElement("label"),d=!!e.kit;n.className=e.kit==="row"?"nkd-ui-row":e.kit==="bar"?"nkd-ui-barfield":"nkd-modal-lbl",r&&(n.title=r);const t=document.createElement("input");t.type="range",t.className=d?"nkd-ui-range":"nkd-modal-rng",t.min=String(e.min),t.max=String(e.max),t.step="any",t.value=String(e.value),e.width&&e.kit!=="row"&&(t.style.width=`${e.width}px`);const h=e.format?document.createElement("span"):null;h&&!d&&(h.className="nkd-modal-num");const m=e.fine??e.step/10,k=o=>Math.max(e.min,Math.min(e.max,o)),p=(o,l)=>{const s=l?m:e.step;return Math.round(Math.round(k(o)/s)*s*1e6)/1e6},f=o=>{h&&(h.textContent=e.format(o)),d&&t.style.setProperty("--nkd-pct",`${(o-e.min)/(e.max-e.min||1)*100}%`)},c=(o,l)=>{const s=p(o,l);t.value=String(s),f(s),a(s)};t.addEventListener("pointerdown",o=>{if(o.button!==0||t.disabled)return;o.preventDefault(),t.focus();try{t.setPointerCapture(o.pointerId)}catch{}const l=t.getBoundingClientRect(),s=e.max-e.min,x=Math.max(1,l.width);let w=o.shiftKey?parseFloat(t.value):k(e.min+(o.clientX-l.left)/x*s);c(w,o.shiftKey);let v=o.clientX;const E=g=>{w=k(w+(g.clientX-v)/x*s*(g.shiftKey?T:1)),v=g.clientX,c(w,g.shiftKey)},y=g=>{t.removeEventListener("pointermove",E),t.removeEventListener("pointerup",y),t.removeEventListener("pointercancel",y);try{t.releasePointerCapture(g.pointerId)}catch{}};t.addEventListener("pointermove",E),t.addEventListener("pointerup",y),t.addEventListener("pointercancel",y)}),t.addEventListener("keydown",o=>{const l=o.key==="ArrowRight"||o.key==="ArrowUp"?1:o.key==="ArrowLeft"||o.key==="ArrowDown"?-1:0;if(!l)return;o.preventDefault();const s=o.shiftKey?m:e.step;c(parseFloat(t.value)+l*s,o.shiftKey)}),t.addEventListener("dblclick",o=>{e.def==null||t.disabled||(o.preventDefault(),c(e.def,!1))});const u=document.createElement("span");return d||(u.className="nkd-modal-lbl-txt"),u.textContent=i,n.append(u,t),h&&n.appendChild(h),f(e.value),n.sync=o=>{t.value=String(o),f(o)},n.setDisabled=o=>{t.disabled=o,n.style.opacity=o?"0.45":""},n}function O(i,e,a,r){const n=document.createElement("select");n.className="nkd-modal-sel",r&&(n.title=r);for(const d of i){const t=document.createElement("option");t.value=d.value,t.textContent=d.label,n.appendChild(t)}return n.value=e,n.onchange=()=>a(n.value),n.addEventListener("wheel",d=>{d.preventDefault(),d.stopPropagation();const t=n.selectedIndex+(d.deltaY<0?1:-1);t<0||t>=n.options.length||(n.selectedIndex=t,n.dispatchEvent(new Event("change")))},{passive:!1}),n}export{S as ensureNkdModalStyles,L as nkdButton,M as nkdFloat,A as nkdHelp,N as nkdIcon,D as nkdPopOut,O as nkdSelect,P as nkdSep,R as nkdSlider,K as nkdToggle,I as openNkdModal};
