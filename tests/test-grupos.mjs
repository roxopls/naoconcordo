// Grupos privados: quem entra, quem sai, e que o servidor nunca ve texto nem
// chave. A cifra aqui e a mesma do cliente (`private.ts`): embrulho da chave do
// grupo com ECDH + HKDF + AES-GCM entre quem embrulha e quem recebe, e as
// mensagens com AES-GCM sob a chave do grupo, com grupo, autor e epoca como
// dado autenticado.
import crypto from "node:crypto";
import { b64, post, put, get, del, check, results, createUser as novaConta, socketFor } from "./test-common.mjs";

async function createUser(label) {
  const session = await novaConta(label);
  const identity = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicRaw = identity.publicKey.export({ type: "spki", format: "der" }).subarray(-65);
  const publish = await put("/api/keys", { publicKey: b64(publicRaw) }, session.token);
  if (!publish.ok) throw new Error("publicar chave " + label + ": " + await publish.text());
  return { username: session.username, token: session.token, identity, publicRaw };
}
async function amigos(a, b) {
  await post("/api/friends/request", { username: b.username }, a.token);
  const aceite = await post("/api/friends/accept", { username: a.username }, b.token);
  if (!aceite.ok) throw new Error("amizade " + a.username + " " + b.username);
}

function segredoDoPar(mine, theirRaw) {
  const theirs = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"), theirRaw]),
    format: "der", type: "spki",
  });
  const secret = crypto.diffieHellman({ privateKey: mine.identity.privateKey, publicKey: theirs });
  return Buffer.from(crypto.hkdfSync("sha256", secret, Buffer.alloc(0), Buffer.from("naoconcordo-dm-v1"), 32));
}
function cifrar(chave, texto, aad) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", chave, nonce);
  cipher.setAAD(aad);
  const corpo = Buffer.concat([cipher.update(texto, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { ciphertext: corpo.toString("base64url"), nonce: nonce.toString("base64url") };
}
function decifrar(chave, env, aad) {
  const corpo = Buffer.from(env.ciphertext, "base64url");
  const d = crypto.createDecipheriv("aes-256-gcm", chave, Buffer.from(env.nonce, "base64url"));
  d.setAAD(aad);
  d.setAuthTag(corpo.subarray(corpo.length - 16));
  return Buffer.concat([d.update(corpo.subarray(0, corpo.length - 16)), d.final()]).toString("utf8");
}
const aadPar = (de, para) => Buffer.from(de.toLowerCase() + ":" + para.toLowerCase(), "utf8");
const aadGrupo = (grupo, de, epoca) => Buffer.from("grupo:" + grupo + ":" + de.toLowerCase() + ":" + epoca, "utf8");

/// Embrulha `chave` (base64url, como no cliente) de `quem` para `para`.
function embrulhar(quem, para, chave) {
  return { de: quem.username, ...cifrar(segredoDoPar(quem, para.publicRaw), chave, aadPar(quem.username, para.username)) };
}
function desembrulhar(eu, remetente, embrulho) {
  return decifrar(segredoDoPar(eu, remetente.publicRaw), embrulho, aadPar(embrulho.de, eu.username));
}
const novaChave = () => crypto.randomBytes(32).toString("base64url");

const ana = await createUser("ana");
const bia = await createUser("bia");
const caio = await createUser("caio");
const davi = await createUser("davi");
// Ana e amiga de todos; Bia e Caio nao sao amigos entre si.
await amigos(ana, bia); await amigos(ana, caio); await amigos(ana, davi);

// Grupo so com amigos de quem cria.
const chave1 = novaChave();
const estranho = await post("/api/grupos", { membros: [caio.username], chaves: {} }, bia.token);
check("grupoSoComAmigos", estranho.status === 403, String(estranho.status));
const incompleto = await post("/api/grupos", {
  membros: [bia.username], chaves: { [ana.username]: embrulhar(ana, ana, chave1) },
}, ana.token);
check("grupoSemEmbrulhoDeTodosRecusado", incompleto.status === 400, String(incompleto.status));

const sBia = socketFor(bia.token);
const sCaio = socketFor(caio.token);
await new Promise(r => setTimeout(r, 300));
const criado = await post("/api/grupos", {
  nome: "Trio", membros: [bia.username, caio.username],
  chaves: {
    [ana.username]: embrulhar(ana, ana, chave1),
    [bia.username]: embrulhar(ana, bia, chave1),
    [caio.username]: embrulhar(ana, caio, chave1),
  },
}, ana.token);
check("grupoCriado", criado.status === 201, String(criado.status));
const grupo = await criado.json();
check("donoEMembros", grupo.dono === ana.username && grupo.membros.length === 3 && grupo.epoca === 1);
check("vejoSoMeuEmbrulho", Object.keys(grupo.chaves).length === 1 && grupo.chaves["1"].de === ana.username);
const avisoBia = await sBia.waitFor("grupoAtualizado");
check("membroAvisadoPorSocket", avisoBia.grupo?.id === grupo.id);
check("socketLevaEmbrulhoDoMembro", Boolean(avisoBia.grupo?.chaves?.["1"]));

// Bia abre o embrulho dela com a chave publica de Ana e chega na mesma chave.
const vistaBia = (await (await get("/api/grupos", bia.token)).json()).find(g => g.id === grupo.id);
check("biaAbreAChave", desembrulhar(bia, ana, vistaBia.chaves["1"]) === chave1);

// Membros que nao sao amigos veem a chave publica um do outro.
const chaveCaio = await get("/api/keys/" + encodeURIComponent(caio.username), bia.token);
check("chaveEntreMembrosDoGrupo", chaveCaio.ok, String(chaveCaio.status));
const chaveDavi = await get("/api/keys/" + encodeURIComponent(davi.username), bia.token);
check("chaveForaDoGrupoBloqueada", chaveDavi.status === 403, String(chaveDavi.status));

// Mensagem: o servidor so guarda texto cifrado.
const segredo = "segredo-" + crypto.randomBytes(6).toString("hex");
const k1 = Buffer.from(chave1, "base64url");
const enviado = await post("/api/grupos/" + grupo.id + "/mensagens",
  { epoca: 1, ...cifrar(k1, segredo, aadGrupo(grupo.id, bia.username, 1)) }, bia.token);
check("mensagemEnviada", enviado.status === 201, String(enviado.status));
const naCaio = await sCaio.waitFor("grupoMensagem");
check("mensagemChegaPorSocket", naCaio.mensagem?.grupoId === grupo.id);
check("caioDecifra", decifrar(k1, naCaio.mensagem, aadGrupo(grupo.id, naCaio.mensagem.from, 1)) === segredo);
check("servidorNaoTemTexto", !JSON.stringify(naCaio).includes(segredo));
let trocou = false;
try { decifrar(k1, naCaio.mensagem, aadGrupo(grupo.id, caio.username, 1)); } catch { trocou = true; }
check("autorFazParteDoSelo", trocou);

const deFora = await get("/api/grupos/" + grupo.id + "/mensagens", davi.token);
check("historicoSoParaMembros", deFora.status === 404, String(deFora.status));
const epocaErrada = await post("/api/grupos/" + grupo.id + "/mensagens",
  { epoca: 7, ...cifrar(k1, "x", aadGrupo(grupo.id, bia.username, 7)) }, bia.token);
check("epocaErradaRecusada", epocaErrada.status === 409, String(epocaErrada.status));

// Renomear: qualquer membro.
const renomeado = await put("/api/grupos/" + grupo.id, { nome: "Quarteto" }, caio.token);
check("membroRenomeia", renomeado.ok && (await renomeado.json()).nome === "Quarteto");

// Bia chama Davi? Nao e amiga dele.
const naoAmigo = await post("/api/grupos/" + grupo.id + "/membros",
  { username: davi.username, chaves: { 1: embrulhar(bia, davi, chave1) } }, bia.token);
check("soChamaAmigo", naoAmigo.status === 403, String(naoAmigo.status));
// Ana chama Davi e entrega todas as epocas: ele le o historico.
const entrou = await post("/api/grupos/" + grupo.id + "/membros",
  { username: davi.username, chaves: { 1: embrulhar(ana, davi, chave1) } }, ana.token);
check("daviEntra", entrou.ok, String(entrou.status));
const vistaDavi = (await (await get("/api/grupos", davi.token)).json()).find(g => g.id === grupo.id);
const historicoDavi = await (await get("/api/grupos/" + grupo.id + "/mensagens", davi.token)).json();
const kDavi = Buffer.from(desembrulhar(davi, ana, vistaDavi.chaves["1"]), "base64url");
check("novoMembroLeHistorico", decifrar(kDavi, historicoDavi[0], aadGrupo(grupo.id, bia.username, 1)) === segredo);

// So o dono tira; tirar marca a troca de chave e trava mensagem nova.
const naoDono = await del("/api/grupos/" + grupo.id + "/membros/" + encodeURIComponent(caio.username), bia.token);
check("soDonoTira", naoDono.status === 403, String(naoDono.status));
const tirado = await del("/api/grupos/" + grupo.id + "/membros/" + encodeURIComponent(caio.username), ana.token);
check("donoTira", tirado.status === 204, String(tirado.status));
const avisoCaio = await sCaio.waitFor("grupoRemovido");
check("tiradoRecebeAviso", avisoCaio.grupoId === grupo.id);
const semCaio = await get("/api/grupos/" + grupo.id + "/mensagens", caio.token);
check("tiradoPerdeAcesso", semCaio.status === 404, String(semCaio.status));
const pendente = (await (await get("/api/grupos", ana.token)).json()).find(g => g.id === grupo.id);
check("trocaDeChavePendente", pendente.rotacaoPendente === true);
const travado = await post("/api/grupos/" + grupo.id + "/mensagens",
  { epoca: 1, ...cifrar(k1, "x", aadGrupo(grupo.id, ana.username, 1)) }, ana.token);
check("mensagemTravadaAteTrocar", travado.status === 409, String(travado.status));

// Troca: tem de cobrir exatamente quem ficou.
const chave2 = novaChave();
const comCaio = await post("/api/grupos/" + grupo.id + "/chave", {
  epoca: 2, chaves: {
    [ana.username]: embrulhar(bia, ana, chave2), [bia.username]: embrulhar(bia, bia, chave2),
    [davi.username]: embrulhar(bia, davi, chave2), [caio.username]: embrulhar(bia, caio, chave2),
  },
}, bia.token);
check("trocaSemQuemSaiu", comCaio.status === 400, String(comCaio.status));
const troca = await post("/api/grupos/" + grupo.id + "/chave", {
  epoca: 2, chaves: {
    [ana.username]: embrulhar(bia, ana, chave2), [bia.username]: embrulhar(bia, bia, chave2),
    [davi.username]: embrulhar(bia, davi, chave2),
  },
}, bia.token);
check("chaveTrocada", troca.ok, String(troca.status));
const repetida = await post("/api/grupos/" + grupo.id + "/chave", {
  epoca: 2, chaves: {
    [ana.username]: embrulhar(ana, ana, chave2), [bia.username]: embrulhar(ana, bia, chave2),
    [davi.username]: embrulhar(ana, davi, chave2),
  },
}, ana.token);
check("segundaTrocaPerde", repetida.status === 409, String(repetida.status));
const k2 = Buffer.from(chave2, "base64url");
const depois = await post("/api/grupos/" + grupo.id + "/mensagens",
  { epoca: 2, ...cifrar(k2, "depois", aadGrupo(grupo.id, ana.username, 2)) }, ana.token);
check("mensagemComChaveNova", depois.status === 201, String(depois.status));
const vistaAna = (await (await get("/api/grupos", ana.token)).json()).find(g => g.id === grupo.id);
check("anaAbreChaveNova", desembrulhar(ana, bia, vistaAna.chaves["2"]) === chave2);

// Editar e apagar: so o autor.
const idMsg = (await depois.json()).id;
const editaOutro = await put("/api/grupos/" + grupo.id + "/mensagens/" + idMsg,
  { epoca: 2, ...cifrar(k2, "x", aadGrupo(grupo.id, bia.username, 2)) }, bia.token);
check("soAutorEdita", editaOutro.status === 403, String(editaOutro.status));
const apagaOutro = await del("/api/grupos/" + grupo.id + "/mensagens/" + idMsg, bia.token);
check("soAutorApaga", apagaOutro.status === 403, String(apagaOutro.status));
const apagou = await del("/api/grupos/" + grupo.id + "/mensagens/" + idMsg, ana.token);
check("autorApaga", apagou.status === 204, String(apagou.status));

// Dono sai: o grupo passa para outro membro.
const saiu = await del("/api/grupos/" + grupo.id + "/membros/" + encodeURIComponent(ana.username), ana.token);
check("donoSai", saiu.status === 204, String(saiu.status));
const novoDono = (await (await get("/api/grupos", bia.token)).json()).find(g => g.id === grupo.id);
check("donoPassaAdiante", novoDono && novoDono.dono !== ana.username && novoDono.membros.length === 2);

// Ultimos saem: grupo e mensagens somem.
await del("/api/grupos/" + grupo.id + "/membros/" + encodeURIComponent(bia.username), bia.token);
await del("/api/grupos/" + grupo.id + "/membros/" + encodeURIComponent(davi.username), davi.token);
const sobrou = (await (await get("/api/grupos", davi.token)).json()).find(g => g.id === grupo.id);
check("grupoVazioApagado", !sobrou);

// Limite de 10.
const muitos = [];
for (let i = 0; i < 10; i++) { const u = await createUser("m" + i); await amigos(ana, u); muitos.push(u); }
const chaveG = novaChave();
const grande = await post("/api/grupos", {
  membros: muitos.map(u => u.username),
  chaves: Object.fromEntries([ana, ...muitos].map(u => [u.username, embrulhar(ana, u, chaveG)])),
}, ana.token);
check("limiteDeDez", grande.status === 400, String(grande.status));

sBia.ws.close(); sCaio.ws.close();
console.log(JSON.stringify(results, null, 2));
