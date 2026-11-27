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
`;function S(){if(document.getElementById(C))return;const d=document.createElement("style");d.id=C,d.textContent=z,document.head.appendChild(d)}function m(d){const t=document.createElement("div");return t.className=d,t}function T(d){S();const t=m("nkd-modal-overlay"),l=m("nkd-modal-panel");l.style.width=d.width??"92vw",l.style.height=d.height??"92vh",l.style.maxWidth=d.maxWidth??"1800px";const i=m("nkd-modal-head"),n=document.createElement("span");n.textContent=d.title;const e=document.createElement("span");e.className="nkd-modal-hint",e.textContent=d.hint??"";const a=document.createElement("button");a.className="nkd-modal-x",a.textContent="✕",a.title="Close (Esc)",i.append(n,e,m("nkd-modal-spacer"),a);const b=m("nkd-modal-body"),f=m("nkd-modal-foot"),x=m("nkd-modal-foot-left"),p=m("nkd-modal-foot-right");f.append(x,m("nkd-modal-spacer"),p),l.append(i,b,f),t.append(l),document.body.appendChild(t);let c=!1;function u(r="dismiss"){var h;c||(c=!0,window.removeEventListener("keydown",o,!0),t.remove(),(h=d.onClose)==null||h.call(d,r))}function o(r){var h;r.key==="Escape"&&(r.stopPropagation(),r.preventDefault(),!((h=s.beforeEsc)!=null&&h.call(s))&&u("dismiss"))}a.onclick=()=>u("dismiss"),d.closeOnEsc!==!1&&window.addEventListener("keydown",o,!0),d.closeOnBackdrop!==!1&&t.addEventListener("pointerdown",r=>{r.target===t&&u("dismiss")});const s={overlay:t,panel:l,head:i,body:b,footer:f,footerLeft:x,footerRight:p,setTitle:r=>{n.textContent=r},setHint:r=>{e.textContent=r},addPrimary(r,h){const k=L(r,()=>{h==null||h(),u("save")});return k.classList.add("primary"),p.appendChild(k),k},close:u};return s}function D(d,t,l={}){let i=t.parentElement;const n=m("");n.textContent=l.placeholder??"Open in the editor",n.style.cssText="display:flex;align-items:center;justify-content:center;width:100%;height:100%;box-sizing:border-box;color:rgba(255,255,255,0.35);font-size:11px;background:#111318;border:1px dashed #3a3d46;border-radius:4px;",i==null||i.appendChild(n),t.style.height="100%",t.style.flex="1 1 auto",d.body.appendChild(t);let e=!0,a=!1;const b=new Map,f=()=>{const o=[...b.values()];b.clear();for(const s of o)s()},x=()=>{var s;if(!e||t.parentElement===d.body)return;const o=t.parentElement;o&&(i=o,o.appendChild(n)),d.body.appendChild(t),(s=l.onReclaim)==null||s.call(l)},p=new MutationObserver(x);p.observe(d.body,{childList:!0});const c=()=>{a=!0},u=o=>{o.buttons||(a=!1,f())};return window.addEventListener("pointerdown",c,!0),window.addEventListener("pointerup",u,!0),window.addEventListener("pointercancel",u,!0),{write(o,s){e&&a?b.set(o,s):s()},flush:f,restore(){e&&(e=!1,p.disconnect(),window.removeEventListener("pointerdown",c,!0),window.removeEventListener("pointerup",u,!0),window.removeEventListener("pointercancel",u,!0),f(),i&&t.parentElement!==i&&i.appendChild(t),t.style.height="",t.style.flex="",n.remove())}}}function N(d,t,l,i=!1){const n=document.createElement("button");if(n.type="button",n.title=t,i)n.className="txt",n.textContent=d;else{const e=document.createElement("i");e.className=`pi pi-${d}`,n.appendChild(e)}return n.addEventListener("click",l),n}function I(d,t,l,...i){const n=m("nkd-ui nkd-ui-float"+(l?" col":""));n.style.cssText=t;for(const e of["pointerdown","mousedown","wheel","dblclick"])n.addEventListener(e,a=>a.stopPropagation());return n.append(...i),d.appendChild(n),n}function P(){const d=document.createElement("span");return d.className="nkd-ui-sep",d}function A(d,t,l){const i=m("nkd-ui nkd-ui-help");i.style.cssText="inset:14px 66px 14px 14px;display:none";const n=m("nkd-ui-help-head");n.innerHTML="<b>Shortcuts</b><span><kbd>?</kbd> or <kbd>Esc</kbd> to close</span>";const e=m("nkd-ui-help-cols");for(const[p,c]of l){const u=document.createElement("section"),o=document.createElement("h4");o.textContent=p,u.appendChild(o);for(const[s,r,h]of c){const k=m("nkd-ui-help-row"),v=document.createElement("span");v.textContent=s;const w=document.createElement("span");r.forEach((y,g)=>{g&&w.append("+");const E=document.createElement("kbd");E.textContent=y,w.appendChild(E)}),h&&w.append(h),k.append(v,w),u.appendChild(k)}e.appendChild(u)}i.append(n,e);for(const p of["pointerdown","mousedown","wheel","dblclick"])i.addEventListener(p,c=>c.stopPropagation());t.appendChild(i);let a=!1;const b=N("question","Shortcuts — ?",()=>f(!a)),f=p=>{a=p,i.style.display=p?"":"none",b.classList.toggle("on",p)};d.beforeEsc=()=>a?(f(!1),!0):!1;const x=p=>{if(!d.overlay.isConnected){window.removeEventListener("keydown",x,!0);return}if(p.key!=="?"||p.repeat)return;const c=document.activeElement;c&&(c.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(c.tagName))&&c.type!=="range"||(p.preventDefault(),p.stopPropagation(),f(!a))};return window.addEventListener("keydown",x,!0),b}function L(d,t,l){const i=document.createElement("button");return i.className="nkd-modal-btn",i.textContent=d,l&&(i.title=l),i.onclick=t,i}function K(d,t,l,i){let n=t;const e=L(d,()=>{n=!n,e.classList.toggle("on",n),l(n)},i);return e.classList.toggle("on",n),e}const M=.1;function O(d,t,l,i){const n=document.createElement("label");n.className="nkd-modal-lbl",i&&(n.title=i);const e=document.createElement("input");e.type="range",e.className="nkd-modal-rng",e.min=String(t.min),e.max=String(t.max),e.step="any",e.value=String(t.value),t.width&&(e.style.width=`${t.width}px`);const a=t.format?document.createElement("span"):null;a&&(a.className="nkd-modal-num");const b=t.fine??t.step/10,f=o=>Math.max(t.min,Math.min(t.max,o)),x=(o,s)=>{const r=s?b:t.step;return Math.round(Math.round(f(o)/r)*r*1e6)/1e6},p=o=>{a&&(a.textContent=t.format(o))},c=(o,s)=>{const r=x(o,s);e.value=String(r),p(r),l(r)};e.addEventListener("pointerdown",o=>{if(o.button!==0||e.disabled)return;o.preventDefault(),e.focus();try{e.setPointerCapture(o.pointerId)}catch{}const s=e.getBoundingClientRect(),r=t.max-t.min,h=Math.max(1,s.width);let k=o.shiftKey?parseFloat(e.value):f(t.min+(o.clientX-s.left)/h*r);c(k,o.shiftKey);let v=o.clientX;const w=g=>{k=f(k+(g.clientX-v)/h*r*(g.shiftKey?M:1)),v=g.clientX,c(k,g.shiftKey)},y=g=>{e.removeEventListener("pointermove",w),e.removeEventListener("pointerup",y),e.removeEventListener("pointercancel",y);try{e.releasePointerCapture(g.pointerId)}catch{}};e.addEventListener("pointermove",w),e.addEventListener("pointerup",y),e.addEventListener("pointercancel",y)}),e.addEventListener("keydown",o=>{const s=o.key==="ArrowRight"||o.key==="ArrowUp"?1:o.key==="ArrowLeft"||o.key==="ArrowDown"?-1:0;if(!s)return;o.preventDefault();const r=o.shiftKey?b:t.step;c(parseFloat(e.value)+s*r,o.shiftKey)});const u=document.createElement("span");return u.className="nkd-modal-lbl-txt",u.textContent=d,n.append(u,e),a&&n.appendChild(a),p(t.value),n.sync=o=>{e.value=String(o),p(o)},n.setDisabled=o=>{e.disabled=o,n.style.opacity=o?"0.45":""},n}function F(d,t,l,i){const n=document.createElement("select");n.className="nkd-modal-sel",i&&(n.title=i);for(const e of d){const a=document.createElement("option");a.value=e.value,a.textContent=e.label,n.appendChild(a)}return n.value=t,n.onchange=()=>l(n.value),n.addEventListener("wheel",e=>{e.preventDefault(),e.stopPropagation();const a=n.selectedIndex+(e.deltaY<0?1:-1);a<0||a>=n.options.length||(n.selectedIndex=a,n.dispatchEvent(new Event("change")))},{passive:!1}),n}export{S as ensureNkdModalStyles,L as nkdButton,I as nkdFloat,A as nkdHelp,N as nkdIcon,D as nkdPopOut,F as nkdSelect,P as nkdSep,O as nkdSlider,K as nkdToggle,T as openNkdModal};
