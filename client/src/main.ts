import { invoke } from "@tauri-apps/api/core";
import { abrirExterno, abrirJanela, ehTauri } from "./ambiente";
import {
  LocalTrackPublication, RemoteParticipant, RemoteTrack, Room, RoomEvent,
  Track, VideoPresets,
} from "livekit-client";
import "./styles.css";
import * as voz from "./voz";
import {
  checkPin, dropPin, fingerprint, loadIdentity, openMessage, savePin, sealMessage,
  type Identity,
} from "./private";
import { checkForUpdate, procurarAtualizacao, instalarAtualizacao, canalAtual, definirCanal, notasSalvas, limparNotas } from "./updates";
import {
  pickSource, startShare, stopShare, pauseShare, targetAlive,
  codecPreferido, guardarCodec, type CodecPreferido,
} from "./screenshare";
import {
  askInput, confirmAction, parseRecoveryFile, readDraft, readNavigation,
  saveDraft, saveNavigation, showNotice,
} from "./qol";
import {
  desktopNotificationsOn, notificationPreviewOn, notificationsInCallOn, notifyMessage, sendTestNotification,
  setDesktopNotifications, setNotificationPreview, setNotificationsInCall,
} from "./notifications";

const API = import.meta.env.VITE_SERVER_URL || "http://127.0.0.1:3040";
const WS = API.replace(/^http/, "ws");
type StoredFile = { id: string; name: string; mime: string; size: number; owner: string };
type ChatMessage = { id: string; username: string; text: string; createdAt: string; editedAt?: string | null; roomId: string; attachments?: StoredFile[]; replyTo?: string | null; reactions?: Record<string, string[]>; pinned?: boolean };
type AuthSession = { token: string; username: string; expiresAt: number };
type ServerInfo = { id: string; name: string; iconFile?: string | null; bannerFile?: string | null; description?: string | null };
type RoomKind = "text" | "voice";
type RoomInfo = { id: string; name: string; serverId: string; kind: RoomKind };
type Profile = { username: string; avatar: string | null; avatarFile?: string | null; bio?: string | null; bannerFile?: string | null };
type ServerRole = "owner" | "mod" | "member";
type Bootstrap = { servers: ServerInfo[]; rooms: RoomInfo[]; profiles: Profile[]; isOwner: boolean; isAdmin: boolean; roles: Record<string, ServerRole>; online: string[]; voice?: Record<string, string[]> };
type LivekitAccess = { token: string; url: string; room: string };
type Friendship = { requester: string; addressee: string; status: "pending" | "accepted" };
type FriendsData = { friends: string[]; incoming: Friendship[]; outgoing: Friendship[] };
type IdentityKey = { username: string; publicKey: string };
type Envelope = { id: string; from: string; to: string; ciphertext: string; nonce: string; createdAt: string; editedAt?: string | null; attachments?: StoredFile[]; replyTo?: string | null };
type DirectMessage = { id: string; from: string; to: string; text: string; createdAt: string; editedAt?: string | null; attachments?: StoredFile[]; replyTo?: string | null };
type Invite = { code: string; label: string; createdAt: string; createdBy: string; usedBy: string | null; usedAt: string | null; revoked: boolean };
type ServerInvite = { id: string; serverId: string; serverName: string; from: string; to: string; createdAt: string };
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
/// Troca o icone de um botao que ja tem um svg dentro.
function setIcon(button: HTMLElement, name: string) {
  button.querySelector("use")?.setAttribute("href", "#i-" + name);
}
/// Icone do sprite declarado no index.html.
function icon(name: string, extra = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "ic" + (extra ? " " + extra : ""));
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-" + name);
  svg.append(use);
  return svg;
}

const loginView = byId<HTMLDivElement>("login-view"), appView = byId<HTMLDivElement>("app-view");
const loginForm = byId<HTMLFormElement>("login-form"), loginError = byId<HTMLParagraphElement>("login-error");
const messageForm = byId<HTMLFormElement>("message-form"), messageInput = byId<HTMLTextAreaElement>("message-input");
const messagesEl = byId<HTMLElement>("messages"), stage = byId<HTMLElement>("stage");
const peopleList = byId<HTMLDivElement>("people-list"), voiceUsers = byId<HTMLDivElement>("voice-users");
const statusPill = byId<HTMLDivElement>("status-pill");
const connectionState = byId<HTMLElement>("connection-state"), toastEl = byId<HTMLDivElement>("toast");
const micButton = byId<HTMLButtonElement>("mic-button"), screenButton = byId<HTMLButtonElement>("screen-button");
const camButton = byId<HTMLButtonElement>("cam-button");
const audioButton = byId<HTMLButtonElement>("audio-button"), leaveButton = byId<HTMLButtonElement>("leave-button");

let session: AuthSession | null = readSession();
let chat: WebSocket | null = null, room: Room | null = null;
let servers: ServerInfo[] = [], rooms: RoomInfo[] = [], history: ChatMessage[] = [];
let profiles = new Map<string, Profile>(), currentServerId = "", currentRoomId = "", isAdmin = false;
// Canal de voz onde a chamada esta, independente do canal de texto aberto.
let voiceRoomId = "";
// "home" mostra amigos e conversas privadas; "server", os canais.
let view: "home" | "server" = "home";
// Quem esta conectado agora, e a lista de membros do servidor aberto.
const onlineUsers = new Set<string>();
let serverMembers: string[] = [];
// Quem esta em cada canal de voz, na visao do servidor. Existe para a lista
// aparecer **antes** de entrar na chamada: o LiveKit so conta quem esta na
// sala em que voce ja entrou.
const voicePresence = new Map<string, string[]>();
function setVoicePresence(dados: Record<string, string[]> | undefined) {
  voicePresence.clear();
  for (const [roomId, gente] of Object.entries(dados || {})) voicePresence.set(roomId, gente);
}
/// Nomes a mostrar embaixo do canal. Na sala em que voce esta, o LiveKit e
/// mais fresco que o servidor — ele sabe de quem acabou de entrar — entao os
/// dois se somam.
function peopleInVoice(roomId: string): string[] {
  const doServidor = voicePresence.get(roomId) || [];
  const daChamada = roomId === voiceRoomId ? callParticipants() : [];
  const vistos = new Set<string>();
  const saida: string[] = [];
  for (const nome of [...daChamada, ...doServidor]) {
    if (vistos.has(key(nome))) continue;
    vistos.add(key(nome));
    saida.push(nome);
  }
  return saida;
}
type ServerMember = { username: string; role: ServerRole; nickname?: string | null; avatarFile?: string | null };
const serverMemberProfiles = new Map<string, ServerMember>();

function getDisplayName(username: string) {
  if (view === "server" && currentServerId) {
    const mem = serverMemberProfiles.get(key(username));
    if (mem?.nickname) return mem.nickname;
  }
  return username;
}
// Papel em cada servidor, vindo do backend. Guia o que a interface oferece.
let roles: Record<string, ServerRole> = {};
let micEnabled = false, screenEnabled = false, camEnabled = false, audioEnabled = true, toastTimer = 0;
/// Quem esta no modo grande, por id de tile.
///
/// O estado pertence ao palco, e nao a tile, porque tile e descartavel: as de
/// camera sao destruidas e recriadas a cada `renderCameras`, e as de tela somem
/// quando a transmissao acaba. Guardada na tile, a marca ia embora junto e o
/// palco continuava em modo grande **sem nenhuma tile grande** — e ai o que
/// sobrava sumia do layout, que reserva o espaco todo para uma tile que nao
/// existe mais.
let tileGrande = "";
/// Idem para a tela cheia. A tela cheia e pedida no palco, e nao na tile, entao
/// perder a marca deixa o palco ocupando o monitor inteiro sem nada dentro.
let tileCheia = "";

// Estado das conversas privadas. `identity` guarda a chave deste aparelho;
// `friendKeys` guarda a chave publica ja conferida de cada amigo.
let identity: Identity | null = null;
let friends: string[] = [], incoming: Friendship[] = [], outgoing: Friendship[] = [];
const friendKeys = new Map<string, string>();
const directHistory = new Map<string, DirectMessage[]>();
const blockedFriends = new Set<string>();
const unreadFriends = new Set<string>();
let mode: "room" | "dm" = "room";
let currentFriend = "";
const dmMessagesEl = byId<HTMLElement>("dm-messages"), dmForm = byId<HTMLFormElement>("dm-form");
const dmInput = byId<HTMLTextAreaElement>("dm-input"), friendListEl = byId<HTMLDivElement>("friend-list");
const friendsDialog = byId<HTMLDialogElement>("friends-dialog"), identityDialog = byId<HTMLDialogElement>("identity-dialog");
const keyChangeDialog = byId<HTMLDialogElement>("key-change-dialog");
const key = (value: string) => value.toLowerCase();

function draftConversation() {
  if (mode === "dm" && currentFriend) return "dm:" + key(currentFriend);
  if (view === "server" && currentRoomId) return "room:" + currentRoomId;
  return "";
}
function persistNavigation() {
  if (!session) return;
  saveNavigation(session.username, { view, serverId: currentServerId, roomId: currentRoomId, friend: mode === "dm" ? currentFriend : "" });
}
function restoreComposerDraft() {
  // A citacao pertence a conversa onde ela foi escolhida: trocar de canal ou de
  // amigo apaga, senao a resposta sai colada na conversa errada.
  respondendoA = null;
  renderRespostaBar();
  if (!session) return;
  const conversation = draftConversation();
  if (mode === "dm") { dmInput.value = conversation ? readDraft(session.username, conversation) : ""; resizeDmComposer(); }
  else { messageInput.value = conversation ? readDraft(session.username, conversation) : ""; resizeComposer(); }
}
function persistComposerDraft(value: string) {
  if (!session) return;
  const conversation = draftConversation();
  if (conversation) saveDraft(session.username, conversation, value);
}

function readSession(): AuthSession | null {
  try { const value = JSON.parse(localStorage.getItem("naoconcordo.session") || "null") as AuthSession | null; return value && value.expiresAt * 1000 > Date.now() ? value : null; }
  catch { return null; }
}
function saveSession(value: AuthSession | null) { session = value; if (value) localStorage.setItem("naoconcordo.session", JSON.stringify(value)); else localStorage.removeItem("naoconcordo.session"); }
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers); headers.set("Content-Type", "application/json");
  if (session) headers.set("Authorization", "Bearer " + session.token);
  const response = await fetch(API + path, { ...init, headers });
  if (!response.ok) { const body = await response.json().catch(() => ({ error: "Servidor indisponível." })) as { error?: string }; throw new Error(body.error || "Erro " + response.status); }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
function bytesToBase64Url(bytes: Uint8Array) { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
type AuthChallenge = {
  nonce: string;
  inviteSalt: string;
  inviteIterations: number;
  passwordSalt: string;
  recoverySalt: string;
  passwordIterations: number;
  accountExists: boolean;
};
let registerMode = false;

async function deriveVerifier(password: string, salt: string, iterations: number) {
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: encoder.encode(salt), iterations, hash: "SHA-256" }, material, 256);
  return new Uint8Array(bits);
}
async function signProof(keyBytes: Uint8Array, nonce: string, username: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", keyBytes as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(nonce + ":" + username))));
}
function newRecoveryCode() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}
function downloadRecoveryCode(username: string, code: string) {
  const content = "naoconcordo\n\nUsuario: " + username + "\nCodigo: " + code + "\n\nGuarde este arquivo. O codigo anterior deixa de funcionar apos cada recuperacao.";
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "naoconcordo-recuperacao-" + username.replace(/[^a-z0-9_-]/gi, "_") + ".txt";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  void showNotice("Codigo salvo", "O novo arquivo de recuperacao foi baixado. Guarde-o em um local seguro: sem ele nao e possivel redefinir sua senha.");
}
function renderAuthMode() {
  byId("invite-row").classList.toggle("hidden", !registerMode);
  byId<HTMLInputElement>("invite").required = registerMode;
  byId("auth-submit").textContent = registerMode ? "Criar conta" : "Entrar";
  byId("auth-mode-toggle").textContent = registerMode ? "Ja tenho uma conta" : "Primeiro acesso? Criar conta";
  loginError.textContent = "";
}
byId("auth-mode-toggle").addEventListener("click", () => { registerMode = !registerMode; renderAuthMode(); });
renderAuthMode();

loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  const submit = byId<HTMLButtonElement>("auth-submit");
  const username = byId<HTMLInputElement>("username").value.trim();
  const password = byId<HTMLInputElement>("password").value;
  const invite = byId<HTMLInputElement>("invite").value;
  loginError.textContent = "";
  if (password.length < 8) { loginError.textContent = "A senha precisa ter pelo menos 8 caracteres."; return; }
  submit.setAttribute("disabled", "true");
  try {
    const challenge = await api<AuthChallenge>("/api/auth/challenge", { method: "POST", body: JSON.stringify({ username }) });
    const verifier = await deriveVerifier(password, challenge.passwordSalt, challenge.passwordIterations);
    if (registerMode) {
      if (challenge.accountExists) throw new Error("Este usuario ja existe. Entre com sua senha.");
      const inviteKey = await deriveVerifier(invite, challenge.inviteSalt, challenge.inviteIterations);
      const inviteProof = await signProof(inviteKey, challenge.nonce, username);
      const recoveryCode = newRecoveryCode();
      const recoveryVerifier = await deriveVerifier(recoveryCode, challenge.recoverySalt, challenge.passwordIterations);
      const auth = await api<AuthSession>("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({
          username, nonce: challenge.nonce, inviteProof,
          verifier: bytesToBase64Url(verifier),
          recoveryVerifier: bytesToBase64Url(recoveryVerifier)
        })
      });
      saveSession(auth);
      downloadRecoveryCode(username, recoveryCode);
    } else {
      if (!challenge.accountExists) throw new Error("Usuario nao cadastrado. Use Criar conta.");
      const proof = await signProof(verifier, challenge.nonce, username);
      saveSession(await api<AuthSession>("/api/auth/login", { method: "POST", body: JSON.stringify({ username, nonce: challenge.nonce, proof }) }));
    }
    byId<HTMLInputElement>("password").value = "";
    byId<HTMLInputElement>("invite").value = "";
    await enterApp();
  } catch (error) { loginError.textContent = error instanceof Error ? error.message : "Nao foi possivel entrar."; }
  finally { submit.removeAttribute("disabled"); }
});

const recoveryDialog = byId<HTMLDialogElement>("recovery-dialog");
const recoveryForm = byId<HTMLFormElement>("recovery-form");
const recoveryFile = byId<HTMLInputElement>("recovery-file");

byId("forgot-password").addEventListener("click", () => {
  recoveryForm.reset();
  byId<HTMLInputElement>("recovery-username").value = byId<HTMLInputElement>("username").value.trim();
  byId("recovery-error").textContent = "";
  recoveryDialog.showModal();
  window.setTimeout(() => byId<HTMLInputElement>("recovery-username").focus(), 0);
});
byId("recovery-cancel").addEventListener("click", () => recoveryDialog.close());
byId("recovery-import").addEventListener("click", () => recoveryFile.click());
recoveryFile.addEventListener("change", async () => {
  const file = recoveryFile.files?.[0];
  if (!file) return;
  try {
    const parsed = parseRecoveryFile(await file.text());
    if (parsed.username) byId<HTMLInputElement>("recovery-username").value = parsed.username;
    byId<HTMLTextAreaElement>("recovery-code").value = parsed.code;
    byId("recovery-error").textContent = parsed.code ? "Arquivo importado." : "O arquivo nao contem um codigo.";
  } catch { byId("recovery-error").textContent = "Nao foi possivel ler este arquivo."; }
});
recoveryForm.addEventListener("submit", async event => {
  event.preventDefault();
  const username = byId<HTMLInputElement>("recovery-username").value.trim();
  const recoveryCode = byId<HTMLTextAreaElement>("recovery-code").value.trim();
  const password = byId<HTMLInputElement>("recovery-password").value;
  const confirmation = byId<HTMLInputElement>("recovery-confirm").value;
  const errorEl = byId("recovery-error");
  const submit = byId<HTMLButtonElement>("recovery-submit");
  errorEl.textContent = "";
  if (password.length < 8) { errorEl.textContent = "A nova senha precisa ter pelo menos 8 caracteres."; return; }
  if (password !== confirmation) { errorEl.textContent = "As senhas nao conferem."; return; }
  submit.disabled = true;
  try {
    const challenge = await api<AuthChallenge>("/api/auth/challenge", { method: "POST", body: JSON.stringify({ username }) });
    if (!challenge.accountExists) throw new Error("Usuario nao cadastrado.");
    const recoveryKey = await deriveVerifier(recoveryCode, challenge.recoverySalt, challenge.passwordIterations);
    const recoveryProof = await signProof(recoveryKey, challenge.nonce, username);
    const verifier = await deriveVerifier(password, challenge.passwordSalt, challenge.passwordIterations);
    const nextRecoveryCode = newRecoveryCode();
    const nextRecoveryVerifier = await deriveVerifier(nextRecoveryCode, challenge.recoverySalt, challenge.passwordIterations);
    saveSession(await api<AuthSession>("/api/auth/recover", {
      method: "POST",
      body: JSON.stringify({ username, nonce: challenge.nonce, recoveryProof, verifier: bytesToBase64Url(verifier), recoveryVerifier: bytesToBase64Url(nextRecoveryVerifier) })
    }));
    recoveryDialog.close();
    recoveryForm.reset();
    downloadRecoveryCode(username, nextRecoveryCode);
    await enterApp();
  } catch (error) { errorEl.textContent = error instanceof Error ? error.message : "Nao foi possivel recuperar a conta."; }
  finally { submit.disabled = false; }
});
async function enterApp() {
  if (!session) return;
  const data = await api<Bootstrap>("/api/bootstrap");
  servers = data.servers; rooms = data.rooms; isAdmin = Boolean(data.isAdmin); roles = data.roles || {};
  setVoicePresence(data.voice);
  byId("admin-button").classList.toggle("hidden", !isAdmin);
  onlineUsers.clear();
  for (const name of data.online || []) onlineUsers.add(key(name));
  profiles = new Map(data.profiles.map(profile => [profile.username.toLowerCase(), profile]));
  const restored = readNavigation(session.username);
  if (restored && servers.some(server => server.id === restored.serverId)) currentServerId = restored.serverId;
  if (!servers.some(server => server.id === currentServerId)) currentServerId = servers[0]?.id || "";
  const available = rooms.filter(item => item.serverId === currentServerId && item.kind === "text");
  if (restored && available.some(item => item.id === restored.roomId)) currentRoomId = restored.roomId;
  if (!available.some(item => item.id === currentRoomId)) currentRoomId = available[0]?.id || "";
  view = restored?.view === "server" && currentServerId ? "server" : "home";
  loginView.classList.add("hidden"); appView.classList.remove("hidden");
  byId("profile-name").textContent = session.username;
  byId("mini-profile-name").textContent = session.username;
  paintMyAvatars(session.username);
  view = servers.length && currentServerId ? view : "home";
  const restoredFriend = restored?.friend || "";
  mode = "room"; currentFriend = ""; setMode();
  // Sem isso o rotulo fica em "conectando…" para sempre, porque desde que a
  // chamada deixou de ser automatica nada mais chamava setStatus na entrada.
  setStatus("fora da chamada", false);
  renderNavigation(); renderMessages(); connectChat(); await ensureIdentity(); await refreshFriends(); await refreshServerInvites(); await loadServerMembers();
  if (restoredFriend && friends.some(friend => key(friend) === key(restoredFriend))) await openDirect(restoredFriend);
  else { persistNavigation(); restoreComposerDraft(); }
}
function leaveApp() {
  chat?.close(); chat = null; room?.disconnect(); room = null; restaurarControles(); stage.replaceChildren(); saveSession(null);
  friends = []; incoming = []; outgoing = []; friendKeys.clear(); directHistory.clear();
  blockedFriends.clear(); unreadFriends.clear(); identity = null; mode = "room"; currentFriend = "";
  setMode(); renderFriends();
  closeMiniProfile();
  appView.classList.add("hidden"); loginView.classList.remove("hidden");
}
byId("logout").addEventListener("click", async () => { try { await api<void>("/api/logout", { method: "POST" }); } catch {} leaveApp(); });

function renderRail() {
  byId("home-button").classList.toggle("active", view === "home");
  byId("server-rail").replaceChildren(...servers.map(server => {
    const button = document.createElement("button");
    button.className = "rail-button" + (view === "server" && server.id === currentServerId ? " active" : "");
    button.title = server.name;
    const iniciais = server.name.slice(0, 2).toUpperCase();
    if (server.iconFile) {
      const arquivo = server.iconFile;
      const img = document.createElement("img");
      img.alt = server.name;
      button.classList.add("has-image");
      // replaceChildren antes do await: no caminho de erro o catch trocava o
      // texto e o replaceChildren logo depois o apagava, deixando botao vazio.
      button.replaceChildren(img);
      const cache = blobCache.get(arquivo);
      if (cache) img.src = cache;
      else fileUrl(arquivo).then(url => { img.src = url; }).catch(() => {
        button.classList.remove("has-image"); button.textContent = iniciais;
      });
    } else {
      button.textContent = iniciais;
    }
    button.onclick = () => void selectServer(server.id);
    return button;
  }));
}
function renderNavigation() {
  updateUnreadTitle();
  renderRail();
  syncStagePlacement();
  const emServidor = view === "server";
  byId("channels-pane").classList.toggle("hidden", !emServidor);
  byId("friends-pane").classList.toggle("hidden", emServidor);
  byId("server-members").classList.toggle("hidden", !emServidor);
  const atual = servers.find(item => item.id === currentServerId);
  const bannerEl = byId("server-banner");
  if (bannerEl) {
    if (emServidor && atual?.bannerFile) {
      const arquivo = atual.bannerFile;
      const alvo = currentServerId;
      bannerEl.classList.remove("hidden");
      const cache = blobCache.get(arquivo);
      // Trocar de servidor tem de apagar o banner velho na hora; senao ele fica
      // ate a imagem nova baixar, e a resposta atrasada pinta o servidor errado.
      bannerEl.style.backgroundImage = cache ? 'url("' + cache + '")' : "";
      if (!cache) fileUrl(arquivo).then(url => {
        if (alvo === currentServerId) bannerEl.style.backgroundImage = 'url("' + url + '")';
      }).catch(() => { bannerEl.style.backgroundImage = ""; });
    } else {
      bannerEl.classList.add("hidden");
      bannerEl.style.backgroundImage = "";
    }
  }
  const titleEl = byId("sidebar-title");
  titleEl.textContent = emServidor ? (atual?.name || "servidor") : "Mensagens";
  titleEl.title = (emServidor && atual?.description) ? atual.description : "";
  byId("sidebar-subtitle").textContent = emServidor
    ? (roles[currentServerId] === "owner" ? "dono" : roles[currentServerId] === "mod" ? "moderador" : "membro")
    : "amigos";
  const mine = rooms.filter(item => item.serverId === currentServerId);
  const textRooms = mine.filter(item => item.kind === "text");
  const voiceRooms = mine.filter(item => item.kind === "voice");
  byId("room-list").replaceChildren(...(textRooms.length ? textRooms.map(item => {
    const button = document.createElement("button");
    button.className = "channel" + (mode === "room" && item.id === currentRoomId ? " active" : "");
    button.append(icon("hash", "room-dot"), document.createTextNode(item.name));
    const pendentes = unreadRooms.get(item.id) || 0;
    const citacoes = mencoesPorSala.get(item.id) || 0;
    if (pendentes || citacoes) {
      button.classList.add("unread");
      const badge = document.createElement("span");
      // Selo de mencao ganha da contagem: o que importa e "falaram com voce",
      // nao quantas mensagens passaram.
      badge.className = "unread-badge" + (citacoes ? " mencionado" : "");
      badge.textContent = citacoes ? "@" : (pendentes > 99 ? "99+" : String(pendentes));
      button.append(badge);
    }
    button.onclick = () => selectRoom(item.id); return button;
  }) : [emptyLine("Nenhum canal de texto.")]));
  byId("voice-list").replaceChildren(...voiceRooms.flatMap(item => {
    const button = document.createElement("button");
    button.className = "channel voice" + (item.id === voiceRoomId ? " active" : "");
    button.append(icon("speaker", "room-dot"), document.createTextNode(item.name));
    button.onclick = () => toggleVoice(item.id);
    const nodes: HTMLElement[] = [button];
    // Quem esta na chamada aparece embaixo do canal, como no Discord — em
    // qualquer canal, nao so no seu: dava para entrar numa sala vazia sem
    // saber que a conversa estava na do lado.
    const naSala = peopleInVoice(item.id);
    if (naSala.length) {
      const box = document.createElement("div"); box.className = "voice-members";
      for (const name of naSala) {
        const row = document.createElement("div"); row.className = "voice-member"; row.dataset.who = name;
        const avatar = document.createElement("div"); avatar.className = "avatar"; paintAvatar(avatar, name);
        const label = document.createElement("span"); label.textContent = name;
        row.append(avatar, label);
        // Mesmas marcas do painel da direita: quem esta na chamada mostra aqui
        // se esta com o microfone ou o audio desligado.
        const marks = document.createElement("span"); marks.className = "person-marks";
        if (micMuted(name)) marks.append(icon("mic-off", "ic-sm"));
        if (audioMuted(name)) marks.append(icon("audio-off", "ic-sm"));
        if (silencedByMe(name)) marks.append(icon("silenced", "ic-sm silenced-mark"));
        const selo = liveBadge(name);
        if (selo) marks.append(selo);
        if (marks.childNodes.length) row.append(marks);
        if (key(name) !== key(session?.username || "")) {
          row.classList.add("clickable");
          row.onclick = event => { event.stopPropagation(); openUserMenu(name, row); };
        }
        box.append(row);
      }
      nodes.push(box);
    }
    return nodes;
  }));
  const selected = rooms.find(item => item.id === currentRoomId);
  if (mode === "dm") {
    byId("room-title").textContent = "@ " + currentFriend;
    byId("room-subtitle").textContent = "Conversa privada cifrada";
    dmInput.placeholder = "Mensagem privada para " + currentFriend;
  } else {
    byId("room-title").textContent = view === "home"
      ? "Amigos"
      : (selected ? "# " + selected.name : "naoconcordo");
    const voice = rooms.find(item => item.id === voiceRoomId);
    byId("room-subtitle").textContent = voice
      ? "Na chamada: " + voice.name
      : (view === "home" ? "conversas privadas" : "canal de texto");
    messageInput.placeholder = selected ? "Conversar em #" + selected.name : "Crie um canal de texto para conversar";
    messageInput.disabled = !selected;
  }
}
async function selectServer(id: string) {
  view = "server";
  currentServerId = id;
  // Apelido e foto sao por servidor: sem limpar aqui, os do servidor anterior
  // ficam na tela ate a lista de membros nova chegar.
  serverMembers = []; serverMemberProfiles.clear();
  const first = rooms.find(item => item.serverId === id && item.kind === "text");
  currentRoomId = first?.id || "";
  view = servers.length && currentServerId ? view : "home";
  mode = "room"; currentFriend = ""; setMode(); renderFriends();
  persistNavigation(); restoreComposerDraft(); renderNavigation(); renderMessages(); void loadServerMembers();
  void refreshCatalog();
}
/// Recarrega servidores e canais. Servidores e canais so vinham do
/// `/api/bootstrap` da entrada, entao canal criado, renomeado ou apagado por
/// outra pessoa so aparecia depois de reiniciar o app. Abrir o servidor busca
/// de novo; a tela ja foi desenhada com o que havia em memoria, entao isso
/// corrige em segundo plano em vez de segurar o clique.
async function refreshCatalog() {
  const alvo = currentServerId;
  try {
    const data = await api<Bootstrap>("/api/bootstrap");
    servers = data.servers; rooms = data.rooms; roles = data.roles || {};
    setVoicePresence(data.voice);
    profiles = new Map(data.profiles.map(profile => [profile.username.toLowerCase(), profile]));
  } catch { return; }
  // Trocou de servidor enquanto a resposta vinha: quem mandou depois manda.
  if (alvo !== currentServerId) return;
  if (view === "server") {
    if (!servers.some(server => server.id === currentServerId)) { goHome(); return; }
    const textos = rooms.filter(item => item.serverId === currentServerId && item.kind === "text");
    if (mode === "room" && !textos.some(item => item.id === currentRoomId)) {
      currentRoomId = textos[0]?.id || "";
      persistNavigation(); restoreComposerDraft();
    }
  }
  renderNavigation(); renderMessages();
}
/// Volta para a casa dos amigos. A chamada de voz continua de pe.
function goHome() {
  view = "home";
  serverMembers = []; serverMemberProfiles.clear();
  mode = currentFriend ? "dm" : "room";
  if (!currentFriend) { currentRoomId = ""; }
  setMode(); renderFriends(); persistNavigation(); restoreComposerDraft(); renderNavigation(); void loadServerMembers();
  renderMessages();
}
byId("home-button").addEventListener("click", goHome);
byId("add-server").addEventListener("click", () => void createServer());
/// Trocar de canal de texto nao mexe na chamada, igual ao Discord.
async function selectRoom(id: string) {
  view = servers.length && currentServerId ? view : "home";
  mode = "room"; currentFriend = ""; setMode(); renderFriends();
  currentRoomId = id; clearUnread(id); persistNavigation(); restoreComposerDraft(); renderNavigation(); renderMessages();
}
/// Entrar num canal de voz, ou sair se ja estiver nele.
/// O servidor dono da chamada em andamento. Vazio quando nao ha chamada.
function serverDaChamada(): string {
  return rooms.find(item => item.id === voiceRoomId)?.serverId || "";
}
/// A chamada esta na tela que voce esta olhando agora?
function chamadaNaTela(): boolean {
  const dono = serverDaChamada();
  return Boolean(dono) && view === "server" && currentServerId === dono;
}
/// Decide onde as transmissoes aparecem.
///
/// O `stage` fica no painel do servidor, mas a chamada continua de pe quando
/// voce navega para outro servidor ou para a home — e as tiles ficavam ali,
/// dando a impressao de que aquela transmissao era deste servidor. Agora o
/// painel so mostra a chamada do proprio servidor; fora dela, o que estava
/// sendo transmitido vai para a janela separada, que e o lugar que ja existe
/// para assistir sem estar na tela da chamada.
function syncStagePlacement() {
  // Antes de decidir o que mostrar: a tile grande pode ter acabado de sair.
  aplicarTeatro();
  const aqui = chamadaNaTela();
  if (!aqui && document.fullscreenElement === stage) void document.exitFullscreen();
  const mostrar = aqui && stage.children.length > 0;
  stage.classList.toggle("hidden", !mostrar);
  byId("stage-resizer").classList.toggle("hidden", !mostrar);
  renderCameraMini();
  // So abre sozinha se houver o que assistir: abrir uma janela vazia sempre
  // que a pessoa troca de servidor seria um estorvo.
  if (!aqui && !screenWindowOpen && voiceRoomId && stage.children.length) {
    janelaAutomatica = true;
    void openScreenWindow();
  }
  if (aqui && screenWindowOpen && janelaAutomatica) {
    janelaAutomatica = false;
    void closeScreenWindow();
  }
}
// ------------------------------------------------- altura do palco
// A alca nativa do `resize: vertical` e um triangulo de 12px no canto direito:
// so pega quem mira. Esta barra ocupa a largura toda e guarda a altura, entao a
// pessoa ajusta uma vez e continua assim nas proximas chamadas.
const ALTURA_KEY = "naoconcordo.altura-palco";
const ALTURA_MIN = 140;

