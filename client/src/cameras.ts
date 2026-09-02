// Janela separada de cameras.
//
// Cada janela do Tauri e um WebView independente, com contexto JS proprio, e
// faixas de video do WebRTC nao atravessam essa fronteira. Entao esta janela
// entra na sala por conta propria, com um token de espectador: nao publica nada
// e e marcada como oculta, entao nao aparece para os outros participantes.
//
// A janela principal cancela a assinatura das cameras enquanto esta janela
// estiver aberta, entao o consumo de banda apenas muda de lugar.

import { RemoteParticipant, RemoteTrack, Room, RoomEvent, Track } from "livekit-client";
import { grade } from "./gridlayout";
import "./styles.css";
import { instalarBarra } from "./barra";

import * as servidor from "./servidor";

// A janela separada precisa do mesmo servidor que a principal escolheu.
const API = servidor.endereco();
type AuthSession = { token: string; username: string; expiresAt: number };
type LivekitAccess = { token: string; url: string; room: string };

const grid = document.getElementById("cameras-grid") as HTMLDivElement;
const status = document.getElementById("cameras-status") as HTMLDivElement;
const roomId = new URLSearchParams(location.search).get("room") || "";
const speaking = new Set<string>();
// Cor do anel de cada pessoa. Esta janela e um WebView proprio: nao enxerga a
// memoria do aplicativo, entao busca os perfis por conta uma vez ao abrir.
const cores = new Map<string, string>();

/// `#rrggbb` e nada mais — o valor entra num estilo, e o servidor ja valida,
/// mas quem escreve na tela e este lado.
function corSegura(valor: string | null | undefined): string | null {
  return valor && /^#[0-9a-f]{6}$/i.test(valor) ? valor : null;
}

async function carregarCores(sessao: AuthSession) {
  try {
    const resposta = await fetch(API + "/api/bootstrap", {
      headers: { Authorization: "Bearer " + sessao.token },
    });
    if (!resposta.ok) return;
    const dados = await resposta.json() as { profiles?: { username: string; color?: string | null }[] };
    for (const perfil of dados.profiles || []) {
      const cor = corSegura(perfil.color);
      if (cor) cores.set(perfil.username.toLowerCase(), cor);
    }
    updateSpeaking();
  } catch { /* sem cores, fica o padrao */ }
}
// A grade se refaz quando a janela muda de forma: janela alta empilha, janela
// larga enfileira. E o mesmo calculo do painel dentro do app.
//
// A proporcao sai da primeira camera que reporta tamanho, em vez de um chute
// fixo: webcam 16:9 numa grade calculada para 4:3 sobra faixa preta dos dois
// lados, que e exatamente o "nao cabe direito" que se ve na janela.
let proporcaoReal = 16 / 9;
const ajustar = grade(grid, () => proporcaoReal);

/// Aprende a proporcao com o primeiro quadro que chegar.
function aprenderProporcao(media: HTMLVideoElement) {
  const ler = () => {
    if (!media.videoWidth || !media.videoHeight) return;
    const nova = media.videoWidth / media.videoHeight;
    // Refazer a grade a cada quadro seria desperdicio; so mudanca real conta.
    if (Math.abs(nova - proporcaoReal) < 0.01) return;
    proporcaoReal = nova;
    ajustar();
  };
  media.addEventListener("loadedmetadata", ler);
  media.addEventListener("resize", ler);
  ler();
}

