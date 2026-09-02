// A identidade que vai no token do LiveKit.
//
// Ela e o que o LiveKit usa para saber que duas conexoes sao a mesma pessoa.
// Enquanto levou um sufixo sorteado a cada pedido, cada conexao virava uma
// pessoa diferente: conexao que caia sem se despedir ficava na sala publicando
// microfone, e quem voltava ouvia a si mesmo.
//
// O que precisa valer, e o que este arquivo cobre:
// - pedir token duas vezes da a **mesma** identidade, senao a troca nao serve
//   de nada;
// - a captura de tela e a janela de cameras entram com identidade propria, ou
//   derrubariam a conexao da propria pessoa ao entrar;
// - a identidade da pessoa e o nome dela, sem enfeite;
// - o separador dos sabores nao cabe num nome de usuario, para ninguem poder
//   se cadastrar com um nome que colida com a tela de outra pessoa.
import crypto from "node:crypto";
import { check, createUser, get, post, report } from "./test-common.mjs";

const identidade = token => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub;

const pessoa = await createUser("identidade");
// Servidor proprio: conta recem-criada nao participa de nenhum, e sem canal de
// voz nao ha token de midia para inspecionar.
const servidor = await (await post("/api/servers",
  { name: "Sala " + crypto.randomBytes(2).toString("hex") }, pessoa.token)).json();
const boot = await (await get("/api/bootstrap", pessoa.token)).json();
const voz = boot.rooms.find(room => room.serverId === servidor.id && room.kind === "voice");
if (!voz) throw new Error("o servidor novo nasceu sem canal de voz");

const pedir = async corpo => {
  const resposta = await post("/api/livekit-token", { roomId: voz.id, ...corpo }, pessoa.token);
  if (!resposta.ok) throw new Error("token: " + resposta.status + " " + await resposta.text());
  return identidade((await resposta.json()).token);
};

// ------------------------------------------------------------------ a pessoa
const primeira = await pedir({});
const segunda = await pedir({});
check("a identidade nao muda entre dois pedidos", primeira === segunda,
  "saiu " + primeira + " e depois " + segunda);
check("a identidade da pessoa e o nome dela", primeira === pessoa.username,
  "saiu " + primeira + " para o usuario " + pessoa.username);

// ------------------------------------------------------- os outros dois sabores
const tela = await pedir({ screen: true });
const cameras = await pedir({ viewer: true });
check("a tela entra com identidade propria", tela !== primeira && tela.startsWith(pessoa.username + "#"),
  "saiu " + tela);
check("as cameras entram com identidade propria",
  cameras !== primeira && cameras !== tela && cameras.startsWith(pessoa.username + "#"),
  "saiu " + cameras);
check("a tela tambem nao muda entre dois pedidos", (await pedir({ screen: true })) === tela);

// ---------------------------------------------- ninguem se cadastra com o `#`
// O `#` e barrado ja no desafio, antes mesmo de haver cadastro a recusar.
const invasor = await post("/api/auth/challenge", { username: "alguem#tela" });
check("nome de usuario com `#` e recusado", invasor.status === 400,
  "o desafio respondeu " + invasor.status);

report();
