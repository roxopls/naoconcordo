// Categorias agrupam canais de texto e de voz dentro de um servidor.
//
// O que precisa valer, e o que este arquivo cobre:
// - só dono ou moderador organiza. Membro comum não renomeia nem apaga grupo,
//   e estranho não enxerga nem que existe;
// - **apagar a categoria não apaga os canais.** Meses de conversa de campanha
//   não somem porque alguém quis desfazer a organização;
// - canal só entra em categoria do próprio servidor, senão daria para escondê-lo
//   num grupo que ninguém daquele servidor vê;
// - a ordem é escolhida, não alfabética: "Campanha 2" tem de poder vir antes de
//   "Campanha 10".
import crypto from "node:crypto";
import { check, createUser, del, entrarNoServidor, get, post, put, report } from "./test-common.mjs";

const boot = token => get("/api/bootstrap", token).then(r => r.json());

const dono = await createUser("cdono");
const membro = await createUser("cmemb");
const estranho = await createUser("cestr");

const servidor = await (await post("/api/servers",
  { name: "Mesa " + crypto.randomBytes(2).toString("hex") }, dono.token)).json();
await entrarNoServidor(servidor.id, dono, membro);

// ------------------------------------------------------------------ criar
const criada = await post("/api/categorias", { serverId: servidor.id, name: "Campanha 1" }, dono.token);
check("dono cria categoria", criada.status === 201, String(criada.status));
const campanha1 = await criada.json();

const curta = await post("/api/categorias", { serverId: servidor.id, name: "x" }, dono.token);
check("nome curto demais é recusado", curta.status === 400, String(curta.status));

const porMembro = await post("/api/categorias", { serverId: servidor.id, name: "Minha" }, membro.token);
check("membro comum não cria categoria", porMembro.status === 403, String(porMembro.status));

const porEstranho = await post("/api/categorias", { serverId: servidor.id, name: "Invasao" }, estranho.token);
check("estranho não cria categoria", porEstranho.status === 403, String(porEstranho.status));

// ------------------------------------------------------------------- ver
const visaoDono = await boot(dono.token);
check("a categoria aparece para o dono",
  visaoDono.categorias.some(c => c.id === campanha1.id), JSON.stringify(visaoDono.categorias));
const visaoMembro = await boot(membro.token);
check("e para o membro também",
  visaoMembro.categorias.some(c => c.id === campanha1.id));
const visaoEstranho = await boot(estranho.token);
check("estranho não vê categoria de servidor alheio",
  !visaoEstranho.categorias.some(c => c.id === campanha1.id),
  JSON.stringify(visaoEstranho.categorias));

// ----------------------------------------------------------- mover canal
const canalTexto = visaoDono.rooms.find(r => r.serverId === servidor.id && r.kind === "text");
const canalVoz = visaoDono.rooms.find(r => r.serverId === servidor.id && r.kind === "voice");

check("dono põe canal de texto na categoria",
  (await put("/api/rooms/" + canalTexto.id + "/categoria", { categoryId: campanha1.id }, dono.token)).status === 204);
check("e o de voz na mesma categoria",
  (await put("/api/rooms/" + canalVoz.id + "/categoria", { categoryId: campanha1.id }, dono.token)).status === 204);

const comGrupo = await boot(dono.token);
check("os dois tipos convivem no mesmo grupo",
  comGrupo.rooms.filter(r => r.categoryId === campanha1.id).length === 2,
  JSON.stringify(comGrupo.rooms.map(r => [r.id, r.categoryId])));

check("membro comum não move canal",
  (await put("/api/rooms/" + canalTexto.id + "/categoria", { categoryId: null }, membro.token)).status === 403);

// Categoria de outro servidor não serve.
const outro = await (await post("/api/servers",
  { name: "Outra " + crypto.randomBytes(2).toString("hex") }, dono.token)).json();
const daOutra = await (await post("/api/categorias", { serverId: outro.id, name: "De fora" }, dono.token)).json();
check("canal não entra em categoria de outro servidor",
  (await put("/api/rooms/" + canalTexto.id + "/categoria", { categoryId: daOutra.id }, dono.token)).status === 404);

