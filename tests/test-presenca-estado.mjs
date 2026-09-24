// Estados de presenca: disponivel, ausente, ocupado e "aparecer offline".
//
// O que importa aqui e o que os **outros** enxergam. Invisivel tem que sair
// igual a quem fechou o app — nem na lista de online, nem como estado, nem por
// um instante ao conectar (foi por isso que o estado passou a vir na propria
// conexao, e nao numa mensagem depois dela).
import crypto from "node:crypto";
import { check, createUser, entrarNoServidor, get, post, report, socketFor } from "./test-common.mjs";

const quem = await createUser("estado");
const vizinho = await createUser("vizinho");
const servidor = await (await post("/api/servers",
  { name: "Estado " + crypto.randomBytes(2).toString("hex") }, quem.token)).json();
await entrarNoServidor(servidor.id, quem, vizinho);

const respiro = () => new Promise(resolve => setTimeout(resolve, 400));
const abrir = async (token, consulta) => {
  const socket = socketFor(token, consulta);
  await socket.waitFor("welcome");
  return socket;
};
const visao = async () => (await get("/api/bootstrap", vizinho.token)).json();
/// Proximo aviso de presenca **desta** pessoa, na visao do vizinho.
const avisoDe = async (socket, username) => {
  for (;;) {
    const evento = await socket.waitFor("presenceChanged");
    if (evento.username === username) return evento;
  }
};
const status = (socket, valor) => socket.ws.send(JSON.stringify({ type: "status", roomId: valor }));

const olho = await abrir(vizinho.token);

// Conectar sem estado (cliente antigo): online, "online".
let meu = await abrir(quem.token);
let aviso = await avisoDe(olho, quem.username);
check("semEstadoEntraOnline", aviso.online === true && aviso.presenca === "online", JSON.stringify(aviso));

status(meu, "ocupado");
aviso = await avisoDe(olho, quem.username);
check("ocupadoAnunciado", aviso.online === true && aviso.presenca === "ocupado", JSON.stringify(aviso));
let boot = await visao();
check("ocupadoNoBootstrap", boot.estados?.[quem.username] === "ocupado", JSON.stringify(boot.estados));

status(meu, "invisivel");
aviso = await avisoDe(olho, quem.username);
check("invisivelSaiComoOffline", aviso.online === false && !aviso.presenca, JSON.stringify(aviso));
boot = await visao();
check("invisivelForaDoOnline", !boot.online.includes(quem.username), JSON.stringify(boot.online));
check("invisivelSemEstado", !(quem.username in (boot.estados || {})), JSON.stringify(boot.estados));

status(meu, "qualquercoisa");
aviso = await avisoDe(olho, quem.username);
check("estadoInvalidoViraOnline", aviso.online === true && aviso.presenca === "online", JSON.stringify(aviso));

// Fechar leva o estado junto.
status(meu, "ausente");
await avisoDe(olho, quem.username);
meu.ws.close();
aviso = await avisoDe(olho, quem.username);
check("fecharFicaOffline", aviso.online === false, JSON.stringify(aviso));
await respiro();

// Reconectar ja invisivel: nenhum aviso de online no caminho.
meu = await abrir(quem.token, "&estado=invisivel");
aviso = await avisoDe(olho, quem.username);
check("conectaInvisivelSemPiscar", aviso.online === false, JSON.stringify(aviso));
boot = await visao();
check("conectaInvisivelForaDoOnline", !boot.online.includes(quem.username), JSON.stringify(boot.online));
meu.ws.close();
await avisoDe(olho, quem.username);
await respiro();

// Reconectar ocupado: ja chega ocupado.
meu = await abrir(quem.token, "&estado=ocupado");
aviso = await avisoDe(olho, quem.username);
check("conectaOcupado", aviso.online === true && aviso.presenca === "ocupado", JSON.stringify(aviso));
meu.ws.close();
await avisoDe(olho, quem.username);
await respiro();

// Estado inventado na conexao nao passa.
meu = await abrir(quem.token, "&estado=" + encodeURIComponent("<b>x</b>"));
aviso = await avisoDe(olho, quem.username);
check("conexaoEstadoInvalido", aviso.online === true && aviso.presenca === "online", JSON.stringify(aviso));

meu.ws.close();
olho.ws.close();
report();
