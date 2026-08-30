// Interface do painel de quem hospeda.
//
// Toda a decisao mora no Rust; aqui so se mostra o estado e se encaminham os
// pedidos. O painel se atualiza sozinho a cada dois segundos, porque os
// processos podem morrer por conta propria — porta ocupada, disco cheio — e a
// tela precisa contar isso sem a pessoa ter que apertar nada.

// `export {}` faz deste arquivo um modulo, que e o que permite o `declare
// global` abaixo. Nada e exportado de verdade.
export {};

/// A ponte com o Rust vem pronta na janela, por `withGlobalTauri`, e nao de um
/// pacote npm: sem bundler, um import de modulo nao resolveria no navegador.
declare global {
  interface Window {
    __TAURI__: { core: { invoke<T>(cmd: string, args?: unknown): Promise<T> } };
  }
}
const invoke = <T,>(cmd: string, args?: unknown) => window.__TAURI__.core.invoke<T>(cmd, args);

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type Config = {
  enderecoPublico: string;
  porta: number;
  admin: string;
};
type Endereco = { ip: string; interface: string; vpn: boolean };
type Situacao = {
  servidor: boolean;
  livekit: boolean;
  versaoLivekit: string | null;
  versaoServidor: string | null;
  config: Config;
  enderecos: Endereco[];
  pasta: string;
};

let ultima: Situacao | null = null;
/// Enquanto a pessoa digita, a atualizacao automatica nao pode reescrever os
/// campos por baixo dos dedos.
let editando = false;

function dizer(texto: string, estado: "" | "ok" | "ruim" = "") {
  const recado = byId("recado");
  recado.textContent = texto;
  recado.className = "recado" + (estado ? " " + estado : "");
}

/// O endereco completo, como o amigo vai digitar no aplicativo dele.
function enderecoDosAmigos(config: Config) {
  const host = config.enderecoPublico.trim();
  if (!host) return "";
  // Sem TLS aqui: o painel serve o servidor direto, sem Caddy na frente. Quem
  // puser um dominio com certificado troca o esquema no proprio aplicativo.
  return "http://" + host + ":" + config.porta;
}

function pintar(situacao: Situacao) {
  ultima = situacao;
  const { servidor, livekit, config } = situacao;

  const estado = byId("estado");
  estado.textContent = servidor ? (livekit ? "no ar" : "no ar, sem voz") : "desligado";
  estado.className = "estado " + (servidor ? (livekit ? "ligado" : "parcial") : "parado");

  byId("ligar").classList.toggle("hidden", servidor);
  byId("desligar").classList.toggle("hidden", !servidor);

  const endereco = enderecoDosAmigos(config);
  byId("cartao-endereco").classList.toggle("hidden", !servidor || !endereco);
  byId("endereco-amigos").textContent = endereco || "—";

  if (!editando) {
    byId<HTMLInputElement>("endereco-publico").value = config.enderecoPublico;
    byId<HTMLInputElement>("porta").value = String(config.porta);
    byId<HTMLInputElement>("admin").value = config.admin;
  }

  // ----------------------------------------------------------- enderecos
  const lista = byId("lista-enderecos");
  lista.replaceChildren(...situacao.enderecos.map(item => {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "chip" + (item.vpn ? " vpn" : "") + (item.ip === config.enderecoPublico ? " ativo" : "");
    const ip = document.createElement("strong");
    ip.textContent = item.ip;
    const nome = document.createElement("small");
    nome.textContent = item.vpn ? "VPN · " + item.interface : item.interface;
    botao.append(ip, nome);
    botao.onclick = () => {
      byId<HTMLInputElement>("endereco-publico").value = item.ip;
      void salvar();
    };
    return botao;
  }));
  if (!situacao.enderecos.length) {
    const vazio = document.createElement("p");
    vazio.className = "dica";
    vazio.textContent = "Nenhum endereço de rede encontrado nesta máquina.";
    lista.replaceChildren(vazio);
  }

  // ------------------------------------------------------------ servidor
  byId("servidor-versao").textContent = situacao.versaoServidor
    ? "Servidor " + situacao.versaoServidor + "."
    : "Rodando o servidor que veio com este painel.";

  // ------------------------------------------------------------- livekit
  const recadoLk = byId("livekit-estado");
  const baixar = byId("baixar-livekit");
  if (situacao.versaoLivekit) {
    recadoLk.textContent = livekit
      ? "LiveKit " + situacao.versaoLivekit + " no ar."
      : "LiveKit " + situacao.versaoLivekit + " instalado. Sobe junto com o servidor.";
    baixar.classList.add("hidden");
  } else {
    recadoLk.textContent = "O LiveKit ainda não foi baixado. Sem ele, o chat funciona e a chamada de voz e tela não.";
    baixar.classList.remove("hidden");
  }
}

async function atualizar() {
  try {
    pintar(await invoke<Situacao>("situacao"));
  } catch (erro) {
    dizer(String(erro), "ruim");
  }
}

async function salvar() {
  const config: Config = {
    enderecoPublico: byId<HTMLInputElement>("endereco-publico").value.trim(),
    porta: Number(byId<HTMLInputElement>("porta").value) || 3040,
    admin: byId<HTMLInputElement>("admin").value.trim() || "admin",
  };
  try {
    await invoke("salvar_config", { nova: config });
    editando = false;
    await atualizar();
    dizer(ultima?.servidor
      ? "Salvo. Desligue e ligue o servidor para valer."
      : "Salvo.", "ok");
  } catch (erro) { dizer(String(erro), "ruim"); }
}

