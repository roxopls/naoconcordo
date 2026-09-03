// Cartão de prévia de link.
//
// Estas verificações não tocam a rede: o que se testa aqui é o que o servidor
// decide **antes** de sair buscando. O que precisa valer:
// - link sem prévia responde 204, e não erro. Canal, playlist, perfil e
//   qualquer outro endereço são o caso normal, não falha — o cliente pede a
//   prévia de todo link que aparece numa mensagem;
// - toda rota exige sessão;
// - a rota de mídia só aceita endereço que **este** servidor assinou. Sem isso
//   ela viraria um buscador de qualquer URL da internet, e a primeira coisa que
//   alguém tentaria seria a rede interna de quem hospeda.
import { check, createUser, get, report } from "./test-common.mjs";

const pessoa = await createUser("prev");

// ------------------------------------------------------- sem prévia é 204
for (const [rotulo, url] of [
  ["canal do YouTube", "https://www.youtube.com/@alguem"],
  ["playlist", "https://www.youtube.com/playlist?list=PL123"],
  ["perfil sem tuíte", "https://x.com/fulano"],
  ["site qualquer", "https://exemplo.com/pagina"],
  ["endereço vazio", ""],
  ["texto que não é link", "nao-e-link"],
]) {
  const resposta = await get("/api/previa?url=" + encodeURIComponent(url), pessoa.token);
  check(rotulo + " responde 204", resposta.status === 204, "respondeu " + resposta.status);
}

// Endereço gigante é cortado antes de virar requisição.
const gigante = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&x=" + "a".repeat(600);
check("endereço longo demais responde 204",
  (await get("/api/previa?url=" + encodeURIComponent(gigante), pessoa.token)).status === 204);

// ----------------------------------------------------------- exige sessão
check("sem sessão, /api/previa responde 401",
  (await get("/api/previa?url=https://x.com/a/status/1")).status === 401);
check("sem sessão, /api/previa/midia responde 401",
  (await get("/api/previa/midia?f=qualquer")).status === 401);

// ------------------------------------------- mídia só com assinatura nossa
//
// O `f` é `<endereço em base64url>.<assinatura>`. Nenhum destes foi assinado
// por este servidor, então nenhum pode virar um download.
for (const ficha of [
  Buffer.from("http://127.0.0.1:3040/health").toString("base64url") + ".mentira",
  Buffer.from("https://i.ytimg.com/vi/x/hq.jpg").toString("base64url") + ".mentira",
  "semponto",
  "",
]) {
  const resposta = await get("/api/previa/midia?f=" + encodeURIComponent(ficha), pessoa.token);
  check("endereço não assinado é recusado (" + (ficha.slice(0, 16) || "vazio") + ")",
    resposta.status === 404, "respondeu " + resposta.status);
}

report();
