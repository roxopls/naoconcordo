// O `tsc` so cuida do TypeScript; o HTML e o CSS vao para `dist` na mao.
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
copyFileSync("index.html", "dist/index.html");
copyFileSync("src/estilo.css", "dist/estilo.css");
console.log("estaticos copiados para dist/");
