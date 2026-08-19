import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import cssInjectedByJs from "vite-plugin-css-injected-by-js";

/**
 * Vite config for ComfyUI-NKD-VFX-Tools.
 *
 * Builds the Vue widgets into web/js/:
 *   relighting_widget.js   — interactive relighting node
 *   lens_blur_widget.js    — depth-guided lens blur node
 *   fspy_camera_widget.js  — fSpy vanishing-line camera solver node
 *
 * ComfyUI scripts (app.js, api.js) are external — resolved at runtime.
 * Using rollupOptions.input directly instead of lib to support multiple entries.
 */
export default defineConfig({
  plugins: [
    vue(),
    // relativeCSSInjection puts each chunk's CSS INSIDE that chunk. Without it
    // the plugin picks one entry to host the whole pack's CSS, so a component
    // and the stylesheet that scopes it can come from different builds — and a
    // Vue scope id changes with the component's source, so every scoped rule
    // then silently stops matching. That is what rendered Preview 3D completely
    // unstyled. Needs build.cssCodeSplit: true to have per-chunk CSS to place.
    cssInjectedByJs({ topExecutionPriority: false, relativeCSSInjection: true }),
  ],

  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },

  build: {
    // web/js also holds a hand-written extension (perspective_dewarp_widget.js) that
    // is NOT a Vite entry. emptyOutDir defaults to true here (outDir is inside root),
    // which wipes that file on every build — that is how it was lost once already.
    emptyOutDir: false,
    rollupOptions: {
      // nkd_modal.js is imported at RUNTIME by the hand-written
      // perspective_dewarp_widget.js, which Rollup cannot see. Without this it
      // tree-shakes every export no in-build entry happens to use and mangles
      // the survivors (measured: the whole module collapsed to `export{w as o}`),
      // so the vanilla editor dies on import.
      preserveEntrySignatures: "strict",
      input: {
        // Shared editor-modal chrome. Its own entry so the hand-written
        // perspective_dewarp_widget.js can `import` it at runtime; the Vue
        // entries import the TS source and inline their own copy.
        nkd_modal:         "./src/nkd_modal.ts",
        // Own entry so `node test_plumbline.mjs` can import and assert on it.
        nkd_plumbline:     "./src/plumbline.ts",
        // Likewise: the Preview 3D depth-range geometry, importable on its own so it can be
        // asserted against outside a browser.
        nkd_depth_range:   "./src/depth_range.ts",
        nkd_pivot:         "./src/pivot.ts",
        nkd_view_gizmo:    "./src/view_gizmo.ts",
        // Likewise: the position-weld normal smoothing, so `node test_autosmooth.mjs` asserts on
        // the SHIPPED function instead of a re-implementation of it.
        nkd_smooth_normals: "./src/smooth_normals.ts",
        // Likewise: the fSpy solver + VP-moving geometry, so `node test_vp_slide.mjs`
        // asserts on the shipped code instead of a copy of it.
        nkd_solver:        "./src/solver.ts",
        // Likewise: the Shift fine-adjust drag, so `node test_fine_drag.mjs` asserts on
        // the shipped one. As an internal chunk its filename carries a content hash,
        // which is not something a test can import by name.
        nkd_fine_drag:     "./src/fine_drag.ts",
        relighting_widget: "./src/main.ts",
        lens_blur_widget:  "./src/lens_blur_main.ts",
        fspy_camera_widget: "./src/fspy_main.ts",
        lens_distort_widget: "./src/lens_distort_main.ts",
        preview3d_widget:  "./src/preview3d_main.ts",
      },
      external: [
        "../../scripts/app.js",
        "../../scripts/api.js",
      ],
      output: {
        dir:            "web/js",
        entryFileNames: "[name].js",
        assetFileNames: "assets/[name].[ext]",
        format:         "es",
      },
    },
    sourcemap: false,
    minify: true,
    // TRUE, not false. With false the whole pack's CSS is bundled once and
    // vite-plugin-css-injected-by-js drops it into ONE entry of its choosing —
    // and which entry it picks can change between builds. Vue scope ids change
    // whenever a component's source does, so the moment the stylesheet and the
    // component chunk come from different builds (a browser cache miss on one
    // of them, an orphaned chunk left behind by emptyOutDir:false) every scoped
    // rule stops matching and the widget renders completely unstyled — measured:
    // CSS targeting [data-v-430487f1] against a DOM built by [data-v-178b1930].
    // Split makes each chunk carry its own CSS, so they cannot desync.
    cssCodeSplit: true,
  },

  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});
