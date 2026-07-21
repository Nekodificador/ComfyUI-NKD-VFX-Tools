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
  plugins: [vue(), cssInjectedByJs({ topExecutionPriority: false })],

  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },

  build: {
    rollupOptions: {
      input: {
        relighting_widget: "./src/main.ts",
        lens_blur_widget:  "./src/lens_blur_main.ts",
        fspy_camera_widget: "./src/fspy_main.ts",
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
    cssCodeSplit: false,
  },

  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});
