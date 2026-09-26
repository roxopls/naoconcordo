// Rolagem de dados, enquete, soundboard e o jogo na presenca.
//
// Rolagem e enquete moram dentro da mensagem, e o que interessa verificar e
// que o **servidor** decide o resultado: dado sorteado aqui, voto aplicado
// aqui, e nenhum dos dois reescrito por edicao depois.
//
// No soundboard a falha que importa e de autorizacao e de alcance: membro
// comum mexendo nos sons da casa, e o som chegando a quem nao esta na chamada.
// No jogo, o esconderijo: quem esta invisivel nao pode vazar o que joga.
import crypto from "node:crypto";
import { check, createUser, del, entrarNoServidor, get, post, put, report, socketFor } from "./test-common.mjs";

const dono = await createUser("cmddono");
const membro = await createUser("cmdmemb");

const servidor = await (await post("/api/servers",
  { name: "Mesa " + crypto.randomBytes(2).toString("hex") }, dono.token)).json();
await entrarNoServidor(servidor.id, dono, membro);
const boot = await (await get("/api/bootstrap", dono.token)).json();
const texto = boot.rooms.find(r => r.serverId === servidor.id && r.kind === "text");
const voz = boot.rooms.find(r => r.serverId === servidor.id && r.kind === "voice");

const abrir = async (token, consulta = "") => {
  const socket = socketFor(token, consulta);
  await socket.waitFor("welcome");
  return socket;
};
const mandar = (socket, corpo) => socket.ws.send(JSON.stringify(corpo));
const escrever = (socket, text) => mandar(socket, { type: "message", roomId: texto.id, text });
const respiro = ms => new Promise(resolve => setTimeout(resolve, ms));
/// A proxima presenca **do dono**: o membro tambem recebe a propria, que
/// chega na fila antes e nao interessa aqui.
const presencaDoDono = async socket => {
  for (;;) {
    const evento = await socket.waitFor("presenceChanged");
    if (evento.username === dono.username) return evento;
  }
};

const sDono = await abrir(dono.token);
const sMembro = await abrir(membro.token);

// ------------------------------------------------------------- rolagem
escrever(sDono, "/r 2d6+3 dano");
const rolada = (await sMembro.waitFor("message")).message;
check("rolagem chega com o resultado", rolada.rolagem?.expressao === "2d6+3", JSON.stringify(rolada.rolagem));
check("motivo separado da expressão", rolada.rolagem.motivo === "dano");
const faces = rolada.rolagem.termos[0].faces;
check("total confere com as faces", rolada.rolagem.total === faces[0] + faces[1] + 3, JSON.stringify(rolada.rolagem));
check("faces dentro do dado", faces.every(f => f >= 1 && f <= 6));

check("rolagem não pode ser editada",
  (await put("/api/messages/" + rolada.id, { text: "/r d100" }, dono.token)).status === 409);

escrever(sDono, "/r 0d6");
const aviso = await sDono.waitFor("aviso");
check("rolagem mal escrita volta como aviso", aviso.texto.length > 0);
escrever(sDono, "depois do erro");
const seguinte = (await sMembro.waitFor("message")).message;
check("rolagem mal escrita não vira mensagem", seguinte.text === "depois do erro", seguinte.text);

// ------------------------------------------------------------- enquete
escrever(sDono, "/enquete Que dia? | Sábado | Domingo");
const enquete = (await sMembro.waitFor("message")).message;
check("enquete chega com as opções", enquete.enquete?.opcoes.length === 2, JSON.stringify(enquete.enquete));

mandar(sMembro, { type: "votar", messageId: enquete.id, opcao: 0 });
let votada = (await sDono.waitFor("messageUpdated")).message;
check("voto conta", votada.enquete.opcoes[0].votos.length === 1);
mandar(sMembro, { type: "votar", messageId: enquete.id, opcao: 1 });
votada = (await sDono.waitFor("messageUpdated")).message;
check("trocar de opção move o voto",
  votada.enquete.opcoes[0].votos.length === 0 && votada.enquete.opcoes[1].votos.length === 1);
mandar(sMembro, { type: "votar", messageId: enquete.id, opcao: 1 });
votada = (await sDono.waitFor("messageUpdated")).message;
check("mesmo clique desfaz", votada.enquete.opcoes[1].votos.length === 0);

check("enquete não pode ser editada",
  (await put("/api/messages/" + enquete.id, { text: "/enquete x | a | b" }, dono.token)).status === 409);

