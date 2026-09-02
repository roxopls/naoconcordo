// Prova o isolamento entre servidores e as regras de dono, moderador e membro.
import crypto from "node:crypto";
import { post, get, check, results, createUser, entrarNoServidor, socketFor } from "./test-common.mjs";

const boot = token => get("/api/bootstrap", token).then(r => r.json());

const dono = await createUser("dono");
const mod = await createUser("mod");
const membro = await createUser("membro");
const estranho = await createUser("estranho");

// Criar servidor não exige mais código de proprietário: qualquer conta cria e
// vira dona do que criou.
const servidor = await (await post("/api/servers", { name: "Ilha " + crypto.randomBytes(2).toString("hex") }, dono.token)).json();

let visao = await boot(dono.token);
check("criadorEhDono", visao.roles[servidor.id] === "owner");
check("servidorNasceComDoisCanais", visao.rooms.filter(r => r.serverId === servidor.id).length === 2);

// Quem não foi convidado não enxerga nada do servidor.
visao = await boot(estranho.token);
check("estranhoNaoVeServidor", !visao.servers.some(s => s.id === servidor.id));
check("estranhoNaoVeCanais", !visao.rooms.some(r => r.serverId === servidor.id));

// Nem consegue entrar na chamada dele.
const canalVoz = (await boot(dono.token)).rooms.find(r => r.serverId === servidor.id && r.kind === "voice");
const invasao = await post("/api/livekit-token", { roomId: canalVoz.id }, estranho.token);
check("estranhoSemTokenDeMidia", invasao.status === 403, String(invasao.status));

// Token de tela: identidade propria, para a captura nativa entrar na sala como
// um segundo participante sem derrubar a conexao da pessoa.
const decodificar = jwt => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
const tokenTela = await post("/api/livekit-token", { roomId: canalVoz.id, screen: true }, dono.token);
check("donoRecebeTokenDeTela", tokenTela.status === 200, String(tokenTela.status));
const claimsTela = decodificar((await tokenTela.json()).token);
const tokenNormal = await post("/api/livekit-token", { roomId: canalVoz.id }, dono.token);
const claimsNormal = decodificar((await tokenNormal.json()).token);
check("telaTemIdentidadeSeparada", claimsTela.sub !== claimsNormal.sub && claimsTela.sub.endsWith("#tela"), claimsTela.sub);
check("telaMantemONome", claimsTela.name === claimsNormal.name, claimsTela.name);
check("telaPublicaMasNaoAssina", claimsTela.video.canPublish === true && claimsTela.video.canSubscribe === false, JSON.stringify(claimsTela.video));
// `hidden` esconderia a faixa de todo mundo, e o compartilhamento nao chegaria.
check("telaNaoEhOculta", claimsTela.video.hidden === false, String(claimsTela.video.hidden));
check("telaMarcadaNoMetadata", JSON.parse(claimsTela.metadata || "{}").kind === "screen", String(claimsTela.metadata));
const telaDeEstranho = await post("/api/livekit-token", { roomId: canalVoz.id, screen: true }, estranho.token);
check("estranhoSemTokenDeTela", telaDeEstranho.status === 403, String(telaDeEstranho.status));

// Convidar exige ser dono ou moderador.
const tentativa = await post("/api/servers/members/add", { serverId: servidor.id, username: membro.username }, estranho.token);
check("estranhoNaoConvida", tentativa.status === 403, String(tentativa.status));

// Convite ficou em duas etapas: pendente ate a pessoa aceitar.
check("donoConvidaMod", (await post("/api/servers/members/add", { serverId: servidor.id, username: mod.username }, dono.token)).status === 204);
check("conviteNaoDuplica", (await post("/api/servers/members/add", { serverId: servidor.id, username: mod.username }, dono.token)).status === 409);
const pendentes = await (await get("/api/servers/invites", mod.token)).json();
const conviteDoMod = pendentes.invites.find(item => item.serverId === servidor.id);
check("convitePendenteAparece", Boolean(conviteDoMod) && conviteDoMod.from === dono.username && conviteDoMod.serverName === servidor.name);
check("conviteNaoEntraSozinho", !(await boot(mod.token)).servers.some(s => s.id === servidor.id));
check("outroNaoResponde", (await post("/api/servers/invites/accept", { inviteId: conviteDoMod.id }, estranho.token)).status === 404);
check("modAceita", (await post("/api/servers/invites/accept", { inviteId: conviteDoMod.id }, mod.token)).status === 204);
check("conviteSomeDepoisDeAceitar", !(await (await get("/api/servers/invites", mod.token)).json()).invites.some(item => item.id === conviteDoMod.id));
check("aceitarDeNovo404", (await post("/api/servers/invites/accept", { inviteId: conviteDoMod.id }, mod.token)).status === 404);

// Recusar tira o convite e nao coloca ninguem dentro.
check("donoConvidaEstranho", (await post("/api/servers/members/add", { serverId: servidor.id, username: estranho.username }, dono.token)).status === 204);
const recusado = (await (await get("/api/servers/invites", estranho.token)).json()).invites.find(item => item.serverId === servidor.id);
check("estranhoRecusa", (await post("/api/servers/invites/reject", { inviteId: recusado.id }, estranho.token)).status === 204);
check("recusaNaoEntra", !(await boot(estranho.token)).servers.some(s => s.id === servidor.id));

