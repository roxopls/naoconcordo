// Os ajustes que seguem a conta em vez do computador.
//
// O que precisa valer, e o que este arquivo cobre:
// - conta nova responde um mapa vazio, e não 404: não ter ajuste ainda é o
//   caso normal, não um erro, e o cliente só precisa saber o que aplicar;
// - o que sobe volta igual, senão a troca de máquina não serve de nada;
// - **cada um lê o seu**. Ajuste alheio conta com quem a pessoa fala e quanto
//   ela abaixou o volume de cada um — não é segredo, mas também não é de
//   ninguém mais;
// - gravar de novo **substitui**, e não mescla: desligar uma notificação é
//   apagar a chave dela, e mesclagem nunca deixaria nada ser desligado;
// - os limites seguram quem tentar usar isto como disco de graça.
import { check, createUser, get, put, report } from "./test-common.mjs";

const dono = await createUser("prefs-dono");
const outro = await createUser("prefs-outro");

// -------------------------------------------------------------- conta nova
const vazia = await get("/api/preferencias", dono.token);
check("conta nova responde 200", vazia.status === 200, String(vazia.status));
check("e vem sem nenhum ajuste", Object.keys(await vazia.json()).length === 0);

// ------------------------------------------------------------ subir e reler
const primeiro = {
  "naoconcordo.som": "0",
  "naoconcordo.volumes": JSON.stringify({ fulano: { entrada: 1.5 } }),
  "naoconcordo.quality": "alta",
};
check("guardar responde 204", (await put("/api/preferencias", primeiro, dono.token)).status === 204);

// Comparado par a par, e nao por texto: o servidor guarda em mapa ordenado e
// devolve as chaves em ordem alfabetica, que nao e a ordem em que subiram.
// Comparar `JSON.stringify` falharia por causa disso, sem nada estar errado.
const lido = await (await get("/api/preferencias", dono.token)).json();
const mesmos = (a, b) => {
  const chaves = Object.keys(a);
  return chaves.length === Object.keys(b).length && chaves.every(k => a[k] === b[k]);
};
check("volta igual ao que subiu", mesmos(lido, primeiro), JSON.stringify(lido));

// ----------------------------------------------------------- substitui tudo
//
// Sem `naoconcordo.som`: quem desligou uma notificação apagou a chave dela.
const segundo = { "naoconcordo.quality": "media" };
check("regravar responde 204", (await put("/api/preferencias", segundo, dono.token)).status === 204);
const depois = await (await get("/api/preferencias", dono.token)).json();
check("a chave ausente sumiu de verdade", depois["naoconcordo.som"] === undefined,
  JSON.stringify(depois));
check("e a que ficou tem o valor novo", depois["naoconcordo.quality"] === "media",
  JSON.stringify(depois));

// -------------------------------------------------------- cada um lê o seu
const doOutro = await (await get("/api/preferencias", outro.token)).json();
check("os ajustes de cada um são os seus", Object.keys(doOutro).length === 0,
  JSON.stringify(doOutro));

check("exige sessão para ler", (await get("/api/preferencias")).status === 401);
check("exige sessão para gravar", (await put("/api/preferencias", primeiro)).status === 401);

// -------------------------------------------------------------- os limites
const demais = {};
for (let i = 0; i < 61; i++) demais["chave" + i] = "x";
check("ajustes demais são recusados",
  (await put("/api/preferencias", demais, dono.token)).status === 413);

const gigante = { "naoconcordo.volumes": "x".repeat(8 * 1024 + 1) };
check("ajuste grande demais é recusado",
  (await put("/api/preferencias", gigante, dono.token)).status === 413);

// Recusa não pode ter deixado rastro no que já estava guardado.
const intacto = await (await get("/api/preferencias", dono.token)).json();
check("recusa não estraga o que já estava lá", intacto["naoconcordo.quality"] === "media",
  JSON.stringify(intacto));

report();
