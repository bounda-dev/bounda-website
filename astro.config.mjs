import sitemap from "@astrojs/sitemap";
import { defineConfig, fontProviders } from "astro/config";

// Self-hosted at build time, with metric-matched fallbacks. Science Gothic is only ever set at 600,
// so it is requested at that one weight across the width axis it uses (100% to 125%).
export default defineConfig({
  site: "https://bounda.dev",
  prefetch: true,
  integrations: [sitemap()],
  build: {
    inlineStylesheets: "always",
  },
  vite: {
    // three.js is one chunk, loaded after first paint and only where WebGL 2 is available.
    build: { chunkSizeWarningLimit: 650 },
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
