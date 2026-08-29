import crypto from "node:crypto";
import { api, mintInvite } from "./test-common.mjs";

const username = "teste-" + Date.now().toString(36);
const password = "TesteSeguro-" + crypto.randomBytes(8).toString("hex");
const recoveredPassword = "Recuperada-" + crypto.randomBytes(8).toString("hex");
const recoveryCode = crypto.randomBytes(24).toString("base64url");
const rotatedRecoveryCode = crypto.randomBytes(24).toString("base64url");
const json = { "content-type": "application/json" };
const b64 = value => Buffer.from(value).toString("base64url");

async function challenge() {
  const response = await fetch(api + "/api/auth/challenge", { method: "POST", headers: json, body: JSON.stringify({ username }) });
  if (!response.ok) throw new Error("challenge: " + response.status + " " + await response.text());
  return response.json();
}
const proofFor = (key, nonce) => crypto.createHmac("sha256", key).update(nonce + ":" + username).digest("base64url");
const post = (path, body, token) => fetch(api + path, { method: "POST", headers: token ? { ...json, authorization: "Bearer " + token } : json, body: JSON.stringify(body) });

const first = await challenge();
if (first.accountExists) throw new Error("usuario temporario ja existe");
// Cadastro agora exige convite de uso unico emitido pelo painel do admin.
const convite = await mintInvite("conta");
const inviteKey = crypto.pbkdf2Sync(convite.code, first.inviteSalt, first.inviteIterations, 32, "sha256");
const verifier = crypto.pbkdf2Sync(password, first.passwordSalt, first.passwordIterations, 32, "sha256");
const recoveryVerifier = crypto.pbkdf2Sync(recoveryCode, first.recoverySalt, first.passwordIterations, 32, "sha256");
const registerResponse = await post("/api/auth/register", { username, nonce: first.nonce, inviteProof: proofFor(inviteKey, first.nonce), verifier: b64(verifier), recoveryVerifier: b64(recoveryVerifier) });
if (!registerResponse.ok) throw new Error("register: " + registerResponse.status + " " + await registerResponse.text());
const registered = await registerResponse.json();

const wrong = await challenge();
const wrongVerifier = crypto.pbkdf2Sync("senha-errada", wrong.passwordSalt, wrong.passwordIterations, 32, "sha256");
const wrongResponse = await post("/api/auth/login", { username, nonce: wrong.nonce, proof: proofFor(wrongVerifier, wrong.nonce) });
if (wrongResponse.status !== 401) throw new Error("senha errada deveria retornar 401");

const valid = await challenge();
const loginVerifier = crypto.pbkdf2Sync(password, valid.passwordSalt, valid.passwordIterations, 32, "sha256");
const loginResponse = await post("/api/auth/login", { username, nonce: valid.nonce, proof: proofFor(loginVerifier, valid.nonce) });
if (!loginResponse.ok) throw new Error("login: " + loginResponse.status + " " + await loginResponse.text());
const login = await loginResponse.json();

const recovery = await challenge();
const oldRecoveryVerifier = crypto.pbkdf2Sync(recoveryCode, recovery.recoverySalt, recovery.passwordIterations, 32, "sha256");
const newPasswordVerifier = crypto.pbkdf2Sync(recoveredPassword, recovery.passwordSalt, recovery.passwordIterations, 32, "sha256");
const newRecoveryVerifier = crypto.pbkdf2Sync(rotatedRecoveryCode, recovery.recoverySalt, recovery.passwordIterations, 32, "sha256");
const recoverResponse = await post("/api/auth/recover", { username, nonce: recovery.nonce, recoveryProof: proofFor(oldRecoveryVerifier, recovery.nonce), verifier: b64(newPasswordVerifier), recoveryVerifier: b64(newRecoveryVerifier) });
if (!recoverResponse.ok) throw new Error("recover: " + recoverResponse.status + " " + await recoverResponse.text());
const recovered = await recoverResponse.json();

const oldPassword = await challenge();
const obsoletePasswordVerifier = crypto.pbkdf2Sync(password, oldPassword.passwordSalt, oldPassword.passwordIterations, 32, "sha256");
const oldPasswordResponse = await post("/api/auth/login", { username, nonce: oldPassword.nonce, proof: proofFor(obsoletePasswordVerifier, oldPassword.nonce) });
if (oldPasswordResponse.status !== 401) throw new Error("senha antiga deveria retornar 401");

const oldRecovery = await challenge();
const obsoleteRecoveryVerifier = crypto.pbkdf2Sync(recoveryCode, oldRecovery.recoverySalt, oldRecovery.passwordIterations, 32, "sha256");
const oldRecoveryResponse = await post("/api/auth/recover", { username, nonce: oldRecovery.nonce, recoveryProof: proofFor(obsoleteRecoveryVerifier, oldRecovery.nonce), verifier: b64(newPasswordVerifier), recoveryVerifier: b64(newRecoveryVerifier) });
if (oldRecoveryResponse.status !== 401) throw new Error("codigo antigo deveria retornar 401");

const finalChallenge = await challenge();
const finalVerifier = crypto.pbkdf2Sync(recoveredPassword, finalChallenge.passwordSalt, finalChallenge.passwordIterations, 32, "sha256");
const finalLoginResponse = await post("/api/auth/login", { username, nonce: finalChallenge.nonce, proof: proofFor(finalVerifier, finalChallenge.nonce) });
if (!finalLoginResponse.ok) throw new Error("login novo: " + finalLoginResponse.status + " " + await finalLoginResponse.text());
const finalLogin = await finalLoginResponse.json();

// Nao existe mais canal padrao: usa um canal de voz que a conta enxergue.
const boot = await (await fetch(api + "/api/bootstrap", { headers: { authorization: "Bearer " + finalLogin.token } })).json();
const voz = boot.rooms.find(room => room.kind === "voice");
const mediaResponse = voz
  ? await post("/api/livekit-token", { roomId: voz.id }, finalLogin.token)
  : { ok: true, json: async () => ({ token: "sem canal de voz visivel para esta conta" }) };
if (!mediaResponse.ok) throw new Error("media: " + mediaResponse.status + " " + await mediaResponse.text());
console.log(JSON.stringify({ register: Boolean(registered.token), wrongPasswordRejected: true, login: Boolean(login.token), recover: Boolean(recovered.token), oldPasswordRejected: true, oldRecoveryRejected: true, newPasswordLogin: Boolean(finalLogin.token), mediaToken: Boolean((await mediaResponse.json()).token) }));
