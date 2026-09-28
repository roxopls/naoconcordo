// Sessao sobrevive a reinicio do servidor, e "Manter conectado" estica o prazo.
//
// Roda sozinha, fora do `test-isolated`, porque precisa derrubar e subir o
// backend no meio: `node tests/test-sessao-reinicio.mjs`. Mesma pasta
// temporaria e mesmo `TEST_SERVER_BIN` do executor comum.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const aqui = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const raiz = path.resolve(aqui, "..");
const binario = process.env.TEST_SERVER_BIN
  || path.join(raiz, "server", "target", "debug", process.platform === "win32" ? "naoconcordo-server.exe" : "naoconcordo-server");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "naoconcordo-sessao-"));
const dataDir = path.join(base, "data");
for (const dir of ["data", "uploads", "uploads-fallback"]) fs.mkdirSync(path.join(base, dir), { recursive: true });
const segredo = () => crypto.randomBytes(24).toString("base64url");
const ambiente = {
  ACCESS_PASSWORD: segredo(), OWNER_PASSWORD: segredo(), AUTH_SALT: segredo(), ADMIN_USERNAME: "admin",
  LIVEKIT_API_KEY: "teste", LIVEKIT_API_SECRET: segredo(), LIVEKIT_PUBLIC_URL: "ws://127.0.0.1:7880",
  DATA_DIR: dataDir, UPLOAD_DIR: path.join(base, "uploads"), UPLOAD_FALLBACK_DIR: path.join(base, "uploads-fallback"),
  UPLOAD_PRIMARY_CAP_GB: "1",
};
const api = "http://127.0.0.1:3040";
const json = { "content-type": "application/json" };
const post = (caminho, corpo, token) => fetch(api + caminho, { method: "POST", headers: token ? { ...json, authorization: "Bearer " + token } : json, body: JSON.stringify(corpo) });
const sessao = token => fetch(api + "/api/session", { headers: { authorization: "Bearer " + token } });
const prova = (chave, nonce, nome) => crypto.createHmac("sha256", chave).update(nonce + ":" + nome).digest("base64url");
const SENHA = "SenhaTeste12345";

let servidor = null;
async function subir() {
  servidor = spawn(binario, { env: { ...process.env, ...ambiente }, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(api + "/health")).ok) return; } catch { /* subindo */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error("backend nao subiu");
}
async function derrubar() {
  const fim = new Promise(r => servidor.once("exit", r));
  servidor.kill();
  await fim;
}

const resultados = {};
function check(nome, condicao, detalhe = "") {
  resultados[nome] = Boolean(condicao);
  if (!condicao) throw new Error("falhou: " + nome + (detalhe ? " -> " + detalhe : ""));
}

async function desafio(nome) { return (await post("/api/auth/challenge", { username: nome })).json(); }
async function entrar(nome, lembrar) {
  const d = await desafio(nome);
  const verificador = crypto.pbkdf2Sync(SENHA, d.passwordSalt, d.passwordIterations, 32, "sha256");
  const corpo = { username: nome, nonce: d.nonce, proof: prova(verificador, d.nonce, nome) };
  if (lembrar !== undefined) corpo.lembrar = lembrar;
  const resposta = await post("/api/auth/login", corpo);
  if (!resposta.ok) throw new Error("login: " + await resposta.text());
  return resposta.json();
}

try {
  await subir();
  // Primeira conta nasce da chave global de acesso.
  const d = await desafio("admin");
  const convite = crypto.pbkdf2Sync(ambiente.ACCESS_PASSWORD, d.inviteSalt, d.inviteIterations, 32, "sha256");
  const verificador = crypto.pbkdf2Sync(SENHA, d.passwordSalt, d.passwordIterations, 32, "sha256");
  const recuperacao = crypto.pbkdf2Sync("recuperacao", d.recoverySalt, d.passwordIterations, 32, "sha256");
  const cadastro = await post("/api/auth/register", {
    username: "admin", nonce: d.nonce, inviteProof: prova(convite, d.nonce, "admin"),
    verifier: Buffer.from(verificador).toString("base64url"), recoveryVerifier: Buffer.from(recuperacao).toString("base64url"),
  });
  check("cadastro", cadastro.ok);

  const agora = Date.now() / 1000;
  const lembrada = await entrar("admin", true);
  const curta = await entrar("admin", false);
  const antiga = await entrar("admin");
  check("lembrar dura ~90 dias", lembrada.expiresAt - agora > 89 * 86400, String(lembrada.expiresAt - agora));
  check("sem lembrar dura ~7 dias", curta.expiresAt - agora < 8 * 86400 && curta.expiresAt - agora > 6 * 86400);
  check("cliente antigo (sem campo) dura ~7 dias", antiga.expiresAt - agora < 8 * 86400);

  const arquivo = fs.readFileSync(path.join(dataDir, "sessions.json"), "utf8");
  check("token nao aparece no disco", ![lembrada.token, curta.token, antiga.token].some(t => arquivo.includes(t)));

  check("sair antes do reinicio", (await post("/api/logout", {}, curta.token)).status === 204);

  await derrubar();
  await subir();

  check("sessao lembrada vale apos reinicio", (await sessao(lembrada.token)).status === 200);
  check("sessao de cliente antigo vale apos reinicio", (await sessao(antiga.token)).status === 200);
  check("sessao encerrada continua encerrada", (await sessao(curta.token)).status === 401);
  check("token inventado recusado", (await sessao("x".repeat(43))).status === 401);

  const ws = new WebSocket(api.replace(/^http/, "ws") + "/ws?token=" + encodeURIComponent(lembrada.token));
  const abriu = await new Promise(r => { ws.onopen = () => r(true); ws.onerror = () => r(false); setTimeout(() => r(false), 5000); });
  ws.close();
  check("websocket aceita sessao restaurada", abriu);

  console.log(JSON.stringify(resultados, null, 2));
} finally {
  if (servidor) servidor.kill();
}
