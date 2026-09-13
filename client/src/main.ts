import { invoke } from "@tauri-apps/api/core";
import { abrirExterno, abrirJanela, bloquearRecarregar, ehTauri } from "./ambiente";
import { baixarPreferencias, vigiarPreferencias } from "./preferencias";
import {
  LocalTrackPublication, RemoteAudioTrack, RemoteParticipant, RemoteTrack, RemoteTrackPublication, Room, RoomEvent,
  Track, VideoPresets,
} from "livekit-client";
import "./styles.css";
import * as voz from "./voz";
import { recortarImagem } from "./recorte";
import * as servidor from "./servidor";
import {
  abrirCofre, chaveDoCofre, checkPin, dropPin, fecharCofre, fingerprint, guardarIdentidadeLocal,
  identidadeLocal, loadIdentity, openMessage, savePin, sealMessage,
  type Embrulho, type Identity,
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

// Escolhido em tempo de execucao (veja `servidor.ts`), e nao mais fixado no
// build. Lido uma vez: trocar de servidor recarrega a janela, porque sessao,
// conta e historico sao de outro lugar.
const API = servidor.endereco();
const WS = servidor.paraWs(API);
type StoredFile = { id: string; name: string; mime: string; size: number; owner: string };
type ChatMessage = { id: string; username: string; text: string; createdAt: string; editedAt?: string | null; roomId: string; attachments?: StoredFile[]; replyTo?: string | null; reactions?: Record<string, string[]>; pinned?: boolean };
type AuthSession = { token: string; username: string; expiresAt: number };
type ServerInfo = { id: string; name: string; iconFile?: string | null; bannerFile?: string | null; description?: string | null };
type RoomKind = "text" | "voice";
type RoomInfo = { id: string; name: string; serverId: string; kind: RoomKind; categoryId?: string | null; posicao?: number };
type Profile = { username: string; avatar: string | null; avatarFile?: string | null; bio?: string | null; bannerFile?: string | null; color?: string | null };
type ServerRole = "owner" | "mod" | "member";
type Categoria = { id: string; serverId: string; name: string; posicao: number };
type Bootstrap = { servers: ServerInfo[]; rooms: RoomInfo[]; profiles: Profile[]; isOwner: boolean; isAdmin: boolean; roles: Record<string, ServerRole>; online: string[]; voice?: Record<string, string[]>; categorias?: Categoria[]; gifs?: boolean };
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
/// Os grupos de canais dos servidores que esta conta enxerga, na ordem que o
/// servidor decidiu — ordenar de novo aqui so criaria uma segunda regra para
/// discordar da primeira.
let categorias: Categoria[] = [];
/// Se o servidor deste endereco sabe o que sao categorias.
let temCategorias = false;
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
/// O palco com um quadro por pessoa esta a mostra? Entrar numa chamada liga; o
/// clique no proprio canal alterna. Camera e tela alheias aparecem de qualquer
/// jeito — este interruptor vale so para os quadros de quem esta so na voz.
let palcoDaChamada = true;
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

/// O que abre o cofre desta sessao. Vive so na memoria: guardar isto no
/// aparelho seria o mesmo que guardar a senha.
///
/// `senha` existe sempre que a pessoa digitou a senha agora. Sessao restaurada
/// do disco entra sem digitar nada, e ai nao ha chave — o historico vem da
/// copia local, que e o caso comum do dia a dia.
///
/// `recuperacao` so existe quando o codigo passou pelas maos do usuario: ao
/// criar a conta e ao recuperar. Contas antigas, que migram durante um login
/// comum, ficam sem esse embrulho ate a proxima recuperacao.
let chaveDeSenha: CryptoKey | null = null;
let chaveDeRecuperacao: CryptoKey | null = null;
type Cofre = { porSenha: Embrulho; porRecuperacao?: Embrulho };

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

// ------------------------------------------------------- trocar de servidor
//
// O endereco deixou de ser fixado no build, entao quem hospeda o proprio
// servidor usa o mesmo instalador de todo mundo e so aponta para ele aqui.
//
// Isto vive na tela de entrada, e nao nas configuracoes, porque e antes de
// entrar que a escolha importa: conta, senha e historico sao de cada servidor.
{
  const caixa = byId("servidor-troca");
  const campo = byId<HTMLInputElement>("servidor-endereco");
  const recado = byId("servidor-recado");
  const abrir = byId("servidor-abrir");

  const dizer = (texto: string, estado: "" | "ok" | "ruim" = "") => {
    recado.textContent = texto;
    recado.className = "muted small" + (estado ? " " + estado : "");
  };

  const pintar = () => {
    const proprio = servidor.ehProprio();
    abrir.textContent = proprio ? "Servidor: " + servidor.endereco() : "Usar outro servidor";
    byId("servidor-padrao").classList.toggle("hidden", !proprio);
  };

  abrir.onclick = () => {
    const fechada = caixa.classList.toggle("hidden");
    if (fechada) return;
    campo.value = servidor.ehProprio() ? servidor.endereco() : "";
    campo.placeholder = "meuservidor.com.br:8443";
    dizer("Padrão deste aplicativo: " + servidor.PADRAO);
    campo.focus();
  };

  byId("servidor-testar").onclick = async () => {
    const alvo = campo.value;
    if (!alvo.trim()) { dizer("Escreva um endereço primeiro.", "ruim"); return; }
    dizer("Testando " + servidor.normalizar(alvo) + "…");
    const resultado = await servidor.testar(alvo);
    dizer(resultado.detalhe, resultado.ok ? "ok" : "ruim");
  };

  byId("servidor-usar").onclick = async () => {
    const alvo = campo.value;
    if (!servidor.normalizar(alvo)) { dizer("Endereço inválido.", "ruim"); return; }
    // Testa antes de gravar: gravar um endereco morto deixa o aplicativo sem
    // conseguir nem chegar na tela de entrada do servidor certo.
    dizer("Testando…");
    const resultado = await servidor.testar(alvo);
    if (!resultado.ok) { dizer(resultado.detalhe + " Nada foi alterado.", "ruim"); return; }
    if (!servidor.guardar(alvo)) { dizer("Não foi possível guardar o endereço.", "ruim"); return; }
    // Sem TLS o token de sessao e as mensagens de canal vao em texto claro pela
    // rede. As privadas continuam cifradas ponta a ponta e a senha nunca sai
    // daqui, mas quem escolhe isto merece saber, e nao descobrir depois.
    if (servidor.normalizar(alvo).startsWith("http://")) {
      await showNotice("Servidor sem criptografia",
        "Este endereço usa http, sem certificado. As mensagens de canal e o código da sua sessão trafegam em texto claro por essa rede. Dentro de uma VPN como Radmin ou Hamachi isso é aceitável, porque a própria VPN já é criptografada. Na internet aberta, não é.");
    }
    // Recarrega: a sessao guardada, o historico e as chaves sao de outro
    // servidor, e reaproveitar qualquer um deles daria erro confuso.
    trocarDeServidor();
  };

  byId("servidor-padrao").onclick = () => {
    servidor.esquecer();
    trocarDeServidor();
  };

  pintar();
}

/// Recarrega a janela depois de mudar de servidor, deixando para tras a sessao
/// do anterior. A identidade de conversas fica: ela e por usuario, e voltar ao
/// servidor de origem tem de reencontrar o historico.
function trocarDeServidor() {
  try { localStorage.removeItem("naoconcordo.session"); } catch { /* nada a fazer */ }
  location.reload();
}

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
      // Conta nova ja nasce com os dois embrulhos: e o unico momento, fora da
      // recuperacao, em que o codigo esta a vista.
      chaveDeSenha = await chaveDoCofre(password, challenge.passwordSalt, challenge.passwordIterations);
      chaveDeRecuperacao = await chaveDoCofre(recoveryCode, challenge.recoverySalt, challenge.passwordIterations);
      downloadRecoveryCode(username, recoveryCode);
    } else {
      if (!challenge.accountExists) throw new Error("Usuario nao cadastrado. Use Criar conta.");
      const proof = await signProof(verifier, challenge.nonce, username);
      saveSession(await api<AuthSession>("/api/auth/login", { method: "POST", body: JSON.stringify({ username, nonce: challenge.nonce, proof }) }));
      // Derivada aqui, enquanto a senha esta em maos; e o que abre as conversas
      // nesta maquina pela primeira vez.
      chaveDeSenha = await chaveDoCofre(password, challenge.passwordSalt, challenge.passwordIterations);
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
    // O codigo **antigo** e o que abre o cofre atual; os novos sao para
    // reembrulhar depois. Derivar antes de trocar a senha evita perder o unico
    // caminho de volta para o historico.
    const chaveAntiga = await chaveDoCofre(recoveryCode, challenge.recoverySalt, challenge.passwordIterations);
    saveSession(await api<AuthSession>("/api/auth/recover", {
      method: "POST",
      body: JSON.stringify({ username, nonce: challenge.nonce, recoveryProof, verifier: bytesToBase64Url(verifier), recoveryVerifier: bytesToBase64Url(nextRecoveryVerifier) })
    }));
    chaveDeSenha = await chaveDoCofre(password, challenge.passwordSalt, challenge.passwordIterations);
    chaveDeRecuperacao = await chaveDoCofre(nextRecoveryCode, challenge.recoverySalt, challenge.passwordIterations);
    await recuperarCofre(username, chaveAntiga);
    recoveryDialog.close();
    recoveryForm.reset();
    downloadRecoveryCode(username, nextRecoveryCode);
    await enterApp();
  } catch (error) { errorEl.textContent = error instanceof Error ? error.message : "Nao foi possivel recuperar a conta."; }
  finally { submit.disabled = false; }
});
async function enterApp() {
  if (!session) return;
  // Antes de qualquer coisa desenhar: tudo o que le esses ajustes le por funcao
  // e sob demanda, entao gravar agora faz a tela ja nascer certa.
  await baixarPreferencias(api);
  vigiarPreferencias(api);
  // Primeira medida ja na entrada: esperar o relogio de dez segundos deixaria
  // o estado sem numero justo quando a pessoa esta olhando para ele.
  void medirPing();
  const data = await api<Bootstrap>("/api/bootstrap");
  servers = data.servers; rooms = data.rooms; isAdmin = Boolean(data.isAdmin); roles = data.roles || {};
  temGifs = Boolean(data.gifs); aplicarBotaoDeGif();
  // Servidor mais antigo nao conhece categorias e nem manda o campo. Distinguir
  // "nenhuma categoria" de "este servidor nao sabe o que e isso" e o que evita
  // oferecer um botao cujo unico resultado seria erro.
  temCategorias = data.categorias !== undefined;
  categorias = data.categorias || [];
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
  // As chaves do cofre morrem com a sessao: sem isto a proxima pessoa a entrar
  // neste computador abriria o cofre da anterior.
  chaveDeSenha = null; chaveDeRecuperacao = null;
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
  // O banner virou o fundo do proprio cartao do servidor, atras do nome, em vez
  // de uma faixa separada embaixo dele. Ocupa o mesmo lugar e diz mais.
  const cartao = byId("server-card");
  cartao.classList.toggle("com-capa", Boolean(emServidor && atual?.bannerFile));
  if (emServidor && atual?.bannerFile) {
    const arquivo = atual.bannerFile;
    const alvo = currentServerId;
    const cache = blobCache.get(arquivo);
    // Trocar de servidor tem de apagar a capa velha na hora; senao ela fica ate
    // a imagem nova baixar, e a resposta atrasada pinta o servidor errado.
    cartao.style.backgroundImage = cache ? 'url("' + cache + '")' : "";
    if (!cache) fileUrl(arquivo).then(url => {
      if (alvo === currentServerId) cartao.style.backgroundImage = 'url("' + url + '")';
    }).catch(() => { cartao.style.backgroundImage = ""; });
  } else {
    cartao.style.backgroundImage = "";
  }
  pintarBarraDeTitulo(emServidor ? atual : undefined);
  const titleEl = byId("sidebar-title");
  titleEl.textContent = emServidor ? (atual?.name || "servidor") : "Mensagens";
  titleEl.title = (emServidor && atual?.description) ? atual.description : "";
  byId("sidebar-subtitle").textContent = emServidor
    ? (roles[currentServerId] === "owner" ? "dono" : roles[currentServerId] === "mod" ? "moderador" : "membro")
    : "amigos";
  const mine = rooms.filter(item => item.serverId === currentServerId);
  // Fora de categoria continua em cima, nas duas secoes de sempre: servidor que
  // nunca criou grupo nenhum fica exatamente como estava.
  const soltos = mine.filter(item => !item.categoryId || !grupoExiste(item.categoryId));
  const textRooms = soltos.filter(item => item.kind === "text");
  const voiceRooms = soltos.filter(item => item.kind === "voice");
  byId("room-list").replaceChildren(...textRooms.map(botaoDeTexto));
  byId("voice-list").replaceChildren(...voiceRooms.flatMap(linhasDeVoz));
  // Secao sem nada dentro nao aparece. O "+" dela ia junto, e criar o primeiro
  // canal passou a ser pelo botao direito no vazio da barra.
  esconderSecaoVazia("room-list", textRooms.length > 0);
  esconderSecaoVazia("voice-list", voiceRooms.length > 0);
  // Soltar aqui e tirar o canal de qualquer categoria.
  alvoSemCategoria(byId("room-list"), "text");
  alvoSemCategoria(byId("voice-list"), "voice");
  desenharCategorias(mine);
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
  persistNavigation(); restoreComposerDraft(); renderNavigation(); renderMessages();
  // Desenha ja com a lista vazia: mostrar por um instante a gente do servidor
  // anterior e pior do que mostrar o painel enchendo.
  renderPeople();
  void loadServerMembers();
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
  ganhoAtual = null;
  pararPortao();
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

/// Busca o cofre da conta. `null` quer dizer que ainda nao existe um.
async function lerCofre(): Promise<Cofre | null> {
  try { return await api<Cofre>("/api/cofre"); }
  catch { return null; }
}

/// Sobe a identidade cifrada. O embrulho pelo codigo so vai quando o codigo
/// passou pelas maos do usuario nesta sessao.
async function subirCofre(quem: Identity) {
  if (!chaveDeSenha) return;
  try {
    const porSenha = await fecharCofre(quem, chaveDeSenha);
    // Sem o codigo em maos, o embrulho de recuperacao repete o da senha apenas
    // como espaco reservado? Nao: seria mentir sobre o que o codigo abre. Sem
    // ele, o cofre sobe so com o embrulho da senha.
    const corpo: Cofre = { porSenha };
    if (chaveDeRecuperacao) corpo.porRecuperacao = await fecharCofre(quem, chaveDeRecuperacao);
    await api("/api/cofre", { method: "PUT", body: JSON.stringify(corpo) });
  } catch { showToast("Não foi possível guardar suas conversas na conta."); }
}

/// Depois de recuperar a conta: abre o cofre com o codigo antigo e o reembrulha
/// com a senha e o codigo novos.
async function recuperarCofre(username: string, chaveAntiga: CryptoKey) {
  const cofre = await lerCofre();
  if (!cofre?.porRecuperacao) {
    // Conta que migrou durante um login comum nunca chegou a guardar o embrulho
    // do codigo. Nao ha o que abrir, e dizer isso agora e melhor do que a pessoa
    // descobrir sozinha que as conversas viraram texto ilegivel.
    await showNotice("Conta recuperada", "As conversas privadas anteriores não podem ser abertas com o código de recuperação, porque esta conta é anterior a essa proteção. As novas conversas já ficam guardadas na conta.");
    return;
  }
  try {
    const recuperada = await abrirCofre(cofre.porRecuperacao, chaveAntiga);
    guardarIdentidadeLocal(username, recuperada);
    await subirCofre(recuperada);
  } catch {
    await showNotice("Conta recuperada", "A senha foi trocada, mas as conversas privadas antigas não puderam ser abertas com este código.");
  }
}

/// Traz a identidade da conta e publica a chave publica.
///
/// A identidade segue a **conta**: ela vem do cofre no servidor, aberto pela
/// chave derivada da senha. Antes disto ela nascia neste computador, e entrar de
/// outra maquina gerava uma identidade nova — o que sobrescrevia a chave publica
/// e deixava todo o historico como "(nao foi possivel decifrar)".
async function ensureIdentity() {
  if (!session) return;
  const username = session.username;
  const cofre = await lerCofre();

  // **So publicamos a chave quando sabemos que ela e a da conta.**
  //
  // Havendo cofre que nao conseguimos abrir, a identidade local pode ser outra —
  // mais antiga, ou de antes de a conta ganhar cofre. Publicar a chave dela
  // sobrescreveria a chave da conta no servidor, e o estrago sai daqui: os
  // amigos veem "identidade mudou" e passam a cifrar para uma chave que o cofre
  // nao le. A conversa quebra para os dois lados, e nenhum deles fez nada.
  let ehDaConta = false;

  if (cofre && chaveDeSenha) {
    try {
      const daConta = await abrirCofre(cofre.porSenha, chaveDeSenha);
      guardarIdentidadeLocal(username, daConta);
      identity = daConta;
      ehDaConta = true;
    } catch {
      // Cofre fechado por outra senha: acontece quando a senha foi trocada em
      // outro aparelho. A copia local ainda serve para ler o que ja estava
      // aqui, mas ela nao fala pela conta.
      identity = identidadeLocal(username);
      showToast("Suas conversas antigas estão guardadas com outra senha. Entre com a senha atual para abri-las.");
    }
  } else if (cofre) {
    // Sessao restaurada do disco: nao ha senha em maos para abrir o cofre. A
    // copia local resolve o dia a dia; so a primeira entrada numa maquina nova
    // precisa mesmo da senha. A chave da conta ja esta publicada de antes, e
    // republicar sem conferir e justamente o risco descrito acima.
    identity = identidadeLocal(username);
    if (!identity) showToast("Entre com sua senha para abrir suas conversas privadas neste computador.");
  } else {
    // Conta sem cofre: ou e nova, ou e anterior a esta mudanca. Nos dois casos a
    // identidade deste aparelho passa a ser a da conta.
    identity = await loadIdentity(username);
    await subirCofre(identity);
    ehDaConta = true;
  }

  if (!identity || !ehDaConta) return;
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
    // A foto no lugar do "@": a lista de amigos e de pessoas, e um arroba
    // igual em todas as linhas nao distingue ninguem. Reconhecer o amigo pela
    // cara e mais rapido do que ler a lista inteira.
    const foto = document.createElement("div");
    foto.className = "avatar avatar-canal";
    paintAvatar(foto, name);
    button.append(foto, document.createTextNode(getDisplayName(name)));
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
  const avatar = document.createElement("div"); avatar.className = "avatar clicavel"; paintAvatar(avatar, name);
  const label = document.createElement("span"); label.className = "friend-name clicavel";
  const disp = getDisplayName(name);
  label.textContent = disp;
  if (disp !== name) label.title = "@" + name;
  // Foto e nome abrem o perfil, em qualquer lista onde a pessoa apareca. Sem
  // isto, so a lista de presenca respondia ao clique — no dialogo de membros e
  // na lista de amigos, clicar numa pessoa nao fazia nada.
  //
  // O alvo e o cartao inteiro, e nao o menu ancorado: estas linhas moram dentro
  // de dialogos, e um menu flutuante preso a uma linha de modal briga com o
  // proprio modal.
  avatar.onclick = event => { event.stopPropagation(); abrirPerfil(name); };
  label.onclick = event => { event.stopPropagation(); abrirPerfil(name); };
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
    const mostrou = notifyMessage({ title: friend, body: message.text, privateBody: "Nova mensagem privada", inCall: inCall() });
    void avisarOrigem(mostrou, "Mensagem privada de " + getDisplayName(friend), () => void openDirect(friend));
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
  // A lista da direita mostra quem esta no servidor. Na area de amigos nao ha
  // servidor, e ela repetia a lista da esquerda; sem ela a conversa ganha a
  // largura de volta. Dentro de um servidor continua onde estava.
  byId("app-view").classList.toggle("sem-pessoas", view === "home");
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

/// Quantas tentativas seguidas de abrir o socket falharam.
///
/// Zera assim que uma abre. Serve para duas coisas: espacar as tentativas
/// quando a rede esta fora, e desconfiar da sessao quando falha demais.
let tentativasDeSocket = 0;

/// Quanto esperar antes da proxima tentativa.
///
/// Antes era 2,5 s fixo, para sempre. Com a sessao vencida isso vira 24 pedidos
/// por minuto sem fim, todos recusados — e ninguem avisa a pessoa, que fica com
/// um aplicativo aberto que nunca mais recebe mensagem. Com a rede fora, e a
/// mesma insistencia gastando bateria a toa.
///
/// Dobra ate meio minuto: reconexao rapida quando e um solucinho, e espera
/// civilizada quando o problema e longo.
function esperaDoSocket(): number {
  return Math.min(2500 * 2 ** Math.max(0, tentativasDeSocket - 1), 30000);
}

/// A sessao ainda vale?
///
/// O socket fechado nao diz **por que** — o navegador nao entrega o codigo HTTP
/// de um upgrade recusado. Perguntar aqui e o unico jeito de separar "a rede
/// caiu" de "sua sessao venceu", e as duas pedem respostas opostas: uma quer
/// insistir, a outra quer parar e mandar entrar de novo.
async function sessaoAindaVale(): Promise<boolean> {
  try {
    // `fetch` cru, e nao o ajudante `api`: ele transforma a resposta em Error
    // com o texto da mensagem, e ai so sobraria casar palavra — que quebra no
    // dia em que alguem reescrever a frase. O numero e estavel.
    const resposta = await fetch(API + "/api/session", {
      headers: { Authorization: "Bearer " + (session?.token || "") },
    });
    // So o 401 e recusa da sessao. Servidor fora do ar, 502 do proxy ou queda de
    // rede nao dizem nada sobre ela — nesses casos vale insistir.
    return resposta.status !== 401;
  } catch {
    return true;
  }
}

function connectChat() {
  if (!session) return; chat?.close(); const token = session.token; chat = new WebSocket(WS + "/ws?token=" + encodeURIComponent(token));
  // O bootstrap acontece antes do socket abrir, entao a propria pessoa nao
  // aparecia na lista de online ate reiniciar o app.
  chat.onopen = () => {
    // Abriu: a contagem de falhas volta ao zero, e a proxima queda tenta rapido
    // de novo em vez de herdar a espera longa da vez passada.
    tentativasDeSocket = 0;
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
    // Organizar canais mexe em duas listas ao mesmo tempo, e em ate quatro
    // operacoes diferentes. Reler o estado inteiro custa menos do que aplicar
    // cada mudanca na ordem certa — e nao tem como sair errado.
    if (payload.type === "canaisOrganizados") void recarregarOrganizacao();
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
  chat.onclose = () => {
    if (session?.token !== token) return;
    tentativasDeSocket += 1;
    // Depois de algumas falhas seguidas, para de adivinhar e pergunta.
    if (tentativasDeSocket === 3) {
      void sessaoAindaVale().then(vale => {
        if (vale || session?.token !== token) return;
        saveSession(null);
        showToast("Sua sessão expirou. Entre de novo.");
        // Recarregar leva de volta a tela de entrada sem precisar desmontar a
        // tela inteira na mao. Sem sessao guardada, `resume` nao tenta voltar.
        location.reload();
      });
    }
    window.setTimeout(connectChat, esperaDoSocket());
  };
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
  // Quem le a mensagem e quer o volume da pessoa nao deveria ter de procurar
  // ela na lista da direita.
  const menuDoAutor = (event: MouseEvent) => {
    event.preventDefault();
    openUserMenu(message.username, event.currentTarget as HTMLElement, { x: event.clientX, y: event.clientY });
  };
  avatar.oncontextmenu = menuDoAutor;
  const body = document.createElement("div"), head = document.createElement("div"); head.className = "message-head";
  const name = document.createElement("strong");
  name.className = "clicavel";
  name.onclick = () => abrirPerfil(message.username);
  name.oncontextmenu = menuDoAutor;
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
  const escolhido = (event.currentTarget as HTMLInputElement).files?.[0]; if (!escolhido) return;
  // O enquadramento vem antes do resto: a foto ja chega no formato certo, e o
  // caminho do GIF continua intacto porque o recorte devolve o original.
  const file = await recortarImagem(escolhido, { proporcao: 1, titulo: "Enquadrar sua foto", redondo: true });
  if (!file) return;
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
  const meuAvatar = byId("avatar");
  // Com a marca, `updateSpeakingStyles` alcanca o avatar do rodape e ele ganha
  // o anel na sua cor quando voce fala — antes so os outros tinham.
  meuAvatar.dataset.who = username;
  paintAvatar(meuAvatar, username);
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
      refreshAgendado = window.setTimeout(() => {
        if (!atual()) return;
        renderPeople();
        renderNavigation();
        // O palco mostra um quadro por pessoa na chamada, entao entrar e sair
        // muda o que ele desenha — nao so a lista lateral.
        renderCameras();
      }, 60);
    };
    next.on(RoomEvent.Connected, () => { if (!atual()) return; setStatus("online", true); playJoin(); silenciarAvisos(2000); announceDeafened(); refresh(); }).on(RoomEvent.Reconnecting, () => { if (!atual()) return; setStatus("reconectando", false); reconectandoDesde ||= Date.now(); })
      .on(RoomEvent.Reconnected, () => { if (!atual()) return; reconectandoDesde = 0; setStatus("online", true); silenciarAvisos(2000); })
      .on(RoomEvent.Disconnected, motivo => {
        if (!atual()) return;
        reconectandoDesde = 0;
        setStatus("fora da chamada", false); playLeave(); voiceRoomId = ""; resetMediaState(); refresh();
        // 2 e `DUPLICATE_IDENTITY`: a mesma conta entrou na chamada de outro
        // lugar e o servidor de voz deixou a conexao nova no lugar desta. Sem
        // dizer isso, a chamada simplesmente cai do nada.
        if (motivo === 2) showToast("Sua conta entrou nesta chamada de outro aparelho.");
      })
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
          telasVistas.delete(publication.trackSid);
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
      .on(RoomEvent.TrackUnsubscribed, track => {
        if (!atual()) return;
        soltarDoReforco(track);
        detachTrack(track.sid);
        if (track.sid) removeCamera(track.sid);
      })
      .on(RoomEvent.LocalTrackPublished, publication => { if (atual()) attachLocalPublication(publication); })
      .on(RoomEvent.LocalTrackUnpublished, publication => { if (!atual()) return; const sid = publication.track?.sid; if (sid) { detachTrack(sid); removeCamera(sid); } });
    await next.connect(access.url, access.token, { autoSubscribe: true });
    // Entrar num canal de voz ja abre o microfone, como no Discord.
    try {
      await next.localParticipant.setMicrophoneEnabled(true, voz.opcoesDeCaptura());
      await instalarGanho();
      micEnabled = true; micButton.classList.add("active"); setIcon(micButton, "mic");
    } catch {
      micEnabled = false; micButton.classList.remove("active"); setIcon(micButton, "mic-off");
      showToast("O Windows não liberou o microfone.");
    }
    // O WebView bloqueia som automatico ate haver interacao; startAudio destrava.
    audioEnabled = true; audioButton.classList.remove("active"); setIcon(audioButton, "audio");
    await unlockAudio(next);
    await applySavedDevices(next);
    void reiniciarPortao();
    // Entrar na chamada mostra quem esta nela; esconder e escolha, e o padrao
    // nao pode ser a tela vazia de quem acabou de entrar.
    palcoDaChamada = true;
    applyAllVolumes();
    renderPeople(); renderNavigation();
  } catch (error) {
    voiceRoomId = ""; renderNavigation();
    setStatus("erro de conexão", false);
    showToast(error instanceof Error ? error.message : "Não foi possível conectar ao canal de voz.");
  }
}
/// Amplificador vivo, ou `null` quando o microfone esta fechado.
let ganhoAtual: voz.GanhoDoMicrofone | null = null;

/// Poe ou tira o amplificador da faixa publicada, conforme o volume escolhido.
///
/// Acima de 100% o ganho vem daqui, e nao do Windows: o sistema so oferece o
/// que a placa entrega, e microfone de fone costuma parar baixo demais.
///
/// **Em 100% nao ha processador nenhum.** Quem nunca mexeu no controle — a
/// maioria — segue com o caminho de audio que sempre teve, sem uma peca a mais
/// entre o microfone e a chamada.
async function instalarGanho() {
  const faixa = room?.localParticipant.audioTrackPublications.values().next().value?.track;
  if (!faixa) return;
  const desejado = voz.lerGanho();

  if (desejado === 100) {
    if (ganhoAtual) {
      ganhoAtual = null;
      try { await faixa.stopProcessor(); } catch { /* ja saiu */ }
    }
    return;
  }
  if (ganhoAtual) { ganhoAtual.definir(desejado); return; }

  try {
    const amplificador = new voz.GanhoDoMicrofone();
    await faixa.setProcessor(amplificador as never);
    ganhoAtual = amplificador;
  } catch (erro) {
    // Sem o amplificador a chamada continua no volume do sistema, que e como
    // era antes deste controle existir. Tirar o processador pela metade e o
    // que garante que a faixa volte a ser a crua.
    ganhoAtual = null;
    try { await faixa.stopProcessor(); } catch { /* nem chegou a entrar */ }
    console.warn("[voz] amplificador indisponivel", erro);
    showToast("Não foi possível amplificar o microfone; ele vai no volume do sistema.");
  }
}

// ------------------------------------------------------- portao do microfone
//
// O botao de mudo diz se a pessoa **quer** falar; o portao diz se ela **esta**
// falando agora. Os dois precisam concordar antes de a faixa ir ao ar, senao a
// ativacao por voz reabriria um microfone que foi mudado de proposito.
// Fluxo de microfone usado **so para medir**, separado do que vai ao ar.
//
// O portao silencia a faixa publicada, e `mute()` do LiveKit faz
// `mediaStreamTrack.enabled = false` — faixa desligada entrega silencio. Medir
// a propria faixa publicada era um laco fechado: o portao fechava uma vez, o
// medidor passava a ler silencio, o nivel nunca mais subia e o microfone nunca
// mais abria. Este fluxo nunca e silenciado, entao continua ouvindo a pessoa
// mesmo com o portao fechado.
//
// E um so, compartilhado entre o portao e o medidor das configuracoes: abrir o
// microfone duas vezes em paralelo funciona, mas gasta a toa.
let fluxoDeMedicao: MediaStream | null = null;
let usuariosDaMedicao = 0;

async function pegarFaixaDeMedicao(): Promise<MediaStreamTrack | null> {
  usuariosDaMedicao += 1;
  // Faixa encerrada (microfone desconectado) nao volta a medir: pede outra.
  if (fluxoDeMedicao && fluxoDeMedicao.getAudioTracks()[0]?.readyState !== "live") {
    fluxoDeMedicao.getTracks().forEach(faixa => faixa.stop());
    fluxoDeMedicao = null;
  }
  if (!fluxoDeMedicao) {
    try {
      fluxoDeMedicao = await navigator.mediaDevices.getUserMedia({
        audio: voz.opcoesDeCaptura(readDevices().mic),
      });
    } catch {
      usuariosDaMedicao -= 1;
      return null;
    }
  }
  const faixa = fluxoDeMedicao.getAudioTracks()[0] || null;
  // Fluxo sem faixa de audio nao serve para nada, e quem pediu nao vai chamar
  // `soltar` — devolver a contagem aqui evita segurar o microfone para sempre.
  if (!faixa) soltarFaixaDeMedicao();
  return faixa;
}

function soltarFaixaDeMedicao() {
  usuariosDaMedicao = Math.max(0, usuariosDaMedicao - 1);
  if (usuariosDaMedicao > 0) return;
  // Soltar o microfone de verdade: sem isso o Windows mantem o aviso de "em
  // uso" depois de a chamada acabar.
  fluxoDeMedicao?.getTracks().forEach(faixa => faixa.stop());
  fluxoDeMedicao = null;
}

let pararMedidorDoPortao: (() => void) | null = null;
let portaoAberto = true;
let fecharPortaoEm = 0;
let pttPressionado = false;

/// Aplica ao vivo o que o portao decidiu, **sem contar para a sala**.
///
/// Liga e desliga a faixa crua em vez de chamar `mute()` do LiveKit. Os dois
/// deixam de enviar som, mas o `mute()` anuncia o estado para todo mundo: cada
/// silencio entre duas frases acendia o icone de microfone desligado no painel
/// dos outros, e quem estava conversando parecia estar mutando e desmutando
/// sem parar.
///
/// O mudo de verdade — o botao — continua passando pelo LiveKit, porque ali o
/// aviso e justamente o que se quer: os outros precisam saber que voce se
/// calou de proposito.
function aplicarPortao() {
  const bruta = room?.localParticipant.audioTrackPublications.values().next().value
    ?.track?.mediaStreamTrack;
  if (!bruta) return;
  bruta.enabled = micEnabled && portaoAberto;
}

/// Desliga o portao e devolve o microfone de medicao.
function pararPortao() {
  if (!pararMedidorDoPortao) return;
  pararMedidorDoPortao();
  pararMedidorDoPortao = null;
  soltarFaixaDeMedicao();
}

/// Liga o portao conforme o modo escolhido. Chamado ao entrar na chamada e
/// sempre que a configuracao muda.
async function reiniciarPortao() {
  pararPortao();
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

  // Ativacao por voz: mede o fluxo proprio, que nunca e silenciado.
  const bruta = await pegarFaixaDeMedicao();
  if (!bruta) {
    // Sem medicao nao da para decidir nada; deixar aberto e melhor do que
    // deixar a pessoa muda sem entender por que.
    portaoAberto = true;
    aplicarPortao();
    showToast("Sem acesso ao microfone para detectar a voz; ele ficará aberto.");
    return;
  }
  // A pessoa pode ter saido da chamada ou trocado de modo enquanto o Windows
  // liberava o microfone.
  if (!room || voz.lerModo() !== "voz") { soltarFaixaDeMedicao(); return; }

  portaoAberto = false;
  aplicarPortao();
  const parar = voz.medir(bruta, nivel => {
    const limiar = voz.lerLimiar();
    const agora = Date.now();
    if (nivel >= limiar) {
      fecharPortaoEm = agora + voz.CAUDA_MS;
      if (!portaoAberto) { portaoAberto = true; aplicarPortao(); }
    } else if (portaoAberto && agora >= fecharPortaoEm) {
      portaoAberto = false;
      aplicarPortao();
    }
  }, () => {
    // Medicao morta (microfone trocado ou tirado): aberto e melhor que mudo
    // sem motivo. Tenta montar de novo com o microfone que houver agora.
    portaoAberto = true;
    aplicarPortao();
    console.warn("[portao] medicao encerrou; reabrindo");
    window.setTimeout(() => { if (room && voz.lerModo() === "voz") void reiniciarPortao(); }, 1000);
  });
  pararMedidorDoPortao = parar;
}

/// Ronda que religa faixa de audio que parou de tocar.
///
/// O `play()` de cada faixa era chamado **uma vez**, na hora de anexar, e o
/// comentario dizia que o `unlockAudio` destravaria depois. So que o
/// `unlockAudio` roda no momento de entrar na chamada e tira o proprio ouvinte
/// assim que o som libera: faixa que chega **depois** nao tem quem a religue.
///
/// E ai esta o defeito que so reabrir o aplicativo resolvia. Quando alguem sai e
/// volta rapido, quem ficou na chamada recebe a faixa nova daquela pessoa e
/// chama `play()` uma vez. Se essa unica chamada falhar — a politica de
/// reproducao do WebView, o dispositivo de saida trocando, ou a propria faixa
/// sendo reanexada no mesmo instante — aquela pessoa fica muda para quem ficou,
/// e para mais ninguem. Quem ficou nao sai da chamada, entao nada reanexa nada.
///
/// A ronda varre em vez de tratar caso a caso, pelo mesmo motivo das
/// preferencias: assim ela pega tambem as causas que eu nao previ.
function rondaDeAudio() {
  window.setInterval(() => {
    if (!inCall()) return;
    // O portao geral do LiveKit tambem pode ter fechado no meio do caminho.
    if (room && !room.canPlaybackAudio) void room.startAudio().catch(() => { /* proxima volta */ });
    for (const el of document.querySelectorAll<HTMLAudioElement>("audio[data-naoconcordo-audio]")) {
      // Pausado de proposito nao existe aqui: silenciar e `muted`, nao `pause`.
      if (!el.paused || el.ended) continue;
      void el.play().catch(() => { /* proxima volta */ });
    }
  }, 3000);

  // Interacao do usuario e o que a politica de reproducao espera: aproveita.
  const religar = () => {
    for (const el of document.querySelectorAll<HTMLAudioElement>("audio[data-naoconcordo-audio]")) {
      if (el.paused && !el.ended) void el.play().catch(() => { /* segue */ });
    }
  };
  document.addEventListener("click", religar);
  document.addEventListener("keydown", religar);
}
rondaDeAudio();

/// Desde quando a sala esta em `Reconnecting`, ou 0.
let reconectandoDesde = 0;
/// Pessoas cuja voz parou de chegar, para o diagnostico.
const vozesParadas = new Set<string>();

/// Vigia de midia: faz sozinho o que "sair e entrar na call" fazia na mao.
///
/// Em 2026-09-12 o LINKZIN ficou 31 minutos na sala sem midia nenhuma: o
/// servidor o mantinha la porque o SDK seguia tentando retomar a sessao, e
/// ninguem ouvia ninguem entre ele e o resto ate ele reentrar. Outras reentradas
/// do dia nao deixaram rastro no servidor — o transporte estava de pe e a voz
/// nao chegava. A ronda de audio nao pega nenhum dos dois: o elemento estava
/// tocando, so que sem pacote.
///
/// Por isso a medida e **pacote**, nao estado de elemento nem de conexao. Opus
/// com DTX manda pacote mesmo em silencio (e com o portao de voz fechado), entao
/// contador parado quer dizer midia parada, nao pessoa quieta.
///
/// Escada: faixa parada -> reassina so ela; continua parada, ou o proprio envio
/// parou, ou a reconexao nao termina -> reentra na chamada. Leitura que falha
/// conta como "nao sei", nunca como parada: vigia com falso positivo derrubaria
/// a chamada de quem esta bem.
function vigiaDeMidia() {
  const PARADA_MS = 10_000;
  const ultimo = new Map<string, { pacotes: number; desde: number }>();
  const reassinadaEm = new Map<string, number>();
  let reentrouEm = 0;

  /// Contador lido agora e ha quanto tempo ele nao muda; `null` se nao deu para ler.
  const parada = (chave: string, pacotes: number | null, agora: number) => {
    if (pacotes === null) { ultimo.delete(chave); return 0; }
    const antes = ultimo.get(chave);
    if (!antes || antes.pacotes !== pacotes) { ultimo.set(chave, { pacotes, desde: agora }); return 0; }
    return agora - antes.desde;
  };
  const contar = async (relatorio: RTCStatsReport | undefined, tipo: "inbound-rtp" | "outbound-rtp") => {
    if (!relatorio) return null;
    let total: number | null = null;
    relatorio.forEach(item => {
      if (item.type !== tipo || item.kind !== "audio") return;
      const n = tipo === "inbound-rtp" ? item.packetsReceived : item.packetsSent;
      if (typeof n === "number") total = (total ?? 0) + n;
    });
    return total;
  };

  const reentrar = async (motivo: string) => {
    const canal = voiceRoomId;
    if (!canal || Date.now() - reentrouEm < 90_000) return;
    reentrouEm = Date.now();
    console.warn("[vigia] reentrando:", motivo);
    showToast("A chamada travou. Reconectando.");
    await sairDaChamada();
    voiceRoomId = canal; announceVoice(canal); renderNavigation(); updateCallControls();
    await connectVoice();
  };

  window.setInterval(async () => {
    const sala = room;
    if (!sala || !voiceRoomId) { ultimo.clear(); vozesParadas.clear(); reconectandoDesde = 0; return; }
    const agora = Date.now();
    if (reconectandoDesde && agora - reconectandoDesde > 20_000) { await reentrar("reconexao sem fim"); return; }
    if (sala.state !== "connected") return;

    const vivas = new Set<string>();
    let remotas = 0, remotasParadas = 0, precisaReentrar = "";
    for (const participante of sala.remoteParticipants.values()) {
      const pub = participante.getTrackPublication(Track.Source.Microphone) as RemoteTrackPublication | undefined;
      if (!pub || pub.isMuted || !pub.isDesired) continue;
      const chave = "in:" + pub.trackSid;
      vivas.add(chave);
      let pacotes: number | null = null;
      try { pacotes = pub.track ? await contar(await pub.track.getRTCStatsReport(), "inbound-rtp") : 0; } catch { pacotes = null; }
      // Sem faixa nenhuma o contador fica em zero, e zero parado tambem conta.
      const ms = parada(chave, pacotes, agora);
      remotas++;
      const who = participante.name || participante.identity;
      if (ms < PARADA_MS) { vozesParadas.delete(who); continue; }
      remotasParadas++;
      vozesParadas.add(who);
      const tentou = reassinadaEm.get(pub.trackSid) || 0;
      if (agora - tentou > 60_000) {
        reassinadaEm.set(pub.trackSid, agora);
        ultimo.delete(chave);
        console.warn("[vigia] voz parada, reassinando:", who);
        void pub.setSubscribed(false);
        window.setTimeout(() => { if (room === sala) void pub.setSubscribed(true); }, 500);
      } else if (agora - tentou > PARADA_MS * 2) {
        precisaReentrar = "voz de " + who + " nao voltou ao reassinar";
      }
    }
    for (const chave of ultimo.keys()) if (chave.startsWith("in:") && !vivas.has(chave)) ultimo.delete(chave);

    const mic = sala.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    if (micEnabled && mic) {
      let enviados: number | null = null;
      try { enviados = await contar(await mic.getRTCStatsReport(), "outbound-rtp"); } catch { enviados = null; }
      if (parada("out", enviados, agora) >= PARADA_MS) precisaReentrar ||= "microfone parou de enviar";
    } else {
      ultimo.delete("out");
    }
    if (remotas >= 2 && remotasParadas === remotas) precisaReentrar ||= "nenhuma voz chegando";
    if (room !== sala) return;
    if (precisaReentrar) await reentrar(precisaReentrar);
  }, 4000);
}
vigiaDeMidia();

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
    if (ligado) await instalarGanho();
    // A faixa nasce aberta; o portao decide se ela continua assim.
    void reiniciarPortao();
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
    }, escolha.audio, forcarDuplicacao(), escolha.semBarra, codecPreferido(), escolha.audioSource,
       escolha.audioGain);
    // Cair para o processador nao e erro, mas e a informacao que faltou quando
    // a primeira maquina de fora nao conseguiu compartilhar: sem console num
    // build de release, se ninguem disser, ninguem descobre.
    console.info("[tela]", ondeComprimiu);
    // O motivo vai junto no aviso, e nao so no console. Quem esta do outro lado
    // do país não tem como abrir o console, e sem o motivo o relato chega como
    // "não funciona" — que foi exatamente o que aconteceu duas vezes.
    const queda = ondeComprimiu.split("compressão software:")[1];
    if (queda !== undefined) {
      showToast("A placa não assumiu a compressão:" + queda + ". Usando o processador.");
    } else {
      void vigiarPrimeirosQuadros();
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

/// A placa aceitou comprimir — mas esta comprimindo?
///
/// Codificador de hardware pode abrir, passar no teste e ainda assim nao
/// produzir quadro nenhum. Quando isso acontece nao ha erro em lugar nenhum: a
/// faixa e publicada, quem assiste ve preto e quem transmite acha que esta
/// tudo certo. Foi assim que um defeito passou despercebido por tres versoes.
///
/// Cinco segundos depois de comecar, se nenhum quadro saiu, o aplicativo diz o
/// que fazer em vez de deixar a pessoa descobrir pelo silencio dos outros.
async function vigiarPrimeirosQuadros() {
  await new Promise(resolve => window.setTimeout(resolve, 5000));
  if (!screenEnabled) return;
  try {
    const envio = await invoke<EstatisticasEnvio | null>("screen_share_stats");
    if (envio && envio.quadros === 0) {
      showToast(
        "A placa de vídeo não está produzindo imagem. Em Configurações → "
        + "Compartilhar tela, escolha Software e comece de novo.",
      );
    }
  } catch { /* a transmissao pode ter parado nesse meio tempo */ }
}

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
  // Quem esta reforcado sai pelo ganho, e ganho nao escuta `muted` de elemento.
  applyAllVolumes();
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
    void audio.play().catch(() => { /* a ronda abaixo tenta de novo */ });
  } else if (track.source === Track.Source.ScreenShare) {
    attachVideo(track, who);
    if (track.sid) telasVistas.set(track.sid, { sid: track.sid, label: who, attach: () => track.attach() });
    renderCameraMini();
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

/// As telas que estao sendo assistidas, para o quadradinho poder mostrar uma.
///
/// As tiles de tela vivem soltas no palco, sem registro — o que basta enquanto
/// so o palco as desenha. O quadradinho precisa desenhar a mesma faixa noutro
/// lugar, e procurar `<video>` dentro do DOM do palco para roubar de la seria
/// prender um ao outro.
type TelaAssistida = { sid: string; label: string; attach: () => HTMLMediaElement };
const telasVistas = new Map<string, TelaAssistida>();
const cameras = new Map<string, CameraTrack>();

// Quem esta falando agora, por nome. O anel vermelho sai daqui.
const speaking = new Set<string>();
/// Marca sem redesenhar: recriar as tiles cortaria o video no meio da fala.
/// `#rrggbb` e nada mais.
///
/// O servidor ja valida, mas quem desenha e este lado: uma cor guardada antes
/// da validacao existir, ou vinda de outro caminho, nao pode virar texto solto
/// dentro de um estilo.
function corSegura(valor: string | null | undefined): string | null {
  return valor && /^#[0-9a-f]{6}$/i.test(valor) ? valor : null;
}

function updateSpeakingStyles() {
  document.querySelectorAll<HTMLElement>("[data-who]").forEach(element => {
    const quem = element.dataset.who || "";
    element.classList.toggle("speaking", speaking.has(key(quem)));
    // A cor acompanha a pessoa, e nao o lugar onde ela aparece: a mesma pessoa
    // tem o mesmo anel na lista, na camera e na miniatura.
    const cor = corSegura(profiles.get(key(quem))?.color);
    if (cor) element.style.setProperty("--anel", cor);
    else element.style.removeProperty("--anel");
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
/// Quadro de quem esta na chamada sem camera: foto grande, nome embaixo, e o
/// anel de fala em volta como qualquer outra tile.
///
/// Sem isto, uma chamada em que ninguem liga a camera deixava o palco vazio, e
/// so dava para saber quem estava pela lista lateral. O quadro nao substitui a
/// lista — ele mostra a conversa acontecendo.
function tileDeVoz(nome: string) {
  const tile = document.createElement("div");
  tile.id = "voz-" + key(nome);
  tile.className = "track-tile tile-voz";
  tile.dataset.who = nome;

  const foto = document.createElement("div");
  foto.className = "avatar tile-voz-foto";
  paintAvatar(foto, nome);

  const label = document.createElement("label");
  label.textContent = getDisplayName(nome);

  tile.append(foto, label);
  tile.oncontextmenu = event => {
    event.preventDefault();
    event.stopPropagation();
    openUserMenu(nome, tile, { x: event.clientX, y: event.clientY });
  };
  return tile;
}

function renderCameras() {
  // O palco e compartilhado com as transmissoes de tela, entao aqui so podem
  // sair as tiles de camera e de voz: um `replaceChildren` levaria as telas
  // junto.
  for (const antiga of [
    ...stage.querySelectorAll('[id^="cam-"]'),
    ...stage.querySelectorAll('[id^="voz-"]'),
    byId("camera-hidden-note"),
  ]) {
    if (antiga) antiga.remove();
  }
  const todas = [...cameras.values()];
  const visiveis = todas.filter(entry => !camerasOcultas.has(entry.sid));
  const escondidas = todas.length - visiveis.length;

  for (const entry of visiveis) stage.append(cameraTile(entry));

  // Quem esta na chamada e nao aparece com camera entra com a foto. Assim o
  // palco mostra a chamada inteira, e nao so quem ligou a webcam.
  if (chamadaNaTela() && palcoDaChamada) {
    const comCamera = new Set(visiveis.map(entry => key(entry.who)));
    for (const nome of callParticipants()) {
      if (comCamera.has(key(nome))) continue;
      stage.append(tileDeVoz(nome));
    }
  }

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
/// Onde a pessoa largou o quadradinho, se largou em algum lugar.
///
/// Fica so nesta maquina: e uma coordenada em pixels, e a tela do outro
/// computador tem outro tamanho — levar junto poria o quadro fora do alcance.
const MINI_KEY = "naoconcordo.mini-posicao";
type PontoDoMini = { x: number; y: number };
function miniGuardado(): PontoDoMini | null {
  try { return JSON.parse(localStorage.getItem(MINI_KEY) || "null") as PontoDoMini | null; }
  catch { return null; }
}

/// Mantem o quadradinho dentro da janela.
///
/// Sem isto, diminuir a janela depois de ter arrastado o quadro para a beirada
/// o deixaria fora da tela, sem jeito de trazer de volta.
function encaixarMini(x: number, y: number): PontoDoMini {
  const caixa = byId("camera-mini");
  const largura = caixa.offsetWidth || 232;
  const altura = caixa.offsetHeight || 130;
  const pai = caixa.offsetParent as HTMLElement | null;
  const limite = pai ? pai.getBoundingClientRect() : { width: window.innerWidth, height: window.innerHeight };
  return {
    x: Math.max(8, Math.min(x, limite.width - largura - 8)),
    y: Math.max(8, Math.min(y, limite.height - altura - 8)),
  };
}

function posicionarCameraMini() {
  const caixa = byId("camera-mini");
  const escolhido = miniGuardado();
  if (escolhido) {
    const dentro = encaixarMini(escolhido.x, escolhido.y);
    caixa.style.left = dentro.x + "px";
    caixa.style.top = dentro.y + "px";
    caixa.style.right = "auto";
    caixa.style.bottom = "auto";
    return;
  }
  // Sem escolha da pessoa: em cima do redator, como sempre esteve.
  const redator = [byId("message-form"), byId("dm-form")]
    .find(form => !form.classList.contains("hidden"));
  const altura = redator ? redator.getBoundingClientRect().height : 82;
  caixa.style.left = "auto";
  caixa.style.top = "auto";
  caixa.style.right = "18px";
  caixa.style.bottom = Math.round(altura + 14) + "px";
}

/// Deixa o quadradinho ser arrastado pelo mouse.
///
/// Ligado uma vez so, no elemento que nunca e recriado: o conteudo de dentro
/// troca a cada faixa nova, e pendurar isso ali perderia o arrasto no meio.
function permitirArrastarMini() {
  const caixa = byId("camera-mini");
  let solto: ((evento: PointerEvent) => void) | null = null;

  caixa.addEventListener("pointerdown", evento => {
    // Os botoes de dentro continuam clicaveis: arrastar comeca no fundo.
    if ((evento.target as HTMLElement).closest("button")) return;
    if (evento.button !== 0) return;
    const caixaAgora = caixa.getBoundingClientRect();
    const pai = (caixa.offsetParent as HTMLElement | null)?.getBoundingClientRect();
    const deslocX = evento.clientX - caixaAgora.left;
    const deslocY = evento.clientY - caixaAgora.top;
    let moveu = false;
    caixa.setPointerCapture(evento.pointerId);
    caixa.classList.add("arrastando");

    const mover = (movimento: PointerEvent) => {
      moveu = true;
      const ponto = encaixarMini(
        movimento.clientX - deslocX - (pai?.left || 0),
        movimento.clientY - deslocY - (pai?.top || 0),
      );
      caixa.style.left = ponto.x + "px";
      caixa.style.top = ponto.y + "px";
      caixa.style.right = "auto";
      caixa.style.bottom = "auto";
    };
    solto = (fim: PointerEvent) => {
      caixa.releasePointerCapture(fim.pointerId);
      caixa.classList.remove("arrastando");
      caixa.removeEventListener("pointermove", mover);
      if (solto) caixa.removeEventListener("pointerup", solto);
      solto = null;
      // Clique sem movimento nao vira posicao nova.
      if (!moveu) return;
      localStorage.setItem(MINI_KEY, JSON.stringify({
        x: parseInt(caixa.style.left, 10) || 0,
        y: parseInt(caixa.style.top, 10) || 0,
      }));
    };
    caixa.addEventListener("pointermove", mover);
    caixa.addEventListener("pointerup", solto);
  });

  // Janela redimensionada pode ter deixado o quadro para fora.
  window.addEventListener("resize", () => {
    if (!byId("camera-mini").classList.contains("hidden")) posicionarCameraMini();
  });
}
permitirArrastarMini();

/// O quadradinho que segue a chamada quando voce sai do servidor dela.
///
/// Mostra **a tela que voce esta assistindo**, e so cai para uma camera quando
/// nao ha tela nenhuma. Trocar de servidor no meio de uma transmissao abria uma
/// janela inteira antes, o que e resposta grande demais para quem so foi ler uma
/// mensagem noutro lugar.
function renderCameraMini() {
  const caixa = byId("camera-mini");
  const telas = [...telasVistas.values()].filter(entry => assistindo.has(entry.sid));
  const rostos = [...cameras.values()].filter(entry => !camerasOcultas.has(entry.sid));
  // Com a janela separada aberta aquilo ja esta noutro lugar; repetir aqui so
  // gastaria banda desenhando a mesma coisa duas vezes.
  const temTela = telas.length > 0 && !screenWindowOpen;
  const temRosto = rostos.length > 0 && !cameraWindowOpen;
  const mostrar = !chamadaNaTela() && (temTela || temRosto);
  caixa.classList.toggle("hidden", !mostrar);
  caixa.classList.toggle("mini-tela", mostrar && temTela);
  if (!mostrar) {
    caixa.replaceChildren();
    miniAtual = "";
    return;
  }

  let escolhida: { sid: string; label: string; who?: string; attach: () => HTMLMediaElement };
  if (temTela) {
    // Tela ganha da camera: quem saiu do servidor no meio de uma transmissao
    // quer continuar vendo a transmissao, nao o rosto de quem narra.
    escolhida = telas.find(entry => entry.sid === miniAtual) || telas[0];
  } else {
    const falando = rostos.find(entry => speaking.has(key(entry.who)));
    // Sem ninguem falando, fica quem ja estava: trocar sozinho a cada silencio
    // daria um piscar constante no canto da tela.
    escolhida = falando || rostos.find(entry => entry.sid === miniAtual) || rostos[0];
  }
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
    // Virar janela continua existindo, mas agora e escolha de quem clica.
    if (temTela) {
      abrirMenuSimples(caixa, { x: event.clientX, y: event.clientY }, [
        menuAcao("Abrir numa janela", "window", () => void openScreenWindow()),
      ]);
      return;
    }
    openUserMenu(escolhida.who || escolhida.label, caixa, { x: event.clientX, y: event.clientY }, [
      menuAcao("Virar janela", "window", () => void openCameraWindow()),
    ]);
  };
}

/// Um menu de acoes que nao pertence a ninguem — o de tela, por exemplo.
function abrirMenuSimples(ancora: HTMLElement, ponto: { x: number; y: number }, acoes: HTMLElement[]) {
  closeUserMenu();
  const menu = document.createElement("div");
  menu.className = "user-menu";
  menu.append(...acoes);
  montarMenu(menu, ancora, ponto);
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
      // Mesmo motivo da janela de telas: `instalarBarra` ja desenha a barra
      // daqui, e a moldura do Windows por cima dava dois botoes de fechar.
      decorations: false,
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
      // Sem a moldura do Windows: `instalarBarra` desenha a barra do proprio
      // aplicativo nesta pagina, e as duas juntas davam dois botoes de fechar.
      decorations: false,
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
  const meuPerfil = profiles.get(key(session?.username || ""));
  corEscolhida = corSegura(meuPerfil?.color);
  pintarEscolhaDeCor();
  byId<HTMLDialogElement>("profile-edit-dialog").showModal();
});

/// Cor do anel escolhida no editor. `null` quer dizer "a padrao", que e
/// diferente de uma cor igual a padrao: quem nunca escolheu segue o app se um
/// dia o padrao mudar.
let corEscolhida: string | null = null;

function pintarEscolhaDeCor() {
  const campo = byId<HTMLInputElement>("profile-edit-cor");
  const amostra = byId("profile-edit-cor-amostra");
  campo.value = corEscolhida || "#e5484d";
  amostra.style.setProperty("--anel", corEscolhida || "#e5484d");
  byId("profile-edit-cor-limpar").classList.toggle("hidden", !corEscolhida);
}

byId<HTMLInputElement>("profile-edit-cor")?.addEventListener("input", event => {
  corEscolhida = corSegura((event.currentTarget as HTMLInputElement).value);
  pintarEscolhaDeCor();
});
byId("profile-edit-cor-limpar")?.addEventListener("click", () => {
  corEscolhida = null;
  pintarEscolhaDeCor();
});

byId("profile-edit-bio")?.addEventListener("input", e => {
  const target = e.target as HTMLTextAreaElement;
  byId("profile-edit-bio-count").textContent = `${target.value.length} / 190`;
});

byId("profile-edit-banner-btn")?.addEventListener("click", () => {
  byId<HTMLInputElement>("profile-edit-banner-input").click();
});

byId<HTMLInputElement>("profile-edit-banner-input")?.addEventListener("change", async event => {
  const escolhido = (event.currentTarget as HTMLInputElement).files?.[0];
  if (!escolhido) return;
  const file = await recortarImagem(escolhido, { proporcao: 16 / 6, titulo: "Enquadrar o banner do perfil" });
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
    const payload: { bio?: string | null; bannerFile?: string | null; color?: string | null } = {
      bio: bio || null,
      color: corEscolhida,
    };
    if (profileEditBannerChanged) payload.bannerFile = profileEditBannerFileId;
    const updated = await api<Profile>("/api/profile", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    profiles.set(updated.username.toLowerCase(), updated);
    paintMyAvatars(updated.username);
    // O anel muda na hora, sem esperar a proxima vez que alguem falar.
    updateSpeakingStyles();
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
  const escolhido = (event.currentTarget as HTMLInputElement).files?.[0];
  if (!escolhido) return;
  const file = await recortarImagem(escolhido, { proporcao: 16 / 6, titulo: "Enquadrar o banner do servidor" });
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
  const escolhido = (event.currentTarget as HTMLInputElement).files?.[0];
  if (!escolhido) return;
  const file = await recortarImagem(escolhido, { proporcao: 1, titulo: "Enquadrar o ícone do servidor", redondo: true });
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
  const escolhido = (event.currentTarget as HTMLInputElement).files?.[0];
  if (!escolhido) return;
  const file = await recortarImagem(escolhido, { proporcao: 1, titulo: "Enquadrar a foto neste servidor", redondo: true });
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
// ----------------------------------------------------- abrir com o Windows
// Quem manda e o registro do Windows, e nao um ajuste guardado aqui: alguem
// pode ter tirado o naoconcordo da inicializacao por fora, e o interruptor tem
// de contar a verdade quando as configuracoes abrem.
async function pluginDeInicio() {
  if (!ehTauri()) return null;
  try {
    return await import("@tauri-apps/plugin-autostart");
  } catch {
    return null;
  }
}

/// Marca de que a escolha inicial ja foi feita nesta instalacao.
const INICIO_DECIDIDO = "naoconcordo.inicio-automatico-decidido";

/// Deixa a abertura automatica ligada na primeira vez, e **so** na primeira.
///
/// Sem a marca, todo arranque tornaria a ligar o que a pessoa acabou de
/// desmarcar — o aplicativo discutindo com quem o usa. A marca e gravada antes
/// de tentar ligar: se o Windows recusar, o certo e desistir e nao insistir a
/// cada abertura.
async function decidirAberturaInicial() {
  if (localStorage.getItem(INICIO_DECIDIDO)) return;
  const plugin = await pluginDeInicio();
  if (!plugin) return;
  localStorage.setItem(INICIO_DECIDIDO, "1");
  try {
    if (!(await plugin.isEnabled())) await plugin.enable();
  } catch (erro) {
    console.warn("[inicio] nao deu para ligar na primeira vez", erro);
  }
}

async function carregarAberturaAutomatica() {
  const linha = byId("abrir-com-windows").closest(".switch-row") as HTMLElement | null;
  const plugin = await pluginDeInicio();
  if (!plugin) {
    // No navegador nao ha inicializacao do sistema para ligar.
    linha?.classList.add("hidden");
    byId("abrir-com-windows-nota").textContent = "Disponível no aplicativo instalado.";
    return;
  }
  try {
    byId<HTMLInputElement>("abrir-com-windows").checked = await plugin.isEnabled();
  } catch (erro) {
    console.warn("[inicio] nao deu para ler o estado", erro);
  }
}

byId<HTMLInputElement>("abrir-com-windows").addEventListener("change", async event => {
  const caixa = event.currentTarget as HTMLInputElement;
  const plugin = await pluginDeInicio();
  if (!plugin) return;
  // Mexeu no interruptor: a escolha e dela daqui em diante.
  localStorage.setItem(INICIO_DECIDIDO, "1");
  try {
    if (caixa.checked) await plugin.enable(); else await plugin.disable();
    // Relido do sistema: se o Windows recusou, o interruptor volta sozinho em
    // vez de mentir que ficou ligado.
    caixa.checked = await plugin.isEnabled();
  } catch (erro) {
    caixa.checked = !caixa.checked;
    showToast(erro instanceof Error ? erro.message : "Não foi possível mudar a inicialização.");
  }
});

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
  void carregarAberturaAutomatica();
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
  falhaCaptura: string | null; falhaEncoder: string | null;
  chaves: number; pedidosDeChave: number;
  chegados: number; foraDeRitmo: number; entregues: number; repetidos: number;
};

/// Leitura anterior do caminho do quadro, para mostrar taxa em vez de total.
///
/// Total acumulado nao se compara com a taxa pedida: sessenta por segundo em
/// dez minutos e trinta e seis mil, e ninguem divide isso de cabeca enquanto
/// olha a tela travar. A diferenca entre duas leituras, dividida pelo tempo
/// entre elas, sai no mesmo numero que se pediu nas configuracoes.
let caminhoAnterior:
  | { t: number; chegados: number; foraDeRitmo: number; entregues: number; repetidos: number }
  | null = null;

/// Quadros por segundo em cada etapa, ou `null` na primeira leitura, que nao
/// tem com o que comparar.
function taxasDoCaminho(envio: EstatisticasEnvio) {
  const agora = performance.now();
  const antes = caminhoAnterior;
  caminhoAnterior = {
    t: agora, chegados: envio.chegados, foraDeRitmo: envio.foraDeRitmo,
    entregues: envio.entregues, repetidos: envio.repetidos,
  };
  if (!antes) return null;
  const segundos = (agora - antes.t) / 1000;
  // Janela curta demais transforma um quadro de diferenca em vinte de taxa.
  if (segundos < 0.5) { caminhoAnterior = antes; return null; }
  const porSegundo = (atual: number, anterior: number) => Math.round((atual - anterior) / segundos);
  return {
    chegados: porSegundo(envio.chegados, antes.chegados),
    foraDeRitmo: porSegundo(envio.foraDeRitmo, antes.foraDeRitmo),
    entregues: porSegundo(envio.entregues, antes.entregues),
    repetidos: porSegundo(envio.repetidos, antes.repetidos),
  };
}

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
        // Imagem esfarelada e decodificador sem quadro de referencia. Estes
        // dois numeros dizem onde o conserto esta falhando: pedido chegando e
        // imagem ainda quebrada aponta para o que o codificador produz; pedido
        // que nao chega aponta para o caminho de volta do WebRTC.
        linhas.push(
          "       chaves: " + envio.chaves
          + "  pedidas por quem assiste: " + envio.pedidosDeChave,
        );
        // O caminho do quadro, para a taxa abaixo do pedido ter dono. `tela` e
        // o teto: se ja vem baixo dali, o conserto nao esta neste programa.
        const taxas = taxasDoCaminho(envio);
        if (taxas) {
          linhas.push(
            "       quadros/s  tela: " + taxas.chegados
            + "  fora de ritmo: " + taxas.foraDeRitmo
            + "  repetidos: " + taxas.repetidos
            + "  total: " + (taxas.entregues + taxas.repetidos),
          );
        }
        if (envio.falhaCaptura) linhas.push("       CAPTURA PAROU: " + envio.falhaCaptura);
        if (envio.falhaEncoder) linhas.push("       CODIFICADOR PAROU: " + envio.falhaEncoder);
      }
    } catch { /* a transmissao pode ter parado entre a checagem e a chamada */ }
  }
  // Faixa de audio pausada e a pessoa que voce nao ouve. Aqui em cima, sempre
  // visivel: e o numero que separa "nao ouco fulano" de "fulano nao esta
  // falando", e sem ele a conversa vira adivinhacao.
  const faixas = [...document.querySelectorAll<HTMLAudioElement>("audio[data-naoconcordo-audio]")];
  const paradas = faixas.filter(el => el.paused && !el.ended);
  if (faixas.length) {
    linhas.push(
      "OUVE   " + faixas.length + " faixa(s)"
      + (paradas.length ? "  PARADAS: " + paradas.map(el => el.dataset.who || "?").join(", ") : "  todas tocando")
      + (room && !room.canPlaybackAudio ? "  (som bloqueado pelo sistema)" : ""),
    );
  }
  // Pausado e elemento; isto aqui e pacote. Elemento tocando sem pacote era o
  // caso que so reentrar resolvia.
  if (vozesParadas.size) linhas.push("SEM PACOTE  " + [...vozesParadas].join(", "));
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
  // `showToast` ganhou um segundo parametro de acao; o verificador chama com
  // (texto, notas), entao vai um embrulho que ignora as notas.
  if (marcado) void checkForUpdate(texto => showToast(texto));
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

// ------------------------------------------------------ barra de titulo
//
// A moldura do Windows sai e esta barra fica no lugar. O ganho nao e altura —
// e a mesma faixa —, e sim ela deixar de ser espaco morto: passa a dizer em
// que servidor voce esta.
//
// No navegador nao existe: quem desenha a janela la e o proprio navegador.
function pintarBarraDeTitulo(servidor?: ServerInfo) {
  const barra = byId("titlebar");
  if (!ehTauri()) { barra.classList.add("hidden"); return; }
  barra.classList.remove("hidden");

  const nome = byId("titlebar-nome");
  const icone = byId("titlebar-icone");
  nome.textContent = servidor?.name || "naoconcordo";

  icone.style.backgroundImage = "";
  icone.textContent = "";
  if (!servidor) return;
  if (servidor.iconFile) {
    const arquivo = servidor.iconFile;
    const cache = blobCache.get(arquivo);
    if (cache) icone.style.backgroundImage = 'url("' + cache + '")';
    else void fileUrl(arquivo).then(url => { icone.style.backgroundImage = 'url("' + url + '")'; })
      .catch(() => { icone.textContent = servidor.name.slice(0, 1).toUpperCase(); });
  } else {
    icone.textContent = servidor.name.slice(0, 1).toUpperCase();
  }
}

/// Liga os tres botoes. O `data-tauri-drag-region` do HTML cuida de arrastar e
/// do duplo clique; aqui so ficam os cliques diretos.
async function ligarBotoesDaJanela() {
  if (!ehTauri()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const janela = getCurrentWindow();
    byId("win-min").onclick = () => void janela.minimize();
    byId("win-max").onclick = () => void janela.toggleMaximize();
    // Fechar segue a mesma regra do X da moldura: a bandeja continua com o
    // aplicativo vivo, entao nao ha nada a confirmar aqui.
    byId("win-close").onclick = () => void janela.close();
  } catch (erro) {
    console.warn("[janela] controles indisponiveis", erro);
  }
}
void ligarBotoesDaJanela();

// ----------------------------------------------- menu do sistema, fora
//
// O menu do WebView2 e do Edge, nao nosso: oferece recarregar, salvar como e o
// endereco interno das imagens, e nada disso faz sentido aqui dentro. Onde ha
// menu proprio ele ja aparece; o resto e silenciado.
//
// Campo de texto fica de fora: copiar, colar e a correcao ortografica do
// sistema sao uteis e nao ha substituto nosso para eles.
document.addEventListener("contextmenu", event => {
  const alvo = event.target as HTMLElement | null;
  if (alvo?.closest("input, textarea, [contenteditable='true']")) return;

  // Link ganha menu proprio: sem isso perderiamos "copiar endereco", a unica
  // coisa do menu do navegador que fazia falta.
  const link = alvo?.closest<HTMLAnchorElement>("a[href]");
  if (link) {
    event.preventDefault();
    closeUserMenu();
    const menu = document.createElement("div");
    menu.className = "user-menu";
    const titulo = document.createElement("strong");
    titulo.className = "user-menu-title";
    titulo.textContent = link.href.slice(0, 60) + (link.href.length > 60 ? "…" : "");
    const endereco = link.href;
    menu.append(titulo);
    menu.append(menuAcao("Copiar link", "link", () => {
      void navigator.clipboard.writeText(endereco)
        .then(() => showToast("Link copiado."))
        .catch(() => showToast(endereco));
    }));
    menu.append(menuAcao("Abrir", "spark", () => void abrirExterno(endereco)));
    montarMenu(menu, link, { x: event.clientX, y: event.clientY });
    return;
  }

  event.preventDefault();
});

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

function pararMedidorDoDialogo() {
  if (!pararMedidorLocal) return;
  pararMedidorLocal();
  pararMedidorLocal = null;
  soltarFaixaDeMedicao();
  byId("mic-meter-fill").style.width = "0%";
}

async function ligarMedidorDoDialogo() {
  pararMedidorDoDialogo();
  const barra = byId("mic-meter");
  const preenchimento = byId("mic-meter-fill");
  const nota = byId("mic-meter-nota");

  // Mesmo fluxo do portao, e nao a faixa publicada: em "ao falar" a publicada
  // fica silenciada enquanto ninguem fala, e a barra viveria zerada justamente
  // quando a pessoa esta ali para ajustar o limiar.
  const faixa = await pegarFaixaDeMedicao();
  if (!faixa) {
    nota.textContent = "O Windows não liberou o microfone para o teste.";
    return;
  }
  nota.textContent = "Fale para ver o nível. A marca clara é o ponto em que o microfone abre.";
  pararMedidorLocal = voz.medir(faixa, nivel => {
    preenchimento.style.width = nivel + "%";
    // Fora da ativacao por voz nao ha "fechado": o microfone vai inteiro.
    const porVoz = voz.lerModo() === "voz";
    barra.classList.toggle("fechado", porVoz && nivel < voz.lerLimiar());
  });
}

/// Poe a marca do limiar sobre a barra e mostra o controle so quando ele vale.
function pintarGanho() {
  const valor = voz.lerGanho();
  byId<HTMLInputElement>("voz-ganho").value = String(valor);
  byId("voz-ganho-valor").textContent = valor === 100
    ? "100% — como o Windows entrega"
    : valor + "% — o aplicativo amplifica " + (valor / 100).toFixed(1) + " vezes";
}

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
  void reiniciarPortao();
  void registrarAtalhos();
  // O medidor do dialogo acompanha a troca de modo: em "ao falar" ele passa a
  // mostrar onde o microfone abre.
  void ligarMedidorDoDialogo();
});
byId<HTMLInputElement>("voz-ganho").addEventListener("input", event => {
  const valor = Number((event.currentTarget as HTMLInputElement).value);
  voz.guardarGanho(valor);
  pintarGanho();
  // Ao vivo: quem esta na chamada nao ouve corte enquanto a barra e arrastada.
  // `instalarGanho` tambem poe e tira o processador ao cruzar os 100%.
  void instalarGanho();
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
  pintarGanho();
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
  // De proposito sem `data-who`: o anel de "esta falando" e para rosto, e a
  // tile de tela nao e o rosto de ninguem. Sem a marca, `updateSpeakingStyles`
  // nao a alcanca.
  
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
  // Faixa que saiu nao esta mais reforcada. O registro precisa acompanhar: se
  // a pessoa voltasse com um `sid` reaproveitado, `rotearReforco` acharia que o
  // desvio ja estava montado e nao o refaria.
  reforcadas.delete(sid);
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

/// Cartao de previa de um link, montado pelo servidor.
///
/// O servidor busca titulo, autor e miniatura e devolve enderecos **nossos**
/// para a midia; nada aqui fala com o YouTube nem com o Twitter. Isso mantem a
/// politica de conteudo da janela fechada na propria origem e evita avisar
/// aqueles sites de que alguem leu a conversa.
type CartaoDeLink = {
  fonte: "youtube" | "twitter";
  titulo: string; autor: string; texto: string;
  imagem: string; video: string; link: string;
};

/// O que o servidor ja respondeu, por endereco.
///
/// Uma mensagem e redesenhada muitas vezes — alguem entra na chamada, alguem
/// muda de mudo — e sem isto cada redesenho pediria o cartao de novo.
const cartoesVistos = new Map<string, CartaoDeLink | null>();

async function montarCartao(url: string, into: HTMLElement) {
  let dados = cartoesVistos.get(url);
  if (dados === undefined) {
    try {
      dados = await api<CartaoDeLink | undefined>("/api/previa?url=" + encodeURIComponent(url)) || null;
    } catch { dados = null; }
    cartoesVistos.set(url, dados);
  }
  if (!dados) return;
  // A mensagem pode ter sido redesenhada enquanto a resposta vinha; sem isto o
  // cartao entraria num pedaco de tela que ja saiu.
  if (!into.isConnected) return;

  const cartao = document.createElement("a");
  cartao.className = "cartao-link cartao-" + dados.fonte;
  cartao.href = dados.link;
  cartao.onclick = evento => {
    evento.preventDefault();
    void abrirExterno(dados!.link).catch(() => showToast("Não foi possível abrir o link."));
  };

  if (dados.imagem) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = "";
    // A imagem vem autenticada, como os anexos: `<img src>` nao manda cabecalho.
    void previaDeGif(dados.imagem).then(endereco => { img.src = endereco; }).catch(() => img.remove());
    cartao.append(img);
  }

  const texto = document.createElement("div");
  texto.className = "cartao-texto";
  const titulo = document.createElement("strong");
  titulo.textContent = dados.titulo;
  texto.append(titulo);
  if (dados.autor) {
    const autor = document.createElement("span");
    autor.className = "cartao-autor";
    autor.textContent = dados.autor;
    texto.append(autor);
  }
  if (dados.texto) {
    const corpo = document.createElement("p");
    corpo.textContent = dados.texto;
    texto.append(corpo);
  }
  cartao.append(texto);
  into.append(cartao);
}

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
  // O YouTube saiu daqui de proposito.
  //
  // O player recusava tocar dentro do aplicativo — "Erro de configuracao do
  // player, Erro 153", que e o codigo dele para nao reconhecer quem embute, e a
  // janela se apresenta como `tauri.localhost`. Em vez de brigar com isso, o
  // link vira cartao, montado em `montarCartao`: funciona igual no aplicativo e
  // no navegador, e tira um `iframe` de terceiro de dentro da janela.
  //
  // A Twitch continua aqui porque assistir ao vivo dentro da conversa e o
  // sentido dela; um cartao de canal ao vivo nao substitui.
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
/// Visualizador de imagem com zoom de verdade.
///
/// Antes daqui a imagem so era encolhida para caber na tela (`max-width` e
/// `max-height` a 100%). Numa foto grande isso mostra tudo e nao deixa ler
/// nada: nao havia como chegar perto, so como ver o conjunto pequeno.
///
/// Abre no tamanho que cabe. Clicar alterna entre esse tamanho e o tamanho real
/// da imagem, indo para o ponto que foi clicado — quem clica num detalhe quer
/// ver aquele detalhe, e nao o centro da foto. A roda aproxima em volta do
/// cursor, e com a imagem maior que a tela arrastar move.
function abrirImagem(url: string, alt = "", anexo?: StoredFile) {
  const fundo = document.createElement("div");
  fundo.className = "lightbox";

  const img = document.createElement("img");
  img.src = url;
  img.alt = alt;
  img.className = "lightbox-img";
  img.draggable = false;

  // `cabe` e a escala que faz a imagem inteira caber; nunca passa de 1, para uma
  // foto pequena nao abrir esticada e borrada.
  let cabe = 1, escala = 1, x = 0, y = 0;
  let arrastando = false, moveu = false, ultimoX = 0, ultimoY = 0;
  const MAX = 8;

  const moldura = () => ({ largura: fundo.clientWidth, altura: fundo.clientHeight });

  /// Mantem a imagem dentro da vista. Menor que a moldura, ela fica centrada;
  /// maior, ela pode correr, mas nao a ponto de deixar tarja de um lado.
  const enquadrar = () => {
    const { largura, altura } = moldura();
    const l = img.naturalWidth * escala, a = img.naturalHeight * escala;
    x = l <= largura ? (largura - l) / 2 : Math.min(0, Math.max(largura - l, x));
    y = a <= altura ? (altura - a) / 2 : Math.min(0, Math.max(altura - a, y));
  };

  const desenhar = () => {
    enquadrar();
    img.style.width = img.naturalWidth * escala + "px";
    img.style.height = img.naturalHeight * escala + "px";
    img.style.transform = "translate(" + Math.round(x) + "px," + Math.round(y) + "px)";
    // O cursor conta o que o proximo clique faz.
    const maior = escala > cabe + 0.001;
    fundo.dataset.perto = maior ? "1" : "";
    img.style.cursor = maior ? (arrastando ? "grabbing" : "grab") : "zoom-in";
  };

  /// Troca a escala mantendo parado o ponto sob o cursor. Sem isto, aproximar
  /// joga para o canto o pedaco que a pessoa estava olhando.
  const escalarEm = (nova: number, pontoX: number, pontoY: number) => {
    const limitada = Math.min(MAX, Math.max(cabe, nova));
    if (limitada === escala) return;
    const caixa = fundo.getBoundingClientRect();
    const alvoX = pontoX - caixa.left, alvoY = pontoY - caixa.top;
    x = alvoX - (alvoX - x) * (limitada / escala);
    y = alvoY - (alvoY - y) * (limitada / escala);
    escala = limitada;
    desenhar();
  };

  /// Primeira medida. Precisa da imagem carregada **e** do visualizador ja na
  /// pagina: fora do documento a moldura mede zero, e a escala sairia zerada.
  const medir = () => {
    if (!img.naturalWidth || !fundo.isConnected) return;
    const { largura, altura } = moldura();
    cabe = Math.min(1, largura / img.naturalWidth, altura / img.naturalHeight);
    escala = cabe;
    desenhar();
  };
  img.onload = medir;

  img.onclick = evento => {
    evento.stopPropagation();
    // Arrastar termina num clique; sem isto, mover a imagem mudaria o zoom.
    if (moveu) { moveu = false; return; }
    // Alterna entre caber e o tamanho real. Se a imagem ja cabe inteira em
    // tamanho real, o segundo passo e aproximar de fato, senao o clique nao
    // faria nada.
    const perto = escala > cabe + 0.001;
    escalarEm(perto ? cabe : Math.max(1, cabe * 2.5), evento.clientX, evento.clientY);
  };

  // As mesmas acoes do anexo na conversa. Sem isto, ampliar a imagem custava
  // copiar e salvar: era preciso fechar, achar a mensagem de novo e clicar com
  // o botao direito la.
  img.oncontextmenu = evento => {
    evento.preventDefault();
    evento.stopPropagation();
    if (anexo) { menuDoAnexo(anexo, evento, true); return; }

    // Imagem que veio de um link na mensagem: nao ha anexo no servidor, entao o
    // que se pode oferecer e o proprio endereco. Sem este caso o botao direito
    // aqui nao faria nada, ja que o menu do sistema esta desligado.
    closeUserMenu();
    const menu = document.createElement("div");
    menu.className = "user-menu";
    menu.append(menuAcao("Copiar link", "link", () => {
      void navigator.clipboard.writeText(url)
        .then(() => showToast("Link copiado."))
        .catch(() => showToast(url));
    }));
    menu.append(menuAcao("Abrir no navegador", "spark", () => void abrirExterno(url)));
    montarMenu(menu, img, { x: evento.clientX, y: evento.clientY });
  };

  img.onwheel = evento => {
    evento.preventDefault();
    escalarEm(escala * (evento.deltaY < 0 ? 1.15 : 1 / 1.15), evento.clientX, evento.clientY);
  };

  img.onpointerdown = evento => {
    if (escala <= cabe + 0.001) return;
    arrastando = true; moveu = false;
    ultimoX = evento.clientX; ultimoY = evento.clientY;
    img.setPointerCapture(evento.pointerId);
    desenhar();
  };
  img.onpointermove = evento => {
    if (!arrastando) return;
    const dx = evento.clientX - ultimoX, dy = evento.clientY - ultimoY;
    // Um tremor de dois pixels ainda e um clique, e nao um arrasto.
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moveu = true;
    x += dx; y += dy;
    ultimoX = evento.clientX; ultimoY = evento.clientY;
    desenhar();
  };
  const soltar = (evento: PointerEvent) => {
    if (!arrastando) return;
    arrastando = false;
    img.releasePointerCapture(evento.pointerId);
    desenhar();
  };
  img.onpointerup = soltar;
  img.onpointercancel = soltar;

  // Mudar o tamanho da janela reaproveita a imagem: recalcula o que cabe e, se
  // a pessoa nao tinha aproximado, acompanha o novo tamanho.
  const aoRedimensionar = () => {
    if (!img.naturalWidth) return;
    const { largura, altura } = moldura();
    const novoCabe = Math.min(1, largura / img.naturalWidth, altura / img.naturalHeight);
    if (escala <= cabe + 0.001) escala = novoCabe;
    cabe = novoCabe;
    desenhar();
  };
  window.addEventListener("resize", aoRedimensionar);

  const fechar = document.createElement("button");
  fechar.type = "button";
  fechar.className = "lightbox-close";
  fechar.setAttribute("aria-label", "Fechar");
  fechar.textContent = "×";

  // Salvar so aparece quando se sabe de qual anexo a imagem veio: o
  // visualizador tambem abre imagem de link, que nao passa pelo servidor.
  const salvar = document.createElement("button");
  salvar.type = "button";
  salvar.className = "lightbox-salvar";
  salvar.title = "Salvar imagem";
  salvar.setAttribute("aria-label", "Salvar imagem");
  salvar.append(icon("download", "ic-sm"));
  salvar.classList.toggle("hidden", !anexo);
  salvar.onclick = evento => {
    evento.stopPropagation();
    if (anexo) void salvarAnexo(anexo);
  };

  const sair = () => {
    fundo.remove();
    document.removeEventListener("keydown", tecla);
    window.removeEventListener("resize", aoRedimensionar);
  };
  const tecla = (evento: KeyboardEvent) => { if (evento.key === "Escape") sair(); };

  // Clicar na propria imagem nao fecha: e o gesto de quem quer olhar de perto.
  fundo.onclick = evento => { if (evento.target === fundo) sair(); };
  fechar.onclick = sair;
  document.addEventListener("keydown", tecla);

  fundo.append(img, salvar, fechar);
  // Em tela cheia so o elemento em tela cheia e desenhado, entao o visualizador
  // precisa entrar dentro dele.
  (document.fullscreenElement || document.body).append(fundo);
  // Imagem que ja estava em cache carrega antes de `onload` ser ligado, e nesse
  // caso o evento nunca vem. Medir aqui cobre esse caso e tambem o inverso: se a
  // imagem carregou antes do `append`, agora a moldura ja tem tamanho.
  medir();
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
      if (player) {
        box.classList.add("embed-player");
        const quadro = document.createElement("iframe");
        quadro.src = player;
        quadro.loading = "lazy";
        quadro.allow = "encrypted-media; picture-in-picture; fullscreen";
        quadro.referrerPolicy = "origin";
        // Escape: a Twitch confere o dominio de quem embute, e
        // `tauri.localhost` nao e um que ela aceite.
        const fora = document.createElement("button");
        fora.type = "button";
        fora.className = "embed-fora";
        fora.textContent = "abrir no navegador";
        fora.onclick = () => void abrirExterno(url).catch(() => showToast("Nao foi possivel abrir o link."));
        box.append(quadro, fora);
      } else {
        // Sem player conhecido: pede o cartao ao servidor. Ele responde vazio
        // para link que nao tem previa, que e a maioria — por isso a caixa so
        // entra na tela depois da resposta.
        void montarCartao(url, into);
        continue;
      }
    }
    into.append(box);
  }
}

