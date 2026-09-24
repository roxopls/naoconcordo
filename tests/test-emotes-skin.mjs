// Emotes do servidor e aparência (cor e fundo) do servidor e do canal.
//
// O que estas verificações cobrem, e por que valem a pena: as duas features são
// de **personalização por papel**, e a falha que interessa é de autorização —
// um membro comum conseguir trocar a cara da casa dos outros. Esse defeito não
// aparece usando o app, porque quem testa é o dono e o dono pode tudo.
//
// O resto é validação de entrada. As cores terminam dentro de um estilo no
// navegador de todo mundo que entra no canal, então texto livre ali seria
// deixar o dono escrever CSS na tela alheia; e o apelido do emote vive entre
// dois-pontos no meio de uma frase, onde espaço e acento tornariam impossível
// saber onde ele acaba.
import crypto from "node:crypto";
import { check, createUser, del, entrarNoServidor, get, post, put, report } from "./test-common.mjs";

const dono = await createUser("emdono");
const membro = await createUser("emmemb");

const servidor = await (await post("/api/servers",
  { name: "Casa " + crypto.randomBytes(2).toString("hex") }, dono.token)).json();
await entrarNoServidor(servidor.id, dono, membro);

const boot = await (await get("/api/bootstrap", dono.token)).json();
const texto = boot.rooms.find(r => r.serverId === servidor.id && r.kind === "text");

// Um PNG de verdade, para o servidor aceitar como imagem.
const png = Buffer.concat([
  Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc00000030101003ea9ef9a0000000049454e44ae426082", "hex"),
  crypto.randomBytes(8),
]);
const enviar = async (bytes, mime, nome, token) => (await fetch(
  (process.env.TEST_API || "http://127.0.0.1:3040") + "/api/files",
  { method: "POST", headers: { "content-type": mime, "x-file-name": nome, authorization: "Bearer " + token }, body: bytes },
)).json();

const imagem = await enviar(png, "image/png", "sino.png", dono.token);
const naoImagem = await enviar(Buffer.from("MZ" + crypto.randomBytes(16).toString("hex")), "application/x-msdownload", "p.exe", dono.token);

// ------------------------------------------------------------- emotes
const criar = (corpo, token) => post("/api/emotes", corpo, token);

check("membro comum não cria emote",
  (await criar({ serverId: servidor.id, name: "sino", fileId: imagem.id }, membro.token)).status === 403);

check("apelido com espaço é recusado",
  (await criar({ serverId: servidor.id, name: "si no", fileId: imagem.id }, dono.token)).status === 400);
check("apelido curto demais é recusado",
  (await criar({ serverId: servidor.id, name: "s", fileId: imagem.id }, dono.token)).status === 400);
check("emote que não é imagem é recusado",
  (await criar({ serverId: servidor.id, name: "virus", fileId: naoImagem.id }, dono.token)).status === 400);

const criado = await criar({ serverId: servidor.id, name: "Sino", fileId: imagem.id }, dono.token);
check("dono cria emote", criado.status === 201, String(criado.status));
const emote = await criado.json();
check("apelido vira minúsculo", emote.name === "sino", emote.name);

check("apelido repetido é recusado",
  (await criar({ serverId: servidor.id, name: "sino", fileId: imagem.id }, dono.token)).status === 409);

const bootMembro = await (await get("/api/bootstrap", membro.token)).json();
check("membro enxerga os emotes da casa",
  (bootMembro.emotes || []).some(item => item.id === emote.id));

check("membro comum não apaga emote",
  (await del("/api/emotes/" + emote.id, membro.token)).status === 403);
check("dono apaga emote", (await del("/api/emotes/" + emote.id, dono.token)).status === 204);
const bootDepois = await (await get("/api/bootstrap", dono.token)).json();
check("emote apagado sai da lista", !(bootDepois.emotes || []).some(item => item.id === emote.id));

// ------------------------------------------------------------ aparência
const skinServidor = (corpo, token) => put("/api/servers/" + servidor.id + "/skin", corpo, token);
const skinCanal = (corpo, token) => put("/api/rooms/" + texto.id + "/skin", corpo, token);

