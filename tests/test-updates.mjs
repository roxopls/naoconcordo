// Os arquivos de atualizacao dos clientes.
//
// Em Linux quem serve isto e o Caddy; no Windows e o proprio servidor, porque
// quem hospeda pelo painel nao tem proxy nenhum na frente. Sem esta rota, o
// dono de um servidor caseiro nao teria como distribuir atualizacao para os
// amigos dele.
import fs from "node:fs";
import path from "node:path";
import { api, check, dataDir, report } from "./test-common.mjs";

const pasta = path.join(dataDir, "updates");
fs.mkdirSync(pasta, { recursive: true });

const manifesto = { version: "9.9.9", notes: "teste", platforms: {} };
fs.writeFileSync(path.join(pasta, "latest.json"), JSON.stringify(manifesto));
fs.writeFileSync(path.join(pasta, "instalador.exe"), Buffer.from([0x4d, 0x5a, 0x90, 0x00]));

const lido = await fetch(api + "/updates/latest.json");
check("manifesto e servido", lido.ok, "recebeu " + lido.status);
check("manifesto chega inteiro", (await lido.json()).version === "9.9.9");

const binario = await fetch(api + "/updates/instalador.exe");
check("instalador e servido", binario.ok, "recebeu " + binario.status);
check("instalador chega byte a byte", Buffer.from(await binario.arrayBuffer()).equals(Buffer.from([0x4d, 0x5a, 0x90, 0x00])));

check("arquivo inexistente da 404", (await fetch(api + "/updates/nao-existe.json")).status === 404);

// A pasta de updates nao pode virar uma janela para o resto do disco: os
// arquivos de dados moram um nivel acima dela.
const fuga = await fetch(api + "/updates/../users.json");
check("nao da para sair da pasta de updates", fuga.status === 404 || fuga.status === 400,
  "recebeu " + fuga.status + " ao pedir ../users.json");

// Sem sessao: as atualizacoes sao publicas por necessidade — o app precisa
// consulta-las antes de qualquer login.
check("updates dispensa autenticacao", (await fetch(api + "/updates/latest.json")).ok);

report();
