// Base compartilhada das suites: sessao, convites e utilitarios de rede.
// Depois que o cadastro passou a exigir convite de uso unico, cada suite
// precisa de um admin para emitir codigos; centralizar isso evita repetir a
// mesma dança de PBKDF2 em cinco arquivos.
import fs from "node:fs";
import crypto from "node:crypto";

const envFile = process.env.TEST_ENV || new URL("../infra/.env", import.meta.url);
export const env = Object.fromEntries(
  fs.readFileSync(envFile, "utf8").trim().split(/\r?\n/)
    .filter(line => line && !line.startsWith("#"))
    .map(line => line.split(/=(.*)/s).slice(0, 2)),
);
export const api = process.env.TEST_API || "http://127.0.0.1:3040";
export const wsBase = api.replace(/^http/, "ws");
export const dataDir = process.env.TEST_DATA_DIR || "";
const adminName = process.env.TEST_ADMIN || env.ADMIN_USERNAME || "admin";
const SENHA = "SenhaTeste12345";
const RECUPERACAO = "recuperacao";

const json = { "content-type": "application/json" };
export const b64 = value => Buffer.from(value).toString("base64url");
export const call = (method, path, body, token) => fetch(api + path, {
  method,
  headers: token ? { ...json, authorization: "Bearer " + token } : json,
  body: body === undefined ? undefined : JSON.stringify(body),
});
export const post = (path, body, token) => call("POST", path, body, token);
export const get = (path, token) => call("GET", path, undefined, token);
export const put = (path, body, token) => call("PUT", path, body, token);
export const del = (path, token) => call("DELETE", path, undefined, token);

export const results = {};
export function check(name, condition, detail = "") {
  results[name] = Boolean(condition);
  if (!condition) throw new Error("falhou: " + name + (detail ? " -> " + detail : ""));
}
export function report() { console.log(JSON.stringify(results, null, 2)); }

const proof = (key, nonce, username) => crypto.createHmac("sha256", key).update(nonce + ":" + username).digest("base64url");

async function challengeFor(username) {
  const response = await post("/api/auth/challenge", { username });
  if (!response.ok) throw new Error("challenge: " + await response.text());
  return response.json();
}

/// Cadastra uma conta com o codigo dado. Sem codigo, usa a chave global de
/// acesso, que o servidor so aceita enquanto nao existe nenhuma conta.
export async function register(username, code) {
  const challenge = await challengeFor(username);
  const inviteKey = crypto.pbkdf2Sync(code ?? env.ACCESS_PASSWORD, challenge.inviteSalt, challenge.inviteIterations, 32, "sha256");
  const verifier = crypto.pbkdf2Sync(SENHA, challenge.passwordSalt, challenge.passwordIterations, 32, "sha256");
  const recovery = crypto.pbkdf2Sync(RECUPERACAO, challenge.recoverySalt, challenge.passwordIterations, 32, "sha256");
  const response = await post("/api/auth/register", {
    username, nonce: challenge.nonce, inviteProof: proof(inviteKey, challenge.nonce, username),
    verifier: b64(verifier), recoveryVerifier: b64(recovery),
  });
  return response;
}

export async function login(username, senha = SENHA) {
  const challenge = await challengeFor(username);
  const verifier = crypto.pbkdf2Sync(senha, challenge.passwordSalt, challenge.passwordIterations, 32, "sha256");
  const response = await post("/api/auth/login", {
    username, nonce: challenge.nonce, proof: proof(verifier, challenge.nonce, username),
  });
  if (!response.ok) throw new Error("login " + username + ": " + await response.text());
  return response.json();
}

let adminSession = null;
/// Sessao do admin. Na primeira instalacao ele nasce da chave global; nas
/// execucoes seguintes, contra a mesma instancia, so entra.
export async function admin() {
  if (adminSession) return adminSession;
  const response = await register(adminName, null);
  if (response.ok) adminSession = { username: adminName, ...await response.json() };
  else if (response.status === 409) adminSession = { username: adminName, ...await login(adminName) };
  else throw new Error("admin: " + await response.text());
  return adminSession;
}

export async function mintInvite(label = "teste") {
  const dono = await admin();
  const response = await post("/api/admin/invites", { label }, dono.token);
  if (!response.ok) throw new Error("convite: " + await response.text());
  return response.json();
}

/// Cria uma conta nova consumindo um convite recem-emitido.
export async function createUser(label) {
  const username = label + "-" + Date.now().toString(36) + crypto.randomBytes(2).toString("hex");
  const invite = await mintInvite(label);
  const response = await register(username, invite.code);
  if (!response.ok) throw new Error("register " + label + ": " + await response.text());
  return { username, code: invite.code, ...await response.json() };
}

/// Convidar deixou de colocar a pessoa dentro do servidor: agora fica um
/// convite pendente. Este atalho faz os dois passos para as suites que so
/// precisam de alguem la dentro.
export async function entrarNoServidor(serverId, quemConvida, convidado) {
  const convite = await post("/api/servers/members/add", { serverId, username: convidado.username }, quemConvida.token);
  if (convite.status !== 204) throw new Error("convidar: " + convite.status + " " + await convite.text());
  const lista = await (await get("/api/servers/invites", convidado.token)).json();
  const pendente = lista.invites.find(item => item.serverId === serverId);
  if (!pendente) throw new Error("convite nao chegou para " + convidado.username);
  const aceite = await post("/api/servers/invites/accept", { inviteId: pendente.id }, convidado.token);
  if (aceite.status !== 204) throw new Error("aceitar: " + aceite.status + " " + await aceite.text());
  return pendente;
}

/// WebSocket com fila: cada waitFor consome o primeiro evento daquele tipo.
export function socketFor(token) {
  const ws = new WebSocket(wsBase + "/ws?token=" + encodeURIComponent(token));
  const queued = [];
  const waiters = [];
  ws.onmessage = event => {
    const value = JSON.parse(event.data);
    const index = waiters.findIndex(waiter => waiter.type === value.type);
    if (index >= 0) waiters.splice(index, 1)[0].resolve(value);
    else queued.push(value);
  };
  const waitFor = type => {
    const index = queued.findIndex(value => value.type === type);
    if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve };
      waiters.push(waiter);
      setTimeout(() => {
        const pending = waiters.indexOf(waiter);
        if (pending >= 0) waiters.splice(pending, 1);
        reject(new Error("timeout aguardando " + type));
      }, 5000);
    });
  };
  return { ws, waitFor };
}

export function readData(file) {
  if (!dataDir) return null;
  try { return JSON.parse(fs.readFileSync(dataDir + "/" + file, "utf8")); }
  catch { return null; }
}