function aplicarAlturaDoPalco(px: number) {
  // Sobra para o chat: um palco que come a janela inteira deixa a conversa
  // inalcancavel, e nao ha como arrastar de volta o que nao aparece.
  const teto = Math.max(ALTURA_MIN, window.innerHeight - 260);
  const altura = Math.min(Math.max(px, ALTURA_MIN), teto);
  stage.style.height = altura + "px";
  return altura;
}

(() => {
  const barra = byId("stage-resizer");
  const salva = Number(localStorage.getItem(ALTURA_KEY));
  if (salva > 0) aplicarAlturaDoPalco(salva);

  let arrastando = false;
  barra.addEventListener("pointerdown", event => {
    arrastando = true;
    barra.classList.add("arrastando");
    barra.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  barra.addEventListener("pointermove", event => {
    if (!arrastando) return;
    // A altura e a distancia do topo do palco ate o ponteiro: segue o dedo sem
    // acumular erro, mesmo se um quadro for perdido no meio do arrasto.
    aplicarAlturaDoPalco(event.clientY - stage.getBoundingClientRect().top);
  });
  const soltar = (event: PointerEvent) => {
    if (!arrastando) return;
    arrastando = false;
    barra.classList.remove("arrastando");
    barra.releasePointerCapture(event.pointerId);
    localStorage.setItem(ALTURA_KEY, String(parseInt(stage.style.height, 10) || ALTURA_MIN));
  };
  barra.addEventListener("pointerup", soltar);
  barra.addEventListener("pointercancel", soltar);
  // Duplo clique devolve o padrao, para quem se perdeu arrastando.
  barra.addEventListener("dblclick", () => {
    stage.style.removeProperty("height");
    localStorage.removeItem(ALTURA_KEY);
  });
  // A janela encolher nao pode deixar o palco maior que ela.
  window.addEventListener("resize", () => {
    if (stage.style.height) aplicarAlturaDoPalco(parseInt(stage.style.height, 10) || ALTURA_MIN);
  });
})();

/// Conta ao servidor em que canal de voz este socket esta. E o que faz a lista
/// de quem esta na chamada aparecer para quem ainda nao entrou — o LiveKit so
/// enxerga a sala em que voce ja esta.
function announceVoice(roomId: string) {
  if (chat?.readyState !== WebSocket.OPEN) return;
  chat.send(JSON.stringify({ type: "voice", roomId }));
}
/// Sai da chamada e desliga tudo que dependia dela.
///
/// Parar a transmissao aqui e obrigatorio: a captura em Rust tem conexao
/// propria com o LiveKit e nao cai junto com a sala do WebView. Sem isto, sair
/// da chamada deixava a tela sendo publicada na sala antiga com o botao ja
/// apagado, e a interface passava a mentir sobre o que estava no ar.
async function sairDaChamada() {
  pararMedidorDoPortao?.();
  pararMedidorDoPortao = null;
  portaoAberto = true;
  // O aviso de saida e o som ficam aqui porque o `Disconnected` da sala nao
  // vale mais para ela: `room` ja aponta para outro lugar quando o evento
  // chega, e o guarda de sala atrasada o descarta.
  const estava = Boolean(room);
  await pararDeCompartilhar();
  room?.disconnect(); room = null; voiceRoomId = ""; resetMediaState(); announceVoice("");
  // As janelas separadas entram na sala por conta propria, com token de
  // espectador. Deixadas abertas, continuavam ligadas ao canal do qual voce
  // acabou de sair — e a de telas ainda oferece o botao de compartilhar, que
  // publicaria numa chamada onde voce nao esta mais. Fecham depois da sala
  // cair: o aviso de fechamento reassina as telas, e com `room` ja nulo isso
  // vira o nada que precisa ser.
  if (screenWindowOpen) { try { await closeScreenWindow(); } catch { /* ja fechou */ } }
  if (cameraWindowOpen) { try { await closeCameraWindow(); } catch { /* idem */ } }
  if (estava) { setStatus("fora da chamada", false); playLeave(); }
  renderNavigation(); renderPeople(); updateCallControls();
}
async function toggleVoice(id: string) {
  const mesmoCanal = voiceRoomId === id && (room?.state === "connected" || room?.state === "connecting");
  await sairDaChamada();
  if (mesmoCanal) return;
  voiceRoomId = id; announceVoice(id); renderNavigation(); updateCallControls();
  await connectVoice();
}
async function createServer() {
  const name = await askInput({ title: "Criar servidor", label: "Nome", placeholder: "Ex.: Casa", submit: "Criar", maxLength: 24 });
  if (!name) return;
  try {
    const server = await api<ServerInfo>("/api/servers", { method: "POST", body: JSON.stringify({ name }) });
    const data = await api<Bootstrap>("/api/bootstrap");
    servers = data.servers; rooms = data.rooms; roles = data.roles || {}; currentServerId = server.id;
    currentRoomId = rooms.find(item => item.serverId === server.id && item.kind === "text")?.id || "";
    persistNavigation(); restoreComposerDraft(); renderNavigation(); renderMessages();
  } catch (error) { showToast(error instanceof Error ? error.message : "Não foi possível criar."); }
}
async function createChannel(kind: RoomKind) {
  if (!currentServerId) { showToast("Crie um servidor primeiro."); return; }
  const label = kind === "voice" ? "canal de voz" : "canal de texto";
  const name = await askInput({ title: "Criar " + label, label: "Nome", placeholder: kind === "voice" ? "Ex.: Geral" : "Ex.: Conversa", submit: "Criar", maxLength: 24 });
  if (!name) return;
  try {
    const created = await api<RoomInfo>("/api/rooms", { method: "POST", body: JSON.stringify({ name, serverId: currentServerId, kind }) });
    rooms.push(created);
    if (kind === "text") await selectRoom(created.id); else renderNavigation();
  } catch (error) { showToast(error instanceof Error ? error.message : "Não foi possível criar."); }
}
byId("add-room").addEventListener("click", () => void createChannel("text"));
byId("add-voice-room").addEventListener("click", () => void createChannel("voice"));

// ---------------------------------------------------------------- amizades

/// Publica a chave publica deste aparelho. A privada fica so no localStorage.
async function ensureIdentity() {
  if (!session) return;
  identity = await loadIdentity(session.username);
  try { await api<IdentityKey>("/api/keys", { method: "PUT", body: JSON.stringify({ publicKey: identity.publicKey }) }); }
  catch { showToast("Nao foi possivel publicar sua chave."); }
}
async function refreshFriends() {
  try {
    const data = await api<FriendsData>("/api/friends");
    friends = data.friends; incoming = data.incoming; outgoing = data.outgoing;
    renderFriends(); renderFriendDialog(); renderPeople();
    if (view === "home" && mode === "room") renderMessages();
  } catch { /* sessao caiu; o resto do app ja trata */ }
}
function renderFriends() {
  friendListEl.replaceChildren(...friends.map(name => {
    const button = document.createElement("button");
    button.className = "channel" + (mode === "dm" && key(name) === key(currentFriend) ? " active" : "");
    button.append(icon("at", "room-dot"), document.createTextNode(name));
    if (unreadFriends.has(key(name))) { const dot = document.createElement("span"); dot.className = "unread-dot"; button.append(dot); }
    button.onclick = () => openDirect(name);
    return button;
  }));
  const pending = incoming.length;
  byId("add-friend").textContent = pending ? String(pending) : "+";
  byId("add-friend").classList.toggle("has-pending", pending > 0);
}
function friendRow(name: string, actions: { label: string; primary?: boolean; run: () => void }[]) {
  const row = document.createElement("div"); row.className = "friend-row";
  const avatar = document.createElement("div"); avatar.className = "avatar"; paintAvatar(avatar, name);
  const label = document.createElement("span"); label.className = "friend-name";
  const disp = getDisplayName(name);
  label.textContent = disp;
  if (disp !== name) label.title = "@" + name;
  row.append(avatar, label);
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button"; button.className = action.primary ? "primary small" : "small";
    button.textContent = action.label; button.onclick = action.run;
    row.append(button);
  }
  return row;
}
function renderFriendDialog() {
  byId("friend-current").replaceChildren(...(friends.length ? friends.map(name => friendRow(name, [
    { label: "Conversar", primary: true, run: () => { friendsDialog.close(); void openDirect(name); } },
    { label: "Remover", run: () => removeFriend(name) },
  ])) : [emptyLine("Nenhum amigo ainda.")]));
  byId("friend-incoming").replaceChildren(...(incoming.length ? incoming.map(item => friendRow(item.requester, [
    { label: "Aceitar", primary: true, run: () => respondFriend("accept", item.requester) },
    { label: "Recusar", run: () => respondFriend("reject", item.requester) },
  ])) : [emptyLine("Nenhum pedido recebido.")]));
  byId("friend-outgoing").replaceChildren(...(outgoing.length ? outgoing.map(item => friendRow(item.addressee, [
    { label: "Cancelar", run: () => respondFriend("reject", item.addressee) },
  ])) : [emptyLine("Nenhum pedido enviado.")]));
}
function emptyLine(text: string) { const p = document.createElement("p"); p.className = "muted small"; p.textContent = text; return p; }
async function removeFriend(username: string) {
  if (!await confirmAction("Remover amizade", "Remover " + username + " da sua lista?", "A conversa deixa de aparecer neste aparelho.", "Remover")) return;
  try {
    await api<void>("/api/friends/remove", { method: "POST", body: JSON.stringify({ username }) });
    forgetFriend(username); await refreshFriends();
  } catch (error) { byId("friends-error").textContent = error instanceof Error ? error.message : "Não foi possível remover."; }
}
async function respondFriend(action: "accept" | "reject", username: string) {
  try { await api<void>("/api/friends/" + action, { method: "POST", body: JSON.stringify({ username }) }); await refreshFriends(); }
  catch (error) { showToast(error instanceof Error ? error.message : "Nao foi possivel responder ao pedido."); }
}
byId("add-friend").addEventListener("click", async () => { await refreshFriends(); byId("friends-error").textContent = ""; friendsDialog.showModal(); });
byId("close-friends").addEventListener("click", () => friendsDialog.close());
byId("friend-search-form").addEventListener("submit", event => event.preventDefault());
byId<HTMLInputElement>("friend-search").addEventListener("input", async event => {
  const term = (event.currentTarget as HTMLInputElement).value.trim();
  const results = byId("friend-search-results");
  if (term.length < 2) { results.replaceChildren(emptyLine("Digite 2 letras ou mais.")); return; }
  try {
    const found = await api<{ users: string[] }>("/api/users/search?q=" + encodeURIComponent(term));
    const candidates = found.users.filter(name => !friends.some(friend => key(friend) === key(name))
      && !incoming.some(item => key(item.requester) === key(name))
      && !outgoing.some(item => key(item.addressee) === key(name)));
    results.replaceChildren(...(candidates.length
      ? candidates.map(name => friendRow(name, [{ label: "Adicionar", primary: true, run: () => requestFriend(name) }]))
      : [emptyLine("Ninguém com esse nome.")]));
  } catch (error) { byId("friends-error").textContent = error instanceof Error ? error.message : "Busca indisponivel."; }
});
async function requestFriend(username: string) {
  try {
    await api<Friendship>("/api/friends/request", { method: "POST", body: JSON.stringify({ username }) });
    byId<HTMLInputElement>("friend-search").value = "";
    byId("friend-search-results").replaceChildren(emptyLine("Pedido enviado."));
    await refreshFriends();
  } catch (error) { byId("friends-error").textContent = error instanceof Error ? error.message : "Nao foi possivel enviar."; }
}

// ------------------------------------------------- conversa privada cifrada

/// Busca a chave do amigo e confere com a que foi fixada no primeiro contato.
async function resolveFriendKey(name: string): Promise<string | null> {
  if (!session) return null;
  const cached = friendKeys.get(key(name));
  if (cached) return cached;
  const entry = await api<IdentityKey>("/api/keys/" + encodeURIComponent(name));
  const verdict = checkPin(session.username, name, entry.publicKey);
  if (verdict.status === "mudou") {
    blockedFriends.add(key(name));
    await promptKeyChange(name, verdict.pinned || "", entry.publicKey);
    if (blockedFriends.has(key(name))) return null;
  } else if (verdict.status === "novo") {
    savePin(session.username, name, entry.publicKey);
  }
  friendKeys.set(key(name), entry.publicKey);
  return entry.publicKey;
}
function promptKeyChange(name: string, oldKey: string, newKey: string) {
  return new Promise<void>(resolve => {
    byId("key-change-name").textContent = name;
    void fingerprint(oldKey).then(value => { byId("key-change-old").textContent = value || "(desconhecida)"; });
    void fingerprint(newKey).then(value => { byId("key-change-new").textContent = value; });
    const accept = byId<HTMLButtonElement>("key-change-accept"), reject = byId<HTMLButtonElement>("key-change-reject");
    const finish = (accepted: boolean) => {
      if (accepted && session) { savePin(session.username, name, newKey); blockedFriends.delete(key(name)); }
      accept.onclick = null; reject.onclick = null;
      keyChangeDialog.close(); resolve();
    };
    accept.onclick = () => finish(true);
    reject.onclick = () => finish(false);
    keyChangeDialog.showModal();
  });
}
async function openDirect(name: string) {
  if (!session) return;
  view = "home"; mode = "dm"; currentFriend = name; unreadFriends.delete(key(name)); updateUnreadTitle();
  setMode(); persistNavigation(); restoreComposerDraft(); renderFriends(); renderNavigation();
  dmMessagesEl.replaceChildren(loadingLine("Abrindo…"));
  try {
    const publicKey = await resolveFriendKey(name);
    if (!publicKey) { dmMessagesEl.replaceChildren(loadingLine("Bloqueada até você confirmar a identidade nova.")); return; }
    const data = await api<{ envelopes: Envelope[] }>("/api/dm?with=" + encodeURIComponent(name));
    const opened: DirectMessage[] = [];
    for (const envelope of data.envelopes) opened.push(await toDirect(envelope, publicKey));
    directHistory.set(key(name), opened);
    renderDirect();
  } catch (error) {
    dmMessagesEl.replaceChildren(loadingLine(error instanceof Error ? error.message : "Não foi possível abrir a conversa."));
  }
}
async function toDirect(envelope: Envelope, publicKey: string): Promise<DirectMessage> {
  return {
    id: envelope.id, from: envelope.from, to: envelope.to, createdAt: envelope.createdAt,
    editedAt: envelope.editedAt, attachments: envelope.attachments || [], replyTo: envelope.replyTo || null,
    text: await decryptEnvelope(envelope, publicKey),
  };
}
async function decryptEnvelope(envelope: Envelope, publicKey: string) {
  if (!identity) return "(sem identidade local)";
  try { return await openMessage(identity, publicKey, envelope.from, envelope.to, envelope.ciphertext, envelope.nonce); }
  catch { return "(não foi possível decifrar)"; }
}
function loadingLine(text: string) { const p = document.createElement("p"); p.className = "muted dm-note"; p.textContent = text; return p; }
function renderDirect() {
  const list = directHistory.get(key(currentFriend)) || [];
  dmMessagesEl.replaceChildren(privacyNote());
  for (const item of list) appendDirect(item);
  dmMessagesEl.scrollTop = dmMessagesEl.scrollHeight;
}
function privacyNote() {
  const box = document.createElement("div"); box.className = "welcome";
  const title = document.createElement("h2"); title.textContent = "@" + currentFriend;
  const text = document.createElement("p");
  text.textContent = "Conversa cifrada de ponta a ponta.";
  box.append(title, text); return box;
}
function appendDirect(message: DirectMessage) {
  const article = document.createElement("article"); article.className = "message"; article.dataset.messageId = message.id;
  const avatar = document.createElement("div"); avatar.className = "message-avatar clicavel"; paintAvatar(avatar, message.from);
  avatar.onclick = () => abrirPerfil(message.from);
  const body = document.createElement("div"); body.className = "message-body"; const head = document.createElement("div"); head.className = "message-head";
  const name = document.createElement("strong"); name.className = "clicavel"; name.textContent = message.from;
  name.onclick = () => abrirPerfil(message.from);
  const time = document.createElement("time");
  time.textContent = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date(message.createdAt));
  head.append(name, time);
  if (message.editedAt) { const edited = document.createElement("span"); edited.className = "edited-label"; edited.textContent = "editada"; head.append(edited); }
  body.append(head);
  if (message.replyTo) body.append(citacao(message.replyTo, dmMessagesEl));
  if (message.text) { body.append(renderText(message.text)); renderLinkEmbeds(message.text, body); }
  renderAttachments(message, body);
  {
    const actions = document.createElement("div"); actions.className = "message-actions";
    actions.append(botaoResponder(message.id, message.from));
    if (key(message.from) === key(session?.username || "")) {
    const editButton = document.createElement("button"); editButton.type = "button"; editButton.title = "Editar mensagem"; editButton.append(icon("pencil", "ic-sm")); editButton.onclick = () => openDirectEditor(message);
    const deleteButton = document.createElement("button"); deleteButton.type = "button"; deleteButton.title = "Apagar mensagem"; deleteButton.append(icon("trash", "ic-sm")); deleteButton.onclick = () => void removeDirectMessage(message);
    actions.append(editButton, deleteButton);
    }
    article.append(actions);
  }
  article.append(avatar, body); dmMessagesEl.append(article);
}
/// Editar PV é recifrar: o servidor troca o envelope inteiro, sem ver o texto.
function openDirectEditor(message: DirectMessage) {
  editingMessageId = message.id;
  editingDirect = true;
  byId<HTMLTextAreaElement>("message-edit-text").value = message.text;
  byId("message-edit-error").textContent = "";
  byId<HTMLDialogElement>("message-edit-dialog").showModal();
  window.setTimeout(() => byId<HTMLTextAreaElement>("message-edit-text").focus(), 0);
}
async function removeDirectMessage(message: DirectMessage) {
  if (!await confirmAction("Apagar mensagem", "Apagar esta mensagem privada?", "Ela some para os dois e não pode ser recuperada.", "Apagar")) return;
  try { await api<void>("/api/dm/" + encodeURIComponent(message.id), { method: "DELETE" }); }
  catch (error) { showToast(error instanceof Error ? error.message : "Não foi possível apagar."); }
}
/// Aplica um envelope que voltou editado ou apagado na conversa aberta.
function forgetDirect(id: string) {
  for (const [friend, list] of directHistory) {
    const index = list.findIndex(item => item.id === id);
    if (index < 0) continue;
    list.splice(index, 1);
    directHistory.set(friend, list);
    if (mode === "dm" && key(friend) === key(currentFriend)) renderDirect();
    return;
  }
}
async function applyDirectUpdate(envelope: Envelope) {
  if (!session) return;
  const friend = key(envelope.from) === key(session.username) ? envelope.to : envelope.from;
  const list = directHistory.get(key(friend));
  if (!list) return;
  const index = list.findIndex(item => item.id === envelope.id);
  if (index < 0) return;
  const publicKey = friendKeys.get(key(friend));
  if (!publicKey) return;
  list[index] = await toDirect(envelope, publicKey);
  directHistory.set(key(friend), list);
  if (mode === "dm" && key(friend) === key(currentFriend)) renderDirect();
}
dmForm.addEventListener("submit", async event => {
  event.preventDefault();
  const text = dmInput.value.trim();
  if ((!text && !pendingFiles.length) || !session || !identity || !currentFriend) return;
  const publicKey = friendKeys.get(key(currentFriend));
  if (!publicKey) { showToast("Confirme a identidade dele antes de conversar."); return; }
  try {
    const envelope = await sealMessage(identity, publicKey, session.username, currentFriend, text);
    // O anexo em si nao e cifrado: e o mesmo arquivo autenticado dos canais.
    const stored = await api<Envelope>("/api/dm", { method: "POST", body: JSON.stringify({ to: currentFriend, ...envelope, attachments: pendingFiles.map(file => file.id), replyTo: respondendoA?.id || null }) });
    recordDirect(currentFriend, { id: stored.id, from: stored.from, to: stored.to, text, createdAt: stored.createdAt, attachments: stored.attachments || [], replyTo: stored.replyTo || null });
    dmInput.value = ""; persistComposerDraft(""); pendingFiles = []; renderAttachPreview(); cancelarResposta(); resizeDmComposer();
  } catch (error) { showToast(error instanceof Error ? error.message : "Não foi possível enviar."); }
});
dmInput.addEventListener("input", () => { resizeDmComposer(); persistComposerDraft(dmInput.value); });
dmInput.addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); dmForm.requestSubmit(); } });
function resizeDmComposer() {
  posicionarCameraMini(); dmInput.style.height = "auto"; dmInput.style.height = Math.min(dmInput.scrollHeight, 110) + "px"; }
/// Guarda a mensagem uma vez so: ela chega pelo POST e de novo pelo WebSocket.
function recordDirect(friend: string, message: DirectMessage) {
  const list = directHistory.get(key(friend)) || [];
  if (list.some(item => item.id === message.id)) return;
  list.push(message); directHistory.set(key(friend), list);
  const fromMe = key(message.from) === key(session?.username || "");
  const openHere = mode === "dm" && key(friend) === key(currentFriend);
  const looking = openHere && document.hasFocus();
  if (openHere) { appendDirect(message); dmMessagesEl.scrollTop = dmMessagesEl.scrollHeight; }
  if (!fromMe && !looking) {
    unreadFriends.add(key(friend)); renderFriends(); updateUnreadTitle(); playPing();
    void notifyMessage({ title: friend, body: message.text, privateBody: "Nova mensagem privada", inCall: inCall() });
  }
}
async function handleIncomingEnvelope(envelope: Envelope) {
  if (!session) return;
  const friend = key(envelope.from) === key(session.username) ? envelope.to : envelope.from;
  if (blockedFriends.has(key(friend))) return;
  let publicKey = friendKeys.get(key(friend));
  if (!publicKey) { publicKey = (await resolveFriendKey(friend).catch(() => null)) || undefined; }
  if (!publicKey) return;
  recordDirect(friend, await toDirect(envelope, publicKey));
}
function setMode() {
  const isDm = mode === "dm";
  // Central de amigos nao tem campo de mensagem: nao ha canal para escrever.
  const semComposer = view === "home" && !isDm;
  byId("messages").classList.toggle("hidden", isDm);
  dmMessagesEl.classList.toggle("hidden", !isDm);
  messageForm.classList.toggle("hidden", isDm || semComposer);
  dmForm.classList.toggle("hidden", !isDm);
  byId("fingerprint-button").classList.toggle("hidden", !isDm);
  byId("stage").classList.toggle("hidden", isDm || !byId("stage").children.length);
}
byId("fingerprint-button").addEventListener("click", async () => {
  if (!identity || !currentFriend) return;
  byId("my-fingerprint").textContent = await fingerprint(identity.publicKey);
  byId("friend-fingerprint-label").textContent = currentFriend.toUpperCase();
  const publicKey = friendKeys.get(key(currentFriend));
  byId("friend-fingerprint").textContent = publicKey ? await fingerprint(publicKey) : "(chave ainda não confirmada)";
  identityDialog.showModal();
});
byId("close-identity").addEventListener("click", () => identityDialog.close());
/// Sem vinculo, a chave fixada e o historico local deixam de valer.
function forgetFriend(name: string) {
  if (session) { dropPin(session.username, name); saveDraft(session.username, "dm:" + key(name), ""); }
  friendKeys.delete(key(name)); directHistory.delete(key(name));
  blockedFriends.delete(key(name)); unreadFriends.delete(key(name)); updateUnreadTitle();
  if (mode === "dm" && key(name) === key(currentFriend)) { mode = "room"; currentFriend = ""; persistNavigation(); setMode(); renderNavigation(); renderMessages(); }
}

function connectChat() {
  if (!session) return; chat?.close(); const token = session.token; chat = new WebSocket(WS + "/ws?token=" + encodeURIComponent(token));
  // O bootstrap acontece antes do socket abrir, entao a propria pessoa nao
  // aparecia na lista de online ate reiniciar o app.
  chat.onopen = () => {
    if (session) onlineUsers.add(key(session.username));
    // Socket novo (reconexao, por exemplo) nao sabe da chamada em andamento:
    // sem reanunciar, os outros veem o canal esvaziar enquanto voce continua
    // falando, porque o servidor limpou a sala ao ver o socket antigo cair.
    if (voiceRoomId) announceVoice(voiceRoomId);
    renderPeople();
    if (view === "home" && mode === "room") renderMessages();
  };
  chat.onmessage = event => {
    const payload = JSON.parse(event.data as string) as {
      type: string; messages?: ChatMessage[]; message?: ChatMessage; messageId?: string; roomId?: string; room?: RoomInfo; profile?: Profile;
      friendship?: Friendship; username?: string; envelope?: Envelope; online?: boolean;
      invite?: ServerInvite; inviteId?: string; accepted?: boolean; server?: ServerInfo; rooms?: RoomInfo[]; role?: ServerRole; serverId?: string;
      users?: string[];
    };
    if (payload.type === "welcome") { history = payload.messages || []; renderMessages(); }
    if (payload.type === "message" && payload.message) {
      history.push(payload.message);
      const minha = key(payload.message.username) === key(session?.username || "");
      if (view === "server" && mode === "room" && payload.message.roomId === currentRoomId) { appendMessage(payload.message); scrollMessages(); }
      noteUnread(payload.message, minha);
    }
    if (payload.type === "typing" && payload.username && payload.roomId) {
      anotarDigitando(payload.username, payload.roomId);
    }
    if (payload.type === "messageUpdated" && payload.message) {
      const index = history.findIndex(item => item.id === payload.message!.id);
      if (index >= 0) history[index] = payload.message;
      refreshVisibleRoom(payload.message.roomId);
    }
    if (payload.type === "messageDeleted" && payload.messageId && payload.roomId) {
      history = history.filter(item => item.id !== payload.messageId);
      if (editingMessageId === payload.messageId) closeMessageEditor();
      refreshVisibleRoom(payload.roomId);
    }
    if (payload.type === "presenceChanged" && payload.username) {
      if (payload.online) onlineUsers.add(key(payload.username)); else onlineUsers.delete(key(payload.username));
      renderPeople();
      if (view === "home" && mode === "room") renderMessages();
    }
    if (payload.type === "roomCreated" && payload.room) {
      if (!rooms.some(item => item.id === payload.room!.id)) { rooms.push(payload.room); renderNavigation(); }
    }
    if (payload.type === "profileUpdated" && payload.profile) { profiles.set(payload.profile.username.toLowerCase(), payload.profile); renderMessages(); renderPeople(); if (payload.profile.username === session?.username) paintMyAvatars(payload.profile.username); }
    if (payload.type === "friendRequested" && payload.friendship) {
      if (key(payload.friendship.addressee) === key(session?.username || "")) showToast(payload.friendship.requester + " quer ser seu amigo.");
      void refreshFriends();
    }
    if (payload.type === "friendAccepted" && payload.friendship) {
      const other = key(payload.friendship.requester) === key(session?.username || "") ? payload.friendship.addressee : payload.friendship.requester;
      showToast(other + " aceitou seu pedido de amizade.");
      void refreshFriends();
    }
    if (payload.type === "friendRemoved" && payload.username) { forgetFriend(payload.username); void refreshFriends(); }
    if (payload.type === "serverInvited" && payload.invite) {
      const convite = payload.invite;
      if (key(convite.to) === key(session?.username || "")) {
        if (!serverInvites.some(item => item.id === convite.id)) serverInvites.push(convite);
        renderServerInvites();
        showToast(convite.from + " convidou você para " + convite.serverName + ".");
        playPing();
        void notifyMessage({ title: "Convite de servidor", body: convite.from + " convidou você para " + convite.serverName, privateBody: "Novo convite de servidor", inCall: inCall() });
      } else showToast("Convite enviado para " + convite.to + ".");
    }
    if (payload.type === "serverInviteResolved" && payload.username) {
      serverInvites = serverInvites.filter(item => item.id !== payload.inviteId);
      renderServerInvites();
      showToast(payload.username + (payload.accepted ? " entrou no servidor." : " recusou o convite."));
      if (payload.accepted && payload.serverId === currentServerId) void loadServerMembers();
    }
    if (payload.type === "serverJoined" && payload.server) {
      // Chega com os canais: o bootstrap desta pessoa nao tinha nada daqui.
      if (!servers.some(item => item.id === payload.server!.id)) servers.push(payload.server);
      for (const room of payload.rooms || []) if (!rooms.some(item => item.id === room.id)) rooms.push(room);
      if (payload.role) roles[payload.server.id] = payload.role;
      renderNavigation();
      showToast("Você entrou em " + payload.server.name + ".");
    }
    if (payload.type === "serverUpdated" && payload.server) {
      const serv = payload.server;
      const idx = servers.findIndex(s => s.id === serv.id);
      if (idx >= 0) servers[idx] = serv;
      else servers.push(serv);
      renderNavigation();
    }
    if (payload.type === "serverLeft" && payload.serverId) {
      const saiu = payload.serverId;
      const nome = servers.find(item => item.id === saiu)?.name || "servidor";
      servers = servers.filter(item => item.id !== saiu);
      rooms = rooms.filter(item => item.serverId !== saiu);
      delete roles[saiu];
      if (currentServerId === saiu) {
        currentServerId = ""; currentRoomId = ""; view = "home"; mode = "room"; setMode();
        byId<HTMLDialogElement>("members-dialog").close();
      }
      persistNavigation(); renderNavigation(); renderMessages();
      showToast("Você não participa mais de " + nome + ".");
    }
    if (payload.type === "voiceChanged" && payload.roomId) {
      if (payload.users?.length) voicePresence.set(payload.roomId, payload.users);
      else voicePresence.delete(payload.roomId);
      renderNavigation();
    }
    if (payload.type === "membersChanged" && payload.serverId === currentServerId) void loadServerMembers();
    if (payload.type === "roleChanged" && payload.serverId && payload.role) {
      roles[payload.serverId] = payload.role;
      renderNavigation();
      if (payload.serverId === currentServerId) void loadServerMembers();
    }
    if (payload.type === "directMessage" && payload.envelope) { void handleIncomingEnvelope(payload.envelope); }
    if (payload.type === "directMessageUpdated" && payload.envelope) { void applyDirectUpdate(payload.envelope); }
    if (payload.type === "directMessageDeleted" && payload.messageId) {
      if (editingMessageId === payload.messageId) closeMessageEditor();
      forgetDirect(payload.messageId);
    }
  };
  chat.onclose = () => { if (session?.token === token) window.setTimeout(connectChat, 2500); };
}
messageForm.addEventListener("submit", event => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if ((!text && !pendingFiles.length) || chat?.readyState !== WebSocket.OPEN) return;
  chat.send(JSON.stringify({ type: "message", text, roomId: currentRoomId, attachments: pendingFiles.map(file => file.id), replyTo: respondendoA?.id || null }));
  messageInput.value = ""; persistComposerDraft(""); pendingFiles = []; renderAttachPreview(); cancelarResposta(); resizeComposer();
});
messageInput.addEventListener("input", () => {
  resizeComposer(); persistComposerDraft(messageInput.value); avisarQueDigito(); atualizarSugestoes();
});
messageInput.addEventListener("keydown", event => {
  // A lista aberta rouba as setas, o Tab e o Enter: sem isso o Enter enviaria a
  // mensagem no meio do nome que a pessoa estava escolhendo.
  if (sugestoes.length) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const passo = event.key === "ArrowDown" ? 1 : -1;
      sugestaoAtiva = (sugestaoAtiva + passo + sugestoes.length) % sugestoes.length;
      renderSugestoes();
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); aplicarSugestao(sugestaoAtiva); return; }
    if (event.key === "Escape") { sugestoes = []; renderSugestoes(); return; }
  }
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); messageForm.requestSubmit(); }
});
messageInput.addEventListener("blur", () => { sugestoes = []; renderSugestoes(); });
function resizeComposer() {
  posicionarCameraMini(); messageInput.style.height = "auto"; messageInput.style.height = Math.min(messageInput.scrollHeight, 110) + "px"; }