const estranho = await createUser("cmdfora");
const sFora = await abrir(estranho.token);
mandar(sFora, { type: "votar", messageId: enquete.id, opcao: 0 });
await respiro(300);
mandar(sMembro, { type: "votar", messageId: enquete.id, opcao: 0 });
votada = (await sDono.waitFor("messageUpdated")).message;
check("quem não é do servidor não vota",
  votada.enquete.opcoes[0].votos.length === 1 && votada.enquete.opcoes[0].votos[0] === membro.username,
  JSON.stringify(votada.enquete.opcoes[0].votos));

// ---------------------------------------------------------- soundboard
const enviar = async (bytes, mime, nome, token) => (await fetch(
  (process.env.TEST_API || "http://127.0.0.1:3040") + "/api/files",
  { method: "POST", headers: { "content-type": mime, "x-file-name": nome, authorization: "Bearer " + token }, body: bytes },
)).json();
const audio = await enviar(Buffer.concat([Buffer.from("ID3"), crypto.randomBytes(64)]), "audio/mpeg", "buzina.mp3", dono.token);
const grande = await enviar(Buffer.concat([Buffer.from("ID3"), crypto.randomBytes(1024 * 1024 + 10)]), "audio/mpeg", "longo.mp3", dono.token);
const png = await enviar(Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), crypto.randomBytes(16)]), "image/png", "x.png", dono.token);

check("membro comum não cria som",
  (await post("/api/sons", { serverId: servidor.id, name: "Buzina", fileId: audio.id }, membro.token)).status === 403);
check("som que não é áudio é recusado",
  (await post("/api/sons", { serverId: servidor.id, name: "Img", fileId: png.id }, dono.token)).status === 400);
check("som acima de 1 MB é recusado",
  (await post("/api/sons", { serverId: servidor.id, name: "Longo", fileId: grande.id }, dono.token)).status === 400);
const criado = await post("/api/sons", { serverId: servidor.id, name: "Buzina", fileId: audio.id }, dono.token);
check("dono cria som", criado.status === 201, String(criado.status));
const som = await criado.json();
await sMembro.waitFor("sonsMudaram");
const bootMembro = await (await get("/api/bootstrap", membro.token)).json();
check("membro enxerga os sons da casa", (bootMembro.sons || []).some(item => item.id === som.id));
check("quem é de fora não enxerga",
  !((await (await get("/api/bootstrap", estranho.token)).json()).sons || []).some(item => item.id === som.id));

// Tocar exige estar na chamada; quem esta fora dela nao recebe.
mandar(sDono, { type: "som", som: som.id });
mandar(sDono, { type: "voice", roomId: voz.id });
await sDono.waitFor("voiceChanged");
await respiro(1600);
mandar(sDono, { type: "som", som: som.id });
const tocado = await sDono.waitFor("somTocado");
check("som toca para quem está na chamada", tocado.somId === som.id && tocado.username === dono.username);
await respiro(300);
let membroOuviu = false;
try { await Promise.race([sMembro.waitFor("somTocado"), respiro(400).then(() => { throw new Error("nada"); })]); membroOuviu = true; } catch { /* esperado */ }
check("som não chega a quem está fora da chamada", !membroOuviu);

// Duas vezes seguidas: a segunda cai no intervalo minimo.
mandar(sDono, { type: "som", som: som.id });
let repetiu = false;
try { await Promise.race([sDono.waitFor("somTocado"), respiro(500).then(() => { throw new Error("nada"); })]); repetiu = true; } catch { /* esperado */ }
check("som repetido em seguida é ignorado", !repetiu);

check("membro comum não apaga som", (await del("/api/sons/" + som.id, membro.token)).status === 403);
check("dono apaga som", (await del("/api/sons/" + som.id, dono.token)).status === 204);

// ------------------------------------------------------------------ jogo
mandar(sDono, { type: "jogo", text: "Hollow Knight" });
const jogando = await presencaDoDono(sMembro);
check("jogo chega na presença", jogando.jogo === "Hollow Knight", JSON.stringify(jogando));
const bootJogo = await (await get("/api/bootstrap", membro.token)).json();
check("jogo vem no bootstrap", bootJogo.jogos?.[dono.username.toLowerCase()] === "Hollow Knight", JSON.stringify(bootJogo.jogos));

mandar(sDono, { type: "status", roomId: "invisivel" });
const sumiu = await presencaDoDono(sMembro);
check("invisível não entrega o jogo", sumiu.online === false && !sumiu.jogo, JSON.stringify(sumiu));
const bootInvisivel = await (await get("/api/bootstrap", membro.token)).json();
check("invisível some dos jogos do bootstrap", !bootInvisivel.jogos?.[dono.username.toLowerCase()]);

