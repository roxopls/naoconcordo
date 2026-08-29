// Janela separada das transmissoes de tela.
//
// Mesma ideia da janela de cameras: cada janela do Tauri e um WebView proprio e
// faixas do WebRTC nao atravessam essa fronteira, entao esta janela entra na
// sala por conta propria com um token de espectador — nao publica nada e fica
// oculta para os outros.
//
// A diferenca e que aqui tambem moram os controles da transmissao. Trocar de
// tela **nao** para o compartilhamento: o Rust troca o alvo da captura e a
// faixa publicada continua a mesma, entao quem assiste nem percebe.

import { RemoteTrack, Room, RoomEvent, Track } from "livekit-client";
import "./styles.css";
import {
  pickSource, startShare, stopShare, switchShare, codecPreferido, type ShareQuality,
} from "./screenshare";

const API = import.meta.env.VITE_SERVER_URL || "http://127.0.0.1:3040";
type AuthSession = { token: string; username: string; expiresAt: number };
type LivekitAccess = { token: string; url: string; room: string };
type Quality = { id: string; label: string; hint: string } & ShareQuality;

// Os mesmos degraus da janela principal. Ficam repetidos de proposito: importar
// o `main.ts` traria o aplicativo inteiro para dentro desta janela.
const QUALITIES: Quality[] = [
  { id: "720p30", label: "720p 30fps", hint: "leve, para upload curto", width: 1280, height: 720, fps: 30, bitrate: 3_000_000 },
  { id: "1080p30", label: "1080p 30fps", hint: "equilíbrio, bom para janela e leitura", width: 1920, height: 1080, fps: 30, bitrate: 5_000_000 },
  { id: "1080p60", label: "1080p 60fps", hint: "movimento fluido, para jogo", width: 1920, height: 1080, fps: 60, bitrate: 8_000_000 },
];
const QUALITY_KEY = "naoconcordo.quality";
const readQuality = (): Quality =>
  QUALITIES.find(item => item.id === localStorage.getItem(QUALITY_KEY)) || QUALITIES[1];

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const grid = byId<HTMLDivElement>("telas-grid");
const roomId = new URLSearchParams(location.search).get("room") || "";
// A janela principal informa se ja havia transmissao ao abrir, para os botoes
// nascerem no estado certo.
let sharing = new URLSearchParams(location.search).get("sharing") === "1";

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

function paintControls(current = "") {
  byId<HTMLButtonElement>("telas-share").textContent = sharing ? "Compartilhando" : "Compartilhar tela";
  byId<HTMLButtonElement>("telas-share").disabled = sharing;
  byId<HTMLButtonElement>("telas-switch").disabled = !sharing;
  byId<HTMLButtonElement>("telas-stop").disabled = !sharing;
  if (current) byId("telas-current").textContent = current;
  if (!sharing) byId("telas-current").textContent = "";
}

function addTile(track: RemoteTrack, who: string) {
  if (!track.sid || document.getElementById("tela-" + track.sid)) return;
  const tile = document.createElement("div");
  tile.id = "tela-" + track.sid;
  tile.className = "tela-tile";
  const media = track.attach();
  if (media instanceof HTMLVideoElement) { media.autoplay = true; media.playsInline = true; media.muted = true; }
  const label = document.createElement("label");
  label.textContent = who;
  tile.append(media, label);
  grid.append(tile);
  setStatus("");
}

function removeTile(sid?: string) {
  if (!sid) return;
  document.getElementById("tela-" + sid)?.remove();
  if (!grid.children.length) setStatus("Ninguém transmitindo agora.");
}

/// Comeca a transmitir a partir desta janela. Precisa de um token proprio de
/// publicador de tela, igual ao da janela principal.
async function comecar() {
  const session = readSession();
  if (!session) { setStatus("Entre pela janela principal primeiro."); return; }
  const escolha = await pickSource(QUALITIES, readQuality(), byId);
  if (!escolha) return;
  localStorage.setItem(QUALITY_KEY, escolha.quality.id);
  try {
    const response = await fetch(API + "/api/livekit-token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + session.token },
      body: JSON.stringify({ roomId, screen: true }),
    });
    if (!response.ok) throw new Error("Não foi possível obter acesso à sala.");
    const access = await response.json() as LivekitAccess;
    await startShare(
      escolha.sourceId, access.url, access.token, escolha.quality, escolha.audio,
      false, true, codecPreferido(),
    );
    sharing = true;
    paintControls(escolha.sourceId);
    await avisarPrincipal();
  } catch (erro) {
    setStatus(erro instanceof Error ? erro.message : "Falha ao compartilhar.");
  }
}

/// Troca a tela sem derrubar a transmissao. E o motivo desta janela existir.
async function trocar() {
  const escolha = await pickSource(QUALITIES, readQuality(), byId);
  if (!escolha) return;
  try {
    await switchShare(escolha.sourceId);
    paintControls(escolha.sourceId);
  } catch (erro) {
    setStatus(erro instanceof Error ? erro.message : "Falha ao trocar de tela.");
  }
}

async function parar() {
  try { await stopShare(); } catch { /* ja estava parado */ }
  sharing = false;
  paintControls();
  await avisarPrincipal();
}

/// Mantem o botao da janela principal em sincronia com o que foi feito aqui.
async function avisarPrincipal() {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("telas-estado", { sharing });
  } catch { /* fora do Tauri */ }
}

async function start() {
  const session = readSession();
  if (!session) { setStatus("Entre pela janela principal primeiro."); return; }
  if (!roomId) { setStatus("Canal de voz não informado."); return; }

  byId("telas-share").addEventListener("click", () => void comecar());
  byId("telas-switch").addEventListener("click", () => void trocar());
  byId("telas-stop").addEventListener("click", () => void parar());
  paintControls();

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
      .on(RoomEvent.TrackPublished, publication => {
        void publication.setSubscribed(publication.source === Track.Source.ScreenShare);
      })
      .on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
        if (track.source === Track.Source.ScreenShare) addTile(track, participant.name || participant.identity);
      })
      .on(RoomEvent.TrackUnsubscribed, track => removeTile(track.sid))
      // Tela nao muta, despublica; mesmo assim o mute e tratado por seguranca.
      .on(RoomEvent.TrackMuted, publication => {
        if (publication.source === Track.Source.ScreenShare) removeTile(publication.trackSid);
      })
      .on(RoomEvent.Disconnected, () => setStatus("Desconectado da chamada."));

    await room.connect(access.url, access.token, { autoSubscribe: false });
    setStatus("Ninguém transmitindo agora.");
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (publication.source === Track.Source.ScreenShare) void publication.setSubscribed(true);
      }
    }

    let announced = false;
    const announceClose = async () => {
      if (announced) return;
      announced = true;
      room.disconnect();
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

void start();