// ------------------------------------------------------------- arquivos
// Os bytes vao crus no corpo: multipart e base64 so aumentariam o tamanho.
const MAX_UPLOAD = 50 * 1024 * 1024;
let pendingFiles: StoredFile[] = [];
const blobCache = new Map<string, string>();
/// O conteudo dos anexos ja baixados. Separado do `blobCache`, que guarda so o
/// endereco `blob:` para as tags de imagem e video.
const dadosCache = new Map<string, Blob>();

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
  const url = URL.createObjectURL(await arquivoBlob(id));
  blobCache.set(id, url);
  return url;
}

/// O conteudo do anexo em si.
///
/// Quem precisa dos bytes tem de vir por aqui, e **nao** por um `fetch` na URL
/// `blob:` devolvida por `fileUrl`. A politica de conteudo da janela permite
/// `blob:` em `img-src` e `media-src`, que e o que faz a imagem aparecer, mas
/// nao em `connect-src`: buscar a mesma URL por `fetch` e recusado sem erro de
/// rede, so um aviso no console. Era isso que impedia copiar a imagem.
///
/// Guardar o proprio blob tambem evita baixar o arquivo duas vezes.
async function arquivoBlob(id: string): Promise<Blob> {
  const guardado = dadosCache.get(id);
  if (guardado) return guardado;
  const response = await fetch(API + "/api/files/" + encodeURIComponent(id), {
    headers: { Authorization: "Bearer " + (session?.token || "") },
  });
  if (!response.ok) throw new Error("Arquivo indisponível.");
  const dados = await response.blob();
  dadosCache.set(id, dados);
  return dados;
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
// --------------------------------------------------------------------- gifs
// A busca vive no servidor: ele fala com o Tenor e devolve endereco proprio
// para cada miniatura. Nada aqui conhece o endereco de la, e por isso a
// politica de conteudo da janela continua fechada na propria origem.
type GifAchado = { id: string; descricao: string; largura: number; altura: number; previa: string; ficha: string };
/// O servidor tem chave do Tenor? Sem ela o botao nem aparece.
let temGifs = false;

/// Mostra ou esconde os dois botoes de GIF conforme o servidor.
function aplicarBotaoDeGif() {
  for (const id of ["gif-button", "dm-gif-button"]) {
    byId(id).classList.toggle("hidden", !temGifs);
  }
}

function abrirSeletorDeGif(ancora: HTMLElement) {
  closeUserMenu();
  const caixa = document.createElement("div");
  caixa.className = "user-menu seletor-gif";
  // Clicar dentro do painel nao pode fechar o painel: o ouvinte global fecha
  // qualquer menu ao clique, e aqui se digita e se rola.
  caixa.onclick = evento => evento.stopPropagation();

  const busca = document.createElement("input");
  busca.type = "search";
  busca.placeholder = "Procurar um GIF";
  const grade = document.createElement("div");
  grade.className = "grade";
  caixa.append(busca, grade);

  const avisar = (texto: string) => {
    const aviso = document.createElement("p");
    aviso.className = "aviso";
    aviso.textContent = texto;
    grade.replaceChildren(aviso);
  };

  // Cada busca ganha um numero: resposta de busca antiga que chega depois da
  // nova nao pode sobrescrever a grade.
  let vez = 0;
  async function procurar(termo: string) {
    const minha = ++vez;
    avisar("Procurando…");
    try {
      const pagina = await api<{ gifs: GifAchado[] }>("/api/gifs?q=" + encodeURIComponent(termo));
      if (minha !== vez) return;
      if (!pagina.gifs.length) { avisar("Nada encontrado."); return; }
      grade.replaceChildren(...pagina.gifs.map(gif => cartaoDeGif(gif)));
    } catch (erro) {
      if (minha !== vez) return;
      avisar(erro instanceof Error ? erro.message : "A busca falhou.");
    }
  }

  function cartaoDeGif(gif: GifAchado) {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.title = gif.descricao;
    const img = document.createElement("img");
    // A proporcao vem junto para a grade nao pular enquanto carrega.
    if (gif.largura && gif.altura) img.style.aspectRatio = gif.largura + " / " + gif.altura;
    img.alt = gif.descricao;
    img.loading = "lazy";
    void previaDeGif(gif.previa).then(url => { img.src = url; });
    botao.append(img);
    botao.onclick = () => { closeUserMenu(); void escolherGif(gif); };
    return botao;
  }

  // Espera parar de digitar: uma busca por tecla gastaria a cota do servidor
  // sem nunca mostrar o resultado do que ainda esta sendo escrito.
  let agendado = 0;
  busca.oninput = () => {
    window.clearTimeout(agendado);
    agendado = window.setTimeout(() => void procurar(busca.value), 350);
  };

  montarMenu(caixa, ancora);
  busca.focus();
  void procurar("");
}

/// A miniatura vem autenticada e vira blob, pela mesma razao dos anexos:
/// `<img src>` nao manda cabecalho de autorizacao.
const gifCache = new Map<string, string>();
async function previaDeGif(caminho: string): Promise<string> {
  const pronto = gifCache.get(caminho);
  if (pronto) return pronto;
  const resposta = await fetch(API + caminho, {
    headers: { Authorization: "Bearer " + (session?.token || "") },
  });
  if (!resposta.ok) throw new Error("miniatura indisponivel");
  const url = URL.createObjectURL(await resposta.blob());
  gifCache.set(caminho, url);
  return url;
}

/// O servidor baixa o GIF e o guarda como anexo comum; daqui em diante ele e
/// igual a um arquivo que alguem arrastou para a janela.
async function escolherGif(gif: GifAchado) {
  try {
    const guardado = await api<StoredFile>("/api/gifs/guardar", {
      method: "POST",
      body: JSON.stringify({ ficha: gif.ficha, descricao: gif.descricao }),
    });
    if (!pendingFiles.some(item => item.id === guardado.id)) pendingFiles.push(guardado);
    renderAttachPreview();
  } catch (erro) {
    showToast(erro instanceof Error ? erro.message : "Nao foi possivel trazer o GIF.");
  }
}

byId("gif-button").addEventListener("click", evento => {
  evento.stopPropagation();
  abrirSeletorDeGif(evento.currentTarget as HTMLElement);
});
byId("dm-gif-button").addEventListener("click", evento => {
  evento.stopPropagation();
  abrirSeletorDeGif(evento.currentTarget as HTMLElement);
});

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
// Colar arquivo vale em qualquer lugar do aplicativo, e nao so com o cursor
// dentro da caixa de mensagem: quem acabou de recortar a tela aperta Ctrl+V sem
// pensar onde esta o foco, e antes o atalho simplesmente nao fazia nada.
//
// Texto continua seguindo o caminho normal — so intercepta quando ha arquivo.
document.addEventListener("paste", async event => {
  const dados = event.clipboardData;
  if (!dados) return;
  let arquivos = Array.from(dados.files);
  // Nem todo programa preenche `files`. A Ferramenta de Captura do Windows e o
  // caso comum: ela entrega a imagem so em `items`, e o colar parecia falhar
  // "as vezes" porque dependia de qual programa tinha copiado.
  if (!arquivos.length) {
    arquivos = Array.from(dados.items)
      .filter(item => item.kind === "file")
      .map(item => item.getAsFile())
      .filter((arquivo): arquivo is File => arquivo !== null);
  }
  if (!arquivos.length) return;
  event.preventDefault();
  await queueFiles(arquivos);
});

/// Menu do anexo, no lugar do menu nativo do WebView2.
///
/// O nativo oferece "copiar link da imagem" e entrega `blob:http://tauri.
/// localhost/<uuid>` — o endereco interno daquela janela, que nao serve para
/// nada nem para quem copiou. Ele existe porque a rota de arquivo pede sessao,
/// e `<img src>` nao manda cabecalho de autorizacao: o arquivo e baixado
/// autenticado e vira um blob local.
///
/// Aqui as duas acoes fazem o que a pessoa queria: a imagem em si, ou um
/// endereco que outra pessoa do grupo consegue abrir.
/// `deDentroDoVisualizador` tira a acao de abrir: ela reabriria o visualizador
/// por cima dele mesmo, e quem ja esta olhando a imagem nao precisa disso.
function menuDoAnexo(file: StoredFile, event: MouseEvent, deDentroDoVisualizador = false) {
  event.preventDefault();
  closeUserMenu();
  const menu = document.createElement("div");
  menu.className = "user-menu";

  const titulo = document.createElement("strong");
  titulo.className = "user-menu-title";
  titulo.textContent = file.name;
  menu.append(titulo);

  if (file.mime.startsWith("image/")) {
    menu.append(menuAcao("Copiar imagem", "copy", () => void copiarImagem(file)));
  }
  menu.append(menuAcao("Salvar", "download", () => void salvarAnexo(file)));
  menu.append(menuAcao("Copiar link", "link", () => void copiarLink(file)));
  if (!deDentroDoVisualizador) {
    menu.append(menuAcao("Abrir", "spark", () => {
      void fileUrl(file.id).then(url => abrirImagem(url, file.name, file));
    }));
  }

  const ancora = event.currentTarget as HTMLElement;
  montarMenu(menu, ancora, { x: event.clientX, y: event.clientY });
}

/// Guarda o anexo no computador.
///
/// O arquivo ja esta em memoria como blob autenticado, entao salvar nao passa
/// pela rede de novo. No aplicativo quem grava e o Rust, direto na pasta de
/// Downloads; no navegador, o proprio download do navegador resolve.
async function salvarAnexo(file: StoredFile) {
  try {
    const dados = await arquivoBlob(file.id);

    if (!ehTauri()) {
      const link = document.createElement("a");
      link.href = await fileUrl(file.id);
      link.download = file.name;
      link.click();
      return;
    }

    // O canal com o Rust leva texto, entao o binario vai em base64. Convertido
    // em pedacos: `String.fromCharCode(...bytes)` de uma vez estoura a pilha
    // num arquivo grande.
    const bytes = new Uint8Array(await dados.arrayBuffer());
    let binario = "";
    for (let inicio = 0; inicio < bytes.length; inicio += 0x8000) {
      binario += String.fromCharCode(...bytes.subarray(inicio, inicio + 0x8000));
    }
    const onde = await invoke<string>("salvar_em_downloads", {
      nome: file.name,
      conteudoBase64: btoa(binario),
    });
    showToast("Salvo em " + onde);
  } catch (erro) {
    console.warn("[anexo] salvar", erro);
    showToast("Não foi possível salvar o arquivo.");
  }
}

/// Copia um endereco que abre fora do aplicativo.
///
/// O endereco da API exige cabecalho de autorizacao, que navegador nenhum manda;
/// colado no Chrome ele respondia "Sessao invalida ou expirada". O servidor
/// devolve um endereco assinado, que abre direto.
async function copiarLink(file: StoredFile) {
  try {
    const { url } = await api<{ url: string }>("/api/files/" + encodeURIComponent(file.id) + "/link");
    const completo = API + url;
    await navigator.clipboard.writeText(completo);
    showToast("Link copiado. Abre no navegador para quem receber.");
  } catch (erro) {
    console.warn("[anexo] link", erro);
    showToast("Não foi possível gerar o link.");
  }
}

/// Poe a imagem em si na area de transferencia, e nao o endereco dela.
///
/// O Chromium so aceita PNG em `ClipboardItem`, entao JPEG e WebP passam por um
/// canvas antes. Sem isso, colar no Paint ou no navegador falharia calado.
async function copiarImagem(file: StoredFile) {
  try {
    const bruto = await arquivoBlob(file.id);
    let png = bruto;
    if (bruto.type !== "image/png") {
      const bitmap = await createImageBitmap(bruto);
      const tela = document.createElement("canvas");
      tela.width = bitmap.width; tela.height = bitmap.height;
      tela.getContext("2d")?.drawImage(bitmap, 0, 0);
      png = await new Promise<Blob>((ok, falhou) => {
        tela.toBlob(saida => saida ? ok(saida) : falhou(new Error("conversao falhou")), "image/png");
      });
    }
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    showToast("Imagem copiada.");
  } catch {
    showToast("Não foi possível copiar a imagem.");
  }
}

/// Desenha os anexos de uma mensagem: imagem e video aparecem, o resto vira link.
function renderAttachments(message: { attachments?: StoredFile[] }, into: HTMLElement) {
  for (const file of message.attachments || []) {
    const box = document.createElement("div");
    box.className = "attachment";
    // Substitui o menu nativo, que so sabe oferecer o blob interno da janela.
    box.oncontextmenu = event => menuDoAnexo(file, event);
    if (file.mime.startsWith("image/")) {
      const img = document.createElement("img");
      img.alt = file.name; img.loading = "lazy";
      void fileUrl(file.id).then(url => { img.src = url; }).catch(() => { box.textContent = "(falhou ao carregar)"; });
      img.onclick = () => void fileUrl(file.id).then(url => abrirImagem(url, file.name, file));
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
  // O registro e limpo mesmo quando a transmissao nao estava sendo assistida:
  // deixar o quadradinho com uma faixa que acabou daria um retangulo preto que
  // nao some sozinho.
  if (sid && telasVistas.delete(sid)) renderCameraMini();
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
  // O `#tela` e a identidade de hoje; o `-screen-` e a de antes, e vale
  // enquanto houver servidor sem atualizar do outro lado.
  return /#tela$/.test(participant.identity) || /-screen-/.test(participant.identity);
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
  const servidor = servers.find(item => item.id === channel?.serverId);
  const body = message.text || (message.attachments?.length ? "Enviou um anexo" : "Nova mensagem");
  const de = getDisplayName(message.username)
    + (channel ? " em #" + channel.name : "")
    + (servidor && servidor.id !== currentServerId ? " · " + servidor.name : "");
  const mostrou = notifyMessage({
    title: (citado ? "@ " : "") + message.username + (channel ? " em #" + channel.name : ""),
    body, privateBody: citado ? "Citaram voce em um canal" : "Nova mensagem em um canal", inCall: inCall(),
  });
  void avisarOrigem(mostrou, (citado ? "Citaram você — " : "") + de, () => {
    if (channel && channel.serverId !== currentServerId) void selectServer(channel.serverId);
    if (channel) void selectRoom(channel.id);
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
/// Ate onde o volume de uma pessoa pode ser empurrado. Acima de 100% o audio
/// dela deixa de sair pelo elemento e passa por um `GainNode`, que nao tem o
/// teto de 1 do `HTMLMediaElement.volume`.
const REFORCO_MAX = 2;
const limiteVolume = (valor: number) => Math.min(REFORCO_MAX, Math.max(0, Number.isFinite(valor) ? valor : 1));

/// Reforcar quem fala baixo e **de quem escuta**, e vale so para ele.
///
/// A saida anterior era a pessoa de microfone baixo aumentar o proprio ganho,
/// e isso empurra o volume dela para a sala inteira: quem ja a ouvia bem passa
/// a levar grito. Aqui cada um regula cada um, no proprio computador.
///
/// `HTMLMediaElement.volume` **lanca excecao** acima de 1 ("The volume provided
/// (2) is outside the range [0, 1]"), e a excecao subia ate o `connect` e
/// virava "erro de conexao". O caminho que aceita mais de 1 e o WebAudio: com
/// um `AudioContext` na faixa, o `setVolume` do livekit escreve num `GainNode`
/// em vez do elemento.
///
/// **So a faixa reforcada muda de caminho.** Ligar a mixagem por WebAudio na
/// sala toda passaria o audio de todos por um lugar novo — e contexto suspenso
/// ali significa chamada muda, que e exatamente o defeito da 0.7.21. Quem esta
/// em 100% continua saindo pelo elemento, como sempre saiu.
let contextoDeEscuta: AudioContext | null = null;
/// Faixas que estao no caminho reforcado agora. Serve para desfazer o desvio
/// quando o volume volta para 100% ou menos.
const reforcadas = new Set<string>();

/// Poe (ou tira) uma faixa no caminho do WebAudio. Devolve se o reforco esta
/// valendo; `false` quer dizer que o volume tem de ser tratado como 100%.
function rotearReforco(faixa: RemoteAudioTrack, querReforco: boolean): boolean {
  // Faixa ainda sem `sid` nao foi anexada: nao ha elemento para calar nem como
  // registrar o desvio. Ela volta por aqui quando `applyAllVolumes` rodar.
  const sid = faixa.sid;
  if (!sid) return false;
  // `setAudioContext` e marcado como interno no livekit; e a unica costura que
  // desvia **uma** faixa sem mexer nas outras.
  const interna = faixa as unknown as { setAudioContext(ctx: AudioContext | undefined): void };
  const elementos = () => document.querySelectorAll<HTMLAudioElement>("#audio-" + CSS.escape(sid));

  if (!querReforco) {
    if (!reforcadas.has(sid)) return false;
    reforcadas.delete(sid);
    try { interna.setAudioContext(undefined); } catch (erro) { console.warn("[volume] saida do reforco", erro); }
    for (const el of elementos()) { delete el.dataset.reforcado; el.volume = 1; }
    refreshAudioMuting();
    return false;
  }

  try {
    if (!contextoDeEscuta) {
      contextoDeEscuta = new AudioContext();
      vigiarContextoDeEscuta(contextoDeEscuta);
    }
    // Contexto suspenso nao processa: sem isto a pessoa reforcada ficaria muda.
    if (contextoDeEscuta.state === "suspended") {
      void contextoDeEscuta.resume().catch(erro => {
        // Falhar aqui e o caso perigoso: o elemento ja esta mudo e o contexto
        // nao toca, entao a pessoa some. Desfazer o desvio a traz de volta em
        // volume normal.
        console.warn("[volume] contexto nao retomou", erro);
        desfazerReforcos();
      });
    }
    interna.setAudioContext(contextoDeEscuta);
    reforcadas.add(sid);
    // O som agora sai pelo contexto; deixar o elemento tocando junto dobraria a
    // voz. `refreshAudioMuting` respeita a marca e nao desfaz isto.
    for (const el of elementos()) { el.dataset.reforcado = "1"; el.volume = 0; el.muted = true; }
    return true;
  } catch (erro) {
    // Falhando o desvio, a pessoa continua sendo ouvida no volume normal —
    // nunca em silencio.
    reforcadas.delete(sid);
    console.warn("[volume] reforco indisponivel", erro);
    return false;
  }
}

/// Desconecta do contexto de escuta a faixa que esta saindo.
///
/// `detachTrack` so apagava o `sid` do registro, e o registro nao e o que segura
/// a faixa: quem segura e o proprio `AudioContext`, com os nos que o LiveKit
/// montou dentro dele. Sem desfazer o desvio, cada pessoa que sai deixa a
/// aparelhagem dela ligada num contexto compartilhado que nunca e limpo — e o
/// estrago se acumula justamente com sair e voltar, que e quando isso mais
/// acontece.
function soltarDoReforco(faixa: { sid?: string; kind?: unknown }) {
  const sid = faixa.sid;
  if (!sid || !reforcadas.has(sid)) return;
  reforcadas.delete(sid);
  const interna = faixa as unknown as { setAudioContext?: (ctx: AudioContext | undefined) => void };
  try { interna.setAudioContext?.(undefined); }
  catch (erro) { console.warn("[volume] saida do reforco", erro); }
}

/// Tira **todas** as faixas do caminho reforcado e as devolve ao volume normal.
///
/// Rede de seguranca, nao ajuste: um volume preferido nunca pode virar silencio.
/// No caminho reforcado o elemento de audio fica mudo de proposito, porque o som
/// sai pelo contexto — e se o contexto para, aquela pessoa simplesmente some
/// para quem a reforcou, sem aviso e sem jeito de perceber que foi isso.
///
/// Ouvir alguem a 100% quando se pediu 150% e uma decepcao pequena. Nao ouvir e
/// um defeito.
function desfazerReforcos() {
  if (!reforcadas.size) return;
  console.warn("[volume] desfazendo o reforco de", reforcadas.size, "faixa(s)");
  for (const sid of [...reforcadas]) {
    reforcadas.delete(sid);
    for (const el of document.querySelectorAll<HTMLAudioElement>("#audio-" + CSS.escape(sid))) {
      delete el.dataset.reforcado;
      el.volume = 1;
      el.muted = false;
    }
  }
  refreshAudioMuting();
  showToast("O reforço de volume foi desligado para ninguém ficar sem som.");
}

/// Fica de olho no contexto: ele para sozinho.
///
/// No Windows, trocar o dispositivo de saida — plugar o fone, tirar o fone —
/// suspende o `AudioContext`. O navegador tambem o suspende por politica de
/// reproducao. Nos dois casos o som some sem ninguem tocar em nada, e quem esta
/// do outro lado continua falando achando que esta sendo ouvido.
function vigiarContextoDeEscuta(contexto: AudioContext) {
  contexto.onstatechange = () => {
    if (contexto.state === "running") return;
    // Tenta voltar sozinho primeiro; so desiste se nao der.
    void contexto.resume().catch(() => desfazerReforcos());
    // `resume` pode resolver sem o contexto voltar a tocar de fato.
    window.setTimeout(() => { if (contexto.state !== "running") desfazerReforcos(); }, 1500);
  };
  // Trocar de fone no meio da chamada e o caso comum.
  navigator.mediaDevices?.addEventListener?.("devicechange", () => {
    if (contexto.state !== "running") void contexto.resume().catch(() => desfazerReforcos());
  });
}

/// As unicas fontes com audio, que sao tambem as unicas que `setVolume` aceita.
type FonteDeAudio = Track.Source.Microphone | Track.Source.ScreenShareAudio;

/// A faixa de audio de uma fonte de um participante, se ela estiver chegando.
function faixaDeAudio(participante: RemoteParticipant, fonte: FonteDeAudio): RemoteAudioTrack | undefined {
  const faixa = participante.getTrackPublication(fonte)?.track;
  return faixa && faixa.kind === Track.Kind.Audio ? (faixa as RemoteAudioTrack) : undefined;
}
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
    // Elemento desviado para o WebAudio fica mudo por definicao: o som dele sai
    // pelo contexto. Escrever `muted = false` aqui traria a voz dobrada.
    if (el.dataset.reforcado) { el.muted = true; continue; }
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
      aplicarFonte(participant, Track.Source.Microphone, limiteVolume(pair.mic), Boolean(pair.mudoVoz));
      aplicarFonte(participant, Track.Source.ScreenShareAudio, limiteVolume(pair.screen), Boolean(pair.mudoTela));
    } catch (erro) { console.warn("[volume]", erro); }
  }
}
/// Regula uma fonte de um participante, desviando para o WebAudio so quando o
/// pedido passa de 100%.
function aplicarFonte(participante: RemoteParticipant, fonte: FonteDeAudio, volume: number, silenciado: boolean) {
  const faixa = faixaDeAudio(participante, fonte);
  // Sem a faixa ainda nao ha o que rotear; `applyAllVolumes` volta aqui quando
  // ela chegar.
  const reforcando = faixa ? rotearReforco(faixa, volume > 1) : false;
  // Nao tendo conseguido o desvio, o elemento nao aceita mais de 1 — e passar
  // 2 para ele levantaria excecao no meio da entrada da chamada.
  const efetivo = reforcando ? volume : Math.min(1, volume);
  // No caminho reforcado o elemento esta mudo, entao o surdo geral tem de valer
  // pelo ganho; no caminho normal quem cuida disso e `refreshAudioMuting`.
  const mudo = silenciado || (reforcando && !audioEnabled);
  participante.setVolume(mudo ? 0 : efetivo, fonte);
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
  // Ate 200%: e o reforco de quem escuta, para quem fala baixo demais mesmo
  // com o microfone no talo do outro lado.
  slider.type = "range"; slider.min = "0"; slider.max = String(REFORCO_MAX * 100); slider.step = "5";
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
// -------------------------------------------------------------- arrastar
// Organizar canal e categoria com o mouse.
//
// O menu de "mover para cima" continua existindo — serve a quem usa teclado e a
// quem esta num toque, onde arrastar em lista estreita e sofrido. Mas puxar com
// o mouse e o jeito que as pessoas tentam primeiro.
//
// O estado do arrasto vive aqui, e nao no `dataTransfer`, porque no meio de um
// `dragover` o navegador **nao deixa ler** o que esta sendo carregado — so na
// hora do `drop`. Sem isto nao daria para decidir se o alvo aceita a coisa que
// vem vindo, e todo canal aceitaria toda categoria.
type Arrasto = { tipo: "canal" | "categoria"; id: string };
let arrasto: Arrasto | null = null;

/// Tira as marcas de "vai cair aqui" de tudo.
function limparAlvos() {
  for (const alvo of document.querySelectorAll(".drop-antes, .drop-depois, .drop-dentro")) {
    alvo.classList.remove("drop-antes", "drop-depois", "drop-dentro");
  }
}

/// Deixa um elemento ser puxado.
function tornarArrastavel(elemento: HTMLElement, coisa: Arrasto) {
  if (!podeOrganizar()) return;
  elemento.draggable = true;
  elemento.ondragstart = evento => {
    arrasto = coisa;
    elemento.classList.add("arrastando");
    // Alguns navegadores cancelam o arrasto sem nenhum dado definido.
    evento.dataTransfer?.setData("text/plain", coisa.id);
    if (evento.dataTransfer) evento.dataTransfer.effectAllowed = "move";
  };
  elemento.ondragend = () => {
    arrasto = null;
    elemento.classList.remove("arrastando");
    limparAlvos();
  };
}

/// Marca onde o que vem sendo puxado vai cair: antes ou depois deste elemento.
function ladoDoAlvo(elemento: HTMLElement, evento: DragEvent): "antes" | "depois" {
  const caixa = elemento.getBoundingClientRect();
  return evento.clientY < caixa.top + caixa.height / 2 ? "antes" : "depois";
}

/// Um canal aceita outro canal caindo perto dele.
function alvoDeCanal(elemento: HTMLElement, item: RoomInfo) {
  if (!podeOrganizar()) return;
  // Texto so troca de lugar com texto, e voz com voz. Dentro de uma categoria os
  // dois aparecem na mesma coluna, mas o desenho sempre poe os de texto antes:
  // aceitar a mistura faria o canal cair num lugar diferente do que a linha
  // acabou de prometer.
  const combina = () => {
    if (arrasto?.tipo !== "canal" || arrasto.id === item.id) return false;
    return rooms.find(outro => outro.id === arrasto!.id)?.kind === item.kind;
  };
  elemento.ondragover = evento => {
    if (!combina()) return;
    evento.preventDefault();
    limparAlvos();
    elemento.classList.add(ladoDoAlvo(elemento, evento) === "antes" ? "drop-antes" : "drop-depois");
  };
  elemento.ondragleave = () => elemento.classList.remove("drop-antes", "drop-depois");
  elemento.ondrop = evento => {
    if (!combina() || !arrasto) return;
    evento.preventDefault();
    evento.stopPropagation();
    const lado = ladoDoAlvo(elemento, evento);
    limparAlvos();
    void soltarCanal(arrasto.id, item.categoryId ?? null, item.id, lado);
  };
}

/// Uma categoria aceita canal caindo dentro dela, e outra categoria caindo
/// perto dela.
function alvoDeCategoria(cabecalho: HTMLElement, corpo: HTMLElement | null, categoria: Categoria) {
  if (!podeOrganizar()) return;
  const aceita = (evento: DragEvent) => {
    if (!arrasto) return;
    if (arrasto.tipo === "categoria" && arrasto.id === categoria.id) return;
    evento.preventDefault();
    limparAlvos();
    if (arrasto.tipo === "canal") {
      cabecalho.classList.add("drop-dentro");
      corpo?.classList.add("drop-dentro");
    } else {
      cabecalho.classList.add(ladoDoAlvo(cabecalho, evento) === "antes" ? "drop-antes" : "drop-depois");
    }
  };
  const solta = (evento: DragEvent) => {
    if (!arrasto) return;
    if (arrasto.tipo === "categoria" && arrasto.id === categoria.id) return;
    evento.preventDefault();
    evento.stopPropagation();
    const lado = ladoDoAlvo(cabecalho, evento);
    const puxado = arrasto;
    limparAlvos();
    if (puxado.tipo === "canal") void soltarCanal(puxado.id, categoria.id, null, "depois");
    else void soltarCategoria(puxado.id, categoria.id, lado);
  };
  cabecalho.ondragover = aceita;
  cabecalho.ondragleave = () => limparAlvos();
  cabecalho.ondrop = solta;
  if (corpo) {
    corpo.ondragover = evento => { if (arrasto?.tipo === "canal") aceita(evento); };
    corpo.ondragleave = () => limparAlvos();
    corpo.ondrop = evento => { if (arrasto?.tipo === "canal") solta(evento); };
  }
}

/// As duas listas de cima aceitam canal para tira-lo de qualquer categoria.
function alvoSemCategoria(lista: HTMLElement, tipo: RoomKind) {
  if (!podeOrganizar()) return;
  lista.ondragover = evento => {
    if (arrasto?.tipo !== "canal") return;
    const puxado = rooms.find(item => item.id === arrasto!.id);
    // So o mesmo tipo: canal de voz caindo na lista de texto seria mudanca de
    // natureza, nao de lugar.
    if (!puxado || puxado.kind !== tipo) return;
    evento.preventDefault();
    limparAlvos();
    lista.classList.add("drop-dentro");
  };
  lista.ondragleave = () => lista.classList.remove("drop-dentro");
  lista.ondrop = evento => {
    if (arrasto?.tipo !== "canal") return;
    const puxado = rooms.find(item => item.id === arrasto!.id);
    if (!puxado || puxado.kind !== tipo) return;
    evento.preventDefault();
    limparAlvos();
    void soltarCanal(arrasto.id, null, null, "depois");
  };
}

/// Move o canal e manda o arranjo novo.
///
/// `perto` vazio joga no fim daquele grupo, que e o que "cair na area vazia da
/// categoria" quer dizer.
async function soltarCanal(id: string, categoria: string | null, perto: string | null, lado: "antes" | "depois") {
  const puxado = rooms.find(item => item.id === id);
  if (!puxado) return;
  const doServidor = rooms.filter(item => item.serverId === currentServerId && item.id !== id);
  let onde = doServidor.length;
  if (perto) {
    const alvo = doServidor.findIndex(item => item.id === perto);
    if (alvo >= 0) onde = lado === "antes" ? alvo : alvo + 1;
  } else if (categoria) {
    // Fim do grupo: depois do ultimo canal que ja esta nele.
    const ultimo = doServidor.map(item => item.categoryId ?? null).lastIndexOf(categoria);
    if (ultimo >= 0) onde = ultimo + 1;
  }
  doServidor.splice(onde, 0, { ...puxado, categoryId: categoria });

  // Desenha antes de perguntar ao servidor: arrastar tem de responder na hora.
  // Se a gravacao falhar, `recarregarOrganizacao` traz o estado de verdade.
  const outros = rooms.filter(item => item.serverId !== currentServerId);
  rooms = [...outros, ...doServidor];
  renderNavigation();
  await gravarOrganizacao(doServidor);
}

async function soltarCategoria(id: string, perto: string, lado: "antes" | "depois") {
  const minhas = categorias.filter(item => item.serverId === currentServerId);
  const puxada = minhas.find(item => item.id === id);
  if (!puxada) return;
  const resto = minhas.filter(item => item.id !== id);
  const alvo = resto.findIndex(item => item.id === perto);
  const onde = alvo < 0 ? resto.length : (lado === "antes" ? alvo : alvo + 1);
  resto.splice(onde, 0, puxada);

  categorias = [...categorias.filter(item => item.serverId !== currentServerId), ...resto];
  renderNavigation();
  await gravarOrganizacao(rooms.filter(item => item.serverId === currentServerId));
}

async function gravarOrganizacao(doServidor: RoomInfo[]) {
  const arranjo = {
    categorias: categorias.filter(item => item.serverId === currentServerId).map(item => item.id),
    canais: doServidor.map(item => ({ id: item.id, categoryId: item.categoryId ?? null })),
  };
  try {
    await api<void>("/api/servers/" + encodeURIComponent(currentServerId) + "/organizacao", {
      method: "PUT", body: JSON.stringify(arranjo),
    });
  } catch (erro) {
    showToast(erro instanceof Error ? erro.message : "Não foi possível salvar a ordem.");
    await recarregarOrganizacao();
  }
}

// ------------------------------------------------------------- categorias
// Grupos de canais dentro de um servidor. Valem para os dois tipos ao mesmo
// tempo: uma campanha de RPG tem a mesa de voz e os canais de texto dela, e
// separar isso em dois grupos de mesmo nome so daria trabalho a quem organiza.

/// Quais grupos estao fechados. Segue a conta, e nao a maquina: fechar a
/// campanha que nao e sua e arrumacao pessoal, e ter de refazer isso em cada
/// computador seria o mesmo incomodo que os volumes tinham.
const FECHADAS_KEY = "naoconcordo.categorias-fechadas";
function fechadas(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(FECHADAS_KEY) || "[]") as string[]); }
  catch { return new Set(); }
}
function guardarFechadas(conjunto: Set<string>) {
  localStorage.setItem(FECHADAS_KEY, JSON.stringify([...conjunto]));
}

const grupoExiste = (id: string) => categorias.some(item => item.id === id);
const podeOrganizar = () =>
  temCategorias && (roles[currentServerId] === "owner" || roles[currentServerId] === "mod");

/// Rele a organizacao inteira depois de alguem mexer nela.
///
/// Reler tudo em vez de aplicar cada mudanca: sao quatro operacoes que mexem em
/// duas listas, e a que aplicasse fora de ordem deixaria canal orfao na tela.
async function recarregarOrganizacao() {
  try {
    const dados = await api<Bootstrap>("/api/bootstrap");
    temCategorias = dados.categorias !== undefined;
    categorias = dados.categorias || [];
    rooms = dados.rooms;
    // O canal aberto pode ter sido o apagado: ficar olhando para uma conversa
    // que nao existe mais deixaria a tela mentindo ate alguem clicar noutra.
    if (currentRoomId && !rooms.some(item => item.id === currentRoomId)) {
      const proximo = rooms.find(item => item.serverId === currentServerId && item.kind === "text");
      if (proximo) { await selectRoom(proximo.id); return; }
      currentRoomId = "";
    }
    renderNavigation();
  } catch (erro) {
    console.warn("[categorias] nao deu para reler", erro);
  }
}

/// Desenha os grupos embaixo dos canais soltos.
function desenharCategorias(doServidor: RoomInfo[]) {
  const caixa = byId("category-list");
  const minhas = categorias.filter(item => item.serverId === currentServerId);
  const encolhidas = fechadas();

  caixa.replaceChildren(...minhas.flatMap(categoria => {
    const dentro = doServidor.filter(item => item.categoryId === categoria.id);
    const fechada = encolhidas.has(categoria.id);

    const cabecalho = document.createElement("div");
    cabecalho.className = "category-head" + (fechada ? " fechada" : "");

    const abrir = document.createElement("button");
    abrir.className = "category-name";
    abrir.type = "button";
    abrir.append(icon(fechada ? "plus" : "minus", "ic-sm"), document.createTextNode(categoria.name));
    abrir.title = fechada ? "Mostrar os canais" : "Esconder os canais";
    abrir.onclick = () => {
      const atual = fechadas();
      if (atual.has(categoria.id)) atual.delete(categoria.id); else atual.add(categoria.id);
      guardarFechadas(atual);
      renderNavigation();
    };
    cabecalho.append(abrir);

    if (podeOrganizar()) {
      const ajustes = document.createElement("button");
      ajustes.className = "add-room";
      ajustes.type = "button";
      ajustes.title = "Ajustar esta categoria";
      ajustes.append(icon("gear", "ic-sm"));
      ajustes.onclick = evento => { evento.stopPropagation(); menuDaCategoria(categoria, ajustes); };
      cabecalho.append(ajustes);
    }
    cabecalho.oncontextmenu = evento => {
      if (!podeOrganizar()) return;
      evento.preventDefault();
      evento.stopPropagation();
      menuDaCategoria(categoria, cabecalho, { x: evento.clientX, y: evento.clientY });
    };

    if (fechada) {
      tornarArrastavel(cabecalho, { tipo: "categoria", id: categoria.id });
      alvoDeCategoria(cabecalho, null, categoria);
      return [cabecalho];
    }

    const corpo = document.createElement("div");
    corpo.className = "category-body";
    // Texto antes de voz dentro do grupo: e a ordem em que as pessoas procuram,
    // e a lista de quem esta na chamada fica embaixo, onde ja estava.
    for (const item of dentro.filter(canal => canal.kind === "text")) corpo.append(botaoDeTexto(item));
    for (const item of dentro.filter(canal => canal.kind === "voice")) corpo.append(...linhasDeVoz(item));
    if (!dentro.length) corpo.append(emptyLine("Arraste um canal para cá."));
    tornarArrastavel(cabecalho, { tipo: "categoria", id: categoria.id });
    alvoDeCategoria(cabecalho, corpo, categoria);
    return [cabecalho, corpo];
  }));

  // O botao de criar grupo so existe para quem pode organizar, e so dentro de
  // um servidor: na aba de amigos nao ha o que agrupar.
  byId("add-category").classList.toggle("hidden", !(view === "server" && podeOrganizar()));
  // A secao inteira some num servidor que nao conhece categorias: rotulo sem
  // nada embaixo e sem botao so ocupa espaco e levanta duvida.
  const secao = byId("add-category").closest(".section-title") as HTMLElement | null;
  secao?.classList.toggle("hidden", !temCategorias || !minhas.length && !podeOrganizar());
}

function menuDaCategoria(categoria: Categoria, ancora: HTMLElement, ponto?: { x: number; y: number }) {
  closeUserMenu();
  const menu = document.createElement("div");
  menu.className = "user-menu";

  const opcao = (rotulo: string, aoClicar: () => void, perigo = false) => {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.textContent = rotulo;
    if (perigo) botao.className = "perigo";
    botao.onclick = () => { closeUserMenu(); aoClicar(); };
    menu.append(botao);
  };

  opcao("Renomear", () => void renomearCategoria(categoria));
  opcao("Mover para cima", () => void moverCategoria(categoria, true));
  opcao("Mover para baixo", () => void moverCategoria(categoria, false));
  // O texto diz o que acontece com os canais: sem isso ninguem clica, com medo
  // de perder a conversa de meses de campanha.
  opcao("Apagar (os canais ficam)", () => void apagarCategoria(categoria), true);

  acoesDeCriar(menu);
  montarMenu(menu, ancora, ponto);
}

async function renomearCategoria(categoria: Categoria) {
  const nome = await askInput({
    title: "Renomear categoria", label: "Nome", value: categoria.name,
    submit: "Renomear", maxLength: 24,
  });
  if (!nome || nome === categoria.name) return;
  try {
    await api<void>("/api/categorias/" + encodeURIComponent(categoria.id), {
      method: "PUT", body: JSON.stringify({ name: nome }),
    });
    await recarregarOrganizacao();
  } catch (erro) { showToast(erro instanceof Error ? erro.message : "Não foi possível renomear."); }
}

async function moverCategoria(categoria: Categoria, acima: boolean) {
  try {
    await api<void>("/api/categorias/" + encodeURIComponent(categoria.id) + "/mover", {
      method: "POST", body: JSON.stringify({ acima }),
    });
    await recarregarOrganizacao();
  } catch (erro) { showToast(erro instanceof Error ? erro.message : "Não foi possível mover."); }
}

async function apagarCategoria(categoria: Categoria) {
  const quantos = rooms.filter(item => item.categoryId === categoria.id).length;
  const detalhe = quantos === 0 ? "Ela está vazia."
    : quantos === 1 ? "O canal dela continua existindo, fora de categoria."
    : "Os " + quantos + " canais dela continuam existindo, fora de categoria.";
  if (!await confirmAction("Apagar categoria", "Apagar " + categoria.name + "?", detalhe, "Apagar")) return;
  try {
    await api<void>("/api/categorias/" + encodeURIComponent(categoria.id), { method: "DELETE" });
    await recarregarOrganizacao();
  } catch (erro) { showToast(erro instanceof Error ? erro.message : "Não foi possível apagar."); }
}

/// Acrescenta "Criar canal de texto / de voz / categoria" ao fim de um menu.
///
/// Vai em **todos** os menus da barra lateral, e nao so no do vazio: mirar o
/// espaco entre dois canais para poder criar um terceiro e um alvo que a pessoa
/// nao deveria precisar acertar. Fica no fim porque o que e sobre o item
/// clicado vem primeiro.
function acoesDeCriar(menu: HTMLElement) {
  if (!podeCriarCanal()) return;
  const titulo = document.createElement("p");
  titulo.className = "menu-title";
  titulo.textContent = "Criar";
  menu.append(titulo);

  const acao = (rotulo: string, aoClicar: () => void) => {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.textContent = rotulo;
    botao.onclick = () => { closeUserMenu(); aoClicar(); };
    menu.append(botao);
  };
  acao("Canal de texto", () => void createChannel("text"));
  acao("Canal de voz", () => void createChannel("voice"));
  if (temCategorias) acao("Categoria", () => void criarCategoria());
}

/// Menu do canal: renomear, apagar e trocar de grupo.
function menuDoCanal(item: RoomInfo, ancora: HTMLElement, evento: MouseEvent) {
  // `podeCriarCanal`, e nao `podeOrganizar`: este ultimo exige que o servidor
  // conheca categorias, e renomear e apagar canal nao tem nada com isso.
  if (!podeCriarCanal()) return;
  evento.preventDefault();
  evento.stopPropagation();
  closeUserMenu();

  const menu = document.createElement("div");
  menu.className = "user-menu";

  const acao = (rotulo: string, aoClicar: () => void, perigo = false) => {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.textContent = rotulo;
    if (perigo) botao.className = "perigo";
    botao.onclick = () => { closeUserMenu(); aoClicar(); };
    menu.append(botao);
  };
  acao("Renomear canal", () => void renomearCanal(item));
  acao("Apagar canal", () => void apagarCanal(item), true);

  // A secao de mover so faz sentido onde ha grupos para onde mover.
  if (temCategorias) {
    const titulo = document.createElement("p");
    titulo.className = "menu-title";
    titulo.textContent = "Mover para";
    menu.append(titulo);

    const destino = (rotulo: string, id: string | null, atual: boolean) => {
      const botao = document.createElement("button");
      botao.type = "button";
      botao.textContent = (atual ? "• " : "") + rotulo;
      botao.disabled = atual;
      botao.onclick = () => { closeUserMenu(); void moverCanal(item, id); };
      menu.append(botao);
    };

    destino("Fora de categoria", null, !item.categoryId);
    for (const categoria of categorias.filter(c => c.serverId === currentServerId)) {
      destino(categoria.name, categoria.id, item.categoryId === categoria.id);
    }
  }

  acoesDeCriar(menu);
  montarMenu(menu, ancora, { x: evento.clientX, y: evento.clientY });
}

async function renomearCanal(item: RoomInfo) {
  const nome = await askInput({
    title: "Renomear canal", label: "Nome", value: item.name,
    submit: "Renomear", maxLength: 24,
  });
  if (!nome || nome === item.name) return;
  try {
    await api<void>("/api/rooms/" + encodeURIComponent(item.id), {
      method: "PUT", body: JSON.stringify({ name: nome }),
    });
    await recarregarOrganizacao();
  } catch (erro) { showToast(erro instanceof Error ? erro.message : "Não foi possível renomear."); }
}

async function apagarCanal(item: RoomInfo) {
  // O aviso diz o que se perde. Canal de voz nao guarda nada; o de texto guarda
  // a conversa inteira, e ela some junto.
  //
  // O numero exato so aparece para o canal **aberto**: `history` guarda as
  // mensagens de um canal por vez, entao contar as de outro daria zero e o aviso
  // diria "esta vazio" sobre uma conversa de meses. Aviso que mente e pior do
  // que aviso sem numero.
  const aberto = item.id === currentRoomId;
  const quantas = aberto ? history.filter(m => m.roomId === item.id).length : 0;
  const detalhe = item.kind === "voice"
    ? "Quem estiver na chamada dele sai."
    : aberto
      ? (quantas
        ? "As " + quantas + " mensagens dele somem junto, e não dá para recuperar."
        : "Ele está vazio.")
      : "As mensagens dele somem junto, e não dá para recuperar.";
  if (!await confirmAction("Apagar canal", "Apagar " + item.name + "?", detalhe, "Apagar")) return;
  try {
    await api<void>("/api/rooms/" + encodeURIComponent(item.id), { method: "DELETE" });
    await recarregarOrganizacao();
  } catch (erro) { showToast(erro instanceof Error ? erro.message : "Não foi possível apagar."); }
}

/// Menu de criar, no vazio da barra lateral.
///
/// Ele existe porque as secoes vazias deixaram de aparecer: sem canal de voz
/// nenhum, o rotulo "CANAIS DE VOZ" e o "+" dele sumiam junto, e nao sobrava por
/// onde criar o primeiro.
function menuDeCriar(evento: MouseEvent) {
  if (view !== "server" || !currentServerId) return;
  if (!podeCriarCanal()) return;
  // Em cima de um canal ou de uma categoria manda o menu daquele item, que ja
  // carrega as mesmas acoes de criar no fim dele.
  if ((evento.target as HTMLElement).closest(".channel, .category-head")) return;
  evento.preventDefault();
  closeUserMenu();

  const menu = document.createElement("div");
  menu.className = "user-menu";
  acoesDeCriar(menu);
  montarMenu(menu, byId("channels-pane"), { x: evento.clientX, y: evento.clientY });
}

/// Criar canal e do dono e do moderador, mesma regra de organizar — mas sem
/// depender de o servidor conhecer categorias.
const podeCriarCanal = () =>
  roles[currentServerId] === "owner" || roles[currentServerId] === "mod";

// Na barra inteira, e nao so na lista: o espaco vazio embaixo dos canais fica
// **fora** de `#channels-pane`, e e justamente onde a mao vai. A aba de amigos
// entra no mesmo elemento, mas `menuDeCriar` sai fora quando nao ha servidor
// aberto.
document.querySelector("aside.sidebar nav")?.addEventListener("contextmenu", evento => {
  menuDeCriar(evento as MouseEvent);
});

async function moverCanal(item: RoomInfo, categoryId: string | null) {
  try {
    await api<void>("/api/rooms/" + encodeURIComponent(item.id) + "/categoria", {
      method: "PUT", body: JSON.stringify({ categoryId }),
    });
    await recarregarOrganizacao();
  } catch (erro) { showToast(erro instanceof Error ? erro.message : "Não foi possível mover o canal."); }
}

async function criarCategoria() {
  if (!currentServerId) { showToast("Entre num servidor primeiro."); return; }
  const nome = await askInput({
    title: "Nova categoria", label: "Nome", placeholder: "Ex.: Campanha 1",
    submit: "Criar", maxLength: 24,
  });
  if (!nome) return;
  try {
    await api<Categoria>("/api/categorias", {
      method: "POST", body: JSON.stringify({ serverId: currentServerId, name: nome }),
    });
    await recarregarOrganizacao();
  } catch (erro) { showToast(erro instanceof Error ? erro.message : "Não foi possível criar."); }
}

byId("add-category").addEventListener("click", () => void criarCategoria());

/// Mostra ou esconde o rotulo de uma secao conforme ela tenha conteudo.
function esconderSecaoVazia(listaId: string, tem: boolean) {
  const lista = byId(listaId);
  lista.classList.toggle("hidden", !tem);
  // O rotulo e o irmao logo acima da lista.
  const titulo = lista.previousElementSibling as HTMLElement | null;
  if (titulo?.classList.contains("section-title")) titulo.classList.toggle("hidden", !tem);
}

/// Um canal de texto na barra lateral.
///
/// Separado de `renderNavigation` porque as categorias desenham os mesmos
/// canais: duas copias divergiriam na primeira mudanca, e o selo de nao lido
/// pararia de aparecer dentro dos grupos sem ninguem entender por que.
function botaoDeTexto(item: RoomInfo) {
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
    button.onclick = () => selectRoom(item.id);
  button.oncontextmenu = evento => menuDoCanal(item, button, evento);
  tornarArrastavel(button, { tipo: "canal", id: item.id });
  alvoDeCanal(button, item);
  return button;
}

/// Um canal de voz, mais a lista de quem esta dentro dele.
function linhasDeVoz(item: RoomInfo): HTMLElement[] {
    const button = document.createElement("button");
    button.className = "channel voice" + (item.id === voiceRoomId ? " active" : "");
    button.append(icon("speaker", "room-dot"), document.createTextNode(item.name));
    // Clicar no canal em que voce ja esta **nao** desconecta: mostra ou esconde
    // o palco da chamada. Sair e o botao de desligar, que existe para isso e
    // nao se aperta sem querer ao procurar quem esta na sala.
    button.onclick = () => {
      if (item.id === voiceRoomId && (room?.state === "connected" || room?.state === "connecting")) {
        palcoDaChamada = !palcoDaChamada;
        void selectServer(item.serverId);
        renderCameras();
        return;
      }
      void toggleVoice(item.id);
    };
    // Mesmo menu do canal de texto: sem isto, so metade dos canais entraria
    // numa categoria, e a mesa de voz da campanha ficaria de fora dela.
    button.oncontextmenu = evento => menuDoCanal(item, button, evento);
    tornarArrastavel(button, { tipo: "canal", id: item.id });
    alvoDeCanal(button, item);
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
        row.classList.add("clickable");
        // Em si mesmo nao ha volume nem silenciar para ajustar, entao o clique
        // vai direto ao cartao de perfil em vez de abrir um menu vazio.
        row.onclick = key(name) === key(session?.username || "")
          ? event => { event.stopPropagation(); abrirPerfil(name); }
          : event => { event.stopPropagation(); openUserMenu(name, row); };
        row.oncontextmenu = event => {
          event.preventDefault();
          event.stopPropagation();
          openUserMenu(name, row, { x: event.clientX, y: event.clientY });
        };
        box.append(row);
      }
      nodes.push(box);
    }
    return nodes;
}

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
/// Qual imagem esta valendo para esta pessoa agora, como texto curto.
///
/// Serve so para a assinatura de `renderPeople` perceber que a foto mudou. Segue
/// a mesma ordem de `paintAvatar`: a do servidor aberto ganha da global.
function retratoDe(name: string): string {
  if (view === "server" && currentServerId) {
    const mem = serverMemberProfiles.get(key(name));
    if (mem?.avatarFile) return mem.avatarFile;
  }
  const perfil = profiles.get(key(name));
  // A antiga vinha embutida na propria resposta e pode ser enorme: o tamanho ja
  // distingue uma troca sem carregar a imagem inteira para dentro do texto.
  return perfil?.avatarFile || (perfil?.avatar ? "d" + perfil.avatar.length : "");
}

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
  // Toda pessoa da lista responde ao clique, esteja em chamada ou nao.
  //
  // O menu de volumes so faz sentido para quem esta na chamada e nao e voce —
  // fora disso ele abriria com controles que nao regulam nada. Nos outros
  // casos o clique vai direto ao cartao de perfil, que e o que a pessoa quer
  // quando clica num nome. Antes, quem estava so online, quem estava offline e
  // voce mesmo eram cliques mortos.
  row.classList.add("clickable");
  row.onclick = naChamada && key(name) !== key(session?.username || "")
    ? event => { event.stopPropagation(); openUserMenu(name, row); }
    : event => { event.stopPropagation(); abrirPerfil(name); };
  // Botao direito abre o mesmo cartao, no lugar do menu do navegador.
  row.oncontextmenu = event => {
    event.preventDefault();
    event.stopPropagation();
    openUserMenu(name, row, { x: event.clientX, y: event.clientY });
  };
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
  //
  // A assinatura tem de conter **tudo o que aparece desenhado**, e nao so quem
  // esta na lista. Ela levava o nome de usuario cru e o estado de chamada; o
  // apelido e a foto sao por servidor, entao dois servidores com a mesma gente
  // online davam a mesma assinatura e a lista nao era redesenhada — os apelidos
  // e as fotos do servidor anterior ficavam na tela.
  //
  // O id do servidor entra junto porque e mais barato que comparar cada campo e
  // pega tambem o que eu nao lembrar de incluir aqui.
  const assinatura = currentServerId + "@" + view + "|" + unique.map(name => name
    + "~" + getDisplayName(name)
    + "~" + retratoDe(name)
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
  // O espaco do rodape pertence a barra: sem ela, o redator desce ate o fim.
  byId("app-view").querySelector(".main-panel")?.classList.toggle("com-chamada", ativa);
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
/// Ultimo tempo de ida e volta ate o servidor, em milissegundos. `null` antes
/// da primeira medida ou quando ela falha.
let pingMs: number | null = null;
let estadoAtual = "offline";
let estadoOnline = false;

function setStatus(text: string, online: boolean) {
  estadoAtual = text;
  estadoOnline = online;
  updateCallControls();
  pintarEstado();
  connectionState.textContent = text;
  byId("mini-profile-status").textContent = text;
  leaveButton.querySelector("small")!.textContent = online ? "Desconectar" : "Reconectar";
}

/// O ping acompanha o estado, e nao substitui: "online" sem numero e melhor do
/// que so um numero solto quando a medida ainda nao chegou.
function pintarEstado() {
  statusPill.textContent = estadoAtual + (pingMs !== null ? " · " + pingMs + " ms" : "");
  statusPill.classList.toggle("online", estadoOnline);
}

/// Mede o tempo de ida e volta ate o servidor.
///
/// E a conversa com o backend, e nao o caminho da voz — a midia vai pelo
/// LiveKit e pode estar melhor ou pior que isto. Serve para responder "esta
/// lento porque a minha internet caiu ou porque o servidor engasgou?".
async function medirPing() {
  if (!session) { pingMs = null; pintarEstado(); return; }
  const inicio = performance.now();
  try {
    const resposta = await fetch(API + "/api/session", {
      headers: { Authorization: "Bearer " + session.token },
      cache: "no-store",
    });
    pingMs = resposta.ok ? Math.round(performance.now() - inicio) : null;
  } catch {
    pingMs = null;
  }
  pintarEstado();
}
// A cada dez segundos: perto o bastante para acompanhar uma piora, longe o
// bastante para nao virar transito por conta propria.
window.setInterval(() => void medirPing(), 10_000);
/// Aviso curto no canto. Com `aoClicar`, ele vira botao: clicar leva ao lugar
/// de onde o aviso veio, e some.
function showToast(text: string, aoClicar?: () => void) {
  toastEl.textContent = text;
  toastEl.classList.remove("hidden");
  toastEl.classList.toggle("clicavel", Boolean(aoClicar));
  toastEl.onclick = aoClicar
    ? () => { toastEl.classList.add("hidden"); aoClicar(); }
    : null;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.add("hidden"), aoClicar ? 7000 : 4000);
}

/// Diz de onde veio a mensagem quando a notificacao do Windows nao apareceu.
///
/// As notificacoes do sistema vem **desligadas por padrao**, entao no caso
/// comum so o som tocava — e som sozinho nao diz se foi um canal, qual, ou uma
/// conversa privada. Este aviso preenche essa lacuna e leva ao lugar num
/// clique.
///
/// So aparece quando a notificacao do sistema **nao** apareceu: as duas juntas
/// seriam a mesma informacao duas vezes.
async function avisarOrigem(
  mostrouNoSistema: Promise<boolean>,
  texto: string,
  ir: () => void,
) {
  if (await mostrouNoSistema) return;
  // Estando de olho na janela, o aviso e util; minimizado, quem resolve e a
  // notificacao do sistema, e ela ja foi decidida acima.
  showToast(texto, ir);
}
function initials(name: string) { return name.split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase()).join(""); }
async function resume() { if (!session) return; try { await api("/api/session"); await enterApp(); } catch { saveSession(null); } }
void resume();
void decidirAberturaInicial();
bloquearRecarregar();
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