function refreshVisibleRoom(roomId: string) {
  if (view !== "server" || mode !== "room" || currentRoomId !== roomId) return;
  const distanceFromBottom = messagesEl.scrollHeight - messagesEl.scrollTop;
  renderMessages();
  if (distanceFromBottom > messagesEl.clientHeight + 60) messagesEl.scrollTop = messagesEl.scrollHeight - distanceFromBottom;
}
function renderMessages() {
  // Na home sem conversa aberta o painel e a central de amigos, nao um canal.
  if (view === "home" && mode === "room") { renderFriendsHome(); return; }
  const selected = rooms.find(item => item.id === currentRoomId); messagesEl.innerHTML = '<div class="welcome"><div class="hash">#</div><h2>#' + escapeHtml(selected?.name || "geral") + '</h2><p>Começo do canal.</p></div>'; history.filter(item => item.roomId === currentRoomId).forEach(appendMessage); scrollMessages(); }
/// Tela inicial dos amigos: quem esta online, e um atalho para conversar.
function renderFriendsHome() {
  const box = document.createElement("div");
  box.className = "welcome friends-home";
  const title = document.createElement("h2");
  title.textContent = "Central de amigos";
  const sub = document.createElement("p");
  const online = friends.filter(name => onlineUsers.has(key(name))).length;
  sub.textContent = friends.length
    ? "Aqui estão todos os seus amigos. " + online + " de " + friends.length + " online agora."
    : "Aqui ficam seus amigos. Use o + ao lado de AMIGOS para adicionar alguém.";
  box.append(title, sub);

  if (friends.length) {
    const grid = document.createElement("div");
    grid.className = "friend-cards";
    for (const name of friends) {
      const card = document.createElement("button");
      card.className = "friend-card" + (onlineUsers.has(key(name)) ? " online" : "");
      const avatar = document.createElement("div");
      avatar.className = "avatar";
      paintAvatar(avatar, name);
      const info = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = name;
      const small = document.createElement("small");
      small.textContent = onlineUsers.has(key(name)) ? "online" : "offline";
      info.append(strong, small);
      card.append(avatar, info);
      card.onclick = () => void openDirect(name);
      grid.append(card);
    }
    box.append(grid);
  }
  messagesEl.replaceChildren(box);
}
// ------------------------------------------------------------- mencoes
// Escrever "@" abre a lista de quem esta no servidor. Sem isso a mencao existe
// mas ninguem acerta: nome com acento, maiuscula ou apelido nao sai de cabeca.
let sugestoes: string[] = [];
let sugestaoAtiva = 0;

/// Pedaco de "@nome" que esta sendo escrito na posicao do cursor, se houver.
function mencaoEmCurso(): { termo: string; inicio: number } | null {
  const cursor = messageInput.selectionStart ?? 0;
  const antes = messageInput.value.slice(0, cursor);
  // O "@" tem de comecar palavra: um e-mail no meio da frase nao abre a lista.
  const achado = /(^|\s)@([\w.-]*)$/.exec(antes);
  if (!achado) return null;
  return { termo: achado[2], inicio: cursor - achado[2].length - 1 };
}

function renderSugestoes() {
  const caixa = byId("mention-box");
  caixa.classList.toggle("hidden", sugestoes.length === 0);
  caixa.replaceChildren(...sugestoes.map((nome, indice) => {
    const linha = document.createElement("button");
    linha.type = "button";
    linha.className = "mention-item" + (indice === sugestaoAtiva ? " active" : "");
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    paintAvatar(avatar, nome);
    const rotulo = document.createElement("span");
    rotulo.textContent = getDisplayName(nome);
    linha.append(avatar, rotulo);
    // `mousedown` e nao `click`: o clique tiraria o foco do redator antes de
    // chegar aqui, e a posicao do cursor se perderia.
    linha.onmousedown = evento => { evento.preventDefault(); aplicarSugestao(indice); };
    return linha;
  }));
}

function atualizarSugestoes() {
  const emCurso = mencaoEmCurso();
  if (!emCurso || view !== "server") { sugestoes = []; renderSugestoes(); return; }
  const termo = emCurso.termo.toLowerCase();
  sugestoes = serverMembers
    .filter(nome => nome.toLowerCase().includes(termo) || getDisplayName(nome).toLowerCase().includes(termo))
    .filter(nome => key(nome) !== key(session?.username || ""))
    .slice(0, 6);
  sugestaoAtiva = 0;
  renderSugestoes();
}

function aplicarSugestao(indice: number) {
  const emCurso = mencaoEmCurso();
  const nome = sugestoes[indice];
  if (!emCurso || !nome) return;
  const cursor = messageInput.selectionStart ?? 0;
  const antes = messageInput.value.slice(0, emCurso.inicio);
  const depois = messageInput.value.slice(cursor);
  messageInput.value = antes + "@" + nome + " " + depois;
  const novaPosicao = (antes + "@" + nome + " ").length;
  messageInput.setSelectionRange(novaPosicao, novaPosicao);
  sugestoes = [];
  renderSugestoes();
  persistComposerDraft(messageInput.value);
  messageInput.focus();
}

// ------------------------------------------------------------ digitando
// Quem esta escrevendo agora, por sala. O aviso vale 5 segundos: o remetente
// reenvia enquanto digita, entao parar de digitar apaga sozinho, sem precisar
// de uma mensagem de "parei" que se perderia se a conexao caisse.
const digitando = new Map<string, Map<string, number>>();
let ultimoAvisoEnviado = 0;
const VALIDADE_DIGITANDO = 5000;

function avisarQueDigito() {
  if (chat?.readyState !== WebSocket.OPEN || !currentRoomId || view !== "server") return;
  // Um aviso a cada 2s: a tecla dispara dezenas de eventos por segundo e o
  // socket nao precisa saber de cada um.
  const agora = Date.now();
  if (agora - ultimoAvisoEnviado < 2000) return;
  ultimoAvisoEnviado = agora;
  chat.send(JSON.stringify({ type: "typing", roomId: currentRoomId }));
}

function anotarDigitando(username: string, roomId: string) {
  if (key(username) === key(session?.username || "")) return;
  const sala = digitando.get(roomId) || new Map<string, number>();
  sala.set(key(username), Date.now());
  digitando.set(roomId, sala);
  renderDigitando();
}

function renderDigitando() {
  const aviso = byId("typing-note");
  const sala = digitando.get(currentRoomId);
  const agora = Date.now();
  const nomes: string[] = [];
  if (sala) {
    for (const [pessoa, quando] of [...sala]) {
      if (agora - quando > VALIDADE_DIGITANDO) { sala.delete(pessoa); continue; }
      nomes.push(getDisplayName(pessoa));
    }
  }
  const mostrar = view === "server" && mode === "room" && nomes.length > 0;
  aviso.classList.toggle("hidden", !mostrar);
  if (!mostrar) { aviso.textContent = ""; return; }
  aviso.textContent = nomes.length === 1
    ? nomes[0] + " está digitando…"
    : nomes.length === 2
      ? nomes.join(" e ") + " estão digitando…"
      : "Várias pessoas estão digitando…";
}
// O aviso expira sozinho: sem este relogio ele ficaria preso na tela quando a
// pessoa fechasse o app no meio da frase.
window.setInterval(renderDigitando, 1000);

// ------------------------------------------------------------- reacoes
// Punhado curto e fixo. Um seletor com todos os emoji do Unicode seria mais
// completo e menos usado: em conversa de amigos, quase toda reacao cai nestes.
const EMOJIS = ["👍", "😂", "❤️", "🔥", "😮", "😢", "🎉", "👀"];

function alternarReacao(id: string, emoji: string) {
  if (chat?.readyState !== WebSocket.OPEN) { showToast("Sem conexão."); return; }
  chat.send(JSON.stringify({ type: "react", messageId: id, emoji }));
}

/// Faixa de reacoes de uma mensagem, com o seletor no fim.
function faixaDeReacoes(message: ChatMessage): HTMLElement {
  const faixa = document.createElement("div");
  faixa.className = "reacoes";
  const eu = key(session?.username || "");

  for (const [emoji, quem] of Object.entries(message.reactions || {})) {
    if (!quem.length) continue;
    const chip = document.createElement("button");
    chip.type = "button";
    const meu = quem.some(nome => key(nome) === eu);
    chip.className = "reacao" + (meu ? " minha" : "");
    // Quem reagiu vai na dica: a contagem sozinha nao diz nada num grupo pequeno.
    chip.title = quem.map(getDisplayName).join(", ");
    chip.append(document.createTextNode(emoji));
    const conta = document.createElement("span");
    conta.textContent = String(quem.length);
    chip.append(conta);
    chip.onclick = () => alternarReacao(message.id, emoji);
    faixa.append(chip);
  }

  const abrir = document.createElement("button");
  abrir.type = "button";
  abrir.className = "reacao-add";
  abrir.title = "Reagir";
  abrir.textContent = "☺";
  abrir.onclick = evento => {
    evento.stopPropagation();
    abrirSeletorDeEmoji(message.id, abrir);
  };
  faixa.append(abrir);
  return faixa;
}

function abrirSeletorDeEmoji(id: string, ancora: HTMLElement) {
  closeUserMenu();
  const caixa = document.createElement("div");
  caixa.className = "user-menu seletor-emoji";
  for (const emoji of EMOJIS) {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.textContent = emoji;
    botao.onclick = () => { closeUserMenu(); alternarReacao(id, emoji); };
    caixa.append(botao);
  }
  montarMenu(caixa, ancora);
}

// ------------------------------------------------------------- responder
// Guarda so o id: o texto da citacao sai do historico na hora de desenhar,
// entao editar a original muda a citacao junto em vez de deixar ela mentindo.
let respondendoA: { id: string; autor: string } | null = null;

/// Resumo de uma mensagem em uma linha, para a citacao e para a barra.
function resumo(message: { text?: string; attachments?: StoredFile[] }): string {
  const texto = (message.text || "").replace(/\s+/g, " ").trim();
  if (texto) return texto.length > 120 ? texto.slice(0, 120) + "…" : texto;
  const quantos = message.attachments?.length || 0;
  return quantos ? (quantos === 1 ? "anexo" : quantos + " anexos") : "mensagem sem texto";
}

/// Acha a mensagem citada na conversa aberta.
///
/// Em PV o servidor nao consegue ajudar: o texto so existe decifrado aqui.
function acharCitada(id: string): { autor: string; texto: string } | null {
  if (mode === "dm") {
    const achado = (directHistory.get(key(currentFriend)) || []).find(item => item.id === id);
    return achado ? { autor: achado.from, texto: resumo(achado) } : null;
  }
  const achado = history.find(item => item.id === id);
  return achado ? { autor: getDisplayName(achado.username), texto: resumo(achado) } : null;
}

function iniciarResposta(id: string, autor: string) {
  respondendoA = { id, autor };
  renderRespostaBar();
  (mode === "dm" ? dmInput : messageInput).focus();
}
function cancelarResposta() {
  respondendoA = null;
  renderRespostaBar();
}
function renderRespostaBar() {
  // Trocar de canal ou de conversa nao deve carregar a citacao junto.
  const barra = byId(mode === "dm" ? "dm-reply-bar" : "reply-bar");
  const outra = byId(mode === "dm" ? "reply-bar" : "dm-reply-bar");
  outra.classList.add("hidden");
  outra.replaceChildren();

  barra.classList.toggle("hidden", !respondendoA);
  if (!respondendoA) { barra.replaceChildren(); return; }

  const rotulo = document.createElement("span");
  rotulo.className = "reply-bar-text";
  const quem = document.createElement("strong");
  quem.textContent = "Respondendo a " + respondendoA.autor;
  const trecho = document.createElement("small");
  trecho.textContent = acharCitada(respondendoA.id)?.texto || "mensagem indisponivel";
  rotulo.append(quem, trecho);

  const fechar = document.createElement("button");
  fechar.type = "button";
  fechar.className = "reply-bar-close";
  fechar.title = "Cancelar resposta";
  fechar.textContent = "×";
  fechar.onclick = cancelarResposta;

  barra.replaceChildren(rotulo, fechar);
}

/// Bloco de citacao acima da mensagem. Clicar leva ate a original.
function citacao(id: string, lista: HTMLElement): HTMLElement {
  const bloco = document.createElement("button");
  bloco.type = "button";
  bloco.className = "reply-quote";
  const achado = acharCitada(id);
  const quem = document.createElement("strong");
  quem.textContent = achado ? achado.autor : "";
  const trecho = document.createElement("span");
  // Mensagem apagada, ou antiga demais para estar no historico carregado.
  trecho.textContent = achado ? achado.texto : "mensagem indisponivel";
  bloco.append(quem, trecho);
  bloco.onclick = () => {
    const alvo = lista.querySelector<HTMLElement>('[data-message-id="' + CSS.escape(id) + '"]');
    if (!alvo) { showToast("A mensagem original nao esta carregada."); return; }
    alvo.scrollIntoView({ behavior: "smooth", block: "center" });
    alvo.classList.remove("realcada");
    // Reinicia a animacao: sem o reflow, clicar duas vezes nao pisca de novo.
    void alvo.offsetWidth;
    alvo.classList.add("realcada");
  };
  return bloco;
}

/// Botao de responder, presente em toda mensagem — inclusive nas suas.
function botaoResponder(id: string, autor: string): HTMLButtonElement {
  const botao = document.createElement("button");
  botao.type = "button";
  botao.title = "Responder";
  botao.append(icon("reply", "ic-sm"));
  botao.onclick = () => iniciarResposta(id, autor);
  return botao;
}

function appendMessage(message: ChatMessage) {
  const article = document.createElement("article");
  article.className = "message" + (message.pinned ? " fixada" : "");
  article.dataset.messageId = message.id;
  const avatar = document.createElement("div"); avatar.className = "message-avatar clicavel"; paintAvatar(avatar, message.username);
  avatar.onclick = () => abrirPerfil(message.username);
  const body = document.createElement("div"), head = document.createElement("div"); head.className = "message-head";
  const name = document.createElement("strong");
  name.className = "clicavel";
  name.onclick = () => abrirPerfil(message.username);
  const disp = getDisplayName(message.username);
  name.textContent = disp;
  if (disp !== message.username) name.title = "@" + message.username;
  const time = document.createElement("time"); time.textContent = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date(message.createdAt));
  head.append(name, time);
  if (message.editedAt) { const edited = document.createElement("span"); edited.className = "edited-label"; edited.textContent = "editada"; head.append(edited); }
  body.append(head);
  if (message.replyTo) body.append(citacao(message.replyTo, messagesEl));
  if (message.text) { body.append(renderText(message.text)); renderLinkEmbeds(message.text, body); }
  renderAttachments(message, body);
  body.append(faixaDeReacoes(message));
  {
    const actions = document.createElement("div"); actions.className = "message-actions";
    actions.append(botaoResponder(message.id, getDisplayName(message.username)));
    // Fixar e de todo mundo do servidor, e nao so de quem escreveu: quem
    // guarda o endereco do servidor de jogo costuma ser quem vai usar depois.
    const fixar = document.createElement("button");
    fixar.type = "button";
    fixar.title = message.pinned ? "Desafixar" : "Fixar no canal";
    fixar.append(icon("pin", "ic-sm"));
    fixar.onclick = () => alternarFixada(message.id);
    actions.append(fixar);
    if (key(message.username) === key(session?.username || "")) {
    const editButton = document.createElement("button"); editButton.type = "button"; editButton.title = "Editar mensagem"; editButton.append(icon("pencil", "ic-sm")); editButton.onclick = () => openMessageEditor(message);
    const deleteButton = document.createElement("button"); deleteButton.type = "button"; deleteButton.title = "Apagar mensagem"; deleteButton.append(icon("trash", "ic-sm")); deleteButton.onclick = () => void removeChannelMessage(message);
    actions.append(editButton, deleteButton);
    }
    article.append(actions);
  }
  article.append(avatar, body); messagesEl.append(article);
}
let editingMessageId = "";
let editingDirect = false;
function openMessageEditor(message: ChatMessage) {
  editingMessageId = message.id;
  editingDirect = false;
  byId<HTMLTextAreaElement>("message-edit-text").value = message.text;
  byId("message-edit-error").textContent = "";
  byId<HTMLDialogElement>("message-edit-dialog").showModal();
  window.setTimeout(() => byId<HTMLTextAreaElement>("message-edit-text").focus(), 0);
}
function closeMessageEditor() {
  editingMessageId = "";
  editingDirect = false;
  const dialog = byId<HTMLDialogElement>("message-edit-dialog");
  if (dialog.open) dialog.close();
}
byId("message-edit-cancel").addEventListener("click", closeMessageEditor);
byId<HTMLDialogElement>("message-edit-dialog").addEventListener("cancel", event => { event.preventDefault(); closeMessageEditor(); });
byId<HTMLFormElement>("message-edit-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (editingDirect) { await submitDirectEdit(); return; }
  const message = history.find(item => item.id === editingMessageId);
  if (!message) { closeMessageEditor(); return; }
  const text = byId<HTMLTextAreaElement>("message-edit-text").value.trim();
  if (!text && !(message.attachments?.length)) { byId("message-edit-error").textContent = "A mensagem não pode ficar vazia."; return; }
  try {
    await api<ChatMessage>("/api/messages/" + encodeURIComponent(message.id), { method: "PUT", body: JSON.stringify({ text }) });
    closeMessageEditor();
  } catch (error) { byId("message-edit-error").textContent = error instanceof Error ? error.message : "Não foi possível editar."; }
});
async function submitDirectEdit() {
  const lista = directHistory.get(key(currentFriend)) || [];
  const alvo = lista.find(item => item.id === editingMessageId);
  const publicKey = friendKeys.get(key(currentFriend));
  if (!alvo || !session || !identity || !publicKey) { closeMessageEditor(); return; }
  const text = byId<HTMLTextAreaElement>("message-edit-text").value.trim();
  if (!text && !(alvo.attachments?.length)) { byId("message-edit-error").textContent = "A mensagem não pode ficar vazia."; return; }
  try {
    const envelope = await sealMessage(identity, publicKey, session.username, currentFriend, text);
    await api<Envelope>("/api/dm/" + encodeURIComponent(alvo.id), { method: "PUT", body: JSON.stringify(envelope) });
    closeMessageEditor();
  } catch (error) { byId("message-edit-error").textContent = error instanceof Error ? error.message : "Não foi possível editar."; }
}
async function removeChannelMessage(message: ChatMessage) {
  if (!await confirmAction("Apagar mensagem", "Apagar esta mensagem do canal?", "Ela será removida para todos e não poderá ser recuperada.", "Apagar")) return;
  try { await api<void>("/api/messages/" + encodeURIComponent(message.id), { method: "DELETE" }); }
  catch (error) { showToast(error instanceof Error ? error.message : "Não foi possível apagar."); }
}
function scrollMessages() { messagesEl.scrollTop = messagesEl.scrollHeight; }
function escapeHtml(value: string) { const el = document.createElement("span"); el.textContent = value; return el.innerHTML; }

const miniProfile = byId<HTMLElement>("mini-profile");
const avatarButton = byId<HTMLButtonElement>("avatar-button");
function closeMiniProfile() {
  miniProfile.classList.add("hidden");
  avatarButton.setAttribute("aria-expanded", "false");
}
avatarButton.addEventListener("click", () => {
  const opening = miniProfile.classList.contains("hidden");
  miniProfile.classList.toggle("hidden", !opening);
  avatarButton.setAttribute("aria-expanded", String(opening));
});
byId("profile-change-avatar").addEventListener("click", () => {
  closeMiniProfile();
  const input = byId<HTMLInputElement>("avatar-input");
  input.value = "";
  input.click();
});
document.addEventListener("click", event => {
  const target = event.target as Node;
  if (!miniProfile.contains(target) && !avatarButton.contains(target)) closeMiniProfile();
});
document.addEventListener("keydown", event => { if (event.key === "Escape") closeMiniProfile(); });
byId<HTMLInputElement>("avatar-input").addEventListener("change", async event => {
  const file = (event.currentTarget as HTMLInputElement).files?.[0]; if (!file) return;
  try {
    // GIF vai como arquivo para manter a animacao: passar pelo canvas congela
    // no primeiro quadro. O resto continua virando WebP de 256px.
    let profile: Profile;
    if (file.type === "image/gif") {
      const stored = await uploadFile(file);
      profile = await api<Profile>("/api/profile/avatar", { method: "PUT", body: JSON.stringify({ avatarFile: stored.id }) });
    } else {
      const avatar = await resizeImage(file);
      profile = await api<Profile>("/api/profile/avatar", { method: "PUT", body: JSON.stringify({ avatar }) });
    }
    profiles.set(profile.username.toLowerCase(), profile);
    paintMyAvatars(profile.username); renderMessages(); renderPeople(); showToast("Foto atualizada.");
  }
  catch (error) { showToast(error instanceof Error ? error.message : "Não foi possível usar essa imagem."); }
});
async function resizeImage(file: File) {
  const bitmap = await createImageBitmap(file), canvas = document.createElement("canvas"); canvas.width = canvas.height = 256;
  const context = canvas.getContext("2d")!; const side = Math.min(bitmap.width, bitmap.height); context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256); bitmap.close();
  return canvas.toDataURL("image/webp", .82);
}
function paintMyAvatars(username: string) {
  paintAvatar(byId("avatar"), username);
  paintAvatar(byId("mini-profile-avatar"), username);
  const p = profiles.get(username.toLowerCase());
  const bannerEl = byId("mini-profile-banner");
  if (bannerEl) {
    if (p?.bannerFile) {
      bannerEl.classList.add("has-image");
      fileUrl(p.bannerFile).then(url => { bannerEl.style.backgroundImage = 'url("' + url + '")'; }).catch(() => { bannerEl.style.backgroundImage = ""; });
    } else {
      bannerEl.classList.remove("has-image");
      bannerEl.style.backgroundImage = "";
    }
  }
  const bioEl = byId("mini-profile-bio");
  if (bioEl) bioEl.textContent = p?.bio || "";
  byId("profile-edit-server-btn")?.classList.toggle("hidden", view !== "server" || !currentServerId);
}
function paintAvatar(el: HTMLElement, username: string) {
  let arquivo: string | null | undefined = null;
  let image: string | null | undefined = null;

  if (view === "server" && currentServerId) {
    const mem = serverMemberProfiles.get(key(username));
    if (mem?.avatarFile) arquivo = mem.avatarFile;
  }
  if (!arquivo) {
    const profile = profiles.get(key(username));
    arquivo = profile?.avatarFile;
    image = profile?.avatar;
  }
  if (arquivo) {
    const alvo = arquivo;
    el.textContent = ""; el.classList.add("has-image");
    const cache = blobCache.get(alvo);
    el.style.backgroundImage = cache ? 'url("' + cache + '")' : "";
    if (!cache) void fileUrl(alvo).then(url => { el.style.backgroundImage = 'url("' + url + '")'; }).catch(() => {
      el.classList.remove("has-image"); el.style.backgroundImage = ""; el.textContent = initials(getDisplayName(username));
    });
    return;
  }
  el.textContent = image ? "" : initials(getDisplayName(username));
  el.classList.toggle("has-image", !!image);
  el.style.backgroundImage = image ? 'url("' + image + '")' : "";
}

async function connectVoice() {
  if (!session || !voiceRoomId || room?.state === "connected" || room?.state === "connecting") return;
  setStatus("conectando", false);
  try {
    const access = await api<LivekitAccess>("/api/livekit-token", { method: "POST", body: JSON.stringify({ roomId: voiceRoomId }) });
    // adaptiveStream reduz a resolucao conforme o tamanho do elemento na tela,
    // e era parte do motivo da imagem borrar. Fica ligado so para camera, que
    // aparece em miniatura; a transmissao de tela vai em qualidade cheia.
    const next = new Room({
      adaptiveStream: { pixelDensity: "screen" },
      dynacast: true,
      disconnectOnPageLeave: true,
      // Camera em 1080p30 sempre que a webcam permitir.
      videoCaptureDefaults: { resolution: { width: 1920, height: 1080, frameRate: 30 } },
      publishDefaults: {
        // Camadas menores para quem estiver com rede ruim do outro lado.
        videoSimulcastLayers: [VideoPresets.h540, VideoPresets.h216],
        videoEncoding: { maxBitrate: 3_000_000, maxFramerate: 30 },
        // Tela em 1080p a 30fps: o padrao do LiveKit e 15fps, e era isso que
        // deixava tudo pixelado quando a imagem tinha movimento.
        screenShareEncoding: { maxBitrate: 5_000_000, maxFramerate: 30 },
        screenShareSimulcastLayers: [],
        videoCodec: "vp9",
        backupCodec: { codec: "vp8" },
        red: true, dtx: true,
      },
    }); room = next;
    // Sair da chamada nao e um evento so: o LiveKit despublica cada faixa da
    // pessoa **antes** de anunciar a saida dela. Redesenhando a cada evento,
    // ela aparecia sem microfone por um instante — "mutou e depois caiu" — e a
    // lista era refeita quatro vezes para uma saida.
    //
    // Juntar tudo num desenho so, no fim da rajada, resolve as duas coisas: o
    // estado intermediario nunca chega a tela, e a lista e refeita uma vez.
    // Todo evento daqui pertence a `next`. Sair de uma chamada e entrar noutra
    // cria a sala nova enquanto a antiga ainda esta se despedindo, e os eventos
    // atrasados dela chegavam depois: o `Disconnected` da sala velha zerava o
    // `voiceRoomId` da chamada nova, e a partir dai compartilhar tela pedia
    // token com canal vazio — o servidor respondia "Canal nao encontrado" e so
    // reabrir o aplicativo resolvia.
    const atual = () => room === next;
    let refreshAgendado = 0;
    const refresh = () => {
      window.clearTimeout(refreshAgendado);
      refreshAgendado = window.setTimeout(() => { if (!atual()) return; renderPeople(); renderNavigation(); }, 60);
    };
    next.on(RoomEvent.Connected, () => { if (!atual()) return; setStatus("online", true); playJoin(); silenciarAvisos(2000); announceDeafened(); refresh(); }).on(RoomEvent.Reconnecting, () => { if (atual()) setStatus("reconectando", false); })
      .on(RoomEvent.Reconnected, () => { if (!atual()) return; setStatus("online", true); silenciarAvisos(2000); })
      .on(RoomEvent.Disconnected, () => { if (!atual()) return; setStatus("fora da chamada", false); playLeave(); voiceRoomId = ""; resetMediaState(); refresh(); })
      .on(RoomEvent.ParticipantConnected, participant => {
        if (!atual()) return;
        if (!isScreenParticipant(participant) && avisosLiberados()) playJoin();
        refresh();
      })
      .on(RoomEvent.ParticipantDisconnected, participant => {
        if (!atual()) return;
        for (const publication of participant.trackPublications.values()) {
          if (publication.source === Track.Source.ScreenShare) noteShareStopped(publication.trackSid);
        }
        if (!isScreenParticipant(participant)) playLeave();
        refresh();
      })
      .on(RoomEvent.ActiveSpeakersChanged, speakers => {
        if (!atual()) return;
        speaking.clear();
        for (const speaker of speakers) speaking.add(key(speaker.name || speaker.identity));
        updateSpeakingStyles();
        renderCameraMini();
      })
      .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (!atual()) return;
        // Quem ja estava transmitindo quando voce entrou chega por aqui, sem
        // passar por TrackPublished — sem esta recusa, essa tela ainda abria
        // sozinha.
        if (track.source === Track.Source.ScreenShare && !assistindo.has(publication.trackSid) && !screenWindowOpen) {
          void publication.setSubscribed(false);
          offerScreen(publication.trackSid, participant.name || participant.identity);
          return;
        }
        // O som da transmissao e uma faixa separada da imagem, e a recusa de
        // cima nao alcancava ela: o audio era assinado sozinho e a transmissao
        // comecava a tocar antes de qualquer clique em "Assistir".
        if (track.source === Track.Source.ScreenShareAudio && !telaAceita(participant)) {
          void publication.setSubscribed(false);
          return;
        }
        attachTrack(track, participant); applyAllVolumes(); renderPeople();
      })
      .on(RoomEvent.TrackPublished, (publication, participant) => {
        if (!atual()) return;
        if (publication.source === Track.Source.ScreenShareAudio && !telaAceita(participant)) {
          void publication.setSubscribed(false);
        }
        if (publication.source === Track.Source.ScreenShare) {
          noteShareStarted(publication.trackSid);
          // Nada de assinar sozinho: vira convite. `autoSubscribe` do LiveKit
          // e por sala, entao a recusa e feita aqui, faixa por faixa.
          if (!assistindo.has(publication.trackSid)) {
            void publication.setSubscribed(false);
            offerScreen(publication.trackSid, participant.name || participant.identity);
          }
        }
        // `refresh`, e nao `renderPeople`: o icone de microfone tambem sai na
        // lista do canal de voz, que e desenhada por `renderNavigation`. Sem
        // isso quem entrava na chamada ficava marcado como mudo — a faixa de
        // microfone chega depois do participante, e so o painel da direita se
        // corrigia quando ela chegava.
        refresh();
      })
      .on(RoomEvent.TrackUnpublished, publication => {
        if (!atual()) return;
        if (publication.source === Track.Source.ScreenShare) {
          noteShareStopped(publication.trackSid);
          assistindo.delete(publication.trackSid);
          document.getElementById("oferta-" + publication.trackSid)?.remove();
          syncStagePlacement();
        }
        refresh();
      })
      // Desligar a camera muta a faixa, nao despublica: sem tratar mute aqui,
      // a miniatura fica na tela ate a pessoa sair da chamada.
      .on(RoomEvent.TrackMuted, (publication, participant) => {
        if (!atual()) return;
        if (publication.source === Track.Source.Camera) removeCamera(publication.trackSid);
        void participant;
        refresh();
      })
      .on(RoomEvent.TrackUnmuted, (publication, participant) => {
        if (!atual()) return;
        if (publication.source === Track.Source.Camera && publication.track) {
          addCamera(publication.track, participant.name || participant.identity, participant === room?.localParticipant);
        }
        // Quem estava silenciado e desmutou o microfone tem de continuar
        // silenciado: e o momento em que o volume guardado se perde.
        applyAllVolumes();
        refresh();
      })
      .on(RoomEvent.ParticipantAttributesChanged, () => { if (!atual()) return; updateCallControls(); refresh(); })
      .on(RoomEvent.TrackUnsubscribed, track => { if (!atual()) return; detachTrack(track.sid); if (track.sid) removeCamera(track.sid); })
      .on(RoomEvent.LocalTrackPublished, publication => { if (atual()) attachLocalPublication(publication); })
      .on(RoomEvent.LocalTrackUnpublished, publication => { if (!atual()) return; const sid = publication.track?.sid; if (sid) { detachTrack(sid); removeCamera(sid); } });
    await next.connect(access.url, access.token, { autoSubscribe: true });
    // Entrar num canal de voz ja abre o microfone, como no Discord.
    try {
      await next.localParticipant.setMicrophoneEnabled(true, voz.opcoesDeCaptura());
      micEnabled = true; micButton.classList.add("active"); setIcon(micButton, "mic");
    } catch {
      micEnabled = false; micButton.classList.remove("active"); setIcon(micButton, "mic-off");
      showToast("O Windows não liberou o microfone.");
    }
    // O WebView bloqueia som automatico ate haver interacao; startAudio destrava.
    audioEnabled = true; audioButton.classList.remove("active"); setIcon(audioButton, "audio");
    await unlockAudio(next);
    await applySavedDevices(next);
    reiniciarPortao();
    applyAllVolumes();
    renderPeople(); renderNavigation();
  } catch (error) {
    voiceRoomId = ""; renderNavigation();
    setStatus("erro de conexão", false);
    showToast(error instanceof Error ? error.message : "Não foi possível conectar ao canal de voz.");
  }
}
// ------------------------------------------------------- portao do microfone
//
// O botao de mudo diz se a pessoa **quer** falar; o portao diz se ela **esta**
// falando agora. Os dois precisam concordar antes de a faixa ir ao ar, senao a
// ativacao por voz reabriria um microfone que foi mudado de proposito.
let pararMedidorDoPortao: (() => void) | null = null;
let portaoAberto = true;
let fecharPortaoEm = 0;
let pttPressionado = false;

