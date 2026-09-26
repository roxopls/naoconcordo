// A lista de amigos vem na ordem da ultima conversa, com a hora de cada uma.
import { b64, post, get, check, results, createUser } from "./test-common.mjs";

const ana = await createUser("ana");
const bia = await createUser("bia");
const caio = await createUser("caio");
for (const outro of [bia, caio]) {
  await post("/api/friends/request", { username: outro.username }, ana.token);
  await post("/api/friends/accept", { username: ana.username }, outro.token);
}
const antes = await (await get("/api/friends", ana.token)).json();
check("semConversaPorNome", antes.friends.join() === [bia.username, caio.username].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).join());
const env = await post("/api/dm", { to: caio.username, ciphertext: b64("cifrado"), nonce: b64("123456789012") }, ana.token);
check("mensagemEnviada", env.status === 201, String(env.status));
const depois = await (await get("/api/friends", ana.token)).json();
check("quemConversouPrimeiro", depois.friends[0] === caio.username, depois.friends.join());
check("horaDaConversa", Boolean(depois.atividade?.[caio.username.toLowerCase()]));
check("semHoraSemConversa", !depois.atividade?.[bia.username.toLowerCase()]);
const doCaio = await (await get("/api/friends", caio.token)).json();
check("valeParaOsDois", Boolean(doCaio.atividade?.[ana.username.toLowerCase()]));
console.log(JSON.stringify(results, null, 2));
