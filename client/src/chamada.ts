// Chamada privada: grupo privado ou conversa a dois, com a midia em P2P.
//
// Mora num modulo proprio, separada da chamada de servidor, que e toda
// amarrada ao LiveKit. Daqui para fora so saem os ganchos que o `main.ts`
// entrega (rede, nomes, fotos, avisos) e o que ele precisa chamar de volta. As
// duas chamadas nao convivem: entrar numa sai da outra.
//
// O palco desta chamada fica em cima da conversa dela, como no Discord: a
// conversa continua embaixo. Saindo da conversa, a chamada segue e uma barra
// pequena na lateral leva de volta.

import { MalhaP2P, TransmissorWeb, type Sinal } from "./p2p";
import type { TransmissorNativo } from "./telaNativa";
import { grade } from "./gridlayout";
import { opcoesDeCaptura } from "./voz";

export type Participante = { username: string; sessao: number; desde: string; mudo: boolean; camera: boolean; tela: boolean };

export type Ganchos = {
  api: <T>(caminho: string, init?: RequestInit) => Promise<T>;
  /// Manda uma mensagem pelo WebSocket do app. `false` se ele nao esta aberto.
  enviarWs: (mensagem: object) => boolean;
  eu: () => string;
  sessao: () => number;
  nome: (usuario: string) => string;
  foto: (elemento: HTMLElement, usuario: string) => void;
  aviso: (texto: string, aoClicar?: () => void) => void;
  /// Titulo da chamada (nome do grupo ou do amigo), para a barra e o toque.
  titulo: (chamada: string) => string;
  /// A chamada da conversa aberta agora, ou `null` fora de grupo/conversa.
  chamadaDaTela: () => string | null;
  abrirConversa: (chamada: string) => void;
  /// Sai da chamada de servidor, se houver. As duas nao convivem.
  sairDaOutra: () => Promise<void>;
  volume: (usuario: string) => number;
  dispositivos: () => { mic?: string; cam?: string; out?: string };
  som: (tipo: "entrar" | "sair" | "toque") => void;
  /// Aviso do sistema quando alguem liga e o app nao esta na frente.
  notificar?: (titulo: string, corpo: string, aoClicar: () => void) => void;
  mudou: () => void;
  /// So no app: a tela sai pelo Rust (captura e GPU proprias), escolhida no
  /// mesmo seletor da chamada de servidor. Sem isto, vale o `getDisplayMedia`.
  telaNativa?: {
    iniciar: () => Promise<TransmissorNativo | null>;
    escolherFonte: () => Promise<string | null>;
  };
};

/// A tela que estou transmitindo: pelo navegador (`stream`) ou pelo app
/// (`nativo`, sem imagem local para mostrar — a captura mora no Rust).
type MinhaTela = { stream: MediaStream | null; nativo: TransmissorNativo | null; pausada: boolean; vigia: number };

type Ativa = {
  id: string;
  malha: MalhaP2P;
  microfone: MediaStream | null;
  camera: MediaStream | null;
  tela: MinhaTela | null;
  mudo: boolean;
};

const MIC_KEY = "naoconcordo.p2p.mudo";

