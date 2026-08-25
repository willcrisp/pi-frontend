// Build config for the Android app.
//
// Same plugins and the same dev proxy as the desktop build — only the entry
// document and the output directory differ. `dist-mobile/` is what Capacitor
// copies into the APK (see capacitor.config.json's webDir), kept separate from
// `dist/` so building one never clobbers the other.
import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config.js";

// In the APK the app is served at `/` (the build renames mobile.html to
// index.html — see scripts/mobile-index.mjs). Vite's dev server would otherwise
// serve the desktop index.html there and the mobile entry at /mobile.html, so
// `npm run dev:mobile` would be testing a different URL shape than the device
// runs. Rewriting here keeps the two the same.
function mobileIndex() {
  return {
    name: "mobile-index",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === "/" || req.url.startsWith("/?")) req.url = "/mobile.html";
        next();
      });
    },
  };
}

export default mergeConfig(base, {
  plugins: [mobileIndex()],
  build: {
    outDir: "dist-mobile",
    rollupOptions: { input: "mobile.html" },
  },
  server: { port: 5174, strictPort: true },
});
