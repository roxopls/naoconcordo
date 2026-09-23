// Quem aparece na lista do canal de voz, e por qual conexão.
//
// A lista existe para quem está **fora** da chamada: o LiveKit só enxerga a
// sala em que você já entrou, então é o servidor que conta quem está lá. Ela é
// alimentada pelo WebSocket, e o que este arquivo cobre é o que acontece
// quando a mesma conta tem mais de um socket aberto.
//
// O defeito que motivou estas verificações (2026-09-22): a limpeza da saída
// apagava por **nome**. Quando a rede pisca, o socket novo abre e reanuncia o
// canal antes de o velho terminar de morrer — e a limpeza atrasada do velho
// apagava o registro que o novo acabara de fazer. A pessoa sumia da lista para
// quem estava fora da chamada, enquanto o LiveKit seguia com ela dentro.
import crypto from "node:crypto";
import { check, createUser, get, post, report, socketFor } from "./test-common.mjs";

const pessoa = await createUser("vozpres");

const servidor = await (await post("/api/servers",
  { name: "Voz " + crypto.randomBytes(2).toString("hex") }, pessoa.token)).json();
const boot = await (await get("/api/bootstrap", pessoa.token)).json();
const voz = boot.rooms.find(r => r.serverId === servidor.id && r.kind === "voice");

/// Quem o servidor diz que está no canal, na visão de quem está fora dele.
const naSala = async () => {
  const atual = await (await get("/api/bootstrap", pessoa.token)).json();
  return atual.voice?.[voz.id] || [];
};

const anunciar = (socket, roomId) => socket.ws.send(JSON.stringify({ type: "voice", roomId }));
const abrir = async token => {
  const socket = socketFor(token);
  await socket.waitFor("welcome");
  return socket;
};
/// O fechamento é assíncrono do lado do servidor: dá um respiro para a limpeza
/// daquele socket acontecer antes de perguntar quem sobrou.
const fechar = async socket => {
  socket.ws.close();
  await new Promise(resolve => setTimeout(resolve, 400));
};

// ------------------------------------------------------- um socket só
const antigo = await abrir(pessoa.token);
anunciar(antigo, voz.id);
await antigo.waitFor("voiceChanged");
check("quem anuncia aparece no canal", (await naSala()).length === 1, JSON.stringify(await naSala()));

// ------------------------------------- dois sockets da mesma conta, uma pessoa
//
// Com o app aberto em duas máquinas são duas conexões e uma pessoa só: a lista
// é de gente, não de sockets.
const novo = await abrir(pessoa.token);
anunciar(novo, voz.id);
await novo.waitFor("voiceChanged");
check("a mesma conta não aparece duas vezes", (await naSala()).length === 1, JSON.stringify(await naSala()));

// ----------------------------------------- o socket velho cai por último
//
// **A regressão.** O socket velho morre depois de o novo já ter se anunciado.
// A limpeza dele só pode desfazer o que ele mesmo declarou.
await fechar(antigo);
check("a saída do socket velho não apaga o anúncio do novo",
  (await naSala()).length === 1, JSON.stringify(await naSala()));

// ------------------------------------------- e o último a sair esvazia a sala
await fechar(novo);
check("fechado o último socket, o canal fica vazio",
  (await naSala()).length === 0, JSON.stringify(await naSala()));

// --------------------------------------------- sair pelo aviso, sem fechar
const sozinho = await abrir(pessoa.token);
anunciar(sozinho, voz.id);
await sozinho.waitFor("voiceChanged");
check("voltou a aparecer depois de reanunciar", (await naSala()).length === 1);
anunciar(sozinho, "");
await sozinho.waitFor("voiceChanged");
check("sala vazia no aviso tira a pessoa do canal", (await naSala()).length === 0);
await fechar(sozinho);

report();