/// Aplica ao vivo o que o portao decidiu. Silenciar a faixa e diferente de
/// despublicar: o sid nao muda, entao ninguem precisa reassinar nada.
function aplicarPortao() {
  const faixa = room?.localParticipant.audioTrackPublications.values().next().value?.track;
  if (!faixa) return;
  const deveEnviar = micEnabled && portaoAberto;
  if (deveEnviar && faixa.isMuted) void faixa.unmute();
  if (!deveEnviar && !faixa.isMuted) void faixa.mute();
}

/// Liga o portao conforme o modo escolhido. Chamado ao entrar na chamada e
/// sempre que a configuracao muda.
function reiniciarPortao() {
  pararMedidorDoPortao?.();
  pararMedidorDoPortao = null;
  const modo = voz.lerModo();
  if (!room || modo === "sempre") {
    portaoAberto = true;
    aplicarPortao();
    return;
  }
  if (modo === "ptt") {
    portaoAberto = pttPressionado;
    aplicarPortao();
    return;
  }
  // Ativacao por voz: o medidor le a propria faixa que esta sendo enviada.
  const faixa = room.localParticipant.audioTrackPublications.values().next().value?.track;
  const bruta = faixa?.mediaStreamTrack;
  if (!bruta) { portaoAberto = true; aplicarPortao(); return; }
  portaoAberto = false;
  aplicarPortao();
  pararMedidorDoPortao = voz.medir(bruta, nivel => {
    const limiar = voz.lerLimiar();
    const agora = Date.now();
    if (nivel >= limiar) {
      fecharPortaoEm = agora + voz.CAUDA_MS;
      if (!portaoAberto) { portaoAberto = true; aplicarPortao(); }
    } else if (portaoAberto && agora >= fecharPortaoEm) {
      portaoAberto = false;
      aplicarPortao();
    }
  });
}

/// Destrava a reproducao de som. Se o WebView recusar, tenta de novo no primeiro
/// clique do usuario, que conta como interacao.
async function unlockAudio(target: Room) {
  try { await target.startAudio(); } catch { /* tratado abaixo */ }
  if (target.canPlaybackAudio) return;
  showToast("Clique em qualquer lugar para liberar o áudio.");
  const retry = async () => {
    try { await target.startAudio(); } catch { /* segue tentando no proximo clique */ }
    if (target.canPlaybackAudio) document.removeEventListener("click", retry);
  };
  document.addEventListener("click", retry);
}
const inCall = () => room?.state === "connected";
/// Sem canal de voz escolhido, entra no primeiro do servidor atual.
async function ensureInCall() {
  if (inCall()) return true;
  const target = voiceRoomId || rooms.find(item => item.serverId === currentServerId && item.kind === "voice")?.id;
  if (!target) { showToast("Crie um canal de voz."); return false; }
  await toggleVoice(target);
  return inCall();
}
/// Liga ou desliga o microfone e deixa a interface coerente. Existe separado
/// do clique porque o botao de audio tambem precisa mexer no microfone.
async function definirMicrofone(ligado: boolean) {
  if (!room) return;
  try {
    micEnabled = ligado;
    await room.localParticipant.setMicrophoneEnabled(ligado, voz.opcoesDeCaptura());
    // A faixa nasce aberta; o portao decide se ela continua assim.
    reiniciarPortao();
    micButton.classList.toggle("active", micEnabled);
    setIcon(micButton, micEnabled ? "mic" : "mic-off");
    renderPeople(); renderNavigation();
  } catch {
    micEnabled = false;
    micButton.classList.remove("active");
    setIcon(micButton, "mic-off");
    showToast("O Windows não liberou o microfone.");
  }
}
micButton.onclick = async () => { if (!await ensureInCall() || !room) return; await definirMicrofone(!micEnabled); };
// Pausar fica no botao direito do proprio botao de compartilhar: e a acao
// vizinha de parar, e a barra ja esta cheia de botoes.
screenButton.oncontextmenu = event => { event.preventDefault(); void alternarPausaDaTela(); };
/// Encerra a transmissao de tela, venha o pedido do botao ou da saida da
/// chamada. Nao ha `room` garantido aqui: sair da chamada pode ja ter
/// derrubado a sala antes de a captura ser desligada.
///
/// No aplicativo a parada nao depende de `screenEnabled`. Essa marca vive so
/// no WebView, enquanto a captura vive no Rust, com conexao propria com a
/// sala: qualquer desencontro entre as duas — a transmissao comecada pela
/// janela de telas, um `resetMediaState` que passou antes — deixava a tela no
/// ar depois de sair da chamada, como um segundo participante que ninguem
/// consegue mais desligar. `screen_share_stop` nao faz nada quando ja esta
/// parado, entao pedir a mais e barato.
async function pararDeCompartilhar() {
  const estava = screenEnabled;
  screenEnabled = false;
  sharePausado = false;
  pararDeVigiar();
  screenButton.classList.remove("active");
  if (ehTauri()) {
    try { await stopShare(); } catch { /* ja estava parado */ }
  } else if (estava) {
    try { await room?.localParticipant.setScreenShareEnabled(false); } catch { /* idem */ }
  }
  if (estava) updateCallControls();
}
screenButton.onclick = async () => {
  if (!await ensureInCall() || !room || !session) return;
  if (screenEnabled) {
    await pararDeCompartilhar();
    return;
  }

  // No navegador quem captura e o proprio navegador, com o seletor dele. Todo
  // o trabalho em Rust existe para fugir desse seletor e da barra amarela
  // dentro do aplicativo — fora dele nao ha o que fugir, e `getDisplayMedia` e
  // o unico caminho possivel.
  if (!ehTauri()) {
    const qualidade = readQuality();
    try {
      await room.localParticipant.setScreenShareEnabled(true, {
        audio: true,
        resolution: { width: qualidade.width, height: qualidade.height, frameRate: qualidade.fps },
      }, {
        videoEncoding: { maxBitrate: qualidade.bitrate, maxFramerate: qualidade.fps },
        // Mesma escolha do aplicativo: com movimento priorizado a queda de
        // banda tira nitidez em vez de travar a imagem.
        degradationPreference: "maintain-framerate",
        simulcast: false,
      });
      screenEnabled = true;
      screenButton.classList.add("active");
    } catch (erro) {
      // Cancelar no seletor do navegador cai aqui e nao e erro nenhum.
      screenEnabled = false;
      screenButton.classList.remove("active");
      const nome = erro instanceof DOMException ? erro.name : "";
      if (nome !== "NotAllowedError" && nome !== "AbortError") {
        showToast(String(erro instanceof Error ? erro.message : erro));
      }
    }
    updateCallControls();
    return;
  }

  // A escolha da fonte e nossa, em HTML. O WebView2 nunca ve um pedido de
  // tela, entao nao ha seletor do Edge nem barra de aviso do Windows.
  const escolha = await pickSource(QUALITIES, readQuality(), byId);
  if (!escolha) return;
  saveQuality(escolha.quality.id);

  try {
    // Token proprio: a captura entra na sala como um segundo participante, que
    // so publica. O `name` dele e o mesmo da pessoa, entao a interface junta os
    // dois sozinha na lista de gente e nos volumes.
    const access = await api<LivekitAccess>("/api/livekit-token", {
      method: "POST",
      body: JSON.stringify({ roomId: voiceRoomId, screen: true }),
    });
    const ondeComprimiu = await startShare(escolha.sourceId, access.url, access.token, {
      width: escolha.quality.width,
      height: escolha.quality.height,
      fps: escolha.quality.fps,
      bitrate: escolha.quality.bitrate,
      // Com movimento priorizado, a queda de banda tira nitidez em vez de
      // travar a imagem. O padrao do LiveKit para tela e o contrario, feito
      // para documento, e num jogo isso vira engasgo.
      preferMotion: escolha.motion,
    }, escolha.audio, forcarDuplicacao(), escolha.semBarra, codecPreferido());
    // Cair para o processador nao e erro, mas e a informacao que faltou quando
    // a primeira maquina de fora nao conseguiu compartilhar: sem console num
    // build de release, se ninguem disser, ninguem descobre.
    console.info("[tela]", ondeComprimiu);
    if (ondeComprimiu.includes("compressão software:")) {
      showToast("A placa de vídeo não assumiu a compressão; usando o processador.");
    }
    vigiarJanelaTransmitida();
    screenEnabled = true;
    screenButton.classList.add("active");
  } catch (erro) {
    screenEnabled = false;
    screenButton.classList.remove("active");
    showToast(String(erro instanceof Error ? erro.message : erro));
  }
};

// Camera e compartilhamento sao independentes: dao para ficar ligados juntos.
camButton.onclick = async () => {
  if (!await ensureInCall() || !room) return;
  try {
    camEnabled = !camEnabled;
    await room.localParticipant.setCameraEnabled(camEnabled);
    camButton.classList.toggle("active", camEnabled);
  } catch { camEnabled = false; camButton.classList.remove("active"); showToast("O Windows não liberou a câmera."); }
};
// Ensurdecer arrasta o microfone junto, como no Discord: quem nao esta
// ouvindo nao tem como saber que continua sendo ouvido, e falar sozinho para
// uma sala que voce nao escuta e o pior dos dois mundos.
//
// `micAntesDoSurdo` guarda como o microfone estava: quem ja estava mudo antes
// continua mudo ao voltar a ouvir, em vez de ser ligado sem pedir.
let micAntesDoSurdo = false;
audioButton.onclick = async () => {
  audioEnabled = !audioEnabled;
  refreshAudioMuting();
  audioButton.classList.toggle("active", !audioEnabled);
  setIcon(audioButton, audioEnabled ? "audio" : "audio-off");
  announceDeafened();
  if (room) {
    if (!audioEnabled) { micAntesDoSurdo = micEnabled; if (micEnabled) await definirMicrofone(false); }
    else if (micAntesDoSurdo) { micAntesDoSurdo = false; await definirMicrofone(true); }
  }
  renderPeople(); renderNavigation();
};
leaveButton.onclick = async () => {
  if (room?.state === "connected" || room?.state === "connecting") await sairDaChamada();
  else await ensureInCall();
};
function attachTrack(track: RemoteTrack, participant: RemoteParticipant) {
  const who = participant.name || participant.identity;
  if (track.kind === Track.Kind.Audio) {
    // O som da propria transmissao nao pode voltar para o dono: ele ja escuta
    // direto da placa, e a copia que volta do servidor chega atrasada — as duas
    // juntas soam como eco. O video continua voltando, que e a previa.
    if (isScreenParticipant(participant) && key(who) === key(session?.username || "")) return;
    const audio = track.attach();
    audio.id = "audio-" + track.sid;
    audio.dataset.naoconcordoAudio = "true";
    audio.dataset.who = who;
    audio.dataset.fonte = track.source === Track.Source.ScreenShareAudio ? "tela" : "voz";
    audio.autoplay = true;
    document.body.append(audio);
    // Antes de tocar: o elemento nasce em volume 1 e quem ja estava silenciado
    // seria ouvido pelo tempo entre anexar e reaplicar.
    refreshAudioMuting();
    applyVolume(who, volumeOf(who));
    void audio.play().catch(() => { /* destravado depois por unlockAudio */ });
  } else if (track.source === Track.Source.ScreenShare) {
    attachVideo(track, who);
  } else if (track.source === Track.Source.Camera) {
    addCamera(track, who, false);
  }
}
function attachLocalPublication(publication: LocalTrackPublication) {
  const track = publication.track;
  if (track?.kind !== Track.Kind.Video) return;
  // A propria tela nao precisa ocupar o chat: o botao ativo ja confirma a transmissao.
  if (track.source === Track.Source.Camera) addCamera(track, (session?.username || "Você"), true);
}

// ------------------------------------------------------------ cameras
// As faixas de camera ficam num registro proprio para poderem ser redesenhadas
// em qualquer container: o painel do app ou a janela separada.
type CameraTrack = { sid: string; label: string; who: string; muted: boolean; attach: () => HTMLMediaElement };
const cameras = new Map<string, CameraTrack>();

// Quem esta falando agora, por nome. O anel vermelho sai daqui.
const speaking = new Set<string>();
/// Marca sem redesenhar: recriar as tiles cortaria o video no meio da fala.
function updateSpeakingStyles() {
  document.querySelectorAll<HTMLElement>("[data-who]").forEach(element => {
    element.classList.toggle("speaking", speaking.has(key(element.dataset.who || "")));
  });
}

function addCamera(track: { sid?: string; attach: () => HTMLMediaElement }, label: string, isLocal: boolean) {
  if (!track.sid) return;
  cameras.set(track.sid, {
    sid: track.sid, who: label, label: isLocal ? label + " (você)" : label,
    muted: isLocal, attach: () => track.attach(),
  });
  renderCameras();
}
function removeCamera(sid: string) { if (cameras.delete(sid)) renderCameras(); }

// Camera que voce mandou esconder. Diferente de desligar: a pessoa continua
// transmitindo, voce so parou de receber — e a faixa e mesmo cancelada, entao
// a banda tambem para.
const camerasOcultas = new Set<string>();

/// Volta a receber a camera de quem estava escondido.
function mostrarCamera(sid: string) {
  camerasOcultas.delete(sid);
  setCameraSubscribedOne(sid, true);
  renderCameras();
}
/// Cancela a assinatura de uma camera so.
function setCameraSubscribedOne(sid: string, ativo: boolean) {
  if (!room) return;
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      if (publication.source === Track.Source.Camera && publication.trackSid === sid) {
        void publication.setSubscribed(ativo);
      }
    }
  }
}
/// Tile de camera no palco.
///
/// Mesma classe e mesmos gestos das transmissoes de tela: as cameras deixaram
/// de morar num painel flutuante e passaram a dividir o palco em cima do chat.
/// O painel flutuante nascia fixo em cima da navegacao e engolia os cliques de
/// tudo que estivesse embaixo — a lista de canais, os amigos, os botoes.
function cameraTile(entry: CameraTrack) {
  const tile = document.createElement("div");
  tile.id = "cam-" + entry.sid;
  tile.className = "track-tile";
  tile.dataset.who = entry.who;
  const media = entry.attach();
  if (media instanceof HTMLVideoElement) {
    media.autoplay = true; media.playsInline = true; media.muted = entry.muted;
  }
  const label = document.createElement("label");
  label.textContent = entry.label;

  const esconder = document.createElement("button");
  esconder.className = "tile-action";
  esconder.type = "button";
  esconder.title = "Esconder esta câmera";
  esconder.textContent = "✕";
  esconder.onclick = event => {
    event.stopPropagation();
    camerasOcultas.add(entry.sid);
    setCameraSubscribedOne(entry.sid, false);
    renderCameras();
  };

  const grande = document.createElement("button");
  grande.className = "tile-action";
  grande.type = "button";
  grande.title = "Alternar tamanho grande";
  grande.append(icon("theater", "ic-sm"));
  grande.onclick = event => { event.stopPropagation(); toggleTheater(tile); };

  const cheia = document.createElement("button");
  cheia.className = "tile-action";
  cheia.type = "button";
  cheia.title = "Tela cheia";
  cheia.append(icon("full", "ic-sm"));
  cheia.onclick = event => { event.stopPropagation(); void toggleFullscreen(tile); };

  tile.ondblclick = () => void toggleFullscreen(tile);
  tile.oncontextmenu = event => {
    event.preventDefault();
    event.stopPropagation();
    openUserMenu(entry.who, tile, { x: event.clientX, y: event.clientY }, [
      menuAcao(
        cameraWindowOpen ? "Trazer as câmeras de volta" : "Virar janela",
        "window",
        () => void (cameraWindowOpen ? closeCameraWindow() : openCameraWindow()),
      ),
    ]);
  };
  tile.append(media, label, esconder, grande, cheia);
  return tile;
}
function renderCameras() {
  // O palco e compartilhado com as transmissoes de tela, entao aqui so podem
  // sair as tiles de camera: um `replaceChildren` levaria as telas junto.
  for (const antiga of [...stage.querySelectorAll('[id^="cam-"]'), byId("camera-hidden-note")]) {
    if (antiga) antiga.remove();
  }
  const todas = [...cameras.values()];
  const visiveis = todas.filter(entry => !camerasOcultas.has(entry.sid));
  const escondidas = todas.length - visiveis.length;

  for (const entry of visiveis) stage.append(cameraTile(entry));

  // Uma faixa para trazer de volta o que foi escondido: sem isso a camera
  // sumiria sem caminho de volta a nao ser reentrar na chamada.
  if (escondidas) {
    const aviso = document.createElement("button");
    aviso.type = "button";
    aviso.id = "camera-hidden-note";
    aviso.className = "camera-hidden-note";
    aviso.textContent = escondidas === 1 ? "1 câmera escondida — mostrar" : escondidas + " câmeras escondidas — mostrar";
    aviso.onclick = () => { for (const sid of [...camerasOcultas]) mostrarCamera(sid); };
    stage.append(aviso);
  }
  syncStagePlacement();
  updateSpeakingStyles();
}

// ------------------------------------------------ cameras fora do servidor
// Sair da tela do servidor nao devia apagar quem esta na chamada. As telas
// compartilhadas ganham a janela separada; as cameras ganham este cantinho, que
// mostra uma so — a de quem esta falando. Mostrar todas aqui viraria um mosaico
// de selos ilegiveis por cima do chat de outro servidor.
let miniAtual = "";

/// Levanta o cantinho acima do redator.
///
/// Distancia fixa nao serve: o redator cresce com anexos e com a barra de
/// resposta, e o botao Enviar acaba embaixo do video — foi assim que o painel
/// flutuante antigo comia os cliques da navegacao.
function posicionarCameraMini() {
  const caixa = byId("camera-mini");
  const redator = [byId("message-form"), byId("dm-form")]
    .find(form => !form.classList.contains("hidden"));
  const altura = redator ? redator.getBoundingClientRect().height : 82;
  caixa.style.bottom = Math.round(altura + 14) + "px";
}

function renderCameraMini() {
  const caixa = byId("camera-mini");
  const visiveis = [...cameras.values()].filter(entry => !camerasOcultas.has(entry.sid));
  // Com a janela separada aberta as cameras ja estao noutro lugar; repetir aqui
  // so gastaria banda desenhando a mesma pessoa duas vezes.
  const mostrar = !chamadaNaTela() && !cameraWindowOpen && visiveis.length > 0;
  caixa.classList.toggle("hidden", !mostrar);
  if (!mostrar) {
    caixa.replaceChildren();
    miniAtual = "";
    return;
  }

  const falando = visiveis.find(entry => speaking.has(key(entry.who)));
  // Sem ninguem falando, fica quem ja estava: trocar sozinho a cada silencio
  // daria um piscar constante no canto da tela.
  const escolhida = falando
    || visiveis.find(entry => entry.sid === miniAtual)
    || visiveis[0];
  if (escolhida.sid === miniAtual) return;
  miniAtual = escolhida.sid;

  const media = escolhida.attach();
  if (media instanceof HTMLVideoElement) {
    media.autoplay = true; media.playsInline = true; media.muted = true;
  }
  const nome = document.createElement("label");
  nome.textContent = escolhida.label;
  const voltar = document.createElement("button");
  voltar.type = "button";
  voltar.className = "camera-mini-voltar";
  voltar.title = "Voltar para a chamada";
  voltar.append(icon("theater", "ic-sm"));
  voltar.onclick = () => { const alvo = serverDaChamada(); if (alvo) selectServer(alvo); };
  caixa.replaceChildren(media, nome, voltar);
  posicionarCameraMini();
  caixa.oncontextmenu = event => {
    event.preventDefault();
    openUserMenu(escolhida.who, caixa, { x: event.clientX, y: event.clientY }, [
      menuAcao("Virar janela", "window", () => void openCameraWindow()),
    ]);
  };
}

// ------------------------------------------- janela nativa de cameras
let cameraWindowOpen = false;

/// Liga ou desliga a assinatura das cameras nesta janela. Com a janela separada
/// aberta, a principal para de baixar video: a banda muda de lugar, nao dobra.
function setCameraSubscription(active: boolean) {
  if (!room) return;
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      if (publication.source === Track.Source.Camera) void publication.setSubscribed(active);
    }
  }
  if (!active) { cameras.clear(); renderCameras(); }
}

/// Marca no controle de Camera que as cameras estao noutra janela. Idempotente:
/// pode ser chamada pelos tres caminhos de deteccao sem efeito duplicado.
function setPopoutLabel(open: boolean) {
  camButton.title = open
    ? "Câmera (botão direito: fechar a janela de câmeras)"
    : "Ligar câmera (botão direito: abrir numa janela do sistema)";
  camButton.classList.toggle("popout", open);
  // Abrir ou fechar a janela muda quem desenha as cameras: o cantinho some
  // quando elas ja estao noutro lugar.
  renderCameraMini();
}
function onCameraWindowClosed() {
  if (!cameraWindowOpen) return;
  cameraWindowOpen = false;
  watchCameraWindow(false);
  setCameraSubscription(true);
  setPopoutLabel(false);
}

// A janela de cameras manda um sinal de vida por segundo. Se os sinais pararem,
// ela morreu — nao importa como. Isso substitui a deteccao por evento de
// fechamento e por enumeracao de janelas, que falharam as duas no WebView2.
let cameraWatch = 0;
let lastCameraBeat = 0;
const CAMERA_BEAT_TIMEOUT = 3000;

function watchCameraWindow(active: boolean) {
  window.clearInterval(cameraWatch);
  if (!active) return;
  lastCameraBeat = Date.now();
  cameraWatch = window.setInterval(() => {
    if (cameraWindowOpen && Date.now() - lastCameraBeat > CAMERA_BEAT_TIMEOUT) onCameraWindowClosed();
  }, 1000);
}
void (async () => {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen("cameras-viva", () => { lastCameraBeat = Date.now(); });
    await listen("cameras-fechada", () => onCameraWindowClosed());
  } catch (error) {
    console.warn("[cameras] eventos indisponiveis", error);
  }
})();

/// Abre as cameras numa janela do sistema, que pode ir para outro monitor.
/// Avisa quando um pop-up do navegador for fechado.
///
/// O aplicativo usa sinal de vida por evento, que atravessa a fronteira entre
/// as janelas do Tauri. No navegador isso nao existe, mas `window.open` devolve
/// a referencia e `closed` responde direto — mais simples e mais confiavel.
const popupsAbertos = new Map<string, number>();
function vigiarPopup(rotulo: string, aoFechar: () => void) {
  window.clearInterval(popupsAbertos.get(rotulo) || 0);
  const referencia = window.open("", rotulo);
  const relogio = window.setInterval(() => {
    if (!referencia || referencia.closed) {
      window.clearInterval(relogio);
      popupsAbertos.delete(rotulo);
      aoFechar();
    }
  }, 800);
  popupsAbertos.set(rotulo, relogio);
}
/// Fecha um pop-up do navegador pelo rotulo. `window.open` com o mesmo nome e
/// endereco vazio devolve a janela que ja existe, sem navegar — e o unico jeito
/// de reencontrar uma referencia que nao foi guardada.
function fecharPopup(rotulo: string) {
  window.clearInterval(popupsAbertos.get(rotulo) || 0);
  popupsAbertos.delete(rotulo);
  try { window.open("", rotulo)?.close(); } catch { /* ja fechada */ }
}

async function openCameraWindow() {
  if (!voiceRoomId) { showToast("Entre num canal de voz primeiro."); return; }
  // No navegador nao ha sinal de vida por evento do Tauri: quem responde se a
  // janela ainda existe e a propria referencia devolvida por `window.open`.
  if (!ehTauri()) {
    const url = "cameras.html?room=" + encodeURIComponent(voiceRoomId);
    if (!await abrirJanela("cameras", url, "Câmeras", 640, 420)) {
      showToast("O navegador bloqueou a janela. Libere os pop-ups deste site.");
      return;
    }
    cameraWindowOpen = true;
    vigiarPopup("cameras", () => onCameraWindowClosed());
    setCameraSubscription(false);
    setPopoutLabel(true);
    return;
  }
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const existing = await WebviewWindow.getByLabel("cameras");
    if (existing) { await existing.setFocus(); return; }
    const win = new WebviewWindow("cameras", {
      url: "cameras.html?room=" + encodeURIComponent(voiceRoomId),
      title: "Câmeras — naoconcordo",
      width: 640, height: 420, resizable: true, alwaysOnTop: true,
    });
    // Nao espera "tauri://created": o estado passa a valer ja, e o sinal de vida
    // e quem confirma. Se a janela nem chegar a abrir, o timeout devolve tudo.
    cameraWindowOpen = true;
    watchCameraWindow(true);
    setCameraSubscription(false);
    setPopoutLabel(true);
    win.once("tauri://destroyed", () => onCameraWindowClosed());
    win.once("tauri://error", event => { showToast("Não foi possível abrir a janela: " + String(event.payload)); });
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Janela separada indisponível.");
  }
}
async function closeCameraWindow() {
  if (!ehTauri()) { fecharPopup("cameras"); onCameraWindowClosed(); return; }
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const win = await WebviewWindow.getByLabel("cameras");
  await win?.close();
}

// A altura da moldura e escolhida arrastando a alca do canto. Guardar o valor
// evita reajustar a cada chamada; o ResizeObserver e o unico jeito de saber que
// o arrasto terminou, porque `resize` do CSS nao dispara evento proprio.
const STAGE_KEY = "naoconcordo.alturaMoldura";
(() => {
  const salva = localStorage.getItem(STAGE_KEY);
  if (salva) stage.style.height = salva;
  let guardar = 0;
  new ResizeObserver(() => {
    if (stage.classList.contains("hidden")) return;
    window.clearTimeout(guardar);
    // Espera o arrasto parar: gravar a cada pixel enche o armazenamento de lixo.
    guardar = window.setTimeout(() => {
      const altura = stage.style.height;
      if (altura) localStorage.setItem(STAGE_KEY, altura);
    }, 400);
  }).observe(stage);
})();

// ------------------------------------- janela separada das transmissoes
//
// Mesma mecanica da janela de cameras: enquanto ela estiver aberta, a principal
// cancela a assinatura das telas, entao a banda muda de lugar em vez de dobrar.
// Os controles de transmissao vivem la dentro, inclusive a troca de tela sem
// parar quem esta assistindo.
// Transmissoes que voce escolheu assistir, por sid. Entrar num canal nao
// baixa mais a tela de ninguem: em chamada cheia isso eram varios megabits
// entrando sem pedido, e a tela de todo mundo abrindo por cima do chat.
const assistindo = new Set<string>();
/// Esta tela ja foi aceita? O som vem numa faixa propria, publicada pelo mesmo
/// participante de tela, entao a resposta e por participante e nao por faixa:
/// o audio pode chegar antes da imagem, e ai nao ha sid de video para consultar.
function telaAceita(participant: RemoteParticipant): boolean {
  // Com a janela separada aberta, todas as telas ja estao sendo assistidas la.
  if (screenWindowOpen) return true;
  for (const publication of participant.trackPublications.values()) {
    if (publication.source === Track.Source.ScreenShare && assistindo.has(publication.trackSid)) return true;
  }
  return false;
}
let screenWindowOpen = false;
// A janela separada aberta por conta propria (voce saiu da tela do servidor da
// chamada) e diferente da que voce abriu no botao: so a automatica se fecha
// sozinha quando voce volta. Fechar a sua seria mexer no que voce escolheu.
let janelaAutomatica = false;
let lastScreenBeat = 0;
let screenWatch = 0;