export function criarChamadaPrivada(g: Ganchos) {
  /// Quem esta em cada chamada que eu enxergo, pelo servidor.
  const estados = new Map<string, Participante[]>();
  let ativa: Ativa | null = null;
  /// Telas que eu pedi para assistir, por sessao de quem transmite.
  const assistindo = new Set<number>();
  /// Nivel de voz de cada um, para o anel de quem fala.
  const falando = new Set<string>();
  const saidas = new Map<number, { el: HTMLAudioElement; ganho: GainNode; analisador: AnalyserNode; fonte: MediaStreamAudioSourceNode; faixa: string }>();
  let contexto: AudioContext | null = null;
  let analisadorLocal: AnalyserNode | null = null;
  let vigiaDeFala = 0;
  let toque: { chamada: string; timer: number; repique: number } | null = null;

  const painel = document.getElementById("chamada-privada") as HTMLElement;
  const palco = document.getElementById("chamada-palco") as HTMLElement;
  const mini = document.getElementById("chamada-mini") as HTMLElement;
  const reajustar = grade(palco, 16 / 9, 520);

  // ------------------------------------------------------------ entrar/sair

  async function entrar(chamada: string) {
    if (ativa?.id === chamada) return;
    if (ativa) await sair();
    await g.sairDaOutra();
    pararToque();
    let ice: RTCIceServer[] = [];
    try { ice = (await g.api<{ iceServers: RTCIceServer[] }>("/api/ice")).iceServers; }
    catch (erro) { console.warn("[chamada] ice", erro); }
    let microfone: MediaStream | null = null;
    try {
      microfone = await navigator.mediaDevices.getUserMedia({ audio: opcoesDeCaptura(g.dispositivos().mic) });
    } catch (erro) {
      // Sem microfone ainda da para ouvir e ver: entra mudo.
      console.warn("[chamada] microfone", erro);
      g.aviso("Não foi possível abrir o microfone. Você entrou mudo.");
    }
    const mudo = !microfone || localStorage.getItem(MIC_KEY) === "1";
    const faixa = microfone?.getAudioTracks()[0] || null;
    if (faixa) faixa.enabled = !mudo;
    const malha = new MalhaP2P(g.sessao(), ice, {
      enviar: (para, dados) => { g.enviarWs({ type: "sinal", chamada, para, dados }); },
      mudou: () => { ligarSaidas(); desenhar(); },
    });
    await malha.definir("microfone", faixa);
    ativa = { id: chamada, malha, microfone, camera: null, tela: null, mudo };
    ligarAnalisadorLocal();
    if (!g.enviarWs({ type: "chamadaEntrar", chamada, mudo })) {
      g.aviso("Sem conexão com o servidor. Tente de novo.");
      await sair();
      return;
    }
    g.som("entrar");
    vigiarFala();
    desenhar();
  }

  async function sair() {
    if (!ativa) return;
    const saindo = ativa;
    ativa = null;
    g.enviarWs({ type: "chamadaSair" });
    saindo.malha.encerrar();
    for (const s of [saindo.microfone, saindo.camera, saindo.tela?.stream]) s?.getTracks().forEach(t => t.stop());
    if (saindo.tela) window.clearInterval(saindo.tela.vigia);
    for (const sessao of [...saidas.keys()]) soltarSaida(sessao);
    assistindo.clear();
    falando.clear();
    window.clearInterval(vigiaDeFala);
    analisadorLocal = null;
    g.som("sair");
    desenhar();
  }

  // ------------------------------------------------------------ midia local

  async function alternarMudo() {
    if (!ativa) return;
    if (!ativa.microfone) {
      try {
        ativa.microfone = await navigator.mediaDevices.getUserMedia({ audio: opcoesDeCaptura(g.dispositivos().mic) });
        await ativa.malha.definir("microfone", ativa.microfone.getAudioTracks()[0] || null);
        ligarAnalisadorLocal();
      } catch { g.aviso("Não foi possível abrir o microfone."); return; }
    }
    ativa.mudo = !ativa.mudo;
    for (const t of ativa.microfone.getAudioTracks()) t.enabled = !ativa.mudo;
    localStorage.setItem(MIC_KEY, ativa.mudo ? "1" : "0");
    g.enviarWs({ type: "chamadaMidia", mudo: ativa.mudo });
    desenhar();
  }

  async function alternarCamera() {
    if (!ativa) return;
    if (ativa.camera) {
      ativa.camera.getTracks().forEach(t => t.stop());
      ativa.camera = null;
      await ativa.malha.definir("camera", null);
      g.enviarWs({ type: "chamadaMidia", camera: false });
      desenhar();
      return;
    }
    try {
      const cam = g.dispositivos().cam;
      ativa.camera = await navigator.mediaDevices.getUserMedia({
        video: { ...(cam ? { deviceId: cam } : {}), width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 } },
      });
      await ativa.malha.definir("camera", ativa.camera.getVideoTracks()[0] || null);
      g.enviarWs({ type: "chamadaMidia", camera: true });
    } catch { g.aviso("Não foi possível abrir a câmera."); }
    desenhar();
  }

  async function alternarTela(ancora?: HTMLElement) {
    if (!ativa) return;
    if (ativa.tela) { menuDaTela(ancora); return; }
    try {
      if (g.telaNativa) {
        const nativo = await g.telaNativa.iniciar();
        if (!nativo || !ativa) { nativo?.encerrar(); return; }
        // A janela transmitida fechou: a captura para sozinha, e sem este
        // aviso a tela congelaria para quem assiste sem ninguem entender.
        const vigia = window.setInterval(async () => {
          if (!(await nativo.viva().catch(() => true))) { pararTela(); g.aviso("A janela que você transmitia foi fechada."); }
        }, 3000);
        ativa.tela = { stream: null, nativo, pausada: false, vigia };
        ativa.malha.transmitir(nativo);
      } else {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true });
        if (!ativa) { stream.getTracks().forEach(t => t.stop()); return; }
        stream.getVideoTracks()[0]?.addEventListener("ended", () => pararTela());
        ativa.tela = { stream, nativo: null, pausada: false, vigia: 0 };
        ativa.malha.transmitir(new TransmissorWeb(stream));
      }
      g.enviarWs({ type: "chamadaMidia", tela: true });
    } catch (erro) {
      const nome = erro instanceof DOMException ? erro.name : "";
      if (nome !== "NotAllowedError" && nome !== "AbortError") {
        g.aviso(erro instanceof Error ? erro.message : typeof erro === "string" ? erro : "Não foi possível compartilhar a tela.");
      }
    }
    desenhar();
  }
  function pararTela() {
    if (!ativa?.tela) return;
    ativa.tela.stream?.getTracks().forEach(t => t.stop());
    window.clearInterval(ativa.tela.vigia);
    ativa.tela = null;
    ativa.malha.transmitir(null);
    g.enviarWs({ type: "chamadaMidia", tela: false });
    desenhar();
  }
  async function trocarTela() {
    const nativo = ativa?.tela?.nativo;
    if (!nativo || !g.telaNativa) return;
    const fonte = await g.telaNativa.escolherFonte();
    if (!fonte) return;
    try { await nativo.trocar(fonte); g.aviso("Tela trocada."); }
    catch (erro) { g.aviso(typeof erro === "string" ? erro : "Não foi possível trocar de tela."); }
  }
  async function pausarTela() {
    const tela = ativa?.tela;
    if (!tela?.nativo) return;
    try { tela.pausada = await tela.nativo.pausar(!tela.pausada); desenhar(); }
    catch { g.aviso("Não foi possível pausar."); }
  }

  /// Transmitindo, o botao de tela abre as opcoes em vez de parar direto,
  /// como na chamada de servidor.
  function menuDaTela(ancora?: HTMLElement) {
    fecharMenu();
    const tela = ativa?.tela;
    if (!tela) return;
    const menu = document.createElement("div");
    menu.id = "p2p-menu-tela";
    menu.className = "user-menu";
    const item = (texto: string, acao: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "user-menu-item";
      b.textContent = texto;
      b.onclick = () => { fecharMenu(); acao(); };
      menu.append(b);
    };
    if (tela.nativo) {
      item("Trocar tela", () => void trocarTela());
      item(tela.pausada ? "Retomar transmissão" : "Pausar transmissão", () => void pausarTela());
    }
    item("Parar de compartilhar", pararTela);
    document.body.append(menu);
    const caixa = (ancora || document.getElementById("p2p-tela"))?.getBoundingClientRect();
    if (caixa) {
      menu.style.left = Math.max(8, caixa.left) + "px";
      menu.style.top = Math.max(8, caixa.top - menu.offsetHeight - 8) + "px";
    }
    window.setTimeout(() => document.addEventListener("click", fecharMenu, { once: true }), 0);
  }
  function fecharMenu() { document.getElementById("p2p-menu-tela")?.remove(); }

  function assistir(sessao: number, sim: boolean) {
    if (!ativa) return;
    if (sim) assistindo.add(sessao); else assistindo.delete(sessao);
    ativa.malha.assistir(sessao, sim);
    desenhar();
  }

  // ------------------------------------------------------------ audio

  function audio() {
    if (!contexto) {
      contexto = new AudioContext();
      const saida = g.dispositivos().out;
      const comSaida = contexto as AudioContext & { setSinkId?: (id: string) => Promise<void> };
      if (saida && comSaida.setSinkId) void comSaida.setSinkId(saida).catch(() => {});
    }
    if (contexto.state === "suspended") void contexto.resume();
    return contexto;
  }

  /// Uma saida por pessoa: o elemento de audio segura a faixa (o Chromium so
  /// entrega som de faixa remota ao WebAudio se ela estiver presa num
  /// elemento) e o ganho aplica o volume dela, que vai ate 200%.
  function ligarSaidas() {
    if (!ativa) return;
    for (const par of ativa.malha.pares.values()) {
      const faixa = par.audio.getAudioTracks()[0];
      const atual = saidas.get(par.sessao);
      if (!faixa) continue;
      if (atual?.faixa === faixa.id) continue;
      if (atual) soltarSaida(par.sessao);
      const ctx = audio();
      const el = new Audio();
      el.srcObject = par.audio;
      el.muted = true;
      void el.play().catch(() => {});
      const fonte = ctx.createMediaStreamSource(par.audio);
      const ganho = ctx.createGain();
      ganho.gain.value = g.volume(par.nome);
      const analisador = ctx.createAnalyser();
      analisador.fftSize = 512;
      fonte.connect(ganho).connect(ctx.destination);
      fonte.connect(analisador);
      saidas.set(par.sessao, { el, ganho, analisador, fonte, faixa: faixa.id });
    }
    for (const sessao of [...saidas.keys()]) {
      if (!ativa.malha.pares.has(sessao)) soltarSaida(sessao);
    }
  }
  function soltarSaida(sessao: number) {
    const s = saidas.get(sessao);
    if (!s) return;
    s.fonte.disconnect(); s.ganho.disconnect();
    s.el.srcObject = null;
    saidas.delete(sessao);
  }
  /// O volume escolhido para alguem mudou (no perfil dele, por exemplo).
  function aplicarVolumes() {
    if (!ativa) return;
    for (const par of ativa.malha.pares.values()) {
      const s = saidas.get(par.sessao);
      if (s) s.ganho.gain.value = g.volume(par.nome);
    }
  }

  function ligarAnalisadorLocal() {
    if (!ativa?.microfone) return;
    const ctx = audio();
    analisadorLocal = ctx.createAnalyser();
    analisadorLocal.fftSize = 512;
    ctx.createMediaStreamSource(ativa.microfone).connect(analisadorLocal);
  }

  const nivel = (a: AnalyserNode) => {
    const dados = new Uint8Array(a.fftSize);
    a.getByteTimeDomainData(dados);
    let soma = 0;
    for (const v of dados) { const x = (v - 128) / 128; soma += x * x; }
    return Math.sqrt(soma / dados.length);
  };
  function vigiarFala() {
    window.clearInterval(vigiaDeFala);
    vigiaDeFala = window.setInterval(() => {
      if (!ativa) return;
      const antes = [...falando].join(",");
      falando.clear();
      if (analisadorLocal && !ativa.mudo && nivel(analisadorLocal) > 0.02) falando.add(g.eu().toLowerCase());
      for (const par of ativa.malha.pares.values()) {
        const s = saidas.get(par.sessao);
        if (s && nivel(s.analisador) > 0.02) falando.add(par.nome.toLowerCase());
      }
      if ([...falando].join(",") !== antes) {
        for (const el of palco.querySelectorAll<HTMLElement>("[data-quem]")) {
          el.classList.toggle("speaking", falando.has(el.dataset.quem || ""));
        }
      }
    }, 150);
  }

  // ------------------------------------------------------------ toque

  function tocar(chamada: string, de: string) {
    if (ativa?.id === chamada) return;
    pararToque();
    const titulo = g.titulo(chamada);
    const faixa = document.getElementById("chamada-toque") as HTMLElement;
    // Conversa a dois (ou grupo sem nome, de duas pessoas) tem o nome de quem
    // chama como titulo: repetir so ocupa espaco.
    const quem = g.nome(de);
    (document.getElementById("chamada-toque-texto") as HTMLElement).textContent =
      titulo === quem ? quem + " está chamando" : quem + " está chamando · " + titulo;
    faixa.classList.remove("hidden");
    g.som("toque");
    // Com o app escondido, minimizado ou atras do jogo, o aviso do Windows e o
    // unico que se ve.
    if (!document.hasFocus() || document.hidden) {
      g.notificar?.("Chamada de " + quem, titulo === quem ? "Toque para atender" : titulo, () => { g.abrirConversa(chamada); void entrar(chamada); });
    }
    const repique = window.setInterval(() => g.som("toque"), 2500);
    const timer = window.setTimeout(pararToque, 30_000);
    toque = { chamada, timer, repique };
  }
  function pararToque() {
    if (!toque) return;
    window.clearTimeout(toque.timer);
    window.clearInterval(toque.repique);
    toque = null;
    document.getElementById("chamada-toque")?.classList.add("hidden");
  }
  document.getElementById("chamada-atender")?.addEventListener("click", () => {
    const chamada = toque?.chamada;
    pararToque();
    if (!chamada) return;
    g.abrirConversa(chamada);
    void entrar(chamada);
  });
  document.getElementById("chamada-recusar")?.addEventListener("click", pararToque);

  // ------------------------------------------------------------ desenho

  function botao(id: string, titulo: string, icone: string, ativo: boolean, aoClicar: () => void, perigo = false) {
    const b = document.createElement("button");
    b.type = "button";
    b.id = id;
    b.className = "control" + (ativo ? " active" : "") + (perigo ? " danger" : "");
    b.title = titulo;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "ic");
    const uso = document.createElementNS("http://www.w3.org/2000/svg", "use");
    uso.setAttribute("href", "#i-" + icone);
    svg.append(uso);
    b.append(svg);
    b.onclick = aoClicar;
    return b;
  }

  function quadro(quem: string, rotulo: string, video: MediaStream | null, mudo: boolean, espelhar = false, estado?: RTCPeerConnectionState) {
    const tile = document.createElement("div");
    tile.className = "track-tile" + (video ? "" : " tile-voz");
    tile.dataset.quem = quem.toLowerCase();
    if (falando.has(quem.toLowerCase())) tile.classList.add("speaking");
    if (video) {
      const v = document.createElement("video");
      v.autoplay = true; v.playsInline = true; v.muted = true;
      v.srcObject = video;
      if (espelhar) v.style.transform = "scaleX(-1)";
      tile.append(v);
    } else {
      const foto = document.createElement("div");
      foto.className = "avatar tile-voz-foto";
      g.foto(foto, quem);
      tile.append(foto);
    }
    const label = document.createElement("label");
    label.textContent = (mudo ? "🔇 " : "") + rotulo;
    tile.append(label);
    // Conexao direta com esta pessoa ainda abrindo ou caida: o quadro diz,
    // em vez de mostrar uma imagem parada como se fosse a pessoa em silencio.
    if (estado && estado !== "connected") {
      const selo = document.createElement("span");
      selo.className = "p2p-estado";
      selo.textContent = estado === "failed" ? "sem conexão" : estado === "disconnected" ? "reconectando…" : "conectando…";
      tile.append(selo);
    }
    tile.ondblclick = () => { void (document.fullscreenElement ? document.exitFullscreen() : tile.requestFullscreen()); };
    return tile;
  }

  function desenhar() {
    const naTela = g.chamadaDaTela();
    const lista = naTela ? estados.get(naTela) || [] : [];
    const minha = Boolean(ativa && ativa.id === naTela);
    // Palco: a chamada em que estou, na conversa dela; ou o convite para
    // entrar numa que esta acontecendo na conversa aberta.
    painel.classList.toggle("hidden", !naTela || (!minha && lista.length === 0));
    if (naTela && !painel.classList.contains("hidden")) {
      const quadros: HTMLElement[] = [];
      if (minha && ativa) {
        quadros.push(quadro(g.eu(), g.nome(g.eu()) + " (você)", ativa.camera, ativa.mudo, true));
        if (ativa.tela) {
          const rotulo = (ativa.tela.pausada ? "Sua tela (pausada)" : "Sua tela") + " · " + ativa.malha.plateia + " assistindo";
          if (ativa.tela.stream) {
            const t = quadro(g.eu(), rotulo, ativa.tela.stream, false);
            t.classList.add("tela");
            quadros.push(t);
          } else {
            // Pelo app a imagem nao passa pelo WebView: fica o aviso.
            const card = document.createElement("div");
            card.className = "track-tile oferta tela";
            const titulo = document.createElement("span");
            titulo.className = "oferta-nome";
            titulo.textContent = rotulo;
            card.append(titulo);
            quadros.push(card);
          }
        }
        for (const par of ativa.malha.pares.values()) {
          const p = lista.find(item => item.sessao === par.sessao);
          const temVideo = p?.camera && par.video.getVideoTracks().length > 0;
          quadros.push(quadro(par.nome, g.nome(par.nome), temVideo ? par.video : null, Boolean(p?.mudo), false, par.estado));
          if (p?.tela) {
            if (assistindo.has(par.sessao) && par.tela) {
              const t = quadro(par.nome, "Tela de " + g.nome(par.nome), par.tela.stream, false);
              t.classList.add("tela");
              const parar = document.createElement("button");
              parar.className = "tile-action";
              parar.title = "Parar de assistir";
              parar.textContent = "✕";
              parar.onclick = e => { e.stopPropagation(); assistir(par.sessao, false); };
              t.append(parar);
              quadros.push(t);
            } else {
              const card = document.createElement("div");
              card.className = "track-tile oferta";
              const titulo = document.createElement("span");
              titulo.className = "oferta-nome";
              titulo.textContent = g.nome(par.nome) + " está compartilhando a tela";
              const b = document.createElement("button");
              b.className = "primary small";
              b.textContent = "Assistir";
              b.onclick = () => assistir(par.sessao, true);
              card.append(titulo, b);
              quadros.push(card);
            }
          }
        }
      } else {
        for (const p of lista) quadros.push(quadro(p.username, g.nome(p.username), null, p.mudo));
      }
      palco.replaceChildren(...quadros);
      reajustar();
      const barra = document.getElementById("chamada-controles") as HTMLElement;
      if (minha && ativa) {
        barra.replaceChildren(
          botao("p2p-mic", ativa.mudo ? "Ativar microfone" : "Silenciar microfone", ativa.mudo ? "mic-off" : "mic", !ativa.mudo, () => void alternarMudo()),
          botao("p2p-cam", ativa.camera ? "Desligar câmera" : "Ligar câmera", "cam", Boolean(ativa.camera), () => void alternarCamera()),
          botao("p2p-tela", ativa.tela ? "Trocar tela, pausar ou parar" : "Compartilhar tela", "screen", Boolean(ativa.tela), () => void alternarTela(document.getElementById("p2p-tela") || undefined)),
          botao("p2p-sair", "Sair da chamada", "hangup", false, () => void sair(), true),
        );
      } else {
        const entrarBtn = document.createElement("button");
        entrarBtn.type = "button";
        entrarBtn.className = "primary";
        entrarBtn.textContent = "Entrar na chamada";
        entrarBtn.onclick = () => void entrar(naTela!);
        barra.replaceChildren(entrarBtn);
      }
    }
    // Barra pequena: estou numa chamada mas olhando outra coisa.
    const longe = Boolean(ativa && ativa.id !== naTela);
    mini.classList.toggle("hidden", !longe);
    if (longe && ativa) {
      (document.getElementById("chamada-mini-titulo") as HTMLElement).textContent = g.titulo(ativa.id);
      (document.getElementById("chamada-mini-quantos") as HTMLElement).textContent =
        (estados.get(ativa.id)?.length || 1) + " na chamada";
    }
    g.mudou();
  }
  document.getElementById("chamada-mini-voltar")?.addEventListener("click", () => { if (ativa) g.abrirConversa(ativa.id); });
  document.getElementById("chamada-mini-sair")?.addEventListener("click", () => void sair());

  // ------------------------------------------------------------ eventos

  type Evento = { type: string; chamada?: string; participantes?: Participante[]; de?: string; deSessao?: number; dados?: Sinal };
  function tratarEvento(e: Evento): boolean {
    if (e.type === "chamadaEstado" && e.chamada) {
      const lista = e.participantes || [];
      if (lista.length) estados.set(e.chamada, lista); else estados.delete(e.chamada);
      if (toque?.chamada === e.chamada && !lista.length) pararToque();
      if (ativa?.id === e.chamada) {
        // Parei de aparecer (socket caiu e voltou, por exemplo): a chamada
        // acabou para mim do lado do servidor.
        if (!lista.some(p => p.sessao === g.sessao())) { void sair(); return true; }
        ativa.malha.sincronizar(lista);
        for (const sessao of [...assistindo]) {
          if (!lista.find(p => p.sessao === sessao)?.tela) assistindo.delete(sessao);
        }
      }
      desenhar();
      return true;
    }
    if (e.type === "chamadaTocando" && e.chamada && e.de) { tocar(e.chamada, e.de); return true; }
    if (e.type === "sinal" && e.chamada && e.dados && e.deSessao !== undefined) {
      if (ativa?.id === e.chamada) void ativa.malha.receber(e.deSessao, e.de || "", e.dados).catch(erro => console.warn("[chamada] sinal", erro));
      return true;
    }
    return false;
  }

  async function carregar() {
    try {
      const todas = await g.api<Record<string, Participante[]>>("/api/chamadas");
      estados.clear();
      for (const [id, lista] of Object.entries(todas)) estados.set(id, lista);
      desenhar();
    } catch { /* sem lista, os eventos preenchem */ }
  }

  /// O socket caiu e voltou com numero novo: a chamada antiga morreu com ele.
  function socketReaberto() {
    if (ativa) { const id = ativa.id; void sair().then(() => g.aviso("A conexão caiu e a chamada foi encerrada.", () => void entrar(id))); }
    void carregar();
  }

  return {
    entrar, sair, tratarEvento, carregar, desenhar, aplicarVolumes, socketReaberto,
    get ativa() { return ativa?.id || null; },
    /// Quantas pessoas estao numa chamada agora (para a lista lateral).
    quantos: (chamada: string) => estados.get(chamada)?.length || 0,
  };
}

/// Identificador da chamada de uma conversa a dois: os nomes em minusculas e em
/// ordem, igual para os dois lados.
export function chamadaDoPar(a: string, b: string) {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort();
  return "dm:" + x + "|" + y;
}
