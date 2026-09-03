// Sobe um backend proprio numa pasta temporaria e roda as suites contra ele.
// Nenhum dado de producao e tocado: DATA_DIR e uploads ficam no temporario.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const aqui = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
// As suites vivem em `tests/`; o servidor e a configuracao ficam um nivel acima.
const raiz = path.resolve(aqui, "..");
// `TEST_SERVER_BIN` existe porque compartilhamento de rede no Windows nao
// deixa executar o que esta guardado nele: quem trabalha com o projeto num
// disco de rede compila para um caminho local e aponta para la.
const binario = process.env.TEST_SERVER_BIN
  || path.join(raiz, "server", "target", "debug", process.platform === "win32" ? "naoconcordo-server.exe" : "naoconcordo-server");
if (!fs.existsSync(binario)) {
  console.error("binario ausente: rode `cargo build` em server/ antes.\n" + binario);
  process.exit(2);
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), "naoconcordo-teste-"));
const dataDir = path.join(base, "data");
const uploadDir = path.join(base, "uploads");
const fallbackDir = path.join(base, "uploads-fallback");
for (const dir of [dataDir, uploadDir, fallbackDir]) fs.mkdirSync(dir, { recursive: true });

const segredo = () => crypto.randomBytes(24).toString("base64url");
const ambiente = {
  ACCESS_PASSWORD: segredo(),
  OWNER_PASSWORD: segredo(),
  AUTH_SALT: segredo(),
  ADMIN_USERNAME: "admin",
  LIVEKIT_API_KEY: "teste",
  LIVEKIT_API_SECRET: segredo(),
  LIVEKIT_PUBLIC_URL: "ws://127.0.0.1:7880",
  DATA_DIR: dataDir,
  UPLOAD_DIR: uploadDir,
  UPLOAD_FALLBACK_DIR: fallbackDir,
  UPLOAD_PRIMARY_CAP_GB: "1",
};
const envFile = path.join(base, "test.env");
fs.writeFileSync(envFile, Object.entries(ambiente).map(([chave, valor]) => chave + "=" + valor).join("\n"));

const api = process.env.TEST_API || "http://127.0.0.1:3040";
const servidor = spawn(binario, { env: { ...process.env, ...ambiente }, stdio: ["ignore", "pipe", "pipe"] });
let saida = "";
servidor.stdout.on("data", pedaco => { saida += pedaco; });
servidor.stderr.on("data", pedaco => { saida += pedaco; });
servidor.on("exit", codigo => { if (codigo !== null && codigo !== 0) console.error("servidor saiu com codigo " + codigo + "\n" + saida); });

async function esperarSaude() {
  for (let tentativa = 0; tentativa < 60; tentativa++) {
    try { if ((await fetch(api + "/health")).ok) return true; } catch { /* ainda subindo */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

function rodar(suite) {
  return new Promise(resolve => {
    const filho = spawn(process.execPath, [path.join(aqui, suite)], {
      env: { ...process.env, TEST_ENV: envFile, TEST_API: api, TEST_DATA_DIR: dataDir, TEST_ADMIN: ambiente.ADMIN_USERNAME },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let texto = "";
    filho.stdout.on("data", pedaco => { texto += pedaco; });
    filho.stderr.on("data", pedaco => { texto += pedaco; });
    filho.on("exit", codigo => resolve({ suite, codigo, texto }));
  });
}

const suites = process.argv.slice(2).length ? process.argv.slice(2)
  : ["test-invites.mjs", "test-account.mjs", "test-friends.mjs", "test-servers.mjs", "test-files.mjs", "test-messages.mjs", "test-cofre.mjs", "test-updates.mjs", "test-link-arquivo.mjs", "test-identidade.mjs", "test-gifs.mjs", "test-preferencias.mjs", "test-categorias.mjs"];

if (!await esperarSaude()) {
  console.error("backend nao respondeu em /health\n" + saida);
  servidor.kill();
  process.exit(2);
}
console.log("instancia isolada em " + base);

let falhou = false;
for (const suite of suites) {
  const resultado = await rodar(suite);
  let verificacoes = 0;
  try { verificacoes = Object.keys(JSON.parse(resultado.texto.slice(resultado.texto.indexOf("{")))).length; } catch { /* sem JSON */ }
  if (resultado.codigo === 0) console.log("OK   " + suite + " (" + verificacoes + " verificacoes)");
  else { falhou = true; console.log("FALHA " + suite + "\n" + resultado.texto.trim()); }
}

servidor.kill();
console.log(falhou ? "\nsuites com falha" : "\ntodas as suites passaram");
process.exit(falhou ? 1 : 0);
