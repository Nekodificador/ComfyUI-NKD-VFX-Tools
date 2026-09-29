<template>
  <div class="rl-root" :class="{ 'rl-popped': popped }" ref="rootEl">
    <!-- Tool row: compare against the untouched plate, open the large editor -->
    <div class="rl-tools">
      <button class="rl-tool" :class="{ on: comparing }" :disabled="!hasPasses"
              title="Hold to see the original image without the relight"
              @pointerdown.prevent="setCompare(true, $event)" @pointerup="setCompare(false)"
              @pointercancel="setCompare(false)" @lostpointercapture="setCompare(false)">
        <i class="pi pi-eye" /> Original
      </button>
      <span class="rl-tools-gap" />
      <button v-if="!popped && props.onPopout" class="rl-tool" title="Open in a large editor — same node, nothing reloads"
              @click="props.onPopout()">
        <i class="pi pi-window-maximize" />
      </button>
    </div>

    <!-- Preview canvas area (letterboxed in the stage when popped out) -->
    <div class="rl-stage" ref="stageEl">
    <div class="rl-canvas-wrap" :class="{ comparing }" ref="canvasWrap" :style="wrapStyle"
         @mousemove="onWrapMove" @mouseleave="onWrapLeave">
      <canvas ref="canvas" class="rl-canvas" @mousedown="onCanvasMouseDown" @click="onCanvasClick" @mousemove="onCanvasMove" @mouseup="onMouseUp" />
      <!-- Arcs, joystick and text, drawn at screen resolution: the image canvas above is only as sharp as the pass (<= 512 px) -->
      <canvas ref="overlay" class="rl-overlay" />
      <!-- Draggable point-light indicators -->
      <div
        v-for="light in pointLights"
        :key="light.id"
        class="rl-light-dot"
        :class="{ selected: light.id === selectedId }"
        :style="dotStyle(light)"
        @mousedown.stop="!$event.shiftKey && startDrag($event, light)"
        @click.stop="$event.shiftKey ? removeLight(light.id) : (!didDrag && selectLight(light.id))"
        />
      <!-- Processing overlay -->
      <Transition name="rl-fade">
        <div v-if="isProcessing" class="rl-processing-overlay">
          <div class="rl-processing-pill">
            <span class="rl-processing-dot" />
            <span class="rl-processing-dot" />
            <span class="rl-processing-dot" />
          </div>
        </div>
      </Transition>
    </div>
    </div>

    <!-- Controls -->
    <div class="rl-controls">
      <!-- Light add buttons -->
      <div class="rl-btnbar">
        <button class="rl-btn" :disabled="lights.length >= MAX_LIGHTS" @click="addLight('point')">+ Point</button>
        <button class="rl-btn" :disabled="lights.length >= MAX_LIGHTS" @click="addLight('directional')">+ Dir</button>
        <button class="rl-btn rl-btn-ghost" :disabled="lights.length === 0" @click="clearLights">Clear</button>
        <button class="rl-btn rl-btn-ghost" title="Remove the lights and put every setting back to its default" @click="resetAll">Reset</button>
      </div>

      <!-- Per-light collapsible rows -->
      <div
        v-for="(light, idx) in lights"
        :key="light.id"
        class="rl-section rl-light"
        :class="{ selected: light.id === selectedId }"
      >
        <div class="rl-sec-head" @click="selectLight(light.id)">
          <span class="rl-chev" :class="{ open: popped || light.id === selectedId }">▸</span>
          <i class="pi rl-light-icon" :class="light.type === 'point' ? 'pi-lightbulb' : 'pi-sun'" />
          <span class="rl-sec-title">{{ light.type === 'point' ? 'Point' : 'Dir' }} {{ (idx as number) + 1 }}</span>
          <input class="rl-swatch" type="color" v-model="light.color" @input="emit" @click.stop />
          <button class="rl-x" @click.stop="removeLight(light.id)">×</button>
        </div>

        <div class="rl-sec-body" v-if="popped || light.id === selectedId">
          <div class="rl-field">
            <span class="rl-flabel">Intensity</span>
            <input class="rl-range" data-default="1" :style="rangeStyle(light.intensity, 0, 2)" type="range" min="0" max="2" step="0.05" v-model.number="light.intensity" @input="emit" @click.stop />
            <span class="rl-fval">{{ light.intensity.toFixed(2) }}</span>
          </div>
          <template v-if="light.type === 'point'">
            <div class="rl-field">
              <span class="rl-flabel">Depth</span>
              <input class="rl-range" data-default="0.5" :style="rangeStyle(light.z, 0, 2)" type="range" min="0" max="2" step="0.01" v-model.number="light.z" @input="emit" @click.stop />
              <span class="rl-fval">{{ light.z.toFixed(2) }}</span>
            </div>
            <div class="rl-field">
              <span class="rl-flabel">Radius</span>
              <input class="rl-range" data-default="0.5" :style="rangeStyle(light.radius, 0.05, 2)" type="range" min="0.05" max="2" step="0.05" v-model.number="light.radius" @input="emit" @click.stop />
              <span class="rl-fval">{{ light.radius.toFixed(2) }}</span>
            </div>
          </template>
          <template v-else>
            <div class="rl-field">
              <span class="rl-flabel">Horizontal</span>
              <input class="rl-range" data-default="0" :style="rangeStyle(light.azimuth, -180, 180)" type="range" min="-180" max="180" step="1" v-model.number="light.azimuth" @input="emit" @click.stop />
              <span class="rl-fval">{{ Math.round(light.azimuth) }}°</span>
            </div>
            <div class="rl-field">
              <span class="rl-flabel">Vertical</span>
              <input class="rl-range" data-default="45" :style="rangeStyle(-light.elevation, -90, 90)" type="range" min="-90" max="90" step="1" :value="-light.elevation" @input="setElevation(light, $event)" @click.stop
                     title="Height of the light: + is above the subject, − below. (Stored the other way round, in image space where Y points down.)" />
              <span class="rl-fval">{{ Math.round(-light.elevation) || 0 }}°</span>
            </div>
          </template>
          <!-- Masks: each wired mask_N is used as a silhouette (isolate / exclude) or as a gobo -->
          <div class="rl-subhead">Masks</div>
          <div class="rl-hint" v-if="!maskRows(light).length">Wire a mask into mask_1 to confine this light.</div>
          <div class="rl-field" v-for="k in maskRows(light)" :key="k">
            <span class="rl-flabel">Mask {{ k }}</span>
            <select class="rl-select" v-model.number="light.mset[k - 1]" @change="onMaskUse(light, k)" @click.stop
                    title="Silhouette: the mask sits on screen — isolate the subject, or everything but it. Gobo: the mask is projected from the light and slides with depth like a window shadow. Inverted uses the complement.">
              <option :value="0">Off</option>
              <option :value="1">Silhouette</option>
              <option :value="2">Silhouette, inverted</option>
              <option :value="3">Gobo</option>
              <option :value="4">Gobo, inverted</option>
            </select>
            <span class="rl-fval rl-fval-wide" v-if="!maskSlots[k - 1]">not wired</span>
          </div>
          <div class="rl-field" v-if="maskCount(light) > 1">
            <span class="rl-flabel">Combine</span>
            <select class="rl-select" v-model.number="light.mcomb" @change="emit" @click.stop
                    title="Intersect: lit only where every mask agrees (subject AND window). Union: lit where any of them is. Use an inverted mask to subtract.">
              <option :value="0">Intersect</option>
              <option :value="1">Union</option>
            </select>
          </div>
          <div class="rl-field" v-if="maskCount(light) > 0">
            <span class="rl-flabel">Mask amount</span>
            <input class="rl-range" data-default="1" :style="rangeStyle(light.maskAmount, 0, 1)" type="range" min="0" max="1" step="0.01" v-model.number="light.maskAmount" @input="emit" @click.stop
                   title="1 = the light is fully confined; lower values let some of it leak outside." />
            <span class="rl-fval">{{ light.maskAmount.toFixed(2) }}</span>
          </div>
          <div class="rl-field" v-if="hasGobo(light)">
            <span class="rl-flabel">Project</span>
            <input class="rl-range" data-default="0.5" :style="rangeStyle(light.maskProject, 0, 1)" type="range" min="0" max="1" step="0.01" v-model.number="light.maskProject" @input="emit" @click.stop
                   title="How far the gobo slides with depth along the light: near surfaces move, far ones stay, so the pattern bends over relief. 0 = flat on the screen." />
            <span class="rl-fval">{{ light.maskProject.toFixed(2) }}</span>
          </div>
          <!-- Rim: outline a mask's silhouette on the side that faces this light -->
          <div class="rl-field" v-if="maskRows(light).length"
               title="Outline the silhouette of a wired mask on the edge that faces this light. Reads the mask, not the normals, so it works when the normal pass is too soft for a backlight.">
            <span class="rl-flabel">Rim mask</span>
            <select class="rl-select" v-model.number="light.rimMask" @change="emit" @click.stop>
              <option :value="0">Off</option>
              <option v-for="k in maskRows(light)" :key="k" :value="k">Mask {{ k }}{{ maskSlots[k - 1] ? '' : ' (not wired)' }}</option>
            </select>
          </div>
          <div class="rl-field" v-if="light.rimMask > 0">
            <span class="rl-flabel">Rim</span>
            <input class="rl-range" data-default="1" :style="rangeStyle(light.rimAmount, 0, 2)" type="range" min="0" max="2" step="0.05" v-model.number="light.rimAmount" @input="emit" @click.stop />
            <span class="rl-fval">{{ light.rimAmount.toFixed(2) }}</span>
          </div>
          <div class="rl-field" v-if="light.rimMask > 0">
            <span class="rl-flabel">Rim width</span>
            <input class="rl-range" data-default="0.03" :style="rangeStyle(light.rimWidth, 0.005, 0.15)" type="range" min="0.005" max="0.15" step="0.005" v-model.number="light.rimWidth" @input="emit" @click.stop
                   title="How far the rim reaches into the subject, as a fraction of the image's short side." />
            <span class="rl-fval">{{ light.rimWidth.toFixed(3) }}</span>
          </div>
          <div class="rl-field" v-if="light.rimMask > 0">
            <span class="rl-flabel">Rim softness</span>
            <input class="rl-range" data-default="0.6" :style="rangeStyle(light.rimSoftness, 0, 1)" type="range" min="0" max="1" step="0.01" v-model.number="light.rimSoftness" @input="emit" @click.stop
                   title="Shape of the fade into the subject: 0 = a tight bright line, 1 = a long soft tail." />
            <span class="rl-fval">{{ light.rimSoftness.toFixed(2) }}</span>
          </div>
          <div class="rl-field" v-if="light.rimMask > 0">
            <span class="rl-flabel">Rim spread</span>
            <input class="rl-range" data-default="0.25" :style="rangeStyle(light.rimSpread, 0, 1)" type="range" min="0" max="1" step="0.01" v-model.number="light.rimSpread" @input="emit" @click.stop
                   title="How far round the outline the rim wraps: 0 = only the edge that faces the light, 1 = all the way round. A light straight behind the subject always gives a full halo." />
            <span class="rl-fval">{{ light.rimSpread.toFixed(2) }}</span>
          </div>
          <div class="rl-field" v-if="light.rimMask > 0">
            <span class="rl-flabel">Rim surface</span>
            <input class="rl-range" data-default="0" :style="rangeStyle(light.rimSurface, 0, 1)" type="range" min="0" max="1" step="0.01" v-model.number="light.rimSurface" @input="emit" @click.stop
                   title="Also require the surface to turn away from the camera, using the normal pass: the rim thickens where the form curves away and fades on flat parts. 0 = silhouette only." />
            <span class="rl-fval">{{ light.rimSurface.toFixed(2) }}</span>
          </div>
          <div class="rl-field">
            <span class="rl-flabel">Shadow</span>
            <label class="rl-switch" @click.stop title="Cast screen-space shadows from this light. The Shadows section is the master switch and holds the tracer settings.">
              <input type="checkbox" v-model="light.castShadow" @change="emit" />
              <span class="rl-switch-track"><span class="rl-switch-thumb"></span></span>
            </label>
            <span class="rl-fval rl-fval-wide">{{ !shadowsEnabled ? 'master off' : (light.castShadow ? 'cast' : 'none') }}</span>
          </div>
        </div>
      </div>

      <!-- Ambient section -->
      <div class="rl-section">
        <div class="rl-sec-head" @click="toggleSection('ambient')">
          <span class="rl-chev" :class="{ open: secOpen('ambient') }">▸</span>
          <span class="rl-sec-title">Ambient</span>
          <input class="rl-swatch" type="color" v-model="ambientColor" @input="emit" @click.stop />
        </div>
        <div class="rl-sec-body" v-if="secOpen('ambient')">
          <div class="rl-field">
            <span class="rl-flabel">Intensity</span>
            <input class="rl-range" data-default="0.2" :style="rangeStyle(ambientIntensity, 0, 1)" type="range" min="0" max="1" step="0.01" v-model.number="ambientIntensity" @input="emit" />
            <span class="rl-fval">{{ ambientIntensity.toFixed(2) }}</span>
          </div>
        </div>
      </div>

      <!-- Material section (only when albedo/roughness passes exist) -->
      <div class="rl-section" v-if="hasAlbedo || hasRoughness">
        <div class="rl-sec-head" @click="toggleSection('material')">
          <span class="rl-chev" :class="{ open: secOpen('material') }">▸</span>
          <span class="rl-sec-title">Material</span>
        </div>
        <div class="rl-sec-body" v-if="secOpen('material')">
          <div class="rl-field" v-if="hasAlbedo">
            <span class="rl-flabel">Delight</span>
            <input class="rl-range" data-default="0" :style="rangeStyle(delitMix, 0, 1)" type="range" min="0" max="1" step="0.01" v-model.number="delitMix" @input="emit" />
            <span class="rl-fval">{{ delitMix.toFixed(2) }}</span>
          </div>
          <div class="rl-field" v-if="hasRoughness">
            <span class="rl-flabel">Roughness</span>
            <input class="rl-range" data-default="1" :style="rangeStyle(roughnessStrength, 0, 2)" type="range" min="0" max="2" step="0.01" v-model.number="roughnessStrength" @input="emit" />
            <span class="rl-fval">{{ roughnessStrength.toFixed(2) }}</span>
          </div>
        </div>
      </div>

      <!-- Shadows section -->
      <div class="rl-section">
        <div class="rl-sec-head" @click="toggleSection('shadows')">
          <span class="rl-chev" :class="{ open: secOpen('shadows') }">▸</span>
          <span class="rl-sec-title">Shadows</span>
          <label class="rl-switch" @click.stop>
            <input type="checkbox" v-model="shadowsEnabled" @change="emit" />
            <span class="rl-switch-track"><span class="rl-switch-thumb"></span></span>
          </label>
        </div>
        <div class="rl-sec-body" v-if="secOpen('shadows')" :class="{ disabled: !shadowsEnabled }">
          <div class="rl-field">
            <span class="rl-flabel">Strength</span>
            <input class="rl-range" data-default="0.6" :style="rangeStyle(shadowStrength, 0, 1)" :disabled="!shadowsEnabled" type="range" min="0" max="1" step="0.01" v-model.number="shadowStrength" @input="emit" />
            <span class="rl-fval">{{ shadowStrength.toFixed(2) }}</span>
          </div>
          <div class="rl-field">
            <span class="rl-flabel">Softness</span>
            <input class="rl-range" data-default="0.3" :style="rangeStyle(shadowSoftness, 0, 1)" :disabled="!shadowsEnabled" type="range" min="0" max="1" step="0.01" v-model.number="shadowSoftness" @input="emit" />
            <span class="rl-fval">{{ shadowSoftness.toFixed(2) }}</span>
          </div>
          <div class="rl-field">
            <span class="rl-flabel">Range</span>
            <input class="rl-range" data-default="0.15" :style="rangeStyle(shadowRange, 0.01, 0.5)" :disabled="!shadowsEnabled" type="range" min="0.01" max="0.5" step="0.01" v-model.number="shadowRange" @input="emit" />
            <span class="rl-fval">{{ shadowRange.toFixed(2) }}</span>
          </div>
        </div>
      </div>

      <!-- Look section: post-process on the lit image (exposure, white balance, saturation, haze) -->
      <div class="rl-section">
        <div class="rl-sec-head" @click="toggleSection('look')">
          <span class="rl-chev" :class="{ open: secOpen('look') }">▸</span>
          <span class="rl-sec-title">Look</span>
        </div>
        <div class="rl-sec-body" v-if="secOpen('look')">
          <div class="rl-subhead">Grade</div>
          <div class="rl-field" title="Stops. Applied after the lights, so it scales ambient too.">
            <span class="rl-flabel">Exposure</span>
            <input class="rl-range" data-default="0" :style="rangeStyle(lookExposure, -3, 3)" type="range" min="-3" max="3" step="0.05" v-model.number="lookExposure" @input="emit" />
            <span class="rl-fval">{{ lookExposure.toFixed(2) }}</span>
          </div>
          <div class="rl-field" title="White balance: cool (blue) to warm (orange).">
            <span class="rl-flabel">Temp</span>
            <input class="rl-range" data-default="0" :style="rangeStyle(lookTemperature, -1, 1)" type="range" min="-1" max="1" step="0.01" v-model.number="lookTemperature" @input="emit" />
            <span class="rl-fval">{{ lookTemperature.toFixed(2) }}</span>
          </div>
          <div class="rl-field" title="White balance: magenta to green.">
            <span class="rl-flabel">Tint</span>
            <input class="rl-range" data-default="0" :style="rangeStyle(lookTint, -1, 1)" type="range" min="-1" max="1" step="0.01" v-model.number="lookTint" @input="emit" />
            <span class="rl-fval">{{ lookTint.toFixed(2) }}</span>
          </div>
          <div class="rl-field">
            <span class="rl-flabel">Saturation</span>
            <input class="rl-range" data-default="1" :style="rangeStyle(lookSaturation, 0, 2)" type="range" min="0" max="2" step="0.01" v-model.number="lookSaturation" @input="emit" />
            <span class="rl-fval">{{ lookSaturation.toFixed(2) }}</span>
          </div>
          <div class="rl-subhead">Haze
            <input class="rl-swatch" type="color" v-model="hazeColor" @input="emit" title="Haze colour" />
          </div>
          <div class="rl-field" title="Atmospheric haze from the depth pass: the further the pixel, the more of the haze colour it gets.">
            <span class="rl-flabel">Haze</span>
            <input class="rl-range" data-default="0" :style="rangeStyle(hazeAmount, 0, 1)" type="range" min="0" max="1" step="0.01" v-model.number="hazeAmount" @input="emit" />
            <span class="rl-fval">{{ hazeAmount.toFixed(2) }}</span>
          </div>
          <div class="rl-field" title="Distance (0 near, 1 far) where the haze begins. Put End below Start to haze the near side instead, fading out toward Start. Start = End = 0 hazes the whole image evenly.">
            <span class="rl-flabel">Start</span>
            <input class="rl-range" data-default="0" :style="rangeStyle(hazeStart, 0, 1)" type="range" min="0" max="1" step="0.01" v-model.number="hazeStart" @input="emit" />
            <span class="rl-fval">{{ hazeStart.toFixed(2) }}</span>
          </div>
          <div class="rl-field" title="Distance where the haze reaches its full amount.">
            <span class="rl-flabel">End</span>
            <input class="rl-range" data-default="1" :style="rangeStyle(hazeEnd, 0, 1)" type="range" min="0" max="1" step="0.01" v-model.number="hazeEnd" @input="emit" />
            <span class="rl-fval">{{ hazeEnd.toFixed(2) }}</span>
          </div>
          <div class="rl-field" title="How much the haze takes the colour of the lights reaching it: a point light leaves a halo of its colour, a directional one tints the whole veil. Unlit haze goes dark.">
            <span class="rl-flabel">Lit</span>
            <input class="rl-range" data-default="0" :style="rangeStyle(hazeLit, 0, 1)" type="range" min="0" max="1" step="0.01" v-model.number="hazeLit" @input="emit" />
            <span class="rl-fval">{{ hazeLit.toFixed(2) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from "vue";
import { attachFineRange } from "../fine_drag";

interface Light {
  id: number;
  type: "point" | "directional";
  color: string;
  intensity: number;
  x: number;
  y: number;
  z: number;
  azimuth: number;
  elevation: number;
  radius: number;
  falloff: number;
  mset: number[];       // use of mask_1..mask_N: 0 off, 1 silhouette, 2 silhouette inverted, 3 gobo, 4 gobo inverted
  mcomb: number;        // how several masks combine: 0 intersect, 1 union
  rimMask: number;      // 0 off, 1..MASK_SLOTS: outline this mask's silhouette on the side facing the light
  rimAmount: number;
  rimWidth: number;     // outer ring radius, fraction of the short side
  rimSoftness: number;  // 0 tight line .. 1 long tail
  rimSpread: number;    // 0 only the edge facing the light .. 1 all the way round
  rimSurface: number;   // 0 silhouette only .. 1 also needs the surface to turn away (normal pass)
  maskAmount: number;   // mix(1, mask, amount)
  maskProject: number;  // gobo parallax: mask read at uv - sdir.xy * depth * amount
  castShadow: boolean;  // under the global Shadows master switch
}

const MASK_SLOTS = 4;
// GPU preview cap: every light costs 17 uniform slots and a shadow march. Python has no cap.
const MAX_LIGHTS = 8;

// The ONE list of per-light defaults. Lights saved before masks / per-light shadows existed lack
// those fields; lights saved with the single-mask editor carry `mask` (1..4) + `maskInvert`
// instead of `mset` — maskProject > 0 meant "gobo" then (Python reads the same legacy shape).
function normLight(l: any): Light {
  const { mask, maskInvert, ...rest } = l;
  let mset: number[] = Array.isArray(rest.mset) ? rest.mset.slice(0, MASK_SLOTS) : [];
  while (mset.length < MASK_SLOTS) mset.push(0);
  if (!Array.isArray(rest.mset) && mask >= 1 && mask <= MASK_SLOTS) {
    mset[mask - 1] = (rest.maskProject > 0 ? 3 : 1) + (maskInvert ? 1 : 0);
  }
  return { mcomb: 0, maskAmount: 1, maskProject: 0, castShadow: true,
           rimMask: 0, rimAmount: 1, rimWidth: 0.03, rimSoftness: 0.6, rimSpread: 0.25, rimSurface: 0,
           ...rest, mset } as Light;
}

interface State {
  lights: Light[];
  ambientIntensity: number;
  ambientColor: string;
  delitMix: number;
  roughnessStrength: number;
  shadowsEnabled: boolean;
  shadowStrength: number;
  shadowSoftness: number;
  shadowRange: number;
  exposure: number;
  temperature: number;
  tint: number;
  saturation: number;
  hazeAmount: number;
  hazeColor: string;
  hazeStart: number;
  hazeEnd: number;
  hazeLit: number;
}

interface PassData {
  rgb: string;
  normals: string;
  depth: string;
  albedo?: string;
  roughness?: string;
  masks?: string;        // RGBA, one mask_N per channel
  maskSlots?: boolean[]; // which of mask_1..4 are wired
  width: number;
  height: number;
}

const props = defineProps<{ onChange: (json: string) => void; onPopout?: () => void }>();

const lights              = ref<Light[]>([]);
const selectedId          = ref<number | null>(null);
const ambientIntensity    = ref(0.2);
const ambientColor        = ref("#ffffff");
const delitMix            = ref(0.0);
const roughnessStrength   = ref(1.0);
const shadowsEnabled      = ref(false);
const shadowStrength      = ref(0.6);
const shadowSoftness      = ref(0.3);
const shadowRange         = ref(0.15);
// Look post-process — defaults are the identity (parity with LOOK_DEFAULTS in Python)
const lookExposure        = ref(0.0);
const lookTemperature     = ref(0.0);
const lookTint            = ref(0.0);
const lookSaturation      = ref(1.0);
const hazeAmount          = ref(0.0);
const hazeColor           = ref("#c8d0dc");
const hazeStart           = ref(0.0);
const hazeEnd             = ref(1.0);
const hazeLit             = ref(0.0);
const WB_GAIN = 0.25;   // kept in sync with Python
const HAZE_EPS = 1e-4;  // idem

// Tracer constants — kept in sync with the Python backend tracer.
const SHADOW_STEPS  = 24;
const SHADOW_BIAS   = 0.012;
const SHADOW_SLOPE  = 0.030;

const canvas            = ref<HTMLCanvasElement | null>(null);
const overlay           = ref<HTMLCanvasElement | null>(null);
// Sliders: Shift = tenth-speed drag, double-click = reset to data-default (fine_drag.ts,
// same as Preview 3D / Lens Distort). Delegated on the root, so sliders inside panels
// that mount later (per-light sections) are covered too.
const rootEl            = ref<HTMLElement | null>(null);
let detachFine: (() => void) | null = null;
const canvasWrap        = ref<HTMLDivElement | null>(null);
const passAspect        = ref(16 / 9);
const canvasAspectRatio = computed(() => `${passAspect.value}`);
const stageEl           = ref<HTMLDivElement | null>(null);

// ── Pop-out ─────────────────────────────────────────────────────────────────
// The node's host moves this whole mount into the shared modal (main.ts). Popped, every
// section is open at once in a sidebar and the canvas is letterboxed into the stage — the
// export aspect rules, so the preview is never stretched to the modal's shape.
const popped = ref(false);
const fit = ref<{ w: number; h: number } | null>(null);
const wrapStyle = computed(() =>
  popped.value && fit.value
    ? { width: fit.value.w + "px", height: fit.value.h + "px" }
    : { aspectRatio: canvasAspectRatio.value });
function measureFit() {
  const st = stageEl.value;
  if (!popped.value || !st) { fit.value = null; return; }
  const availW = st.clientWidth - 24, availH = st.clientHeight - 24;
  if (availW <= 0 || availH <= 0) return;
  const a = passAspect.value;
  const w = Math.min(availW, availH * a);
  fit.value = { w: Math.floor(w), h: Math.floor(w / a) };
}
function setPopped(v: boolean) {
  popped.value = v;
  nextTick(() => { measureFit(); scheduleRedraw(); });
}
// Sections are independent toggles in the node; popped, they are all open.
const secOpen = (k: "ambient" | "material" | "shadows" | "look") => popped.value || openSections.value[k];

// ── Compare: hold to see the plate as it came in ───────────────────────────
const comparing = ref(false);
const hasPasses = ref(false);
function setCompare(on: boolean, e?: PointerEvent) {
  if (on && e) (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  if (comparing.value === on) return;
  comparing.value = on;
  scheduleRedraw();
}

// Pass data received from backend — kept outside Vue reactivity (large buffers)
let passRgb:       Uint8Array | null = null;
let passNormals:   Uint8Array | null = null;
let passDepth:     Uint8Array | null = null;
let passAlbedo:    Uint8Array | null = null;
let passRoughness: Uint8Array | null = null;
let passMasks:     Uint8Array | null = null;  // (H,W,4)
let passW = 0;
let passH = 0;
const hasAlbedo    = ref(false);
const hasRoughness = ref(false);
const maskSlots    = ref<boolean[]>(Array(MASK_SLOTS).fill(false));
const isProcessing = ref(false);

const pointLights = computed(() => lights.value.filter((l: Light) => l.type === "point"));

// ── Collapsible section state (UI only, not serialised into lights_config) ────
const openSections = ref<{ ambient: boolean; material: boolean; shadows: boolean; look: boolean }>({
  ambient: false,
  material: false,
  shadows: false,
  look: false,
});
function toggleSection(key: "ambient" | "material" | "shadows" | "look") {
  if (popped.value) return;  // all open in the sidebar
  openSections.value[key] = !openSections.value[key];
}

// Fill percentage for ComfyUI-style sliders (drives the --rl-fill CSS var)
function rangeStyle(v: number, min: number, max: number) {
  const pct = Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
  return { "--rl-fill": pct + "%" };
}

// ── RAF-batched redraw ──────────────────────────────────────────────────────
let rafId: number | null = null;
function scheduleRedraw() {
  if (rafId !== null) return;
  rafId = requestAnimationFrame(() => { rafId = null; drawPreview(); });
}

// ── Arc visibility ──────────────────────────────────────────────────────────
// The three radial sliders of a point light show only while the pointer is within their reach
// (or while one is being dragged); otherwise just the dot stays, so the picture is clear.
const hoverId = ref<number | null>(null);
let arcDragId: number | null = null;
const ARC_REACH = 18 + 22 + 4;  // inner radius + widest band + hit tolerance, in display px

function onWrapMove(e: MouseEvent) {
  const cv = canvas.value;
  if (!cv) return;
  const r = cv.getBoundingClientRect();
  if (r.width === 0) return;
  const k = cv.width / r.width;  // display px → canvas px
  const px = (e.clientX - r.left) * k, py = (e.clientY - r.top) * k;
  let best: number | null = null, bd = Infinity;
  for (const l of lights.value) {
    if (l.type !== "point") continue;
    const d = Math.hypot(px - l.x * cv.width, py - l.y * cv.height);
    if (d <= ARC_REACH * canvasDisplayScale && d < bd) { best = l.id; bd = d; }
  }
  if (best !== hoverId.value) { hoverId.value = best; scheduleRedraw(); }
}
function onWrapLeave() {
  if (hoverId.value !== null) { hoverId.value = null; scheduleRedraw(); }
}

// ── Drag state ─────────────────────────────────────────────────────────────
let dragging: Light | null = null;
let didDrag = false;

function startDrag(_e: MouseEvent, light: Light) {
  selectedId.value = light.id;
  dragging = light;
  didDrag = false;
  const onMove = (ev: MouseEvent) => {
    if (!canvasWrap.value) return;
    didDrag = true;
    const rect = canvasWrap.value.getBoundingClientRect();
    light.x = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    light.y = Math.max(0, Math.min(1, (ev.clientY - rect.top)  / rect.height));
    emit();
  };
  const onUp = () => {
    dragging = null;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function onMouseUp() {
  dragging = null;
}

function onCanvasMove(e: MouseEvent) {
  if (!dragging || !(e.buttons & 1)) { dragging = null; return; }
}

// ── Canvas widget state ─────────────────────────────────────────────────────
let widgetCx = 0, widgetCy = 0, widgetR = 0;
let widgetWasDown = false;
let canvasDisplayScale = 1;

function onCanvasMouseDown(e: MouseEvent) {
  widgetWasDown = false;
  const cv = canvas.value;
  if (!cv) return;
  const cvRect = cv.getBoundingClientRect();
  const sx = (e.clientX - cvRect.left) * (cv.width  / cvRect.width);
  const sy = (e.clientY - cvRect.top)  * (cv.height / cvRect.height);

  // ── Sphere widget (selected directional light) ────────────────────────────
  if (widgetR > 0) {
    const ddx = sx - widgetCx, ddy = sy - widgetCy;
    if (ddx * ddx + ddy * ddy <= widgetR * widgetR) {
      const light = lights.value.find((l: Light) => l.id === selectedId.value && l.type === "directional");
      if (light) {
        widgetWasDown = true;
        let prevX = e.clientX, prevY = e.clientY;
        const onMove = (ev: MouseEvent) => {
          const ddx2 = (ev.clientX - prevX) * (cv.width  / cvRect.width);
          const ddy2 = (ev.clientY - prevY) * (cv.height / cvRect.height);
          prevX = ev.clientX; prevY = ev.clientY;
          const sens = 90 / widgetR;
          light.azimuth   = Math.round(((light.azimuth  + ddx2 * sens) % 360 + 360 + 180) % 360 - 180);
          light.elevation = Math.round(Math.max(-90, Math.min(90, light.elevation + ddy2 * sens)));
          emit();
        };
        const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        return;
      }
    }
  }

  // ── Arc widgets (point lights) — 3 sectors of 120° each ─────────────────
  const s   = canvasDisplayScale;
  const arc = { innerR: 18 * s, maxLW: 22 * s, tol: 4 * s };
  const B1 = Math.PI / 6;
  const B2 = 5 * Math.PI / 6;
  const B3 = 3 * Math.PI / 2;

  const makeDrag = (
    getV: () => number, setV: (v: number) => void,
    min: number, max: number, invert = false
  ) => {
    widgetWasDown = true;
    let prevY = e.clientY;
    const sens = (max - min) / (60 * cvRect.height / cv.height);
    const onMove = (ev: MouseEvent) => {
      const delta = (ev.clientY - prevY) * sens;
      setV(Math.max(min, Math.min(max, getV() + (invert ? delta : -delta))));
      prevY = ev.clientY;
      emit();
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      arcDragId = null;
      scheduleRedraw();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  for (const light of lights.value) {
    if (light.type !== "point") continue;
    const lx   = light.x * cv.width;
    const ly   = light.y * cv.height;
    const ddx  = sx - lx, ddy = sy - ly;
    const dist = Math.sqrt(ddx * ddx + ddy * ddy);

    const a = Math.atan2(ddy, ddx);
    const aN = a < 0 ? a + 2 * Math.PI : a;

    const isIntensity = aN >= B3 || aN < B1;
    const isDepth     = aN >= B1 && aN < B2;
    const isRadius    = aN >= B2 && aN < B3;

    const inBand = dist >= arc.innerR - arc.tol && dist <= arc.innerR + arc.maxLW + arc.tol;
    if (inBand) {
      arcDragId = light.id;
      if (isIntensity) {
        selectedId.value = light.id;
        makeDrag(() => light.intensity, v => { light.intensity = v; }, 0, 2);
        return;
      }
      if (isDepth) {
        selectedId.value = light.id;
        makeDrag(() => light.z, v => { light.z = v; }, 0, 2, true);
        return;
      }
      if (isRadius) {
        selectedId.value = light.id;
        makeDrag(() => light.radius, v => { light.radius = v; }, 0.05, 2);
        return;
      }
    }
  }
}

function onCanvasClick(e: MouseEvent) {
  if (widgetWasDown) { widgetWasDown = false; return; }
  if (!canvasWrap.value) return;
  const sel = lights.value.find((l: Light) => l.id === selectedId.value);
  if (!sel || sel.type !== "point") return;
  const rect = canvasWrap.value.getBoundingClientRect();
  sel.x = (e.clientX - rect.left) / rect.width;
  sel.y = (e.clientY - rect.top)  / rect.height;
  emit();
}

// ── Light management ────────────────────────────────────────────────────────
let idSeq = Date.now();
// Mask/shadow fields come from normLight — the ONE list of per-light defaults. A
// field missing here (maskProject, once) crashed the render the moment its row
// appeared, and Vue tore the whole widget out of the node.
function mkLight(type: "point" | "directional", over: Partial<Light> = {}): Light {
  return normLight({
    id: idSeq++,
    type,
    color: "#ffffff",
    intensity: 1.0,
    x: 0.15 + (lights.value.length * 0.17) % 0.7,
    y: 0.5,
    z: 0.5,
    azimuth: 0,
    elevation: -45,  // stored image-space: negative = from above (see setElevation)
    radius: 0.5,
    falloff: 2.0,
    ...over,
  });
}

function addLight(type: "point" | "directional") {
  if (lights.value.length >= MAX_LIGHTS) return;
  const light = mkLight(type);
  lights.value.push(light);
  selectedId.value = light.id;
  emit();
}

// Mask slots a light's editor lists: the wired ones, plus any it still has a use set on.
const maskRows = (l: Light) =>
  Array.from({ length: MASK_SLOTS }, (_, k) => k + 1).filter((k) => maskSlots.value[k - 1] || l.mset[k - 1] > 0);
// Uses that count: an unwired slot selects nothing (the light is left alone, whatever its use).
const maskCount = (l: Light) => l.mset.filter((c, k) => c > 0 && maskSlots.value[k]).length;
const hasGobo = (l: Light) => l.mset.some((c, k) => c >= 3 && maskSlots.value[k]);
function onMaskUse(l: Light, k: number) {
  // A gobo at Project 0 is just the flat mask; give the choice something to show.
  if (l.mset[k - 1] >= 3 && l.maskProject === 0) l.maskProject = 0.5;
  emit();
}

// `elevation` is stored in image space, where Y points DOWN (the normals are flipped into it), so
// a positive stored value lights surfaces facing down. The slider shows and writes the negation:
// + = the light is above. Stored numbers are untouched, so saved workflows look the same.
function setElevation(l: Light, e: Event) {
  l.elevation = -Number((e.target as HTMLInputElement).value);
  emit();
}

function removeLight(id: number) {
  lights.value = lights.value.filter((l: Light) => l.id !== id);
  if (selectedId.value === id) selectedId.value = null;
  emit();
}

function clearLights() {
  lights.value = [];
  selectedId.value = null;
  emit();
}

// Reset = Clear + every setting back to its default. deserialise("{}") already IS the
// default state (each field falls back to its default), so this is that plus the emit.
function resetAll() {
  deserialise("{}");
  selectedId.value = null;
  emit();
}

function selectLight(id: number) {
  // Popped, every light is expanded, so a second click has nothing to collapse.
  selectedId.value = !popped.value && selectedId.value === id ? null : id;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
// (start, span) of the haze ramp — parity with _haze_ramp in Python: Start = End is a
// step that includes dist == Start, so only then the start is nudged back by HAZE_EPS.
function hazeRamp(): [number, number] {
  const st = hazeStart.value, span = hazeEnd.value - st;
  return Math.abs(span) <= HAZE_EPS ? [st - HAZE_EPS, HAZE_EPS] : [st, span];  // span signed
}

// White-balance RGB gains from the Temp/Tint sliders (parity with _apply_look).
function wbGain(): [number, number, number] {
  const t = lookTemperature.value, g = lookTint.value;
  return [1 + WB_GAIN * t, 1 + WB_GAIN * g, 1 - WB_GAIN * t];
}

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  return [
    parseInt(h.substring(0, 2), 16) / 255,
    parseInt(h.substring(2, 4), 16) / 255,
    parseInt(h.substring(4, 6), 16) / 255,
  ];
}

// ═══════════════════════════════════════════════════════════════════════════
// WebGL pixel shader — replaces the JS pixel loop in renderShader
// ═══════════════════════════════════════════════════════════════════════════

// WebGL state lives outside Vue reactivity (no need to observe these)
let glOffscreen: OffscreenCanvas | null = null;
let gl: WebGLRenderingContext | null = null;
let glProgram: WebGLProgram | null = null;
let glQuadBuf: WebGLBuffer | null = null;
let glTextures: { rgb: WebGLTexture | null; normals: WebGLTexture | null; depth: WebGLTexture | null; albedo: WebGLTexture | null; roughness: WebGLTexture | null; masks?: WebGLTexture | null; rimField?: WebGLTexture | null } = { rgb: null, normals: null, depth: null, albedo: null, roughness: null };
let glLocs: Record<string, WebGLUniformLocation | null> = {};
let glAPos = -1;
let glReady = false;
let glW = 0, glH = 0;
let texturesDirty = false;

const VERT_SRC = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// GLSL fragment shader — Lambertian + Blinn-Phong, max MAX_LIGHTS lights
// Uses UNPACK_FLIP_Y_WEBGL so vUv.y=0 = image bottom, vUv.y=1 = image top.
// imgUv converts to image-space coords (y=0 at top) for light position math.
const FRAG_SRC = `
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

// Look post-process (parity with _apply_look in Python)
uniform float uExposure;   // already 2^ev
uniform vec3  uWbGain;
uniform float uSaturation;
uniform float uHazeAmount;
uniform vec3  uHazeColor;
uniform float uHazeStart;
uniform float uHazeInvSpan;  // 1 / span, signed (End < Start = reversed ramp)
uniform float uHazeLit;

// Flat light arrays (max 3) — avoids struct array issues in GLSL ES 1.00
uniform int   uLType[${MAX_LIGHTS}];
uniform float uLColorR[${MAX_LIGHTS}];
uniform float uLColorG[${MAX_LIGHTS}];
uniform float uLColorB[${MAX_LIGHTS}];
uniform float uLIntensity[${MAX_LIGHTS}];
uniform float uLX[${MAX_LIGHTS}];
uniform float uLY[${MAX_LIGHTS}];
uniform float uLZ[${MAX_LIGHTS}];
uniform float uLRadius[${MAX_LIGHTS}];
uniform float uLAzimuth[${MAX_LIGHTS}];
uniform float uLElevation[${MAX_LIGHTS}];
// Per-light mask: one-hot channel selector into uMasks (all-zero = no mask), invert, amount
uniform sampler2D uMasks;
uniform vec4  uLMaskSel[${MAX_LIGHTS}];  // multi-hot: which mask_N this light uses
uniform vec4  uLMaskInv[${MAX_LIGHTS}];
uniform vec4  uLMaskGobo[${MAX_LIGHTS}];
uniform float uLMaskComb[${MAX_LIGHTS}];
uniform float uLMaskAmt[${MAX_LIGHTS}];
uniform float uLProject[${MAX_LIGHTS}];
// Per-light shadow opt-out (uShadowOn stays the master)
uniform float uLShadow[${MAX_LIGHTS}];
// Rim from a mask silhouette. The smooth edge field (edge, outward normal, mask) is built on the
// CPU per (mask, width) and stacked in an atlas, one image-sized tile per rim light: RGBA8 =
// (edge, ox*.5+.5, oy*.5+.5, mask). uLRimTile is the light's tile, -1 = no rim.
uniform sampler2D uRimField;
uniform float uRimTiles;
uniform float uLRimTile[${MAX_LIGHTS}];
uniform float uLRimAmt[${MAX_LIGHTS}];
uniform float uLRimSoft[${MAX_LIGHTS}];
uniform float uLRimSpread[${MAX_LIGHTS}];
uniform float uLRimSurf[${MAX_LIGHTS}];

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

// One light's contribution, inlined into main()'s loop on purpose: GLSL ES 1.0 lets a
// fragment shader index a uniform array only with a constant or a LOOP variable, and a
// function parameter is neither — as a function this never compiled (ANGLE: 'Index
// expression can only contain const or loop symbols'), so the preview fell back to the
// JS pixel loop. Kept as a macro-like block: the body reads N, imgUv, dVal, smoothness,
// shininess and lightAccum from main().

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
  // Light reaching the haze itself: no normals, no shadows (parity with Python's fog_accum)
  vec3 fogAccum = lightAccum;

  // Accumulate lights. A loop variable is the ONLY non-constant index a fragment
  // shader may use on a uniform array in GLSL ES 1.0 (see the note above).
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= uLightCount) break;
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

    // Screen-space shadow attenuation (this light may opt out)
    if (uLShadow[i] > 0.5) {
      float shadow = traceShadow(imgUv, dVal, sdir);
      contrib *= (1.0 - uShadowStrength * shadow);
    }

    // Rim from a silhouette (parity with _rim_term). One read of the precomputed field: closeness
    // to the edge, the edge's outward normal, the mask. The lobe faces the light's screen
    // direction, blends to a full halo when the light is straight behind, and fades as the
    // light comes to the front.
    float rimTile = uLRimTile[i];
    if (uLRimAmt[i] > 0.0 && rimTile > -0.5) {
      // 1:1 with the pass, so a NEAREST read is exact (no bleeding between tiles)
      vec4 rf = texture2D(uRimField, vec2(imgUv.x, (rimTile + imgUv.y) / uRimTiles));
      float edgeR = pow(rf.r, 3.0 - 2.0 * uLRimSoft[i]);
      vec2 outN = rf.gb * 2.0 - 1.0;
      float latR = length(sdir.xy);
      float lobeR = clamp((dot(outN, sdir.xy / max(latR, 1e-6)) + uLRimSpread[i]) / (1.0 + uLRimSpread[i]), 0.0, 1.0);
      float facingR = mix(1.0, lobeR, smoothstep(0.0, 0.5, latR));
      float behindR = clamp(1.0 - sdir.z, 0.0, 1.0);
      float turnR = mix(1.0, clamp((1.0 - N.z) * 2.0, 0.0, 1.0), uLRimSurf[i]);
      contrib += rf.a * edgeR * facingR * behindR * turnR * uLRimAmt[i] * att;
    }

    // Per-light masks: confine the light (and its shadow). Each selected channel is read flat
    // (silhouette) or displaced along the light by depth (gobo), optionally inverted, then
    // combined: product = intersect, 1 - product of complements = union (parity with _light_mask).
    vec4 sel = uLMaskSel[i];
    float maskF = 1.0;
    if (dot(sel, sel) > 0.5) {
      vec2 muv = imgUv - sdir.xy * dVal * uLProject[i];
      vec4 mFlat = texture2D(uMasks, vec2(imgUv.x, 1.0 - imgUv.y));
      vec4 mGobo = texture2D(uMasks, vec2(muv.x, 1.0 - muv.y));
      vec4 m = mix(mFlat, mGobo, uLMaskGobo[i]);
      m = mix(m, 1.0 - m, uLMaskInv[i]);
      vec4 pIn = mix(vec4(1.0), m, sel);
      vec4 qIn = mix(vec4(1.0), 1.0 - m, sel);
      float inter = pIn.x * pIn.y * pIn.z * pIn.w;
      float uni = 1.0 - qIn.x * qIn.y * qIn.z * qIn.w;
      maskF = mix(1.0, mix(inter, uni, uLMaskComb[i]), uLMaskAmt[i]);
    }
    contrib *= maskF;

    vec3 lCol = vec3(uLColorR[i], uLColorG[i], uLColorB[i]) * uLIntensity[i];
    lightAccum += contrib * lCol;
    fogAccum += att * maskF * lCol;
  }

  vec3 c = clamp(base * lightAccum, 0.0, 1.0);
  // Look: exposure -> white balance -> saturation -> haze (haze last: the colour you
  // pick is the colour that lands on the plate). Depth: near = white.
  c = c * uExposure * uWbGain;
  float luma = dot(c, vec3(0.299, 0.587, 0.114));
  c = luma + (c - luma) * uSaturation;
  vec3 hazeCol = uHazeColor * mix(vec3(1.0), fogAccum, uHazeLit);
  c = mix(c, hazeCol, uHazeAmount * clamp((1.0 - dVal - uHazeStart) * uHazeInvSpan, 0.0, 1.0));
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

function compileShader(g: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = g.createShader(type);
  if (!sh) return null;
  g.shaderSource(sh, src);
  g.compileShader(sh);
  if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) {
    console.error("[NKD-Relight] Shader compile error:", g.getShaderInfoLog(sh));
    g.deleteShader(sh);
    return null;
  }
  return sh;
}

function initWebGL(w: number, h: number): boolean {
  try {
    glOffscreen = new OffscreenCanvas(w, h);
    const ctx = glOffscreen.getContext("webgl", { preserveDrawingBuffer: true, antialias: false });
    if (!ctx) { glReady = false; return false; }
    gl = ctx as WebGLRenderingContext;
    // Passes arrive tightly packed. WebGL's default UNPACK_ALIGNMENT of 4 wants every
    // row padded to 4 bytes, so any RGB pass whose width × 3 is not a multiple of 4
    // (409, 370, most real widths) makes texImage2D throw INVALID_OPERATION and the
    // preview goes black — measured live, see CLAUDE.md.
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // The browser evicts GL contexts when a page holds too many (reloads with several
    // widgets get there). The 2D canvas keeps drawing the HUD while the offscreen image
    // silently goes black — so drop the dead context and rebuild it on the next draw.
    glOffscreen.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      destroyWebGL();
      texturesDirty = true;
      scheduleRedraw();
    });

    const vert = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
    const frag = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vert || !frag) { glReady = false; return false; }

    glProgram = gl.createProgram()!;
    gl.attachShader(glProgram, vert);
    gl.attachShader(glProgram, frag);
    gl.linkProgram(glProgram);
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    if (!gl.getProgramParameter(glProgram, gl.LINK_STATUS)) {
      console.error("[NKD-Relight] Program link error:", gl.getProgramInfoLog(glProgram));
      glReady = false; return false;
    }

    // Full-screen quad: two triangles covering NDC [-1,1]²
    glQuadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, glQuadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1,  -1, 1,
       1, -1,  1,  1,  -1, 1,
    ]), gl.STATIC_DRAW);

    // Allocate textures for all 5 passes
    const mkTex = () => {
      const t = gl!.createTexture()!;
      gl!.bindTexture(gl!.TEXTURE_2D, t);
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR);
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
      return t;
    };
    glTextures = { rgb: mkTex(), normals: mkTex(), depth: mkTex(), albedo: mkTex(), roughness: mkTex(), masks: mkTex(), rimField: mkTex() };
    // The rim atlas is read 1:1 with the pass: NEAREST keeps tiles from bleeding into each other
    gl.bindTexture(gl.TEXTURE_2D, glTextures.rimField);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    // Cache uniform locations
    gl.useProgram(glProgram);
    const u = (name: string) => gl!.getUniformLocation(glProgram!, name);
    glLocs = {
      uRgb: u("uRgb"), uNormals: u("uNormals"), uDepth: u("uDepth"),
      uAlbedo: u("uAlbedo"), uRoughness: u("uRoughness"),
      uHasAlbedo: u("uHasAlbedo"), uHasRoughness: u("uHasRoughness"),
      uAmbR: u("uAmbR"), uAmbG: u("uAmbG"), uAmbB: u("uAmbB"),
      uAmbientIntensity: u("uAmbientIntensity"),
      uDelitMix: u("uDelitMix"), uRoughnessStrength: u("uRoughnessStrength"),
      uShadowOn: u("uShadowOn"), uShadowStrength: u("uShadowStrength"),
      uShadowSoftness: u("uShadowSoftness"), uShadowRange: u("uShadowRange"),
      uExposure: u("uExposure"), uWbGain: u("uWbGain"), uSaturation: u("uSaturation"),
      uHazeAmount: u("uHazeAmount"), uHazeColor: u("uHazeColor"),
      uHazeStart: u("uHazeStart"), uHazeInvSpan: u("uHazeInvSpan"), uHazeLit: u("uHazeLit"),
      uLightCount: u("uLightCount"),
      uLType: Array.from({ length: MAX_LIGHTS }, (_, k) => u(`uLType[${k}]`)),
      uLColorR: u("uLColorR"), uLColorG: u("uLColorG"), uLColorB: u("uLColorB"),
      uLIntensity: u("uLIntensity"),
      uLX: u("uLX"), uLY: u("uLY"), uLZ: u("uLZ"), uLRadius: u("uLRadius"),
      uLAzimuth: u("uLAzimuth"), uLElevation: u("uLElevation"),
      uMasks: u("uMasks"), uLMaskSel: u("uLMaskSel"), uLMaskInv: u("uLMaskInv"),
      uLMaskGobo: u("uLMaskGobo"), uLMaskComb: u("uLMaskComb"),
      uRimField: u("uRimField"), uRimTiles: u("uRimTiles"), uLRimTile: u("uLRimTile"),
      uLRimAmt: u("uLRimAmt"), uLRimSoft: u("uLRimSoft"), uLRimSpread: u("uLRimSpread"),
      uLRimSurf: u("uLRimSurf"),
      uLMaskAmt: u("uLMaskAmt"), uLShadow: u("uLShadow"), uLProject: u("uLProject"),
    };

    // Bind texture units once
    gl.uniform1i(glLocs.uRgb, 0);
    gl.uniform1i(glLocs.uNormals, 1);
    gl.uniform1i(glLocs.uDepth, 2);
    gl.uniform1i(glLocs.uAlbedo, 3);
    gl.uniform1i(glLocs.uRoughness, 4);
    gl.uniform1i(glLocs.uMasks, 5);
    gl.uniform1i(glLocs.uRimField, 6);

    glAPos = gl.getAttribLocation(glProgram, "aPos");
    glW = w; glH = h;
    glReady = true;
    return true;
  } catch (e) {
    console.warn("[NKD-Relight] WebGL init failed, falling back to JS shader:", e);
    glReady = false;
    return false;
  }
}

// ── Rim field (parity with _rim_field in Python) ─────────────────────────────
// The mask is softened with the same cheap blur as NKD Mask Ops: three box passes per axis
// (running sums, so the radius is free) with a continuous radius. B is 0.5 on a straight edge and
// climbs to 1 inside, so 2(1-B) is a smooth closeness-to-the-edge profile and -grad B the outward
// normal. Built once per (mask, width) and cached; a new pass set clears the cache.
const RIM_MIN_RADIUS = 2;

function boxPass(src: Float32Array, dst: Float32Array, W: number, H: number, k: number, horizontal: boolean) {
  const half = k >> 1, lines = horizontal ? H : W, n = horizontal ? W : H;
  const step = horizontal ? 1 : W, lineStep = horizontal ? W : 1;
  for (let l = 0; l < lines; l++) {
    const base = l * lineStep;
    const at = (i: number) => src[base + Math.min(n - 1, Math.max(0, i)) * step];  // replicate padding
    let sum = 0;
    for (let i = -half; i <= half; i++) sum += at(i);
    for (let i = 0; i < n; i++) {
      dst[base + i * step] = sum / k;
      sum += at(i + half + 1) - at(i - half);
    }
  }
}

function box3(x: Float32Array, W: number, H: number, k: number): Float32Array {
  if (k <= 1) return x;
  let a = x, b = new Float32Array(x.length);
  for (const horizontal of [true, false]) {
    for (let p = 0; p < 3; p++) { boxPass(a, b, W, H, k, horizontal); [a, b] = [b, a]; }
  }
  for (let i = 0; i < a.length; i++) a[i] = Math.min(1, Math.max(0, a[i]));
  return a;
}

function softMask(x: Float32Array, W: number, H: number, r: number): Float32Array {
  if (r <= 1) return x;
  let lo = Math.floor(r) | 1;
  if (lo > r) lo -= 2;
  const t = (r - lo) / 2;
  const a = box3(x.slice(), W, H, lo);
  if (t <= 1e-6) return a;
  const b = box3(x.slice(), W, H, lo + 2);
  for (let i = 0; i < a.length; i++) a[i] += (b[i] - a[i]) * t;
  return a;
}

// RGBA8 tile, image row order: (edge, ox*.5+.5, oy*.5+.5, mask)
const rimCache = new Map<string, Uint8Array>();
function buildRimField(ch: number, width: number): Uint8Array {
  const W = passW, H = passH, n = W * H;
  const m = new Float32Array(n);
  for (let i = 0; i < n; i++) m[i] = passMasks![i * 4 + ch] / 255;
  const B = softMask(m, W, H, Math.max(RIM_MIN_RADIUS, width * Math.min(W, H)));
  const out = new Uint8Array(n * 4);
  for (let y = 0; y < H; y++) {
    const ym = Math.max(0, y - 1), yp = Math.min(H - 1, y + 1);
    for (let x = 0; x < W; x++) {
      const xm = Math.max(0, x - 1), xp = Math.min(W - 1, x + 1);
      const gx = (B[y * W + xp] - B[y * W + xm]) * 0.5, gy = (B[yp * W + x] - B[ym * W + x]) * 0.5;
      const nrm = Math.hypot(gx, gy), inv = nrm > 1e-5 ? 1 / nrm : 0;
      const o = (y * W + x) * 4;
      out[o]     = Math.round(Math.min(1, Math.max(0, 2 * (1 - B[y * W + x]))) * 255);
      out[o + 1] = Math.round((-gx * inv * 0.5 + 0.5) * 255);
      out[o + 2] = Math.round((-gy * inv * 0.5 + 0.5) * 255);
      out[o + 3] = Math.round(m[y * W + x] * 255);
    }
  }
  return out;
}

// The light's field, or null when it has no rim (off, unwired slot, no amount).
function rimFieldFor(l: Light): Uint8Array | null {
  if (!passMasks || l.rimAmount <= 0 || l.rimMask < 1 || l.rimMask > MASK_SLOTS || !maskSlots.value[l.rimMask - 1]) return null;
  const key = `${l.rimMask - 1}|${l.rimWidth}`;
  let f = rimCache.get(key);
  if (!f) {
    if (rimCache.size > 24) rimCache.clear();  // dragging Width mints a key per step
    f = buildRimField(l.rimMask - 1, l.rimWidth);
    rimCache.set(key, f);
  }
  return f;
}

// One image-sized tile per rim light, stacked. Re-uploaded only when the set of tiles changes.
let rimAtlasTiles: Uint8Array[] = [];
function uploadRimAtlas(tiles: Uint8Array[]) {
  if (!gl) return;
  if (tiles.length === rimAtlasTiles.length && tiles.every((t, i) => t === rimAtlasTiles[i])) return;
  rimAtlasTiles = tiles.slice();
  gl.bindTexture(gl.TEXTURE_2D, glTextures.rimField!);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);  // rows are already in image order; tiles must not swap
  if (!tiles.length) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  } else {
    const atlas = new Uint8Array(passW * passH * 4 * tiles.length);
    tiles.forEach((t, i) => atlas.set(t, i * passW * passH * 4));
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, passW, passH * tiles.length, 0, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
  }
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
}

function uploadPassTextures() {
  if (!gl || !glReady) return;
  // UNPACK_FLIP_Y_WEBGL: first row of data (image top) maps to texture t=1 (screen top)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);

  const upload = (tex: WebGLTexture | null, data: Uint8Array | null, fmt: number = gl!.RGB) => {
    if (!tex) return;
    const ch = fmt === gl!.RGBA ? 4 : 3;
    if (data && data.length < passW * passH * ch) {
      // A short buffer makes texImage2D throw INVALID_OPERATION and the preview goes
      // black with no hint. Say so, and upload the 1×1 stand-in instead.
      console.warn(`NKD Relight: pass buffer ${data.length} B < ${passW}×${passH}×${ch}, skipped`);
      data = null;
    }
    gl!.bindTexture(gl!.TEXTURE_2D, tex);
    if (data) {
      gl!.texImage2D(gl!.TEXTURE_2D, 0, fmt, passW, passH, 0, fmt, gl!.UNSIGNED_BYTE, data);
    } else {
      // Upload a 1x1 black pixel as placeholder for optional passes
      gl!.texImage2D(gl!.TEXTURE_2D, 0, fmt, 1, 1, 0, fmt, gl!.UNSIGNED_BYTE, new Uint8Array(ch));
    }
  };

  upload(glTextures.rgb,      passRgb);
  upload(glTextures.normals,  passNormals);
  upload(glTextures.depth,    passDepth);
  upload(glTextures.albedo,   passAlbedo);
  upload(glTextures.roughness, passRoughness);
  upload(glTextures.masks,    passMasks, gl.RGBA);

  texturesDirty = false;
}

function renderWebGL(ctx: CanvasRenderingContext2D, W: number, H: number) {
  if (!gl || !glProgram || !glOffscreen) return;

  // Resize offscreen canvas if pass dimensions changed
  if (glW !== W || glH !== H) {
    glOffscreen.width  = W;
    glOffscreen.height = H;
    gl.viewport(0, 0, W, H);
    glW = W; glH = H;
    texturesDirty = true;
  }

  if (texturesDirty) uploadPassTextures();

  gl.useProgram(glProgram);
  gl.viewport(0, 0, W, H);

  // Bind textures to units 0–4
  const bindTex = (unit: number, tex: WebGLTexture | null) => {
    gl!.activeTexture(gl!.TEXTURE0 + unit);
    gl!.bindTexture(gl!.TEXTURE_2D, tex);
  };
  bindTex(0, glTextures.rgb);
  bindTex(1, glTextures.normals);
  bindTex(2, glTextures.depth);
  bindTex(3, glTextures.albedo);
  bindTex(4, glTextures.roughness);
  bindTex(5, glTextures.masks);
  bindTex(6, glTextures.rimField);

  // Global uniforms
  const [ar, ag, ab] = hexToRgb(ambientColor.value);
  gl.uniform1f(glLocs.uAmbR, ar);
  gl.uniform1f(glLocs.uAmbG, ag);
  gl.uniform1f(glLocs.uAmbB, ab);
  gl.uniform1f(glLocs.uAmbientIntensity, ambientIntensity.value);
  gl.uniform1f(glLocs.uDelitMix, delitMix.value);
  gl.uniform1f(glLocs.uRoughnessStrength, roughnessStrength.value);
  gl.uniform1i(glLocs.uHasAlbedo,    hasAlbedo.value    ? 1 : 0);
  gl.uniform1i(glLocs.uHasRoughness, hasRoughness.value ? 1 : 0);
  gl.uniform1i(glLocs.uShadowOn,       shadowsEnabled.value ? 1 : 0);
  gl.uniform1f(glLocs.uShadowStrength, shadowStrength.value);
  gl.uniform1f(glLocs.uShadowSoftness, shadowSoftness.value);
  gl.uniform1f(glLocs.uShadowRange,    shadowRange.value);
  const wb = wbGain();
  gl.uniform1f(glLocs.uExposure,   Math.pow(2, lookExposure.value));
  gl.uniform3f(glLocs.uWbGain,     wb[0], wb[1], wb[2]);
  gl.uniform1f(glLocs.uSaturation, lookSaturation.value);
  gl.uniform1f(glLocs.uHazeAmount, hazeAmount.value);
  const hc = hexToRgb(hazeColor.value);
  gl.uniform3f(glLocs.uHazeColor,  hc[0], hc[1], hc[2]);
  const [hzStart, hzSpan] = hazeRamp();
  gl.uniform1f(glLocs.uHazeStart,   hzStart);
  gl.uniform1f(glLocs.uHazeInvSpan, 1 / hzSpan);
  gl.uniform1f(glLocs.uHazeLit, hazeLit.value);

  // Per-light uniforms — padded to MAX_LIGHTS elements
  const ls = lights.value;
  const count = ls.length;
  gl.uniform1i(glLocs.uLightCount, count);

  const pad = (v: number) => new Array<number>(MAX_LIGHTS).fill(v);
  const lType = pad(0);
  const lR = pad(1), lG = pad(1), lB = pad(1);
  const lInt = pad(0);
  const lX = pad(0), lY = pad(0), lZ = pad(0);
  const lRad = pad(1);
  const lAz = pad(0), lEl = pad(0);
  const lSel = new Float32Array(MAX_LIGHTS * 4);  // vec4 one-hot per light
  const lInv = new Float32Array(MAX_LIGHTS * 4), lGobo = new Float32Array(MAX_LIGHTS * 4);
  const lComb = pad(0), lAmt = pad(1), lSh = pad(1);
  const lRimTile = pad(-1), lRimAmt = pad(0);
  const lRimSoft = pad(0.6), lRimSpread = pad(0.25), lRimSurf = pad(0);
  const rimTiles: Uint8Array[] = [];
  const lProj = pad(0);

  for (let i = 0; i < count; i++) {
    const l = ls[i];
    // An unwired slot selects nothing → the shader leaves the light alone (parity with Python)
    for (let k = 0; k < MASK_SLOTS; k++) {
      const use = l.mset[k];
      if (use > 0 && maskSlots.value[k]) {
        lSel[i * 4 + k] = 1;
        lInv[i * 4 + k] = use === 2 || use === 4 ? 1 : 0;
        lGobo[i * 4 + k] = use >= 3 ? 1 : 0;
      }
    }
    lComb[i] = l.mcomb;
    // An unwired rim slot selects nothing, like an unwired mask
    const rimField = rimFieldFor(l);
    if (rimField) {
      lRimTile[i] = rimTiles.length;
      rimTiles.push(rimField);
      lRimAmt[i] = l.rimAmount;
      lRimSoft[i] = l.rimSoftness;
      lRimSpread[i] = l.rimSpread;
      lRimSurf[i] = l.rimSurface;
    }
    lAmt[i] = l.maskAmount;
    lProj[i] = l.maskProject ?? 0;
    lSh[i]  = l.castShadow ? 1 : 0;
    lType[i] = l.type === "directional" ? 0 : 1;
    const [r, g, b] = hexToRgb(l.color);
    lR[i] = r; lG[i] = g; lB[i] = b;
    lInt[i] = l.intensity;
    lX[i] = l.x; lY[i] = l.y; lZ[i] = l.z;
    lRad[i] = l.radius;
    lAz[i] = l.azimuth  * Math.PI / 180;
    lEl[i] = l.elevation * Math.PI / 180;
  }

  // Integer arrays need individual uniform1i calls in WebGL 1.0
  for (let i = 0; i < MAX_LIGHTS; i++) gl.uniform1i((glLocs.uLType as any)[i], lType[i]);
  gl.uniform1fv(glLocs.uLColorR, lR);
  gl.uniform1fv(glLocs.uLColorG, lG);
  gl.uniform1fv(glLocs.uLColorB, lB);
  gl.uniform1fv(glLocs.uLIntensity, lInt);
  gl.uniform1fv(glLocs.uLX, lX);
  gl.uniform1fv(glLocs.uLY, lY);
  gl.uniform1fv(glLocs.uLZ, lZ);
  gl.uniform1fv(glLocs.uLRadius, lRad);
  gl.uniform1fv(glLocs.uLAzimuth, lAz);
  gl.uniform1fv(glLocs.uLElevation, lEl);
  gl.uniform4fv(glLocs.uLMaskSel, lSel);
  gl.uniform4fv(glLocs.uLMaskInv, lInv);
  gl.uniform4fv(glLocs.uLMaskGobo, lGobo);
  gl.uniform1fv(glLocs.uLMaskComb, lComb);
  uploadRimAtlas(rimTiles);
  gl.uniform1f(glLocs.uRimTiles, Math.max(1, rimTiles.length));
  gl.uniform1fv(glLocs.uLRimTile, lRimTile);
  gl.uniform1fv(glLocs.uLRimAmt, lRimAmt);
  gl.uniform1fv(glLocs.uLRimSoft, lRimSoft);
  gl.uniform1fv(glLocs.uLRimSpread, lRimSpread);
  gl.uniform1fv(glLocs.uLRimSurf, lRimSurf);
  gl.uniform1fv(glLocs.uLMaskAmt, lAmt);
  gl.uniform1fv(glLocs.uLProject, lProj);
  gl.uniform1fv(glLocs.uLShadow, lSh);

  // Draw full-screen quad
  gl.bindBuffer(gl.ARRAY_BUFFER, glQuadBuf);
  gl.enableVertexAttribArray(glAPos);
  gl.vertexAttribPointer(glAPos, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);

  // Blit WebGL result into the 2D canvas
  ctx.drawImage(glOffscreen, 0, 0, W, H);
}

function destroyWebGL() {
  if (!gl) return;
  Object.values(glTextures).forEach(t => t && gl!.deleteTexture(t));
  if (glQuadBuf) gl.deleteBuffer(glQuadBuf);
  if (glProgram) gl.deleteProgram(glProgram);
  glOffscreen = null; gl = null; glProgram = null; glReady = false;
}

// ═══════════════════════════════════════════════════════════════════════════
// JS pixel-loop fallback (used when WebGL is unavailable)
// ═══════════════════════════════════════════════════════════════════════════
function renderShaderFallback(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const imgData = ctx.createImageData(W, H);
  const out = imgData.data;
  const pw = passW, ph = passH;
  const rgb = passRgb!, norm = passNormals!, dep = passDepth!;
  const alb = passAlbedo, rou = passRoughness;
  const mix = delitMix.value, rStr = roughnessStrength.value;
  const [ar, ag, ab] = hexToRgb(ambientColor.value);
  const ambInt = ambientIntensity.value;

  const lightParams = lights.value.map(l => ({
    type: l.type, color: hexToRgb(l.color), intensity: l.intensity,
    x: l.x, y: l.y, z: l.z, radius: l.radius,
    azimuth: l.azimuth * Math.PI / 180, elevation: l.elevation * Math.PI / 180,
    // (channel in passMasks, inverted, gobo) per mask in use; unwired slots select nothing
    mterms: passMasks
      ? l.mset.map((use, k) => ({ ch: k, inv: use === 2 || use === 4, gobo: use >= 3, on: use > 0 && maskSlots.value[k] }))
          .filter((t) => t.on)
      : [],
    mcomb: l.mcomb,
    rimField: rimFieldFor(l),
    rimAmount: l.rimAmount, rimSoftness: l.rimSoftness,
    rimSpread: l.rimSpread, rimSurface: l.rimSurface,
    maskAmount: l.maskAmount, castShadow: l.castShadow,
    maskProject: l.maskProject ?? 0,
  }));
  const masks = passMasks;

  // Screen-space shadow setup (parity with WebGL/Python tracer)
  const shOn   = shadowsEnabled.value;
  const shStr  = shadowStrength.value;
  const shWin  = shadowSoftness.value * 0.5 + 1e-3;
  const shRng  = shadowRange.value;
  // Look post-process (parity with Python / GLSL)
  const ev = Math.pow(2, lookExposure.value), wb = wbGain(), sat = lookSaturation.value;
  const hzA = hazeAmount.value, hz = hexToRgb(hazeColor.value);
  const [hzS, hzSpan] = hazeRamp(); const hzInv = 1 / hzSpan; const hzLit = hazeLit.value;
  const sampleDepth = (u: number, v: number): number => {
    const ix = Math.max(0, Math.min(pw - 1, Math.round(u * pw)));
    const iy = Math.max(0, Math.min(ph - 1, Math.round(v * ph)));
    const di = (iy * pw + ix) * 3;
    return (dep[di] + dep[di+1] + dep[di+2]) / (3 * 255);
  };
  const traceShadow = (u0: number, v0: number, d0: number, sx: number, sy: number, sz: number): number => {
    if (!shOn || shStr <= 0) return 0;
    let occ = 0;
    for (let s = 1; s <= SHADOW_STEPS; s++) {
      const t = (s / SHADOW_STEPS) * shRng;
      const sceneZ = sampleDepth(u0 + sx * t, v0 + sy * t);
      const rayZ = d0 + sz * t;
      const surplus = sceneZ - rayZ - (SHADOW_BIAS + SHADOW_SLOPE * t);
      occ = Math.max(occ, Math.min(1, Math.max(0, surplus / shWin)));
    }
    return occ;
  };

  for (let y = 0; y < H; y++) {
    const sy = Math.min(Math.floor(y * ph / H), ph - 1);
    for (let x = 0; x < W; x++) {
      const sx = Math.min(Math.floor(x * pw / W), pw - 1);
      const pi = (sy * pw + sx) * 3;
      const r = rgb[pi] / 255, g = rgb[pi+1] / 255, b = rgb[pi+2] / 255;
      let nx = (norm[pi] / 255) * 2 - 1;
      let ny = -((norm[pi+1] / 255) * 2 - 1);
      let nz = (norm[pi+2] / 255) * 2 - 1;
      const nL = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
      nx /= nL; ny /= nL; nz /= nL;
      const dVal = (dep[pi] + dep[pi+1] + dep[pi+2]) / (3 * 255);
      let smoothness = 1.0, shininess = 129.0;
      if (rou) {
        const rv = Math.min((rou[pi] + rou[pi+1] + rou[pi+2]) / (3 * 255) * rStr, 1.0);
        smoothness = 1.0 - rv;
        shininess = smoothness * smoothness * 128.0 + 1.0;
      }
      let baseR = r, baseG = g, baseB = b;
      if (alb && mix > 0) {
        baseR = (1 - mix) * r + mix * alb[pi] / 255;
        baseG = (1 - mix) * g + mix * alb[pi+1] / 255;
        baseB = (1 - mix) * b + mix * alb[pi+2] / 255;
      }
      let lR = ambInt * ar, lG = ambInt * ag, lB = ambInt * ab;
      let fR = lR, fG = lG, fB = lB;  // light reaching the haze (parity with Python / GLSL)
      const pu = sx / pw, pv = sy / ph;
      for (const lp of lightParams) {
        let contrib = 0, att = 1.0, ldx = 0, ldy = 0, ldz = 0, lightSolidAngle = 0.0;
        let sdx = 0, sdy = 0, sdz = 0;
        if (lp.type === "directional") {
          ldx = Math.cos(lp.elevation) * Math.sin(lp.azimuth);
          ldy = Math.sin(lp.elevation);
          ldz = Math.cos(lp.elevation) * Math.cos(lp.azimuth);
          sdx = ldx; sdy = ldy; sdz = ldz;
          contrib = Math.max(nx * ldx + ny * ldy + nz * ldz, 0);
        } else {
          const dx = lp.x - pu, dy = lp.y - pv, dz = lp.z - dVal;
          const dist = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1e-8;
          ldx = dx/dist; ldy = dy/dist; ldz = dz/dist;
          sdx = ldx; sdy = ldy; sdz = ldz;
          const nd = dist / lp.radius;
          att = Math.max(1 - nd * nd, 0) ** 2;
          lightSolidAngle = Math.min(1, Math.max(0, (lp.radius - 0.05) / 1.95));
          const w = lightSolidAngle * 1.0;
          const rawDot = nx*ldx + ny*ldy + nz*ldz;
          contrib = Math.max(rawDot + w, 0) / (1 + w) * att;
        }
        if (rou) {
          const hx = ldx, hy = ldy, hz = ldz + 1.0;
          const hLen = Math.sqrt(hx*hx + hy*hy + hz*hz) || 1e-8;
          const ndoth = Math.max(nx*(hx/hLen) + ny*(hy/hLen) + nz*(hz/hLen), 0);
          const effShininess = lp.type === "point"
              ? shininess * (1.0 - lightSolidAngle * 0.95) + 1.0
              : shininess;
          contrib += Math.pow(ndoth, effShininess) * smoothness * smoothness * att;
        }
        if (shOn && lp.castShadow) {
          const occ = traceShadow(pu, pv, dVal, sdx, sdy, sdz);
          contrib *= (1 - shStr * occ);
        }
        if (lp.rimField && lp.rimAmount > 0) {
          // Rim from the silhouette: one read of the precomputed field (parity with _rim_term / GLSL)
          const o = (sy * pw + sx) * 4, f = lp.rimField;
          const edge = Math.pow(f[o] / 255, 3 - 2 * lp.rimSoftness);
          const ox = f[o + 1] / 127.5 - 1, oy = f[o + 2] / 127.5 - 1, lat = Math.hypot(sdx, sdy);
          const lobe = Math.min(1, Math.max(0, ((ox * sdx + oy * sdy) / (lat || 1e-6) + lp.rimSpread) / (1 + lp.rimSpread)));
          const ht = Math.min(1, lat / 0.5), halo = ht * ht * (3 - 2 * ht);
          const facing = 1 + (lobe - 1) * halo;
          const behind = Math.min(1, Math.max(0, 1 - sdz));
          const turn = 1 + (Math.min(1, Math.max(0, (1 - nz) * 2)) - 1) * lp.rimSurface;
          contrib += (f[o + 3] / 255) * edge * facing * behind * turn * lp.rimAmount * att;
        }
        let maskF = 1;
        if (lp.mterms.length && masks) {
          let inter = 1, comp = 1;  // product of masks / product of complements
          for (const t of lp.mterms) {
            // Gobo terms read displaced by depth along the light (parity with Python / GLSL)
            const k = t.gobo ? lp.maskProject : 0;
            const mu = Math.min(1, Math.max(0, pu - sdx * dVal * k));
            const mv = Math.min(1, Math.max(0, pv - sdy * dVal * k));
            const mx = Math.min(pw - 1, Math.round(mu * pw)), my = Math.min(ph - 1, Math.round(mv * ph));
            let m = masks[(my * pw + mx) * 4 + t.ch] / 255;
            if (t.inv) m = 1 - m;
            inter *= m; comp *= 1 - m;
          }
          const m = lp.mcomb === 1 ? 1 - comp : inter;
          maskF = 1 - lp.maskAmount + lp.maskAmount * m;
        }
        contrib *= maskF;
        lR += contrib * lp.color[0] * lp.intensity;
        lG += contrib * lp.color[1] * lp.intensity;
        lB += contrib * lp.color[2] * lp.intensity;
        const reach = att * maskF * lp.intensity;
        fR += reach * lp.color[0]; fG += reach * lp.color[1]; fB += reach * lp.color[2];
      }
      let cR = Math.min(1, Math.max(0, baseR * lR)) * ev * wb[0];
      let cG = Math.min(1, Math.max(0, baseG * lG)) * ev * wb[1];
      let cB = Math.min(1, Math.max(0, baseB * lB)) * ev * wb[2];
      const luma = cR * 0.299 + cG * 0.587 + cB * 0.114;
      cR = luma + (cR - luma) * sat; cG = luma + (cG - luma) * sat; cB = luma + (cB - luma) * sat;
      const hf = hzA * Math.min(1, Math.max(0, (1 - dVal - hzS) * hzInv));
      const hzR = hz[0] * (1 + (fR - 1) * hzLit), hzG = hz[1] * (1 + (fG - 1) * hzLit), hzB = hz[2] * (1 + (fB - 1) * hzLit);
      cR += (hzR - cR) * hf; cG += (hzG - cG) * hf; cB += (hzB - cB) * hf;
      const oi = (y * W + x) * 4;
      out[oi]   = Math.min(255, Math.max(0, cR * 255));
      out[oi+1] = Math.min(255, Math.max(0, cG * 255));
      out[oi+2] = Math.min(255, Math.max(0, cB * 255));
      out[oi+3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);
}

// The plate as received (RGB pass, no lights) — the "Original" compare.
function renderOriginal(ctx: CanvasRenderingContext2D, W: number, H: number) {
  if (!passRgb) return;
  const im = ctx.createImageData(W, H);
  for (let i = 0, j = 0, n = W * H; i < n; i++) {
    im.data[j++] = passRgb[i * 3];
    im.data[j++] = passRgb[i * 3 + 1];
    im.data[j++] = passRgb[i * 3 + 2];
    im.data[j++] = 255;
  }
  ctx.putImageData(im, 0, 0);
}

// ── Canvas preview ───────────────────────────────────────────────────────────
function drawPreview() {
  const cv = canvas.value;
  if (!cv) return;
  const wrap = canvasWrap.value;
  const W = wrap ? wrap.clientWidth  : 320;
  const H = wrap ? wrap.clientHeight : 180;
  cv.width  = W;
  cv.height = H;

  const ctx = cv.getContext("2d");
  if (!ctx) return;

  if (passRgb && passNormals && passDepth && passW > 0 && passH > 0) {
    cv.width  = passW;
    cv.height = passH;

    if (comparing.value) {
      renderOriginal(ctx, passW, passH);
    } else if (glReady && !gl?.isContextLost()) {
      renderWebGL(ctx, passW, passH);
    } else if (passRgb) {
      // Try to init WebGL once we have pass dimensions
      if (initWebGL(passW, passH)) {
        renderWebGL(ctx, passW, passH);
      } else {
        renderShaderFallback(ctx, passW, passH);
      }
    }
  } else {
    renderFallback(ctx, W, H);
  }

  canvasDisplayScale = wrap && wrap.clientWidth > 0 ? cv.width / wrap.clientWidth : 1;

  // Everything that is not the image goes on the overlay, backed at the size it is SHOWN at
  // (times the device ratio). The drawing code keeps working in image-canvas units: the overlay
  // is just scaled by ov.width / cv.width, so arcs, joystick and text stay vector-sharp and
  // the hit-testing (which reasons in those same units) is untouched.
  let g: CanvasRenderingContext2D = ctx;
  const ov = overlay.value;
  if (ov && wrap) {
    const r = wrap.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const ow = Math.max(1, Math.min(4096, Math.round(r.width * dpr)));
    const oh = Math.max(1, Math.min(4096, Math.round(r.height * dpr)));
    if (ov.width !== ow || ov.height !== oh) { ov.width = ow; ov.height = oh; }
    const octx = ov.getContext("2d");
    if (octx) {
      octx.setTransform(1, 0, 0, 1, 0, 0);
      octx.clearRect(0, 0, ow, oh);
      octx.setTransform(ow / cv.width, 0, 0, oh / cv.height, 0, 0);
      g = octx;
    }
  }

  // HUD — sized by the display scale, so it reads the same whatever the pass resolution
  const hs = canvasDisplayScale;
  g.fillStyle = "rgba(255,255,255,0.7)";
  g.font = `${Math.round(11 * hs)}px monospace`;
  g.textAlign = "left";
  g.textBaseline = "alphabetic";
  g.fillText(comparing.value ? "Original" : `Lights: ${lights.value.length}/${MAX_LIGHTS}`, 8 * hs, 16 * hs);
  if (glReady && !comparing.value) {
    g.fillStyle = "rgba(100,220,100,0.5)";
    g.font = `${Math.round(10 * hs)}px monospace`;
    g.fillText("WebGL", cv.width - 44 * hs, 14 * hs);
  }
  if (!passRgb) {
    g.fillStyle = "rgba(255,255,255,0.3)";
    g.font = "10px monospace";
    g.fillText("Execute graph to enable real-time preview", 8, H - 8);
  }

  if (comparing.value) return;  // plate only: no gizmos on top of the comparison
  drawSemicircleWidgets(g, cv.width, cv.height);
  const selDir = lights.value.find((l: Light) => l.id === selectedId.value && l.type === "directional");
  if (selDir) {
    drawDirectionalWidget(g, selDir, cv.width, cv.height);
  } else {
    widgetR = 0;
  }
}

// ── Arc widgets for point lights ─────────────────────────────────────────────
function drawSemicircleWidgets(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const s      = canvasDisplayScale;
  const innerR = 18 * s;
  const MIN_LW =  3 * s;
  const MAX_LW = 22 * s;
  const HG     = 3 * Math.PI / 180;

  const INT_A1 = -Math.PI / 2 + HG,    INT_A2 = Math.PI / 6 - HG;
  const DEP_A1 =  Math.PI / 6 + HG,    DEP_A2 = 5 * Math.PI / 6 - HG;
  const RAD_A1 = 5 * Math.PI / 6 + HG, RAD_A2 = 3 * Math.PI / 2 - HG;

  ctx.save();
  ctx.lineCap = "butt";

  for (const light of lights.value) {
    if (light.type !== "point") continue;
    if (light.id !== hoverId.value && light.id !== arcDragId) continue;
    const lx  = light.x * W;
    const ly  = light.y * H;
    const sel = true;  // shown only while in use, so always drawn as active
    const [lr, lg, lb] = hexToRgb(light.color);
    const cr = Math.round(lr * 255), cg = Math.round(lg * 255), cb = Math.round(lb * 255);
    const alphaTrack = sel ? 0.13 : 0.07;
    const alphaFill  = sel ? 0.62 : 0.22;

    const drawArc = (norm: number, a1: number, a2: number) => {
      const lw = MIN_LW + norm * (MAX_LW - MIN_LW);
      const r  = innerR + lw / 2;
      ctx.beginPath();
      ctx.arc(lx, ly, innerR + MAX_LW / 2, a1, a2, false);
      ctx.strokeStyle = `rgba(${cr},${cg},${cb},${alphaTrack})`;
      ctx.lineWidth   = MAX_LW;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(lx, ly, r, a1, a2, false);
      ctx.strokeStyle = `rgba(${cr},${cg},${cb},${alphaFill})`;
      ctx.lineWidth   = lw;
      ctx.stroke();
    };

    drawArc(light.intensity / 2,             INT_A1, INT_A2);
    drawArc(light.z / 2,                     DEP_A1, DEP_A2);
    drawArc((light.radius - 0.05) / 1.95,    RAD_A1, RAD_A2);

    if (sel) {
      ctx.fillStyle    = "rgba(210,210,230,0.82)";
      ctx.font         = `${Math.round(9 * s)}px sans-serif`;
      ctx.textAlign    = "center";
      ctx.textBaseline = "middle";
      const off = innerR + MAX_LW + 9 * s;
      const label = (text: string, mid: number) =>
        ctx.fillText(text, lx + off * Math.cos(mid), ly + off * Math.sin(mid));
      label(`I ${light.intensity.toFixed(2)}`, (INT_A1 + INT_A2) / 2);
      label(`D ${light.z.toFixed(2)}`,         (DEP_A1 + DEP_A2) / 2);
      label(`R ${light.radius.toFixed(2)}`,    (RAD_A1 + RAD_A2) / 2);
    }
  }

  ctx.restore();
}

// ── Directional-light sphere joystick ───────────────────────────────────────
function drawDirectionalWidget(ctx: CanvasRenderingContext2D, light: Light, W: number, H: number) {
  const r  = Math.max(30, Math.min(50, Math.min(W, H) * 0.09));
  const cx = W - r - 12;
  const cy = H - r - 12;
  widgetCx = cx; widgetCy = cy; widgetR = r;

  const lw = Math.max(0.5, r * 0.02);

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();

  const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.05, cx, cy, r);
  grad.addColorStop(0, "rgba(65,65,92,0.94)");
  grad.addColorStop(1, "rgba(10,10,20,0.94)");
  ctx.fillStyle = grad;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

  ctx.strokeStyle = "rgba(110,110,150,0.28)";
  ctx.lineWidth = lw;
  for (const latDeg of [0, 30, -30, 60, -60]) {
    const latRad = latDeg * Math.PI / 180;
    const ry = Math.cos(latRad) * r;
    ctx.beginPath();
    ctx.ellipse(cx, cy - Math.sin(latRad) * r, ry, ry * 0.22, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.ellipse(cx, cy, r * 0.22, r, 0, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();
  ctx.save();

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(140,140,180,0.6)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const az = light.azimuth   * Math.PI / 180;
  const el = light.elevation * Math.PI / 180;
  const dotX = cx + (r - 4) * Math.cos(el) * Math.sin(az);
  const dotY = cy + (r - 4) * Math.sin(el);

  const isBehind = Math.cos(el) * Math.cos(az) < 0;
  const alpha = isBehind ? "44" : "bb";

  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(dotX, dotY);
  ctx.strokeStyle = light.color + alpha;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const ch = r * 0.08;
  ctx.strokeStyle = "rgba(180,180,200,0.4)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(cx - ch, cy); ctx.lineTo(cx + ch, cy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx, cy - ch); ctx.lineTo(cx, cy + ch); ctx.stroke();

  ctx.beginPath();
  ctx.arc(dotX, dotY, 5, 0, Math.PI * 2);
  ctx.fillStyle = isBehind ? light.color + "55" : light.color;
  ctx.fill();
  ctx.strokeStyle = isBehind ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.9)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx - r * 0.32, cy - r * 0.38, r * 0.16, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.09)";
  ctx.fill();

  ctx.restore();
}

function renderFallback(ctx: CanvasRenderingContext2D, W: number, H: number) {
  ctx.fillStyle = "#111827";
  ctx.fillRect(0, 0, W, H);

  ctx.globalCompositeOperation = "screen";
  for (const light of lights.value) {
    if (light.type === "point") {
      const gx = light.x * W, gy = light.y * H;
      const gr = light.radius * W * Math.max(light.intensity, 0.1);
      const grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
      grad.addColorStop(0, light.color + "99");
      grad.addColorStop(1, "transparent");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    } else {
      const az = light.azimuth * Math.PI / 180;
      const el = light.elevation * Math.PI / 180;
      const elFactor = Math.sin(el);
      const sx = W / 2 - Math.sin(az) * W * 0.7;
      const sy = H / 2 + Math.cos(az) * H * 0.7;
      const ex = W / 2 + Math.sin(az) * W * 0.7;
      const ey = H / 2 - Math.cos(az) * H * 0.7;
      const grad = ctx.createLinearGradient(sx, sy, ex, ey);
      // elFactor = sin(elevation) is NEGATIVE for lights below the horizon
      // (e.g. -46°); Math.round(negative).toString(16) yields "-7a" → an invalid
      // color like "#ffffff-7a" that throws in addColorStop. Clamp to [0,255].
      const hex2 = (f: number) =>
        Math.max(0, Math.min(255, Math.round(f))).toString(16).padStart(2, "0");
      grad.addColorStop(0, light.color + hex2(elFactor * 0xaa));
      grad.addColorStop(0.5, light.color + hex2(elFactor * 0x44));
      grad.addColorStop(1, "transparent");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    }
  }
  ctx.globalCompositeOperation = "source-over";

  if (ambientIntensity.value > 0) {
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = ambientIntensity.value * 0.3;
    ctx.fillStyle = ambientColor.value;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }
}

// ── Pass data ingestion ────────────────────────────────────────────────────
function setPasses(data: PassData) {
  passW = data.width;
  passH = data.height;
  passAspect.value = passW / passH;
  hasPasses.value = true;
  if (popped.value) nextTick(measureFit);

  passRgb     = decodeB64(data.rgb);
  passNormals = decodeB64(data.normals);
  passDepth   = decodeB64(data.depth);
  passAlbedo  = data.albedo   ? decodeB64(data.albedo)   : null;
  passRoughness = data.roughness ? decodeB64(data.roughness) : null;
  passMasks     = data.masks     ? decodeB64(data.masks)     : null;
  maskSlots.value = Array.from({ length: MASK_SLOTS }, (_, k) => !!(passMasks && data.maskSlots?.[k]));

  hasAlbedo.value    = passAlbedo    !== null;
  hasRoughness.value = passRoughness !== null;

  // If WebGL context doesn't exist yet, init it now that we know the dimensions
  if (!glReady) {
    initWebGL(passW, passH);
  }
  texturesDirty = true;
  rimCache.clear();
  rimAtlasTiles = [];

  isProcessing.value = false;
  nextTick(drawPreview);
}

function decodeB64(b64: string): Uint8Array {
  const bin = atob(b64);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

// ── Serialisation ───────────────────────────────────────────────────────────
function serialise(): string {
  const state: State = {
    lights: lights.value,
    ambientIntensity: ambientIntensity.value,
    ambientColor: ambientColor.value,
    delitMix: delitMix.value,
    roughnessStrength: roughnessStrength.value,
    shadowsEnabled: shadowsEnabled.value,
    shadowStrength: shadowStrength.value,
    shadowSoftness: shadowSoftness.value,
    shadowRange: shadowRange.value,
    exposure: lookExposure.value,
    temperature: lookTemperature.value,
    tint: lookTint.value,
    saturation: lookSaturation.value,
    hazeAmount: hazeAmount.value,
    hazeColor: hazeColor.value,
    hazeStart: hazeStart.value,
    hazeEnd: hazeEnd.value,
    hazeLit: hazeLit.value,
  };
  return JSON.stringify(state);
}

function deserialise(json: string) {
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) {
      lights.value = parsed.map(normLight);
    } else {
      lights.value              = (parsed.lights ?? []).map(normLight);
      ambientIntensity.value    = parsed.ambientIntensity    ?? 0.2;
      ambientColor.value        = parsed.ambientColor        ?? "#ffffff";
      delitMix.value            = parsed.delitMix            ?? 0.0;
      roughnessStrength.value   = parsed.roughnessStrength   ?? 1.0;
      shadowsEnabled.value      = parsed.shadowsEnabled      ?? false;
      shadowStrength.value      = parsed.shadowStrength      ?? 0.6;
      shadowSoftness.value      = parsed.shadowSoftness      ?? 0.3;
      shadowRange.value         = parsed.shadowRange         ?? 0.15;
      lookExposure.value        = parsed.exposure            ?? 0.0;
      lookTemperature.value     = parsed.temperature         ?? 0.0;
      lookTint.value            = parsed.tint                ?? 0.0;
      lookSaturation.value      = parsed.saturation          ?? 1.0;
      hazeAmount.value          = parsed.hazeAmount          ?? 0.0;
      hazeColor.value           = parsed.hazeColor           ?? "#c8d0dc";
      hazeStart.value           = parsed.hazeStart           ?? 0.0;
      hazeEnd.value             = parsed.hazeEnd             ?? 1.0;
      hazeLit.value             = parsed.hazeLit             ?? 0.0;
    }
    nextTick(drawPreview);
  } catch {
    // ignore
  }
}

// ── Light dot visual style ────────────────────────────────────────────────
function dotStyle(light: Light) {
  const f = Math.min(light.z / 2, 1);
  const size = 10 + f * 16;
  const opacity = 0.35 + f * 0.65;
  const glow = 3 + f * 15;
  return {
    left:      light.x * 100 + '%',
    top:       light.y * 100 + '%',
    background: light.color,
    width:     size + 'px',
    height:    size + 'px',
    opacity,
    boxShadow: `0 0 ${glow}px ${light.color}`,
  };
}

function emit() {
  scheduleRedraw();
  props.onChange(serialise());
}

function setProcessing(val: boolean) {
  isProcessing.value = val;
}

defineExpose({ serialise, deserialise, setPasses, setProcessing, setPopped });

// The arcs and HUD are sized by displayed pixels, so a resize (window, modal, node) redraws.
let stageRO: ResizeObserver | null = null;
let wrapRO: ResizeObserver | null = null;
// Click a slider's readout to type an exact value. Delegated, so the ~30 readouts need no
// template change; the span stays (Vue owns it) and is hidden while an input sits beside it.
// The value goes through the range input's own `input` event, so v-model and emit() run as
// for a drag. step="any" for the write, or the range would snap what was typed.
function editReadout(e: MouseEvent) {
  const el = (e.target as HTMLElement).closest(".rl-fval") as HTMLElement | null;
  if (!el || el.classList.contains("rl-fval-wide") || el.nextElementSibling?.classList.contains("rl-fval-edit")) return;
  const rng = el.parentElement?.querySelector("input.rl-range") as HTMLInputElement | null;
  if (!rng || rng.disabled) return;
  const box = document.createElement("input");
  box.className = "rl-fval-edit";
  box.value = String(Math.round(parseFloat(rng.value) * 1e4) / 1e4);
  el.style.display = "none";
  el.after(box);
  box.focus(); box.select();
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return; done = true;
    const v = parseFloat(box.value.replace(",", "."));
    box.remove(); el.style.display = "";
    if (!commit || !isFinite(v)) return;
    const step = rng.step;
    rng.step = "any";
    rng.value = String(Math.min(+rng.max, Math.max(+rng.min, v)));
    rng.dispatchEvent(new Event("input", { bubbles: true }));
    rng.step = step;
  };
  box.addEventListener("keydown", (k) => {
    k.stopPropagation();  // W/R/Delete... are ComfyUI shortcuts
    if (k.key === "Enter") finish(true);
    else if (k.key === "Escape") { k.preventDefault(); finish(false); }
  });
  box.addEventListener("blur", () => finish(true));
}

onMounted(() => {
  rootEl.value?.addEventListener("click", editReadout);
  if (rootEl.value) detachFine = attachFineRange(rootEl.value);
  if (stageEl.value) { stageRO = new ResizeObserver(measureFit); stageRO.observe(stageEl.value); }
  if (canvasWrap.value) { wrapRO = new ResizeObserver(scheduleRedraw); wrapRO.observe(canvasWrap.value); }
  nextTick(drawPreview);
});

onUnmounted(() => {
  rootEl.value?.removeEventListener("click", editReadout);
  stageRO?.disconnect();
  wrapRO?.disconnect();
  detachFine?.();
  destroyWebGL();
  if (rafId !== null) cancelAnimationFrame(rafId);
});
</script>

<style scoped>
.rl-root {
  width: 100%;
  background: var(--comfy-menu-bg, #111827);
  border-radius: 8px;
  overflow: hidden;
  font-family: var(--font-family, "Inter", sans-serif);
  font-size: 12px;
  color: var(--fg-color, #e5e7eb);
  box-sizing: border-box;
}
/* Universal border-box inside the widget — prevents fixed-width children
   from overflowing the node and "bleeding" past its border. */
.rl-root, .rl-root * , .rl-root *::before, .rl-root *::after {
  box-sizing: border-box;
}

/* ── Tool row ──────────────────────────────────────────────────────────────── */
.rl-tools {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border-color, #374151);
}
.rl-tools-gap { flex: 1 1 auto; }
.rl-tool {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  font-size: 11px;
  border: 1px solid var(--border-color, #374151);
  border-radius: 5px;
  background: var(--comfy-input-bg, #1e293b);
  color: var(--input-text, #e5e7eb);
  cursor: pointer;
  user-select: none;
  touch-action: none;
}
.rl-tool .pi { font-size: 12px; }
.rl-tool:hover:not(:disabled) { border-color: var(--p-primary-color, #3b82f6); }
.rl-tool.on { border-color: var(--p-primary-color, #3b82f6); color: var(--p-primary-color, #3b82f6); }
.rl-tool:disabled { opacity: 0.4; cursor: default; }

/* ── Popped out: canvas left, every panel in a full-height sidebar ─────────── */
.rl-popped {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  grid-template-rows: auto minmax(0, 1fr);
  height: 100%;
  border-radius: 0;
}
.rl-popped .rl-tools { grid-column: 1; grid-row: 1; }
.rl-popped .rl-stage {
  grid-column: 1; grid-row: 2;
  display: flex; align-items: center; justify-content: center;
  min-width: 0; min-height: 0; overflow: hidden;
  background: #0b0d12;
}
.rl-popped .rl-canvas-wrap { flex: 0 0 auto; }
.rl-popped .rl-controls {
  grid-column: 2; grid-row: 1 / span 2;
  overflow-y: auto;
  border-left: 1px solid var(--border-color, #374151);
}
.rl-canvas-wrap.comparing .rl-light-dot { opacity: 0 !important; }

.rl-fval { cursor: text; }
.rl-fval-wide { cursor: default; }
.rl-root :deep(.rl-fval-edit) {
  width: 46px; padding: 0 3px; font: inherit; text-align: right;
  background: var(--comfy-input-bg, #1e293b); color: var(--input-text, #e5e7eb);
  border: 1px solid var(--p-primary-color, #3b82f6); border-radius: 3px; outline: none;
}

.rl-hint { font-size: 10px; color: var(--descrip-text, #9ca3af); padding: 2px 0; }

.rl-subhead {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--descrip-text, #9ca3af);
}

.rl-canvas-wrap {
  position: relative;
  width: 100%;
  background: #0f172a;
  overflow: hidden;
  cursor: crosshair;
}

.rl-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
.rl-overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.rl-light-dot {
  position: absolute;
  border-radius: 50%;
  border: 2px solid #555;
  transform: translate(-50%, -50%);
  cursor: move;
  pointer-events: auto;
  transition: border-color 0.15s;
}
.rl-light-dot.selected { border-color: #fff; }

.rl-controls {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

/* ── Light add buttons ─────────────────────────────────────────────────────── */
.rl-btnbar {
  display: flex;
  gap: 6px;
  min-width: 0;
}
.rl-btn {
  flex: 1 1 0;
  min-width: 0;
  padding: 5px 6px;
  font-size: 11px;
  border: 1px solid var(--border-color, #374151);
  border-radius: 5px;
  background: var(--comfy-input-bg, #1e293b);
  color: var(--input-text, #e5e7eb);
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
}
.rl-btn:hover:not(:disabled) { border-color: var(--p-primary-color, #3b82f6); }
.rl-btn:disabled { opacity: 0.4; cursor: default; }
.rl-btn-ghost { background: transparent; }

/* ── Collapsible sections ──────────────────────────────────────────────────── */
.rl-section {
  flex-shrink: 0;  /* overflow:hidden lets a flex item shrink to nothing in the popped sidebar */
  border: 1px solid var(--border-color, #374151);
  border-radius: 6px;
  background: var(--comfy-menu-bg, #1f2937);
  overflow: hidden;
  min-width: 0;
}
.rl-light.selected { border-color: var(--p-primary-color, #3b82f6); }

.rl-sec-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  cursor: pointer;
  user-select: none;
  min-width: 0;
}
.rl-sec-head:hover { background: rgba(127, 127, 127, 0.08); }

.rl-chev {
  flex-shrink: 0;
  font-size: 9px;
  color: var(--descrip-text, #9ca3af);
  transition: transform 0.15s;
}
.rl-chev.open { transform: rotate(90deg); }

.rl-light-icon { flex-shrink: 0; font-size: 12px; color: var(--descrip-text, #9ca3af); }
.rl-select {
  flex: 1 1 0;
  min-width: 0;
  height: 20px;
  padding: 0 4px;
  font-size: 10px;
  color: var(--input-text, #cbd5e1);
  background: var(--comfy-input-bg, #374151);
  border: 1px solid var(--border-color, #374151);
  border-radius: 4px;
}
.rl-check {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--descrip-text, #9ca3af);
  cursor: pointer;
}
.rl-check.disabled { opacity: 0.45; cursor: default; }
.rl-check input { margin: 0; }
.rl-fval-wide { width: auto; text-align: left; white-space: nowrap; }

.rl-sec-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  color: var(--fg-color, #e5e7eb);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rl-sec-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 7px 8px 8px;
  border-top: 1px solid var(--border-color, #374151);
  min-width: 0;
}
.rl-sec-body.disabled { opacity: 0.45; }

/* ── Slider field row (ComfyUI-style) ──────────────────────────────────────── */
.rl-field {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.rl-flabel {
  flex-shrink: 0;
  width: 62px;
  font-size: 10px;
  color: var(--descrip-text, #9ca3af);
}
.rl-fval {
  flex-shrink: 0;
  width: 38px;
  text-align: right;
  font-size: 10px;
  color: var(--fg-color, #cbd5e1);
  font-variant-numeric: tabular-nums;
}

/* Range: thin filled track + small thumb, themed to ComfyUI */
.rl-range {
  flex: 1 1 auto;
  min-width: 0;
  height: 14px;
  margin: 0;
  background: transparent;
  cursor: pointer;
  -webkit-appearance: none;
  appearance: none;
}
.rl-range:disabled { cursor: default; }
/* WebKit / Chromium (ComfyUI desktop): fill via --rl-fill gradient on the track */
.rl-range::-webkit-slider-runnable-track {
  height: 5px;
  border-radius: 3px;
  background: linear-gradient(
    to right,
    var(--p-primary-color, #3b82f6) 0 var(--rl-fill, 0%),
    var(--comfy-input-bg, #0f172a) var(--rl-fill, 0%) 100%
  );
}
.rl-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  margin-top: -4px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--fg-color, #e5e7eb);
  border: 1px solid var(--border-color, #1f2937);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
}
/* Firefox: native progress fill */
.rl-range::-moz-range-track {
  height: 5px;
  border-radius: 3px;
  background: var(--comfy-input-bg, #0f172a);
}
.rl-range::-moz-range-progress {
  height: 5px;
  border-radius: 3px;
  background: var(--p-primary-color, #3b82f6);
}
.rl-range::-moz-range-thumb {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--fg-color, #e5e7eb);
  border: 1px solid var(--border-color, #1f2937);
}

/* ── Color swatch ──────────────────────────────────────────────────────────── */
.rl-swatch {
  flex-shrink: 0;
  width: 22px;
  height: 18px;
  padding: 0;
  border: 1px solid var(--border-color, #374151);
  border-radius: 4px;
  background: none;
  cursor: pointer;
}
.rl-swatch::-webkit-color-swatch-wrapper { padding: 0; }
.rl-swatch::-webkit-color-swatch { border: none; border-radius: 3px; }

/* ── Remove (×) button ─────────────────────────────────────────────────────── */
.rl-x {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--descrip-text, #9ca3af);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.rl-x:hover { background: var(--error-text, #b91c1c); color: #fff; }

/* ── Toggle switch ─────────────────────────────────────────────────────────── */
.rl-switch {
  position: relative;
  flex-shrink: 0;
  width: 30px;
  height: 16px;
  cursor: pointer;
}
.rl-switch input {
  position: absolute;
  inset: 0;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
.rl-switch-track {
  display: block;
  width: 30px;
  height: 16px;
  border-radius: 8px;
  background: var(--comfy-input-bg, #374151);
  transition: background 0.15s;
}
.rl-switch-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--fg-color, #e5e7eb);
  transition: left 0.15s;
}
.rl-switch input:checked + .rl-switch-track { background: var(--p-primary-color, #2563eb); }
.rl-switch input:checked + .rl-switch-track .rl-switch-thumb { left: 16px; }

/* ── Processing overlay ──────────────────────────────────────────────────── */
.rl-processing-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  pointer-events: none;
  z-index: 10;
}

.rl-processing-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(15, 23, 42, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  padding: 10px 18px;
}

.rl-processing-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #60a5fa;
  animation: rl-bounce 1.1s ease-in-out infinite;
}
.rl-processing-dot:nth-child(2) { animation-delay: 0.18s; }
.rl-processing-dot:nth-child(3) { animation-delay: 0.36s; }

@keyframes rl-bounce {
  0%, 80%, 100% { transform: scale(0.7); opacity: 0.4; }
  40%           { transform: scale(1.15); opacity: 1; }
}

/* Fade transition */
.rl-fade-enter-active, .rl-fade-leave-active { transition: opacity 0.18s ease; }
.rl-fade-enter-from,  .rl-fade-leave-to      { opacity: 0; }
</style>
