// Janela separada das transmissoes de tela.
//
// Mesma ideia da janela de cameras: cada janela do Tauri e um WebView proprio e
// faixas do WebRTC nao atravessam essa fronteira, entao esta janela entra na
// sala por conta propria com um token de espectador — nao publica nada e fica
// oculta para os outros.
//
// Os controles da transmissao (trocar tela, pausar, parar) ficam no botao
// Compartilhar da janela principal; esta janela so mostra as telas.

import { RemoteTrack, Room, RoomEvent, Track } from "livekit-client";
import "./styles.css";
import { instalarBarra } from "./barra";

import * as servidor from "./servidor";

// A janela separada precisa do mesmo servidor que a principal escolheu.
const API = servidor.endereco();
type AuthSession = { token: string; username: string; expiresAt: number };
type LivekitAccess = { token: string; url: string; room: string };

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const grid = byId<HTMLDivElement>("telas-grid");
const roomId = new URLSearchParams(location.search).get("room") || "";
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