function setScreenSubscription(active: boolean) {
  if (!room) return;
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      if (publication.source === Track.Source.ScreenShare) void publication.setSubscribed(active);
    }
  }
  if (!active) { restaurarControles(); stage.replaceChildren(); stage.classList.add("hidden"); }
}

function onScreenWindowClosed() {
  if (!screenWindowOpen) return;
  screenWindowOpen = false;
  janelaAutomatica = false;
  window.clearInterval(screenWatch);
  setScreenSubscription(true);
}

async function openScreenWindow() {
  if (!voiceRoomId) { showToast("Entre num canal de voz primeiro."); return; }
  if (!ehTauri()) {
    const url = "telas.html?room=" + encodeURIComponent(voiceRoomId)
      + "&sharing=" + (screenEnabled ? "1" : "0");
    if (!await abrirJanela("telas", url, "Telas", 960, 600)) {
      showToast("O navegador bloqueou a janela. Libere os pop-ups deste site.");
      return;
    }
    screenWindowOpen = true;
    setScreenSubscription(false);
    vigiarPopup("telas", () => onScreenWindowClosed());
    return;
  }
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const existing = await WebviewWindow.getByLabel("telas");
    if (existing) { await existing.setFocus(); return; }
    const win = new WebviewWindow("telas", {
      url: "telas.html?room=" + encodeURIComponent(voiceRoomId) + "&sharing=" + (screenEnabled ? "1" : "0"),
      title: "Telas — naoconcordo",
      width: 960, height: 600, resizable: true,
    });
    screenWindowOpen = true;
    lastScreenBeat = Date.now();
    window.clearInterval(screenWatch);
    screenWatch = window.setInterval(() => {
      if (screenWindowOpen && Date.now() - lastScreenBeat > 3000) onScreenWindowClosed();
    }, 1000);
    setScreenSubscription(false);
    win.once("tauri://destroyed", () => onScreenWindowClosed());
    win.once("tauri://error", event => { showToast("Não foi possível abrir a janela: " + String(event.payload)); });
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Janela separada indisponível.");
  }
}

async function closeScreenWindow() {
  if (!ehTauri()) { fecharPopup("telas"); onScreenWindowClosed(); return; }
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const win = await WebviewWindow.getByLabel("telas");
  await win?.close();
}

byId("screen-window").addEventListener("click", () => { void (screenWindowOpen ? closeScreenWindow() : openScreenWindow()); });

void (async () => {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen("telas-viva", () => { lastScreenBeat = Date.now(); });
    void registrarAtalhos();
    await listen("telas-fechada", () => onScreenWindowClosed());
    // A janela avisa quando comeca ou para de transmitir por la, para o botao
    // daqui nao mentir sobre o estado.
    await listen<{ sharing: boolean }>("telas-estado", event => {
      screenEnabled = Boolean(event.payload?.sharing);
      screenButton.classList.toggle("active", screenEnabled);
    });
  } catch (error) {
    console.warn("[telas] eventos indisponiveis", error);
  }
})();

// A janela separada de cameras entra pelo botao direito no controle de Camera,
// como o botao direito em Compartilhar pausa a transmissao: um gesto so para
// "tem mais uma opcao aqui". O painel flutuante que existia antes foi removido
// — ele nascia fixo por cima da navegacao e engolia os cliques da lista de
// canais e dos amigos, e o palco resolve melhor o que ele tentava resolver.
camButton.oncontextmenu = event => {
  event.preventDefault();
  void (cameraWindowOpen ? closeCameraWindow() : openCameraWindow());
};

// ------------------------------------------------------- dispositivos
const DEVICE_KEY = "naoconcordo.devices";
type DeviceChoice = { mic?: string; cam?: string; out?: string };
function readDevices(): DeviceChoice {
  try { return JSON.parse(localStorage.getItem(DEVICE_KEY) || "{}") as DeviceChoice; } catch { return {}; }
}
function saveDevices(value: DeviceChoice) { localStorage.setItem(DEVICE_KEY, JSON.stringify(value)); }

async function fillDeviceLists() {
  const note = byId("devices-note");
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const saved = readDevices();
    const fill = (id: string, kind: MediaDeviceKind, chosen?: string) => {
      const select = byId<HTMLSelectElement>(id);
      const list = devices.filter(device => device.kind === kind);
      select.replaceChildren(...list.map((device, index) => {
        const option = document.createElement("option");
        option.value = device.deviceId;
        option.textContent = device.label || kind + " " + (index + 1);
        option.selected = device.deviceId === chosen;
        return option;
      }));
      if (!list.length) {
        const option = document.createElement("option");
        option.textContent = "Nenhum encontrado";
        select.replaceChildren(option);
      }
    };
    fill("device-mic", "audioinput", saved.mic);
    fill("device-cam", "videoinput", saved.cam);
    fill("device-out", "audiooutput", saved.out);
    const semNome = devices.some(device => !device.label);
    note.textContent = semNome ? "Permita microfone e câmera para ver os nomes." : "";
  } catch (error) {
    note.textContent = error instanceof Error ? error.message : "Não foi possível listar os dispositivos.";
  }
}
async function applyDevice(kind: "audioinput" | "videoinput" | "audiooutput", deviceId: string) {
  const saved = readDevices();
  if (kind === "audioinput") saved.mic = deviceId;
  if (kind === "videoinput") saved.cam = deviceId;
  if (kind === "audiooutput") saved.out = deviceId;
  saveDevices(saved);
  if (!room || room.state !== "connected") return;
  try { await room.switchActiveDevice(kind, deviceId); }
  catch (error) { showToast(error instanceof Error ? error.message : "Este dispositivo não pôde ser usado."); }
}
/// Reaplica a escolha salva ao entrar numa chamada.
async function applySavedDevices(target: Room) {
  const saved = readDevices();
  const pairs: [("audioinput" | "videoinput" | "audiooutput"), string | undefined][] = [
    ["audioinput", saved.mic], ["videoinput", saved.cam], ["audiooutput", saved.out],
  ];
  for (const [kind, id] of pairs) {
    if (!id) continue;
    try { await target.switchActiveDevice(kind, id); } catch { /* dispositivo sumiu; segue no padrao */ }
  }
}
// ------------------------------------------------------------- membros
async function renderMembers() {
  const list = byId("member-list"), candidates = byId("member-candidates");
  byId("members-error").textContent = "";
  if (!currentServerId) { list.replaceChildren(emptyLine("Nenhum servidor aberto.")); candidates.replaceChildren(); return; }
  try {
    const data = await api<{ members: { username: string; role: ServerRole }[]; myRole: ServerRole }>(
      "/api/servers/" + encodeURIComponent(currentServerId) + "/members");
    roles[currentServerId] = data.myRole;
    const souDono = data.myRole === "owner";
    const administro = souDono || data.myRole === "mod";
    byId("members-title").textContent = "Configurações de "
      + (servers.find(item => item.id === currentServerId)?.name || "servidor");
    byId("delete-server").classList.toggle("hidden", !souDono);
    byId("customize-server-btn").classList.toggle("hidden", !souDono);
    list.replaceChildren(...data.members.map(member => {
      const eu = key(member.username) === key(session?.username || "");
      const acoes: { label: string; primary?: boolean; run: () => void }[] = [];
      if (souDono && !eu) {
        if (member.role === "member") acoes.push({ label: "Tornar moderador", run: () => void changeRole(member.username, "mod") });
        if (member.role === "mod") acoes.push({ label: "Rebaixar", run: () => void changeRole(member.username, "member") });
        acoes.push({ label: "Passar servidor", run: () => void transferOwnership(member.username) });
      }
      if (administro && !eu && member.role !== "owner") {
        acoes.push({ label: "Expulsar", run: () => void changeMember("remove", member.username) });
      }
      const row = friendRow(member.username, acoes);
      const tag = document.createElement("span");
      tag.className = "role-tag role-" + member.role;
      tag.textContent = member.role === "owner" ? "dono" : member.role === "mod" ? "moderador" : "membro";
      row.insertBefore(tag, row.children[2] || null);
      return row;
    }));
    if (!administro) { candidates.replaceChildren(emptyLine("Só dono e moderador convidam.")); return; }
    const faltando = friends.filter(friend => !data.members.some(member => key(member.username) === key(friend)));
    candidates.replaceChildren(...(faltando.length
      ? faltando.map(name => friendRow(name, [{ label: "Convidar", primary: true, run: () => void changeMember("add", name) }]))
      : [emptyLine("Todos já participam.")]));
  } catch (error) {
    byId("members-error").textContent = error instanceof Error ? error.message : "Não foi possível carregar.";
  }
}
async function changeMember(action: "add" | "remove", username: string) {
  if (action === "remove" && !await confirmAction("Expulsar membro", "Expulsar " + username + " deste servidor?", "A pessoa perde acesso aos canais e ao historico.", "Expulsar")) return;
  try {
    await api<void>("/api/servers/members/" + action, { method: "POST", body: JSON.stringify({ serverId: currentServerId, username }) });
    await renderMembers();
  } catch (error) { byId("members-error").textContent = error instanceof Error ? error.message : "Não foi possível alterar."; }
}
async function changeRole(username: string, role: ServerRole) {
  try {
    await api<void>("/api/servers/members/role", { method: "POST", body: JSON.stringify({ serverId: currentServerId, username, role }) });
    await renderMembers();
  } catch (error) { byId("members-error").textContent = error instanceof Error ? error.message : "Não foi possível mudar o papel."; }
}
/// Transferir e definitivo: quem passa vira moderador e nao volta sozinho.
async function transferOwnership(username: string) {
  if (!await confirmAction("Transferir servidor", "Passar o servidor para " + username + "?", "Voce sera rebaixado para moderador e nao podera desfazer sozinho.", "Transferir")) return;
  await changeRole(username, "owner");
  await enterApp();
}
byId("leave-server").addEventListener("click", async () => {
  if (!await confirmAction("Sair do servidor", "Sair de " + (servers.find(item => item.id === currentServerId)?.name || "servidor") + "?", "Voce perdera acesso aos canais ate ser convidado novamente.", "Sair")) return;
  try {
    await api<void>("/api/servers/leave", { method: "POST", body: JSON.stringify({ serverId: currentServerId }) });
    byId<HTMLDialogElement>("members-dialog").close();
    currentServerId = ""; currentRoomId = "";
    await enterApp();
  } catch (error) { byId("members-error").textContent = error instanceof Error ? error.message : "Não foi possível sair."; }
});
byId("delete-server").addEventListener("click", async () => {
  const nome = servers.find(item => item.id === currentServerId)?.name || "este servidor";
  if (!await confirmAction("Apagar servidor", "Apagar " + nome + "?", "Esta acao remove canais e historico e nao pode ser desfeita.", "Apagar")) return;
  try {
    await api<void>("/api/servers/delete", { method: "POST", body: JSON.stringify({ serverId: currentServerId }) });
    byId<HTMLDialogElement>("members-dialog").close();
    currentServerId = ""; currentRoomId = "";
    await enterApp();
  } catch (error) { byId("members-error").textContent = error instanceof Error ? error.message : "Não foi possível apagar."; }
});
byId("server-members").addEventListener("click", async () => { await renderMembers(); byId<HTMLDialogElement>("members-dialog").showModal(); });
byId("close-members").addEventListener("click", () => byId<HTMLDialogElement>("members-dialog").close());

// ------------------------------------------------- personalizacao de perfil
let profileEditBannerFileId: string | null = null;
let profileEditBannerChanged = false;

byId("profile-edit")?.addEventListener("click", () => {
  closeMiniProfile();
  const me = profiles.get(session?.username.toLowerCase() || "");
  profileEditBannerFileId = me?.bannerFile || null;
  profileEditBannerChanged = false;
  const bioInput = byId<HTMLTextAreaElement>("profile-edit-bio");
  bioInput.value = me?.bio || "";
  byId("profile-edit-bio-count").textContent = `${bioInput.value.length} / 190`;
  const preview = byId("profile-edit-banner-preview");
  const removeBtn = byId("profile-edit-banner-remove");
  if (profileEditBannerFileId) {
    preview.classList.add("has-image");
    removeBtn.classList.remove("hidden");
    fileUrl(profileEditBannerFileId).then(url => { preview.style.backgroundImage = 'url("' + url + '")'; }).catch(() => {});
  } else {
    preview.classList.remove("has-image");
    preview.style.backgroundImage = "";
    removeBtn.classList.add("hidden");
  }
  byId<HTMLDialogElement>("profile-edit-dialog").showModal();
});

byId("profile-edit-bio")?.addEventListener("input", e => {
  const target = e.target as HTMLTextAreaElement;
  byId("profile-edit-bio-count").textContent = `${target.value.length} / 190`;
});

byId("profile-edit-banner-btn")?.addEventListener("click", () => {
  byId<HTMLInputElement>("profile-edit-banner-input").click();
});

byId<HTMLInputElement>("profile-edit-banner-input")?.addEventListener("change", async event => {
  const file = (event.currentTarget as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const stored = await uploadFile(file);
    profileEditBannerFileId = stored.id;
    profileEditBannerChanged = true;
    const preview = byId("profile-edit-banner-preview");
    preview.classList.add("has-image");
    byId("profile-edit-banner-remove").classList.remove("hidden");
    fileUrl(stored.id).then(url => { preview.style.backgroundImage = 'url("' + url + '")'; });
  } catch (err) {
    showToast(err instanceof Error ? err.message : "Erro ao enviar banner.");
  }
});

byId("profile-edit-banner-remove")?.addEventListener("click", () => {
  profileEditBannerFileId = null;
  profileEditBannerChanged = true;
  const preview = byId("profile-edit-banner-preview");
  preview.classList.remove("has-image");
  preview.style.backgroundImage = "";
  byId("profile-edit-banner-remove").classList.add("hidden");
});

byId("profile-edit-cancel")?.addEventListener("click", () => {
  byId<HTMLDialogElement>("profile-edit-dialog").close();
});

byId("profile-edit-save")?.addEventListener("click", async () => {
  const bio = byId<HTMLTextAreaElement>("profile-edit-bio").value.trim();
  try {
    const payload: { bio?: string | null; bannerFile?: string | null } = { bio: bio || null };
    if (profileEditBannerChanged) payload.bannerFile = profileEditBannerFileId;
    const updated = await api<Profile>("/api/profile", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    profiles.set(updated.username.toLowerCase(), updated);
    paintMyAvatars(updated.username);
    byId<HTMLDialogElement>("profile-edit-dialog").close();
    showToast("Perfil atualizado.");
  } catch (err) {
    showToast(err instanceof Error ? err.message : "Erro ao salvar perfil.");
  }
});

// ------------------------------------------------- personalizacao de servidor
let serverSettingsBannerFileId: string | null = null;
let serverSettingsBannerChanged = false;
let serverSettingsIconFileId: string | null = null;
let serverSettingsIconChanged = false;

function openServerSettings() {
  const s = servers.find(item => item.id === currentServerId);
  if (!s) return;
  byId<HTMLInputElement>("server-settings-name").value = s.name;
  const descInput = byId<HTMLTextAreaElement>("server-settings-description");
  descInput.value = s.description || "";
  byId("server-settings-desc-count").textContent = `${descInput.value.length} / 300`;

  serverSettingsBannerFileId = s.bannerFile || null;
  serverSettingsBannerChanged = false;
  serverSettingsIconFileId = s.iconFile || null;
  serverSettingsIconChanged = false;

  const bannerPrev = byId("server-settings-banner-preview");
  const bannerRem = byId("server-settings-banner-remove");
  if (serverSettingsBannerFileId) {
    bannerPrev.classList.add("has-image");
    bannerRem.classList.remove("hidden");
    fileUrl(serverSettingsBannerFileId).then(url => { bannerPrev.style.backgroundImage = 'url("' + url + '")'; }).catch(() => {});
  } else {
    bannerPrev.classList.remove("has-image");
    bannerPrev.style.backgroundImage = "";
    bannerRem.classList.add("hidden");
  }

  const iconPrev = byId("server-settings-icon-preview");
  const iconRem = byId("server-settings-icon-remove");
  if (serverSettingsIconFileId) {
    iconPrev.classList.add("has-image");
    iconRem.classList.remove("hidden");
    fileUrl(serverSettingsIconFileId).then(url => { iconPrev.style.backgroundImage = 'url("' + url + '")'; }).catch(() => {});
  } else {
    iconPrev.classList.remove("has-image");
    iconPrev.style.backgroundImage = "";
    iconRem.classList.add("hidden");
  }

  byId<HTMLDialogElement>("server-settings-dialog").showModal();
}

byId("customize-server-btn")?.addEventListener("click", () => {
  byId<HTMLDialogElement>("members-dialog").close();
  openServerSettings();
});

byId("server-settings-description")?.addEventListener("input", e => {
  const target = e.target as HTMLTextAreaElement;
  byId("server-settings-desc-count").textContent = `${target.value.length} / 300`;
});

byId("server-settings-banner-btn")?.addEventListener("click", () => {
  byId<HTMLInputElement>("server-settings-banner-input").click();
});

byId<HTMLInputElement>("server-settings-banner-input")?.addEventListener("change", async event => {
  const file = (event.currentTarget as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const stored = await uploadFile(file);
    serverSettingsBannerFileId = stored.id;
    serverSettingsBannerChanged = true;
    const prev = byId("server-settings-banner-preview");
    prev.classList.add("has-image");
    byId("server-settings-banner-remove").classList.remove("hidden");
    fileUrl(stored.id).then(url => { prev.style.backgroundImage = 'url("' + url + '")'; });
  } catch (err) {
    showToast(err instanceof Error ? err.message : "Erro ao enviar banner.");
  }
});

byId("server-settings-banner-remove")?.addEventListener("click", () => {
  serverSettingsBannerFileId = null;
  serverSettingsBannerChanged = true;
  const prev = byId("server-settings-banner-preview");
  prev.classList.remove("has-image");
  prev.style.backgroundImage = "";
  byId("server-settings-banner-remove").classList.add("hidden");
});

byId("server-settings-icon-btn")?.addEventListener("click", () => {
  byId<HTMLInputElement>("server-settings-icon-input").click();
});

byId<HTMLInputElement>("server-settings-icon-input")?.addEventListener("change", async event => {
  const file = (event.currentTarget as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const stored = await uploadFile(file);
    serverSettingsIconFileId = stored.id;
    serverSettingsIconChanged = true;
    const prev = byId("server-settings-icon-preview");
    prev.classList.add("has-image");
    byId("server-settings-icon-remove").classList.remove("hidden");
    fileUrl(stored.id).then(url => { prev.style.backgroundImage = 'url("' + url + '")'; });
  } catch (err) {
    showToast(err instanceof Error ? err.message : "Erro ao enviar ícone.");
  }
});

byId("server-settings-icon-remove")?.addEventListener("click", () => {
  serverSettingsIconFileId = null;
  serverSettingsIconChanged = true;
  const prev = byId("server-settings-icon-preview");
  prev.classList.remove("has-image");
  prev.style.backgroundImage = "";
  byId("server-settings-icon-remove").classList.add("hidden");
});

byId("server-settings-cancel")?.addEventListener("click", () => {
  byId<HTMLDialogElement>("server-settings-dialog").close();
});

byId("server-settings-save")?.addEventListener("click", async () => {
  const name = byId<HTMLInputElement>("server-settings-name").value.trim();
  if (name.length < 2) { showToast("O nome do servidor precisa ter pelo menos 2 letras."); return; }
  const description = byId<HTMLTextAreaElement>("server-settings-description").value.trim();
  try {
    const body: { name?: string; description?: string | null; iconFile?: string | null; bannerFile?: string | null } = {
      name,
      description: description || null,
    };
    if (serverSettingsIconChanged) body.iconFile = serverSettingsIconFileId;
    if (serverSettingsBannerChanged) body.bannerFile = serverSettingsBannerFileId;

    const updated = await api<ServerInfo>("/api/servers/" + encodeURIComponent(currentServerId) + "/customize", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    const idx = servers.findIndex(s => s.id === updated.id);
    if (idx >= 0) servers[idx] = updated;
    renderNavigation();
    byId<HTMLDialogElement>("server-settings-dialog").close();
    showToast("Servidor atualizado.");
  } catch (err) {
    showToast(err instanceof Error ? err.message : "Erro ao salvar servidor.");
  }
});

// ------------------------------------------------- perfil no servidor
let serverProfileAvatarFileId: string | null = null;

function openServerProfileDialog() {
  if (view !== "server" || !currentServerId || !session) return;
  const mem = serverMemberProfiles.get(key(session.username));
  const nickInput = byId<HTMLInputElement>("server-profile-nickname");
  nickInput.value = mem?.nickname || "";
  byId("server-profile-error").textContent = "";

  serverProfileAvatarFileId = mem?.avatarFile || null;

  renderServerProfilePreview();
  byId<HTMLDialogElement>("server-profile-dialog").showModal();
}

function renderServerProfilePreview() {
  const prev = byId("server-profile-avatar-preview");
  const rem = byId("server-profile-avatar-remove");
  if (serverProfileAvatarFileId) {
    prev.classList.add("has-image");
    prev.textContent = "";
    rem.classList.remove("hidden");
    fileUrl(serverProfileAvatarFileId).then(url => { prev.style.backgroundImage = 'url("' + url + '")'; }).catch(() => {});
  } else {
    prev.classList.remove("has-image");
    prev.style.backgroundImage = "";
    prev.textContent = initials(session?.username || "");
    rem.classList.add("hidden");
  }
}

byId("profile-edit-server-btn")?.addEventListener("click", () => {
  closeMiniProfile();
  openServerProfileDialog();
});

byId("server-profile-avatar-btn")?.addEventListener("click", () => {
  byId<HTMLInputElement>("server-profile-avatar-input").click();
});

byId<HTMLInputElement>("server-profile-avatar-input")?.addEventListener("change", async event => {
  const file = (event.currentTarget as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const stored = await uploadFile(file);
    serverProfileAvatarFileId = stored.id;
    renderServerProfilePreview();
  } catch (err) {
    byId("server-profile-error").textContent = err instanceof Error ? err.message : "Erro ao enviar foto.";
  }
});

byId("server-profile-avatar-remove")?.addEventListener("click", () => {
  serverProfileAvatarFileId = null;
  renderServerProfilePreview();
});

byId("server-profile-cancel")?.addEventListener("click", () => {
  byId<HTMLDialogElement>("server-profile-dialog").close();
});

byId("server-profile-save")?.addEventListener("click", async () => {
  if (view !== "server" || !currentServerId) return;
  const nickname = byId<HTMLInputElement>("server-profile-nickname").value.trim();
  try {
    const body: { nickname?: string | null; avatarFile?: string | null } = {
      nickname: nickname || null,
      avatarFile: serverProfileAvatarFileId,
    };
    const updated = await api<ServerMember>("/api/servers/" + encodeURIComponent(currentServerId) + "/member-profile", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    serverMemberProfiles.set(key(updated.username), updated);
    renderPeople();
    if (session) paintMyAvatars(session.username);
    if (mode === "room") renderMessages();
    byId<HTMLDialogElement>("server-profile-dialog").close();
    showToast("Perfil no servidor atualizado.");
  } catch (err) {
    byId("server-profile-error").textContent = err instanceof Error ? err.message : "Erro ao salvar perfil no servidor.";
  }
});

// ------------------------------------------------- convites de servidor
// Entrar deixou de ser automatico: o convite chega pelo WebSocket, fica com
// contador na barra de servidores e so vira participacao quando a pessoa aceita.
let serverInvites: ServerInvite[] = [];
function renderServerInvites() {
  const botao = byId("server-invites-button");
  botao.classList.toggle("hidden", serverInvites.length === 0);
  byId("server-invites-count").textContent = String(serverInvites.length);
  const lista = byId("server-invite-list");
  lista.replaceChildren(...(serverInvites.length ? serverInvites.map(invite => {
    const row = document.createElement("div"); row.className = "friend-row";
    const nome = document.createElement("span"); nome.className = "friend-name"; nome.textContent = invite.serverName;
    const quem = document.createElement("small"); quem.className = "muted"; quem.textContent = "convite de " + invite.from;
    const aceitar = document.createElement("button"); aceitar.type = "button"; aceitar.className = "primary small"; aceitar.textContent = "Entrar";
    aceitar.onclick = () => void responderConvite(invite, true);
    const recusar = document.createElement("button"); recusar.type = "button"; recusar.className = "small"; recusar.textContent = "Recusar";
    recusar.onclick = () => void responderConvite(invite, false);
    row.append(nome, quem, aceitar, recusar);
    return row;
  }) : [emptyLine("Nenhum convite pendente.")]));
}
async function refreshServerInvites() {
  if (!session) return;
  try {
    const data = await api<{ invites: ServerInvite[] }>("/api/servers/invites");
    serverInvites = data.invites || [];
    renderServerInvites();
  } catch { /* sem sessao ou rede fora: tenta de novo no proximo bootstrap */ }
}
async function responderConvite(invite: ServerInvite, aceitar: boolean) {
  byId("server-invites-error").textContent = "";
  try {
    await api<void>("/api/servers/invites/" + (aceitar ? "accept" : "reject"), { method: "POST", body: JSON.stringify({ inviteId: invite.id }) });
    serverInvites = serverInvites.filter(item => item.id !== invite.id);
    renderServerInvites();
    if (!serverInvites.length) byId<HTMLDialogElement>("server-invites-dialog").close();
    if (!aceitar) showToast("Convite recusado.");
  } catch (error) { byId("server-invites-error").textContent = error instanceof Error ? error.message : "Não foi possível responder."; }
}
byId("server-invites-button").addEventListener("click", async () => {
  await refreshServerInvites();
  byId<HTMLDialogElement>("server-invites-dialog").showModal();
});
byId("close-server-invites").addEventListener("click", () => byId<HTMLDialogElement>("server-invites-dialog").close());

// ------------------------------------------------------- painel de convites
/// Só o admin enxerga: cada código serve uma conta e guarda quem entrou com ele.
function inviteRow(invite: Invite) {
  const row = document.createElement("div"); row.className = "friend-row";
  const quando = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });
  const codigo = document.createElement("span"); codigo.className = "friend-name"; codigo.textContent = invite.code;
  const detalhe = document.createElement("small"); detalhe.className = "muted";
  detalhe.textContent = invite.usedBy
    ? "usado por " + invite.usedBy + " em " + quando.format(new Date(invite.usedAt || invite.createdAt))
    : (invite.label ? invite.label + " · " : "") + quando.format(new Date(invite.createdAt));
  row.append(codigo, detalhe);
  if (!invite.usedBy && !invite.revoked) {
    const copiar = document.createElement("button");
    copiar.type = "button"; copiar.className = "primary small"; copiar.textContent = "Copiar";
    copiar.onclick = () => { void navigator.clipboard.writeText(invite.code).then(() => showToast("Convite copiado.")).catch(() => showToast("Convite: " + invite.code)); };
    const revogar = document.createElement("button");
    revogar.type = "button"; revogar.className = "small"; revogar.textContent = "Revogar";
    revogar.onclick = () => void revokeInvite(invite.code);
    row.append(copiar, revogar);
  }
  return row;
}
async function renderInvites() {
  byId("admin-error").textContent = "";
  try {
    const data = await api<{ invites: Invite[] }>("/api/admin/invites");
    const livres = data.invites.filter(item => !item.usedBy && !item.revoked);
    const usados = data.invites.filter(item => item.usedBy);
    byId("admin-open-list").replaceChildren(...(livres.length ? livres.map(inviteRow) : [emptyLine("Nenhum convite disponível.")]));
    byId("admin-used-list").replaceChildren(...(usados.length ? usados.map(inviteRow) : [emptyLine("Ninguém entrou por convite ainda.")]));
  } catch (error) { byId("admin-error").textContent = error instanceof Error ? error.message : "Não foi possível carregar."; }
}
async function revokeInvite(code: string) {
  if (!await confirmAction("Revogar convite", "Revogar este convite?", "Ele deixa de valer para criar conta.", "Revogar")) return;
  try { await api<void>("/api/admin/invites/revoke", { method: "POST", body: JSON.stringify({ code }) }); await renderInvites(); }
  catch (error) { byId("admin-error").textContent = error instanceof Error ? error.message : "Não foi possível revogar."; }
}
byId("admin-button").addEventListener("click", async () => {
  closeMiniProfile();
  await renderInvites();
  byId<HTMLDialogElement>("admin-dialog").showModal();
});
byId("close-admin").addEventListener("click", () => byId<HTMLDialogElement>("admin-dialog").close());
byId<HTMLFormElement>("admin-invite-form").addEventListener("submit", async event => {
  event.preventDefault();
  const campo = byId<HTMLInputElement>("admin-invite-label");
  try {
    const invite = await api<Invite>("/api/admin/invites", { method: "POST", body: JSON.stringify({ label: campo.value.trim() }) });
    campo.value = "";
    await renderInvites();
    void navigator.clipboard.writeText(invite.code).then(() => showToast("Convite copiado: " + invite.code)).catch(() => showToast("Convite: " + invite.code));
  } catch (error) { byId("admin-error").textContent = error instanceof Error ? error.message : "Não foi possível gerar."; }
});

// Forca o motor de duplicacao mesmo onde o WGC funcionaria. Serve para
// exercitar, numa maquina Windows 11, o caminho que so roda no Windows 10 —
// codigo que ninguem consegue testar e codigo que ninguem sabe se funciona.
//
// Fica escondido fora do canal de teste: nao e ajuste util para quem so quer
// usar o aplicativo, e ligado sem motivo so piora a captura de janela.
const DXGI_KEY = "naoconcordo.forcar-dxgi";
const forcarDuplicacao = () => localStorage.getItem(DXGI_KEY) === "1";
byId<HTMLInputElement>("modo-dev").addEventListener("change", event => {
  localStorage.setItem(DEV_KEY, (event.currentTarget as HTMLInputElement).checked ? "1" : "0");
  aplicarModoDev();
});
// Quem comprime a tela. Fica visivel, e nao escondido no modo desenvolvedor,
// porque a escolha tem consequencia para quem assiste: o AV1 economiza banda,
// mas exige um decodificador que nem toda maquina do outro lado tem.
/// O que este cliente consegue **receber**.
///
/// Um SFU nao transcodifica: o que sai da GPU de quem transmite e exatamente o
/// que chega em quem assiste. Entao a pergunta que importa nao e se a placa de
/// quem assiste tem decodificador de AV1 — o Chromium decodifica por software
/// quando nao tem —, e sim se o WebRTC dele anuncia AV1 na negociacao. Como
/// todo mundo aqui roda o mesmo aplicativo, perguntar a este ja responde pelos
/// outros.
function relatarSuporteDeCodec() {
  const alvo = byId("codec-suporte");
  try {
    const codecs = RTCRtpReceiver.getCapabilities("video")?.codecs || [];
    const tem = (nome: string) => codecs.some(item => new RegExp(nome, "i").test(item.mimeType));
    const lista = ["AV1", "H264", "VP9", "VP8"].filter(tem);
    alvo.textContent = lista.length
      ? "Este aplicativo recebe: " + lista.join(", ") + "."
        + (tem("AV1") ? "" : " Sem AV1 — use H.264 para quem assiste te ver.")
      : "Não foi possível ler os codecs deste cliente.";
  } catch {
    alvo.textContent = "Não foi possível ler os codecs deste cliente.";
  }
}
byId<HTMLSelectElement>("codec-tela")?.addEventListener("change", event => {
  const valor = (event.currentTarget as HTMLSelectElement).value as CodecPreferido;
  guardarCodec(valor);
  showToast("Vale na próxima vez que você começar a compartilhar.");
});
byId<HTMLInputElement>("forcar-dxgi")?.addEventListener("change", event => {
  const marcado = (event.currentTarget as HTMLInputElement).checked;
  localStorage.setItem(DXGI_KEY, marcado ? "1" : "0");
  showToast(marcado
    ? "Duplicação forçada. Vale na próxima vez que você começar a compartilhar."
    : "De volta à escolha automática do motor de captura.");
});
/// Diz se a borda amarela do Windows sai nesta maquina, e por que nao sai
/// quando nao sai. Existe porque o mesmo binario tira a borda num computador e
/// nao tira noutro, e sem isso o diagnostico vira adivinhacao a distancia.
async function mostrarDiagnosticoDaBorda() {
  const alvo = byId("border-diag");
  if (!("__TAURI_INTERNALS__" in window)) { alvo.textContent = "Disponível apenas no aplicativo instalado."; return; }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const diag = await invoke<{ windows: string; suportado: boolean; permitido: boolean; semBorda: boolean }>("screen_border_diag");
    if (diag.semBorda) { alvo.textContent = diag.windows + " — captura direta, sem a borda amarela."; return; }
    // Sem a opcao de tirar a borda, a captura cai para a duplicacao de tela,
    // que nao desenha aviso nenhum mas trabalha sobre o monitor: janela sai por
    // recorte, e ai o que estiver por cima aparece.
    alvo.textContent = diag.windows
      + " — sem a opção de tirar a borda, então a captura usa duplicação de tela (sem borda amarela)."
      + " Ao compartilhar uma janela, mantenha-a visível: o que estiver por cima dela aparece.";
  } catch (erro) {
    alvo.textContent = "Não foi possível verificar: " + (erro instanceof Error ? erro.message : String(erro));
  }
}
async function openDevicesDialog() {
  byId<HTMLInputElement>("notify-sound").checked = soundOn();
  byId<HTMLInputElement>("notify-desktop").checked = desktopNotificationsOn();
  byId<HTMLInputElement>("notify-preview").checked = notificationPreviewOn();
  byId<HTMLInputElement>("notify-in-call").checked = notificationsInCallOn();
  byId<HTMLInputElement>("canal-unstable").checked = canalAtual() === "unstable";
  byId("check-update-status").textContent = "";
  byId<HTMLInputElement>("modo-dev").checked = modoDev();
  aplicarModoDev();
  aplicarAmbiente();
  byId<HTMLInputElement>("forcar-dxgi").checked = forcarDuplicacao();
  byId<HTMLSelectElement>("codec-tela").value = codecPreferido();
  relatarSuporteDeCodec();
  void mostrarDiagnosticoDaBorda();
  await fillDeviceLists();
  pintarConfiguracoesDeVoz();
  byId<HTMLDialogElement>("devices-dialog").showModal();
  void ligarMedidorDoDialogo();
  acompanharUso(true);
}

