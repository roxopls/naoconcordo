// Testa edicao/exclusao de mensagens de canal e de PV, e anexo no PV,
// contra uma instancia isolada do servidor.
import crypto from "node:crypto";
import { api, call, post, get, check, report, readData, createUser, socketFor, entrarNoServidor } from "./test-common.mjs";

const enviarArquivo = (bytes, mime, nome, token) => fetch(api + "/api/files", {
  method: "POST",
  headers: { "content-type": mime, "x-file-name": nome, authorization: "Bearer " + token },
  body: bytes,
});
const png = () => Buffer.concat([
  Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc00000030101003ea9ef9a0000000049454e44ae426082", "hex"),
  crypto.randomBytes(8),
]);
const cifra = texto => ({ ciphertext: Buffer.from(texto).toString("base64url"), nonce: crypto.randomBytes(12).toString("base64url") });

const dono = await createUser("msg-dono");
const membro = await createUser("msg-membro");

// ---------- canal ----------
const servidor = await (await post("/api/servers", { name: "Mensagens " + crypto.randomBytes(2).toString("hex") }, dono.token)).json();
check("contaComumCriaServidor", Boolean(servidor.id), JSON.stringify(servidor));
await entrarNoServidor(servidor.id, dono, membro);
check("membroEntrouNoServidor", (await (await get("/api/bootstrap", membro.token)).json()).servers.some(item => item.id === servidor.id));
const inicio = await (await get("/api/bootstrap", dono.token)).json();
const canal = inicio.rooms.find(item => item.serverId === servidor.id && item.kind === "text");
check("canalTextoExiste", Boolean(canal));

const socketDono = socketFor(dono.token);
const socketMembro = socketFor(membro.token);
await socketDono.waitFor("welcome");
await socketMembro.waitFor("welcome");
socketDono.ws.send(JSON.stringify({ type: "message", roomId: canal.id, text: "texto original", attachments: [] }));
const criadaDono = await socketDono.waitFor("message");
const criadaMembro = await socketMembro.waitFor("message");
check("mensagemChegaAosDois", criadaDono.message.id === criadaMembro.message.id);
const mensagemId = criadaDono.message.id;

const edicao = await call("PUT", "/api/messages/" + mensagemId, { text: "texto corrigido" }, dono.token);
check("autorEdita", edicao.status === 200, String(edicao.status));
const editada = await edicao.json();
check("edicaoMarcada", editada.text === "texto corrigido" && Boolean(editada.editedAt));
const atualizadaDono = await socketDono.waitFor("messageUpdated");
const atualizadaMembro = await socketMembro.waitFor("messageUpdated");
check("edicaoEmTempoReal", atualizadaDono.message.text === "texto corrigido" && atualizadaMembro.message.id === mensagemId);

check("outroNaoEdita", (await call("PUT", "/api/messages/" + mensagemId, { text: "invasao" }, membro.token)).status === 403);
check("outroNaoApaga", (await call("DELETE", "/api/messages/" + mensagemId, undefined, membro.token)).status === 403);
check("mensagemVaziaBloqueada", (await call("PUT", "/api/messages/" + mensagemId, { text: "   " }, dono.token)).status === 400);
const emDisco = readData("messages.json");
if (emDisco) check("edicaoPersistida", emDisco.some(item => item.id === mensagemId && item.text === "texto corrigido" && item.editedAt));

check("autorApaga", (await call("DELETE", "/api/messages/" + mensagemId, undefined, dono.token)).status === 204);
const apagadaDono = await socketDono.waitFor("messageDeleted");
const apagadaMembro = await socketMembro.waitFor("messageDeleted");
check("exclusaoEmTempoReal", apagadaDono.messageId === mensagemId && apagadaMembro.messageId === mensagemId);
check("apagarNovamenteRetorna404", (await call("DELETE", "/api/messages/" + mensagemId, undefined, dono.token)).status === 404);
const depoisDeApagar = readData("messages.json");
if (depoisDeApagar) check("exclusaoPersistida", !depoisDeApagar.some(item => item.id === mensagemId));

// ---------- PV ----------
check("pedidoDeAmizade", (await post("/api/friends/request", { username: membro.username }, dono.token)).ok);
check("amizadeAceita", (await post("/api/friends/accept", { username: dono.username }, membro.token)).ok);

const anexo = await (await enviarArquivo(png(), "image/png", "pv.png", dono.token)).json();
check("uploadParaPv", Boolean(anexo.id), JSON.stringify(anexo));

const envio = await post("/api/dm", { to: membro.username, ...cifra("oi cifrado"), attachments: [anexo.id] }, dono.token);
check("pvEnviado", envio.status === 201, String(envio.status));
const envelope = await envio.json();
check("pvLevaAnexo", envelope.attachments?.length === 1 && envelope.attachments[0].id === anexo.id);
const pvDono = await socketDono.waitFor("directMessage");
const pvMembro = await socketMembro.waitFor("directMessage");
check("pvChegaAosDois", pvDono.envelope.id === envelope.id && pvMembro.envelope.id === envelope.id);
check("pvComAnexoNoEvento", pvMembro.envelope.attachments?.length === 1);
check("destinatarioBaixaAnexo", (await fetch(api + "/api/files/" + anexo.id, { headers: { authorization: "Bearer " + membro.token } })).status === 200);

const anexoAlheio = await post("/api/dm", { to: dono.username, ...cifra("roubo"), attachments: [anexo.id] }, membro.token);
const envelopeAlheio = await anexoAlheio.json();
check("anexoDeOutroIgnorado", (envelopeAlheio.attachments || []).length === 0);

const pvEditado = await call("PUT", "/api/dm/" + envelope.id, cifra("oi corrigido"), dono.token);
check("autorEditaPv", pvEditado.status === 200, String(pvEditado.status));
const envelopeEditado = await pvEditado.json();
check("pvEdicaoMarcada", Boolean(envelopeEditado.editedAt) && envelopeEditado.ciphertext === Buffer.from("oi corrigido").toString("base64url"));
const pvUpdDono = await socketDono.waitFor("directMessageUpdated");
const pvUpdMembro = await socketMembro.waitFor("directMessageUpdated");
check("pvEdicaoEmTempoReal", pvUpdDono.envelope.id === envelope.id && pvUpdMembro.envelope.id === envelope.id);
check("outroNaoEditaPv", (await call("PUT", "/api/dm/" + envelope.id, cifra("invasao"), membro.token)).status === 403);
check("outroNaoApagaPv", (await call("DELETE", "/api/dm/" + envelope.id, undefined, membro.token)).status === 403);
const pvEmDisco = readData("dms.json");
if (pvEmDisco) check("pvEdicaoPersistida", pvEmDisco.some(item => item.id === envelope.id && item.editedAt && item.attachments?.length === 1));

check("autorApagaPv", (await call("DELETE", "/api/dm/" + envelope.id, undefined, dono.token)).status === 204);
const pvDelDono = await socketDono.waitFor("directMessageDeleted");
const pvDelMembro = await socketMembro.waitFor("directMessageDeleted");
check("pvExclusaoEmTempoReal", pvDelDono.messageId === envelope.id && pvDelMembro.messageId === envelope.id);
check("pvApagarNovamente404", (await call("DELETE", "/api/dm/" + envelope.id, undefined, dono.token)).status === 404);
const historico = await (await get("/api/dm?with=" + encodeURIComponent(dono.username), membro.token)).json();
check("pvSaiDoHistorico", !historico.envelopes.some(item => item.id === envelope.id));

socketDono.ws.close(); socketMembro.ws.close();
await post("/api/servers/delete", { serverId: servidor.id }, dono.token);
report();
