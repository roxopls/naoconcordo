// Janela separada das transmissoes de tela.
//
// Mesma ideia da janela de cameras: cada janela do Tauri e um WebView proprio e
// faixas do WebRTC nao atravessam essa fronteira, entao esta janela entra na
// sala por conta propria com um token de espectador — nao publica nada e fica
// oculta para os outros.
//
// Os controles da transmissao (trocar tela, pausar, parar) ficam no botao
// Compartilhar da janela principal; esta janela so mostra as telas.

import { RemoteParticipant, RemoteTrack, RemoteTrackPublication, Room, RoomEvent, Track } from "livekit-client";
import { grade } from "./gridlayout";
import "./styles.css";
import { instalarBarra } from "./barra";

import * as servidor from "./servidor";

// A janela separada precisa do mesmo servidor que a principal escolheu.
const API = servidor.endereco();
type AuthSession = { token: string; username: string; expiresAt: number };
type LivekitAccess = { token: string; url: string; room: string };

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const grid = byId<HTMLDivElement>("telas-grid");
const barraFontes = byId<HTMLElement>("telas-bar");
const escolha = byId<HTMLDivElement>("telas-escolha");
const roomId = new URLSearchParams(location.search).get("room") || "";

// A grade se refaz quando a janela muda de forma, igual a da janela de cameras:
// as linhas dividem a altura disponivel em vez de sairem da proporcao do video.
let proporcaoReal = 16 / 9;
const ajustar = grade(grid, () => proporcaoReal);

/// Aprende a proporcao com o primeiro quadro que chegar.
///
/// Chute fixo nao serve: tela de notebook 16:10 e janela avulsa 4:3 entram aqui
/// com a mesma frequencia que o monitor 16:9.
function aprenderProporcao(media: HTMLVideoElement) {
  const ler = () => {
    if (!media.videoWidth || !media.videoHeight) return;
    const nova = media.videoWidth / media.videoHeight;
    if (Math.abs(nova - proporcaoReal) < 0.01) return;
    proporcaoReal = nova;
    ajustar();
  };
  media.addEventListener("loadedmetadata", ler);
  media.addEventListener("resize", ler);
  ler();
}

// As transmissoes que existem na sala, escolhidas ou nao, por `trackSid`. A
// barra sai daqui: uma tela desligada continua listada, senao nao haveria como
// ligar de volta.
type Fonte = { publicacao: RemoteTrackPublication; quem: string; identidade: string };
const fontes = new Map<string, Fonte>();
// Quem a pessoa desligou, por identidade do publicador — nao por `trackSid`,
// que muda a cada vez que a transmissao recomeca. Sem isto, quem desliga uma
// tela a ve voltar sozinha no primeiro "pausar e continuar" do outro lado.
const desligados = new Set<string>();
function readSession(): AuthSession | null {
  try {
    const value = JSON.parse(localStorage.getItem("naoconcordo.session") || "null") as AuthSession | null;
    return value && value.expiresAt * 1000 > Date.now() ? value : null;
  } catch { return null; }
}

function setStatus(text: string) {
  const status = byId("telas-status");
  status.textContent = text;
  status.classList.toggle("hidden", !text);
}

function addTile(track: RemoteTrack, who: string) {
  if (!track.sid || document.getElementById("tela-" + track.sid)) return;
  const tile = document.createElement("div");
  tile.id = "tela-" + track.sid;
  tile.className = "tela-tile";
  const media = track.attach();
  if (media instanceof HTMLVideoElement) {
    media.autoplay = true; media.playsInline = true; media.muted = true;
    aprenderProporcao(media);
  }
  const label = document.createElement("label");
  label.textContent = who;
  tile.append(media, label);
  grid.append(tile);
  ajustar();
  atualizarEstado();
}

function removeTile(sid?: string) {
  if (!sid) return;
  document.getElementById("tela-" + sid)?.remove();
  ajustar();
  atualizarEstado();
}

/// O aviso do meio da janela e a barra de escolha, sempre a partir do mesmo
/// estado: sem isto, "Ninguem transmitindo agora" aparecia sobre uma tela que a
/// pessoa tinha acabado de desligar por conta.
function atualizarEstado() {
  barraFontes.classList.toggle("hidden", fontes.size === 0);
  if (grid.children.length) { setStatus(""); return; }
  if (fontes.size === 0) { setStatus("Ninguém transmitindo agora."); return; }
  const algumaLigada = [...fontes.values()].some(f => !desligados.has(f.identidade));
  setStatus(algumaLigada ? "" : "Nenhuma tela escolhida — ligue uma na barra de cima.");
}

/// Assina ou cancela conforme a escolha guardada. Tela desligada e tela nao
/// assinada: esconder com CSS gastaria a banda de um video que ninguem ve.
function aplicarEscolha(fonte: Fonte) {
  void fonte.publicacao.setSubscribed(!desligados.has(fonte.identidade));
}

