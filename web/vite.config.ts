import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const hub = process.env.CROSSTALK_DEV_HUB || "http://127.0.0.1:7420";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    port: 5180,
    strictPort: true,
    host: "127.0.0.1",
    // Browser tests (CROSSTALK_WEB_NO_WATCH=1 in playwright.config.ts) hold the tree still: a file saved while the
    // suite runs would reload the page under a test, and from then on the dev server serves the app
    // "/src/store.ts?t=…", so a test's own `import("/src/store.ts")` is a second copy of the store with none of the
    // app's state. Only the test run stops watching; `bun run dev` by hand keeps its live reload.
    watch: process.env.CROSSTALK_WEB_NO_WATCH ? { ignored: ["**/*"] } : undefined,
    proxy: {
      "/api": { target: hub, ws: true, changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          xterm: ["@xterm/xterm", "@xterm/addon-fit"],
          markdown: ["react-markdown", "remark-gfm"],
        },
      },
    },
  },
});
