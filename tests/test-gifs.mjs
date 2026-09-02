// A busca de GIF passa pelo servidor, e o cliente nunca fala com o Tenor.
//
// Estas verificacoes nao tocam a rede: o servidor de teste sobe sem
// `TENOR_API_KEY`, que e justamente o estado de quem hospeda sem configurar
// nada. O que precisa valer, e o que este arquivo cobre:
// - sem chave, a rota diz que nao ha busca em vez de dar erro obscuro, e o
//   `bootstrap` avisa o cliente para nem mostrar o botao;
// - toda rota de GIF exige sessao, como o resto do aplicativo;
// - a rota de midia so aceita endereco que **este** servidor assinou. Sem isso
//   ela viraria um buscador de qualquer URL da internet, e a primeira coisa que
//   alguem tentaria seria a rede interna de quem hospeda.
import { check, createUser, get, post, report } from "./test-common.mjs";

const pessoa = await createUser("gif");

// ------------------------------------------------------------- sem a chave
const busca = await get("/api/gifs?q=gato", pessoa.token);
check("sem chave, a busca responde 501", busca.status === 501,
  "respondeu " + busca.status);

const boot = await (await get("/api/bootstrap", pessoa.token)).json();
check("o bootstrap avisa que nao ha busca de GIF", boot.gifs === false,
  "veio " + JSON.stringify(boot.gifs));

// ----------------------------------------------------------- exige sessao
for (const [rota, chamada] of [
  ["/api/gifs", get("/api/gifs")],
  ["/api/gifs/midia", get("/api/gifs/midia?f=qualquer")],
  ["/api/gifs/guardar", post("/api/gifs/guardar", { ficha: "qualquer" })],
]) {
  const resposta = await chamada;
  check("sem sessao, " + rota + " responde 401", resposta.status === 401,
    "respondeu " + resposta.status);
}

// -------------------------------------------- so endereco assinado por aqui
//
// O `f` e `<endereco em base64url>.<assinatura>`. Nenhum destes foi assinado
// por este servidor, entao nenhum pode virar um download.
const forjadas = [
  // Endereco interno com assinatura inventada.
  Buffer.from("http://127.0.0.1:3040/health").toString("base64url") + ".mentira",
  // Ate um endereco do proprio Tenor precisa da assinatura.
  Buffer.from("https://media.tenor.com/x/y.gif").toString("base64url") + ".mentira",
  // Sem o separador.
  "semponto",
  "",
];
for (const ficha of forjadas) {
  const midia = await get("/api/gifs/midia?f=" + encodeURIComponent(ficha), pessoa.token);
  check("endereco nao assinado e recusado (" + (ficha.slice(0, 18) || "vazio") + ")",
    midia.status === 404, "respondeu " + midia.status);

  const guardar = await post("/api/gifs/guardar", { ficha }, pessoa.token);
  check("guardar nao assinado e recusado (" + (ficha.slice(0, 18) || "vazio") + ")",
    guardar.status === 404, "respondeu " + guardar.status);
}

report();
