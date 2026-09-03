import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  clearScreen: false,
  // Caminhos relativos nos arquivos gerados.
  //
  // A versao web nao e servida na raiz do dominio: ela mora em `/app/`. Com o
  // padrao do vite (`base: "/"`), o HTML sai pedindo `/assets/...` e o navegador
  // procura na raiz, onde nao ha nada — nem CSS nem JavaScript carregam, e a
  // pagina aparece como texto cru com todas as secoes visiveis ao mesmo tempo.
  //
  // Isto ja era passado na linha de comando por quem gerava a versao web. Fica
  // aqui porque linha de comando se esquece: eu esqueci.
  base: "./",
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

