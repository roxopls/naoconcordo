// O registro de quem tenta entrar numa chamada.
//
// O que precisa valer, e o que este arquivo cobre:
// - **sucesso e fracasso no mesmo arquivo**. Só os fracassos não bastam: para
//   saber se "ninguém consegue entrar" é preciso ver que os outros conseguiram;
// - o motivo da recusa aparece, senão a linha não ajuda a investigar nada;
// - **só o administrador lê**. A lista diz quem esteve em qual canal e a que
//   horas, e isso não é da conta de todo mundo;
// - o registro sobrevive: é arquivo, não memória — o reinício do servidor é
//   justamente o que se faz quando algo dá errado.
import crypto from "node:crypto";
import { admin, check, createUser, entrarNoServidor, get, post, report } from "./test-common.mjs";

const dono = await createUser("chdono");
const estranho = await createUser("chestr");
const chefe = await admin();

const servidor = await (await post("/api/servers",
  { name: "Sala " + crypto.randomBytes(2).toString("hex") }, dono.token)).json();
const boot = await (await get("/api/bootstrap", dono.token)).json();
const voz = boot.rooms.find(r => r.serverId === servidor.id && r.kind === "voice");
const texto = boot.rooms.find(r => r.serverId === servidor.id && r.kind === "text");

const registro = async (linhas = 100) =>
  (await (await get("/api/admin/chamadas?linhas=" + linhas, chefe.token)).json()).linhas;

// -------------------------------------------------------------- uma que dá certo
check("entrar no canal de voz responde 200",
  (await post("/api/livekit-token", { roomId: voz.id }, dono.token)).status === 200);

// ------------------------------------------------------- e três que não dão
await post("/api/livekit-token", { roomId: texto.id }, dono.token);
await post("/api/livekit-token", { roomId: "nao-existe" }, dono.token);
await post("/api/livekit-token", { roomId: voz.id }, estranho.token);

const linhas = await registro();
const juntas = linhas.join("\n");

check("o sucesso foi anotado",
  linhas.some(l => l.includes(dono.username) && /\sok\s/.test(l)),
  juntas.slice(0, 400));
check("canal de texto aparece com o motivo",
  juntas.includes("canal de texto"), juntas.slice(0, 400));
check("canal inexistente aparece com o motivo",
  juntas.includes("canal nao encontrado"), juntas.slice(0, 400));
check("quem não participa aparece com o motivo",
  juntas.includes("nao participa do servidor"), juntas.slice(0, 400));
check("o nome de quem tentou está na linha",
  juntas.includes(estranho.username), juntas.slice(0, 400));
check("o canal está na linha", juntas.includes(voz.id), juntas.slice(0, 200));

// A mais nova vem primeiro: quem abre o registro quer ver o que acabou de
// acontecer, não o que aconteceu na semana passada.
check("a mais nova vem primeiro",
  linhas[0].includes(estranho.username), linhas[0]);

// ---------------------------------------------------- os três tipos separados
const tipos = await (async () => {
  await post("/api/livekit-token", { roomId: voz.id, screen: true }, dono.token);
  await post("/api/livekit-token", { roomId: voz.id, viewer: true }, dono.token);
  return (await registro()).join("\n");
})();
check("tela e câmeras entram separados da voz",
  tipos.includes(" tela ") && tipos.includes(" cameras ") && tipos.includes(" voz "),
  tipos.slice(0, 300));

// ------------------------------------------------------------- só o admin lê
check("membro comum não lê o registro",
  (await get("/api/admin/chamadas", dono.token)).status === 403);
check("sem sessão não lê o registro",
  (await get("/api/admin/chamadas")).status === 401);

// Pedido absurdo não derruba nem devolve o arquivo inteiro.
const muitas = await (await get("/api/admin/chamadas?linhas=999999", chefe.token)).json();
check("o limite de linhas é respeitado", muitas.linhas.length <= 500, String(muitas.linhas.length));

report();
