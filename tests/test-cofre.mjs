// O cofre guarda a identidade privada de conversas, cifrada pelo proprio dono.
//
// O que precisa valer, e o que este arquivo cobre:
// - o cofre volta igual ao que subiu, para a chave abrir do outro lado;
// - **so o dono le o seu**. Um cofre alheio na mao de alguem vira ataque de
//   forca bruta contra a senha dela, offline e sem deixar rastro;
// - subir de novo substitui, que e o que a troca de senha faz;
// - o embrulho de recuperacao e opcional: contas antigas migram sem ele;
// - lixo no lugar do embrulho e recusado.
import crypto from "node:crypto";
import { check, createUser, get, put, report } from "./test-common.mjs";

const embrulho = () => ({
  ciphertext: crypto.randomBytes(96).toString("base64url"),
  nonce: crypto.randomBytes(12).toString("base64url"),
});

const dono = await createUser("cofre-dono");
const outro = await createUser("cofre-outro");

// ------------------------------------------------------ conta ainda sem cofre
check("cofre ausente responde 404", (await get("/api/cofre", dono.token)).status === 404);

// ------------------------------------------------------------ subir e reler
const primeiro = { porSenha: embrulho(), porRecuperacao: embrulho() };
check("guardar cofre", (await put("/api/cofre", primeiro, dono.token)).ok);

const lido = await (await get("/api/cofre", dono.token)).json();
check("cofre volta igual ao que subiu",
  lido.porSenha.ciphertext === primeiro.porSenha.ciphertext
  && lido.porSenha.nonce === primeiro.porSenha.nonce
  && lido.porRecuperacao.ciphertext === primeiro.porRecuperacao.ciphertext);

// -------------------------------------------------------------- so o dono le
const doOutro = await get("/api/cofre", outro.token);
check("cofre de cada um e o seu", doOutro.status === 404,
  "o outro usuario recebeu " + doOutro.status + " em vez de nao achar cofre nenhum");

const semToken = await get("/api/cofre");
check("cofre exige sessao", semToken.status === 401);

// ------------------------------------------------- substituir, como na troca
const segundo = { porSenha: embrulho(), porRecuperacao: embrulho() };
check("regravar cofre", (await put("/api/cofre", segundo, dono.token)).ok);
const relido = await (await get("/api/cofre", dono.token)).json();
check("cofre novo substitui o antigo", relido.porSenha.ciphertext === segundo.porSenha.ciphertext);

// ------------------------------------------ conta antiga migra so pela senha
const soSenha = { porSenha: embrulho() };
check("cofre sem embrulho de recuperacao e aceito", (await put("/api/cofre", soSenha, dono.token)).ok);
const migrado = await (await get("/api/cofre", dono.token)).json();
check("cofre migrado nao inventa embrulho de recuperacao", migrado.porRecuperacao === undefined);

// ------------------------------------------------------------------- recusas
const invalido = await put("/api/cofre", { porSenha: { ciphertext: "nao@e#base64", nonce: "!!" } }, dono.token);
check("embrulho invalido e recusado", invalido.status === 400);

const gigante = await put("/api/cofre", {
  porSenha: { ciphertext: crypto.randomBytes(8192).toString("base64url"), nonce: crypto.randomBytes(12).toString("base64url") },
}, dono.token);
check("embrulho grande demais e recusado", gigante.status === 400);

// O cofre precisa sobreviver as recusas: uma delas nao pode apagar o que valia.
const final = await (await get("/api/cofre", dono.token)).json();
check("recusa nao destroi o cofre guardado", final.porSenha.ciphertext === soSenha.porSenha.ciphertext);

report();
