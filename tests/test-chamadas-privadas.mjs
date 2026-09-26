// Sinalizacao das chamadas privadas P2P. A midia nao passa pelo servidor;
// aqui se prova que ele so repassa sinal para quem esta na chamada, e para o
// socket certo.
import crypto from "node:crypto";
import { b64, post, put, get, check, results, createUser as novaConta, socketFor } from "./test-common.mjs";

async function createUser(label) {
  const s = await novaConta(label);
  const id = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  await put("/api/keys", { publicKey: b64(id.publicKey.export({ type: "spki", format: "der" }).subarray(-65)) }, s.token);
  return { username: s.username, token: s.token };
}
async function amigos(a, b) {
  await post("/api/friends/request", { username: b.username }, a.token);
  await post("/api/friends/accept", { username: a.username }, b.token);
}
const enviar = (s, obj) => s.ws.send(JSON.stringify(obj));
async function conectar(conta) {
  const s = socketFor(conta.token);
  const welcome = await s.waitFor("welcome");
  return { ...s, sessao: welcome.sessao };
}
/// Consome eventos do tipo ate aparecer um que satisfaca `cond`.
async function esperarQue(s, tipo, cond) {
  for (;;) { const e = await s.waitFor(tipo); if (cond(e)) return e; }
}
const semEvento = (s, tipo, ms = 600) => s.waitFor(tipo).then(() => false, () => true).then(v => v);

const ana = await createUser("ana");
const bia = await createUser("bia");
const caio = await createUser("caio");
await amigos(ana, bia);
// Grupo Ana+Bia. As chaves aqui nao importam: o servidor so confere o formato.
const emb = de => ({ de, ciphertext: b64("x".repeat(40)), nonce: b64("123456789012") });
const grupo = await (await post("/api/grupos", {
  membros: [bia.username], chaves: { [ana.username]: emb(ana.username), [bia.username]: emb(ana.username) },
}, ana.token)).json();
const chamada = "grupo:" + grupo.id;

const sa = await conectar(ana);
const sb = await conectar(bia);
const sb2 = await conectar(bia); // Bia com o app aberto em outra maquina
const sc = await conectar(caio);
check("welcomeTemSessao", typeof sa.sessao === "number" && sa.sessao !== sb.sessao && sb.sessao !== sb2.sessao);

// Caio nao e do grupo: entrar nao faz nada.
enviar(sc, { type: "chamadaEntrar", chamada });
check("estranhoNaoEntra", await semEvento(sa, "chamadaEstado"));

enviar(sa, { type: "chamadaEntrar", chamada, mudo: true });
const estadoA = await sa.waitFor("chamadaEstado");
check("estadoAoEntrar", estadoA.chamada === chamada && estadoA.participantes.length === 1 && estadoA.participantes[0].mudo === true);
const toque = await sb.waitFor("chamadaTocando");
check("tocaParaOsOutros", toque.chamada === chamada && toque.de === ana.username);
check("naoTocaParaQuemChama", await semEvento(sa, "chamadaTocando"));
check("naoTocaParaEstranho", await semEvento(sc, "chamadaTocando"));
await sb.waitFor("chamadaEstado"); await sb2.waitFor("chamadaTocando"); await sb2.waitFor("chamadaEstado");

// Bia entra pelo socket 1; o segundo toque nao acontece.
enviar(sb, { type: "chamadaEntrar", chamada });
const estadoB = await sa.waitFor("chamadaEstado");
check("doisNaChamada", estadoB.participantes.length === 2);
check("semToqueComChamadaAberta", await semEvento(sa, "chamadaTocando"));
await sb.waitFor("chamadaEstado"); await sb2.waitFor("chamadaEstado");

// Sinal da Ana para a sessao da Bia: chega so no socket que esta na chamada.
enviar(sa, { type: "sinal", chamada, para: sb.sessao, dados: { sdp: { type: "offer", sdp: "v=0" } } });
const sinal = await sb.waitFor("sinal");
check("sinalChega", sinal.de === ana.username && sinal.deSessao === sa.sessao && sinal.dados.sdp.type === "offer");
check("sinalSoNoSocketCerto", await semEvento(sb2, "sinal"));
// Sinal para quem nao esta na chamada nao sai.
enviar(sa, { type: "sinal", chamada, para: sb2.sessao, dados: { ice: 1 } });
check("sinalParaForaDaChamadaNaoSai", await semEvento(sb2, "sinal"));
// Quem nao esta na chamada nao manda sinal.
enviar(sc, { type: "sinal", chamada, para: sb.sessao, dados: { ice: 1 } });
check("estranhoNaoSinaliza", await semEvento(sb, "sinal"));

// Estado de midia.
enviar(sb, { type: "chamadaMidia", camera: true, mudo: false });
const midia = await sa.waitFor("chamadaEstado");
check("estadoDeMidia", midia.participantes.find(p => p.username === bia.username)?.camera === true);

const lista = await (await get("/api/chamadas", bia.token)).json();
check("listaDeChamadas", lista[chamada]?.length === 2);
const listaCaio = await (await get("/api/chamadas", caio.token)).json();
check("listaSoDoQueEuVejo", !listaCaio[chamada]);

// Socket cai: sai da chamada.
sb.ws.close();
const caiu = await sa.waitFor("chamadaEstado");
check("quedaTiraDaChamada", caiu.participantes.length === 1 && caiu.participantes[0].username === ana.username);
enviar(sa, { type: "chamadaSair" });
const acabou = await esperarQue(sb2, "chamadaEstado", e => e.participantes.length === 0).catch(() => null);
check("chamadaAcaba", acabou?.chamada === chamada);

await esperarQue(sa, "chamadaEstado", e => e.participantes.length === 0);
// Chamada a dois pela conversa privada: nome em ordem e so entre amigos.
const [x, y] = [ana.username.toLowerCase(), bia.username.toLowerCase()].sort();
enviar(sa, { type: "chamadaEntrar", chamada: "dm:" + y + "|" + x });
check("parForaDeOrdemRecusado", await semEvento(sa, "chamadaEstado"));
enviar(sa, { type: "chamadaEntrar", chamada: "dm:" + x + "|" + y });
check("chamadaDm", (await sa.waitFor("chamadaEstado")).participantes.length === 1);
check("dmTocaParaOAmigo", (await sb2.waitFor("chamadaTocando")).de === ana.username);
const [p, q] = [ana.username.toLowerCase(), caio.username.toLowerCase()].sort();
enviar(sc, { type: "chamadaEntrar", chamada: "dm:" + p + "|" + q });
check("dmSoEntreAmigos", await semEvento(sc, "chamadaEstado"));

const ice = await (await get("/api/ice", ana.token)).json();
check("iceResponde", Array.isArray(ice.iceServers));

for (const s of [sa, sb2, sc]) s.ws.close();
console.log(JSON.stringify(results, null, 2));