check("membro comum não muda a aparência do servidor",
  (await skinServidor({ accent: "#ff0000" }, membro.token)).status === 403);
check("membro comum não muda a aparência do canal",
  (await skinCanal({ accent: "#ff0000" }, membro.token)).status === 403);

check("cor inventada é recusada",
  (await skinServidor({ accent: "red; background: url(x)" }, dono.token)).status === 400);
check("cor sem # é recusada",
  (await skinServidor({ bgColor: "112233" }, dono.token)).status === 400);
check("fundo que não é imagem é recusado",
  (await skinServidor({ bgFile: naoImagem.id }, dono.token)).status === 400);

check("dono pinta o servidor",
  (await skinServidor({ accent: "#3366ff", bgColor: "#101014" }, dono.token)).status === 200);
const comSkin = await (await get("/api/bootstrap", membro.token)).json();
const servidorVisto = comSkin.servers.find(item => item.id === servidor.id);
check("a cor chega a quem participa", servidorVisto?.accent === "#3366ff", JSON.stringify(servidorVisto));

check("dono pinta só o canal", (await skinCanal({ accent: "#00aa55" }, dono.token)).status === 204);
const comCanal = await (await get("/api/bootstrap", dono.token)).json();
const canalVisto = comCanal.rooms.find(item => item.id === texto.id);
check("o canal guarda a cor dele", canalVisto?.accent === "#00aa55", JSON.stringify(canalVisto));
// O canal sobrepõe campo a campo: mexeu só no destaque, o fundo continua o da casa.
check("o que o canal não define fica sem valor próprio",
  canalVisto?.bgColor === undefined || canalVisto?.bgColor === null, JSON.stringify(canalVisto));

// Tirar uma cor é diferente de nunca ter posto: `null` apaga.
check("null tira a cor", (await skinCanal({ accent: null }, dono.token)).status === 204);
const semCor = await (await get("/api/bootstrap", dono.token)).json();
const canalLimpo = semCor.rooms.find(item => item.id === texto.id);
check("a cor do canal saiu",
  canalLimpo?.accent === undefined || canalLimpo?.accent === null, JSON.stringify(canalLimpo));

// ------------------------------------------------- emote animado e teto
const gif = Buffer.concat([Buffer.from("GIF89a"), crypto.randomBytes(32)]);
const imagemGif = await enviar(gif, "image/gif", "danca.gif", dono.token);
const criadoGif = await criar({ serverId: servidor.id, name: "danca", fileId: imagemGif.id }, dono.token);
check("GIF vira emote", criadoGif.status === 201, String(criadoGif.status));
check("id do GIF termina em .gif (o cliente decide animado por ele)",
  (await criadoGif.json()).fileId?.endsWith(".gif"));

const pesado = await enviar(Buffer.concat([png, crypto.randomBytes(2 * 1024 * 1024)]), "image/png", "pesado.png", dono.token);
check("emote acima de 2 MB é recusado",
  (await criar({ serverId: servidor.id, name: "pesado", fileId: pesado.id }, dono.token)).status === 400);

// ------------------------------------------------- recado por servidor
const perfilCasa = corpo => put("/api/servers/" + servidor.id + "/member-profile", corpo, membro.token);
let casa = await (await perfilCasa({ nickname: null, avatarFile: null, recado: "de plantão" })).json();
check("recado da casa gravado", casa.recado === "de plantão", JSON.stringify(casa));
// Cliente anterior ao recado salva o perfil sem o campo: não pode apagar.
casa = await (await perfilCasa({ nickname: "Apelido", avatarFile: null })).json();
check("salvar sem o campo mantém o recado", casa.recado === "de plantão", JSON.stringify(casa));
casa = await (await perfilCasa({ nickname: null, avatarFile: null, recado: "" })).json();
check("recado vazio limpa", !casa.recado, JSON.stringify(casa));
check("recado longo é recusado",
  (await perfilCasa({ nickname: null, avatarFile: null, recado: "x".repeat(61) })).status === 400);

report();