// ---------------------------------------------------------------- ordenar
const campanha2 = await (await post("/api/categorias", { serverId: servidor.id, name: "Campanha 2" }, dono.token)).json();
const ordem = t => t.categorias.filter(c => c.serverId === servidor.id).map(c => c.name);
check("a nova entra no fim",
  JSON.stringify(ordem(await boot(dono.token))) === JSON.stringify(["Campanha 1", "Campanha 2"]),
  JSON.stringify(ordem(await boot(dono.token))));

check("subir responde 204",
  (await post("/api/categorias/" + campanha2.id + "/mover", { acima: true }, dono.token)).status === 204);
check("a ordem escolhida vale, e não a alfabética",
  JSON.stringify(ordem(await boot(dono.token))) === JSON.stringify(["Campanha 2", "Campanha 1"]),
  JSON.stringify(ordem(await boot(dono.token))));

check("subir a primeira não faz nada e não quebra",
  (await post("/api/categorias/" + campanha2.id + "/mover", { acima: true }, dono.token)).status === 204);
check("e a ordem continua a mesma",
  JSON.stringify(ordem(await boot(dono.token))) === JSON.stringify(["Campanha 2", "Campanha 1"]));

// --------------------------------------------------------------- renomear
check("renomear responde 204",
  (await put("/api/categorias/" + campanha1.id, { name: "Campanha antiga" }, dono.token)).status === 204);
check("o nome novo chega no bootstrap",
  ordem(await boot(dono.token)).includes("Campanha antiga"));
check("membro comum não renomeia",
  (await put("/api/categorias/" + campanha1.id, { name: "Sequestrada" }, membro.token)).status === 403);

// ----------------------------------------------------------------- apagar
check("apagar responde 204",
  (await del("/api/categorias/" + campanha1.id, dono.token)).status === 204);
const depois = await boot(dono.token);
check("a categoria sumiu", !depois.categorias.some(c => c.id === campanha1.id));
check("mas os canais dela continuam existindo",
  depois.rooms.some(r => r.id === canalTexto.id) && depois.rooms.some(r => r.id === canalVoz.id),
  JSON.stringify(depois.rooms.map(r => r.id)));
check("e ficaram soltos, sem grupo",
  depois.rooms.filter(r => r.id === canalTexto.id || r.id === canalVoz.id)
    .every(r => !r.categoryId),
  JSON.stringify(depois.rooms.map(r => [r.id, r.categoryId])));

check("apagar categoria inexistente responde 404",
  (await del("/api/categorias/nao-existe", dono.token)).status === 404);


// ------------------------------------------------- arranjo inteiro de uma vez
//
// Arrastar um canal muda três coisas ao mesmo tempo: a categoria dele, a posição
// dele e a de todos que se deslocaram. Em chamadas separadas existiria um
// instante com a lista pela metade — por isso o arranjo vai numa requisição só,
// e ou vale inteiro ou não vale nada.
const arranjo = (categorias, canais) =>
  put("/api/servers/" + servidor.id + "/organizacao", { categorias, canais }, dono.token);

const agora = await boot(dono.token);
const daqui = agora.rooms.filter(r => r.serverId === servidor.id);
const grupos = agora.categorias.filter(c => c.serverId === servidor.id).map(c => c.id);

// Ordem invertida dos canais, todos fora de categoria.
const invertido = [...daqui].reverse().map(r => ({ id: r.id, categoryId: null }));
check("gravar o arranjo responde 204", (await arranjo(grupos, invertido)).status === 204);
const depoisDoArranjo = await boot(dono.token);
check("a ordem pedida é a que volta",
  JSON.stringify(depoisDoArranjo.rooms.filter(r => r.serverId === servidor.id).map(r => r.id))
    === JSON.stringify(invertido.map(r => r.id)),
  JSON.stringify(depoisDoArranjo.rooms.filter(r => r.serverId === servidor.id).map(r => r.id)));

// Lista de categorias incompleta é recusada: gravar assim apagaria a ordem das
// que ficaram de fora.
check("lista de categorias incompleta é recusada",
  (await arranjo([], invertido)).status === 400);