await entrarNoServidor(servidor.id, dono, membro);

visao = await boot(membro.token);
check("membroPassaAVerServidor", visao.servers.some(s => s.id === servidor.id));
check("membroEntraComoMembro", visao.roles[servidor.id] === "member");

// Membro comum não cria canal nem convida.
check("membroNaoCriaCanal", (await post("/api/rooms", { name: "proibido", serverId: servidor.id, kind: "text" }, membro.token)).status === 403);
check("membroNaoConvida", (await post("/api/servers/members/add", { serverId: servidor.id, username: estranho.username }, membro.token)).status === 403);

// Promover a moderador é coisa de dono.
check("membroNaoPromove", (await post("/api/servers/members/role", { serverId: servidor.id, username: membro.username, role: "mod" }, membro.token)).status === 403);
check("donoPromoveMod", (await post("/api/servers/members/role", { serverId: servidor.id, username: mod.username, role: "mod" }, dono.token)).status === 204);

visao = await boot(mod.token);
check("modVeSeuPapel", visao.roles[servidor.id] === "mod");
check("modCriaCanal", (await post("/api/rooms", { name: "moderado", serverId: servidor.id, kind: "text" }, mod.token)).status === 201);

// Hierarquia ao expulsar.
check("modNaoExpulsaDono", (await post("/api/servers/members/remove", { serverId: servidor.id, username: dono.username }, mod.token)).status === 403);
check("modExpulsaMembro", (await post("/api/servers/members/remove", { serverId: servidor.id, username: membro.username }, mod.token)).status === 204);
visao = await boot(membro.token);
check("expulsoPerdeAcesso", !visao.servers.some(s => s.id === servidor.id));

// Dono não some sem passar o bastão.
check("donoNaoSaiSemTransferir", (await post("/api/servers/leave", { serverId: servidor.id }, dono.token)).status === 400);
check("modPodeSair", (await post("/api/servers/leave", { serverId: servidor.id }, mod.token)).status === 204);

// Transferência de dono rebaixa o antigo, sem ficar com dois.
await entrarNoServidor(servidor.id, dono, membro);
check("transfereDono", (await post("/api/servers/members/role", { serverId: servidor.id, username: membro.username, role: "owner" }, dono.token)).status === 204);
const lista = await (await get("/api/servers/" + encodeURIComponent(servidor.id) + "/members", dono.token)).json();
check("apenasUmDono", lista.members.filter(m => m.role === "owner").length === 1);
check("antigoDonoVirouMod", lista.members.find(m => m.username === dono.username).role === "mod");
check("novoDonoEhOMembro", lista.members.find(m => m.username === membro.username).role === "owner");

// Aviso em tempo real: sem isso o servidor só aparecia ao reabrir o app.
const socketMembro = socketFor(membro.token);
const socketConvidado = socketFor(mod.token);
await socketMembro.waitFor("welcome");
await socketConvidado.waitFor("welcome");
check("convidarAvisaNaHora", (await post("/api/servers/members/add", { serverId: servidor.id, username: mod.username }, membro.token)).status === 204);
const avisoConvite = await socketConvidado.waitFor("serverInvited");
check("conviteChegaPeloSocket", avisoConvite.invite.serverId === servidor.id && avisoConvite.invite.to === mod.username);
check("aceiteViaSocket", (await post("/api/servers/invites/accept", { inviteId: avisoConvite.invite.id }, mod.token)).status === 204);
const entrou = await socketConvidado.waitFor("serverJoined");
check("entradaTrazCanais", entrou.server.id === servidor.id && entrou.rooms.length >= 2 && entrou.role === "member");
const resolvido = await socketMembro.waitFor("serverInviteResolved");
check("quemConvidouSabeDaResposta", resolvido.accepted === true && resolvido.username === mod.username);
await socketMembro.waitFor("membersChanged");

check("promoverAvisaNaHora", (await post("/api/servers/members/role", { serverId: servidor.id, username: mod.username, role: "mod" }, membro.token)).status === 204);
const papel = await socketConvidado.waitFor("roleChanged");
check("papelNovoChegaNoSocket", papel.serverId === servidor.id && papel.role === "mod");

check("expulsarAvisaNaHora", (await post("/api/servers/members/remove", { serverId: servidor.id, username: mod.username }, membro.token)).status === 204);
const saiu = await socketConvidado.waitFor("serverLeft");
check("expulsoRecebeServerLeft", saiu.serverId === servidor.id);
socketMembro.ws.close(); socketConvidado.ws.close();

// Apagar o servidor é só do dono novo.
check("modNaoApaga", (await post("/api/servers/delete", { serverId: servidor.id }, dono.token)).status === 403);
check("donoApaga", (await post("/api/servers/delete", { serverId: servidor.id }, membro.token)).status === 204);
visao = await boot(membro.token);
check("servidorSumiu", !visao.servers.some(s => s.id === servidor.id));
check("canaisSumiram", !visao.rooms.some(r => r.serverId === servidor.id));

console.log(JSON.stringify(results, null, 2));