// -------------------------------------------------------------- consumo
// O WebView2 e Chromium e nunca roda dentro do nosso processo: no Gerenciador
// de Tarefas o aplicativo aparece partido em varios nomes da Microsoft, e
// parece mais leve do que e. Juntar os processos nao da — `--single-process`
// nao e suportado. Somar da, e e o que esta aqui.
type Grupo = { nome: string; memoria: number; processos: number };
type Uso = { memoria: number; cpuMs: number; processos: number; nucleos: number; grupos: Grupo[] };

let usoTimer = 0;
let usoAnterior: { cpuMs: number; quando: number } | null = null;

const emMB = (bytes: number) => (bytes / 1024 / 1024).toFixed(0) + " MB";

async function medirUso() {
  let uso: Uso;
  try { uso = await invoke<Uso>("uso_de_recursos"); }
  catch { byId("uso-total").textContent = "indisponivel"; return; }

  // A primeira medida so serve de marco: porcentagem de CPU precisa de duas.
  const agora = performance.now();
  let cpu = "";
  if (usoAnterior) {
    const decorrido = agora - usoAnterior.quando;
    const gasto = uso.cpuMs - usoAnterior.cpuMs;
    if (decorrido > 0 && gasto >= 0) {
      const porcento = (gasto / decorrido) * 100 / Math.max(1, uso.nucleos);
      cpu = " · CPU " + porcento.toFixed(1) + "%";
    }
  }
  usoAnterior = { cpuMs: uso.cpuMs, quando: agora };

  byId("uso-total").textContent = emMB(uso.memoria) + cpu
    + " · " + uso.processos + (uso.processos === 1 ? " processo" : " processos");

  byId("uso-grupos").replaceChildren(...uso.grupos.map(grupo => {
    const linha = document.createElement("div");
    linha.className = "uso-linha";
    const nome = document.createElement("span");
    nome.textContent = grupo.nome + (grupo.processos > 1 ? " (" + grupo.processos + ")" : "");
    const valor = document.createElement("strong");
    valor.textContent = emMB(grupo.memoria);
    linha.append(nome, valor);
    return linha;
  }));
}

/// Esconde o que so o aplicativo faz.
///
/// Oferecer um botao que nao pode funcionar e pior do que nao ter o botao:
/// atualizador, medida de consumo por processo e o motor de captura dependem do
/// Rust, e no navegador nao ha o que chamar.
function aplicarAmbiente() {
  const noApp = ehTauri();
  for (const id of ["secao-atualizacoes", "secao-consumo"]) {
    byId(id)?.classList.toggle("hidden", !noApp);
  }
  if (!noApp) {
    byId("forcar-dxgi-linha").classList.add("hidden");
    // No navegador quem comprime e o proprio navegador: nao ha o que escolher.
    byId("codec-tela-linha").classList.add("hidden");
    byId("border-diag").textContent =
      "No navegador quem captura a tela e o proprio navegador, com o seletor dele.";
  }
}

// -------------------------------------------------- modo desenvolvedor
// Interruptor separado do canal de teste: quem esta no unstable quer receber
// versao nova cedo, nao necessariamente ver numero de codificador por cima da
// chamada. Sao publicos diferentes.
const DEV_KEY = "naoconcordo.dev";
const modoDev = () => localStorage.getItem(DEV_KEY) === "1";

function aplicarModoDev() {
  const ligado = modoDev();
  byId("forcar-dxgi-linha").classList.toggle("hidden", !ligado || !ehTauri());
  if (!ligado) {
    byId("diag-box").classList.add("hidden");
    window.clearInterval(diagTimer);
    diagTimer = 0;
  } else if (!diagTimer) {
    diagTimer = window.setInterval(() => void atualizarDiagnostico(), 2000);
    void atualizarDiagnostico();
  }
}

// ------------------------------------------------ diagnostico da transmissao
// O WebRTC ja sabe por que esta degradando; so ninguem estava perguntando.
// `limite` responde a pergunta que importa — se quem segura e a CPU de quem
// transmite ou o upload dele — e `codificador` diz se e software, que e o caso
// comum e o caro.
let diagTimer = 0;

/// Le as estatisticas de recepcao de uma transmissao que estamos assistindo.
async function diagnosticoDeRecepcao(): Promise<string[]> {
  const linhas: string[] = [];
  if (!room) return linhas;
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      if (publication.source !== Track.Source.ScreenShare) continue;
      if (!assistindo.has(publication.trackSid)) continue;
      // `receiver` e o RTCRtpReceiver cru; o livekit nao expoe um resumo pronto.
      const receiver = (publication.track as { receiver?: RTCRtpReceiver } | undefined)?.receiver;
      if (!receiver) continue;
      let relatorio: RTCStatsReport;
      try { relatorio = await receiver.getStats(); } catch { continue; }
      relatorio.forEach(item => {
        if (item.type !== "inbound-rtp" || item.kind !== "video") return;
        const dados = item as RTCInboundRtpStreamStats & {
          frameWidth?: number; frameHeight?: number; framesPerSecond?: number;
          framesDropped?: number; totalDecodeTime?: number; framesDecoded?: number;
        };
        const ms = dados.framesDecoded
          ? ((dados.totalDecodeTime || 0) * 1000 / dados.framesDecoded).toFixed(1)
          : "?";
        linhas.push(
          "RECEBE " + getDisplayName(participant.name || participant.identity)
          + "  " + (dados.frameWidth || 0) + "x" + (dados.frameHeight || 0)
          + " @ " + Math.round(dados.framesPerSecond || 0) + "fps"
          + "  perdidos " + (dados.packetsLost || 0)
          + "  descartados " + (dados.framesDropped || 0)
          + "  decodifica " + ms + "ms/quadro",
        );
      });
    }
  }
  return linhas;
}

type EstatisticasEnvio = {
  largura: number; altura: number; fps: number; bitrateAlvo: number;
  limite: string; msPorQuadro: number; codificador: string; eficiente: boolean;
  quadros: number; quedasDeResolucao: number; descartados: number;
  falhaCaptura: string | null;
};

async function atualizarDiagnostico() {
  const caixa = byId("diag-box");
  if (!modoDev() || !inCall()) { caixa.classList.add("hidden"); return; }

  const linhas: string[] = [];
  if (screenEnabled) {
    try {
      const envio = await invoke<EstatisticasEnvio | null>("screen_share_stats");
      if (envio) {
        linhas.push(
          "ENVIA  " + envio.largura + "x" + envio.altura
          + " @ " + Math.round(envio.fps) + "fps"
          + "  " + (envio.bitrateAlvo / 1_000_000).toFixed(1) + " Mbps"
          + "  limite: " + envio.limite,
        );
        linhas.push(
          "       codifica " + envio.msPorQuadro.toFixed(1) + "ms/quadro"
          + "  " + (envio.codificador || "?")
          + (envio.eficiente ? " (hardware)" : " (software)")
          + "  quedas de resolucao: " + envio.quedasDeResolucao
          + (envio.descartados ? "  descartados: " + envio.descartados : ""),
        );
        if (envio.falhaCaptura) linhas.push("       CAPTURA PAROU: " + envio.falhaCaptura);
      }
    } catch { /* a transmissao pode ter parado entre a checagem e a chamada */ }
  }
  linhas.push(...await diagnosticoDeRecepcao());

  caixa.classList.toggle("hidden", linhas.length === 0);
  caixa.textContent = linhas.join("\n");
}

function acompanharUso(ligar: boolean) {
  window.clearInterval(usoTimer);
  usoTimer = 0;
  if (!ligar || !ehTauri()) return;
  usoAnterior = null;
  byId("uso-total").textContent = "medindo...";
  void medirUso();
  // Dois segundos: perto o bastante para o numero acompanhar o que a pessoa
  // faz, longe o bastante para a propria medicao nao aparecer na conta.
  usoTimer = window.setInterval(() => void medirUso(), 2000);
}
/// Trocar de canal vale ja na proxima verificacao; nao precisa reinstalar.
byId<HTMLInputElement>("canal-unstable").addEventListener("change", event => {
  const marcado = (event.currentTarget as HTMLInputElement).checked;
  definirCanal(marcado ? "unstable" : "stable");
  showToast(marcado ? "Canal de teste ligado. A proxima verificacao ja usa ele." : "De volta ao canal estavel.");
  if (marcado) void checkForUpdate(showToast);
});
/// Verificacao a pedido. A automatica so roda na abertura, entao quem acabou
/// de publicar uma versao nao precisa fechar e abrir o app para busca-la.
byId("check-update")?.addEventListener("click", async event => {
  const botao = event.currentTarget as HTMLButtonElement;
  const status = byId("check-update-status");
  const dizer = (texto: string) => { status.textContent = texto; };
  botao.disabled = true;
  try {
    dizer("Procurando…");
    const update = await procurarAtualizacao();
    if (!update) { dizer("Você já está na versão mais recente."); return; }
    // Quem clicou em verificar quer atualizar: nao ha segundo botao. O aviso
    // existe so para a reinicializacao nao pegar ninguem de surpresa.
    dizer("Versão " + update.version + " encontrada. Baixando… o app reinicia sozinho.");
    await instalarAtualizacao(update, texto => dizer(texto));
  } catch (error) {
    dizer("Não foi possível atualizar agora: " + (error instanceof Error ? error.message : String(error)));
  } finally { botao.disabled = false; }
});
byId("devices-button").addEventListener("click", () => void openDevicesDialog());
byId("profile-open-settings").addEventListener("click", () => { closeMiniProfile(); void openDevicesDialog(); });
byId("close-devices").addEventListener("click", () => byId<HTMLDialogElement>("devices-dialog").close());
// Fechar pelo Esc nao passa pelo botao, entao o `close` e quem para o relogio.
byId<HTMLDialogElement>("devices-dialog").addEventListener("close", () => {
  acompanharUso(false);
  pararMedidorDoDialogo();
});
byId<HTMLInputElement>("notify-sound").addEventListener("change", event => {
  localStorage.setItem(SOUND_KEY, (event.target as HTMLInputElement).checked ? "1" : "0");
});
byId<HTMLInputElement>("notify-desktop").addEventListener("change", async event => {
  const input = event.target as HTMLInputElement;
  const wanted = input.checked;
  const accepted = await setDesktopNotifications(wanted).catch(() => false);
  input.checked = wanted && accepted;
  byId("devices-note").textContent = wanted && !accepted ? "O Windows nao liberou as notificacoes." : "";
});
byId<HTMLInputElement>("notify-preview").addEventListener("change", event => setNotificationPreview((event.target as HTMLInputElement).checked));
byId<HTMLInputElement>("notify-in-call").addEventListener("change", event => setNotificationsInCall((event.target as HTMLInputElement).checked));
byId("notify-test").addEventListener("click", async () => {
  const sent = await sendTestNotification().catch(() => false);
  byId<HTMLInputElement>("notify-desktop").checked = sent;
  byId("devices-note").textContent = sent
    ? "Notificação de teste enviada."
    : "O Windows não liberou as notificações.";
});
byId("devices-refresh").addEventListener("click", () => void fillDeviceLists());

// ------------------------------------------------------- mensagens fixadas
//
// Mesmo caminho da reacao: pelo WebSocket, guardado no servidor e valendo para
// todo mundo que ve o canal. Fixar por pessoa nao serviria para o que as
// pessoas fixam — combinado de horario, endereco de servidor de jogo, regra do
// grupo.
function alternarFixada(id: string) {
  if (chat?.readyState !== WebSocket.OPEN) { showToast("Sem conexão."); return; }
  chat.send(JSON.stringify({ type: "pin", messageId: id }));
}

function abrirFixadas() {
  const dialogo = byId<HTMLDialogElement>("fixadas-dialog");
  const lista = byId("fixadas-lista");
  const vazio = byId("fixadas-vazio");
  const fixadas = history.filter(item => item.pinned && item.roomId === currentRoomId).reverse();

  vazio.classList.toggle("hidden", fixadas.length > 0);
  lista.replaceChildren(...fixadas.map(mensagem => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "busca-item";

    const topo = document.createElement("div");
    topo.className = "busca-item-topo";
    const quem = document.createElement("span");
    quem.className = "busca-item-canal";
    quem.textContent = getDisplayName(mensagem.username);
    const quando = document.createElement("span");
    quando.textContent = new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    }).format(new Date(mensagem.createdAt));
    topo.append(quem, quando);

    const texto = document.createElement("p");
    texto.className = "busca-item-texto";
    texto.textContent = mensagem.text.slice(0, 240) + (mensagem.text.length > 240 ? "…" : "");

    item.append(topo, texto);
    item.onclick = () => void irAteMensagem(mensagem);
    return item;
  }));
  dialogo.showModal();
}

byId("fixadas-abrir").addEventListener("click", abrirFixadas);
byId("fixadas-fechar").addEventListener("click", () => byId<HTMLDialogElement>("fixadas-dialog").close());

// -------------------------------------------------------- busca de mensagens
//
// Inteira no cliente, de proposito: o historico ja chega completo no `welcome`
// do WebSocket, entao procurar no servidor seria pedir de novo o que ja esta
// aqui — e a resposta sai sem ida a rede. O outro motivo pesa mais: mensagem
// privada e E2E, e o servidor nao tem como procurar no que nao consegue ler.

/// Acha o termo sem tropecar em acento nem em caixa: "acao" encontra "ação".
function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/// Trecho em volta da primeira ocorrencia, com o termo destacado.
///
/// Mostrar a mensagem inteira encheria a lista com paredes de texto; mostrar so
/// o comeco esconderia justamente a parte que casou.
function trechoDestacado(texto: string, termo: string): DocumentFragment {
  const fragmento = document.createDocumentFragment();
  const onde = normalizar(texto).indexOf(normalizar(termo));
  if (onde < 0) { fragmento.append(texto.slice(0, 160)); return fragmento; }
  const inicio = Math.max(0, onde - 45);
  const fim = Math.min(texto.length, onde + termo.length + 75);
  if (inicio > 0) fragmento.append("…");
  fragmento.append(texto.slice(inicio, onde));
  const marca = document.createElement("mark");
  marca.textContent = texto.slice(onde, onde + termo.length);
  fragmento.append(marca, texto.slice(onde + termo.length, fim));
  if (fim < texto.length) fragmento.append("…");
  return fragmento;
}

/// Leva ate a mensagem: troca de canal se precisar e pisca a linha.
async function irAteMensagem(mensagem: ChatMessage) {
  byId<HTMLDialogElement>("busca-dialog").close();
  if (mensagem.roomId !== currentRoomId) {
    const sala = rooms.find(item => item.id === mensagem.roomId);
    if (sala && sala.serverId !== currentServerId) await selectServer(sala.serverId);
    await selectRoom(mensagem.roomId);
  }
  // Depois do desenho: a linha so existe no DOM quando o canal ja foi montado.
  window.setTimeout(() => {
    const alvo = messagesEl.querySelector<HTMLElement>(
      '[data-message-id="' + CSS.escape(mensagem.id) + '"]',
    );
    if (!alvo) return;
    alvo.scrollIntoView({ block: "center", behavior: "smooth" });
    alvo.classList.remove("achada");
    // Reinicia a animacao quando a mesma mensagem e buscada duas vezes.
    void alvo.offsetWidth;
    alvo.classList.add("achada");
  }, 60);
}

function rodarBusca() {
  const termo = byId<HTMLInputElement>("busca-campo").value.trim();
  const soCanal = byId<HTMLInputElement>("busca-so-canal").checked;
  const lista = byId("busca-resultados");
  const resumo = byId("busca-resumo");

  if (termo.length < 2) {
    lista.replaceChildren();
    resumo.textContent = "Escreva pelo menos duas letras.";
    return;
  }

  const alvo = normalizar(termo);
  // Do mais recente para o mais antigo: procurar algo dito "outro dia" e o uso
  // comum, e o que se procura quase nunca esta no comeco do canal.
  const achados = history
    .filter(item => (!soCanal || item.roomId === currentRoomId) && normalizar(item.text).includes(alvo))
    .reverse()
    .slice(0, 80);

  resumo.textContent = achados.length
    ? achados.length + (achados.length === 1 ? " mensagem" : " mensagens")
      + (achados.length === 80 ? " (mostrando as 80 mais recentes)" : "")
    : "Nada encontrado.";

  lista.replaceChildren(...achados.map(mensagem => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "busca-item";

    const topo = document.createElement("div");
    topo.className = "busca-item-topo";
    const canal = document.createElement("span");
    canal.className = "busca-item-canal";
    canal.textContent = "#" + (rooms.find(sala => sala.id === mensagem.roomId)?.name || "canal");
    const quem = document.createElement("span");
    quem.textContent = getDisplayName(mensagem.username);
    const quando = document.createElement("span");
    quando.textContent = new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    }).format(new Date(mensagem.createdAt));
    topo.append(canal, quem, quando);

    const texto = document.createElement("p");
    texto.className = "busca-item-texto";
    texto.append(trechoDestacado(mensagem.text, termo));

    item.append(topo, texto);
    item.onclick = () => void irAteMensagem(mensagem);
    return item;
  }));
}

function abrirBusca() {
  const dialogo = byId<HTMLDialogElement>("busca-dialog");
  if (dialogo.open) return;
  byId<HTMLInputElement>("busca-so-canal").checked = false;
  dialogo.showModal();
  const campo = byId<HTMLInputElement>("busca-campo");
  campo.select();
  rodarBusca();
}

byId("busca-abrir").addEventListener("click", abrirBusca);
byId("busca-fechar").addEventListener("click", () => byId<HTMLDialogElement>("busca-dialog").close());
byId<HTMLInputElement>("busca-campo").addEventListener("input", rodarBusca);
byId<HTMLInputElement>("busca-so-canal").addEventListener("change", rodarBusca);
// Ctrl+F e o gesto que a pessoa ja tem no dedo. O do WebView2 procuraria no
// que esta desenhado na tela, que e so o canal aberto e so o pedaco visivel.
window.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
    event.preventDefault();
    abrirBusca();
  }
});

// ------------------------------------------------- configuracoes por secao
//
// Um dialogo so, com nome proprio para cada assunto. Antes tudo morava numa
// coluna unica chamada "Audio, video e notificacoes", e achar um ajuste era
// rolagem as cegas.
for (const aba of document.querySelectorAll<HTMLButtonElement>(".config-tab")) {
  aba.addEventListener("click", () => {
    const alvo = aba.dataset.pane || "";
    for (const outra of document.querySelectorAll(".config-tab")) {
      outra.classList.toggle("ativo", outra === aba);
    }
    for (const painel of document.querySelectorAll<HTMLElement>(".config-pane")) {
      painel.classList.toggle("ativo", painel.dataset.pane === alvo);
    }
    // O medidor so vale na aba onde ele aparece: segurar o microfone aberto
    // enquanto a pessoa le a aba de notificacoes seria pedir acesso a toa.
    if (alvo === "voz") void ligarMedidorDoDialogo();
    else pararMedidorDoDialogo();
  });
}

// ------------------------------------------------------ medidor do dialogo
//
// Separado do medidor do portao: aquele le a faixa que ja esta no ar, este
// precisa funcionar fora da chamada, que e justamente quando a pessoa vai
// conferir se o microfone escolhido funciona.
let pararMedidorLocal: (() => void) | null = null;
let fluxoDoMedidor: MediaStream | null = null;

function pararMedidorDoDialogo() {
  pararMedidorLocal?.();
  pararMedidorLocal = null;
  // Soltar o microfone: sem isto o Windows mantem o aviso de "em uso" e a luz
  // da webcam vizinha de alguns notebooks fica acesa.
  fluxoDoMedidor?.getTracks().forEach(faixa => faixa.stop());
  fluxoDoMedidor = null;
  byId("mic-meter-fill").style.width = "0%";
}

async function ligarMedidorDoDialogo() {
  pararMedidorDoDialogo();
  const barra = byId("mic-meter");
  const preenchimento = byId("mic-meter-fill");
  const nota = byId("mic-meter-nota");

  // Em chamada, mede a propria faixa publicada — e o que os outros ouvem, e
  // nao um segundo microfone aberto em paralelo.
  let faixa = room?.localParticipant.audioTrackPublications.values().next().value
    ?.track?.mediaStreamTrack;
  if (!faixa) {
    try {
      fluxoDoMedidor = await navigator.mediaDevices.getUserMedia({
        audio: voz.opcoesDeCaptura(readDevices().mic),
      });
      faixa = fluxoDoMedidor.getAudioTracks()[0];
    } catch {
      nota.textContent = "O Windows não liberou o microfone para o teste.";
      return;
    }
  }
  if (!faixa) return;
  nota.textContent = "Fale para ver o nível. A marca clara é o ponto em que o microfone abre.";
  pararMedidorLocal = voz.medir(faixa, nivel => {
    preenchimento.style.width = nivel + "%";
    // Fora da ativacao por voz nao ha "fechado": o microfone vai inteiro.
    const porVoz = voz.lerModo() === "voz";
    barra.classList.toggle("fechado", porVoz && nivel < voz.lerLimiar());
  });
}

/// Poe a marca do limiar sobre a barra e mostra o controle so quando ele vale.
function pintarLimiar() {
  const limiar = voz.lerLimiar();
  byId("mic-meter-limiar").style.left = limiar + "%";
  const porVoz = voz.lerModo() === "voz";
  byId("voz-limiar-linha").classList.toggle("hidden", !porVoz);
  byId("mic-meter-limiar").classList.toggle("hidden", !porVoz);
}

byId<HTMLSelectElement>("voz-modo").addEventListener("change", event => {
  voz.guardarModo((event.currentTarget as HTMLSelectElement).value as voz.ModoVoz);
  pintarLimiar();
  reiniciarPortao();
  void registrarAtalhos();
});
byId<HTMLInputElement>("voz-limiar").addEventListener("input", event => {
  voz.guardarLimiar(Number((event.currentTarget as HTMLInputElement).value));
  pintarLimiar();
});
for (const [id, chave] of [["filtro-ruido", "ruido"], ["filtro-eco", "eco"], ["filtro-ganho", "ganho"]] as const) {
  byId<HTMLInputElement>(id).addEventListener("change", event => {
    voz.guardarFiltros({
      ...voz.lerFiltros(),
      [chave]: (event.currentTarget as HTMLInputElement).checked,
    });
    showToast("Vale no próximo microfone aberto.");
  });
}

// --------------------------------------------------------- atalhos globais
//
// Global de verdade: o plugin do Tauri registra no Windows, entao a tecla vale
// com o jogo em primeiro plano. E o unico jeito de push-to-talk servir para
// alguma coisa — atalho de pagina exigiria a janela em foco, que e justamente
// onde a pessoa nao esta.
type Acao = "ptt" | "mudo" | "surdo";
const ATALHO_KEY = "naoconcordo.atalhos";

function lerAtalhos(): Record<Acao, string> {
  try {
    const bruto = JSON.parse(localStorage.getItem(ATALHO_KEY) || "null") as Partial<Record<Acao, string>> | null;
    return { ptt: bruto?.ptt || "", mudo: bruto?.mudo || "", surdo: bruto?.surdo || "" };
  } catch {
    return { ptt: "", mudo: "", surdo: "" };
  }
}
function guardarAtalhos(atalhos: Record<Acao, string>) {
  localStorage.setItem(ATALHO_KEY, JSON.stringify(atalhos));
}

/// Le uma combinacao de tecla no formato que o Tauri entende.
///
/// Devolve `null` para tecla que so faz sentido acompanhada — apertar Shift
/// sozinho enquanto se escolhe o atalho e acidente, nao escolha.
function combinacaoDe(evento: KeyboardEvent): string | null {
  const partes: string[] = [];
  if (evento.ctrlKey) partes.push("Control");
  if (evento.altKey) partes.push("Alt");
  if (evento.shiftKey) partes.push("Shift");
  if (evento.metaKey) partes.push("Super");
  const tecla = evento.key;
  if (["Control", "Alt", "Shift", "Meta"].includes(tecla)) return null;
  if (tecla === " ") partes.push("Space");
  else if (tecla.length === 1) partes.push(tecla.toUpperCase());
  else partes.push(tecla);
  return partes.join("+");
}

function pintarAtalhos() {
  const atalhos = lerAtalhos();
  for (const botao of document.querySelectorAll<HTMLButtonElement>("[data-atalho]")) {
    const acao = botao.dataset.atalho as Acao;
    botao.textContent = atalhos[acao] || "—";
  }
}

for (const botao of document.querySelectorAll<HTMLButtonElement>("[data-atalho]")) {
  botao.addEventListener("click", () => {
    const acao = botao.dataset.atalho as Acao;
    botao.classList.add("gravando");
    botao.textContent = "aperte a tecla...";
    const ler = (evento: KeyboardEvent) => {
      evento.preventDefault();
      evento.stopPropagation();
      if (evento.key === "Escape") { fim(); return; }
      const atalhos = lerAtalhos();
      if (evento.key === "Delete" || evento.key === "Backspace") {
        atalhos[acao] = "";
        guardarAtalhos(atalhos);
        void registrarAtalhos();
        fim();
        return;
      }
      const combinacao = combinacaoDe(evento);
      if (!combinacao) return;
      atalhos[acao] = combinacao;
      guardarAtalhos(atalhos);
      void registrarAtalhos();
      fim();
    };
    const fim = () => {
      window.removeEventListener("keydown", ler, true);
      botao.classList.remove("gravando");
      pintarAtalhos();
    };
    window.addEventListener("keydown", ler, true);
  });
}

/// Registra no Windows o que esta guardado, trocando o que havia antes.
///
/// O push-to-talk precisa dos dois lados da tecla, e nao so do toque: quem
/// segura fala, quem solta cala. O plugin entrega `Pressed` e `Released`
/// separados, entao da para tratar como botao de radio amador.
async function registrarAtalhos() {
  if (!ehTauri()) return;
  try {
    const plugin = await import("@tauri-apps/plugin-global-shortcut");
    await plugin.unregisterAll();
    const atalhos = lerAtalhos();

    if (atalhos.ptt && voz.lerModo() === "ptt") {
      await plugin.register(atalhos.ptt, evento => {
        const pressionado = evento.state === "Pressed";
        if (pressionado === pttPressionado) return;
        pttPressionado = pressionado;
        portaoAberto = pressionado;
        aplicarPortao();
      });
    }
    if (atalhos.mudo) {
      await plugin.register(atalhos.mudo, evento => {
        if (evento.state !== "Pressed") return;
        void definirMicrofone(!micEnabled);
      });
    }
    if (atalhos.surdo) {
      await plugin.register(atalhos.surdo, evento => {
        if (evento.state !== "Pressed") return;
        audioButton.click();
      });
    }
  } catch (erro) {
    // Tecla ja tomada por outro programa e o caso comum, e nao e culpa nossa.
    showToast("Não foi possível registrar um dos atalhos: " + String(erro));
  }
}

