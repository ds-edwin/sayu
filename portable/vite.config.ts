import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({
  base: "./",
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: false,
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("..", import.meta.url)) } },
  build: {
    outDir: "../portable-dist",
    emptyOutDir: true,
    assetsDir: "pwa-assets",
  },
});
