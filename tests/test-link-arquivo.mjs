// O link que abre o anexo fora do aplicativo.
//
// O endereco da API exige cabecalho de autorizacao, e navegador nenhum manda
// isso: colado no Chrome, ele respondia "Sessao invalida ou expirada". O link
// assinado existe para abrir sem sessao, e por isso a assinatura precisa
// aguentar chute.
import crypto from "node:crypto";
import { api, check, createUser, get, report } from "./test-common.mjs";

const dono = await createUser("link-dono");

// PNG minimo de verdade, com sufixo aleatorio: sem ele o dedupe devolveria o
// arquivo de uma execucao anterior.
const corpo = Buffer.concat([
  Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc00000030101003ea9ef9a0000000049454e44ae426082", "hex"),
  crypto.randomBytes(8),
]);
const enviado = await (await fetch(api + "/api/files", {
  method: "POST",
  headers: {
    "content-type": "image/png",
    "x-file-name": "minha foto.png",
    authorization: "Bearer " + dono.token,
  },
  body: corpo,
})).json();
check("anexo enviado", Boolean(enviado.id), JSON.stringify(enviado));

// ------------------------------------------------------- o endereco antigo
const semSessao = await fetch(api + "/api/files/" + enviado.id);
check("endereco da api continua exigindo sessao", semSessao.status === 401);

// ------------------------------------------------------------ o link novo
const { url } = await (await get("/api/files/" + enviado.id + "/link", dono.token)).json();
check("link tem prova na propria url", /^\/f\/[^?]+\?t=.+$/.test(url), url);

const aberto = await fetch(api + url);
check("link abre sem sessao", aberto.ok, "recebeu " + aberto.status);
check("conteudo e o mesmo", Buffer.from(await aberto.arrayBuffer()).equals(corpo));
check("tipo preservado", aberto.headers.get("content-type") === "image/png");
check("imagem abre na aba, nao baixa", (aberto.headers.get("content-disposition") || "").startsWith("inline"));
check("nome do arquivo acompanha", (aberto.headers.get("content-disposition") || "").includes("minha foto.png"));

// ------------------------------------------------------------- e a prova?
const semProva = await fetch(api + "/f/" + enviado.id);
check("sem prova nao abre", semProva.status === 404, "recebeu " + semProva.status);

const provaErrada = await fetch(api + "/f/" + enviado.id + "?t=" + crypto.randomBytes(16).toString("base64url"));
check("prova inventada nao abre", provaErrada.status === 404, "recebeu " + provaErrada.status);

// A prova de um arquivo nao pode valer para outro: senao bastaria receber um
// anexo qualquer para abrir todos os outros.
const prova = url.split("t=")[1];
const outro = await fetch(api + "/f/" + crypto.randomUUID() + "?t=" + prova);
check("prova nao serve para outro arquivo", outro.status === 404, "recebeu " + outro.status);

// Arquivo inexistente e prova errada respondem igual, para ninguem descobrir
// quais identificadores existem tentando um por um.
check("nao da para descobrir o que existe", provaErrada.status === outro.status);

// ------------------------------------------------- nome com ponto sobrevive
//
// O saneamento do nome filtrava os caracteres do conjunto "/\..", e como
// isso e um conjunto e nao uma sequencia, ele apagava todo ponto: "foto.png"
// chegava como "fotopng" e todo anexo ficava sem extensao.
check("extensao do anexo sobrevive", enviado.name === "minha foto.png", JSON.stringify(enviado.name));

const travessia = await (await fetch(api + "/api/files", {
  method: "POST",
  headers: {
    "content-type": "image/png",
    // Contrabarra dobrada de proposito: em JavaScript "\W" nao e escape
    // valido e vira "W", entao com uma barra so o teste mandaria um nome
    // sem contrabarra nenhuma e nao provaria nada.
    "x-file-name": "..\\..\\Windows\\System32\\algo.png",
    authorization: "Bearer " + dono.token,
  },
  body: Buffer.concat([corpo, crypto.randomBytes(4)]),
})).json();
check("nome nao atravessa pastas", travessia.name === "algo.png", JSON.stringify(travessia.name));

// ------------------------------------------------- pedir link exige sessao
check("gerar link exige sessao", (await get("/api/files/" + enviado.id + "/link")).status === 401);

report();
