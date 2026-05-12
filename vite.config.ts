/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    // Service worker for offline play. The strategy is:
    //   • App shell (HTML/JS/CSS chunks) — Workbox precaches everything in
    //     the build output so the app boots offline.
    //   • Card dataset — same precache; sized small enough that this is OK.
    //   • Card images — runtime CacheFirst against Limitless's CDN. First
    //     view of each card primes the cache; subsequent loads work offline.
    //   • localStorage / IndexedDB persistence is unaffected (it's outside
    //     the SW lifecycle).
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      manifest: false, // we ship our own manifest.webmanifest in /public.
      workbox: {
        // The dataset chunk is ~1.5MB; lift the default 2MB cap so it gets
        // precached. Anything bigger should be runtime-cached, not precached.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        globPatterns: ["**/*.{js,css,html,svg,webmanifest,json}"],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/limitlesstcg\.nyc3\.cdn\.digitaloceanspaces\.com\/.*\.png$/,
            handler: "CacheFirst",
            options: {
              cacheName: "card-images",
              expiration: {
                maxEntries: 3000, // ~bigger than the legal pool to catch all
                maxAgeSeconds: 60 * 60 * 24 * 90, // 90 days
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        enabled: false, // SW only in production builds; dev hot-reload stays clean.
      },
    }),
  ],
  server: { port: 5173 },
  build: {
    rollupOptions: {
      output: {
        // Split React + the engine into stable chunks so deploys that touch
        // only UI code don't bust the cache for the heavy engine bundle.
        // (DeckBuilderModal is already lazy-loaded via React.lazy.)
        manualChunks(id: string) {
          if (id.includes("node_modules/react/") ||
              id.includes("node_modules/react-dom/") ||
              id.includes("node_modules/scheduler/")) {
            return "vendor-react";
          }
          if (id.includes("/src/engine/")) {
            return "engine";
          }
        },
      },
    },
  },
  test: {
    setupFiles: ["./src/test-setup.ts"],
    // Playwright e2e specs live under /e2e and need a real browser; vitest
    // would try (and fail) to import @playwright/test in node mode.
    exclude: ["**/node_modules/**", "**/dist/**", "**/e2e/**"],
  },
});