/// Poe os controles de voz no estado guardado. Chamado ao abrir o dialogo.
function pintarConfiguracoesDeVoz() {
  byId<HTMLSelectElement>("voz-modo").value = voz.lerModo();
  byId<HTMLInputElement>("voz-limiar").value = String(voz.lerLimiar());
  const filtros = voz.lerFiltros();
  byId<HTMLInputElement>("filtro-ruido").checked = filtros.ruido;
  byId<HTMLInputElement>("filtro-eco").checked = filtros.eco;
  byId<HTMLInputElement>("filtro-ganho").checked = filtros.ganho;
  pintarLimiar();
  pintarAtalhos();
}
byId<HTMLSelectElement>("device-mic").addEventListener("change", event => void applyDevice("audioinput", (event.target as HTMLSelectElement).value));
byId<HTMLSelectElement>("device-cam").addEventListener("change", event => void applyDevice("videoinput", (event.target as HTMLSelectElement).value));
byId<HTMLSelectElement>("device-out").addEventListener("change", event => void applyDevice("audiooutput", (event.target as HTMLSelectElement).value));
navigator.mediaDevices?.addEventListener("devicechange", () => { if (byId<HTMLDialogElement>("devices-dialog").open) void fillDeviceLists(); });
function attachVideo(track: { sid?: string; attach: () => HTMLMediaElement }, labelText: string, muted = false) {
  if (!track.sid || document.getElementById("track-" + track.sid)) return;
  const tile = document.createElement("div");
  tile.id = "track-" + track.sid;
  tile.className = "track-tile";
  const media = track.attach();
  if (media instanceof HTMLVideoElement) { media.autoplay = true; media.playsInline = true; media.muted = muted; }
  const label = document.createElement("label");
  label.textContent = labelText;

  // Tres tamanhos: normal na grade, grande ocupando o painel, e tela cheia.
  const bigger = document.createElement("button");
  bigger.className = "tile-action";
  bigger.title = "Alternar tamanho grande";
  bigger.append(icon("theater", "ic-sm"));
  bigger.onclick = event => { event.stopPropagation(); toggleTheater(tile); };
  const full = document.createElement("button");
  full.className = "tile-action";
  full.title = "Tela cheia";
  full.append(icon("full", "ic-sm"));
  full.onclick = event => { event.stopPropagation(); void toggleFullscreen(tile); };
  const parar = document.createElement("button");
  parar.className = "tile-action";
  parar.title = "Parar de assistir";
  parar.textContent = "✕";
  parar.onclick = event => { event.stopPropagation(); pararDeAssistir(track.sid!, labelText); };
  tile.ondblclick = () => void toggleFullscreen(tile);
  // Botao direito na propria transmissao: e onde a mao ja esta quando o volume
  // incomoda, entao o controle tem de estar aqui tambem, nao so na lista.
  tile.oncontextmenu = event => {
    event.preventDefault();
    event.stopPropagation();
    openUserMenu(labelText, tile, { x: event.clientX, y: event.clientY });
  };

  tile.append(media, label, parar, bigger, full);
  stage.append(tile);
  // Quem decide se isso aparece no painel ou vai para a janela separada e o
  // `syncStagePlacement`: mostrar aqui direto era o que fazia a transmissao de
  // um servidor continuar na tela de outro.
  syncStagePlacement();
}

/// Poe o palco de acordo com `tileGrande`. Chamar depois de qualquer mexida no
/// palco; a tile que sumiu desliga o modo grande sozinha.
function aplicarTeatro() {
  if (tileGrande && !stage.querySelector("#" + CSS.escape(tileGrande))) tileGrande = "";
  if (tileCheia && !stage.querySelector("#" + CSS.escape(tileCheia))) {
    tileCheia = "";
    // Sem nada para mostrar, a tela cheia perdeu o motivo de existir.
    if (document.fullscreenElement === stage) void document.exitFullscreen();
  }
  for (const tile of stage.querySelectorAll(".track-tile")) {
    tile.classList.toggle("theater", tile.id === tileGrande);
    tile.classList.toggle("cheia", tile.id === tileCheia);
  }
  const ligado = Boolean(tileGrande);
  stage.classList.toggle("has-theater", ligado);
  // No modo grande o chat encolhe para uma faixa embaixo e a tela fica com o resto.
  byId("app-view").querySelector(".main-panel")?.classList.toggle("theater-mode", ligado);
}

/// Modo grande: o compartilhamento domina o painel, sem virar tela cheia.
function toggleTheater(tile: HTMLElement) {
  tileGrande = tile.classList.contains("theater") ? "" : tile.id;
  aplicarTeatro();
}
/// Cartao no lugar da transmissao, com o botao que comeca a assistir. A faixa
/// so e assinada quando a pessoa clica: ate la nao entra video nenhum.
function offerScreen(sid: string, who: string) {
  if (document.getElementById("track-" + sid) || document.getElementById("oferta-" + sid)) return;
  const card = document.createElement("div");
  card.id = "oferta-" + sid;
  card.className = "track-tile oferta";
  const titulo = document.createElement("span");
  titulo.className = "oferta-nome";
  titulo.textContent = who + " está compartilhando a tela";
  const botao = document.createElement("button");
  botao.type = "button";
  botao.className = "primary small";
  botao.textContent = "Assistir";
  botao.onclick = () => { assistindo.add(sid); anunciarAssistindo(); setSubscribedScreen(sid, true); card.remove(); syncStagePlacement(); };
  card.append(titulo, botao);
  stage.append(card);
  syncStagePlacement();
}
/// Assina ou cancela a assinatura de uma transmissao especifica.
///
/// O som acompanha a imagem: e o mesmo participante de tela, numa faixa
/// separada. Mexer so no video deixava a transmissao muda ao aceitar e o som
/// tocando sozinho ao recusar.
function setSubscribedScreen(sid: string, ativo: boolean) {
  if (!room) return;
  for (const participant of room.remoteParticipants.values()) {
    const publicacoes = [...participant.trackPublications.values()];
    if (!publicacoes.some(item => item.source === Track.Source.ScreenShare && item.trackSid === sid)) continue;
    for (const publication of publicacoes) {
      if (publication.source === Track.Source.ScreenShare && publication.trackSid !== sid) continue;
      if (publication.source !== Track.Source.ScreenShare && publication.source !== Track.Source.ScreenShareAudio) continue;
      void publication.setSubscribed(ativo);
    }
  }
}
/// Para de assistir: solta a faixa e devolve o cartao com o botao.
function pararDeAssistir(sid: string, who: string) {
  assistindo.delete(sid);
  anunciarAssistindo();
  setSubscribedScreen(sid, false);
  detachTrack(sid);
  offerScreen(sid, who);
}
/// Tela cheia no `stage`, e nao na tile.
///
/// Em tela cheia o navegador so desenha o elemento em tela cheia e os
/// descendentes dele. A barra de chamada e `position: fixed` no corpo da
/// pagina, entao sumia — junto com o botao de desconectar e o de mudo, bem na
/// hora em que mais se precisa deles. A barra precisa entrar no elemento.
///
/// Ela vai para o `stage` porque a tile **e destruida** a cada
/// `stage.replaceChildren()` (trocar de transmissao, abrir a janela separada,
/// sair da chamada). Quando a barra morava dentro da tile, ia embora junto e
/// nunca mais voltava. O `stage` sobrevive a tudo isso.
async function toggleFullscreen(tile: HTMLElement) {
  try {
    if (document.fullscreenElement) { await document.exitFullscreen(); return; }
    tileCheia = tile.id;
    aplicarTeatro();
    await stage.requestFullscreen();
  } catch { showToast("A tela cheia foi bloqueada."); }
}
/// Devolve a barra de chamada ao lugar. Chamada antes de qualquer limpeza do
/// `stage`: sem isso a barra seria apagada junto com as tiles.
function restaurarControles() {
  const app = byId("app-view");
  // A caixa de diagnostico cai na mesma armadilha da barra: dentro do `stage`
  // ela seria apagada pelo `replaceChildren` e nunca mais voltaria.
  for (const id of ["call-controls", "diag-box"]) {
    const elemento = byId(id);
    if (elemento.parentElement !== app) app.append(elemento);
  }
}
/// Esconde a interface quando o mouse para, em tela cheia.
///
/// Sem isto a barra de chamada, a caixa de diagnostico e os botoes da tile
/// ficam por cima do video para sempre — em tela cheia eles sao forcados a
/// aparecer, porque sem hover nao haveria como sair. O relogio devolve o meio
/// termo: continuam alcancaveis, mas nao moram na frente da imagem.
let ociosoTimer = 0;
function acordarControles() {
  window.clearTimeout(ociosoTimer);
  stage.classList.remove("ocioso");
  if (document.fullscreenElement !== stage) return;
  ociosoTimer = window.setTimeout(() => {
    // Conferido de novo na hora: a pessoa pode ter saido da tela cheia entre o
    // ultimo movimento e agora.
    if (document.fullscreenElement === stage) stage.classList.add("ocioso");
  }, 2500);
}

document.addEventListener("fullscreenchange", () => {
  if (document.fullscreenElement === stage) {
    stage.classList.add("tela-cheia");
    stage.append(byId("call-controls"), byId("diag-box"));
    stage.addEventListener("mousemove", acordarControles);
    stage.addEventListener("mousedown", acordarControles);
    stage.addEventListener("wheel", acordarControles, { passive: true });
    acordarControles();
  } else {
    window.clearTimeout(ociosoTimer);
    stage.classList.remove("ocioso");
    stage.removeEventListener("mousemove", acordarControles);
    stage.removeEventListener("mousedown", acordarControles);
    stage.removeEventListener("wheel", acordarControles);
    stage.classList.remove("tela-cheia");
    tileCheia = "";
    aplicarTeatro();
    restaurarControles();
  }
});
function detachTrack(sid?: string) {
  if (!sid) return;
  document.getElementById("track-" + sid)?.remove();
  document.getElementById("audio-" + sid)?.remove();
  // `syncStagePlacement` reconcilia o modo grande e a visibilidade do palco:
  // sair daqui na mao era o que deixava o palco em modo grande com a tile
  // grande ja removida.
  syncStagePlacement();
}




// --------------------------------------------------------------- links
// Link de midia toca direto da origem: nada e baixado para o servidor.
// Em troca, abrir o conteudo revela seu IP para o site de origem.
const RE_URL = /https?:\/\/[^\s<>"']+/g;
const ehImagem = (url: string) => /\.(png|jpe?g|gif|webp|avif)(\?|#|$)/i.test(url);
const ehVideo = (url: string) => /\.(mp4|webm|mov)(\?|#|$)/i.test(url);
const ehAudio = (url: string) => /\.(mp3|ogg|wav|m4a)(\?|#|$)/i.test(url);

/// Endereco de player para links que sao pagina, nao arquivo.
///
/// YouTube e Twitch nao terminam em `.mp4`, entao o teste por extensao nunca
/// os pega. A alternativa seria o servidor baixar a pagina e ler as marcas
/// `og:` — funcionaria em qualquer site, mas faria o servidor buscar uma URL
/// escolhida por quem escreveu a mensagem. Enquanto forem esses dois sites,
/// montar o endereco aqui resolve sem abrir essa porta.
///
/// Devolve `null` quando o link nao e de nenhum player conhecido.
function playerDoLink(url: string): string | null {
  let endereco: URL;
  try { endereco = new URL(url); } catch { return null; }
  const host = endereco.hostname.replace(/^www\./, "");

  // `youtube-nocookie` para o player nao plantar cookie de rastreio de quem
  // so passou os olhos na mensagem.
  if (host === "youtu.be") {
    const id = endereco.pathname.slice(1);
    return ID_YOUTUBE.test(id) ? "https://www.youtube-nocookie.com/embed/" + id : null;
  }
  if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
    const id = endereco.pathname.startsWith("/shorts/")
      ? endereco.pathname.slice("/shorts/".length)
      : endereco.searchParams.get("v") || "";
    return ID_YOUTUBE.test(id) ? "https://www.youtube-nocookie.com/embed/" + id : null;
  }
  if (host === "twitch.tv") {
    const partes = endereco.pathname.split("/").filter(Boolean);
    // O player da Twitch exige o dominio de quem embute na propria URL.
    if (partes[0] === "videos" && /^\d+$/.test(partes[1] || "")) {
      return "https://player.twitch.tv/?video=" + partes[1] + "&parent=" + PARENT_TWITCH + "&autoplay=false";
    }
    if (partes.length === 1 && /^[\w]{2,30}$/.test(partes[0]) && !PAGINAS_TWITCH.has(partes[0])) {
      return "https://player.twitch.tv/?channel=" + partes[0] + "&parent=" + PARENT_TWITCH + "&autoplay=false";
    }
  }
  return null;
}
const ID_YOUTUBE = /^[\w-]{11}$/;
// Caminhos de um segmento que sao pagina do site, nao canal de alguem.
const PAGINAS_TWITCH = new Set(["directory", "settings", "downloads", "store", "subscriptions", "wallet", "p"]);
// O aplicativo roda em `tauri.localhost`, e e esse nome que a Twitch confere.
const PARENT_TWITCH = location.hostname || "tauri.localhost";

/// Texto da mensagem com links, formatacao simples e mencoes.
///
/// Sem `innerHTML` em nenhum ponto: cada pedaco entra como no de texto, entao
/// nada que a pessoa escrever vira marcacao. Um unico percurso resolve tudo —
/// varrer o texto uma vez por recurso deixaria os recursos se comendo, com
/// negrito dentro de URL e mencao dentro de bloco de codigo.
const RE_RICO =
  /(https?:\/\/[^\s<>"']+)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|\|\|([^|\n]+)\|\||(?<![\w.@])@([\w.-]{2,32})/g;

function renderText(texto: string) {
  const paragrafo = document.createElement("p");
  let ultimo = 0;
  for (const achado of texto.matchAll(RE_RICO)) {
    const inicio = achado.index ?? 0;
    if (inicio > ultimo) paragrafo.append(document.createTextNode(texto.slice(ultimo, inicio)));
    paragrafo.append(pedacoRico(achado));
    ultimo = inicio + achado[0].length;
  }
  if (ultimo < texto.length) paragrafo.append(document.createTextNode(texto.slice(ultimo)));
  return paragrafo;
}

function pedacoRico(achado: RegExpMatchArray): Node {
  const [inteiro, link, codigo, negrito, italico, spoiler, mencao] = achado;

  if (link) {
    const a = document.createElement("a");
    a.className = "chat-link";
    a.textContent = link;
    a.href = "#";
    a.onclick = evento => {
      evento.preventDefault();
      void abrirExterno(link).catch(() => showToast("Nao foi possivel abrir o link."));
    };
    return a;
  }
  if (codigo !== undefined) {
    const el = document.createElement("code");
    el.className = "chat-codigo";
    el.textContent = codigo;
    return el;
  }
  if (negrito !== undefined) {
    const el = document.createElement("strong");
    el.textContent = negrito;
    return el;
  }
  if (italico !== undefined) {
    const el = document.createElement("em");
    el.textContent = italico;
    return el;
  }
  if (spoiler !== undefined) {
    const el = document.createElement("span");
    el.className = "spoiler";
    el.textContent = spoiler;
    el.title = "Clique para revelar";
    el.onclick = () => el.classList.add("revelado");
    return el;
  }
  if (mencao !== undefined) {
    const el = document.createElement("span");
    el.className = "mencao";
    el.textContent = "@" + getDisplayName(mencao);
    // A propria mencao fica destacada: e o que faz a pessoa achar a mensagem
    // ao rolar a conversa.
    if (key(mencao) === key(session?.username || "")) el.classList.add("mencao-eu");
    return el;
  }
  return document.createTextNode(inteiro);
}

/// A mensagem cita esta pessoa?
function mencionaVoce(texto: string): boolean {
  const eu = key(session?.username || "");
  if (!eu) return false;
  for (const achado of texto.matchAll(RE_RICO)) {
    if (achado[6] && key(achado[6]) === eu) return true;
  }
  return false;
}

/// Abre a imagem grande por cima de tudo.
///
/// `window.open` mandava para uma janela do WebView2 sem controle nenhum: sem
/// fechar com Esc e fora da janela do aplicativo.
function abrirImagem(url: string, alt = "") {
  const fundo = document.createElement("div");
  fundo.className = "lightbox";

  const img = document.createElement("img");
  img.src = url;
  img.alt = alt;

  const fechar = document.createElement("button");
  fechar.type = "button";
  fechar.className = "lightbox-close";
  fechar.setAttribute("aria-label", "Fechar");
  fechar.textContent = "×";

  const sair = () => {
    fundo.remove();
    document.removeEventListener("keydown", tecla);
  };
  const tecla = (evento: KeyboardEvent) => { if (evento.key === "Escape") sair(); };

  // Clicar na propria imagem nao fecha: e o gesto de quem quer olhar de perto.
  fundo.onclick = evento => { if (evento.target === fundo) sair(); };
  fechar.onclick = sair;
  document.addEventListener("keydown", tecla);

  fundo.append(img, fechar);
  // Em tela cheia so o elemento em tela cheia e desenhado, entao o visualizador
  // precisa entrar dentro dele.
  (document.fullscreenElement || document.body).append(fundo);
}

/// Mostra a midia dos links, sem passar pelo servidor.
function renderLinkEmbeds(texto: string, into: HTMLElement) {
  const vistos = new Set<string>();
  for (const achado of texto.matchAll(RE_URL)) {
    const url = achado[0];
    if (vistos.has(url)) continue;
    vistos.add(url);
    if (vistos.size > 3) break;
    const box = document.createElement("div");
    box.className = "attachment";
    if (ehImagem(url)) {
      const img = document.createElement("img");
      img.src = url; img.loading = "lazy"; img.alt = "";
      img.onerror = () => box.remove();
      img.onclick = () => abrirImagem(url);
      box.append(img);
    } else if (ehVideo(url)) {
      const video = document.createElement("video");
      video.src = url; video.controls = true; video.preload = "metadata";
      video.onerror = () => box.remove();
      box.append(video);
    } else if (ehAudio(url)) {
      const audio = document.createElement("audio");
      audio.src = url; audio.controls = true;
      audio.onerror = () => box.remove();
      box.append(audio);
    } else {
      const player = playerDoLink(url);
      if (!player) continue;
      box.classList.add("embed-player");
      const quadro = document.createElement("iframe");
      quadro.src = player;
      quadro.loading = "lazy";
      quadro.allow = "encrypted-media; picture-in-picture; fullscreen";
      // Sem `allow-same-origin`: o player nao enxerga nada desta janela.
      quadro.referrerPolicy = "no-referrer";
      // Escape: quando o player recusa carregar — a Twitch confere o dominio de
      // quem embute, e `tauri.localhost` nao e um que ela aceite — sobra pelo
      // menos um jeito de assistir.
      const fora = document.createElement("button");
      fora.type = "button";
      fora.className = "embed-fora";
      fora.textContent = "abrir no navegador";
      fora.onclick = () => void abrirExterno(url).catch(() => showToast("Nao foi possivel abrir o link."));
      box.append(quadro, fora);
    }
    into.append(box);
  }
}

// ------------------------------------------------------------- arquivos
// Os bytes vao crus no corpo: multipart e base64 so aumentariam o tamanho.
const MAX_UPLOAD = 50 * 1024 * 1024;
let pendingFiles: StoredFile[] = [];
const blobCache = new Map<string, string>();

async function uploadFile(file: File): Promise<StoredFile> {
  if (file.size > MAX_UPLOAD) throw new Error(file.name + " passa de 50 MB.");
  const response = await fetch(API + "/api/files", {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name).replace(/%20/g, " "),
      Authorization: "Bearer " + (session?.token || ""),
    },
    body: file,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "Falha no envio." })) as { error?: string };
    throw new Error(body.error || "Falha no envio.");
  }
  return response.json() as Promise<StoredFile>;
}

/// Busca autenticada e vira blob: <img src> nao manda cabecalho.
async function fileUrl(id: string): Promise<string> {
  const pronto = blobCache.get(id);
  if (pronto) return pronto;
  const response = await fetch(API + "/api/files/" + encodeURIComponent(id), {
    headers: { Authorization: "Bearer " + (session?.token || "") },
  });
  if (!response.ok) throw new Error("Arquivo indisponível.");
  const url = URL.createObjectURL(await response.blob());
  blobCache.set(id, url);
  return url;
}

/// Canal e PV compartilham a fila de anexos, entao os dois previews desenham.
function renderAttachPreview() {
  for (const id of ["attach-preview", "dm-attach-preview"]) {
    const box = byId(id);
    box.classList.toggle("hidden", pendingFiles.length === 0);
    box.replaceChildren(...pendingFiles.map(file => {
      const chip = document.createElement("span");
      chip.className = "attach-chip";
      chip.textContent = file.name + " (" + Math.round(file.size / 1024) + " KB)";
      const remove = document.createElement("button");
      remove.type = "button"; remove.textContent = "×";
      remove.onclick = () => { pendingFiles = pendingFiles.filter(item => item.id !== file.id); renderAttachPreview(); };
      chip.append(remove);
      return chip;
    }));
  }
}
async function queueFiles(list: FileList | File[]) {
  for (const file of Array.from(list).slice(0, 6)) {
    try {
      const stored = await uploadFile(file);
      if (!pendingFiles.some(item => item.id === stored.id)) pendingFiles.push(stored);
      renderAttachPreview();
    } catch (error) { showToast(error instanceof Error ? error.message : "Falha no envio."); }
  }
}
byId("attach-button").addEventListener("click", () => byId<HTMLInputElement>("attach-input").click());
byId("dm-attach-button").addEventListener("click", () => byId<HTMLInputElement>("attach-input").click());
byId<HTMLInputElement>("attach-input").addEventListener("change", async event => {
  const input = event.currentTarget as HTMLInputElement;
  if (input.files) await queueFiles(input.files);
  input.value = "";
});
// Arrastar para a janela e colar da area de transferencia.
document.addEventListener("dragover", event => { event.preventDefault(); });
document.addEventListener("drop", async event => {
  event.preventDefault();
  if (!event.dataTransfer?.files.length) return;
  await queueFiles(event.dataTransfer.files);
});
for (const campo of [messageInput, dmInput]) {
  campo.addEventListener("paste", async event => {
    const arquivos = Array.from(event.clipboardData?.files || []);
    if (arquivos.length) { event.preventDefault(); await queueFiles(arquivos); }
  });
}

/// Desenha os anexos de uma mensagem: imagem e video aparecem, o resto vira link.
function renderAttachments(message: { attachments?: StoredFile[] }, into: HTMLElement) {
  for (const file of message.attachments || []) {
    const box = document.createElement("div");
    box.className = "attachment";
    if (file.mime.startsWith("image/")) {
      const img = document.createElement("img");
      img.alt = file.name; img.loading = "lazy";
      void fileUrl(file.id).then(url => { img.src = url; }).catch(() => { box.textContent = "(falhou ao carregar)"; });
      img.onclick = () => void fileUrl(file.id).then(url => abrirImagem(url, file.name));
      box.append(img);
    } else if (file.mime.startsWith("video/")) {
      const video = document.createElement("video");
      video.controls = true; video.preload = "metadata";
      void fileUrl(file.id).then(url => { video.src = url; }).catch(() => { box.textContent = "(falhou ao carregar)"; });
      box.append(video);
    } else if (file.mime.startsWith("audio/")) {
      const audio = document.createElement("audio");
      audio.controls = true;
      void fileUrl(file.id).then(url => { audio.src = url; }).catch(() => { box.textContent = "(falhou)"; });
      box.append(audio);
    } else {
      const link = document.createElement("button");
      link.className = "attach-file"; link.type = "button";
      link.append(icon("download", "ic-sm"), document.createTextNode(file.name));
      // Mesmo motivo do link de texto: `window.open` nao sai daqui. Como o
      // arquivo ja e um blob local, um ancora com `download` baixa direto, com
      // o nome certo, sem passar pelo navegador.
      link.onclick = () => void fileUrl(file.id).then(url => {
        const baixar = document.createElement("a");
        baixar.href = url;
        baixar.download = file.name;
        baixar.click();
      }).catch(() => showToast("Nao foi possivel abrir o arquivo."));
      box.append(link);
    }
    into.append(box);
  }
}

// ------------------------------------------------------- avisos de mensagem
// Canais com mensagem nova desde a ultima vez que voce olhou.
const unreadRooms = new Map<string, number>();
const SOUND_KEY = "naoconcordo.som";
const soundOn = () => localStorage.getItem(SOUND_KEY) !== "0";

/// Bipe curto gerado na hora: evita carregar arquivo de audio no bundle.
function playPing() {
  if (!soundOn()) return;
  try {
    const context = new AudioContext();
    const now = context.currentTime;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    gain.connect(context.destination);
    for (const [freq, at] of [[880, 0], [1320, 0.09]] as [number, number][]) {
      const osc = context.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + at);
      osc.connect(gain);
      osc.start(now + at);
      osc.stop(now + at + 0.12);
    }
    window.setTimeout(() => void context.close(), 600);
  } catch { /* sem audio disponivel */ }
}

/// Toca uma sequencia curta de notas. Senoide pura, sem ataque brusco: o que
/// assusta num aviso e a subida instantanea, nao o volume em si.
function playChime(notes: [number, number][], peak: number, wave: OscillatorType = "sine") {
  if (!soundOn()) return;
  try {
    const context = new AudioContext();
    const now = context.currentTime;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
    gain.connect(context.destination);
    for (const [freq, at] of notes) {
      const osc = context.createOscillator();
      osc.type = wave;
      osc.frequency.setValueAtTime(freq, now + at);
      osc.connect(gain);
      osc.start(now + at);
      osc.stop(now + at + 0.3);
    }
    window.setTimeout(() => void context.close(), 900);
  } catch { /* sem audio disponivel */ }
}
// Subindo para entrar, descendo para sair: da para saber o que aconteceu sem
// olhar a tela. Do e Mi, que combinam entre si em qualquer ordem.
const playJoin = () => playChime([[523.25, 0], [659.25, 0.12]], 0.1);
const playLeave = () => playChime([[659.25, 0], [523.25, 0.12]], 0.1);
// Transmissao usa onda triangular e um intervalo maior: com quatro avisos na
// mesma chamada, timbre separa melhor que melodia.
const playShareOn = () => playChime([[440, 0], [659.25, 0.13]], 0.09, "triangle");
const playShareOff = () => playChime([[659.25, 0], [440, 0.13]], 0.09, "triangle");

/// Quem esta com a tela no ar, por publicacao. Guardar isto evita tocar duas
/// vezes: ao sair da sala chegam o fim da faixa e a saida do participante, e os
/// dois caminhos levariam ao mesmo aviso.
const sharingNow = new Set<string>();

function noteShareStarted(sid: string) {
  if (!sid || sharingNow.has(sid)) return;
  sharingNow.add(sid);
  playShareOn();
}
function noteShareStopped(sid: string) {
  if (!sid || !sharingNow.delete(sid)) return;
  playShareOff();
}

let quietUntil = 0;
const silenciarAvisos = (ms: number) => { quietUntil = Date.now() + ms; };
const avisosLiberados = () => Date.now() >= quietUntil;

/// A captura de tela entra na sala como participante propria. Sem isto, cada
/// compartilhamento tocaria o som de "alguem entrou".
function isScreenParticipant(participant: { identity: string; metadata?: string }): boolean {
  try {
    if (JSON.parse(participant.metadata || "{}").kind === "screen") return true;
  } catch { /* metadata vazio ou invalido: cai na checagem de identidade */ }
  return /-screen-/.test(participant.identity);
}

/// Marca o canal e avisa, se a mensagem nao for do canal que esta aberto.
function noteUnread(message: ChatMessage, fromMe: boolean) {
  const olhando = view === "server" && mode === "room" && message.roomId === currentRoomId && document.hasFocus();
  if (fromMe) return;
  // Ser citado avisa mesmo com o canal aberto na frente: e o ponto da mencao —
  // alguem quer sua atencao agora, nao quando voce rolar a conversa.
  const citado = mencionaVoce(message.text || "");
  if (olhando && !citado) return;
  if (citado) mencoesPorSala.set(message.roomId, (mencoesPorSala.get(message.roomId) || 0) + 1);
  if (!olhando) unreadRooms.set(message.roomId, (unreadRooms.get(message.roomId) || 0) + 1);
  renderNavigation(); playPing();
  const channel = rooms.find(item => item.id === message.roomId);
  const body = message.text || (message.attachments?.length ? "Enviou um anexo" : "Nova mensagem");
  void notifyMessage({
    title: (citado ? "@ " : "") + message.username + (channel ? " em #" + channel.name : ""),
    body, privateBody: citado ? "Citaram voce em um canal" : "Nova mensagem em um canal", inCall: inCall(),
  });
}
// Contagem separada da de nao lidas: mencao merece marca propria na lista de
// canais, senao ela se perde no meio de uma conversa movimentada.
const mencoesPorSala = new Map<string, number>();

function clearUnread(roomId: string) {
  mencoesPorSala.delete(roomId);
  if (unreadRooms.delete(roomId)) renderNavigation();
  else updateUnreadTitle();
}
function updateUnreadTitle() {
  const total = unreadFriends.size + [...unreadRooms.values()].reduce((sum, count) => sum + count, 0);
  document.title = total ? "(" + (total > 99 ? "99+" : total) + ") naoconcordo" : "naoconcordo";
}

// ------------------------------------------------------- qualidade da tela
// O LiveKit so entrega presets ate 1080p30, entao 60fps sai daqui.
type QualityId = "720p30" | "1080p30" | "1080p60";
type Quality = {
  id: QualityId; label: string; hint: string;
  width: number; height: number; fps: number; bitrate: number;
};
const QUALITIES: Quality[] = [
  { id: "720p30", label: "720p 30fps", hint: "leve, para upload curto", width: 1280, height: 720, fps: 30, bitrate: 3_000_000 },
  { id: "1080p30", label: "1080p 30fps", hint: "equilíbrio, bom para janela e leitura", width: 1920, height: 1080, fps: 30, bitrate: 5_000_000 },
  { id: "1080p60", label: "1080p 60fps", hint: "movimento fluido, para jogo", width: 1920, height: 1080, fps: 60, bitrate: 8_000_000 },
];
const QUALITY_KEY = "naoconcordo.quality";
function readQuality(): Quality {
  const saved = localStorage.getItem(QUALITY_KEY);
  return QUALITIES.find(item => item.id === saved) || QUALITIES[1];
}
function saveQuality(id: QualityId) { localStorage.setItem(QUALITY_KEY, id); }