// Canal de outro servidor não entra no arranjo deste.
const doOutro = agora.rooms.find(r => r.serverId === outro.id);
check("canal de outro servidor é recusado",
  (await arranjo(grupos, [{ id: doOutro.id, categoryId: null }])).status === 403);

// Categoria de outro servidor também não.
check("categoria de outro servidor é recusada",
  (await arranjo(grupos, [{ id: daqui[0].id, categoryId: daOutra.id }])).status === 404);

// Nenhuma das recusas pode ter gravado nada.
const intacto = await boot(dono.token);
check("recusa não muda a ordem que já valia",
  JSON.stringify(intacto.rooms.filter(r => r.serverId === servidor.id).map(r => r.id))
    === JSON.stringify(invertido.map(r => r.id)),
  JSON.stringify(intacto.rooms.filter(r => r.serverId === servidor.id).map(r => r.id)));

check("membro comum não reorganiza",
  (await put("/api/servers/" + servidor.id + "/organizacao", { categorias: grupos, canais: invertido }, membro.token)).status === 403);

// ---------------------------------------------- renomear e apagar canal
//
// Apagar canal apaga **as mensagens dele**. Deixá-las órfãs guardaria para
// sempre uma conversa que ninguém consegue mais abrir.
const paraApagar = await (await post("/api/rooms",
  { name: "descartavel", serverId: servidor.id, kind: "text" }, dono.token)).json();

check("dono renomeia canal",
  (await put("/api/rooms/" + paraApagar.id, { name: "renomeado" }, dono.token)).status === 204);
check("o nome novo chega no bootstrap",
  (await boot(dono.token)).rooms.find(r => r.id === paraApagar.id)?.name === "renomeado");
check("nome curto demais é recusado",
  (await put("/api/rooms/" + paraApagar.id, { name: "x" }, dono.token)).status === 400);
check("membro comum não renomeia canal",
  (await put("/api/rooms/" + paraApagar.id, { name: "sequestrado" }, membro.token)).status === 403);

// Uma mensagem para provar que ela vai junto.
await post("/api/messages", { roomId: paraApagar.id, text: "ate logo" }, dono.token);

check("membro comum não apaga canal",
  (await del("/api/rooms/" + paraApagar.id, membro.token)).status === 403);
check("dono apaga canal", (await del("/api/rooms/" + paraApagar.id, dono.token)).status === 204);

const semEle = await boot(dono.token);
check("o canal sumiu", !semEle.rooms.some(r => r.id === paraApagar.id));
check("apagar canal inexistente responde 404",
  (await del("/api/rooms/nao-existe", dono.token)).status === 404);

// Os outros canais do servidor continuam de pé.
check("apagar um canal não leva os outros",
  semEle.rooms.filter(r => r.serverId === servidor.id).length >= 2,
  JSON.stringify(semEle.rooms.filter(r => r.serverId === servidor.id).map(r => r.id)));

// ------------------------------------------- sem sessão não se sonda nada
//
// Estas rotas procuram o canal antes de saber quem chama. Responder "não
// encontrado" ou "encontrado" a quem não entrou vira uma forma de descobrir
// quais canais existem no servidor dos outros, um id por tentativa. A resposta
// tem de ser sempre 401, exista o canal ou não.
for (const [rota, chamada] of [
  ["PUT canal existente", put("/api/rooms/" + canalTexto.id, { name: "x" })],
  ["PUT canal inexistente", put("/api/rooms/nao-existe", { name: "x" })],
  ["DELETE canal existente", del("/api/rooms/" + canalTexto.id)],
  ["DELETE canal inexistente", del("/api/rooms/nao-existe")],
  ["PUT categoria inexistente", put("/api/categorias/nao-existe", { name: "x" })],
  ["DELETE categoria inexistente", del("/api/categorias/nao-existe")],
]) {
  const resposta = await chamada;
  check("sem sessão, " + rota + " responde 401", resposta.status === 401,
    "respondeu " + resposta.status);
}

report();
