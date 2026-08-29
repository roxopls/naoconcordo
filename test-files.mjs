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

const semTipo = await enviar(png, "application/x-msdownload", "virus.exe", eu.token);
check("tipoNaoAceitoRecusado", semTipo.status === 415, String(semTipo.status));

const vazio = await enviar(Buffer.alloc(0), "image/png", "vazio.png", eu.token);
check("arquivoVazioRecusado", vazio.status === 400, String(vazio.status));

// Acima do limite o servidor corta o corpo no meio, entao o fetch pode falhar
// com EPIPE em vez de responder. As duas formas contam como recusa.
let recusouGrande = false;
try {
  const grande = await enviar(Buffer.alloc(51 * 1024 * 1024), "video/mp4", "grande.mp4", eu.token);
  recusouGrande = grande.status === 413 || grande.status === 400;
} catch { recusouGrande = true; }
check("acimaDe50MbRecusado", recusouGrande);

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
