import sitemap from "@astrojs/sitemap";
import { defineConfig, fontProviders } from "astro/config";

// Self-hosted at build time, with metric-matched fallbacks. Science Gothic is only ever set at 600,
// so it is requested at that one weight across the width axis it uses (100% to 125%).
export default defineConfig({
  site: "https://bounda.dev",
  // Every link on the page leaves the site (docs, demo, GitHub), so there is nothing to prefetch.
  prefetch: false,
  // The site is rebuilt on every push, so the build is the last change.
  integrations: [sitemap({ lastmod: new Date() })],
  build: {
    inlineStylesheets: "always",
  },
  vite: {
    // three.js is one chunk, run in a worker where the browser allows it (see src/scripts/landing/scene-client.ts).
    build: { chunkSizeWarningLimit: 650 },
    // The scene imports three.js dynamically, so the dev server would only find it on first use,
    // re-optimize, and fail that import as an outdated dependency. Pre-bundle it from the start.
    optimizeDeps: { include: ["three", "three/addons/geometries/RoundedBoxGeometry.js"] },
  },
  fonts: [
    {
      provider: fontProviders.google(),
      name: "Science Gothic",
      cssVariable: "--font-science-gothic",
      weights: [600],
      styles: ["normal"],
      fallbacks: ["sans-serif"],
      options: { experimental: { variableAxis: { wdth: [["100", "125"]] } } },
    },
    {
      provider: fontProviders.google(),
      name: "IBM Plex Sans",
      cssVariable: "--font-ibm-plex-sans",
      weights: ["400 600"],
      styles: ["normal"],
      fallbacks: ["sans-serif"],
    },
    {
      provider: fontProviders.google(),
      name: "Red Hat Mono",
      cssVariable: "--font-red-hat-mono",
      weights: ["400 600"],
      styles: ["normal"],
      fallbacks: ["monospace"],
    },
  ],
});
