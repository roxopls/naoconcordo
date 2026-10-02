// Sair da chamada encerra a sessão no servidor de voz.
//
// Cada pessoa pode ter três conexões na sala: a dela, a da captura de tela
// (`nome#tela`) e a da janela de câmeras (`nome#cameras`). O defeito que motivou
// isto (2026-10-01): compartilhando a tela num computador e entrando na chamada
// por outro, a tela do primeiro continuava no ar — a conexão da pessoa caía por
// identidade repetida, a da captura não.
//
// Aqui um LiveKit de mentira anota os pedidos de remoção. O que se confere é
// **quem** o servidor manda remover em cada situação, e principalmente quem ele
// não pode remover.
import http from "node:http";
import crypto from "node:crypto";
import { check, createUser, get, post, report, socketFor } from "./test-common.mjs";

const pessoa = await createUser("encerr");
const nome = pessoa.username;

const porta = Number(process.env.TEST_LIVEKIT_API_PORT || 7899);
const pedidos = [];
const falso = http.createServer((req, res) => {
  let corpo = "";
  req.on("data", pedaco => { corpo += pedaco; });
  req.on("end", () => {
    const [, miolo] = (req.headers.authorization || "").replace("Bearer ", "").split(".");
    let claims = {};
    try { claims = JSON.parse(Buffer.from(miolo || "", "base64url").toString()); } catch { /* sem token */ }
    const pedido = { rota: req.url, ...JSON.parse(corpo || "{}"), claims };
    // So os desta suite: a limpeza roda em segundo plano no servidor, e a de uma
    // suite anterior ainda pode estar a caminho quando esta comeca a escutar.
    if (String(pedido.identity).startsWith(nome)) pedidos.push(pedido);
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"code":"not_found","msg":"participant not found"}');
  });
});
await new Promise(pronto => falso.listen(porta, "127.0.0.1", pronto));

const respiro = (ms = 500) => new Promise(resolve => setTimeout(resolve, ms));
/// Identidades pedidas desde a última leitura, em ordem alfabética.
const colher = async () => {
  await respiro();
  const lista = pedidos.splice(0).map(p => p.room + " " + p.identity).sort();
  return lista;
};
const esperado = (...itens) => JSON.stringify(itens.sort());

const servidor = await (await post("/api/servers",
  { name: "Enc " + crypto.randomBytes(2).toString("hex") }, pessoa.token)).json();
const boot = await (await get("/api/bootstrap", pessoa.token)).json();
const canalA = boot.rooms.find(r => r.serverId === servidor.id && r.kind === "voice");
const canalB = await (await post("/api/rooms",
  { name: "outra", serverId: servidor.id, kind: "voice" }, pessoa.token)).json();
const salaA = "naoconcordo-" + canalA.id;
const salaB = "naoconcordo-" + canalB.id;

const anunciar = (socket, roomId) => socket.ws.send(JSON.stringify({ type: "voice", roomId }));
const abrir = async () => { const s = socketFor(pessoa.token); await s.waitFor("welcome"); return s; };
const pedirToken = extra => post("/api/livekit-token", { roomId: canalA.id, ...extra }, pessoa.token);

// ------------------------------------------------------------ sair pelo aviso
const um = await abrir();
anunciar(um, canalA.id);
await um.waitFor("voiceChanged");
check("entrar no canal não remove ninguém", JSON.stringify(await colher()) === "[]");

anunciar(um, "");
await um.waitFor("voiceChanged");
const aoSair = await colher();
check("sair encerra as três conexões da pessoa na sala",
  JSON.stringify(aoSair) === esperado(salaA + " " + nome, salaA + " " + nome + "#tela", salaA + " " + nome + "#cameras"),
  JSON.stringify(aoSair));

// -------------------------------------------------------------- o pedido em si
anunciar(um, canalA.id); await um.waitFor("voiceChanged");
anunciar(um, ""); await um.waitFor("voiceChanged");
await respiro();
const amostra = pedidos[0];
check("vai na rota de remover participante",
  amostra?.rota === "/twirp/livekit.RoomService/RemoveParticipant", String(amostra?.rota));
check("o token é de administrador só daquela sala",
  amostra?.claims?.video?.roomAdmin === true && amostra?.claims?.video?.room === salaA,
  JSON.stringify(amostra?.claims?.video));
pedidos.splice(0);

// --------------------------------------------------------------- trocar de canal
anunciar(um, canalA.id); await um.waitFor("voiceChanged");
anunciar(um, canalB.id); await um.waitFor("voiceChanged");
const aoTrocar = await colher();
check("trocar de canal encerra só o canal antigo",
  aoTrocar.length === 3 && aoTrocar.every(item => item.startsWith(salaA + " ")), JSON.stringify(aoTrocar));

anunciar(um, canalB.id);
check("anunciar de novo o mesmo canal não remove nada", JSON.stringify(await colher()) === "[]");
anunciar(um, ""); await um.waitFor("voiceChanged");
await colher();

// ------------------------------------- a mesma conta em dois sockets, um sai
//
// O aplicativo aberto em duas máquinas: enquanto uma delas se anuncia no canal,
// a sessão vale, e a saída da outra não pode derrubá-la.
const dois = await abrir();
anunciar(um, canalA.id); await um.waitFor("voiceChanged");
anunciar(dois, canalA.id); await respiro(300);
anunciar(um, ""); await respiro(300);
check("com outro socket da conta no canal, sair de um não encerra a sessão",
  JSON.stringify(await colher()) === "[]");

// ---------------------------------------------------- socket que cai, sem aviso
//
// A conversa e a mídia andam por caminhos diferentes: o socket cai com a
// chamada perfeita. Queda de socket não pode virar queda de chamada.
dois.ws.close();
check("queda de socket não encerra a chamada", JSON.stringify(await colher(900)) === "[]");

// -------------------------------------------------------------- ao entrar
//
// Tela e câmeras só nascem depois de a pessoa entrar. O que houver delas na
// sala no momento da entrada é resto de outra sessão — o outro computador.
check("token emitido", (await pedirToken({})).status === 200);
const aoEntrar = await colher();
check("entrar limpa a tela e as câmeras antigas, e não a própria pessoa",
  JSON.stringify(aoEntrar) === esperado(salaA + " " + nome + "#tela", salaA + " " + nome + "#cameras"),
  JSON.stringify(aoEntrar));

await pedirToken({ screen: true });
await pedirToken({ viewer: true });
check("token de tela e de câmeras não limpa nada", JSON.stringify(await colher()) === "[]");

// ------------------------------------- aviso de saída atrasado, depois do token
//
// Sair e entrar de novo na mesma sala: o aviso de saída vem pelo socket e o
// pedido de token por HTTP, sem ordem garantida. Com o aviso chegando depois,
// remover a pessoa derrubaria a sessão que acabou de nascer.
anunciar(um, canalA.id); await um.waitFor("voiceChanged");
await pedirToken({});
await colher();
anunciar(um, ""); await um.waitFor("voiceChanged");
const atrasado = await colher();
check("quem acabou de pegar token não é removido por um aviso de saída atrasado",
  !atrasado.includes(salaA + " " + nome), JSON.stringify(atrasado));

um.ws.close();
falso.close();
report();