mandar(sDono, { type: "status", roomId: "online" });
await presencaDoDono(sMembro);
mandar(sDono, { type: "jogo", text: "" });
const parou = await presencaDoDono(sMembro);
check("fechar o jogo limpa a presença", !parou.jogo, JSON.stringify(parou));

// --------------------------------------------------------- assistir junto
// O dono ainda esta no canal de voz desde o soundboard.
mandar(sDono, { type: "assistir", acao: "iniciar", text: "dQw4w9WgXcQ", posicao: 10 });
let video = await sMembro.waitFor("assistirEstado");
check("vídeo começa para o servidor", video.estado?.video === "dQw4w9WgXcQ" && video.estado.tocando, JSON.stringify(video));
check("posição inicial respeitada", video.estado.posicao >= 10 && video.estado.posicao < 12);
mandar(sDono, { type: "assistir", acao: "pausar", posicao: 42 });
video = await sMembro.waitFor("assistirEstado");
check("pausar fixa a posição", !video.estado.tocando && video.estado.posicao === 42, JSON.stringify(video.estado));
mandar(sDono, { type: "assistir", acao: "iniciar", text: "nao-e-um-id-valido" });
mandar(sMembro, { type: "assistir", acao: "parar" });
await respiro(400);
const bootVideo = await (await get("/api/bootstrap", membro.token)).json();
check("id inválido e quem está fora da chamada não mexem", bootVideo.assistindo?.[voz.id]?.posicao === 42, JSON.stringify(bootVideo.assistindo));
mandar(sDono, { type: "assistir", acao: "parar" });
video = await sMembro.waitFor("assistirEstado");
check("parar limpa o vídeo", video.estado === null);

// ---------------------------------------------------------------- mestre
// Desligado por padrao: sem o dono ligar, ninguem vira mestre.
mandar(sDono, { type: "mestre", acao: "assumir" });
await respiro(300);
check("modo mestre começa desligado", !(await (await get("/api/bootstrap", dono.token)).json()).mestres?.[voz.id]);
check("membro comum não liga o modo mestre",
  (await put("/api/servers/" + servidor.id + "/customize", { modoMestre: true }, membro.token)).status === 403);
const ligado = await (await put("/api/servers/" + servidor.id + "/customize", { modoMestre: true }, dono.token)).json();
check("dono liga o modo mestre", ligado.modoMestre === true, JSON.stringify(ligado));
// Ligado, mas ninguem escolhido: ainda nao da para assumir.
mandar(sDono, { type: "mestre", acao: "assumir" });
await respiro(300);
check("sem mestre escolhido ninguém assume", !(await (await get("/api/bootstrap", dono.token)).json()).mestres?.[voz.id]);
check("membro comum não escolhe mestre",
  (await put("/api/rooms/" + voz.id + "/mestre", { username: membro.username }, membro.token)).status === 403);
check("mestre precisa ser do servidor",
  (await put("/api/rooms/" + voz.id + "/mestre", { username: estranho.username }, dono.token)).status === 400);
check("dono escolhe o mestre do canal",
  (await put("/api/rooms/" + voz.id + "/mestre", { username: dono.username }, dono.token)).status === 204);
mandar(sDono, { type: "mestre", acao: "assumir" });
let mestre = await sMembro.waitFor("mestreMudou");
check("mestre assumido", mestre.username === dono.username && mestre.roomId === voz.id);
mandar(sMembro, { type: "mestre", acao: "assumir" });
await respiro(300);
check("fora da chamada não assume", (await (await get("/api/bootstrap", membro.token)).json()).mestres?.[voz.id] === dono.username);
mandar(sDono, { type: "mestre", acao: "largar" });
mestre = await sMembro.waitFor("mestreMudou");
check("mestre largado", mestre.username === null);

