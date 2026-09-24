// Prova o armazenamento de anexos: limite, tipo aceito, dedupe por hash,
// entrega autenticada e o anexo chegando na mensagem pelo WebSocket.
import crypto from "node:crypto";
import { api, post, check, results, createUser } from "./test-common.mjs";

const enviar = (bytes, mime, nome, token) => fetch(api + "/api/files", {
  method: "POST",
  headers: { "content-type": mime, "x-file-name": nome, authorization: "Bearer " + token },
  body: bytes,
});

const eu = await createUser("arq");

// PNG minimo de verdade, para nao depender de arquivo externo.
// Sufixo aleatorio: sem isso o dedupe da execucao anterior responderia 200
// em vez de 201, e o teste falharia sozinho na segunda rodada.
const png = Buffer.concat([
  Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc00000030101003ea9ef9a0000000049454e44ae426082", "hex"),
  crypto.randomBytes(8),
]);

// A conversa aceita **qualquer** arquivo desde a 0.7.40.1. Antes havia uma
// lista de tipos e esta verificação cobrava o 415; hoje o que protege não é
// mais recusar o envio, e sim como o arquivo é entregue — ver abaixo.
const executavel = await enviar(png, "application/x-msdownload", "programa.exe", eu.token);
check("qualquerTipoAceito", executavel.status === 201, String(executavel.status));
const fichaExe = await executavel.json();
check("extensaoVemDoNome", fichaExe.id.endsWith(".exe"), fichaExe.id);

// O que substituiu a lista de tipos.
//
// Os bytes nunca foram conferidos contra o tipo declarado, e quem envia escolhe
// esse cabeçalho. Se o servidor devolvesse o tipo do remetente, bastaria mandar
// HTML anunciado como imagem para ter uma página rodando na origem do app — com
// acesso à sessão de quem clicasse. Então: tipo neutro, download forçado, e
// `nosniff` para o navegador não decidir sozinho que aquilo é uma página.
const baixarExe = await fetch(api + "/api/files/" + fichaExe.id, { headers: { authorization: "Bearer " + eu.token } });
check("executavelSaiComoBytes", baixarExe.headers.get("content-type") === "application/octet-stream",
  String(baixarExe.headers.get("content-type")));
check("executavelForcaDownload", (baixarExe.headers.get("content-disposition") || "").startsWith("attachment"),
  String(baixarExe.headers.get("content-disposition")));
check("executavelComNosniff", baixarExe.headers.get("x-content-type-options") === "nosniff",
  String(baixarExe.headers.get("x-content-type-options")));

// O mesmo vale para o que **parece** inofensivo: um SVG é um documento que
// executa script, e por isso fica fora da lista do que pode abrir na aba.
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>' + crypto.randomBytes(8).toString("hex"));
const envioSvg = await enviar(svg, "image/svg+xml", "desenho.svg", eu.token);
check("svgAceito", envioSvg.status === 201, String(envioSvg.status));
const baixarSvg = await fetch(api + "/api/files/" + (await envioSvg.json()).id, { headers: { authorization: "Bearer " + eu.token } });
check("svgNaoAbreNaAba", baixarSvg.headers.get("content-type") === "application/octet-stream",
  String(baixarSvg.headers.get("content-type")));

const vazio = await enviar(Buffer.alloc(0), "image/png", "vazio.png", eu.token);
check("arquivoVazioRecusado", vazio.status === 400, String(vazio.status));

// Acima do limite o servidor corta o corpo no meio, entao o fetch pode falhar
// com EPIPE em vez de responder. As duas formas contam como recusa.
let recusouGrande = false;
try {
  const grande = await enviar(Buffer.alloc(201 * 1024 * 1024), "video/mp4", "grande.mp4", eu.token);
  recusouGrande = grande.status === 413 || grande.status === 400;
} catch { recusouGrande = true; }
check("acimaDe200MbRecusado", recusouGrande);

const semSessao = await fetch(api + "/api/files", { method: "POST", headers: { "content-type": "image/png" }, body: png });
check("uploadExigeSessao", semSessao.status === 401, String(semSessao.status));

const primeiro = await enviar(png, "image/png", "ponto.png", eu.token);
check("uploadAceito", primeiro.status === 201, String(primeiro.status));
const arquivo = await primeiro.json();
check("idEhOHashDoConteudo", arquivo.id.endsWith(".png") && arquivo.id.length > 20);
check("tamanhoConfere", arquivo.size === png.length);

// Mesmo conteudo com outro nome: nao duplica em disco.
const repetido = await enviar(png, "image/png", "outro-nome.png", eu.token);
check("dedupePorHash", repetido.status === 200, String(repetido.status));
check("mesmoId", (await repetido.json()).id === arquivo.id);

const baixarSemSessao = await fetch(api + "/api/files/" + arquivo.id);
check("downloadExigeSessao", baixarSemSessao.status === 401, String(baixarSemSessao.status));

const baixar = await fetch(api + "/api/files/" + arquivo.id, { headers: { authorization: "Bearer " + eu.token } });
check("downloadAutenticado", baixar.ok, String(baixar.status));
check("tipoNaResposta", baixar.headers.get("content-type") === "image/png");
const voltou = Buffer.from(await baixar.arrayBuffer());
check("bytesIdenticos", voltou.equals(png));

const inexistente = await fetch(api + "/api/files/naoexiste.png", { headers: { authorization: "Bearer " + eu.token } });
check("arquivoInexistente404", inexistente.status === 404, String(inexistente.status));

console.log(JSON.stringify(results, null, 2));