// ------------------------------------------------------------- volumes
// Volume por pessoa, separado para voz e para o audio da transmissao dela.
// Fica salvo, entao quem fala baixo continua ajustado na proxima chamada.
const VOLUME_KEY = "naoconcordo.volumes";
type VolumePair = { mic: number; screen: number; mudoVoz?: boolean; mudoTela?: boolean };
function readVolumes(): Record<string, VolumePair> {
  try { return JSON.parse(localStorage.getItem(VOLUME_KEY) || "{}") as Record<string, VolumePair>; }
  catch { return {}; }
}
/// O slider ia ate 200%, mas `HTMLMediaElement.volume` **lanca excecao** acima
/// de 1 ("The volume provided (2) is outside the range [0, 1]"). O reforco
/// nunca funcionou: so quebrava. E quebrava caro, porque o `setVolume` e
/// chamado dentro do `attachTrack` e na entrada da chamada — a excecao subia
/// ate o `connect` e virava "erro de conexao".
///
/// Volume acima de 1 exigiria mixagem por WebAudio no LiveKit, que muda o
/// caminho do audio inteiro. Enquanto isso nao existe, o limite e 100%, e os
/// valores antigos ja gravados sao trazidos para dentro da faixa.
const limiteVolume = (valor: number) => Math.min(1, Math.max(0, Number.isFinite(valor) ? valor : 1));
function volumeOf(name: string): VolumePair {
  const bruto = readVolumes()[key(name)] || { mic: 1, screen: 1 };
  return { ...bruto, mic: limiteVolume(bruto.mic), screen: limiteVolume(bruto.screen) };
}
function saveVolume(name: string, pair: VolumePair) {
  const all = readVolumes();
  all[key(name)] = pair;
  localStorage.setItem(VOLUME_KEY, JSON.stringify(all));
}
/// Decide o `muted` de cada elemento de audio num lugar so. O surdo geral e o
/// silenciar por pessoa se sobrepoem, e quem escrevia direto no elemento
/// apagava a decisao do outro: desativar o surdo devolvia a voz de quem estava
/// silenciado.
///
/// Silenciar por aqui, e nao so por volume, tambem contorna o
/// `livekit-client`: o `attach()` dele reaplica o volume guardado com
/// `if (this.elementVolume)`, e **zero e falso**. Quando a faixa de alguem
/// silenciado era anexada de novo — republicada depois de um mudo, por
/// exemplo — o elemento novo nascia em volume 1 e a pessoa voltava a ser
/// ouvida.
function refreshAudioMuting() {
  for (const el of document.querySelectorAll<HTMLAudioElement>("audio[data-naoconcordo-audio]")) {
    const pair = volumeOf(el.dataset.who || "");
    const silenciado = el.dataset.fonte === "tela" ? pair.mudoTela : pair.mudoVoz;
    el.muted = !audioEnabled || Boolean(silenciado);
  }
}
/// Aplica no LiveKit. A fonte separa a voz do audio da tela da mesma pessoa.
function applyVolume(name: string, pair: VolumePair) {
  refreshAudioMuting();
  if (!room) return;
  for (const participant of room.remoteParticipants.values()) {
    if (key(participant.name || participant.identity) !== key(name)) continue;
    // Protegido: um volume invalido nao pode derrubar a entrada na chamada,
    // que e por onde essa chamada passa.
    try {
      participant.setVolume(pair.mudoVoz ? 0 : limiteVolume(pair.mic), Track.Source.Microphone);
      participant.setVolume(pair.mudoTela ? 0 : limiteVolume(pair.screen), Track.Source.ScreenShareAudio);
    } catch (erro) { console.warn("[volume]", erro); }
  }
}
/// Reaplica tudo, usado quando alguem entra ou publica uma faixa nova.
function applyAllVolumes() {
  if (!room) return;
  for (const participant of room.remoteParticipants.values()) {
    const name = participant.name || participant.identity;
    applyVolume(name, volumeOf(name));
  }
}
function volumeRow(name: string, kind: "mic" | "screen", label: string) {
  const row = document.createElement("div");
  row.className = "volume-row";
  const caption = document.createElement("span");
  caption.className = "volume-label";
  caption.textContent = label;
  const slider = document.createElement("input");
  slider.type = "range"; slider.min = "0"; slider.max = "100"; slider.step = "5";
  slider.value = String(Math.round(volumeOf(name)[kind] * 100));
  const value = document.createElement("span");
  value.className = "volume-value";
  value.textContent = slider.value + "%";
  slider.oninput = () => {
    value.textContent = slider.value + "%";
    const pair = volumeOf(name);
    pair[kind] = Number(slider.value) / 100;
    if (kind === "mic") pair.mudoVoz = false; else pair.mudoTela = false;
    saveVolume(name, pair);
    applyVolume(name, pair);
  };
  // Redesenhar so no fim do arrasto: durante o `input`, recriar a lista
  // arrancaria o slider de baixo do dedo.
  slider.onchange = () => { renderPeople(); renderNavigation(); };
  row.append(caption, slider, value);
  return row;
}
/// Microfone mudo? Vale tanto para quem apertou o botao quanto para quem
/// nunca ligou o microfone: dos dois jeitos ninguem escuta, e a linha deve
/// dizer a mesma coisa.
///
/// A busca ignora o participante-tela, que nao tem microfone nenhum.
function micMuted(name: string): boolean {
  if (!room) return false;
  if (key(name) === key(session?.username || "")) return !micEnabled;
  for (const participant of room.remoteParticipants.values()) {
    if (key(participant.name || participant.identity) !== key(name)) continue;
    const publication = participant.getTrackPublication(Track.Source.Microphone);
    if (publication) return publication.isMuted;
  }
  return true;
}

/// Audio desligado (a pessoa nao escuta ninguem). Isso e estado local de quem
/// aperta, entao viaja como atributo do participante — quem entra depois ja
/// recebe o valor atual, sem ninguem precisar reemitir.
function audioMuted(name: string): boolean {
  if (!room) return false;
  if (key(name) === key(session?.username || "")) return !audioEnabled;
  for (const participant of room.remoteParticipants.values()) {
    if (key(participant.name || participant.identity) !== key(name)) continue;
    if (participant.attributes?.surdo === "1") return true;
  }
  return false;
}

/// Anuncia o proprio estado de audio para os outros.
function announceDeafened() {
  if (room?.state !== "connected") return;
  // String vazia apaga o atributo: e o jeito do LiveKit de limpar.
  void room.localParticipant.setAttributes({ surdo: audioEnabled ? "" : "1" }).catch(() => { /* sem permissao ou fora da sala */ });
}

/// Voce silenciou esta pessoa? E decisao sua, guardada aqui no computador —
/// nada a ver com o microfone dela estar desligado.
function silencedByMe(name: string): boolean {
  if (key(name) === key(session?.username || "")) return false;
  const pair = volumeOf(name);
  return Boolean(pair.mudoVoz);
}

/// Quem esta transmitindo audio de tela agora.
function sharesAudio(name: string) {
  if (!room) return false;
  // Uma pessoa ocupa dois participantes na sala: ela mesma e a conexao que
  // publica a tela. So a segunda tem audio de tela, entao a busca precisa
  // varrer todas as que dividem o nome, e nao parar na primeira.
  for (const participant of room.remoteParticipants.values()) {
    if (key(participant.name || participant.identity) !== key(name)) continue;
    if (participant.getTrackPublication(Track.Source.ScreenShareAudio)) return true;
  }
  return false;
}

// Vigia a janela transmitida. Fechar o jogo mata a captura, e sem isso a
// transmissao fica congelada com todo mundo achando que travou.
let vigiaJanela = 0;
let sharePausado = false;
function pararDeVigiar() { window.clearInterval(vigiaJanela); vigiaJanela = 0; }
function vigiarJanelaTransmitida() {
  pararDeVigiar();
  vigiaJanela = window.setInterval(async () => {
    if (!screenEnabled) { pararDeVigiar(); return; }
    const viva = await targetAlive().catch(() => true);
    if (viva) return;
    pararDeVigiar();
    screenEnabled = false;
    sharePausado = false;
    screenButton.classList.remove("active");
    try { await stopShare(); } catch { /* ja tinha morrido */ }
    updateCallControls();
    showToast("A janela que você transmitia foi fechada. A transmissão parou.");
  }, 3000);
}
/// Pausa e retoma a propria transmissao. Diferente de parar: o sid continua o
/// mesmo, entao quem assiste volta a ver sozinho ao retomar, sem clicar de novo.
async function alternarPausaDaTela() {
  if (!screenEnabled) return;
  try {
    sharePausado = await pauseShare(!sharePausado);
    showToast(sharePausado ? "Transmissão pausada." : "Transmissão retomada.");
    updateCallControls();
  } catch (erro) { showToast(erro instanceof Error ? erro.message : "Não foi possível pausar."); }
}
/// A faixa de tela que esta pessoa esta transmitindo agora, se houver.
///
/// Vale para os dois formatos: a conexao separada que publica a tela (clientes
/// novos) e a publicacao na propria pessoa (clientes 0.7.7 e anteriores).
function liveSid(name: string): string {
  if (!room) return "";
  for (const participant of room.remoteParticipants.values()) {
    if (key(participant.name || participant.identity) !== key(name)) continue;
    for (const publication of participant.trackPublications.values()) {
      if (publication.source === Track.Source.ScreenShare) return publication.trackSid;
    }
  }
  return "";
}
/// Abre a transmissao da pessoa. Se ja estiver aberta, so leva o olho ate ela.
function watchLive(name: string) {
  const sid = liveSid(name);
  if (!sid) return;
  const aberta = document.getElementById("track-" + sid);
  if (aberta) { aberta.scrollIntoView({ block: "nearest" }); return; }
  assistindo.add(sid);
  anunciarAssistindo();
  setSubscribedScreen(sid, true);
  document.getElementById("oferta-" + sid)?.remove();
}
/// Selo "ao vivo" de quem esta transmitindo. Clicar abre a transmissao.
function liveBadge(name: string): HTMLElement | null {
  if (!liveSid(name)) return null;
  const selo = document.createElement("button");
  selo.type = "button";
  selo.className = "live-badge";
  selo.textContent = "AO VIVO";
  selo.title = "Assistir a transmissão de " + name;
  selo.onclick = event => { event.stopPropagation(); watchLive(name); };
  return selo;
}
/// Anuncia o que estou assistindo.
///
/// O LiveKit nao conta inscritos para o lado de quem publica, e a nossa tela e
/// publicada por uma conexao separada em Rust — de dentro do app nao ha como
/// perguntar "quem me assiste". Entao cada um declara o que assiste num
/// atributo de participante, do mesmo jeito que o estado "surdo" viaja. Quem
/// entra depois ja recebe o valor atual, sem ninguem reemitir nada.
function anunciarAssistindo() {
  if (!room || room.state !== "connected") return;
  void room.localParticipant.setAttributes({ assistindo: [...assistindo].join(",") })
    .catch(() => { /* sem permissao ou fora da sala */ });
}
/// Quantas pessoas estao assistindo a minha transmissao. Com o botao
/// "Assistir", transmitir virou coisa que pode nao ter plateia — sem este
/// numero nao da para saber se vale a pena continuar.
function meusEspectadores(): number {
  const meu = liveSid(session?.username || "");
  if (!room || !meu) return 0;
  let total = 0;
  for (const participant of room.remoteParticipants.values()) {
    // O participante-tela e uma conexao minha, nao uma pessoa assistindo.
    if (isScreenParticipant(participant)) continue;
    const lista = participant.attributes?.assistindo || "";
    if (lista.split(",").includes(meu)) total += 1;
  }
  return total;
}

// ------------------------------------------------- menu de cada pessoa
//
// Volume e silenciamento moram aqui, e nao soltos na lista: com a chamada
// cheia, uma barra por pessoa empurra todo mundo para fora da tela. Clicar na
// pessoa abre o que e dela.

let openMenu: HTMLElement | null = null;

function closeUserMenu() {
  openMenu?.remove();
  openMenu = null;
}

/// Fecha ao clicar fora ou apertar Esc. Registrado uma vez so: um ouvinte por
/// abertura vazaria um por clique.
document.addEventListener("click", event => {
  if (openMenu && !openMenu.contains(event.target as Node)) closeUserMenu();
}, true);
document.addEventListener("keydown", event => { if (event.key === "Escape") closeUserMenu(); });

function menuToggle(label: string, ativo: boolean, onChange: (valor: boolean) => void) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "user-menu-item" + (ativo ? " active" : "");
  row.append(icon(ativo ? "audio-off" : "audio", "ic-sm"), document.createTextNode(label));
  row.onclick = () => onChange(!ativo);
  return row;
}

// ------------------------------------------------ perfil de outra pessoa
// O mini-perfil de cima sempre mostrou so o **seu** perfil. Quem escrevia no
// canal era um nome e um avatar, sem apelido do servidor, sem bio, sem foto de
// capa — e sem caminho para virar amigo a nao ser procurar pelo nome exato na
// busca.

/// Em que pe esta a amizade com esta pessoa.
function situacaoDeAmizade(username: string): "eu" | "amigo" | "enviado" | "recebido" | "nenhum" {
  const alvo = key(username);
  if (alvo === key(session?.username || "")) return "eu";
  if (friends.some(nome => key(nome) === alvo)) return "amigo";
  if (outgoing.some(item => key(item.addressee) === alvo)) return "enviado";
  if (incoming.some(item => key(item.requester) === alvo)) return "recebido";
  return "nenhum";
}

function abrirPerfil(username: string) {
  const dialogo = byId<HTMLDialogElement>("perfil-dialog");
  const perfil = profiles.get(key(username));
  const doServidor = serverMemberProfiles.get(key(username));

  byId("perfil-nome").textContent = getDisplayName(username);
  // O nome de conta aparece embaixo quando o apelido do servidor e outro: sem
  // isso nao da para saber com quem se esta falando de verdade.
  const usuario = byId("perfil-usuario");
  usuario.textContent = "@" + username;
  usuario.classList.toggle("hidden", getDisplayName(username) === username);

  paintAvatar(byId("perfil-avatar"), username);

  const banner = byId("perfil-banner");
  banner.style.backgroundImage = "";
  const arquivoBanner = perfil?.bannerFile;
  if (arquivoBanner) {
    const cache = blobCache.get(arquivoBanner);
    if (cache) banner.style.backgroundImage = 'url("' + cache + '")';
    else void fileUrl(arquivoBanner).then(url => { banner.style.backgroundImage = 'url("' + url + '")'; }).catch(() => {});
  }

  const bio = byId("perfil-bio");
  const texto = (doServidor?.nickname ? "" : "") + (perfil?.bio || "");
  bio.textContent = texto;
  bio.classList.toggle("hidden", !texto);

  byId("perfil-erro").textContent = "";
  renderAcoesDoPerfil(username);
  if (!dialogo.open) dialogo.showModal();
}

function renderAcoesDoPerfil(username: string) {
  const caixa = byId("perfil-acoes");
  const situacao = situacaoDeAmizade(username);
  const botoes: HTMLElement[] = [];

  const acao = (rotulo: string, principal: boolean, aoClicar: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    if (principal) b.className = "primary";
    b.textContent = rotulo;
    b.onclick = aoClicar;
    return b;
  };

  if (situacao === "amigo") {
    botoes.push(acao("Conversar", true, () => {
      byId<HTMLDialogElement>("perfil-dialog").close();
      void openDirect(username);
    }));
  } else if (situacao === "enviado") {
    const espera = document.createElement("p");
    espera.className = "muted small";
    espera.textContent = "Pedido de amizade enviado. Falta ele aceitar.";
    botoes.push(espera);
  } else if (situacao === "recebido") {
    botoes.push(acao("Aceitar amizade", true, async () => {
      await respondFriend("accept", username);
      renderAcoesDoPerfil(username);
    }));
    botoes.push(acao("Recusar", false, async () => {
      await respondFriend("reject", username);
      renderAcoesDoPerfil(username);
    }));
  } else if (situacao === "nenhum") {
    botoes.push(acao("Adicionar amigo", true, async () => {
      try {
        await api<Friendship>("/api/friends/request", { method: "POST", body: JSON.stringify({ username }) });
        await refreshFriends();
        renderAcoesDoPerfil(username);
      } catch (erro) {
        byId("perfil-erro").textContent = erro instanceof Error ? erro.message : "Não foi possível enviar o pedido.";
      }
    }));
  }

  botoes.push(acao("Fechar", false, () => byId<HTMLDialogElement>("perfil-dialog").close()));
  caixa.replaceChildren(...botoes);
}

/// Linha de acao do menu: executa e fecha, sem estado a mostrar.
function menuAcao(label: string, nomeIcone: string, aoClicar: () => void) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "user-menu-item";
  row.append(icon(nomeIcone, "ic-sm"), document.createTextNode(label));
  row.onclick = () => { closeUserMenu(); aoClicar(); };
  return row;
}

/// Abre o menu da pessoa. Sem `ponto`, encosta no elemento clicado; com ele,
/// abre no cursor — que e o que se espera de um clique com o botao direito.
///
/// `extras` sao acoes do contexto de onde o menu foi aberto: no tile de camera
/// entra "Virar janela". Ficam no fim, depois dos volumes, para o menu nao
/// mudar de forma dependendo de onde foi aberto.
/// Cartao de identidade no topo do menu da pessoa: capa, foto, apelido do
/// servidor com o nome de conta embaixo quando forem diferentes, e a bio.
function cabecalhoDePerfil(username: string): HTMLElement {
  const cabecalho = document.createElement("div");
  cabecalho.className = "user-menu-perfil";

  const capa = document.createElement("div");
  capa.className = "user-menu-capa";
  const arquivo = profiles.get(key(username))?.bannerFile;
  if (arquivo) {
    const cache = blobCache.get(arquivo);
    if (cache) capa.style.backgroundImage = 'url("' + cache + '")';
    else void fileUrl(arquivo).then(url => { capa.style.backgroundImage = 'url("' + url + '")'; }).catch(() => { /* sem capa */ });
  }

  const foto = document.createElement("div");
  foto.className = "avatar user-menu-foto";
  paintAvatar(foto, username);

  const nome = document.createElement("strong");
  nome.className = "user-menu-title";
  nome.textContent = getDisplayName(username);

  const conta = document.createElement("small");
  conta.className = "muted";
  conta.textContent = "@" + username;
  // Repetir o mesmo nome duas vezes so ocuparia espaco.
  conta.classList.toggle("hidden", getDisplayName(username) === username);

  const bio = document.createElement("p");
  bio.className = "user-menu-bio";
  const texto = profiles.get(key(username))?.bio || "";
  bio.textContent = texto;
  bio.classList.toggle("hidden", !texto);

  cabecalho.append(capa, foto, nome, conta, bio);
  return cabecalho;
}

function openUserMenu(
  name: string,
  anchor: HTMLElement,
  ponto?: { x: number; y: number },
  extras?: HTMLElement[],
) {
  closeUserMenu();
  // Silenciar a si mesmo e regular o proprio volume nao querem dizer nada, mas
  // as acoes do contexto sim: sozinho na chamada a unica camera e a sua, e sem
  // isto o botao direito nela nao abria nada.
  const euMesmo = key(name) === key(session?.username || "");
  if (euMesmo && !extras?.length) return;

  const menu = document.createElement("div");
  menu.className = "user-menu";

  if (euMesmo) {
    const title = document.createElement("strong");
    title.className = "user-menu-title";
    title.textContent = "Sua câmera";
    menu.append(title, ...extras!);
    montarMenu(menu, anchor, ponto);
    return;
  }

  // Cabecalho com o perfil que a pessoa montou, e nao so o nome dela.
  //
  // Clicar em alguem e querer saber quem e; abrir um menu de volumes com o
  // nome cru em cima obrigava a passar por "Ver perfil" para ver a foto, a
  // capa e a bio. Tudo isto ja esta em memoria — `profiles` chega no
  // bootstrap —, entao mostrar aqui nao custa nem uma ida ao servidor.
  menu.append(cabecalhoDePerfil(name));

  const redesenhar = () => { const atual = anchor; closeUserMenu(); openUserMenu(name, atual, ponto, extras); };
  const pair = volumeOf(name);

  menu.append(menuToggle("Silenciar voz para mim", Boolean(pair.mudoVoz), valor => {
    const atualizado = { ...volumeOf(name), mudoVoz: valor };
    saveVolume(name, atualizado); applyVolume(name, atualizado);
    redesenhar(); renderPeople(); renderNavigation();
  }));
  menu.append(volumeRow(name, "mic", "voz"));

  // Barra da transmissao so aparece quando existe transmissao com som.
  if (sharesAudio(name)) {
    menu.append(menuToggle("Silenciar tela para mim", Boolean(pair.mudoTela), valor => {
      const atualizado = { ...volumeOf(name), mudoTela: valor };
      saveVolume(name, atualizado); applyVolume(name, atualizado);
      redesenhar();
    }));
    menu.append(volumeRow(name, "screen", "tela"));
  }

  const acoesDoContexto = [
    menuAcao("Ver perfil", "user-plus", () => abrirPerfil(name)),
    ...(extras || []),
  ];
  const risco = document.createElement("div");
  risco.className = "user-menu-sep";
  menu.append(risco, ...acoesDoContexto);

  montarMenu(menu, anchor, ponto);
}

/// Pendura o menu e posiciona junto do que foi clicado.
///
/// Em tela cheia o navegador so desenha o elemento em tela cheia e os
/// descendentes dele: pendurado no `body`, o menu simplesmente nao aparecia —
/// mesma armadilha da barra de chamada. O menu e efemero (fecha a cada clique
/// fora), entao pode viver dentro do `stage` sem o risco de sumir de vez que a
/// barra corria.
function montarMenu(menu: HTMLElement, anchor: HTMLElement, ponto?: { x: number; y: number }) {
  (document.fullscreenElement || document.body).append(menu);
  // Posiciona depois de medir: fora da tela, o menu abriria cortado.
  const caixa = anchor.getBoundingClientRect();
  const largura = menu.offsetWidth || 220;
  const altura = menu.offsetHeight || 160;
  const alvoX = ponto ? ponto.x : caixa.left;
  const alvoY = ponto ? ponto.y : caixa.bottom + 4;
  const esquerda = Math.min(alvoX, window.innerWidth - largura - 8);
  const topo = Math.min(alvoY, window.innerHeight - altura - 8);
  menu.style.left = Math.max(8, esquerda) + "px";
  menu.style.top = Math.max(8, topo) + "px";
  openMenu = menu;
}

/// Uma linha do painel. Só quem está na chamada ganha controle de volume.
function personRow(name: string, online: boolean, naChamada: boolean) {
  const box = document.createElement("div");
  box.className = "person-box" + (online ? "" : " offline");
  const row = document.createElement("div");
  row.className = "person" + (naChamada ? " in-call" : "");
  row.dataset.who = name;
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  paintAvatar(avatar, name);
  const text = document.createElement("span");
  const disp = getDisplayName(name);
  text.textContent = disp;
  if (disp !== name) text.title = "@" + name;
  row.append(avatar, text);
  if (naChamada) {
    const marks = document.createElement("span");
    marks.className = "person-marks";
    // Os dois estados sao independentes: da para estar mudo, surdo, ou os dois.
    const aoVivo = liveBadge(name);
    if (aoVivo) marks.append(aoVivo);
    if (micMuted(name)) {
      const mark = icon("mic-off", "ic-sm");
      mark.setAttribute("aria-label", "microfone desligado");
      marks.append(mark);
    }
    if (audioMuted(name)) {
      const mark = icon("audio-off", "ic-sm");
      mark.setAttribute("aria-label", "audio desligado");
      marks.append(mark);
    }
    if (silencedByMe(name)) {
      const mark = icon("silenced", "ic-sm silenced-mark");
      mark.setAttribute("aria-label", "silenciado por voce");
      marks.append(mark);
    }
    if (marks.childNodes.length) row.append(marks);
  }
  box.append(row);
  if (naChamada && key(name) !== key(session?.username || "")) {
    row.classList.add("clickable");
    row.onclick = event => { event.stopPropagation(); openUserMenu(name, row); };
  }
  return box;
}
function callParticipants(): string[] {
  const names: string[] = [];
  if (room?.state === "connected") {
    names.push(session?.username || room.localParticipant.identity);
    for (const participant of room.remoteParticipants.values()) names.push(participant.name || participant.identity);
  }
  return [...new Set(names)];
}
/// Carrega a lista de membros do servidor aberto, para montar o painel.
async function loadServerMembers() {
  if (view !== "server" || !currentServerId) { serverMembers = []; serverMemberProfiles.clear(); renderPeople(); return; }
  const alvo = currentServerId;
  try {
    const data = await api<{ members: ServerMember[]; myRole?: ServerRole }>(
      "/api/servers/" + encodeURIComponent(alvo) + "/members");
    // Duas trocas seguidas de servidor: a resposta atrasada da primeira nao
    // pode sobrescrever a lista da segunda.
    if (alvo !== currentServerId) return;
    serverMembers = data.members.map(member => member.username);
    serverMemberProfiles.clear();
    for (const m of data.members) serverMemberProfiles.set(key(m.username), m);
    if (data.myRole) roles[alvo] = data.myRole;
  } catch {
    if (alvo !== currentServerId) return;
    serverMembers = []; serverMemberProfiles.clear();
  }
  renderNavigation();
  renderPeople();
  if (session) paintMyAvatars(session.username);
}
function renderPeople() {
  // Em servidor, mostra os membros; na home, os amigos. Sempre por presenca.
  const todos = view === "server" ? serverMembers : friends;
  const naChamada = new Set(callParticipants().map(key));
  const online = todos.filter(name => onlineUsers.has(key(name)) || naChamada.has(key(name)));
  const offline = todos.filter(name => !online.includes(name));
  byId("people-count").textContent = String(online.length);
  byId("offline-count").textContent = String(offline.length);
  byId("offline-title").classList.toggle("hidden", offline.length === 0);
  byId("offline-list").replaceChildren(...offline.map(name => personRow(name, false, false)));
  const unique = online;
  // So redesenha quando a lista muda: recriar a cada evento faria o controle de
  // volume escapar do dedo no meio do arrasto.
  const assinatura = unique.map(name => name
    + (naChamada.has(key(name)) ? "!" : "")
    + (sharesAudio(name) ? "+t" : "")
    + (micMuted(name) ? "+m" : "")
    + (audioMuted(name) ? "+s" : "")
    + (silencedByMe(name) ? "+q" : "")).join("|");
  if (peopleList.dataset.assinatura !== assinatura) {
    peopleList.dataset.assinatura = assinatura;
    peopleList.replaceChildren(...unique.map(name => personRow(name, true, naChamada.has(key(name)))));
  }
  voiceUsers.classList.add("hidden");
  updateSpeakingStyles();
}
function resetMediaState() {
  sharingNow.clear();
  micEnabled = false; screenEnabled = false; camEnabled = false;
  micButton.classList.remove("active"); screenButton.classList.remove("active"); camButton.classList.remove("active");
  setIcon(micButton, "mic-off"); setIcon(audioButton, "audio");
  assistindo.clear();
  camerasOcultas.clear();
  restaurarControles(); stage.replaceChildren(); stage.classList.add("hidden");
  tileGrande = ""; tileCheia = ""; aplicarTeatro();
  cameras.clear(); renderCameras();
  document.querySelectorAll("audio[data-naoconcordo-audio]").forEach(el => el.remove());
}
/// A barra de chamada so existe durante a chamada: fora dela e poluicao.
function updateCallControls() {
  const ativa = Boolean(voiceRoomId) || room?.state === "connected" || room?.state === "connecting";
  byId("call-controls").classList.toggle("hidden", !ativa);
  // Quem transmite precisa saber se tem plateia: desde o botao "Assistir",
  // transmitir para ninguem virou possibilidade real.
  const rotulo = screenButton.querySelector("small");
  if (rotulo) {
    const espectadores = screenEnabled ? meusEspectadores() : 0;
    rotulo.textContent = !screenEnabled ? "Compartilhar"
      : sharePausado ? "Pausada"
      : espectadores === 0 ? "Ninguém vendo"
      : espectadores === 1 ? "1 assistindo"
      : espectadores + " assistindo";
    screenButton.classList.toggle("pausada", screenEnabled && sharePausado);
    screenButton.title = screenEnabled
      ? "Parar de compartilhar (botão direito pausa sem parar)"
      : "Compartilhar tela";
  }
}
function setStatus(text: string, online: boolean) {
  updateCallControls(); statusPill.textContent = text; statusPill.classList.toggle("online", online); connectionState.textContent = text; byId("mini-profile-status").textContent = text; leaveButton.querySelector("small")!.textContent = online ? "Desconectar" : "Reconectar"; }
function showToast(text: string) { toastEl.textContent = text; toastEl.classList.remove("hidden"); window.clearTimeout(toastTimer); toastTimer = window.setTimeout(() => toastEl.classList.add("hidden"), 4000); }
function initials(name: string) { return name.split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase()).join(""); }
async function resume() { if (!session) return; try { await api("/api/session"); await enterApp(); } catch { saveSession(null); } }
void resume();
byId("app-version").textContent = "v" + __APP_VERSION__;

// ------------------------------------------------------ aviso de versao
// Duas situacoes viram simbolo no alto da janela: uma versao nova baixando, e
// a primeira abertura depois de atualizar. Antes disso a atualizacao passava
// so num toast e ninguem percebia que o app tinha mudado.
const VERSAO_VISTA = "naoconcordo.versao-vista";
const updatePill = byId<HTMLButtonElement>("update-pill");
let notasDaVersao = "";
function mostrarPill(texto: string, baixando: boolean, notas: string) {
  notasDaVersao = notas;
  byId("update-pill-text").textContent = texto;
  updatePill.classList.toggle("baixando", baixando);
  updatePill.classList.remove("hidden");
}
updatePill.addEventListener("click", () => {
  showNotice("Versão " + __APP_VERSION__, notasDaVersao || "Sem notas para esta versão.");
  if (!updatePill.classList.contains("baixando")) {
    updatePill.classList.add("hidden");
    localStorage.setItem(VERSAO_VISTA, __APP_VERSION__);
  }
});
const versaoAnterior = localStorage.getItem(VERSAO_VISTA);
if (versaoAnterior && versaoAnterior !== __APP_VERSION__) {
  const notas = notasSalvas() || "Sem notas para esta versão.";
  mostrarPill("Atualizado para " + __APP_VERSION__, false, notas);
  limparNotas();
} else if (!versaoAnterior) {
  localStorage.setItem(VERSAO_VISTA, __APP_VERSION__);
}
// Vale desde o primeiro quadro, e nao so quando alguem abre as configuracoes:
// esconder o que nao funciona e estado da interface, nao efeito de um clique.
aplicarAmbiente();

// A pagina no navegador se atualiza recarregando; o updater assinado e so do
// instalador do Windows.
if (ehTauri()) {
  void checkForUpdate((texto, notas) => {
    showToast(texto);
    mostrarPill(texto, true, notas || texto);
  });
}