// ------------------------------------------------------------------- botoes
for (const id of ["endereco-publico", "porta", "admin"]) {
  byId(id).addEventListener("input", () => { editando = true; });
}
byId("salvar").onclick = () => void salvar();

byId("ligar").onclick = async () => {
  dizer("Ligando…");
  try { await invoke("iniciar"); dizer("Servidor no ar.", "ok"); }
  catch (erro) { dizer(String(erro), "ruim"); }
  await atualizar();
};

byId("desligar").onclick = async () => {
  try { await invoke("parar"); dizer("Servidor desligado."); }
  catch (erro) { dizer(String(erro), "ruim"); }
  await atualizar();
};

byId("copiar").onclick = async () => {
  const texto = byId("endereco-amigos").textContent || "";
  try { await navigator.clipboard.writeText(texto); dizer("Endereço copiado.", "ok"); }
  catch { dizer(texto); }
};

byId("baixar-livekit").onclick = async () => {
  const botao = byId<HTMLButtonElement>("baixar-livekit");
  botao.disabled = true;
  dizer("Baixando o LiveKit…");
  try {
    const versao = await invoke<string>("instalar_livekit");
    dizer("LiveKit " + versao + " instalado.", "ok");
  } catch (erro) { dizer(String(erro), "ruim"); }
  finally { botao.disabled = false; }
  await atualizar();
};

byId("atualizar-servidor").onclick = async () => {
  const botao = byId<HTMLButtonElement>("atualizar-servidor");
  botao.disabled = true;
  dizer("Procurando…");
  try {
    const versao = await invoke<string>("atualizar_servidor");
    dizer("Servidor " + versao + ". Desligue e ligue para valer.", "ok");
  } catch (erro) { dizer(String(erro), "ruim"); }
  finally { botao.disabled = false; }
  await atualizar();
};

byId("firewall").onclick = async () => {
  dizer("Criando as regras…");
  try { dizer(await invoke<string>("abrir_firewall"), "ok"); }
  catch (erro) { dizer(String(erro), "ruim"); }
};

byId("abrir-pasta").onclick = () => void invoke("abrir_pasta").catch(erro => dizer(String(erro), "ruim"));

// -------------------------------------------------------------- registro
async function atualizarRegistro() {
  try {
    const linhas = await invoke<string[]>("registro");
    const caixa = byId("registro");
    // Colado no fim so quando ja estava: quem rolou para ler algo mais acima
    // nao pode ser arrastado de volta a cada dois segundos.
    const noFim = caixa.scrollTop + caixa.clientHeight >= caixa.scrollHeight - 20;
    caixa.textContent = linhas.length ? linhas.join("\n") : "—";
    if (noFim) caixa.scrollTop = caixa.scrollHeight;
  } catch { /* painel ocupado; a proxima volta pega */ }
}

// ----------------------------------------- gerar o aplicativo dos amigos
//
// Quem instala um aplicativo compilado por outra pessoa continua recebendo
// atualizacao dela, porque o executavel carrega o endereco e a chave publica de
// quem o compilou. Gerar o proprio e o que corta esse fio.
let versaoPronta = "";

function recadoBuild(texto: string) { byId("build-recado").textContent = texto; }

byId("verificar-versao").onclick = async () => {
  const botao = byId<HTMLButtonElement>("verificar-versao");
  botao.disabled = true;
  recadoBuild("Consultando o GitHub…");
  try {
    const versao = await invoke<string>("versao_publicada");
    const faltando = await invoke<string[]>("ferramentas_de_build");
    if (faltando.length) {
      // Dizer o que falta antes de a pessoa apertar o botao e esperar dez
      // minutos para descobrir que nao tinha como dar certo.
      recadoBuild("Versão publicada: " + versao + ". Esta máquina não tem " + faltando.join(", ")
        + ", e sem isso não dá para compilar. Instale o Node.js e o Rust, e o NSIS vem junto com o Tauri.");
      return;
    }
    versaoPronta = versao;
    recadoBuild("Versão publicada: " + versao + ". A primeira compilação demora bastante — acompanhe pelo registro acima.");
    byId("compilar").classList.remove("hidden");
  } catch (erro) { recadoBuild(String(erro)); }
  finally { botao.disabled = false; }
};

byId("compilar").onclick = async () => {
  if (!versaoPronta) return;
  const botao = byId<HTMLButtonElement>("compilar");
  botao.disabled = true;
  recadoBuild("Compilando " + versaoPronta + "… isso leva vários minutos.");
  try {
    const nome = await invoke<string>("gerar_clientes", { versao: versaoPronta });
    recadoBuild("Pronto: " + nome + ". Ele está publicado neste servidor; passe o instalador aos seus amigos uma vez, e daí em diante eles atualizam sozinhos.");
  } catch (erro) { recadoBuild(String(erro)); }
  finally { botao.disabled = false; }
};

void atualizar();
void atualizarRegistro();
window.setInterval(() => { void atualizar(); void atualizarRegistro(); }, 2000);
