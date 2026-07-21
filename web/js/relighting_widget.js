import{d as tn,o as nn,n as mt,a as sn,b as O,c as W,e as a,F as et,r as kt,f as on,w as an,g as ye,T as ln,h as Q,i as Ue,j as K,v as ee,k as le,t as q,l as rn,m as N,p as un,u as Ut,_ as dn,q as cn}from"./assets/_plugin-vue_export-helper-B2JzIScF.js";import{app as fn}from"../../scripts/app.js";import{api as Se}from"../../scripts/api.js";const hn={class:"rl-root"},mn=["onMousedown","onClick","onDblclick"],vn={key:0,class:"rl-processing-overlay"},pn={class:"rl-controls"},gn={class:"rl-btnbar"},bn=["disabled"],yn=["disabled"],Sn=["disabled"],wn=["onClick"],Mn={class:"rl-light-icon"},Rn={class:"rl-sec-title"},Ln=["onUpdate:modelValue"],An=["onClick"],_n={key:0,class:"rl-sec-body"},En={class:"rl-field"},Dn=["onUpdate:modelValue"],Cn={class:"rl-fval"},In={class:"rl-field"},Tn=["onUpdate:modelValue"],xn={class:"rl-fval"},Pn={class:"rl-field"},kn=["onUpdate:modelValue"],Un={class:"rl-fval"},zn={class:"rl-field"},Nn=["onUpdate:modelValue"],Bn={class:"rl-fval"},Fn={class:"rl-field"},Vn=["onUpdate:modelValue"],Gn={class:"rl-fval"},On={class:"rl-section"},Wn={key:0,class:"rl-sec-body"},Xn={class:"rl-field"},Yn={class:"rl-fval"},Hn={key:0,class:"rl-section"},$n={key:0,class:"rl-sec-body"},Zn={key:0,class:"rl-field"},Kn={class:"rl-fval"},qn={key:1,class:"rl-field"},Jn={class:"rl-fval"},jn={class:"rl-section"},Qn={class:"rl-field"},es=["disabled"],ts={class:"rl-fval"},ns={class:"rl-field"},ss=["disabled"],os={class:"rl-fval"},as={class:"rl-field"},ls=["disabled"],is={class:"rl-fval"},zt=24,rs=.012,us=.03,ds=`
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`,cs=`
precision highp float;
varying vec2 vUv;

uniform sampler2D uRgb;
uniform sampler2D uNormals;
uniform sampler2D uDepth;
uniform sampler2D uAlbedo;
uniform sampler2D uRoughness;

uniform int   uHasAlbedo;
uniform int   uHasRoughness;
uniform float uAmbR;
uniform float uAmbG;
uniform float uAmbB;
uniform float uAmbientIntensity;
uniform float uDelitMix;
uniform float uRoughnessStrength;
uniform int   uLightCount;

// Screen-space shadow uniforms
uniform int   uShadowOn;
uniform float uShadowStrength;
uniform float uShadowSoftness;
uniform float uShadowRange;

// Flat light arrays (max 3) — avoids struct array issues in GLSL ES 1.00
uniform int   uLType[3];
uniform float uLColorR[3];
uniform float uLColorG[3];
uniform float uLColorB[3];
uniform float uLIntensity[3];
uniform float uLX[3];
uniform float uLY[3];
uniform float uLZ[3];
uniform float uLRadius[3];
uniform float uLAzimuth[3];
uniform float uLElevation[3];

// Screen-space shadow tracer — marches the depth pass toward the light.
// uv0/d0: surface image-UV + depth. sdir: screen-space dir toward the light
// (v down, +z toward camera). Returns occlusion in [0,1] (0 = fully lit).
const int SHADOW_STEPS = 24;
const float SHADOW_BIAS  = 0.012;
const float SHADOW_SLOPE = 0.030;

float traceShadow(vec2 uv0, float d0, vec3 sdir) {
  if (uShadowOn == 0 || uShadowStrength <= 0.0) return 0.0;
  float occ = 0.0;
  float window = uShadowSoftness * 0.5 + 1e-3;
  for (int s = 1; s <= SHADOW_STEPS; s++) {
    float t = (float(s) / float(SHADOW_STEPS)) * uShadowRange;
    vec2 p = uv0 + sdir.xy * t;
    float rayZ = d0 + sdir.z * t;
    // imgUv → depth-texture UV (textures uploaded with UNPACK_FLIP_Y)
    vec3 dd = texture2D(uDepth, vec2(p.x, 1.0 - p.y)).rgb;
    float sceneZ = (dd.r + dd.g + dd.b) / 3.0;
    float surplus = sceneZ - rayZ - (SHADOW_BIAS + SHADOW_SLOPE * t);
    occ = max(occ, clamp(surplus / window, 0.0, 1.0));
  }
  return occ;
}

vec3 calcLight(int i, vec3 N, vec2 imgUv, float dVal, float smoothness, float shininess) {
  float contrib         = 0.0;
  float att             = 1.0;
  vec3  ld              = vec3(0.0);
  float lightSolidAngle = 0.0;
  vec3  sdir            = vec3(0.0);

  if (uLType[i] == 0) {
    // Directional light — uniform direction across all pixels
    float az = uLAzimuth[i];
    float el = uLElevation[i];
    ld = normalize(vec3(cos(el) * sin(az), sin(el), cos(el) * cos(az)));
    // Screen-space marching dir matches point lights: ld is in the same mixed
    // space as imgUv (N has been pre-flipped via N.y = -N.y), so no Y flip here.
    sdir = ld;
    contrib = max(dot(N, ld), 0.0);
  } else {
    // Point light — per-pixel direction and attenuation
    vec3 toLight = vec3(uLX[i] - imgUv.x, uLY[i] - imgUv.y, uLZ[i] - dVal);
    float dist = max(length(toLight), 1.0e-8);
    ld = toLight / dist;
    // Marching dir already in image-UV space (v down, +z toward camera)
    sdir = ld;
    // Windowed falloff: att reaches exactly 0 at dist=radius, so the radius
    // defines the boundary of the lit region without affecting brightness within it.
    float nd = dist / uLRadius[i];
    att = pow(max(1.0 - nd * nd, 0.0), 2.0);
    // Map radius slider [0.05, 2.0] → softness [0.1, 1.0].
    lightSolidAngle = clamp((uLRadius[i] - 0.05) / 1.95, 0.0, 1.0);
    // Wrapped diffuse: large radius adds fill light near the shadow terminator,
    // matching the behaviour of a large physical light source (softbox, window).
    // Normalization by (1+w) keeps full brightness on the lit side unchanged.
    float w = lightSolidAngle * 1.0;
    float rawDot = dot(N, ld);
    contrib = max(rawDot + w, 0.0) / (1.0 + w) * att;
  }

  // Blinn-Phong specular: H = normalize(L + V), view direction V = (0, 0, 1)
  if (uHasRoughness == 1) {
    vec3 H = normalize(ld + vec3(0.0, 0.0, 1.0));
    float ndoth = max(dot(N, H), 0.0);
    // Larger solid angle → lower effective shininess → softer, broader highlight.
    // Directional lights: lightSolidAngle = 0.0, so effShininess = shininess (unchanged).
    float effShininess = (uLType[i] == 1)
        ? shininess * (1.0 - lightSolidAngle * 0.95) + 1.0
        : shininess;
    float spec = pow(ndoth, effShininess) * smoothness * smoothness * att;
    contrib += spec;
  }

  // Screen-space shadow attenuation
  float shadow = traceShadow(imgUv, dVal, sdir);
  contrib *= (1.0 - uShadowStrength * shadow);

  return contrib * vec3(uLColorR[i], uLColorG[i], uLColorB[i]) * uLIntensity[i];
}

void main() {
  // vUv: (0,0)=bottom-left, (1,1)=top-right (OpenGL convention)
  // imgUv: (0,0)=top-left, y increases downward (matches light.x/y coordinates)
  vec2 imgUv = vec2(vUv.x, 1.0 - vUv.y);

  vec3 rgb  = texture2D(uRgb,     vUv).rgb;
  vec3 norm = texture2D(uNormals, vUv).rgb;
  vec3 dep  = texture2D(uDepth,   vUv).rgb;

  // Decode normal: [0,1] → [-1,1], flip Y (OpenGL Y-up convention)
  vec3 N = norm * 2.0 - 1.0;
  N.y = -N.y;
  N = normalize(N);

  // Depth: luminance
  float dVal = (dep.r + dep.g + dep.b) / 3.0;

  // Roughness → smoothness + shininess
  float smoothness = 1.0;
  float shininess  = 129.0;
  if (uHasRoughness == 1) {
    vec3 rouRaw = texture2D(uRoughness, vUv).rgb;
    float roughVal = clamp((rouRaw.r + rouRaw.g + rouRaw.b) / 3.0 * uRoughnessStrength, 0.0, 1.0);
    smoothness = 1.0 - roughVal;
    shininess  = smoothness * smoothness * 128.0 + 1.0;
  }

  // Base color with delit mix
  vec3 base = rgb;
  if (uHasAlbedo == 1 && uDelitMix > 0.0) {
    vec3 alb = texture2D(uAlbedo, vUv).rgb;
    base = mix(rgb, alb, uDelitMix);
  }

  // Ambient seed
  vec3 lightAccum = vec3(uAmbR, uAmbG, uAmbB) * uAmbientIntensity;

  // Accumulate lights (unrolled to avoid GLSL ES loop-variable restrictions)
  if (uLightCount > 0) lightAccum += calcLight(0, N, imgUv, dVal, smoothness, shininess);
  if (uLightCount > 1) lightAccum += calcLight(1, N, imgUv, dVal, smoothness, shininess);
  if (uLightCount > 2) lightAccum += calcLight(2, N, imgUv, dVal, smoothness, shininess);

  gl_FragColor = vec4(clamp(base * lightAccum, 0.0, 1.0), 1.0);
}`,fs=tn({__name:"RelightingCanvas",props:{onChange:{type:Function}},setup(de,{expose:X}){const tt=de,d=N([]),M=N(null),_=N(.2),m=N("#ffffff"),U=N(0),V=N(1),B=N(!1),E=N(.6),te=N(.3),G=N(.15),ne=N(null),J=N(null),we=N("16 / 9");let Y=null,ze=null,Me=null,ie=null,Re=null,F=0,H=0;const Le=N(!1),he=N(!1),Ae=N(!1),Ze=un(()=>d.value.filter(t=>t.type==="point")),b=N({ambient:!1,material:!1,shadows:!1});function x(t){b.value[t]=!b.value[t]}function D(t,e,n){return{"--rl-fill":Math.max(0,Math.min(100,(t-e)/(n-e)*100))+"%"}}let _e=null;function vt(){_e===null&&(_e=requestAnimationFrame(()=>{_e=null,qe()}))}const Fe=N(new Set);function Nt(t){st=!0,setTimeout(()=>{st=!1},300);const e=Fe.value;e.has(t)?e.delete(t):e.add(t),Fe.value=new Set(e),vt()}let Ve=null,nt=!1,st=!1;function Bt(t,e){M.value=e.id,Ve=e,nt=!1;const n=o=>{if(!J.value)return;nt=!0;const r=J.value.getBoundingClientRect();e.x=Math.max(0,Math.min(1,(o.clientX-r.left)/r.width)),e.y=Math.max(0,Math.min(1,(o.clientY-r.top)/r.height)),C()},i=()=>{Ve=null,document.removeEventListener("mousemove",n),document.removeEventListener("mouseup",i)};document.addEventListener("mousemove",n),document.addEventListener("mouseup",i)}function Ft(){Ve=null}function Vt(t){if(!Ve||!(t.buttons&1)){Ve=null;return}}let pt=0,gt=0,Ne=0,Ge=!1,ot=1;function Gt(t){Ge=!1;const e=ne.value;if(!e)return;const n=e.getBoundingClientRect(),i=(t.clientX-n.left)*(e.width/n.width),o=(t.clientY-n.top)*(e.height/n.height);if(Ne>0){const u=i-pt,p=o-gt;if(u*u+p*p<=Ne*Ne){const y=d.value.find(f=>f.id===M.value&&f.type==="directional");if(y){Ge=!0;let f=t.clientX,L=t.clientY;const P=S=>{const Z=(S.clientX-f)*(e.width/n.width),v=(S.clientY-L)*(e.height/n.height);f=S.clientX,L=S.clientY;const w=90/Ne;y.azimuth=Math.round(((y.azimuth+Z*w)%360+360+180)%360-180),y.elevation=Math.round(Math.max(-90,Math.min(90,y.elevation+v*w))),C()},A=()=>{document.removeEventListener("mousemove",P),document.removeEventListener("mouseup",A)};document.addEventListener("mousemove",P),document.addEventListener("mouseup",A);return}}}const r=ot,l={innerR:18*r,maxLW:22*r,tol:4*r},h=Math.PI/6,z=5*Math.PI/6,R=3*Math.PI/2,I=(u,p,y,f,L=!1)=>{Ge=!0;let P=t.clientY;const A=(f-y)/(60*n.height/e.height),S=v=>{const w=(v.clientY-P)*A;p(Math.max(y,Math.min(f,u()+(L?w:-w)))),P=v.clientY,C()},Z=()=>{document.removeEventListener("mousemove",S),document.removeEventListener("mouseup",Z)};document.addEventListener("mousemove",S),document.addEventListener("mouseup",Z)};for(const u of d.value){if(u.type!=="point")continue;const p=u.x*e.width,y=u.y*e.height,f=i-p,L=o-y,P=Math.sqrt(f*f+L*L),A=Math.atan2(L,f),S=A<0?A+2*Math.PI:A,Z=S>=R||S<h,v=S>=h&&S<z,w=S>=z&&S<R;if(P>=l.innerR-l.tol&&P<=l.innerR+l.maxLW+l.tol){if(Z){M.value=u.id,I(()=>u.intensity,oe=>{u.intensity=oe},0,2);return}if(v){M.value=u.id,I(()=>u.z,oe=>{u.z=oe},0,2,!0);return}if(w){M.value=u.id,I(()=>u.radius,oe=>{u.radius=oe},.05,2);return}}}}function Ot(t){if(Ge){Ge=!1;return}if(!J.value)return;const e=d.value.find(i=>i.id===M.value);if(!e||e.type!=="point")return;const n=J.value.getBoundingClientRect();e.x=(t.clientX-n.left)/n.width,e.y=(t.clientY-n.top)/n.height,C()}function bt(t){if(d.value.length>=3)return;const e={id:Date.now(),type:t,color:"#ffffff",intensity:1,x:.3+d.value.length*.2,y:.5,z:.5,azimuth:0,elevation:45,radius:.5,falloff:2};d.value.push(e),M.value=e.id,C()}function yt(t){d.value=d.value.filter(e=>e.id!==t),M.value===t&&(M.value=null),Fe.value.delete(t),C()}function Wt(){d.value=[],M.value=null,Fe.value.clear(),C()}function St(t){M.value=M.value===t?null:t}function Oe(t){let e=t.replace("#","");return e.length===3&&(e=e[0]+e[0]+e[1]+e[1]+e[2]+e[2]),[parseInt(e.substring(0,2),16)/255,parseInt(e.substring(2,4),16)/255,parseInt(e.substring(4,6),16)/255]}let Ee=null,s=null,$=null,We=null,se={rgb:null,normals:null,depth:null,albedo:null,roughness:null},c={},at=-1,re=!1,lt=0,it=0,Ke=!1;function wt(t,e,n){const i=t.createShader(e);return i?(t.shaderSource(i,n),t.compileShader(i),t.getShaderParameter(i,t.COMPILE_STATUS)?i:(console.error("[NKD-Relight] Shader compile error:",t.getShaderInfoLog(i)),t.deleteShader(i),null)):null}function Mt(t,e){try{Ee=new OffscreenCanvas(t,e);const n=Ee.getContext("webgl",{preserveDrawingBuffer:!0,antialias:!1});if(!n)return re=!1,!1;s=n;const i=wt(s,s.VERTEX_SHADER,ds),o=wt(s,s.FRAGMENT_SHADER,cs);if(!i||!o)return re=!1,!1;if($=s.createProgram(),s.attachShader($,i),s.attachShader($,o),s.linkProgram($),s.deleteShader(i),s.deleteShader(o),!s.getProgramParameter($,s.LINK_STATUS))return console.error("[NKD-Relight] Program link error:",s.getProgramInfoLog($)),re=!1,!1;We=s.createBuffer(),s.bindBuffer(s.ARRAY_BUFFER,We),s.bufferData(s.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,-1,1,1,-1,1]),s.STATIC_DRAW);const r=()=>{const h=s.createTexture();return s.bindTexture(s.TEXTURE_2D,h),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MIN_FILTER,s.LINEAR),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MAG_FILTER,s.LINEAR),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_WRAP_S,s.CLAMP_TO_EDGE),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_WRAP_T,s.CLAMP_TO_EDGE),h};se={rgb:r(),normals:r(),depth:r(),albedo:r(),roughness:r()},s.useProgram($);const l=h=>s.getUniformLocation($,h);return c={uRgb:l("uRgb"),uNormals:l("uNormals"),uDepth:l("uDepth"),uAlbedo:l("uAlbedo"),uRoughness:l("uRoughness"),uHasAlbedo:l("uHasAlbedo"),uHasRoughness:l("uHasRoughness"),uAmbR:l("uAmbR"),uAmbG:l("uAmbG"),uAmbB:l("uAmbB"),uAmbientIntensity:l("uAmbientIntensity"),uDelitMix:l("uDelitMix"),uRoughnessStrength:l("uRoughnessStrength"),uShadowOn:l("uShadowOn"),uShadowStrength:l("uShadowStrength"),uShadowSoftness:l("uShadowSoftness"),uShadowRange:l("uShadowRange"),uLightCount:l("uLightCount"),uLType0:l("uLType[0]"),uLType1:l("uLType[1]"),uLType2:l("uLType[2]"),uLColorR:l("uLColorR"),uLColorG:l("uLColorG"),uLColorB:l("uLColorB"),uLIntensity:l("uLIntensity"),uLX:l("uLX"),uLY:l("uLY"),uLZ:l("uLZ"),uLRadius:l("uLRadius"),uLAzimuth:l("uLAzimuth"),uLElevation:l("uLElevation")},s.uniform1i(c.uRgb,0),s.uniform1i(c.uNormals,1),s.uniform1i(c.uDepth,2),s.uniform1i(c.uAlbedo,3),s.uniform1i(c.uRoughness,4),at=s.getAttribLocation($,"aPos"),lt=t,it=e,re=!0,!0}catch(n){return console.warn("[NKD-Relight] WebGL init failed, falling back to JS shader:",n),re=!1,!1}}function Xt(){if(!s||!re)return;s.pixelStorei(s.UNPACK_FLIP_Y_WEBGL,1);const t=(e,n)=>{e&&(s.bindTexture(s.TEXTURE_2D,e),n?s.texImage2D(s.TEXTURE_2D,0,s.RGB,F,H,0,s.RGB,s.UNSIGNED_BYTE,n):s.texImage2D(s.TEXTURE_2D,0,s.RGB,1,1,0,s.RGB,s.UNSIGNED_BYTE,new Uint8Array(3)))};t(se.rgb,Y),t(se.normals,ze),t(se.depth,Me),t(se.albedo,ie),t(se.roughness,Re),Ke=!1}function Rt(t,e,n){if(!s||!$||!Ee)return;(lt!==e||it!==n)&&(Ee.width=e,Ee.height=n,s.viewport(0,0,e,n),lt=e,it=n,Ke=!0),Ke&&Xt(),s.useProgram($),s.viewport(0,0,e,n);const i=(v,w)=>{s.activeTexture(s.TEXTURE0+v),s.bindTexture(s.TEXTURE_2D,w)};i(0,se.rgb),i(1,se.normals),i(2,se.depth),i(3,se.albedo),i(4,se.roughness);const[o,r,l]=Oe(m.value);s.uniform1f(c.uAmbR,o),s.uniform1f(c.uAmbG,r),s.uniform1f(c.uAmbB,l),s.uniform1f(c.uAmbientIntensity,_.value),s.uniform1f(c.uDelitMix,U.value),s.uniform1f(c.uRoughnessStrength,V.value),s.uniform1i(c.uHasAlbedo,Le.value?1:0),s.uniform1i(c.uHasRoughness,he.value?1:0),s.uniform1i(c.uShadowOn,B.value?1:0),s.uniform1f(c.uShadowStrength,E.value),s.uniform1f(c.uShadowSoftness,te.value),s.uniform1f(c.uShadowRange,G.value);const h=d.value,z=h.length;s.uniform1i(c.uLightCount,z);const R=[0,0,0],I=[1,1,1],u=[1,1,1],p=[1,1,1],y=[0,0,0],f=[0,0,0],L=[0,0,0],P=[0,0,0],A=[1,1,1],S=[0,0,0],Z=[0,0,0];for(let v=0;v<z;v++){const w=h[v];R[v]=w.type==="directional"?0:1;const[De,oe,Ye]=Oe(w.color);I[v]=De,u[v]=oe,p[v]=Ye,y[v]=w.intensity,f[v]=w.x,L[v]=w.y,P[v]=w.z,A[v]=w.radius,S[v]=w.azimuth*Math.PI/180,Z[v]=w.elevation*Math.PI/180}s.uniform1i(c.uLType0,R[0]),s.uniform1i(c.uLType1,R[1]),s.uniform1i(c.uLType2,R[2]),s.uniform1fv(c.uLColorR,I),s.uniform1fv(c.uLColorG,u),s.uniform1fv(c.uLColorB,p),s.uniform1fv(c.uLIntensity,y),s.uniform1fv(c.uLX,f),s.uniform1fv(c.uLY,L),s.uniform1fv(c.uLZ,P),s.uniform1fv(c.uLRadius,A),s.uniform1fv(c.uLAzimuth,S),s.uniform1fv(c.uLElevation,Z),s.bindBuffer(s.ARRAY_BUFFER,We),s.enableVertexAttribArray(at),s.vertexAttribPointer(at,2,s.FLOAT,!1,0,0),s.drawArrays(s.TRIANGLES,0,6),t.drawImage(Ee,0,0,e,n)}function Yt(){s&&(Object.values(se).forEach(t=>t&&s.deleteTexture(t)),We&&s.deleteBuffer(We),$&&s.deleteProgram($),Ee=null,s=null,$=null,re=!1)}function Ht(t,e,n){const i=t.createImageData(e,n),o=i.data,r=F,l=H,h=Y,z=ze,R=Me,I=ie,u=Re,p=U.value,y=V.value,[f,L,P]=Oe(m.value),A=_.value,S=d.value.map(T=>({type:T.type,color:Oe(T.color),intensity:T.intensity,x:T.x,y:T.y,z:T.z,radius:T.radius,azimuth:T.azimuth*Math.PI/180,elevation:T.elevation*Math.PI/180})),Z=B.value,v=E.value,w=te.value*.5+.001,De=G.value,oe=(T,ce)=>{const j=Math.max(0,Math.min(r-1,Math.round(T*r))),g=(Math.max(0,Math.min(l-1,Math.round(ce*l)))*r+j)*3;return(R[g]+R[g+1]+R[g+2])/(3*255)},Ye=(T,ce,j,ae,g,fe)=>{if(!Z||v<=0)return 0;let ve=0;for(let Be=1;Be<=zt;Be++){const ue=Be/zt*De,pe=oe(T+ae*ue,ce+g*ue),ge=j+fe*ue,He=pe-ge-(rs+us*ue);ve=Math.max(ve,Math.min(1,Math.max(0,He/w)))}return ve};for(let T=0;T<n;T++){const ce=Math.min(Math.floor(T*l/n),l-1);for(let j=0;j<e;j++){const ae=Math.min(Math.floor(j*r/e),r-1),g=(ce*r+ae)*3,fe=h[g]/255,ve=h[g+1]/255,Be=h[g+2]/255;let ue=z[g]/255*2-1,pe=-(z[g+1]/255*2-1),ge=z[g+2]/255*2-1;const He=Math.sqrt(ue*ue+pe*pe+ge*ge)||1;ue/=He,pe/=He,ge/=He;const At=(R[g]+R[g+1]+R[g+2])/(3*255);let $e=1,rt=129;u&&($e=1-Math.min((u[g]+u[g+1]+u[g+2])/765*y,1),rt=$e*$e*128+1);let _t=fe,Et=ve,Dt=Be;I&&p>0&&(_t=(1-p)*fe+p*I[g]/255,Et=(1-p)*ve+p*I[g+1]/255,Dt=(1-p)*Be+p*I[g+2]/255);let Ct=A*f,It=A*L,Tt=A*P;const xt=ae/r,Pt=ce/l;for(const k of S){let Ce=0,ut=1,Ie=0,Te=0,xe=0,dt=0,ct=0,ft=0,ht=0;if(k.type==="directional")Ie=Math.cos(k.elevation)*Math.sin(k.azimuth),Te=Math.sin(k.elevation),xe=Math.cos(k.elevation)*Math.cos(k.azimuth),ct=Ie,ft=Te,ht=xe,Ce=Math.max(ue*Ie+pe*Te+ge*xe,0);else{const me=k.x-xt,Pe=k.y-Pt,ke=k.z-At,be=Math.sqrt(me*me+Pe*Pe+ke*ke)||1e-8;Ie=me/be,Te=Pe/be,xe=ke/be,ct=Ie,ft=Te,ht=xe;const je=be/k.radius;ut=Math.max(1-je*je,0)**2,dt=Math.min(1,Math.max(0,(k.radius-.05)/1.95));const Qe=dt*1,en=ue*Ie+pe*Te+ge*xe;Ce=Math.max(en+Qe,0)/(1+Qe)*ut}if(u){const me=Ie,Pe=Te,ke=xe+1,be=Math.sqrt(me*me+Pe*Pe+ke*ke)||1e-8,je=Math.max(ue*(me/be)+pe*(Pe/be)+ge*(ke/be),0),Qe=k.type==="point"?rt*(1-dt*.95)+1:rt;Ce+=Math.pow(je,Qe)*$e*$e*ut}if(Z){const me=Ye(xt,Pt,At,ct,ft,ht);Ce*=1-v*me}Ct+=Ce*k.color[0]*k.intensity,It+=Ce*k.color[1]*k.intensity,Tt+=Ce*k.color[2]*k.intensity}const Je=(T*e+j)*4;o[Je]=Math.min(255,Math.max(0,_t*Ct*255)),o[Je+1]=Math.min(255,Math.max(0,Et*It*255)),o[Je+2]=Math.min(255,Math.max(0,Dt*Tt*255)),o[Je+3]=255}}t.putImageData(i,0,0)}function qe(){const t=ne.value;if(!t)return;const e=J.value,n=e?e.clientWidth:320,i=e?e.clientHeight:180;t.width=n,t.height=i;const o=t.getContext("2d");if(!o)return;Y&&ze&&Me&&F>0&&H>0?(t.width=F,t.height=H,re?Rt(o,F,H):!re&&Y&&(Mt(F,H)?Rt(o,F,H):Ht(o,F,H))):Kt(o,n,i),ot=e&&e.clientWidth>0?t.width/e.clientWidth:1,o.fillStyle="rgba(255,255,255,0.7)",o.font="11px monospace",o.fillText(`Lights: ${d.value.length}/3`,8,16),re&&(o.fillStyle="rgba(100,220,100,0.5)",o.font="10px monospace",o.fillText("WebGL",t.width-44,14)),Y||(o.fillStyle="rgba(255,255,255,0.3)",o.font="10px monospace",o.fillText("Execute graph to enable real-time preview",8,i-8)),$t(o,t.width,t.height);const r=d.value.find(l=>l.id===M.value&&l.type==="directional");r?Zt(o,r,t.width,t.height):Ne=0}function $t(t,e,n){const i=ot,o=18*i,r=3*i,l=22*i,h=3*Math.PI/180,z=-Math.PI/2+h,R=Math.PI/6-h,I=Math.PI/6+h,u=5*Math.PI/6-h,p=5*Math.PI/6+h,y=3*Math.PI/2-h;t.save(),t.lineCap="butt";for(const f of d.value){if(f.type!=="point"||Fe.value.has(f.id))continue;const L=f.x*e,P=f.y*n,A=f.id===M.value,[S,Z,v]=Oe(f.color),w=Math.round(S*255),De=Math.round(Z*255),oe=Math.round(v*255),Ye=A?.13:.07,T=A?.62:.22,ce=(j,ae,g)=>{const fe=r+j*(l-r),ve=o+fe/2;t.beginPath(),t.arc(L,P,o+l/2,ae,g,!1),t.strokeStyle=`rgba(${w},${De},${oe},${Ye})`,t.lineWidth=l,t.stroke(),t.beginPath(),t.arc(L,P,ve,ae,g,!1),t.strokeStyle=`rgba(${w},${De},${oe},${T})`,t.lineWidth=fe,t.stroke()};if(ce(f.intensity/2,z,R),ce(f.z/2,I,u),ce((f.radius-.05)/1.95,p,y),A){t.fillStyle="rgba(210,210,230,0.82)",t.font=`${Math.round(9*i)}px sans-serif`,t.textAlign="center",t.textBaseline="middle";const j=o+l+9*i,ae=(g,fe)=>t.fillText(g,L+j*Math.cos(fe),P+j*Math.sin(fe));ae(`I ${f.intensity.toFixed(2)}`,(z+R)/2),ae(`D ${f.z.toFixed(2)}`,(I+u)/2),ae(`R ${f.radius.toFixed(2)}`,(p+y)/2)}}t.restore()}function Zt(t,e,n,i){const o=Math.max(30,Math.min(50,Math.min(n,i)*.09)),r=n-o-12,l=i-o-12;pt=r,gt=l,Ne=o;const h=Math.max(.5,o*.02);t.save(),t.beginPath(),t.arc(r,l,o,0,Math.PI*2),t.clip();const z=t.createRadialGradient(r-o*.3,l-o*.35,o*.05,r,l,o);z.addColorStop(0,"rgba(65,65,92,0.94)"),z.addColorStop(1,"rgba(10,10,20,0.94)"),t.fillStyle=z,t.fillRect(r-o,l-o,o*2,o*2),t.strokeStyle="rgba(110,110,150,0.28)",t.lineWidth=h;for(const P of[0,30,-30,60,-60]){const A=P*Math.PI/180,S=Math.cos(A)*o;t.beginPath(),t.ellipse(r,l-Math.sin(A)*o,S,S*.22,0,0,Math.PI*2),t.stroke()}t.beginPath(),t.ellipse(r,l,o*.22,o,0,0,Math.PI*2),t.stroke(),t.restore(),t.save(),t.beginPath(),t.arc(r,l,o,0,Math.PI*2),t.strokeStyle="rgba(140,140,180,0.6)",t.lineWidth=1.5,t.stroke();const R=e.azimuth*Math.PI/180,I=e.elevation*Math.PI/180,u=r+(o-4)*Math.cos(I)*Math.sin(R),p=l+(o-4)*Math.sin(I),y=Math.cos(I)*Math.cos(R)<0,f=y?"44":"bb";t.beginPath(),t.moveTo(r,l),t.lineTo(u,p),t.strokeStyle=e.color+f,t.lineWidth=1.5,t.stroke();const L=o*.08;t.strokeStyle="rgba(180,180,200,0.4)",t.lineWidth=1,t.beginPath(),t.moveTo(r-L,l),t.lineTo(r+L,l),t.stroke(),t.beginPath(),t.moveTo(r,l-L),t.lineTo(r,l+L),t.stroke(),t.beginPath(),t.arc(u,p,5,0,Math.PI*2),t.fillStyle=y?e.color+"55":e.color,t.fill(),t.strokeStyle=y?"rgba(255,255,255,0.25)":"rgba(255,255,255,0.9)",t.lineWidth=1,t.stroke(),t.beginPath(),t.arc(r-o*.32,l-o*.38,o*.16,0,Math.PI*2),t.fillStyle="rgba(255,255,255,0.09)",t.fill(),t.restore()}function Kt(t,e,n){t.fillStyle="#111827",t.fillRect(0,0,e,n),t.globalCompositeOperation="screen";for(const i of d.value)if(i.type==="point"){const o=i.x*e,r=i.y*n,l=i.radius*e*Math.max(i.intensity,.1),h=t.createRadialGradient(o,r,0,o,r,l);h.addColorStop(0,i.color+"99"),h.addColorStop(1,"transparent"),t.fillStyle=h,t.fillRect(0,0,e,n)}else{const o=i.azimuth*Math.PI/180,r=i.elevation*Math.PI/180,l=Math.sin(r),h=e/2-Math.sin(o)*e*.7,z=n/2+Math.cos(o)*n*.7,R=e/2+Math.sin(o)*e*.7,I=n/2-Math.cos(o)*n*.7,u=t.createLinearGradient(h,z,R,I),p=y=>Math.max(0,Math.min(255,Math.round(y))).toString(16).padStart(2,"0");u.addColorStop(0,i.color+p(l*170)),u.addColorStop(.5,i.color+p(l*68)),u.addColorStop(1,"transparent"),t.fillStyle=u,t.fillRect(0,0,e,n)}t.globalCompositeOperation="source-over",_.value>0&&(t.globalCompositeOperation="screen",t.globalAlpha=_.value*.3,t.fillStyle=m.value,t.fillRect(0,0,e,n),t.globalAlpha=1,t.globalCompositeOperation="source-over")}function qt(t){F=t.width,H=t.height,we.value=`${F} / ${H}`,Y=Xe(t.rgb),ze=Xe(t.normals),Me=Xe(t.depth),ie=t.albedo?Xe(t.albedo):null,Re=t.roughness?Xe(t.roughness):null,Le.value=ie!==null,he.value=Re!==null,re||Mt(F,H),Ke=!0,Ae.value=!1,mt(qe)}function Xe(t){const e=atob(t);return Uint8Array.from(e,n=>n.charCodeAt(0))}function Lt(){const t={lights:d.value,ambientIntensity:_.value,ambientColor:m.value,delitMix:U.value,roughnessStrength:V.value,shadowsEnabled:B.value,shadowStrength:E.value,shadowSoftness:te.value,shadowRange:G.value};return JSON.stringify(t)}function Jt(t){try{const e=JSON.parse(t);Array.isArray(e)?d.value=e:(d.value=e.lights??[],_.value=e.ambientIntensity??.2,m.value=e.ambientColor??"#ffffff",U.value=e.delitMix??0,V.value=e.roughnessStrength??1,B.value=e.shadowsEnabled??!1,E.value=e.shadowStrength??.6,te.value=e.shadowSoftness??.3,G.value=e.shadowRange??.15),mt(qe)}catch{}}function jt(t){const e=Math.min(t.z/2,1),n=10+e*16,i=.35+e*.65,o=3+e*15;return{left:t.x*100+"%",top:t.y*100+"%",background:t.color,width:n+"px",height:n+"px",opacity:i,boxShadow:`0 0 ${o}px ${t.color}`}}function C(){vt(),tt.onChange(Lt())}function Qt(t){Ae.value=t}return X({serialise:Lt,deserialise:Jt,setPasses:qt,setProcessing:Qt}),nn(()=>{mt(qe)}),sn(()=>{Yt(),_e!==null&&cancelAnimationFrame(_e)}),(t,e)=>(O(),W("div",hn,[a("div",{class:"rl-canvas-wrap",ref_key:"canvasWrap",ref:J,style:Q({aspectRatio:we.value})},[a("canvas",{ref_key:"canvas",ref:ne,class:"rl-canvas",onMousedown:Gt,onClick:Ot,onMousemove:Vt,onMouseup:Ft},null,544),(O(!0),W(et,null,kt(Ze.value,n=>(O(),W("div",{key:n.id,class:Ue(["rl-light-dot",{selected:n.id===M.value}]),style:Q(jt(n)),onMousedown:le(i=>!i.shiftKey&&Bt(i,n),["stop"]),onClick:le(i=>i.shiftKey?yt(n.id):!Ut(nt)&&!Ut(st)&&St(n.id),["stop"]),onDblclick:le(i=>Nt(n.id),["stop"])},null,46,mn))),128)),on(ln,{name:"rl-fade"},{default:an(()=>[Ae.value?(O(),W("div",vn,[...e[21]||(e[21]=[a("div",{class:"rl-processing-pill"},[a("span",{class:"rl-processing-dot"}),a("span",{class:"rl-processing-dot"}),a("span",{class:"rl-processing-dot"})],-1)])])):ye("",!0)]),_:1})],4),a("div",pn,[a("div",gn,[a("button",{class:"rl-btn",disabled:d.value.length>=3,onClick:e[0]||(e[0]=n=>bt("point"))},"+ Point",8,bn),a("button",{class:"rl-btn",disabled:d.value.length>=3,onClick:e[1]||(e[1]=n=>bt("directional"))},"+ Dir",8,yn),a("button",{class:"rl-btn rl-btn-ghost",disabled:d.value.length===0,onClick:Wt},"Clear",8,Sn)]),(O(!0),W(et,null,kt(d.value,(n,i)=>(O(),W("div",{key:n.id,class:Ue(["rl-section rl-light",{selected:n.id===M.value}])},[a("div",{class:"rl-sec-head",onClick:o=>St(n.id)},[a("span",{class:Ue(["rl-chev",{open:n.id===M.value}])},"▸",2),a("span",Mn,q(n.type==="point"?"💡":"☀️"),1),a("span",Rn,q(n.type==="point"?"Point":"Dir")+" "+q(i+1),1),K(a("input",{class:"rl-swatch",type:"color","onUpdate:modelValue":o=>n.color=o,onInput:C,onClick:e[2]||(e[2]=le(()=>{},["stop"]))},null,40,Ln),[[ee,n.color]]),a("button",{class:"rl-x",onClick:le(o=>yt(n.id),["stop"])},"×",8,An)],8,wn),n.id===M.value?(O(),W("div",_n,[a("div",En,[e[22]||(e[22]=a("span",{class:"rl-flabel"},"Intensity",-1)),K(a("input",{class:"rl-range",style:Q(D(n.intensity,0,2)),type:"range",min:"0",max:"2",step:"0.05","onUpdate:modelValue":o=>n.intensity=o,onInput:C,onClick:e[3]||(e[3]=le(()=>{},["stop"]))},null,44,Dn),[[ee,n.intensity,void 0,{number:!0}]]),a("span",Cn,q(n.intensity.toFixed(2)),1)]),n.type==="point"?(O(),W(et,{key:0},[a("div",In,[e[23]||(e[23]=a("span",{class:"rl-flabel"},"Depth",-1)),K(a("input",{class:"rl-range",style:Q(D(n.z,0,2)),type:"range",min:"0",max:"2",step:"0.01","onUpdate:modelValue":o=>n.z=o,onInput:C,onClick:e[4]||(e[4]=le(()=>{},["stop"]))},null,44,Tn),[[ee,n.z,void 0,{number:!0}]]),a("span",xn,q(n.z.toFixed(2)),1)]),a("div",Pn,[e[24]||(e[24]=a("span",{class:"rl-flabel"},"Radius",-1)),K(a("input",{class:"rl-range",style:Q(D(n.radius,.05,2)),type:"range",min:"0.05",max:"2",step:"0.05","onUpdate:modelValue":o=>n.radius=o,onInput:C,onClick:e[5]||(e[5]=le(()=>{},["stop"]))},null,44,kn),[[ee,n.radius,void 0,{number:!0}]]),a("span",Un,q(n.radius.toFixed(2)),1)])],64)):(O(),W(et,{key:1},[a("div",zn,[e[25]||(e[25]=a("span",{class:"rl-flabel"},"Horizontal",-1)),K(a("input",{class:"rl-range",style:Q(D(n.azimuth,-180,180)),type:"range",min:"-180",max:"180",step:"1","onUpdate:modelValue":o=>n.azimuth=o,onInput:C,onClick:e[6]||(e[6]=le(()=>{},["stop"]))},null,44,Nn),[[ee,n.azimuth,void 0,{number:!0}]]),a("span",Bn,q(Math.round(n.azimuth))+"°",1)]),a("div",Fn,[e[26]||(e[26]=a("span",{class:"rl-flabel"},"Vertical",-1)),K(a("input",{class:"rl-range",style:Q(D(n.elevation,-90,90)),type:"range",min:"-90",max:"90",step:"1","onUpdate:modelValue":o=>n.elevation=o,onInput:C,onClick:e[7]||(e[7]=le(()=>{},["stop"]))},null,44,Vn),[[ee,n.elevation,void 0,{number:!0}]]),a("span",Gn,q(Math.round(n.elevation))+"°",1)])],64))])):ye("",!0)],2))),128)),a("div",On,[a("div",{class:"rl-sec-head",onClick:e[10]||(e[10]=n=>x("ambient"))},[a("span",{class:Ue(["rl-chev",{open:b.value.ambient}])},"▸",2),e[27]||(e[27]=a("span",{class:"rl-sec-title"},"Ambient",-1)),K(a("input",{class:"rl-swatch",type:"color","onUpdate:modelValue":e[8]||(e[8]=n=>m.value=n),onInput:C,onClick:e[9]||(e[9]=le(()=>{},["stop"]))},null,544),[[ee,m.value]])]),b.value.ambient?(O(),W("div",Wn,[a("div",Xn,[e[28]||(e[28]=a("span",{class:"rl-flabel"},"Intensity",-1)),K(a("input",{class:"rl-range",style:Q(D(_.value,0,1)),type:"range",min:"0",max:"1",step:"0.01","onUpdate:modelValue":e[11]||(e[11]=n=>_.value=n),onInput:C},null,36),[[ee,_.value,void 0,{number:!0}]]),a("span",Yn,q(_.value.toFixed(2)),1)])])):ye("",!0)]),Le.value||he.value?(O(),W("div",Hn,[a("div",{class:"rl-sec-head",onClick:e[12]||(e[12]=n=>x("material"))},[a("span",{class:Ue(["rl-chev",{open:b.value.material}])},"▸",2),e[29]||(e[29]=a("span",{class:"rl-sec-title"},"Material",-1))]),b.value.material?(O(),W("div",$n,[Le.value?(O(),W("div",Zn,[e[30]||(e[30]=a("span",{class:"rl-flabel"},"Delight",-1)),K(a("input",{class:"rl-range",style:Q(D(U.value,0,1)),type:"range",min:"0",max:"1",step:"0.01","onUpdate:modelValue":e[13]||(e[13]=n=>U.value=n),onInput:C},null,36),[[ee,U.value,void 0,{number:!0}]]),a("span",Kn,q(U.value.toFixed(2)),1)])):ye("",!0),he.value?(O(),W("div",qn,[e[31]||(e[31]=a("span",{class:"rl-flabel"},"Roughness",-1)),K(a("input",{class:"rl-range",style:Q(D(V.value,0,2)),type:"range",min:"0",max:"2",step:"0.01","onUpdate:modelValue":e[14]||(e[14]=n=>V.value=n),onInput:C},null,36),[[ee,V.value,void 0,{number:!0}]]),a("span",Jn,q(V.value.toFixed(2)),1)])):ye("",!0)])):ye("",!0)])):ye("",!0),a("div",jn,[a("div",{class:"rl-sec-head",onClick:e[17]||(e[17]=n=>x("shadows"))},[a("span",{class:Ue(["rl-chev",{open:b.value.shadows}])},"▸",2),e[33]||(e[33]=a("span",{class:"rl-sec-title"},"Shadows",-1)),a("label",{class:"rl-switch",onClick:e[16]||(e[16]=le(()=>{},["stop"]))},[K(a("input",{type:"checkbox","onUpdate:modelValue":e[15]||(e[15]=n=>B.value=n),onChange:C},null,544),[[rn,B.value]]),e[32]||(e[32]=a("span",{class:"rl-switch-track"},[a("span",{class:"rl-switch-thumb"})],-1))])]),b.value.shadows?(O(),W("div",{key:0,class:Ue(["rl-sec-body",{disabled:!B.value}])},[a("div",Qn,[e[34]||(e[34]=a("span",{class:"rl-flabel"},"Strength",-1)),K(a("input",{class:"rl-range",style:Q(D(E.value,0,1)),disabled:!B.value,type:"range",min:"0",max:"1",step:"0.01","onUpdate:modelValue":e[18]||(e[18]=n=>E.value=n),onInput:C},null,44,es),[[ee,E.value,void 0,{number:!0}]]),a("span",ts,q(E.value.toFixed(2)),1)]),a("div",ns,[e[35]||(e[35]=a("span",{class:"rl-flabel"},"Softness",-1)),K(a("input",{class:"rl-range",style:Q(D(te.value,0,1)),disabled:!B.value,type:"range",min:"0",max:"1",step:"0.01","onUpdate:modelValue":e[19]||(e[19]=n=>te.value=n),onInput:C},null,44,ss),[[ee,te.value,void 0,{number:!0}]]),a("span",os,q(te.value.toFixed(2)),1)]),a("div",as,[e[36]||(e[36]=a("span",{class:"rl-flabel"},"Range",-1)),K(a("input",{class:"rl-range",style:Q(D(G.value,.01,.5)),disabled:!B.value,type:"range",min:"0.01",max:"0.5",step:"0.01","onUpdate:modelValue":e[20]||(e[20]=n=>G.value=n),onInput:C},null,44,ls),[[ee,G.value,void 0,{number:!0}]]),a("span",is,q(G.value.toFixed(2)),1)])],2)):ye("",!0)])])]))}}),hs=dn(fs,[["__scopeId","data-v-8a3ea01f"]]),ms="RelightingNode",vs="NKD.Relighting.Vue";function ps(de,X){let d=!1,M=15;const _=()=>{var E;return!!((E=window.LiteGraph)!=null&&E.vueNodesMode)},m=()=>{var we;if(d)return;if(_()){X.style.width&&(X.style.width="");return}const E=(we=de.size)==null?void 0:we[0];if(!E)return;const te=X.parentElement,G=te?te.clientWidth:0;if(!(G>0&&(G>E*1.2||G<E*.7))){X.style.width&&(d=!0,X.style.width="",requestAnimationFrame(()=>{d=!1}));const Y=X.clientWidth;Y>0&&Y<=E&&Y>=E-40&&(M=E-Y);return}const J=Math.round(E-M);J>0&&Math.abs(X.clientWidth-J)>2&&(d=!0,X.style.boxSizing="border-box",X.style.width=J+"px",requestAnimationFrame(()=>{d=!1}))};m();const U=new ResizeObserver(m);U.observe(X);const V=de.onResize;de.onResize=function(){V==null||V.apply(this,arguments),m()};const B=window.setInterval(m,250);return()=>{U.disconnect(),clearInterval(B)}}fn.registerExtension({name:vs,async beforeRegisterNodeDef(de,X,tt){if(X.name!==ms||de.prototype.__nkdRelightWrapped)return;de.prototype.__nkdRelightWrapped=!0;const d=de.prototype.onNodeCreated;de.prototype.onNodeCreated=function(){var Ze;const M=d==null?void 0:d.apply(this,arguments),_=this,m=(Ze=this.widgets)==null?void 0:Ze.find(b=>b.name==="lights_config");m&&(m.hidden=!0,m.computedHeight=0,m.computeSize=()=>[0,-4],m.inputEl&&(m.inputEl.style.display="none"),m.labelEl&&(m.labelEl.style.display="none"));const U=document.createElement("div");U.style.cssText="width:100%;box-sizing:border-box;overflow:hidden;";let V=9/16,B=0;const E=110,G=cn(hs,{onChange:b=>{m&&(m.value=b),_.setDirtyCanvas(!0)}}),ne=G.mount(U),J=this.addDOMWidget("relighting_editor","RELIGHTING_EDITOR",U,{getValue:()=>ne.serialise(),setValue:b=>{ne.deserialise(b),m&&(m.value=b)},serialize:!1}),we=ps(this,U),Y=300,ze=8;J&&(J.computeSize=b=>{const x=Math.max(b??Y,Y),D=(B>0?B:Math.round(x*V)+E)+ze;return[x,D]});const Me=U.firstElementChild??U;let ie=0;const Re=new ResizeObserver(()=>{const b=Me.offsetHeight;b>0&&Math.abs(b-B)>1&&(B=b,ie&&cancelAnimationFrame(ie),ie=requestAnimationFrame(()=>{if(ie=0,!_.size)return;const x=_.computeSize(),[D,_e]=_.size;Math.abs(x[1]-_e)>1&&(_.setSize([D,x[1]]),_.setDirtyCanvas(!0,!0))}))});Re.observe(Me);const F=m==null?void 0:m.value;F&&F!=="[]"&&F!=="{}"&&ne.deserialise(F);const H=b=>{const x=b.detail;if(String(x==null?void 0:x.node_id)===String(_.id)&&(x!=null&&x.passes)){const D=x.passes;D.width>0&&D.height>0&&(V=D.height/D.width),ne.setPasses(D)}},Le=b=>{const{node:x}=b.detail??{};String(x)===String(_.id)?ne.setProcessing(!0):ne.setProcessing(!1)},he=()=>ne.setProcessing(!1);Se.addEventListener("nkd-relight-passes",H),Se.addEventListener("executing",Le),Se.addEventListener("executed",he),Se.addEventListener("execution_error",he);const Ae=this.onRemoved;return this.onRemoved=function(){we(),Re.disconnect(),ie&&cancelAnimationFrame(ie),Se.removeEventListener("nkd-relight-passes",H),Se.removeEventListener("executing",Le),Se.removeEventListener("executed",he),Se.removeEventListener("execution_error",he),G.unmount(),Ae==null||Ae.apply(this,arguments)},M}}});
