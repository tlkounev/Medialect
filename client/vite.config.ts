import { defineConfig } from "vite";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  clearScreen: false,
  define: { __APP_VERSION__: JSON.stringify(process.env.APP_VERSION || pkg.version) },
  server: { port: 1420, strictPort: true },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
  test: { environment: "node", include: ["test/**/*.test.ts"], testTimeout: 30000 },
});
