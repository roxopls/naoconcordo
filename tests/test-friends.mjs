// Prova que amizade e exigida para conversa privada e que o servidor nunca
// recebe texto legivel. Cria dois usuarios temporarios e conversa entre eles.
import crypto from "node:crypto";
import { api, b64, post, put, get, check, results, createUser as novaConta } from "./test-common.mjs";

async function createUser(label) {
  const session = await novaConta(label);
  const username = session.username;
  // Identidade criptografica local: a chave privada nunca sai daqui.
  const identity = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicRaw = identity.publicKey.export({ type: "spki", format: "der" }).subarray(-65);
  const publish = await put("/api/keys", { publicKey: b64(publicRaw) }, session.token);
  if (!publish.ok) throw new Error("publicar chave " + label + ": " + await publish.text());
  return { username, token: session.token, identity, publicRaw };
}

function sharedKey(mine, theirRaw) {
  const theirs = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"), theirRaw]),
    format: "der", type: "spki",
  });
  const secret = crypto.diffieHellman({ privateKey: mine.identity.privateKey, publicKey: theirs });
  return crypto.hkdfSync("sha256", secret, Buffer.alloc(0), Buffer.from("naoconcordo-dm-v1"), 32);
}
// Remetente e destinatario entram como dado autenticado, igual ao cliente.
const aad = (from, to) => Buffer.from(from.toLowerCase() + ":" + to.toLowerCase(), "utf8");
function seal(key, plaintext, from, to) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(key), nonce);
  cipher.setAAD(aad(from, to));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { ciphertext: body.toString("base64url"), nonce: nonce.toString("base64url") };
}
function open(key, envelope, from, to) {
  const body = Buffer.from(envelope.ciphertext, "base64url");
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(envelope.nonce, "base64url"));
  decipher.setAAD(aad(from, to));
  decipher.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString("utf8");
}

const alice = await createUser("alice");
const bob = await createUser("bob");
const secretText = "segredo-" + crypto.randomBytes(6).toString("hex");

// Sem amizade, nem conversa nem leitura de chave sao permitidas.
const blockedSend = await post("/api/dm", { to: bob.username, ciphertext: b64("x"), nonce: b64("123456789012") }, alice.token);
check("dmSemAmizadeBloqueado", blockedSend.status === 403, String(blockedSend.status));
const blockedHistory = await get("/api/dm?with=" + encodeURIComponent(bob.username), alice.token);
check("historicoSemAmizadeBloqueado", blockedHistory.status === 403, String(blockedHistory.status));
const blockedKey = await get("/api/keys/" + encodeURIComponent(bob.username), alice.token);
check("chaveSemVinculoBloqueada", blockedKey.status === 403, String(blockedKey.status));

// Busca encontra o usuario pelo prefixo.
const search = await (await get("/api/users/search?q=" + encodeURIComponent(bob.username.slice(0, 6)), alice.token)).json();
check("buscaEncontraUsuario", search.users.some(name => name === bob.username));

const requested = await post("/api/friends/request", { username: bob.username }, alice.token);
check("pedidoCriado", requested.status === 201, String(requested.status));
const duplicated = await post("/api/friends/request", { username: bob.username }, alice.token);
check("pedidoDuplicadoRejeitado", duplicated.status === 409, String(duplicated.status));

// Quem pediu nao pode aceitar o proprio pedido.
const selfAccept = await post("/api/friends/accept", { username: bob.username }, alice.token);
check("autoAceiteRejeitado", selfAccept.status === 404, String(selfAccept.status));

// Ainda pendente: conversa continua bloqueada.
const pendingSend = await post("/api/dm", { to: bob.username, ciphertext: b64("x"), nonce: b64("123456789012") }, alice.token);
check("dmPendenteBloqueado", pendingSend.status === 403, String(pendingSend.status));

const accepted = await post("/api/friends/accept", { username: alice.username }, bob.token);
check("pedidoAceito", accepted.ok, String(accepted.status));

const aliceFriends = await (await get("/api/friends", alice.token)).json();
check("listaDeAmigos", aliceFriends.friends.includes(bob.username));

// Agora as chaves sao visiveis entre os dois.
const bobKey = await get("/api/keys/" + encodeURIComponent(bob.username), alice.token);
check("chaveVisivelEntreAmigos", bobKey.ok, String(bobKey.status));
const bobPublic = Buffer.from((await bobKey.json()).publicKey, "base64url");
check("chavePublicaConfere", bobPublic.equals(bob.publicRaw));

const aliceShared = sharedKey(alice, bob.publicRaw);
const bobShared = sharedKey(bob, alice.publicRaw);
check("segredoCompartilhadoIgual", Buffer.from(aliceShared).equals(Buffer.from(bobShared)));

const envelope = seal(aliceShared, secretText, alice.username, bob.username);
const sent = await post("/api/dm", { to: bob.username, ...envelope }, alice.token);
check("mensagemEnviada", sent.status === 201, String(sent.status));
const stored = await sent.json();

// O que o servidor devolve nao contem o texto original.
const storedRaw = JSON.stringify(stored);
check("respostaSemPlaintext", !storedRaw.includes(secretText));

const history = await (await get("/api/dm?with=" + encodeURIComponent(alice.username), bob.token)).json();
check("historicoRecebido", history.envelopes.length === 1);
check("historicoSemPlaintext", !JSON.stringify(history.envelopes).includes(secretText));
check("bobDecifra", open(bobShared, history.envelopes[0], alice.username, bob.username) === secretText);

// O envelope nao pode ser reaproveitado invertendo remetente e destinatario.
let reflectionRejected = false;
try { open(bobShared, history.envelopes[0], bob.username, alice.username); }
catch { reflectionRejected = true; }
check("envelopeNaoReaproveitavel", reflectionRejected);

// Um terceiro nao le a conversa nem com sessao valida.
const mallory = await createUser("mallory");
const intruderHistory = await get("/api/dm?with=" + encodeURIComponent(alice.username), mallory.token);
check("terceiroBloqueado", intruderHistory.status === 403, String(intruderHistory.status));

// Com KEEP_DATA=1 o teste para aqui, para inspecionar o que ficou gravado em disco.
if (process.env.KEEP_DATA === "1") {
  console.log(JSON.stringify({ ...results, textoOriginal: secretText }, null, 2));
  process.exit(0);
}

// Ao desfazer a amizade, a conversa some e volta a ser proibida.
const removed = await post("/api/friends/remove", { username: bob.username }, alice.token);
check("amizadeRemovida", removed.status === 204, String(removed.status));
const afterRemove = await get("/api/dm?with=" + encodeURIComponent(bob.username), alice.token);
check("dmAposRemocaoBloqueado", afterRemove.status === 403, String(afterRemove.status));

console.log(JSON.stringify(results, null, 2));
