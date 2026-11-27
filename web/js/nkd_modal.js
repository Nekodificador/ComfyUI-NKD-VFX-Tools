const E="nkd-modal-styles",L=`
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
`;function C(){if(document.getElementById(E))return;const d=document.createElement("style");d.id=E,d.textContent=L,document.head.appendChild(d)}function f(d){const n=document.createElement("div");return n.className=d,n}function N(d){C();const n=f("nkd-modal-overlay"),l=f("nkd-modal-panel");l.style.width=d.width??"92vw",l.style.height=d.height??"92vh",l.style.maxWidth=d.maxWidth??"1800px";const a=f("nkd-modal-head"),o=document.createElement("span");o.textContent=d.title;const e=document.createElement("span");e.className="nkd-modal-hint",e.textContent=d.hint??"";const r=document.createElement("button");r.className="nkd-modal-x",r.textContent="✕",r.title="Close (Esc)",a.append(o,e,f("nkd-modal-spacer"),r);const h=f("nkd-modal-body"),c=f("nkd-modal-foot"),m=f("nkd-modal-foot-left"),u=f("nkd-modal-foot-right");c.append(m,f("nkd-modal-spacer"),u),l.append(a,h,c),n.append(l),document.body.appendChild(n);let x=!1;function p(i="dismiss"){var s;x||(x=!0,window.removeEventListener("keydown",t,!0),n.remove(),(s=d.onClose)==null||s.call(d,i))}function t(i){i.key==="Escape"&&(i.stopPropagation(),i.preventDefault(),p("dismiss"))}return r.onclick=()=>p("dismiss"),d.closeOnEsc!==!1&&window.addEventListener("keydown",t,!0),d.closeOnBackdrop!==!1&&n.addEventListener("pointerdown",i=>{i.target===n&&p("dismiss")}),{overlay:n,panel:l,head:a,body:h,footer:c,footerLeft:m,footerRight:u,setTitle:i=>{o.textContent=i},setHint:i=>{e.textContent=i},addPrimary(i,s){const b=z(i,()=>{s==null||s(),p("save")});return b.classList.add("primary"),u.appendChild(b),b},close:p}}function M(d,n,l={}){let a=n.parentElement;const o=f("");o.textContent=l.placeholder??"Open in the editor",o.style.cssText="display:flex;align-items:center;justify-content:center;width:100%;height:100%;box-sizing:border-box;color:rgba(255,255,255,0.35);font-size:11px;background:#111318;border:1px dashed #3a3d46;border-radius:4px;",a==null||a.appendChild(o),n.style.height="100%",n.style.flex="1 1 auto",d.body.appendChild(n);let e=!0,r=!1;const h=new Map,c=()=>{const t=[...h.values()];h.clear();for(const i of t)i()},m=()=>{var i;if(!e||n.parentElement===d.body)return;const t=n.parentElement;t&&(a=t,t.appendChild(o)),d.body.appendChild(n),(i=l.onReclaim)==null||i.call(l)},u=new MutationObserver(m);u.observe(d.body,{childList:!0});const x=()=>{r=!0},p=t=>{t.buttons||(r=!1,c())};return window.addEventListener("pointerdown",x,!0),window.addEventListener("pointerup",p,!0),window.addEventListener("pointercancel",p,!0),{write(t,i){e&&r?h.set(t,i):i()},flush:c,restore(){e&&(e=!1,u.disconnect(),window.removeEventListener("pointerdown",x,!0),window.removeEventListener("pointerup",p,!0),window.removeEventListener("pointercancel",p,!0),c(),a&&n.parentElement!==a&&a.appendChild(n),n.style.height="",n.style.flex="",o.remove())}}}function z(d,n,l){const a=document.createElement("button");return a.className="nkd-modal-btn",a.textContent=d,l&&(a.title=l),a.onclick=n,a}function D(d,n,l,a){let o=n;const e=z(d,()=>{o=!o,e.classList.toggle("on",o),l(o)},a);return e.classList.toggle("on",o),e}const S=.1;function I(d,n,l,a){const o=document.createElement("label");o.className="nkd-modal-lbl",a&&(o.title=a);const e=document.createElement("input");e.type="range",e.className="nkd-modal-rng",e.min=String(n.min),e.max=String(n.max),e.step="any",e.value=String(n.value),n.width&&(e.style.width=`${n.width}px`);const r=n.format?document.createElement("span"):null;r&&(r.className="nkd-modal-num");const h=n.fine??n.step/10,c=t=>Math.max(n.min,Math.min(n.max,t)),m=(t,i)=>{const s=i?h:n.step;return Math.round(Math.round(c(t)/s)*s*1e6)/1e6},u=t=>{r&&(r.textContent=n.format(t))},x=(t,i)=>{const s=m(t,i);e.value=String(s),u(s),l(s)};e.addEventListener("pointerdown",t=>{if(t.button!==0||e.disabled)return;t.preventDefault(),e.focus();try{e.setPointerCapture(t.pointerId)}catch{}const i=e.getBoundingClientRect(),s=n.max-n.min,b=Math.max(1,i.width);let k=t.shiftKey?parseFloat(e.value):c(n.min+(t.clientX-i.left)/b*s);x(k,t.shiftKey);let v=t.clientX;const y=g=>{k=c(k+(g.clientX-v)/b*s*(g.shiftKey?S:1)),v=g.clientX,x(k,g.shiftKey)},w=g=>{e.removeEventListener("pointermove",y),e.removeEventListener("pointerup",w),e.removeEventListener("pointercancel",w);try{e.releasePointerCapture(g.pointerId)}catch{}};e.addEventListener("pointermove",y),e.addEventListener("pointerup",w),e.addEventListener("pointercancel",w)}),e.addEventListener("keydown",t=>{const i=t.key==="ArrowRight"||t.key==="ArrowUp"?1:t.key==="ArrowLeft"||t.key==="ArrowDown"?-1:0;if(!i)return;t.preventDefault();const s=t.shiftKey?h:n.step;x(parseFloat(e.value)+i*s,t.shiftKey)});const p=document.createElement("span");return p.className="nkd-modal-lbl-txt",p.textContent=d,o.append(p,e),r&&o.appendChild(r),u(n.value),o.sync=t=>{e.value=String(t),u(t)},o.setDisabled=t=>{e.disabled=t,o.style.opacity=t?"0.45":""},o}function K(d,n,l,a){const o=document.createElement("select");o.className="nkd-modal-sel",a&&(o.title=a);for(const e of d){const r=document.createElement("option");r.value=e.value,r.textContent=e.label,o.appendChild(r)}return o.value=n,o.onchange=()=>l(o.value),o.addEventListener("wheel",e=>{e.preventDefault(),e.stopPropagation();const r=o.selectedIndex+(e.deltaY<0?1:-1);r<0||r>=o.options.length||(o.selectedIndex=r,o.dispatchEvent(new Event("change")))},{passive:!1}),o}export{C as ensureNkdModalStyles,z as nkdButton,M as nkdPopOut,K as nkdSelect,I as nkdSlider,D as nkdToggle,N as openNkdModal};