// Categoria: o canal sem mestre proprio herda o dela.
const categoria = await (await post("/api/categorias", { serverId: servidor.id, name: "Campanha" }, dono.token)).json();
await put("/api/rooms/" + voz.id + "/categoria", { categoryId: categoria.id }, dono.token);
await put("/api/rooms/" + voz.id + "/mestre", { username: null }, dono.token);
await put("/api/categorias/" + categoria.id + "/mestre", { username: dono.username }, dono.token);
const bootCat = await (await get("/api/bootstrap", dono.token)).json();
check("mestre fica na categoria", bootCat.categorias.find(c => c.id === categoria.id)?.mestre === dono.username);
mandar(sDono, { type: "mestre", acao: "assumir" });
mestre = await sMembro.waitFor("mestreMudou");
check("mestre da categoria assume no canal dela", mestre.username === dono.username);
await put("/api/categorias/" + categoria.id + "/mestre", { username: membro.username }, dono.token);
mestre = await sMembro.waitFor("mestreMudou");
check("trocar o mestre escolhido tira a prioridade de quem saiu", mestre.username === null);
await put("/api/categorias/" + categoria.id + "/mestre", { username: dono.username }, dono.token);
mandar(sDono, { type: "mestre", acao: "assumir" });
await sMembro.waitFor("mestreMudou");
await put("/api/servers/" + servidor.id + "/customize", { modoMestre: false }, dono.token);
mestre = await sMembro.waitFor("mestreMudou");
check("desligar o modo mestre tira o mestre da chamada", mestre.username === null);

// ------------------------------------------------------ sala temporaria
const temporaria = (corpo, token) => post("/api/rooms", { serverId: servidor.id, kind: "voice", temporaria: true, ...corpo }, token);
check("membro comum não cria canal fixo",
  (await post("/api/rooms", { serverId: servidor.id, kind: "voice", name: "Fixa" }, membro.token)).status === 403);
check("sala temporária de texto é recusada",
  (await temporaria({ name: "Texto", kind: "text" }, membro.token)).status === 400);
const criadaTemp = await temporaria({ name: "Sala do membro" }, membro.token);
check("membro comum cria sala temporária", criadaTemp.status === 201, String(criadaTemp.status));
const salaTemp = await criadaTemp.json();
check("sala sai marcada como temporária", salaTemp.temporaria === true);
check("quem é de fora não cria", (await temporaria({ name: "Intrusa" }, estranho.token)).status === 403);
mandar(sMembro, { type: "voice", roomId: salaTemp.id });
await sMembro.waitFor("voiceChanged");
mandar(sMembro, { type: "voice", roomId: "" });

// --------------------------------------------------------------- lembrete
escrever(sDono, "/lembrar amanhã 20h sem horário convertido");
check("lembrete sem instante volta como aviso", (await sDono.waitFor("aviso")).texto.length > 0);
mandar(sDono, { type: "message", roomId: texto.id, text: "/lembrar ontem", lembrete: { quando: new Date(Date.now() - 60_000).toISOString(), texto: "x" } });
check("lembrete no passado é recusado", /passou/.test((await sDono.waitFor("aviso")).texto));
mandar(sDono, { type: "message", roomId: texto.id, text: "/lembrar em 3s pizza", lembrete: { quando: new Date(Date.now() + 3000).toISOString(), texto: "pizza" } });
const pedido = (await sMembro.waitFor("message")).message;
check("pedido de lembrete vira mensagem", pedido.lembrete?.texto === "pizza" && !pedido.lembrete.disparado, JSON.stringify(pedido.lembrete));
check("lembrete não pode ser editado",
  (await put("/api/messages/" + pedido.id, { text: "/lembrar x" }, dono.token)).status === 409);
mandar(sDono, { type: "message", roomId: texto.id, text: "/lembrar em 3s cancelado", lembrete: { quando: new Date(Date.now() + 3000).toISOString(), texto: "cancelado" } });
const cancelado = (await sMembro.waitFor("message")).message;
await del("/api/messages/" + cancelado.id, dono.token);
await sMembro.waitFor("messageDeleted");

// A vigia roda a cada 15 s, e a sala temporaria some 30 s depois de esvaziar.
const esperarMensagem = async (socket, ms) => {
  const fim = Date.now() + ms;
  const vistas = [];
  while (Date.now() < fim) {
    try { vistas.push((await socket.waitFor("message")).message); } catch { /* timeout de 5 s, tenta de novo */ }
  }
  return vistas;
};
const chegaram = await esperarMensagem(sMembro, 34_000);
const disparados = chegaram.filter(m => m.lembrete?.disparado);
check("lembrete dispara na hora", disparados.length === 1 && disparados[0].lembrete.texto === "pizza" && disparados[0].replyTo === pedido.id,
  JSON.stringify(chegaram.map(m => m.lembrete)));
check("apagar o pedido cancela o lembrete", !disparados.some(m => m.lembrete.texto === "cancelado"));
const bootTemp = await (await get("/api/bootstrap", membro.token)).json();
check("sala temporária vazia some sozinha", !bootTemp.rooms.some(r => r.id === salaTemp.id));
check("canal fixo vazio continua", bootTemp.rooms.some(r => r.id === voz.id));

for (const socket of [sDono, sMembro, sFora]) socket.ws.close();
report();