function readSession(): AuthSession | null {
  try {
    const value = JSON.parse(localStorage.getItem("naoconcordo.session") || "null") as AuthSession | null;
    return value && value.expiresAt * 1000 > Date.now() ? value : null;
  } catch { return null; }
}
function setStatus(text: string) {
  status.textContent = text;
  status.classList.toggle("hidden", !text);
}
function updateSpeaking() {
  grid.querySelectorAll<HTMLElement>("[data-who]").forEach(tile => {
    const quem = (tile.dataset.who || "").toLowerCase();
    tile.classList.toggle("speaking", speaking.has(quem));
    const cor = cores.get(quem);
    if (cor) tile.style.setProperty("--anel", cor);
    else tile.style.removeProperty("--anel");
  });
}
function addTile(track: RemoteTrack, who: string) {
  if (!track.sid || document.getElementById("cam-" + track.sid)) return;
  const tile = document.createElement("div");
  tile.id = "cam-" + track.sid;
  tile.className = "camera-tile";
  tile.dataset.who = who;
  const media = track.attach();
  if (media instanceof HTMLVideoElement) {
    media.autoplay = true; media.playsInline = true; media.muted = true;
    aprenderProporcao(media);
  }
  const label = document.createElement("label");
  label.textContent = who;
  // Duplo clique amplia, igual ao painel de dentro do app: dois lugares que
  // mostram camera nao podem responder a gestos diferentes.
  tile.ondblclick = () => {
    if (document.fullscreenElement) { void document.exitFullscreen(); return; }
    for (const outra of grid.querySelectorAll(".camera-tile")) outra.classList.remove("cheia");
    tile.classList.add("cheia");
    void grid.requestFullscreen().catch(() => { /* bloqueada */ });
  };
  tile.append(media, label);
  grid.append(tile);
  setStatus("");
  ajustar();
  updateSpeaking();
}
function removeTile(sid?: string) {
  if (!sid) return;
  document.getElementById("cam-" + sid)?.remove();
  ajustar();
  if (!grid.children.length) setStatus("Ninguém com a câmera ligada.");
}

async function start() {
  const session = readSession();
  if (!session) { setStatus("Entre pela janela principal primeiro."); return; }
  if (!roomId) { setStatus("Canal de voz não informado."); return; }
  // Nao bloqueia a entrada na sala: sem as cores o anel sai no padrao, e a
  // camera importa mais que o tom dele.
  void carregarCores(session);
  try {
    const response = await fetch(API + "/api/livekit-token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + session.token },
      body: JSON.stringify({ roomId, viewer: true }),
    });
    if (!response.ok) throw new Error("Não foi possível obter acesso à sala.");
    const access = await response.json() as LivekitAccess;

    // autoSubscribe desligado: esta janela assina apenas faixas de camera.
    const room = new Room({ adaptiveStream: true, dynacast: true });
    room
      .on(RoomEvent.TrackPublished, (publication, participant: RemoteParticipant) => {
        if (publication.source === Track.Source.Camera) void publication.setSubscribed(true);
        else void publication.setSubscribed(false);
        void participant;
      })
      .on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
        if (track.source === Track.Source.Camera) addTile(track, participant.name || participant.identity);
      })
      .on(RoomEvent.TrackUnsubscribed, track => removeTile(track.sid))
      .on(RoomEvent.ActiveSpeakersChanged, speakers => {
        speaking.clear();
        for (const speaker of speakers) speaking.add((speaker.name || speaker.identity).toLowerCase());
        updateSpeaking();
      })
      .on(RoomEvent.Disconnected, () => setStatus("Desconectado da chamada."));

    await room.connect(access.url, access.token, { autoSubscribe: false });
    setStatus("Ninguém com a câmera ligada.");
    // Assina o que ja estava publicado antes desta janela abrir.
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (publication.source === Track.Source.Camera) void publication.setSubscribed(true);
      }
    }
    // Avisa a janela principal para ela voltar a assinar as cameras.
    let announced = false;
    const announceClose = async () => {
      if (announced) return;
      announced = true;
      room.disconnect();
      try {
        const { emit } = await import("@tauri-apps/api/event");
        await emit("cameras-fechada");
      } catch { /* fora do Tauri: a principal reconcilia pelo polling */ }
    };
    // onCloseRequested roda ANTES da janela morrer e espera a promessa, entao o
    // emit chega. beforeunload/pagehide nao garantem isso no WebView2.
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().onCloseRequested(async () => { await announceClose(); });
    } catch { /* fora do Tauri */ }

    // Sinal de vida. E o que a janela principal realmente usa: se esta janela
    // morrer de qualquer jeito, os sinais param e ela percebe em ~3 segundos.
    // Eventos de fechamento se mostraram pouco confiaveis no WebView2.
    try {
      const { emit } = await import("@tauri-apps/api/event");
      await emit("cameras-viva");
      window.setInterval(() => { void emit("cameras-viva"); }, 1000);
    } catch { /* fora do Tauri */ }
    window.addEventListener("beforeunload", () => { void announceClose(); });
    window.addEventListener("pagehide", () => { void announceClose(); });
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Falha ao conectar.");
  }
}

void instalarBarra("Câmeras — naoconcordo");
void start();
