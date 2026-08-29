import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  clearScreen: false,
  // Versao embutida no bundle: evita depender de permissao do Tauri so para exibir.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: { port: 5173, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2022",
    minify: "esbuild",
    sourcemap: false,
    // Tres paginas: a principal e as janelas separadas de cameras e de telas.
    rollupOptions: { input: { main: "index.html", cameras: "cameras.html", telas: "telas.html" } }
  }
});