/// Um botao por transmissao. O rotulo e o nome de quem publica; com duas
/// transmissoes da mesma pessoa (a do aplicativo e a captura nativa) entra o
/// numero, senao os dois botoes ficariam iguais e indistinguiveis.
function desenharBarra() {
  escolha.textContent = "";
  const porPessoa = new Map<string, number>();
  for (const fonte of fontes.values()) {
    const ordem = (porPessoa.get(fonte.quem) || 0) + 1;
    porPessoa.set(fonte.quem, ordem);
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "telas-fonte";
    botao.classList.toggle("ligada", !desligados.has(fonte.identidade));
    const ponto = document.createElement("span");
    ponto.className = "ponto";
    botao.append(ponto, document.createTextNode(fonte.quem + (ordem > 1 ? " (" + ordem + ")" : "")));
    botao.onclick = () => {
      if (desligados.has(fonte.identidade)) desligados.delete(fonte.identidade);
      else desligados.add(fonte.identidade);
      // A escolha vale para todas as transmissoes daquela identidade, entao
      // reaplica em todas em vez de so nesta.
      for (const outra of fontes.values()) {
        if (outra.identidade === fonte.identidade) aplicarEscolha(outra);
      }
      desenharBarra();
      atualizarEstado();
    };
    escolha.append(botao);
  }
  atualizarEstado();
}

/// Uma transmissao entrou na sala. Tela nova chega ligada: quem abriu esta
/// janela quer ver o que aparecer, e desligar e um clique.
function registrarFonte(publicacao: RemoteTrackPublication, participante: RemoteParticipant) {
  if (publicacao.source !== Track.Source.ScreenShare) return;
  const identidade = participante.identity;
  const fonte: Fonte = { publicacao, quem: participante.name || identidade, identidade };
  fontes.set(publicacao.trackSid, fonte);
  aplicarEscolha(fonte);
  desenharBarra();
}

/// A transmissao saiu do ar de verdade (despublicada), que e diferente de ter
/// sido desligada aqui: nesse caso o botao tem de sumir da barra.
function esquecerFonte(sid: string) {
  if (!fontes.delete(sid)) return;
  removeTile(sid);
  desenharBarra();
}

async function start() {
  const session = readSession();
  if (!session) { setStatus("Entre pela janela principal primeiro."); return; }
  if (!roomId) { setStatus("Canal de voz não informado."); return; }

  try {
    const response = await fetch(API + "/api/livekit-token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + session.token },
      body: JSON.stringify({ roomId, viewer: true }),
    });
    if (!response.ok) throw new Error("Não foi possível obter acesso à sala.");
    const access = await response.json() as LivekitAccess;

    // Só video de tela: o audio da transmissao continua saindo pela janela
    // principal, senao a mesma faixa tocaria duas vezes.
    const room = new Room({ adaptiveStream: true, dynacast: true });
    room
      .on(RoomEvent.TrackPublished, (publication, participant) => registrarFonte(publication, participant))
      .on(RoomEvent.TrackUnpublished, publication => esquecerFonte(publication.trackSid))
      .on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
        if (track.source === Track.Source.ScreenShare) addTile(track, participant.name || participant.identity);
      })
      // Cancelar a assinatura tambem cai aqui, e e o que faz a tela desligada
      // desaparecer da grade sem sair da barra.
      .on(RoomEvent.TrackUnsubscribed, track => removeTile(track.sid))
      // Tela nao muta, despublica; mesmo assim o mute e tratado por seguranca.
      .on(RoomEvent.TrackMuted, publication => {
        if (publication.source === Track.Source.ScreenShare) removeTile(publication.trackSid);
      })
      .on(RoomEvent.ParticipantDisconnected, participante => {
        for (const publicacao of participante.trackPublications.values()) esquecerFonte(publicacao.trackSid);
      })
      .on(RoomEvent.Disconnected, () => setStatus("Desconectado da chamada."));

    await room.connect(access.url, access.token, { autoSubscribe: false });
    // O que ja estava no ar antes desta janela abrir.
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) registrarFonte(publication, participant);
    }
    atualizarEstado();

    let announced = false;
    const announceClose = async () => {
      if (announced) return;
      announced = true;
      // Mesma espera da janela de cameras: o espectador desta janela e um
      // participante a parte, e sem o `await` ele so morria por `dtls timeout`,
      // muito depois de a janela ter fechado. Teto de 2 s para saida travada
      // nao travar o fechamento.
      await Promise.race([
        room.disconnect().catch(() => { /* ja caiu */ }),
        new Promise(pronto => window.setTimeout(pronto, 2000)),
      ]);
      try {
        const { emit } = await import("@tauri-apps/api/event");
        await emit("telas-fechada");
      } catch { /* fora do Tauri */ }
    };
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().onCloseRequested(async () => { await announceClose(); });
    } catch { /* fora do Tauri */ }

    // Sinal de vida, mesmo motivo da janela de cameras: no WebView2 os eventos
    // de fechamento nao sao confiaveis, mas a ausencia de batidas e.
    try {
      const { emit } = await import("@tauri-apps/api/event");
      await emit("telas-viva");
      window.setInterval(() => { void emit("telas-viva"); }, 1000);
    } catch { /* fora do Tauri */ }
    window.addEventListener("beforeunload", () => { void announceClose(); });
    window.addEventListener("pagehide", () => { void announceClose(); });
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Falha ao conectar.");
  }
}

void instalarBarra("Telas — naoconcordo");
void start();
