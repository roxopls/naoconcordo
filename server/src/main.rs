use std::{collections::{BTreeMap, HashMap}, env, net::SocketAddr, path::{Path, PathBuf}, sync::Arc, time::{SystemTime, UNIX_EPOCH}};

use axum::{
    extract::{ConnectInfo, Path as Caminho, Query, State, WebSocketUpgrade, ws::{Message as WsMessage, WebSocket}},
    http::{HeaderMap, Method, StatusCode}, response::{IntoResponse, Response},
    routing::{get, post, put}, Json, Router,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tokio::{fs, sync::{RwLock, broadcast}};
use axum::extract::DefaultBodyLimit;
use tower_http::{cors::{Any, CorsLayer}, limit::RequestBodyLimitLayer, services::ServeDir, trace::TraceLayer};
use uuid::Uuid;

mod gifs;
mod previa;

type HmacSha256 = Hmac<Sha256>;
const DEFAULT_ROOM: &str = "geral";
const MAX_MESSAGES: usize = 2_000;
const MAX_ENVELOPES: usize = 5_000;
/// Teto por arquivo: 50 MB.
const MAX_UPLOAD: usize = 50 * 1024 * 1024;
const SESSION_SECONDS: u64 = 7 * 24 * 60 * 60;
const PASSWORD_ITERATIONS: u32 = 210_000;
/// Teto das preferencias de uma conta. Elas seguem a pessoa entre computadores,
/// entao viajam em toda entrada; sem teto viravam um lugar barato de guardar
/// qualquer coisa no servidor dos outros.
const MAX_PREFERENCIAS: usize = 60;
const MAX_PREF_CHAVE: usize = 80;
const MAX_PREF_VALOR: usize = 8 * 1024;

#[derive(Clone)]
struct Config { auth_salt: String, owner_password: String, admin_username: String, livekit_key: String, livekit_secret: String, livekit_url: String, data_dir: PathBuf, upload_dir: PathBuf, upload_fallback_dir: PathBuf, upload_primary_cap: u64,
    /// Chave da busca de GIF, e de qual provedor ela e. Sem chave o botao nao
    /// aparece no cliente.
    ///
    /// O nome nao cita provedor de proposito: o Tenor fechou para cadastros
    /// novos em janeiro de 2026, e trocar de fonte tem de ser uma linha no
    /// `.env`, nao uma versao nova do servidor.
    gif_key: Option<String>, gif_provider: gifs::Provedor }
#[derive(Clone)]
struct AppState {
    config: Config, auth_key: [u8; 32],
    sessions: Arc<RwLock<HashMap<String, Session>>>,
    challenges: Arc<RwLock<HashMap<String, Challenge>>>,
    users: Arc<RwLock<HashMap<String, UserAccount>>>,
    // Convites de uso unico emitidos pelo painel do admin.
    invites: Arc<RwLock<Vec<Invite>>>,
    messages: Arc<RwLock<Vec<ChatMessage>>>,
    rooms: Arc<RwLock<Vec<RoomInfo>>>,
    profiles: Arc<RwLock<HashMap<String, Profile>>>,
    servers: Arc<RwLock<Vec<ServerInfo>>>,
    // Quem enxerga cada servidor. Sem isso, todo mundo via tudo.
    memberships: Arc<RwLock<HashMap<String, Vec<Member>>>>,
    // Convites de servidor esperando resposta.
    server_invites: Arc<RwLock<Vec<ServerInvite>>>,
    // Quantos sockets abertos cada pessoa tem. Zero significa offline.
    online: Arc<RwLock<HashMap<String, usize>>>,
    // Quem esta em cada canal de voz, para a lista aparecer antes de entrar na
    // chamada. So existe em memoria: chamada nao sobrevive a um restart, e
    // gravar isso deixaria gente presa numa sala que nao existe mais.
    voice: Arc<RwLock<HashMap<String, Vec<String>>>>,
    files: Arc<RwLock<HashMap<String, StoredFile>>>,
    keys: Arc<RwLock<HashMap<String, IdentityKey>>>,
    // A identidade privada de cada conta, cifrada pelo proprio dono. O servidor
    // guarda e devolve; abrir, nao abre.
    cofres: Arc<RwLock<HashMap<String, Cofre>>>,
    // Ajustes que seguem a conta, e nao a maquina: volume de cada pessoa,
    // atalhos, notificacoes. O que descreve **este computador** — microfone,
    // placa de video, canal de atualizacao — fica no proprio computador, porque
    // levar isso junto escolheria um microfone que nao existe do outro lado.
    preferencias: Arc<RwLock<HashMap<String, BTreeMap<String, String>>>>,
    categorias: Arc<RwLock<Vec<Categoria>>>,
    friendships: Arc<RwLock<Vec<Friendship>>>,
    envelopes: Arc<RwLock<Vec<Envelope>>>,
    events: broadcast::Sender<Broadcast>,
}
#[derive(Clone)] struct Session { username: String, expires_at: u64, is_owner: bool }
#[derive(Clone)] struct Challenge { username: String, expires_at: u64, ip: String, password_salt: String, recovery_salt: String, account_exists: bool }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatMessage {
    id: Uuid, username: String, text: String, created_at: DateTime<Utc>,
    #[serde(default)] edited_at: Option<DateTime<Utc>>,
    #[serde(default = "default_room_id")] room_id: String,
    #[serde(default)] attachments: Vec<StoredFile>,
    // So o id: o cliente ja tem o historico e monta a citacao sozinho. Guardar
    // uma copia do texto citado deixaria a citacao mentindo depois de uma edicao.
    #[serde(default)] reply_to: Option<Uuid>,
    // Emoji -> quem reagiu. Guardar a lista, e nao so a contagem, e o que
    // permite marcar a propria reacao e alternar com um clique.
    #[serde(default)] reactions: BTreeMap<String, Vec<String>>,
    // Fixada no canal. Vale para todo mundo que ve o canal, e nao por pessoa:
    // fixar serve para combinar horario e guardar o endereco do servidor de
    // jogo, que nao sao assunto particular de quem fixou.
    #[serde(default)] pinned: bool,
}
#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum RoomKind { Text, Voice }
fn default_room_kind() -> RoomKind { RoomKind::Text }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoomInfo {
    id: String, name: String, created_at: DateTime<Utc>,
    #[serde(default = "default_server_id")] server_id: String,
    // Salas antigas nao tinham tipo: viram canal de texto.
    #[serde(default = "default_room_kind")] kind: RoomKind,
    /// Em qual grupo o canal aparece. Ausente e o normal: canal sem categoria
    /// fica em cima, solto, como sempre esteve.
    #[serde(default)] category_id: Option<String>,
    /// Onde o canal fica na lista.
    ///
    /// Canais antigos vem todos com zero, e o desempate por data de criacao
    /// mantem exatamente a ordem que eles ja tinham — ninguem ve a lista mudar
    /// sozinha por causa desta atualizacao.
    #[serde(default)] posicao: i32,
}

/// Um grupo de canais dentro de um servidor.
///
/// Vale para os dois tipos ao mesmo tempo — uma campanha de RPG tem a mesa de
/// voz e os canais de texto dela, e separar isso em dois grupos de mesmo nome so
/// daria trabalho a quem organiza.
///
/// `posicao` existe porque ordem alfabetica nao serve: "Campanha 2" antes de
/// "Campanha 10" e o tipo de coisa que so incomoda depois de pronto.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Categoria {
    id: String,
    server_id: String,
    name: String,
    posicao: i32,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerInfo {
    id: String, name: String, created_at: DateTime<Utc>,
    #[serde(default)] icon_file: Option<String>,
    #[serde(default)] banner_file: Option<String>,
    #[serde(default)] description: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    username: String,
    /// Cor do anel de "esta falando", escolhida pela pessoa. `#rrggbb`
    /// validado no servidor: este valor termina dentro de um estilo no
    /// navegador de todo mundo, entao aceitar texto livre seria deixar cada
    /// um escrever CSS na tela dos outros.
    #[serde(default)] color: Option<String>,
    /// Formato antigo: imagem embutida como data URI.
    avatar: Option<String>,
    /// Formato novo: id de arquivo. Preserva GIF animado, que o canvas matava.
    #[serde(default)] avatar_file: Option<String>,
    #[serde(default)] bio: Option<String>,
    #[serde(default)] banner_file: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserAccount { username: String, password_salt: String, verifier: String, recovery_salt: String, recovery_verifier: String, created_at: DateTime<Utc> }

/// Convite de uso unico. `key` e o PBKDF2 do codigo com o mesmo sal e as mesmas
/// iteracoes que o cliente usa, para o cadastro continuar sem mandar o codigo
/// em texto puro. O codigo fica legivel porque o painel do admin precisa
/// mostra-lo para ser repassado a pessoa convidada.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Invite {
    code: String, key: String, #[serde(default)] label: String,
    created_at: DateTime<Utc>, created_by: String,
    #[serde(default)] used_by: Option<String>,
    #[serde(default)] used_at: Option<DateTime<Utc>>,
    #[serde(default)] revoked: bool,
}

/// Papel de cada pessoa dentro de um servidor.
#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ServerRole { Owner, Mod, Member }
impl ServerRole {
    /// Dono e moderador administram; membro so participa.
    fn manages(self) -> bool { matches!(self, ServerRole::Owner | ServerRole::Mod) }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Member {
    username: String,
    role: ServerRole,
    #[serde(default)] nickname: Option<String>,
    #[serde(default)] avatar_file: Option<String>,
}

/// Convite de servidor pendente. Entrar deixou de ser automatico: quem convida
/// cria isto, e a pessoa so vira membro quando aceita.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerInvite {
    id: Uuid, server_id: String, server_name: String,
    from: String, to: String, created_at: DateTime<Utc>,
}

/// Aceita tanto a forma nova quanto a antiga, que era so uma lista de nomes.
/// Na conversao, o primeiro da lista vira dono e o resto membro.
#[derive(Deserialize)]
#[serde(untagged)]
enum StoredMembers { Detailed(Vec<Member>), Legacy(Vec<String>) }
impl From<StoredMembers> for Vec<Member> {
    fn from(value: StoredMembers) -> Self {
        match value {
            StoredMembers::Detailed(list) => list,
            StoredMembers::Legacy(names) => names.into_iter().enumerate()
                .map(|(index, username)| Member {
                    username,
                    role: if index == 0 { ServerRole::Owner } else { ServerRole::Member },
                    nickname: None,
                    avatar_file: None,
                }).collect(),
        }
    }
}

/// Anexo guardado em disco. O JSON guarda so os metadados; os bytes ficam
/// no disco de uploads, com o nome derivado do hash do conteudo.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredFile {
    id: String, name: String, mime: String, size: u64,
    owner: String, created_at: DateTime<Utc>,
    /// "primary" ou "fallback": em qual disco o arquivo ficou.
    disk: String,
}

/// Chave publica ECDH do usuario. A privada nunca sai do dispositivo.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentityKey { username: String, public_key: String, updated_at: DateTime<Utc> }

/// A chave privada de conversas de uma conta, cifrada no cliente.
///
/// Fica aqui para que as conversas sigam a **conta**, e nao o computador: antes
/// disso a chave nascia no `localStorage` e entrar de outra maquina significava
/// identidade nova e historico ilegivel.
///
/// **O servidor nao tem como abrir isto.** A chave que abre e derivada da senha
/// (ou do codigo de recuperacao) com um sal proprio, diferente do que gera o
/// verificador de login guardado aqui. Guardar os dois embrulhos do mesmo
/// conteudo e o que faz o codigo de recuperacao devolver tambem o historico.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cofre {
    username: String,
    por_senha: Embrulho,
    /// Ausente nas contas que migraram durante um login comum: ali a senha
    /// estava em maos, o codigo de recuperacao nao.
    #[serde(skip_serializing_if = "Option::is_none")]
    por_recuperacao: Option<Embrulho>,
    updated_at: DateTime<Utc>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Embrulho { ciphertext: String, nonce: String }

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum FriendStatus { Pending, Accepted }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Friendship { requester: String, addressee: String, status: FriendStatus, created_at: DateTime<Utc>, updated_at: DateTime<Utc> }

/// Mensagem privada. O servidor guarda apenas texto cifrado e metadados minimos.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    id: Uuid, from: String, to: String, ciphertext: String, nonce: String, created_at: DateTime<Utc>,
    #[serde(default)] edited_at: Option<DateTime<Utc>>,
    // Anexo de PV nao e cifrado: e o mesmo arquivo autenticado dos canais, com
    // id de SHA-256. So o texto continua fora do alcance do servidor.
    #[serde(default)] attachments: Vec<StoredFile>,
    #[serde(default)] reply_to: Option<Uuid>,
}

#[derive(Clone, Serialize)]
// `rename_all` so renomeia as variantes; sem `rename_all_fields` os campos de
// messageDeleted iam como message_id e o cliente nunca achava a mensagem.
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum ServerEvent {
    Message { message: ChatMessage },
    MessageUpdated { message: ChatMessage },
    MessageDeleted { message_id: Uuid, room_id: String },
    RoomCreated { room: RoomInfo },
    ProfileUpdated { profile: Profile },
    FriendRequested { friendship: Friendship },
    FriendAccepted { friendship: Friendship },
    FriendRemoved { username: String },
    DirectMessage { envelope: Envelope },
    DirectMessageUpdated { envelope: Envelope },
    DirectMessageDeleted { message_id: Uuid, from: String, to: String },
    // Servidores em tempo real: antes so aparecia quando a pessoa reabria o app.
    ServerInvited { invite: ServerInvite },
    ServerInviteResolved { invite_id: Uuid, accepted: bool, username: String, server_id: String },
    ServerJoined { server: ServerInfo, rooms: Vec<RoomInfo>, role: ServerRole },
    ServerLeft { server_id: String },
    ServerUpdated { server: ServerInfo },
    MembersChanged { server_id: String },
    /// Categorias criadas, renomeadas, reordenadas, ou canal trocado de grupo.
    ///
    /// Sem detalhe do que mudou de proposito: sao quatro operacoes que mexem em
    /// duas listas, e mandar o estado inteiro de volta pelo `bootstrap` custa
    /// menos do que quatro eventos que precisam ser aplicados na ordem certa.
    CanaisOrganizados { server_id: String },
    RoleChanged { server_id: String, role: ServerRole },
    PresenceChanged { username: String, online: bool },
    VoiceChanged { room_id: String, users: Vec<String> },
    // Efemero: nao e guardado nem reenviado. Quem entrar depois nao ve.
    Typing { username: String, room_id: String },
}

/// Evento mais a lista de quem pode receber. `audience: None` significa todos.
#[derive(Clone)]
struct Broadcast { audience: Option<Vec<String>>, event: ServerEvent }
impl Broadcast {
    fn all(event: ServerEvent) -> Self { Self { audience: None, event } }
    fn to(users: [&str; 2], event: ServerEvent) -> Self {
        Self { audience: Some(users.iter().map(|u| profile_key(u)).collect()), event }
    }
    fn to_many(users: Vec<String>, event: ServerEvent) -> Self {
        Self { audience: Some(users.iter().map(|u| profile_key(u)).collect()), event }
    }
    /// Evento de uma pessoa so: papel mudou, entrou ou saiu de um servidor.
    fn to_one(user: &str, event: ServerEvent) -> Self {
        Self { audience: Some(vec![profile_key(user)]), event }
    }
    fn allows(&self, username: &str) -> bool {
        match &self.audience { None => true, Some(list) => list.contains(&profile_key(username)) }
    }
}

#[derive(Deserialize)] struct UsernameInput { username: String }
#[derive(Deserialize)] struct LoginInput { username: String, nonce: String, proof: String }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
struct RegisterInput { username: String, nonce: String, invite_proof: String, verifier: String, recovery_verifier: String }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
struct RecoverInput { username: String, nonce: String, recovery_proof: String, verifier: String, recovery_verifier: String }
#[derive(Deserialize)] struct WsQuery { token: String }
#[derive(Deserialize)] struct EditMessageInput { text: String }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")] struct ClientMessage { #[serde(rename = "type")] kind: String, text: Option<String>, room_id: Option<String>, #[serde(default)] attachments: Vec<String>, #[serde(default)] reply_to: Option<Uuid>,
    // Usados por "react" e "pin": qual mensagem e qual emoji.
    #[serde(default)] message_id: Option<Uuid>, #[serde(default)] emoji: Option<String> }

/// Anuncia a entrada e a saida de um canal de voz e avisa quem enxerga o
/// servidor. `sala` vazia significa que a pessoa saiu da chamada.
///
/// A lista guarda o nome como a pessoa escreveu, mas a comparacao e sempre por
/// `profile_key`, senao "Ana" e "ana" viram duas pessoas na mesma sala.
async fn set_voice(state: &AppState, username: &str, anterior: &mut Option<String>, sala: Option<String>) {
    let mut mudou: Vec<String> = Vec::new();
    {
        let mut voice = state.voice.write().await;
        if let Some(antiga) = anterior.take() {
            if let Some(gente) = voice.get_mut(&antiga) {
                gente.retain(|nome| profile_key(nome) != profile_key(username));
                if gente.is_empty() { voice.remove(&antiga); }
            }
            mudou.push(antiga);
        }
        if let Some(nova) = sala {
            let gente = voice.entry(nova.clone()).or_default();
            if !gente.iter().any(|nome| profile_key(nome) == profile_key(username)) {
                gente.push(username.to_string());
            }
            *anterior = Some(nova.clone());
            if !mudou.contains(&nova) { mudou.push(nova); }
        }
    }
    for room_id in mudou {
        let Some(sala) = state.rooms.read().await.iter().find(|r| r.id == room_id).cloned() else { continue; };
        let audience = { let memberships = state.memberships.read().await; members_of(&memberships, &sala.server_id) };
        let users = state.voice.read().await.get(&room_id).cloned().unwrap_or_default();
        let _ = state.events.send(Broadcast::to_many(audience, ServerEvent::VoiceChanged { room_id, users }));
    }
}
#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
struct CreateRoomInput {
    name: String, server_id: String,
    #[serde(default = "default_room_kind")] kind: RoomKind,
    /// Ja nascer dentro de um grupo: criar o canal e depois arrasta-lo para a
    /// categoria certa e um passo a mais toda vez.
    #[serde(default)] category_id: Option<String>,
}
#[derive(Deserialize)] struct CreateServerInput { name: String }
#[derive(Deserialize)] struct OwnerInput { code: String }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")] struct CreateInviteInput { #[serde(default)] label: String }
#[derive(Deserialize)] struct InviteCodeInput { code: String }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
struct AvatarInput { avatar: Option<String>, #[serde(default)] avatar_file: Option<String> }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
struct ProfileInput {
    #[serde(default, deserialize_with = "double_option")] bio: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")] banner_file: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")] color: Option<Option<String>>,
}

/// `#rrggbb`, e nada mais. Curto de proposito: qualquer coisa alem disso vira
/// texto arbitrario dentro de um estilo na maquina dos outros.
fn cor_valida(texto: &str) -> bool {
    texto.len() == 7
        && texto.starts_with('#')
        && texto[1..].chars().all(|c| c.is_ascii_hexdigit())
}
/// Distingue "campo ausente" de "campo enviado como null". Sem isso, remover
/// icone, banner ou bio nunca funcionava: null virava None e o `is_some()` que
/// decidia se havia mudanca dava falso.
fn double_option<'de, D, T>(de: D) -> Result<Option<Option<T>>, D::Error>
where D: serde::Deserializer<'de>, T: Deserialize<'de> {
    Deserialize::deserialize(de).map(Some)
}
#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
struct CustomizeServerInput {
    name: Option<String>,
    #[serde(default, deserialize_with = "double_option")] description: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")] icon_file: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")] banner_file: Option<Option<String>>,
}
#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
struct LivekitInput { room_id: String, #[serde(default)] viewer: bool, #[serde(default)] screen: bool }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")] struct PublicKeyInput { public_key: String }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")] struct CofreInput { por_senha: Embrulho, por_recuperacao: Option<Embrulho> }
#[derive(Deserialize)] struct SearchQuery { q: Option<String> }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")] struct DirectMessageInput { to: String, ciphertext: String, nonce: String, #[serde(default)] attachments: Vec<String>, #[serde(default)] reply_to: Option<Uuid> }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")] struct EditDirectInput { ciphertext: String, nonce: String }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")] struct DirectHistoryQuery { with: String }
#[derive(Serialize)] struct ErrorBody { error: String }
#[derive(Serialize)] #[serde(rename_all = "camelCase")] struct FriendsOutput { friends: Vec<String>, incoming: Vec<Friendship>, outgoing: Vec<Friendship> }
#[derive(Serialize)] #[serde(rename_all = "camelCase")] struct DirectHistoryOutput { envelopes: Vec<Envelope> }
#[derive(Serialize)] #[serde(rename_all = "camelCase")] struct SearchOutput { users: Vec<String> }
#[derive(Serialize)] #[serde(rename_all = "camelCase")] struct MembersOutput { members: Vec<MemberEntry>, my_role: ServerRole }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")] struct MemberInput { server_id: String, username: String }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")] struct RoleInput { server_id: String, username: String, role: ServerRole }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")] struct ServerIdInput { server_id: String }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")] struct InviteIdInput { invite_id: Uuid }
#[derive(Serialize)] #[serde(rename_all = "camelCase")] struct ServerInvitesOutput { invites: Vec<ServerInvite> }
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
struct MemberEntry {
    username: String,
    role: ServerRole,
    #[serde(default)] nickname: Option<String>,
    #[serde(default)] avatar_file: Option<String>,
}
#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
struct ServerMemberProfileInput {
    nickname: Option<String>,
    avatar_file: Option<String>,
}
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
struct ChallengeOutput {
    nonce: String,
    invite_salt: String,
    invite_iterations: u32,
    password_salt: String,
    recovery_salt: String,
    password_iterations: u32,
    account_exists: bool,
}
#[derive(Serialize)] #[serde(rename_all = "camelCase")] struct LoginOutput { token: String, username: String, expires_at: u64 }
#[derive(Serialize)] struct SessionOutput { username: String }
#[derive(Serialize)] struct HealthOutput { ok: bool, service: &'static str, time: DateTime<Utc> }
#[derive(Serialize)] struct LivekitOutput { token: String, url: String, room: String }
#[derive(Serialize)] struct WelcomeOutput { #[serde(rename = "type")] kind: &'static str, messages: Vec<ChatMessage> }
#[derive(Serialize)] #[serde(rename_all = "camelCase")] struct BootstrapOutput { servers: Vec<ServerInfo>, rooms: Vec<RoomInfo>, profiles: Vec<Profile>, is_owner: bool, is_admin: bool, roles: HashMap<String, ServerRole>, online: Vec<String>, voice: HashMap<String, Vec<String>>,
    categorias: Vec<Categoria>,
    /// Se este servidor tem busca de GIF. Sem isso o cliente mostraria um botao
    /// que so sabe dar erro.
    gifs: bool }
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
struct InviteView { code: String, label: String, created_at: DateTime<Utc>, created_by: String, used_by: Option<String>, used_at: Option<DateTime<Utc>>, revoked: bool }
#[derive(Serialize)] #[serde(rename_all = "camelCase")] struct InvitesOutput { invites: Vec<InviteView> }
#[derive(Serialize)] #[serde(rename_all = "camelCase")] struct OwnerOutput { is_owner: bool }
#[derive(Serialize)] struct VideoGrant {
    #[serde(rename = "roomJoin")] room_join: bool, room: String,
    #[serde(rename = "canPublish")] can_publish: bool,
    #[serde(rename = "canSubscribe")] can_subscribe: bool,
    #[serde(rename = "canPublishData")] can_publish_data: bool,
    // Permite ao participante escrever os proprios atributos. E assim que o
    // estado de "surdo" (audio desligado) chega aos outros: e local de quem
    // aperta, ninguem descobriria sozinho. Atributo em vez de mensagem porque
    // quem entra depois ja recebe o estado atual, sem ninguem reemitir.
    #[serde(rename = "canUpdateOwnMetadata")] can_update_own_metadata: bool,
    // Participante oculto nao aparece para os outros. Usado pela janela de
    // cameras, que so assiste e nao deve virar um usuario fantasma na chamada.
    hidden: bool,
}
#[derive(Serialize)] struct LivekitClaims { iss: String, sub: String, name: String, nbf: u64, exp: u64, video: VideoGrant, #[serde(skip_serializing_if = "Option::is_none")] metadata: Option<String> }

#[tokio::main]
async fn main() {
    let access_password = required("ACCESS_PASSWORD");
    let config = Config {
        auth_salt: required("AUTH_SALT"), owner_password: required("OWNER_PASSWORD"),
        admin_username: env::var("ADMIN_USERNAME").unwrap_or_else(|_| "admin".into()),
        livekit_key: required("LIVEKIT_API_KEY"),
        livekit_secret: required("LIVEKIT_API_SECRET"),
        livekit_url: env::var("LIVEKIT_PUBLIC_URL").unwrap_or_else(|_| "ws://livekit:7880".into()),
        data_dir: PathBuf::from(env::var("DATA_DIR").unwrap_or_else(|_| "/app/data".into())),
        upload_dir: PathBuf::from(env::var("UPLOAD_DIR").unwrap_or_else(|_| "/app/uploads".into())),
        upload_fallback_dir: PathBuf::from(env::var("UPLOAD_FALLBACK_DIR").unwrap_or_else(|_| "/app/uploads-fallback".into())),
        // Opcional de proposito: quem hospeda sem chave continua com tudo o
        // mais funcionando, so sem a busca de GIF.
        gif_key: env::var("GIF_API_KEY").ok().filter(|chave| !chave.trim().is_empty()),
        gif_provider: gifs::Provedor::ler(&env::var("GIF_PROVIDER").unwrap_or_default()),
        // Quando o disco principal passa disso, o proximo arquivo vai para a
        // reserva. Contamos o que gravamos em vez de perguntar ao sistema,
        // para nao depender de chamada externa dentro do container.
        upload_primary_cap: env::var("UPLOAD_PRIMARY_CAP_GB").ok()
            .and_then(|value| value.parse::<u64>().ok()).unwrap_or(400) * 1024 * 1024 * 1024,
    };
    fs::create_dir_all(&config.data_dir).await.expect("nao foi possivel criar data dir");
    for dir in [&config.upload_dir, &config.upload_fallback_dir] {
        if let Err(erro) = fs::create_dir_all(dir).await { eprintln!("aviso: sem acesso a {dir:?}: {erro}"); }
    }
    let mut auth_key = [0_u8; 32];
    pbkdf2_hmac::<Sha256>(access_password.as_bytes(), config.auth_salt.as_bytes(), 150_000, &mut auth_key);
    let (events, _) = broadcast::channel(256);
    let state = AppState {
        messages: Arc::new(RwLock::new(load_messages(&config.data_dir).await)),
        rooms: Arc::new(RwLock::new(load_rooms(&config.data_dir).await)),
        profiles: Arc::new(RwLock::new(load_profiles(&config.data_dir).await)),
        servers: Arc::new(RwLock::new(load_servers(&config.data_dir).await)),
        users: Arc::new(RwLock::new(load_users(&config.data_dir).await)),
        invites: Arc::new(RwLock::new(load_json(&config.data_dir, "invites.json").await)),
        memberships: Arc::new(RwLock::new(load_memberships(&config.data_dir).await)),
        server_invites: Arc::new(RwLock::new(load_json(&config.data_dir, "server-invites.json").await)),
        online: Default::default(),
        voice: Default::default(),
        files: Arc::new(RwLock::new(load_json(&config.data_dir, "files.json").await)),
        keys: Arc::new(RwLock::new(load_json(&config.data_dir, "keys.json").await)),
        cofres: Arc::new(RwLock::new(load_json(&config.data_dir, "cofres.json").await)),
        preferencias: Arc::new(RwLock::new(load_json(&config.data_dir, "preferencias.json").await)),
        categorias: Arc::new(RwLock::new(load_json(&config.data_dir, "categorias.json").await)),
        friendships: Arc::new(RwLock::new(load_json(&config.data_dir, "friends.json").await)),
        envelopes: Arc::new(RwLock::new(load_envelopes(&config.data_dir).await)),
        config, auth_key, sessions: Default::default(), challenges: Default::default(), events,
    };
    let cors = CorsLayer::new().allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE, Method::OPTIONS]).allow_headers(Any);
    // Onde ficam os instaladores e o manifesto que os clientes consultam. Fica
    // ao lado dos dados quando ninguem escolhe outro lugar; a pasta e criada
    // vazia para o `ServeDir` nao responder erro de caminho inexistente.
    let updates_dir = env::var("UPDATES_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| state.config.data_dir.join("updates"));
    if let Err(erro) = tokio::fs::create_dir_all(&updates_dir).await {
        eprintln!("nao foi possivel criar {}: {erro}", updates_dir.display());
    }
    let app = Router::new()
        .route("/health", get(health))
        .route("/api/auth/challenge", post(auth_challenge))
        .route("/api/auth/register", post(auth_register))
        .route("/api/auth/login", post(auth_login))
        .route("/api/auth/recover", post(auth_recover))
        .route("/api/session", get(get_session))
        .route("/api/logout", post(logout))
        .route("/api/bootstrap", get(bootstrap))
        .route("/api/owner/unlock", post(unlock_owner))
        .route("/api/admin/invites", get(list_invites).post(create_invite))
        .route("/api/admin/invites/revoke", post(revoke_invite))
        .route("/api/servers", post(create_server))
        .route("/api/rooms", post(create_room))
        .route("/api/rooms/{id}", put(renomear_canal).delete(apagar_canal))
        .route("/api/rooms/{id}/categoria", put(mover_canal))
        .route("/api/categorias", post(criar_categoria))
        .route("/api/categorias/{id}", put(renomear_categoria).delete(apagar_categoria))
        .route("/api/categorias/{id}/mover", post(mover_categoria))
        .route("/api/servers/{id}/organizacao", put(reorganizar))
        .route("/api/profile/avatar", put(update_avatar))
        .route("/api/profile", put(update_profile))
        .route("/api/messages/{id}", put(edit_message).delete(delete_message))
        .route("/api/preferencias", get(ler_preferencias).put(guardar_preferencias))
        .route("/api/previa", get(previa_de_link))
        .route("/api/previa/midia", get(midia_de_previa))
        .route("/api/gifs", get(buscar_gifs))
        .route("/api/gifs/midia", get(midia_de_gif))
        .route("/api/gifs/guardar", post(guardar_gif))
        .route("/api/files", post(upload_file))
        .route("/api/files/{id}", get(download_file))
        .route("/api/files/{id}/link", get(link_do_arquivo))
        // Sem `/api` e sem sessao: e o endereco que abre no navegador.
        .route("/f/{id}", get(arquivo_por_link))
        .route("/api/livekit-token", post(livekit_token))
        .route("/api/servers/{server_id}/members", get(list_members))
        .route("/api/servers/members/add", post(add_member))
        .route("/api/servers/invites", get(list_server_invites))
        .route("/api/servers/invites/accept", post(accept_server_invite))
        .route("/api/servers/invites/reject", post(reject_server_invite))
        .route("/api/servers/members/remove", post(remove_member))
        .route("/api/servers/members/role", post(set_member_role))
        .route("/api/servers/leave", post(leave_server))
        .route("/api/servers/delete", post(delete_server))
        .route("/api/servers/{id}/customize", put(customize_server))
        .route("/api/servers/{id}/member-profile", put(update_server_member_profile))
        .route("/api/keys", put(publish_key))
        .route("/api/cofre", get(ler_cofre).put(guardar_cofre))
        .route("/api/keys/{username}", get(get_key))
        .route("/api/users/search", get(search_users))
        .route("/api/friends", get(list_friends))
        .route("/api/friends/request", post(friend_request))
        .route("/api/friends/accept", post(friend_accept))
        .route("/api/friends/reject", post(friend_reject))
        .route("/api/friends/remove", post(friend_remove))
        .route("/api/dm", get(direct_history).post(send_direct))
        .route("/api/dm/{id}", put(edit_direct).delete(delete_direct))
        .route("/ws", get(websocket))
        // O axum tem um teto proprio de 2 MB para o corpo, e o
        // `RequestBodyLimitLayer` **nao** o substitui: os dois valem, e o menor
        // ganha. Sem desligar este, o limite real era 2 MB — qualquer anexo
        // maior levava 413, que atraves do proxy chega no navegador como
        // "Failed to fetch". O app prometia 50 MB desde sempre e nunca
        // entregou.
        // Os arquivos de atualizacao dos clientes.
        //
        // Em Linux quem serve isto e o Caddy. No Windows, onde quem hospeda usa
        // o painel e nao tem proxy nenhum na frente, o proprio servidor entrega
        // — senao nao haveria como o dono distribuir atualizacao para os amigos
        // dele sem montar um segundo servidor web.
        .nest_service("/updates", ServeDir::new(updates_dir))
        .layer(DefaultBodyLimit::disable())
        .layer(RequestBodyLimitLayer::new(MAX_UPLOAD + 64 * 1024)).layer(cors)
        .layer(TraceLayer::new_for_http()).with_state(state);
    // A porta vem do ambiente para o painel de quem hospeda poder escolher: em
    // casa a 3040 pode ja estar tomada, e ate agora nao havia como desviar sem
    // recompilar. Sem a variavel, continua na 3040 de sempre.
    let porta: u16 = env::var("PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(3040);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", porta)).await
        .unwrap_or_else(|erro| panic!("porta {porta} indisponivel: {erro}"));
    println!("naoconcordo ouvindo em http://0.0.0.0:{porta}");
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await.expect("servidor encerrou");
}

fn required(name: &str) -> String { env::var(name).unwrap_or_else(|_| panic!("variavel obrigatoria ausente: {name}")) }
fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }
fn random_token(bytes: usize) -> String { let mut data = vec![0; bytes]; rand::rng().fill_bytes(&mut data); URL_SAFE_NO_PAD.encode(data) }
fn normalize_name(v: &str) -> String { v.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(24).collect() }
fn valid_name(v: &str) -> bool { let n = v.chars().count(); (2..=24).contains(&n) && v.chars().all(|c| c.is_alphanumeric() || "_. -".contains(c)) }
fn profile_key(v: &str) -> String { v.to_lowercase() }
fn default_room_id() -> String { DEFAULT_ROOM.into() }
fn default_server_id() -> String { "principal".into() }
fn error(status: StatusCode, message: &str) -> Response { (status, Json(ErrorBody { error: message.into() })).into_response() }
fn slugify(v: &str) -> String {
    let mut slug = String::new();
    for c in v.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() { slug.push(c); }
        else if (c.is_whitespace() || c == '-' || c == '_') && !slug.ends_with('-') { slug.push('-'); }
    }
    slug.trim_matches('-').chars().take(28).collect()
}

async fn health() -> Json<HealthOutput> { Json(HealthOutput { ok: true, service: "naoconcordo", time: Utc::now() }) }
async fn auth_challenge(State(state): State<AppState>, ConnectInfo(addr): ConnectInfo<SocketAddr>, Json(body): Json<UsernameInput>) -> Response {
    let username = normalize_name(&body.username);
    if !valid_name(&username) { return error(StatusCode::BAD_REQUEST, "Usuario deve ter de 2 a 24 caracteres."); }
    let account = state.users.read().await.get(&profile_key(&username)).cloned();
    let account_exists = account.is_some();
    let password_salt = account.as_ref().map(|value| value.password_salt.clone()).unwrap_or_else(|| random_token(18));
    let recovery_salt = account.map(|value| value.recovery_salt).unwrap_or_else(|| random_token(18));
    let nonce = random_token(32);
    state.challenges.write().await.insert(nonce.clone(), Challenge {
        username, expires_at: now() + 60, ip: addr.ip().to_string(),
        password_salt: password_salt.clone(), recovery_salt: recovery_salt.clone(), account_exists,
    });
    Json(ChallengeOutput {
        nonce, invite_salt: state.config.auth_salt.clone(), invite_iterations: 150_000,
        password_salt, recovery_salt, password_iterations: PASSWORD_ITERATIONS, account_exists,
    }).into_response()
}
fn valid_challenge(challenge: &Challenge, username: &str, addr: SocketAddr) -> bool {
    challenge.expires_at >= now() && challenge.ip == addr.ip().to_string() && challenge.username == username
}
async fn create_session(state: &AppState, username: String) -> Response {
    let token = random_token(32); let expires_at = now() + SESSION_SECONDS;
    state.sessions.write().await.insert(token.clone(), Session { username: username.clone(), expires_at, is_owner: false });
    let mut profiles = state.profiles.write().await;
    if !profiles.contains_key(&profile_key(&username)) {
        profiles.insert(profile_key(&username), Profile { username: username.clone(), color: None, avatar: None, avatar_file: None, bio: None, banner_file: None });
        persist_json(&state.config.data_dir, "profiles.json", &*profiles).await;
    }
    Json(LoginOutput { token, username, expires_at }).into_response()
}
async fn auth_register(State(state): State<AppState>, ConnectInfo(addr): ConnectInfo<SocketAddr>, Json(body): Json<RegisterInput>) -> Response {
    let username = normalize_name(&body.username);
    let Some(challenge) = state.challenges.write().await.remove(&body.nonce) else { return error(StatusCode::UNAUTHORIZED, "Desafio expirado. Tente novamente."); };
    if !valid_challenge(&challenge, &username, addr) { return error(StatusCode::UNAUTHORIZED, "Desafio expirado. Tente novamente."); }
    if challenge.account_exists || state.users.read().await.contains_key(&profile_key(&username)) { return error(StatusCode::CONFLICT, "Este usuario ja existe."); }
    let Ok(invite_proof) = URL_SAFE_NO_PAD.decode(body.invite_proof.as_bytes()) else { return error(StatusCode::UNAUTHORIZED, "Convite incorreto."); };
    // Cada convite serve uma conta so. A chave global de acesso vale apenas
    // enquanto nao existe nenhuma conta, para abrir a primeira instalacao.
    // O lock fica preso ate marcar o convite como usado; sem isso dois cadastros
    // simultaneos poderiam gastar o mesmo convite.
    let mut invites = state.invites.write().await;
    let matched = invites.iter().position(|invite| {
        if invite.revoked || invite.used_by.is_some() { return false; }
        let Ok(key) = URL_SAFE_NO_PAD.decode(invite.key.as_bytes()) else { return false; };
        let Ok(mut mac) = HmacSha256::new_from_slice(&key) else { return false; };
        mac.update(format!("{}:{}", body.nonce, username).as_bytes());
        mac.verify_slice(&invite_proof).is_ok()
    });
    if matched.is_none() {
        if !state.users.read().await.is_empty() { return error(StatusCode::UNAUTHORIZED, "Convite invalido ou ja usado."); }
        let Ok(mut invite_mac) = HmacSha256::new_from_slice(&state.auth_key) else { return error(StatusCode::INTERNAL_SERVER_ERROR, "Erro interno."); };
        invite_mac.update(format!("{}:{}", body.nonce, username).as_bytes());
        if invite_mac.verify_slice(&invite_proof).is_err() { return error(StatusCode::UNAUTHORIZED, "Convite incorreto."); }
    }
    let Ok(verifier) = URL_SAFE_NO_PAD.decode(body.verifier.as_bytes()) else { return error(StatusCode::BAD_REQUEST, "Senha invalida."); };
    if verifier.len() != 32 { return error(StatusCode::BAD_REQUEST, "Senha invalida."); }
    let Ok(recovery_verifier) = URL_SAFE_NO_PAD.decode(body.recovery_verifier.as_bytes()) else { return error(StatusCode::BAD_REQUEST, "Recuperacao invalida."); };
    if recovery_verifier.len() != 32 { return error(StatusCode::BAD_REQUEST, "Recuperacao invalida."); }
    let account = UserAccount {
        username: username.clone(), password_salt: challenge.password_salt,
        verifier: URL_SAFE_NO_PAD.encode(verifier), recovery_salt: challenge.recovery_salt,
        recovery_verifier: URL_SAFE_NO_PAD.encode(recovery_verifier), created_at: Utc::now(),
    };
    let mut users = state.users.write().await;
    users.insert(profile_key(&username), account);
    persist_json(&state.config.data_dir, "users.json", &*users).await;
    drop(users);
    if let Some(index) = matched {
        if let Some(invite) = invites.get_mut(index) {
            invite.used_by = Some(username.clone());
            invite.used_at = Some(Utc::now());
        }
        persist_json(&state.config.data_dir, "invites.json", &*invites).await;
    }
    drop(invites);
    create_session(&state, username).await
}
async fn auth_login(State(state): State<AppState>, ConnectInfo(addr): ConnectInfo<SocketAddr>, Json(body): Json<LoginInput>) -> Response {
    let username = normalize_name(&body.username);
    let Some(challenge) = state.challenges.write().await.remove(&body.nonce) else { return error(StatusCode::UNAUTHORIZED, "Desafio expirado. Tente novamente."); };
    if !valid_challenge(&challenge, &username, addr) { return error(StatusCode::UNAUTHORIZED, "Desafio expirado. Tente novamente."); }
    if !challenge.account_exists { return error(StatusCode::NOT_FOUND, "Usuario nao cadastrado. Crie sua conta."); }
    let Some(account) = state.users.read().await.get(&profile_key(&username)).cloned() else { return error(StatusCode::NOT_FOUND, "Usuario nao cadastrado."); };
    let Ok(verifier) = URL_SAFE_NO_PAD.decode(account.verifier.as_bytes()) else { return error(StatusCode::INTERNAL_SERVER_ERROR, "Conta invalida."); };
    let Ok(mut password_mac) = HmacSha256::new_from_slice(&verifier) else { return error(StatusCode::INTERNAL_SERVER_ERROR, "Erro interno."); };
    password_mac.update(format!("{}:{}", body.nonce, username).as_bytes());
    let Ok(proof) = URL_SAFE_NO_PAD.decode(body.proof.as_bytes()) else { return error(StatusCode::UNAUTHORIZED, "Usuario ou senha incorretos."); };
    if password_mac.verify_slice(&proof).is_err() { return error(StatusCode::UNAUTHORIZED, "Usuario ou senha incorretos."); }
    create_session(&state, account.username).await
}
async fn auth_recover(State(state): State<AppState>, ConnectInfo(addr): ConnectInfo<SocketAddr>, Json(body): Json<RecoverInput>) -> Response {
    let username = normalize_name(&body.username);
    let Some(challenge) = state.challenges.write().await.remove(&body.nonce) else { return error(StatusCode::UNAUTHORIZED, "Desafio expirado. Tente novamente."); };
    if !valid_challenge(&challenge, &username, addr) || !challenge.account_exists { return error(StatusCode::UNAUTHORIZED, "Recuperacao invalida."); }
    let key = profile_key(&username);
    let Some(account) = state.users.read().await.get(&key).cloned() else { return error(StatusCode::UNAUTHORIZED, "Recuperacao invalida."); };
    let Ok(recovery_verifier) = URL_SAFE_NO_PAD.decode(account.recovery_verifier.as_bytes()) else { return error(StatusCode::INTERNAL_SERVER_ERROR, "Conta invalida."); };
    let Ok(mut recovery_mac) = HmacSha256::new_from_slice(&recovery_verifier) else { return error(StatusCode::INTERNAL_SERVER_ERROR, "Erro interno."); };
    recovery_mac.update(format!("{}:{}", body.nonce, username).as_bytes());
    let Ok(recovery_proof) = URL_SAFE_NO_PAD.decode(body.recovery_proof.as_bytes()) else { return error(StatusCode::UNAUTHORIZED, "Codigo de recuperacao incorreto."); };
    if recovery_mac.verify_slice(&recovery_proof).is_err() { return error(StatusCode::UNAUTHORIZED, "Codigo de recuperacao incorreto."); }
    let Ok(verifier) = URL_SAFE_NO_PAD.decode(body.verifier.as_bytes()) else { return error(StatusCode::BAD_REQUEST, "Senha invalida."); };
    let Ok(new_recovery_verifier) = URL_SAFE_NO_PAD.decode(body.recovery_verifier.as_bytes()) else { return error(StatusCode::BAD_REQUEST, "Recuperacao invalida."); };
    if verifier.len() != 32 || new_recovery_verifier.len() != 32 { return error(StatusCode::BAD_REQUEST, "Dados de recuperacao invalidos."); }
    let mut users = state.users.write().await;
    if let Some(value) = users.get_mut(&key) {
        value.verifier = URL_SAFE_NO_PAD.encode(verifier);
        value.recovery_verifier = URL_SAFE_NO_PAD.encode(new_recovery_verifier);
    }
    persist_json(&state.config.data_dir, "users.json", &*users).await;
    drop(users);
    create_session(&state, account.username).await
}
fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers.get("authorization")?.to_str().ok()?.strip_prefix("Bearer ")
}
async fn authenticated(state: &AppState, headers: &HeaderMap) -> Option<(String, Session)> {
    let token = bearer(headers)?.to_string(); let session = state.sessions.read().await.get(&token)?.clone();
    (session.expires_at >= now()).then_some((token, session))
}
async fn get_session(State(state): State<AppState>, headers: HeaderMap) -> Response {
    match authenticated(&state, &headers).await { Some((_, s)) => Json(SessionOutput { username: s.username }).into_response(), None => error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada.") }
}
async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response { if let Some(token) = bearer(&headers) { state.sessions.write().await.remove(token); } StatusCode::NO_CONTENT.into_response() }
/// Papel da pessoa no servidor, ou None se ela nao participa.
fn role_of(memberships: &HashMap<String, Vec<Member>>, server_id: &str, username: &str) -> Option<ServerRole> {
    let key = profile_key(username);
    memberships.get(server_id)?.iter().find(|m| m.username == key).map(|m| m.role)
}
fn is_member(memberships: &HashMap<String, Vec<Member>>, server_id: &str, username: &str) -> bool {
    role_of(memberships, server_id, username).is_some()
}
fn manages(memberships: &HashMap<String, Vec<Member>>, server_id: &str, username: &str) -> bool {
    role_of(memberships, server_id, username).is_some_and(ServerRole::manages)
}
fn members_of(memberships: &HashMap<String, Vec<Member>>, server_id: &str) -> Vec<String> {
    memberships.get(server_id).map(|list| list.iter().map(|m| m.username.clone()).collect()).unwrap_or_default()
}

async fn bootstrap(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    // So vao os servidores de que a pessoa participa, e os canais deles.
    let memberships = state.memberships.read().await;
    let servers: Vec<ServerInfo> = state.servers.read().await.iter()
        .filter(|server| is_member(&memberships, &server.id, &session.username))
        .cloned().collect();
    let visible: Vec<String> = servers.iter().map(|server| server.id.clone()).collect();
    let mut rooms: Vec<RoomInfo> = state.rooms.read().await.iter()
        .filter(|room| visible.contains(&room.server_id)).cloned().collect();
    // Ordenado aqui para todo cliente desenhar igual. O desempate por data e o
    // que preserva a ordem antiga de quem nunca arrastou nada: aqueles canais
    // tem todos `posicao` zero.
    rooms.sort_by(|a, b| a.posicao.cmp(&b.posicao).then_with(|| a.created_at.cmp(&b.created_at)));
    let mut categorias: Vec<Categoria> = state.categorias.read().await.iter()
        .filter(|categoria| visible.contains(&categoria.server_id)).cloned().collect();
    // Ordenadas aqui para todo cliente desenhar igual, sem cada um inventar a
    // sua regra de desempate.
    categorias.sort_by(|a, b| a.posicao.cmp(&b.posicao).then_with(|| a.name.cmp(&b.name)));
    let roles: HashMap<String, ServerRole> = servers.iter()
        .filter_map(|server| role_of(&memberships, &server.id, &session.username).map(|role| (server.id.clone(), role)))
        .collect();
    // So a presenca de quem tem relacao com a pessoa: colegas de servidor e
    // amigos. Antes ia a lista inteira de conectados do sistema.
    let relacionados = presence_audience(&state, &session.username).await;
    let online: Vec<String> = state.online.read().await.iter()
        .filter(|(name, count)| **count > 0 && relacionados.contains(name))
        .map(|(name, _)| name.clone()).collect();
    // So os canais de voz que a pessoa enxerga; o resto nao e da conta dela.
    let visiveis: Vec<String> = rooms.iter().map(|room| room.id.clone()).collect();
    let voice: HashMap<String, Vec<String>> = state.voice.read().await.iter()
        .filter(|(room_id, gente)| visiveis.contains(room_id) && !gente.is_empty())
        .map(|(room_id, gente)| (room_id.clone(), gente.clone())).collect();
    Json(BootstrapOutput {
        servers, rooms,
        profiles: state.profiles.read().await.values().cloned().collect(),
        is_owner: session.is_owner, is_admin: is_admin(&state, &session.username), roles, online, voice,
        categorias,
        gifs: state.config.gif_key.is_some(),
    }).into_response()
}
/// Admin do sistema: quem emite convites e ve quem os usou.
fn is_admin(state: &AppState, username: &str) -> bool {
    profile_key(username) == profile_key(&state.config.admin_username)
}
fn invite_view(invite: &Invite) -> InviteView {
    InviteView {
        code: invite.code.clone(), label: invite.label.clone(), created_at: invite.created_at,
        created_by: invite.created_by.clone(), used_by: invite.used_by.clone(),
        used_at: invite.used_at, revoked: invite.revoked,
    }
}
async fn list_invites(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    if !is_admin(&state, &session.username) { return error(StatusCode::FORBIDDEN, "Somente o admin ve os convites."); }
    let mut invites: Vec<InviteView> = state.invites.read().await.iter().map(invite_view).collect();
    invites.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Json(InvitesOutput { invites }).into_response()
}
async fn create_invite(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<CreateInviteInput>) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    if !is_admin(&state, &session.username) { return error(StatusCode::FORBIDDEN, "Somente o admin cria convites."); }
    let code = random_token(9);
    // Derivamos aqui a mesma chave que o cliente vai derivar do codigo. Assim o
    // cadastro compara HMAC barato em vez de rodar PBKDF2 por convite.
    let mut key = [0_u8; 32];
    pbkdf2_hmac::<Sha256>(code.as_bytes(), state.config.auth_salt.as_bytes(), 150_000, &mut key);
    let invite = Invite {
        code, key: URL_SAFE_NO_PAD.encode(key), label: normalize_name(&body.label),
        created_at: Utc::now(), created_by: session.username.clone(),
        used_by: None, used_at: None, revoked: false,
    };
    let view = invite_view(&invite);
    let mut invites = state.invites.write().await;
    invites.push(invite);
    persist_json(&state.config.data_dir, "invites.json", &*invites).await;
    (StatusCode::CREATED, Json(view)).into_response()
}
async fn revoke_invite(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<InviteCodeInput>) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    if !is_admin(&state, &session.username) { return error(StatusCode::FORBIDDEN, "Somente o admin revoga convites."); }
    let mut invites = state.invites.write().await;
    let Some(invite) = invites.iter_mut().find(|invite| invite.code == body.code) else {
        return error(StatusCode::NOT_FOUND, "Convite nao encontrado.");
    };
    if invite.used_by.is_some() { return error(StatusCode::CONFLICT, "Este convite ja foi usado."); }
    invite.revoked = true;
    persist_json(&state.config.data_dir, "invites.json", &*invites).await;
    StatusCode::NO_CONTENT.into_response()
}
async fn unlock_owner(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<OwnerInput>) -> Response {
    let Some((token, _)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    if body.code != state.config.owner_password { return error(StatusCode::FORBIDDEN, "Codigo de proprietario incorreto."); }
    if let Some(session) = state.sessions.write().await.get_mut(&token) { session.is_owner = true; }
    Json(OwnerOutput { is_owner: true }).into_response()
}
async fn create_server(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<CreateServerInput>) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    // Qualquer conta cria servidor: quem cria vira dono e so enxerga quem for
    // convidado. O codigo de proprietario global saiu daqui.
    let name = normalize_name(&body.name); let base = slugify(&name);
    if name.chars().count() < 2 || base.len() < 2 { return error(StatusCode::BAD_REQUEST, "O nome precisa ter pelo menos 2 caracteres."); }
    let mut servers = state.servers.write().await; let mut id = base.clone(); let mut suffix = 2;
    while servers.iter().any(|server| server.id == id) { id = format!("{base}-{suffix}"); suffix += 1; }
    let server = ServerInfo { id: id.clone(), name, created_at: Utc::now(), icon_file: None, banner_file: None, description: None };
    servers.push(server.clone()); persist_json(&state.config.data_dir, "servers.json", &*servers).await;
    // Quem cria e o primeiro membro; ninguem mais enxerga ate ser convidado.
    let mut memberships = state.memberships.write().await;
    memberships.insert(id.clone(), vec![Member { username: profile_key(&session.username), role: ServerRole::Owner, nickname: None, avatar_file: None }]);
    persist_json(&state.config.data_dir, "memberships.json", &*memberships).await;
    drop(memberships);
    // Servidor novo nasce com um canal de texto e um de voz, como no Discord.
    let mut rooms = state.rooms.write().await;
    rooms.push(RoomInfo { id: format!("{id}-geral"), name: "geral".into(), created_at: Utc::now(), server_id: id.clone(), kind: RoomKind::Text, category_id: None, posicao: 0 });
    rooms.push(RoomInfo { id: format!("{id}-voz-geral"), name: "Geral".into(), created_at: Utc::now(), server_id: id, kind: RoomKind::Voice, category_id: None, posicao: 0 });
    persist_json(&state.config.data_dir, "rooms.json", &*rooms).await;
    Json(server).into_response()
}
async fn create_room(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<CreateRoomInput>) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    // Quem manda aqui e o papel dentro do servidor, nao o codigo de proprietario
    // global — esse continua valendo so para criar um servidor novo.
    if !state.servers.read().await.iter().any(|server| server.id == body.server_id) { return error(StatusCode::NOT_FOUND, "Servidor nao encontrado."); }
    {
        let memberships = state.memberships.read().await;
        if !manages(&memberships, &body.server_id, &session.username) {
            return error(StatusCode::FORBIDDEN, "Somente dono ou moderador cria canal.");
        }
    }
    let name = normalize_name(&body.name);
    // Canal de voz e de texto vivem em espacos de id separados, entao dois canais
    // podem se chamar "geral" sem colidir.
    let prefix = if body.kind == RoomKind::Voice { "voz-" } else { "" };
    let base = format!("{}-{}{}", body.server_id, prefix, slugify(&name));
    if name.chars().count() < 2 || base.len() < 2 { return error(StatusCode::BAD_REQUEST, "O nome da sala precisa ter pelo menos 2 caracteres."); }
    let mut rooms = state.rooms.write().await;
    if rooms.len() >= 60 { return error(StatusCode::BAD_REQUEST, "Limite de 60 canais atingido."); }
    let mut id = base.clone(); let mut suffix = 2;
    while rooms.iter().any(|r| r.id == id) { id = format!("{base}-{suffix}"); suffix += 1; }
    // No fim da lista daquele servidor: canal novo aparece embaixo, que e onde
    // quem acabou de criar vai procurar.
    let posicao = rooms.iter()
        .filter(|outro| outro.server_id == body.server_id)
        .map(|outro| outro.posicao).max().unwrap_or(-1) + 1;
    let room = RoomInfo {
        id, name, created_at: Utc::now(), server_id: body.server_id, kind: body.kind,
        category_id: body.category_id.filter(|valor| !valor.is_empty()),
        posicao,
    };
    rooms.push(room.clone()); persist_json(&state.config.data_dir, "rooms.json", &*rooms).await;
    let audience = { let memberships = state.memberships.read().await; members_of(&memberships, &room.server_id) };
    let _ = state.events.send(Broadcast::to_many(audience, ServerEvent::RoomCreated { room: room.clone() }));
    (StatusCode::CREATED, Json(room)).into_response()
}
async fn update_avatar(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<AvatarInput>) -> Response {
    let Some((_, s)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    if let Some(a) = &body.avatar {
        let ok = a.starts_with("data:image/png;base64,") || a.starts_with("data:image/jpeg;base64,") || a.starts_with("data:image/webp;base64,");
        if !ok || a.len() > 420_000 { return error(StatusCode::BAD_REQUEST, "Imagem invalida ou muito grande."); }
    }
    if let Some(id) = &body.avatar_file {
        if !state.files.read().await.contains_key(id) { return error(StatusCode::NOT_FOUND, "Arquivo nao encontrado."); }
    }
    let mut profiles = state.profiles.write().await;
    let key = profile_key(&s.username);
    let mut profile = profiles.get(&key).cloned().unwrap_or_else(|| Profile { username: s.username.clone(), color: None, avatar: None, avatar_file: None, bio: None, banner_file: None });
    profile.avatar = body.avatar;
    profile.avatar_file = body.avatar_file;
    profiles.insert(key, profile.clone());
    persist_json(&state.config.data_dir, "profiles.json", &*profiles).await;
    let _ = state.events.send(Broadcast::all(ServerEvent::ProfileUpdated { profile: profile.clone() }));
    Json(profile).into_response()
}
async fn update_profile(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<ProfileInput>) -> Response {
    let Some((_, s)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    if let Some(Some(bio)) = &body.bio {
        if bio.chars().count() > 190 { return error(StatusCode::BAD_REQUEST, "Biografia muito longa."); }
    }
    if let Some(Some(id)) = &body.banner_file {
        if !state.files.read().await.contains_key(id) { return error(StatusCode::NOT_FOUND, "Arquivo nao encontrado."); }
    }
    if let Some(Some(cor)) = &body.color {
        if !cor_valida(cor) { return error(StatusCode::BAD_REQUEST, "Cor invalida."); }
    }
    let mut profiles = state.profiles.write().await;
    let key = profile_key(&s.username);
    let mut profile = profiles.get(&key).cloned().unwrap_or_else(|| Profile { username: s.username.clone(), color: None, avatar: None, avatar_file: None, bio: None, banner_file: None });
    if let Some(bio) = body.bio { profile.bio = bio; }
    if let Some(banner) = body.banner_file { profile.banner_file = banner; }
    if let Some(cor) = body.color { profile.color = cor; }
    profiles.insert(key, profile.clone());
    persist_json(&state.config.data_dir, "profiles.json", &*profiles).await;
    let _ = state.events.send(Broadcast::all(ServerEvent::ProfileUpdated { profile: profile.clone() }));
    Json(profile).into_response()
}
async fn livekit_token(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<LivekitInput>) -> Response {
    let Some((_, s)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    let Some(room) = state.rooms.read().await.iter().find(|r| r.id == body.room_id).cloned() else { return error(StatusCode::NOT_FOUND, "Canal nao encontrado."); };
    if room.kind != RoomKind::Voice { return error(StatusCode::BAD_REQUEST, "Este canal e de texto."); }
    {
        let memberships = state.memberships.read().await;
        if !is_member(&memberships, &room.server_id, &s.username) {
            return error(StatusCode::FORBIDDEN, "Voce nao participa deste servidor.");
        }
    }
    let livekit_room = format!("naoconcordo-{}", body.room_id); let issued = now();
    // Tres sabores de token na mesma rota:
    //
    // - normal: publica e assina, aparece como a pessoa;
    // - espectador (`viewer`): a janela de cameras so assina faixas, nunca
    //   publica, e fica invisivel para os outros participantes;
    // - tela (`screen`): a captura nativa entra como um segundo participante,
    //   que so publica. Nao pode ser `hidden`, senao o LiveKit nao entrega a
    //   faixa para ninguem. Ele nao vira um fantasma na lista porque divide o
    //   `name` com a pessoa, e a interface agrupa por nome; o `metadata` fica
    //   como marca explicita, util para depurar quem e quem numa sala.
    //
    // A identidade e fixa, uma por sabor. Antes ela levava um sufixo sorteado
    // a cada pedido de token, e cada conexao virava uma pessoa diferente aos
    // olhos do LiveKit. Quando uma conexao caia sem se despedir — queda de
    // rede, aplicativo fechado no tapa — a antiga ficava na sala como fantasma
    // que ainda publica microfone, e quem voltava encontrava a si mesmo e se
    // ouvia. Com identidade fixa o LiveKit desconecta a conexao velha sozinho
    // assim que a nova entra, que e exatamente o que se quer.
    //
    // O `#` separa porque `valid_name` nao o aceita num nome de usuario: assim
    // ninguem consegue registrar um nome que colida com a tela de outra pessoa.
    let sub = if body.screen { format!("{}#tela", s.username) }
              else if body.viewer { format!("{}#cameras", s.username) }
              else { s.username.clone() };
    let metadata = body.screen.then(|| format!(r#"{{"kind":"screen","owner":{}}}"#,
        serde_json::Value::String(s.username.clone())));
    let claims = LivekitClaims { iss: state.config.livekit_key.clone(), sub, name: s.username,
        nbf: issued.saturating_sub(10), exp: issued + 21600,
        video: VideoGrant {
            room_join: true, room: livekit_room.clone(),
            can_publish: !body.viewer,
            // O publicador de tela nao assina nada: ele so manda video e audio.
            can_subscribe: !body.screen,
            can_publish_data: !body.viewer && !body.screen, hidden: body.viewer,
            // So a conexao da pessoa mexe nos proprios atributos: a captura de
            // tela e a janela de cameras nao tem estado a anunciar.
            can_update_own_metadata: !body.viewer && !body.screen,
        },
        metadata };
    match encode(&Header::new(Algorithm::HS256), &claims, &EncodingKey::from_secret(state.config.livekit_secret.as_bytes())) {
        Ok(token) => Json(LivekitOutput { token, url: state.config.livekit_url.clone(), room: livekit_room }).into_response(),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Nao foi possivel entrar na sala."),
    }
}
/// Duas pessoas sao amigas quando existe um vinculo aceito, em qualquer direcao.
fn friends_already(list: &[Friendship], a: &str, b: &str) -> bool {
    list.iter().any(|f| f.status == FriendStatus::Accepted && pair_matches(f, a, b))
}
fn pair_matches(f: &Friendship, a: &str, b: &str) -> bool {
    let (ka, kb) = (profile_key(a), profile_key(b));
    (profile_key(&f.requester) == ka && profile_key(&f.addressee) == kb)
        || (profile_key(&f.requester) == kb && profile_key(&f.addressee) == ka)
}
fn valid_b64(value: &str, max_bytes: usize) -> bool {
    matches!(URL_SAFE_NO_PAD.decode(value.as_bytes()), Ok(bytes) if !bytes.is_empty() && bytes.len() <= max_bytes)
}

async fn list_members(State(state): State<AppState>, headers: HeaderMap, axum::extract::Path(server_id): axum::extract::Path<String>) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    let memberships = state.memberships.read().await;
    if !is_member(&memberships, &server_id, &session.username) { return error(StatusCode::FORBIDDEN, "Voce nao participa deste servidor."); }
    // Devolve o nome como a pessoa escreveu, nao a chave em minusculas.
    let users = state.users.read().await;
    let members: Vec<MemberEntry> = memberships.get(&server_id).map(|list| list.iter().map(|member| MemberEntry {
        username: users.get(&member.username).map(|a| a.username.clone()).unwrap_or_else(|| member.username.clone()),
        role: member.role,
        nickname: member.nickname.clone(),
        avatar_file: member.avatar_file.clone(),
    }).collect()).unwrap_or_default();
    let my_role = role_of(&memberships, &server_id, &session.username).unwrap_or(ServerRole::Member);
    Json(MembersOutput { members, my_role }).into_response()
}

async fn update_server_member_profile(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(server_id): axum::extract::Path<String>,
    Json(body): Json<ServerMemberProfileInput>,
) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else {
        return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada.");
    };
    if let Some(nick) = &body.nickname {
        if nick.chars().count() > 32 {
            return error(StatusCode::BAD_REQUEST, "Apelido muito longo (max 32 caracteres).");
        }
    }
    if let Some(id) = &body.avatar_file {
        if !state.files.read().await.contains_key(id) {
            return error(StatusCode::NOT_FOUND, "Arquivo de foto nao encontrado.");
        }
    }
    let user_key = profile_key(&session.username);
    let mut memberships = state.memberships.write().await;
    let Some(list) = memberships.get_mut(&server_id) else {
        return error(StatusCode::NOT_FOUND, "Servidor nao encontrado.");
    };
    let Some(member) = list.iter_mut().find(|m| profile_key(&m.username) == user_key) else {
        return error(StatusCode::FORBIDDEN, "Voce nao participa deste servidor.");
    };

    member.nickname = body.nickname.and_then(|n| {
        let t = n.trim().to_string();
        if t.is_empty() { None } else { Some(t) }
    });
    member.avatar_file = body.avatar_file.and_then(|a| {
        let t = a.trim().to_string();
        if t.is_empty() { None } else { Some(t) }
    });
    let updated_entry = MemberEntry {
        username: session.username.clone(),
        role: member.role,
        nickname: member.nickname.clone(),
        avatar_file: member.avatar_file.clone(),
    };
    persist_json(&state.config.data_dir, "memberships.json", &*memberships).await;
    let audience = members_of(&memberships, &server_id);
    drop(memberships);

    let _ = state.events.send(Broadcast::to_many(audience, ServerEvent::MembersChanged { server_id }));
    Json(updated_entry).into_response()
}
async fn add_member(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<MemberInput>) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    let target = normalize_name(&body.username);
    let Some(account) = state.users.read().await.get(&profile_key(&target)).cloned() else { return error(StatusCode::NOT_FOUND, "Usuario nao encontrado."); };
    let Some(server) = state.servers.read().await.iter().find(|server| server.id == body.server_id).cloned()
        else { return error(StatusCode::NOT_FOUND, "Servidor nao encontrado."); };
    {
        let memberships = state.memberships.read().await;
        if !manages(&memberships, &body.server_id, &session.username) { return error(StatusCode::FORBIDDEN, "Somente dono ou moderador convida."); }
        if is_member(&memberships, &body.server_id, &account.username) { return error(StatusCode::CONFLICT, "Esta pessoa ja participa."); }
    }
    // Ninguem mais e jogado dentro de um servidor: fica um convite esperando
    // resposta, e o aviso chega na hora pelo WebSocket.
    let mut invites = state.server_invites.write().await;
    if invites.iter().any(|invite| invite.server_id == body.server_id && profile_key(&invite.to) == profile_key(&account.username)) {
        return error(StatusCode::CONFLICT, "Esta pessoa ja tem um convite pendente.");
    }
    let invite = ServerInvite {
        id: Uuid::new_v4(), server_id: server.id.clone(), server_name: server.name.clone(),
        from: session.username.clone(), to: account.username.clone(), created_at: Utc::now(),
    };
    invites.push(invite.clone());
    persist_json(&state.config.data_dir, "server-invites.json", &*invites).await;
    drop(invites);
    let _ = state.events.send(Broadcast::to([&invite.to, &invite.from], ServerEvent::ServerInvited { invite: invite.clone() }));
    StatusCode::NO_CONTENT.into_response()
}
async fn list_server_invites(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    let invites: Vec<ServerInvite> = state.server_invites.read().await.iter()
        .filter(|invite| profile_key(&invite.to) == profile_key(&session.username))
        .cloned().collect();
    Json(ServerInvitesOutput { invites }).into_response()
}
/// Tira o convite da fila. Devolve o convite so para quem era o destinatario.
async fn take_invite(state: &AppState, id: Uuid, username: &str) -> Option<ServerInvite> {
    let mut invites = state.server_invites.write().await;
    let position = invites.iter().position(|invite| invite.id == id && profile_key(&invite.to) == profile_key(username))?;
    let invite = invites.remove(position);
    persist_json(&state.config.data_dir, "server-invites.json", &*invites).await;
    Some(invite)
}
async fn accept_server_invite(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<InviteIdInput>) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    let Some(invite) = take_invite(&state, body.invite_id, &session.username).await else {
        return error(StatusCode::NOT_FOUND, "Convite nao encontrado.");
    };
    let Some(server) = state.servers.read().await.iter().find(|server| server.id == invite.server_id).cloned() else {
        return error(StatusCode::NOT_FOUND, "Este servidor nao existe mais.");
    };
    let audiencia = {
        let mut memberships = state.memberships.write().await;
        let list = memberships.entry(invite.server_id.clone()).or_default();
        if !list.iter().any(|member| member.username == profile_key(&session.username)) {
            list.push(Member { username: profile_key(&session.username), role: ServerRole::Member, nickname: None, avatar_file: None });
        }
        persist_json(&state.config.data_dir, "memberships.json", &*memberships).await;
        members_of(&memberships, &invite.server_id)
    };
    let rooms: Vec<RoomInfo> = state.rooms.read().await.iter()
        .filter(|room| room.server_id == invite.server_id).cloned().collect();
    // Quem entrou precisa dos canais junto: o bootstrap dele nao trazia nada
    // deste servidor, e sem isso a barra ficava vazia ate reabrir o app.
    let _ = state.events.send(Broadcast::to_one(&session.username, ServerEvent::ServerJoined { server, rooms, role: ServerRole::Member }));
    let _ = state.events.send(Broadcast::to_many(audiencia, ServerEvent::MembersChanged { server_id: invite.server_id.clone() }));
    let _ = state.events.send(Broadcast::to_one(&invite.from, ServerEvent::ServerInviteResolved {
        invite_id: invite.id, accepted: true, username: session.username.clone(), server_id: invite.server_id,
    }));
    StatusCode::NO_CONTENT.into_response()
}
async fn reject_server_invite(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<InviteIdInput>) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    let Some(invite) = take_invite(&state, body.invite_id, &session.username).await else {
        return error(StatusCode::NOT_FOUND, "Convite nao encontrado.");
    };
    let _ = state.events.send(Broadcast::to_one(&invite.from, ServerEvent::ServerInviteResolved {
        invite_id: invite.id, accepted: false, username: session.username.clone(), server_id: invite.server_id,
    }));
    StatusCode::NO_CONTENT.into_response()
}
async fn remove_member(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<MemberInput>) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    let target = profile_key(&normalize_name(&body.username));
    let mut memberships = state.memberships.write().await;
    let Some(mine) = role_of(&memberships, &body.server_id, &session.username) else { return error(StatusCode::FORBIDDEN, "Voce nao participa deste servidor."); };
    if !mine.manages() { return error(StatusCode::FORBIDDEN, "Somente dono ou moderador expulsa."); }
    let Some(theirs) = role_of(&memberships, &body.server_id, &target) else { return error(StatusCode::NOT_FOUND, "Esta pessoa nao participa."); };
    if theirs == ServerRole::Owner { return error(StatusCode::FORBIDDEN, "O dono nao pode ser expulso."); }
    // Moderador nao mexe em outro moderador; so o dono faz isso.
    if theirs == ServerRole::Mod && mine != ServerRole::Owner { return error(StatusCode::FORBIDDEN, "Somente o dono expulsa um moderador."); }
    let Some(list) = memberships.get_mut(&body.server_id) else { return error(StatusCode::NOT_FOUND, "Servidor nao encontrado."); };
    list.retain(|member| member.username != target);
    persist_json(&state.config.data_dir, "memberships.json", &*memberships).await;
    let restantes = members_of(&memberships, &body.server_id);
    drop(memberships);
    let _ = state.events.send(Broadcast::to_one(&target, ServerEvent::ServerLeft { server_id: body.server_id.clone() }));
    let _ = state.events.send(Broadcast::to_many(restantes, ServerEvent::MembersChanged { server_id: body.server_id }));
    StatusCode::NO_CONTENT.into_response()
}

/// Promove ou rebaixa. Só o dono mexe em papel, e a troca de dono é uma
/// transferência: quem era dono vira moderador, para não ficarem dois.
async fn set_member_role(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<RoleInput>) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    let target = profile_key(&normalize_name(&body.username));
    let mut memberships = state.memberships.write().await;
    if role_of(&memberships, &body.server_id, &session.username) != Some(ServerRole::Owner) {
        return error(StatusCode::FORBIDDEN, "Somente o dono muda papeis.");
    }
    if target == profile_key(&session.username) { return error(StatusCode::BAD_REQUEST, "Voce nao muda o proprio papel."); }
    let Some(list) = memberships.get_mut(&body.server_id) else { return error(StatusCode::NOT_FOUND, "Servidor nao encontrado."); };
    if !list.iter().any(|member| member.username == target) { return error(StatusCode::NOT_FOUND, "Esta pessoa nao participa."); }
    if body.role == ServerRole::Owner {
        for member in list.iter_mut() {
            if member.role == ServerRole::Owner { member.role = ServerRole::Mod; }
        }
    }
    for member in list.iter_mut() {
        if member.username == target { member.role = body.role; }
    }
    persist_json(&state.config.data_dir, "memberships.json", &*memberships).await;
    let audiencia = members_of(&memberships, &body.server_id);
    // Quem virou dono numa transferencia precisa saber que perdeu ou ganhou o
    // papel sem reabrir o app; os botoes do painel dependem disso.
    let antigo_dono = profile_key(&session.username);
    drop(memberships);
    let _ = state.events.send(Broadcast::to_one(&target, ServerEvent::RoleChanged { server_id: body.server_id.clone(), role: body.role }));
    if body.role == ServerRole::Owner {
        let _ = state.events.send(Broadcast::to_one(&antigo_dono, ServerEvent::RoleChanged { server_id: body.server_id.clone(), role: ServerRole::Mod }));
    }
    let _ = state.events.send(Broadcast::to_many(audiencia, ServerEvent::MembersChanged { server_id: body.server_id }));
    StatusCode::NO_CONTENT.into_response()
}
/// Sair por conta propria. O dono precisa transferir antes.
async fn leave_server(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<ServerIdInput>) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    let me = profile_key(&session.username);
    let mut memberships = state.memberships.write().await;
    let Some(mine) = role_of(&memberships, &body.server_id, &session.username) else { return error(StatusCode::NOT_FOUND, "Voce nao participa deste servidor."); };
    if mine == ServerRole::Owner { return error(StatusCode::BAD_REQUEST, "Passe o servidor para outra pessoa antes de sair."); }
    if let Some(list) = memberships.get_mut(&body.server_id) { list.retain(|member| member.username != me); }
    persist_json(&state.config.data_dir, "memberships.json", &*memberships).await;
    let restantes = members_of(&memberships, &body.server_id);
    drop(memberships);
    let _ = state.events.send(Broadcast::to_many(restantes, ServerEvent::MembersChanged { server_id: body.server_id }));
    StatusCode::NO_CONTENT.into_response()
}
/// Apaga o servidor, seus canais e as mensagens deles. So o dono.
async fn delete_server(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<ServerIdInput>) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    let mut memberships = state.memberships.write().await;
    if role_of(&memberships, &body.server_id, &session.username) != Some(ServerRole::Owner) {
        return error(StatusCode::FORBIDDEN, "Somente o dono apaga o servidor.");
    }
    let doomed: Vec<String> = state.rooms.read().await.iter()
        .filter(|room| room.server_id == body.server_id).map(|room| room.id.clone()).collect();
    {
        let mut rooms = state.rooms.write().await;
        rooms.retain(|room| room.server_id != body.server_id);
        persist_json(&state.config.data_dir, "rooms.json", &*rooms).await;
    }
    {
        let mut messages = state.messages.write().await;
        messages.retain(|message| !doomed.contains(&message.room_id));
        persist_json(&state.config.data_dir, "messages.json", &*messages).await;
    }
    {
        let mut servers = state.servers.write().await;
        servers.retain(|server| server.id != body.server_id);
        persist_json(&state.config.data_dir, "servers.json", &*servers).await;
    }
    let atingidos = members_of(&memberships, &body.server_id);
    memberships.remove(&body.server_id);
    persist_json(&state.config.data_dir, "memberships.json", &*memberships).await;
    drop(memberships);
    // Convite para um servidor que deixou de existir vira lixo.
    {
        let mut invites = state.server_invites.write().await;
        let antes = invites.len();
        invites.retain(|invite| invite.server_id != body.server_id);
        if invites.len() != antes { persist_json(&state.config.data_dir, "server-invites.json", &*invites).await; }
    }
    let _ = state.events.send(Broadcast::to_many(atingidos, ServerEvent::ServerLeft { server_id: body.server_id }));
    StatusCode::NO_CONTENT.into_response()
}

async fn customize_server(State(state): State<AppState>, headers: HeaderMap, axum::extract::Path(id): axum::extract::Path<String>, Json(body): Json<CustomizeServerInput>) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    
    let memberships = state.memberships.read().await;
    if role_of(&memberships, &id, &session.username) != Some(ServerRole::Owner) {
        return error(StatusCode::FORBIDDEN, "Somente o dono pode personalizar o servidor.");
    }
    
    if let Some(name) = &body.name {
        let name = normalize_name(name);
        if name.chars().count() < 2 { return error(StatusCode::BAD_REQUEST, "O nome precisa ter pelo menos 2 caracteres."); }
    }
    if let Some(Some(desc)) = &body.description {
        if desc.chars().count() > 300 { return error(StatusCode::BAD_REQUEST, "Descricao muito longa."); }
    }
    {
        let files = state.files.read().await;
        if let Some(Some(file_id)) = &body.icon_file {
            if !files.contains_key(file_id) { return error(StatusCode::NOT_FOUND, "Arquivo de icone nao encontrado."); }
        }
        if let Some(Some(file_id)) = &body.banner_file {
            if !files.contains_key(file_id) { return error(StatusCode::NOT_FOUND, "Arquivo de banner nao encontrado."); }
        }
    }
    
    let updated = {
        let mut servers = state.servers.write().await;
        let Some(server) = servers.iter_mut().find(|s| s.id == id) else { return error(StatusCode::NOT_FOUND, "Servidor nao encontrado."); };
        if let Some(name) = body.name { server.name = normalize_name(&name); }
        if let Some(desc) = body.description { server.description = desc; }
        if let Some(icon) = body.icon_file { server.icon_file = icon; }
        if let Some(banner) = body.banner_file { server.banner_file = banner; }
        let updated = server.clone();
        persist_json(&state.config.data_dir, "servers.json", &*servers).await;
        updated
    };
    
    let audience = members_of(&memberships, &id);
    let _ = state.events.send(Broadcast::to_many(audience, ServerEvent::ServerUpdated { server: updated.clone() }));
    Json(updated).into_response()
}


/// Tipos aceitos. GIF entra na lista para o avatar animado funcionar.
fn allowed_mime(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "video/mp4" => Some("mp4"),
        "video/webm" => Some("webm"),
        "audio/mpeg" => Some("mp3"),
        "audio/ogg" => Some("ogg"),
        _ => None,
    }
}

/// Recebe os bytes crus. O nome vai no cabecalho, nao no corpo, para nao
/// precisar de multipart nem de base64 (que incharia 33% um arquivo de 50 MB).
/// Limpa o nome que o remetente escolheu para o anexo.
///
/// O nome vem de outra pessoa, entao e entrada nao confiavel: barra,
/// contrabarra e `..` precisam sair, senao um nome como `..\..\algo.exe`
/// atravessaria pastas na hora de alguem salvar.
///
/// **O ponto simples fica.** A versao anterior filtrava os caracteres do
/// conjunto `"/\.."`, e como isso e um conjunto e nao uma sequencia, ela
/// apagava todo ponto: `foto.png` virava `fotopng`, e todo anexo perdia a
/// extensao. Sem extensao o navegador nao sabe o que abrir, e o arquivo salvo
/// chega sem tipo.
fn nome_de_anexo(bruto: &str, ext: &str) -> String {
    // So o ultimo trecho interessa: o resto seria caminho.
    let so_nome = bruto.rsplit(['/', '\\']).next().unwrap_or("");
    let limpo: String = so_nome.chars().filter(|c| !c.is_control()).take(120).collect();

    // Sequencia de pontos vira um so, o que mata `..` sem matar a extensao.
    let mut resultado = String::with_capacity(limpo.len());
    let mut ponto_anterior = false;
    for c in limpo.chars() {
        if c == '.' {
            if ponto_anterior { continue; }
            ponto_anterior = true;
        } else {
            ponto_anterior = false;
        }
        resultado.push(c);
    }

    let resultado = resultado.trim().trim_start_matches('.').trim().to_string();
    if resultado.is_empty() { format!("arquivo.{ext}") } else { resultado }
}

async fn upload_file(State(state): State<AppState>, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    let mime = headers.get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let Some(ext) = allowed_mime(&mime) else { return error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "Tipo de arquivo nao aceito."); };
    if body.is_empty() { return error(StatusCode::BAD_REQUEST, "Arquivo vazio."); }
    if body.len() > MAX_UPLOAD { return error(StatusCode::PAYLOAD_TOO_LARGE, "O limite e de 50 MB por arquivo."); }
    let name = headers.get("x-file-name").and_then(|v| v.to_str().ok())
        .map(|value| nome_de_anexo(value, &ext))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("arquivo.{ext}"));

    match guardar_bytes(&state, &session.username, &body, &mime, &ext, name).await {
        Ok((stored, novo)) => {
            let status = if novo { StatusCode::CREATED } else { StatusCode::OK };
            (status, Json(stored)).into_response()
        }
        Err((status, motivo)) => error(status, motivo),
    }
}

/// Grava bytes como anexo e devolve a ficha, mais se o arquivo era novo.
///
/// Extraido de `upload_file` porque o GIF escolhido na busca entra pelo mesmo
/// caminho: o servidor baixa uma vez e o resto do aplicativo passa a tratar
/// aquilo como qualquer outro anexo — mesmo link, mesmo menu, mesma copia unica
/// por conteudo.
async fn guardar_bytes(
    state: &AppState,
    dono: &str,
    body: &[u8],
    mime: &str,
    ext: &str,
    name: String,
) -> Result<(StoredFile, bool), (StatusCode, &'static str)> {
    // O id e o hash do conteudo: o mesmo arquivo enviado de novo nao ocupa
    // espaco duas vezes, e ainda ganha o envio instantaneo.
    let digest = <Sha256 as sha2::Digest>::digest(body);
    let id = format!("{}.{}", URL_SAFE_NO_PAD.encode(digest), ext);

    {
        let files = state.files.read().await;
        if let Some(existing) = files.get(&id) {
            return Ok((existing.clone(), false));
        }
    }

    // Escolhe o disco: enquanto o principal couber, e nele que grava.
    let usado_primario: u64 = state.files.read().await.values()
        .filter(|file| file.disk == "primary").map(|file| file.size).sum();
    let (dir, disk) = if usado_primario + body.len() as u64 <= state.config.upload_primary_cap {
        (state.config.upload_dir.clone(), "primary")
    } else {
        (state.config.upload_fallback_dir.clone(), "fallback")
    };
    if fs::write(dir.join(&id), body).await.is_err() {
        return Err((StatusCode::INSUFFICIENT_STORAGE, "Nao foi possivel gravar o arquivo."));
    }

    let stored = StoredFile {
        id: id.clone(), name, mime: mime.to_string(), size: body.len() as u64,
        owner: dono.to_string(), created_at: Utc::now(), disk: disk.into(),
    };
    let mut files = state.files.write().await;
    files.insert(id, stored.clone());
    persist_json(&state.config.data_dir, "files.json", &*files).await;
    Ok((stored, true))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CanalOrganizado { id: String, #[serde(default)] category_id: Option<String> }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Organizacao {
    #[serde(default)] categorias: Vec<String>,
    #[serde(default)] canais: Vec<CanalOrganizado>,
}

/// Grava de uma vez o arranjo inteiro de um servidor: ordem das categorias,
/// ordem dos canais e em que grupo cada um esta.
///
/// Uma rota so, e nao uma por movimento, porque arrastar um canal para outro
/// grupo muda tres coisas ao mesmo tempo — a categoria dele, a posicao dele e a
/// posicao de todos os que se deslocaram. Em chamadas separadas existiria um
/// instante com a lista pela metade, e duas pessoas arrastando junto veriam
/// resultados diferentes.
///
/// A posicao e o **indice** na lista que chegou. Quem envia ja sabe como quer
/// que fique; renumerar aqui evita que buracos e empates de posicoes antigas
/// sobrevivam.
async fn reorganizar(
    State(state): State<AppState>,
    Caminho(server_id): Caminho<String>,
    headers: HeaderMap,
    Json(body): Json<Organizacao>,
) -> Response {
    if let Err(resposta) = pode_organizar(&state, &headers, &server_id).await { return resposta; }

    // Tudo conferido antes de gravar qualquer coisa: aplicar metade e recusar o
    // resto deixaria a lista num estado que ninguem pediu.
    let mut categorias = state.categorias.write().await;
    let daqui: Vec<&Categoria> = categorias.iter().filter(|c| c.server_id == server_id).collect();
    if body.categorias.len() != daqui.len()
        || !body.categorias.iter().all(|id| daqui.iter().any(|c| &c.id == id))
    {
        return error(StatusCode::BAD_REQUEST, "A lista de categorias nao confere com a do servidor.");
    }

    let mut rooms = state.rooms.write().await;
    let conhecidos: Vec<String> = body.categorias.clone();
    for canal in &body.canais {
        let Some(room) = rooms.iter().find(|r| r.id == canal.id) else {
            return error(StatusCode::NOT_FOUND, "Canal nao encontrado.");
        };
        if room.server_id != server_id {
            return error(StatusCode::FORBIDDEN, "Canal de outro servidor.");
        }
        // Categoria de fora esconderia o canal num grupo que ninguem daqui ve.
        if let Some(alvo) = canal.category_id.as_deref().filter(|valor| !valor.is_empty()) {
            if !conhecidos.iter().any(|id| id == alvo) {
                return error(StatusCode::NOT_FOUND, "Categoria nao encontrada.");
            }
        }
    }

    for (indice, id) in body.categorias.iter().enumerate() {
        if let Some(categoria) = categorias.iter_mut().find(|c| &c.id == id) {
            categoria.posicao = indice as i32;
        }
    }
    for (indice, canal) in body.canais.iter().enumerate() {
        if let Some(room) = rooms.iter_mut().find(|r| r.id == canal.id) {
            room.category_id = canal.category_id.clone().filter(|valor| !valor.is_empty());
            room.posicao = indice as i32;
        }
    }
    persist_json(&state.config.data_dir, "categorias.json", &*categorias).await;
    persist_json(&state.config.data_dir, "rooms.json", &*rooms).await;
    drop(categorias);
    drop(rooms);

    let audience = { let memberships = state.memberships.read().await; members_of(&memberships, &server_id) };
    let _ = state.events.send(Broadcast::to_many(audience, ServerEvent::CanaisOrganizados { server_id }));
    StatusCode::NO_CONTENT.into_response()
}

// ------------------------------------------------------------- categorias
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CriarCategoria { server_id: String, name: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenomearCategoria { name: String }

#[derive(Deserialize)]
struct MoverCategoria { acima: bool }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoverCanal {
    /// Ausente ou nulo tira o canal de qualquer categoria.
    #[serde(default)] category_id: Option<String>,
}

/// Quem pode mexer na organizacao do servidor, e o servidor existe?
///
/// Mesma regra de criar canal: dono ou moderador. Devolve a resposta de erro
/// pronta, porque as quatro rotas abaixo fariam a mesma checagem palavra por
/// palavra e uma delas acabaria esquecendo um pedaco.
/// Ha sessao valida? Sem isto, as rotas abaixo procuram o canal **antes** de
/// olhar quem esta chamando, e responder "nao encontrado" ou "encontrado" a quem
/// nao entrou vira uma forma de descobrir quais canais existem no servidor dos
/// outros, um id por tentativa.
async fn tem_sessao(state: &AppState, headers: &HeaderMap) -> Result<(), Response> {
    match authenticated(state, headers).await {
        Some(_) => Ok(()),
        None => Err(error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada.")),
    }
}

async fn pode_organizar(state: &AppState, headers: &HeaderMap, server_id: &str) -> Result<(), Response> {
    let Some((_, session)) = authenticated(state, headers).await else {
        return Err(error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."));
    };
    if !state.servers.read().await.iter().any(|server| server.id == server_id) {
        return Err(error(StatusCode::NOT_FOUND, "Servidor nao encontrado."));
    }
    let memberships = state.memberships.read().await;
    if !manages(&memberships, server_id, &session.username) {
        return Err(error(StatusCode::FORBIDDEN, "Somente dono ou moderador organiza os canais."));
    }
    Ok(())
}

async fn criar_categoria(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<CriarCategoria>) -> Response {
    if let Err(resposta) = pode_organizar(&state, &headers, &body.server_id).await { return resposta; }
    let name = normalize_name(&body.name);
    if name.chars().count() < 2 {
        return error(StatusCode::BAD_REQUEST, "O nome da categoria precisa ter pelo menos 2 caracteres.");
    }
    let mut categorias = state.categorias.write().await;
    let deste = categorias.iter().filter(|c| c.server_id == body.server_id).count();
    if deste >= 20 { return error(StatusCode::BAD_REQUEST, "Limite de 20 categorias por servidor."); }
    // Entra no fim: quem acabou de criar procura embaixo, nao no meio da lista.
    let posicao = categorias.iter()
        .filter(|c| c.server_id == body.server_id)
        .map(|c| c.posicao).max().unwrap_or(-1) + 1;
    let server_id = body.server_id;
    let categoria = Categoria {
        id: Uuid::new_v4().to_string(), server_id: server_id.clone(), name, posicao,
    };
    categorias.push(categoria.clone());
    persist_json(&state.config.data_dir, "categorias.json", &*categorias).await;
    let audience = { let memberships = state.memberships.read().await; members_of(&memberships, &server_id) };
    let _ = state.events.send(Broadcast::to_many(audience, ServerEvent::CanaisOrganizados { server_id }));
    (StatusCode::CREATED, Json(categoria)).into_response()
}

async fn renomear_categoria(State(state): State<AppState>, Caminho(id): Caminho<String>, headers: HeaderMap, Json(body): Json<RenomearCategoria>) -> Response {
    if let Err(resposta) = tem_sessao(&state, &headers).await { return resposta; }
    let server_id = match dono_da_categoria(&state, &id).await {
        Some(valor) => valor,
        None => return error(StatusCode::NOT_FOUND, "Categoria nao encontrada."),
    };
    if let Err(resposta) = pode_organizar(&state, &headers, &server_id).await { return resposta; }
    let name = normalize_name(&body.name);
    if name.chars().count() < 2 {
        return error(StatusCode::BAD_REQUEST, "O nome da categoria precisa ter pelo menos 2 caracteres.");
    }
    let mut categorias = state.categorias.write().await;
    let Some(categoria) = categorias.iter_mut().find(|c| c.id == id) else {
        return error(StatusCode::NOT_FOUND, "Categoria nao encontrada.");
    };
    categoria.name = name;
    persist_json(&state.config.data_dir, "categorias.json", &*categorias).await;
    let audience = { let memberships = state.memberships.read().await; members_of(&memberships, &server_id) };
    let _ = state.events.send(Broadcast::to_many(audience, ServerEvent::CanaisOrganizados { server_id }));
    StatusCode::NO_CONTENT.into_response()
}

/// Apaga a categoria. **Os canais dela continuam existindo**, soltos.
///
/// Apagar um grupo nao pode apagar o que estava dentro: a conversa de meses de
/// campanha nao some porque alguem quis desfazer a organizacao.
async fn apagar_categoria(State(state): State<AppState>, Caminho(id): Caminho<String>, headers: HeaderMap) -> Response {
    if let Err(resposta) = tem_sessao(&state, &headers).await { return resposta; }
    let server_id = match dono_da_categoria(&state, &id).await {
        Some(valor) => valor,
        None => return error(StatusCode::NOT_FOUND, "Categoria nao encontrada."),
    };
    if let Err(resposta) = pode_organizar(&state, &headers, &server_id).await { return resposta; }

    {
        let mut rooms = state.rooms.write().await;
        let mut mexeu = false;
        for room in rooms.iter_mut().filter(|r| r.category_id.as_deref() == Some(id.as_str())) {
            room.category_id = None;
            mexeu = true;
        }
        if mexeu { persist_json(&state.config.data_dir, "rooms.json", &*rooms).await; }
    }
    let mut categorias = state.categorias.write().await;
    categorias.retain(|c| c.id != id);
    persist_json(&state.config.data_dir, "categorias.json", &*categorias).await;
    let audience = { let memberships = state.memberships.read().await; members_of(&memberships, &server_id) };
    let _ = state.events.send(Broadcast::to_many(audience, ServerEvent::CanaisOrganizados { server_id }));
    StatusCode::NO_CONTENT.into_response()
}

/// Troca de lugar com a vizinha, para cima ou para baixo.
///
/// Trocar em vez de renumerar tudo: a lista e curta, e mexer so em duas deixa o
/// resto exatamente onde estava mesmo se as posicoes tiverem buracos.
async fn mover_categoria(State(state): State<AppState>, Caminho(id): Caminho<String>, headers: HeaderMap, Json(body): Json<MoverCategoria>) -> Response {
    if let Err(resposta) = tem_sessao(&state, &headers).await { return resposta; }
    let server_id = match dono_da_categoria(&state, &id).await {
        Some(valor) => valor,
        None => return error(StatusCode::NOT_FOUND, "Categoria nao encontrada."),
    };
    if let Err(resposta) = pode_organizar(&state, &headers, &server_id).await { return resposta; }

    let mut categorias = state.categorias.write().await;
    let mut deste: Vec<usize> = categorias.iter().enumerate()
        .filter(|(_, c)| c.server_id == server_id)
        .map(|(indice, _)| indice).collect();
    deste.sort_by_key(|indice| (categorias[*indice].posicao, categorias[*indice].name.clone()));
    let Some(lugar) = deste.iter().position(|indice| categorias[*indice].id == id) else {
        return error(StatusCode::NOT_FOUND, "Categoria nao encontrada.");
    };
    let vizinho = if body.acima {
        if lugar == 0 { return StatusCode::NO_CONTENT.into_response(); }
        lugar - 1
    } else {
        if lugar + 1 >= deste.len() { return StatusCode::NO_CONTENT.into_response(); }
        lugar + 1
    };
    let (a, b) = (deste[lugar], deste[vizinho]);
    // Posicoes iguais entre vizinhas fariam a troca nao mudar nada; renumerar as
    // duas pelo lugar que ocupam resolve isso sem tocar nas outras.
    categorias[a].posicao = vizinho as i32;
    categorias[b].posicao = lugar as i32;
    persist_json(&state.config.data_dir, "categorias.json", &*categorias).await;
    let audience = { let memberships = state.memberships.read().await; members_of(&memberships, &server_id) };
    let _ = state.events.send(Broadcast::to_many(audience, ServerEvent::CanaisOrganizados { server_id }));
    StatusCode::NO_CONTENT.into_response()
}

async fn dono_da_categoria(state: &AppState, id: &str) -> Option<String> {
    state.categorias.read().await.iter().find(|c| c.id == id).map(|c| c.server_id.clone())
}

#[derive(Deserialize)]
struct RenomearCanal { name: String }

/// Troca o nome do canal. O id nao muda: mensagem e convite apontam para ele.
async fn renomear_canal(State(state): State<AppState>, Caminho(id): Caminho<String>, headers: HeaderMap, Json(body): Json<RenomearCanal>) -> Response {
    if let Err(resposta) = tem_sessao(&state, &headers).await { return resposta; }
    let server_id = match state.rooms.read().await.iter().find(|r| r.id == id).map(|r| r.server_id.clone()) {
        Some(valor) => valor,
        None => return error(StatusCode::NOT_FOUND, "Canal nao encontrado."),
    };
    if let Err(resposta) = pode_organizar(&state, &headers, &server_id).await { return resposta; }

    let name = normalize_name(&body.name);
    if name.chars().count() < 2 {
        return error(StatusCode::BAD_REQUEST, "O nome do canal precisa ter pelo menos 2 caracteres.");
    }
    {
        let mut rooms = state.rooms.write().await;
        let Some(room) = rooms.iter_mut().find(|r| r.id == id) else {
            return error(StatusCode::NOT_FOUND, "Canal nao encontrado.");
        };
        room.name = name;
        persist_json(&state.config.data_dir, "rooms.json", &*rooms).await;
    }
    let audience = { let memberships = state.memberships.read().await; members_of(&memberships, &server_id) };
    let _ = state.events.send(Broadcast::to_many(audience, ServerEvent::CanaisOrganizados { server_id }));
    StatusCode::NO_CONTENT.into_response()
}

/// Apaga o canal e **as mensagens dele**.
///
/// As mensagens vao junto de proposito: deixa-las orfas guardaria para sempre
/// uma conversa que ninguem consegue mais abrir, e o arquivo so cresceria. Quem
/// apaga precisa saber disso, e quem chama esta rota avisa antes.
///
/// O servidor nao impede apagar o ultimo canal. Um servidor sem canal nenhum e
/// estranho, mas e escolha de quem manda nele — e inventar uma regra aqui
/// deixaria alguem preso com um canal que nao quer.
async fn apagar_canal(State(state): State<AppState>, Caminho(id): Caminho<String>, headers: HeaderMap) -> Response {
    if let Err(resposta) = tem_sessao(&state, &headers).await { return resposta; }
    let server_id = match state.rooms.read().await.iter().find(|r| r.id == id).map(|r| r.server_id.clone()) {
        Some(valor) => valor,
        None => return error(StatusCode::NOT_FOUND, "Canal nao encontrado."),
    };
    if let Err(resposta) = pode_organizar(&state, &headers, &server_id).await { return resposta; }

    {
        let mut rooms = state.rooms.write().await;
        let antes = rooms.len();
        rooms.retain(|r| r.id != id);
        if rooms.len() == antes { return error(StatusCode::NOT_FOUND, "Canal nao encontrado."); }
        persist_json(&state.config.data_dir, "rooms.json", &*rooms).await;
    }
    {
        let mut messages = state.messages.write().await;
        let antes = messages.len();
        messages.retain(|m| m.room_id != id);
        if messages.len() != antes {
            persist_json(&state.config.data_dir, "messages.json", &*messages).await;
        }
    }
    // Ninguem fica preso numa sala de voz que deixou de existir.
    {
        let mut voice = state.voice.write().await;
        voice.remove(&id);
    }

    let audience = { let memberships = state.memberships.read().await; members_of(&memberships, &server_id) };
    let _ = state.events.send(Broadcast::to_many(audience, ServerEvent::CanaisOrganizados { server_id }));
    StatusCode::NO_CONTENT.into_response()
}

/// Poe o canal numa categoria, ou o tira de todas.
async fn mover_canal(State(state): State<AppState>, Caminho(id): Caminho<String>, headers: HeaderMap, Json(body): Json<MoverCanal>) -> Response {
    if let Err(resposta) = tem_sessao(&state, &headers).await { return resposta; }
    let server_id = match state.rooms.read().await.iter().find(|r| r.id == id).map(|r| r.server_id.clone()) {
        Some(valor) => valor,
        None => return error(StatusCode::NOT_FOUND, "Canal nao encontrado."),
    };
    if let Err(resposta) = pode_organizar(&state, &headers, &server_id).await { return resposta; }

    let destino = body.category_id.filter(|valor| !valor.is_empty());
    // Categoria de outro servidor nao serve: sem esta checagem daria para
    // esconder um canal dentro de um grupo que ninguem daquele servidor ve.
    if let Some(alvo) = destino.as_deref() {
        let existe = state.categorias.read().await.iter()
            .any(|c| c.id == alvo && c.server_id == server_id);
        if !existe { return error(StatusCode::NOT_FOUND, "Categoria nao encontrada."); }
    }

    let mut rooms = state.rooms.write().await;
    let Some(room) = rooms.iter_mut().find(|r| r.id == id) else {
        return error(StatusCode::NOT_FOUND, "Canal nao encontrado.");
    };
    room.category_id = destino;
    persist_json(&state.config.data_dir, "rooms.json", &*rooms).await;
    let audience = { let memberships = state.memberships.read().await; members_of(&memberships, &server_id) };
    let _ = state.events.send(Broadcast::to_many(audience, ServerEvent::CanaisOrganizados { server_id }));
    StatusCode::NO_CONTENT.into_response()
}

/// Os ajustes desta conta, ou um mapa vazio se ela ainda nao guardou nenhum.
///
/// Vazio em vez de 404 porque conta nova e o caso normal, nao um erro: o cliente
/// so precisa saber o que aplicar, e "nada" e uma resposta legitima.
async fn ler_preferencias(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else {
        return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada.");
    };
    let guardadas = state.preferencias.read().await;
    let minhas = guardadas.get(&profile_key(&session.username)).cloned().unwrap_or_default();
    Json(minhas).into_response()
}

/// Substitui os ajustes desta conta pelos que chegaram.
///
/// Substitui em vez de mesclar de proposito: desligar uma notificacao e apagar a
/// chave dela, e uma mesclagem nunca deixaria nada ser desligado. Duas maquinas
/// ligadas ao mesmo tempo terminam com a ultima que escreveu — e o que se espera
/// de ajuste pessoal, e o preco de nao inventar resolucao de conflito para algo
/// que ninguem edita dos dois lados ao mesmo tempo.
async fn guardar_preferencias(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(recebidas): Json<BTreeMap<String, String>>,
) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else {
        return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada.");
    };
    if recebidas.len() > MAX_PREFERENCIAS {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "Ajustes demais.");
    }
    if recebidas.iter().any(|(chave, valor)| {
        chave.len() > MAX_PREF_CHAVE || valor.len() > MAX_PREF_VALOR
    }) {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "Ajuste grande demais.");
    }

    let mut guardadas = state.preferencias.write().await;
    guardadas.insert(profile_key(&session.username), recebidas);
    persist_json(&state.config.data_dir, "preferencias.json", &*guardadas).await;
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
struct PedidoDePrevia { #[serde(default)] url: String }

/// Cartao de previa de um link do YouTube ou do Twitter.
///
/// **204 quando o link nao tem cartao**, e nao um erro: canal, playlist, perfil e
/// qualquer outro endereco sao casos normais, nao falhas. O cliente pede a previa
/// de todo link que aparece numa mensagem, entao "nao tem" precisa ser barato de
/// dizer e barato de tratar.
async fn previa_de_link(State(state): State<AppState>, headers: HeaderMap, Query(pedido): Query<PedidoDePrevia>) -> Response {
    if authenticated(&state, &headers).await.is_none() {
        return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada.");
    }
    // Endereco enorme so gasta tempo: nenhum link de video ou tuite chega perto.
    if pedido.url.len() > 500 {
        return StatusCode::NO_CONTENT.into_response();
    }
    let Some((fonte, alvo)) = previa::reconhecer(&pedido.url) else {
        return StatusCode::NO_CONTENT.into_response();
    };
    match previa::montar(&state.auth_key, fonte, &alvo).await {
        Ok(cartao) => Json(cartao).into_response(),
        Err(motivo) => {
            eprintln!("[previa] {motivo}");
            // Tambem 204: video apagado ou tuite privado nao e erro de quem le a
            // conversa, e mostrar aviso vermelho por isso seria ruido.
            StatusCode::NO_CONTENT.into_response()
        }
    }
}

/// Repassa a imagem ou o video do cartao, para o cliente nao falar com o site.
async fn midia_de_previa(State(state): State<AppState>, headers: HeaderMap, Query(pedido): Query<MidiaDeGif>) -> Response {
    if authenticated(&state, &headers).await.is_none() {
        return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada.");
    }
    let Some(url) = previa::abrir_midia(&state.auth_key, &pedido.f) else {
        return error(StatusCode::NOT_FOUND, "Nao encontrado.");
    };
    match previa::baixar(&url).await {
        Ok((bytes, tipo)) => {
            let mut cabecalhos = HeaderMap::new();
            if let Ok(valor) = tipo.parse() { cabecalhos.insert("content-type", valor); }
            // O endereco carrega o conteudo dentro da assinatura, entao guardar
            // em cache nunca serve imagem velha.
            if let Ok(valor) = "public, max-age=86400".parse() { cabecalhos.insert("cache-control", valor); }
            (StatusCode::OK, cabecalhos, bytes).into_response()
        }
        Err(_) => error(StatusCode::NOT_FOUND, "Nao encontrado."),
    }
}

#[derive(Deserialize)]
struct BuscaDeGif {
    #[serde(default)] q: String,
    #[serde(default)] pos: String,
    #[serde(default)] locale: String,
}

/// Procura GIF no Tenor. Exige sessao, como tudo aqui.
async fn buscar_gifs(State(state): State<AppState>, headers: HeaderMap, Query(busca): Query<BuscaDeGif>) -> Response {
    if authenticated(&state, &headers).await.is_none() {
        return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada.");
    }
    let Some(chave) = state.config.gif_key.as_deref() else {
        return error(StatusCode::NOT_IMPLEMENTED, "Este servidor nao tem busca de GIF configurada.");
    };
    // Termo enorme so gasta a cota do provedor, e o cursor vem de volta dele:
    // os dois sao podados antes de virar URL.
    let termo: String = busca.q.chars().take(100).collect();
    let posicao: String = busca.pos.chars()
        .filter(|c| c.is_ascii_alphanumeric() || "-_=.".contains(*c)).take(120).collect();
    let idioma = if !busca.locale.is_empty()
        && busca.locale.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        busca.locale.chars().take(10).collect()
    } else {
        "pt_BR".to_string()
    };
    match gifs::procurar(state.config.gif_provider, chave, &state.auth_key, &termo, &posicao, &idioma).await {
        Ok(pagina) => Json(pagina).into_response(),
        Err(motivo) => {
            // O motivo pode trazer a chave da API de volta: fica no log.
            eprintln!("[gifs] busca falhou: {motivo}");
            error(StatusCode::BAD_GATEWAY, "A busca de GIF nao respondeu.")
        }
    }
}

#[derive(Deserialize)]
struct MidiaDeGif { #[serde(default)] f: String }

/// Repassa a miniatura, para o cliente nunca falar com o provedor.
async fn midia_de_gif(State(state): State<AppState>, headers: HeaderMap, Query(pedido): Query<MidiaDeGif>) -> Response {
    if authenticated(&state, &headers).await.is_none() {
        return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada.");
    }
    let Some(url) = gifs::abrir(&state.auth_key, state.config.gif_provider, &pedido.f) else {
        return error(StatusCode::NOT_FOUND, "Nao encontrado.");
    };
    match gifs::baixar(&url).await {
        Ok((bytes, tipo)) => {
            let mut cabecalhos = HeaderMap::new();
            if let Ok(valor) = tipo.parse() { cabecalhos.insert("content-type", valor); }
            // A miniatura e imutavel: o endereco carrega o conteudo dentro da
            // assinatura, entao guardar em cache nunca serve imagem velha.
            if let Ok(valor) = "public, max-age=86400".parse() { cabecalhos.insert("cache-control", valor); }
            (StatusCode::OK, cabecalhos, bytes).into_response()
        }
        Err(_) => error(StatusCode::NOT_FOUND, "Nao encontrado."),
    }
}

#[derive(Deserialize)]
struct GuardarGif { ficha: String, #[serde(default)] descricao: String }

/// Baixa o GIF escolhido e o guarda como anexo comum.
///
/// Guardar, em vez de mandar o endereco de fora dentro da mensagem: assim a
/// conversa nao depende de um servico de terceiro continuar no ar — e o Tenor
/// fechando as portas mostrou que isso acontece — e quem abre a mensagem depois
/// nao avisa o provedor de que a leu.
async fn guardar_gif(State(state): State<AppState>, headers: HeaderMap, Json(pedido): Json<GuardarGif>) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else {
        return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada.");
    };
    let Some(url) = gifs::abrir(&state.auth_key, state.config.gif_provider, &pedido.ficha) else {
        return error(StatusCode::NOT_FOUND, "Nao encontrado.");
    };
    let (bytes, tipo) = match gifs::baixar(&url).await {
        Ok(par) => par,
        Err(motivo) => {
            eprintln!("[gifs] download falhou: {motivo}");
            return error(StatusCode::BAD_GATEWAY, "Nao foi possivel baixar o GIF.");
        }
    };
    let Some(ext) = allowed_mime(&tipo) else {
        return error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "Tipo de arquivo nao aceito.");
    };
    // A descricao que o provedor manda e um titulo — "Dance Dancing GIF" — e nao
    // um nome de arquivo. Sem a extensao, o que a pessoa salvar chega ao disco
    // sem tipo, e o Windows nao sabe com o que abrir.
    let nome = nome_de_anexo(&pedido.descricao, &ext);
    let nome = if nome.to_lowercase().ends_with(&format!(".{ext}")) {
        nome
    } else {
        format!("{nome}.{ext}")
    };
    match guardar_bytes(&state, &session.username, &bytes, &tipo, &ext, nome).await {
        Ok((stored, _)) => (StatusCode::CREATED, Json(stored)).into_response(),
        Err((status, motivo)) => error(status, motivo),
    }
}

/// Entrega o arquivo. Exige sessao: nada aqui e publico.
/// A prova de que um endereco de arquivo saiu daqui.
///
/// O navegador nao manda cabecalho de autorizacao, entao um link colado fora do
/// aplicativo nunca ia abrir: caia em "sessao invalida ou expirada". A prova
/// viaja na propria URL.
///
/// **Quem tem o link abre o arquivo, sem conta.** E o mesmo que fazem os outros
/// aplicativos de conversa, e e o que "copiar link" sempre prometeu. A prova e
/// derivada da chave do servidor, entao ninguem adivinha o endereco de um
/// arquivo que nao recebeu.
fn prova_do_arquivo(state: &AppState, id: &str) -> Option<String> {
    let mut mac = HmacSha256::new_from_slice(&state.auth_key).ok()?;
    mac.update(b"arquivo:");
    mac.update(id.as_bytes());
    // Metade do digest ja da 128 bits, e deixa o link menos comprido.
    Some(URL_SAFE_NO_PAD.encode(&mac.finalize().into_bytes()[..16]))
}

/// Compara sem revelar em qual caractere as duas divergem.
fn prova_confere(esperada: &str, recebida: &str) -> bool {
    if esperada.len() != recebida.len() { return false; }
    esperada.bytes().zip(recebida.bytes()).fold(0_u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

#[derive(Serialize)] #[serde(rename_all = "camelCase")] struct LinkDoArquivo { url: String }

/// Devolve o endereco publico de um arquivo, para quem esta na sessao copiar.
async fn link_do_arquivo(State(state): State<AppState>, headers: HeaderMap, axum::extract::Path(id): axum::extract::Path<String>) -> Response {
    if authenticated(&state, &headers).await.is_none() {
        return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada.");
    }
    if !state.files.read().await.contains_key(&id) {
        return error(StatusCode::NOT_FOUND, "Arquivo nao encontrado.");
    }
    let Some(prova) = prova_do_arquivo(&state, &id) else {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "Erro interno.");
    };
    Json(LinkDoArquivo { url: format!("/f/{id}?t={prova}") }).into_response()
}

#[derive(Deserialize)] struct ProvaQuery { t: Option<String> }

/// Serve o arquivo para quem tem o link, sem exigir sessao.
async fn arquivo_por_link(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(query): Query<ProvaQuery>,
) -> Response {
    let Some(esperada) = prova_do_arquivo(&state, &id) else {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "Erro interno.");
    };
    // Mesma resposta para prova errada e arquivo inexistente: senao daria para
    // descobrir quais identificadores existem tentando um por um.
    if !query.t.as_deref().map(|t| prova_confere(&esperada, t)).unwrap_or(false) {
        return error(StatusCode::NOT_FOUND, "Arquivo nao encontrado.");
    }
    servir_arquivo(&state, &id, false).await
}

async fn download_file(State(state): State<AppState>, headers: HeaderMap, axum::extract::Path(id): axum::extract::Path<String>) -> Response {
    // Exige sessao. O cliente busca por fetch autenticado e monta um blob,
    // porque <img src> nao manda cabecalho de autorizacao.
    if authenticated(&state, &headers).await.is_none() {
        return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada.");
    }
    servir_arquivo(&state, &id, true).await
}

/// Le o arquivo do disco e responde com ele.
///
/// `privado` decide o cache: o que veio pela sessao nao pode ficar guardado num
/// proxy compartilhado, o que veio por link assinado pode.
async fn servir_arquivo(state: &AppState, id: &str, privado: bool) -> Response {
    let Some(file) = state.files.read().await.get(id).cloned() else { return error(StatusCode::NOT_FOUND, "Arquivo nao encontrado."); };
    let dir = if file.disk == "fallback" { &state.config.upload_fallback_dir } else { &state.config.upload_dir };
    match fs::read(dir.join(&file.id)).await {
        Ok(bytes) => ([
            (axum::http::header::CONTENT_TYPE, file.mime.clone()),
            (axum::http::header::CACHE_CONTROL,
                if privado { "private, max-age=31536000, immutable".to_string() }
                else { "public, max-age=31536000, immutable".to_string() }),
            // O navegador mostra imagem, video e PDF na propria aba, e oferece
            // salvar o resto com o nome que a pessoa enviou, em vez do
            // identificador interno.
            (axum::http::header::CONTENT_DISPOSITION, disposicao(&file)),
        ], bytes).into_response(),
        Err(_) => error(StatusCode::NOT_FOUND, "Arquivo nao encontrado no disco."),
    }
}

/// `inline` para o que o navegador sabe mostrar, `attachment` para o resto.
fn disposicao(file: &StoredFile) -> String {
    let mostra = file.mime.starts_with("image/")
        || file.mime.starts_with("video/")
        || file.mime.starts_with("audio/")
        || file.mime == "application/pdf";
    // O nome vai codificado: acento e espaco quebram o cabecalho, e aspas no
    // nome permitiriam sair do campo.
    let seguro: String = file.name.chars()
        .map(|c| if c.is_ascii_alphanumeric() || "._- ".contains(c) { c } else { '_' })
        .collect();
    format!("{}; filename=\"{}\"", if mostra { "inline" } else { "attachment" }, seguro.trim())
}

async fn publish_key(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<PublicKeyInput>) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    // Chave publica ECDH P-256 em formato raw: 65 bytes.
    if !valid_b64(&body.public_key, 256) { return error(StatusCode::BAD_REQUEST, "Chave publica invalida."); }
    let entry = IdentityKey { username: session.username.clone(), public_key: body.public_key, updated_at: Utc::now() };
    let mut keys = state.keys.write().await;
    keys.insert(profile_key(&session.username), entry.clone());
    persist_json(&state.config.data_dir, "keys.json", &*keys).await;
    Json(entry).into_response()
}
/// Devolve o cofre do proprio usuario. **So o dono**: nao ha caminho aqui para
/// pedir o de outra pessoa, nem por vinculo de amizade. Um cofre alheio nas
/// maos de alguem vira ataque de forca bruta contra a senha dela, sem limite de
/// tentativas e sem deixar rastro.
async fn ler_cofre(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    match state.cofres.read().await.get(&profile_key(&session.username)) {
        Some(cofre) => Json(cofre.clone()).into_response(),
        // Conta antiga, de antes do cofre: o cliente sobe o dela na entrada.
        None => error(StatusCode::NOT_FOUND, "Esta conta ainda nao tem cofre."),
    }
}

/// Guarda o cofre do proprio usuario, substituindo o anterior.
///
/// Sobrescrever e o comportamento certo: quem troca de senha reembrulha a mesma
/// identidade, e quem recupera a conta reembrulha com o codigo novo.
async fn guardar_cofre(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<CofreInput>) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    // A identidade cifrada e um JSON com a chave JWK dentro; 4 KB sobra e ainda
    // impede o cofre de virar deposito de arquivo.
    for embrulho in [Some(&body.por_senha), body.por_recuperacao.as_ref()].into_iter().flatten() {
        if !valid_b64(&embrulho.ciphertext, 4096) || !valid_b64(&embrulho.nonce, 16) {
            return error(StatusCode::BAD_REQUEST, "Cofre invalido.");
        }
    }
    let cofre = Cofre {
        username: session.username.clone(),
        por_senha: body.por_senha,
        por_recuperacao: body.por_recuperacao,
        updated_at: Utc::now(),
    };
    let mut cofres = state.cofres.write().await;
    cofres.insert(profile_key(&session.username), cofre.clone());
    persist_json(&state.config.data_dir, "cofres.json", &*cofres).await;
    Json(cofre).into_response()
}

async fn get_key(State(state): State<AppState>, headers: HeaderMap, axum::extract::Path(username): axum::extract::Path<String>) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    let target = normalize_name(&username);
    // A chave so e visivel para o proprio dono ou para quem ja tem vinculo com ele,
    // aceito ou pendente. Isso evita virar diretorio publico de chaves.
    let related = profile_key(&target) == profile_key(&session.username)
        || state.friendships.read().await.iter().any(|f| pair_matches(f, &session.username, &target));
    if !related { return error(StatusCode::FORBIDDEN, "Voce nao tem vinculo com este usuario."); }
    match state.keys.read().await.get(&profile_key(&target)) {
        Some(key) => Json(key.clone()).into_response(),
        None => error(StatusCode::NOT_FOUND, "Este usuario ainda nao publicou uma chave."),
    }
}
async fn search_users(State(state): State<AppState>, headers: HeaderMap, Query(query): Query<SearchQuery>) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    let needle = profile_key(query.q.unwrap_or_default().trim());
    if needle.chars().count() < 2 { return Json(SearchOutput { users: Vec::new() }).into_response(); }
    let mine = profile_key(&session.username);
    let mut users: Vec<String> = state.users.read().await.values()
        .filter(|account| profile_key(&account.username) != mine && profile_key(&account.username).contains(&needle))
        .map(|account| account.username.clone()).collect();
    users.sort_by_key(|name| name.to_lowercase());
    users.truncate(20);
    Json(SearchOutput { users }).into_response()
}
async fn list_friends(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    let me = profile_key(&session.username);
    let list = state.friendships.read().await.clone();
    let mut friends = Vec::new();
    let (mut incoming, mut outgoing) = (Vec::new(), Vec::new());
    for item in list {
        let is_requester = profile_key(&item.requester) == me;
        let is_addressee = profile_key(&item.addressee) == me;
        if !is_requester && !is_addressee { continue; }
        match item.status {
            FriendStatus::Accepted => friends.push(if is_requester { item.addressee.clone() } else { item.requester.clone() }),
            FriendStatus::Pending if is_addressee => incoming.push(item),
            FriendStatus::Pending => outgoing.push(item),
        }
    }
    friends.sort_by_key(|name| name.to_lowercase());
    Json(FriendsOutput { friends, incoming, outgoing }).into_response()
}
async fn friend_request(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<UsernameInput>) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    let target = normalize_name(&body.username);
    if profile_key(&target) == profile_key(&session.username) { return error(StatusCode::BAD_REQUEST, "Voce nao pode adicionar a si mesmo."); }
    let Some(account) = state.users.read().await.get(&profile_key(&target)).cloned() else { return error(StatusCode::NOT_FOUND, "Usuario nao encontrado."); };
    let mut list = state.friendships.write().await;
    if let Some(existing) = list.iter().find(|f| pair_matches(f, &session.username, &account.username)) {
        return match existing.status {
            FriendStatus::Accepted => error(StatusCode::CONFLICT, "Voces ja sao amigos."),
            FriendStatus::Pending => error(StatusCode::CONFLICT, "Ja existe um pedido pendente entre voces."),
        };
    }
    let friendship = Friendship {
        requester: session.username.clone(), addressee: account.username.clone(),
        status: FriendStatus::Pending, created_at: Utc::now(), updated_at: Utc::now(),
    };
    list.push(friendship.clone());
    persist_json(&state.config.data_dir, "friends.json", &*list).await;
    drop(list);
    let _ = state.events.send(Broadcast::to([&friendship.requester, &friendship.addressee], ServerEvent::FriendRequested { friendship: friendship.clone() }));
    (StatusCode::CREATED, Json(friendship)).into_response()
}
async fn friend_accept(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<UsernameInput>) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    let other = normalize_name(&body.username);
    let mut list = state.friendships.write().await;
    // So o destinatario aceita, e apenas um pedido ainda pendente.
    let Some(item) = list.iter_mut().find(|f| f.status == FriendStatus::Pending
        && profile_key(&f.addressee) == profile_key(&session.username)
        && profile_key(&f.requester) == profile_key(&other)) else {
        return error(StatusCode::NOT_FOUND, "Nao existe pedido pendente deste usuario.");
    };
    item.status = FriendStatus::Accepted;
    item.updated_at = Utc::now();
    let friendship = item.clone();
    persist_json(&state.config.data_dir, "friends.json", &*list).await;
    drop(list);
    let _ = state.events.send(Broadcast::to([&friendship.requester, &friendship.addressee], ServerEvent::FriendAccepted { friendship: friendship.clone() }));
    Json(friendship).into_response()
}
async fn friend_reject(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<UsernameInput>) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    let other = normalize_name(&body.username);
    let mut list = state.friendships.write().await;
    let before = list.len();
    list.retain(|f| !(f.status == FriendStatus::Pending && pair_matches(f, &session.username, &other)));
    if list.len() == before { return error(StatusCode::NOT_FOUND, "Nao existe pedido pendente com este usuario."); }
    persist_json(&state.config.data_dir, "friends.json", &*list).await;
    drop(list);
    let _ = state.events.send(Broadcast::to([&session.username, &other], ServerEvent::FriendRemoved { username: other.clone() }));
    StatusCode::NO_CONTENT.into_response()
}
async fn friend_remove(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<UsernameInput>) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    let other = normalize_name(&body.username);
    let mut list = state.friendships.write().await;
    let before = list.len();
    list.retain(|f| !pair_matches(f, &session.username, &other));
    if list.len() == before { return error(StatusCode::NOT_FOUND, "Voces nao tem vinculo."); }
    persist_json(&state.config.data_dir, "friends.json", &*list).await;
    drop(list);
    // O historico cifrado do par deixa de fazer sentido sem o vinculo.
    let mut envelopes = state.envelopes.write().await;
    envelopes.retain(|e| !(pair_matches(&Friendship {
        requester: e.from.clone(), addressee: e.to.clone(), status: FriendStatus::Accepted,
        created_at: e.created_at, updated_at: e.created_at,
    }, &session.username, &other)));
    persist_json(&state.config.data_dir, "dms.json", &*envelopes).await;
    drop(envelopes);
    let _ = state.events.send(Broadcast::to([&session.username, &other], ServerEvent::FriendRemoved { username: other.clone() }));
    StatusCode::NO_CONTENT.into_response()
}
async fn direct_history(State(state): State<AppState>, headers: HeaderMap, Query(query): Query<DirectHistoryQuery>) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    let other = normalize_name(&query.with);
    if !friends_already(&state.friendships.read().await, &session.username, &other) {
        return error(StatusCode::FORBIDDEN, "Conversa privada e so entre amigos.");
    }
    let (me, them) = (profile_key(&session.username), profile_key(&other));
    let envelopes: Vec<Envelope> = state.envelopes.read().await.iter()
        .filter(|e| (profile_key(&e.from) == me && profile_key(&e.to) == them) || (profile_key(&e.from) == them && profile_key(&e.to) == me))
        .cloned().collect();
    Json(DirectHistoryOutput { envelopes }).into_response()
}
async fn send_direct(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<DirectMessageInput>) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    let other = normalize_name(&body.to);
    if !friends_already(&state.friendships.read().await, &session.username, &other) {
        return error(StatusCode::FORBIDDEN, "Conversa privada e so entre amigos.");
    }
    // O servidor nunca ve o texto: valida so o formato e o tamanho do envelope.
    if !valid_b64(&body.ciphertext, 8 * 1024) { return error(StatusCode::BAD_REQUEST, "Envelope invalido."); }
    if !valid_b64(&body.nonce, 32) { return error(StatusCode::BAD_REQUEST, "Nonce invalido."); }
    // Mesma regra dos canais: so entra anexo que existe e que a pessoa enviou.
    let anexos: Vec<StoredFile> = {
        let files = state.files.read().await;
        body.attachments.iter().filter_map(|id| files.get(id).cloned())
            .filter(|file| profile_key(&file.owner) == profile_key(&session.username))
            .take(6).collect()
    };
    // So cita mensagem que existe nesta conversa; id inventado vira nada.
    let citada = match body.reply_to {
        Some(alvo) => state.envelopes.read().await.iter().any(|item| item.id == alvo
            && ((item.from == session.username && item.to == other)
                || (item.from == other && item.to == session.username))).then_some(alvo),
        None => None,
    };
    let envelope = Envelope {
        id: Uuid::new_v4(), from: session.username.clone(), to: other.clone(),
        ciphertext: body.ciphertext, nonce: body.nonce, created_at: Utc::now(),
        edited_at: None, attachments: anexos, reply_to: citada,
    };
    {
        let mut envelopes = state.envelopes.write().await;
        envelopes.push(envelope.clone());
        let excess = envelopes.len().saturating_sub(MAX_ENVELOPES);
        if excess > 0 { envelopes.drain(..excess); }
        persist_json(&state.config.data_dir, "dms.json", &*envelopes).await;
    }
    let _ = state.events.send(Broadcast::to([&envelope.from, &envelope.to], ServerEvent::DirectMessage { envelope: envelope.clone() }));
    (StatusCode::CREATED, Json(envelope)).into_response()
}
/// Editar PV: o autor manda o texto recifrado; o servidor so troca o envelope.
async fn edit_direct(State(state): State<AppState>, headers: HeaderMap, axum::extract::Path(id): axum::extract::Path<Uuid>, Json(body): Json<EditDirectInput>) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida."); };
    if !valid_b64(&body.ciphertext, 8 * 1024) { return error(StatusCode::BAD_REQUEST, "Envelope invalido."); }
    if !valid_b64(&body.nonce, 32) { return error(StatusCode::BAD_REQUEST, "Nonce invalido."); }
    let updated = {
        let mut envelopes = state.envelopes.write().await;
        let Some(envelope) = envelopes.iter_mut().find(|envelope| envelope.id == id) else {
            return error(StatusCode::NOT_FOUND, "Mensagem nao encontrada.");
        };
        if profile_key(&envelope.from) != profile_key(&session.username) {
            return error(StatusCode::FORBIDDEN, "Voce so pode editar suas mensagens.");
        }
        envelope.ciphertext = body.ciphertext;
        envelope.nonce = body.nonce;
        envelope.edited_at = Some(Utc::now());
        let updated = envelope.clone();
        persist_json(&state.config.data_dir, "dms.json", &*envelopes).await;
        updated
    };
    let _ = state.events.send(Broadcast::to([&updated.from, &updated.to], ServerEvent::DirectMessageUpdated { envelope: updated.clone() }));
    Json(updated).into_response()
}
async fn delete_direct(State(state): State<AppState>, headers: HeaderMap, axum::extract::Path(id): axum::extract::Path<Uuid>) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida."); };
    let removed = {
        let mut envelopes = state.envelopes.write().await;
        let Some(position) = envelopes.iter().position(|envelope| envelope.id == id) else {
            return error(StatusCode::NOT_FOUND, "Mensagem nao encontrada.");
        };
        if profile_key(&envelopes[position].from) != profile_key(&session.username) {
            return error(StatusCode::FORBIDDEN, "Voce so pode apagar suas mensagens.");
        }
        let removed = envelopes.remove(position);
        persist_json(&state.config.data_dir, "dms.json", &*envelopes).await;
        removed
    };
    let _ = state.events.send(Broadcast::to([&removed.from, &removed.to], ServerEvent::DirectMessageDeleted { message_id: id, from: removed.from.clone(), to: removed.to.clone() }));
    StatusCode::NO_CONTENT.into_response()
}

async fn message_audience(state: &AppState, message: &ChatMessage, username: &str) -> Result<Vec<String>, Response> {
    let Some(room) = state.rooms.read().await.iter().find(|room| room.id == message.room_id && room.kind == RoomKind::Text).cloned()
        else { return Err(error(StatusCode::NOT_FOUND, "Canal nao encontrado.")); };
    let memberships = state.memberships.read().await;
    if !is_member(&memberships, &room.server_id, username) {
        return Err(error(StatusCode::FORBIDDEN, "Voce nao participa deste servidor."));
    }
    Ok(members_of(&memberships, &room.server_id))
}

async fn edit_message(State(state): State<AppState>, headers: HeaderMap, axum::extract::Path(id): axum::extract::Path<Uuid>, Json(body): Json<EditMessageInput>) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida."); };
    let Some(existing) = state.messages.read().await.iter().find(|message| message.id == id).cloned()
        else { return error(StatusCode::NOT_FOUND, "Mensagem nao encontrada."); };
    if profile_key(&existing.username) != profile_key(&session.username) {
        return error(StatusCode::FORBIDDEN, "Voce so pode editar suas mensagens.");
    }
    let Ok(audience) = message_audience(&state, &existing, &session.username).await else {
        return error(StatusCode::FORBIDDEN, "Voce nao participa deste servidor.");
    };
    let text = body.text.trim().chars().take(2000).collect::<String>();
    if text.is_empty() && existing.attachments.is_empty() {
        return error(StatusCode::BAD_REQUEST, "A mensagem nao pode ficar vazia.");
    }
    let updated = {
        let mut messages = state.messages.write().await;
        let Some(message) = messages.iter_mut().find(|message| message.id == id) else {
            return error(StatusCode::NOT_FOUND, "Mensagem nao encontrada.");
        };
        message.text = text;
        message.edited_at = Some(Utc::now());
        let updated = message.clone();
        persist_json(&state.config.data_dir, "messages.json", &*messages).await;
        updated
    };
    let _ = state.events.send(Broadcast::to_many(audience, ServerEvent::MessageUpdated { message: updated.clone() }));
    Json(updated).into_response()
}

async fn delete_message(State(state): State<AppState>, headers: HeaderMap, axum::extract::Path(id): axum::extract::Path<Uuid>) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida."); };
    let Some(existing) = state.messages.read().await.iter().find(|message| message.id == id).cloned()
        else { return error(StatusCode::NOT_FOUND, "Mensagem nao encontrada."); };
    if profile_key(&existing.username) != profile_key(&session.username) {
        return error(StatusCode::FORBIDDEN, "Voce so pode apagar suas mensagens.");
    }
    let Ok(audience) = message_audience(&state, &existing, &session.username).await else {
        return error(StatusCode::FORBIDDEN, "Voce nao participa deste servidor.");
    };
    {
        let mut messages = state.messages.write().await;
        messages.retain(|message| message.id != id);
        persist_json(&state.config.data_dir, "messages.json", &*messages).await;
    }
    let _ = state.events.send(Broadcast::to_many(audience, ServerEvent::MessageDeleted { message_id: id, room_id: existing.room_id }));
    StatusCode::NO_CONTENT.into_response()
}

async fn websocket(State(state): State<AppState>, Query(query): Query<WsQuery>, ws: WebSocketUpgrade) -> Response {
    let Some(s) = state.sessions.read().await.get(&query.token).cloned() else { return StatusCode::UNAUTHORIZED.into_response(); };
    if s.expires_at < now() { return StatusCode::UNAUTHORIZED.into_response(); }
    ws.on_upgrade(move |socket| handle_socket(socket, state, s)).into_response()
}

/// Quem tem relacao com a pessoa: colegas de servidor mais amigos aceitos.
/// A presenca so vai para essas pessoas, e nao para o grupo inteiro.
async fn presence_audience(state: &AppState, username: &str) -> Vec<String> {
    let mut audience: Vec<String> = Vec::new();
    for list in state.memberships.read().await.values() {
        if list.iter().any(|member| member.username == profile_key(username)) {
            for member in list { audience.push(member.username.clone()); }
        }
    }
    for friendship in state.friendships.read().await.iter() {
        if friendship.status != FriendStatus::Accepted { continue; }
        if profile_key(&friendship.requester) == profile_key(username) { audience.push(profile_key(&friendship.addressee)); }
        else if profile_key(&friendship.addressee) == profile_key(username) { audience.push(profile_key(&friendship.requester)); }
    }
    audience.sort();
    audience.dedup();
    audience
}

async fn handle_socket(mut socket: WebSocket, state: AppState, session: Session) {
    // A inscricao vem antes do anuncio: se anunciasse primeiro, este socket
    // perderia o proprio evento e a pessoa se veria offline.
    let mut events = state.events.subscribe();
    // Presenca: o primeiro socket da pessoa avisa que ela ficou online.
    {
        let mut online = state.online.write().await;
        let count = online.entry(profile_key(&session.username)).or_insert(0);
        *count += 1;
        if *count == 1 {
            let audience = presence_audience(&state, &session.username).await;
            let _ = state.events.send(Broadcast::to_many(audience, ServerEvent::PresenceChanged {
                username: session.username.clone(), online: true,
            }));
        }
    }
    // O historico tambem precisa ser filtrado: antes ia tudo para todos.
    let visible_rooms: Vec<String> = {
        let memberships = state.memberships.read().await;
        state.rooms.read().await.iter()
            .filter(|room| is_member(&memberships, &room.server_id, &session.username))
            .map(|room| room.id.clone()).collect()
    };
    let welcome = WelcomeOutput {
        kind: "welcome",
        messages: state.messages.read().await.iter()
            .filter(|message| visible_rooms.contains(&message.room_id)).cloned().collect(),
    };
    if socket.send(WsMessage::Text(serde_json::to_string(&welcome).unwrap_or_default().into())).await.is_err() { return; }
    // Canal de voz anunciado por este socket. Fica aqui, e nao no estado
    // global, para a limpeza da saida so desfazer o que este socket declarou:
    // a mesma pessoa pode estar com o app aberto em duas maquinas.
    let mut sala_de_voz: Option<String> = None;
    loop { tokio::select! {
        incoming = socket.recv() => match incoming {
            Some(Ok(WsMessage::Text(text))) => {
                let Ok(input) = serde_json::from_str::<ClientMessage>(&text) else { continue; };
                if input.kind == "voice" {
                    let pedida = input.room_id.unwrap_or_default();
                    // Sala vazia = saiu. Sala cheia so vale se for de voz e a
                    // pessoa participar do servidor: senao daria para se
                    // anunciar numa chamada que nem enxerga.
                    let destino = if pedida.is_empty() { None } else {
                        let sala = state.rooms.read().await.iter().find(|r| r.id == pedida && r.kind == RoomKind::Voice).cloned();
                        match sala {
                            Some(sala) => {
                                let memberships = state.memberships.read().await;
                                if is_member(&memberships, &sala.server_id, &session.username) { Some(pedida) } else { None }
                            }
                            None => None,
                        }
                    };
                    set_voice(&state, &session.username, &mut sala_de_voz, destino).await;
                    continue;
                }
                // "typing" e efemero: nunca e guardado, entao quem chega depois
                // nao ve um aviso de digitacao que ja morreu.
                if input.kind == "typing" {
                    let room_id = input.room_id.unwrap_or_default();
                    let audience = {
                        let rooms = state.rooms.read().await;
                        let Some(alvo) = rooms.iter().find(|r| r.id == room_id && r.kind == RoomKind::Text).cloned() else { continue; };
                        drop(rooms);
                        let memberships = state.memberships.read().await;
                        if !is_member(&memberships, &alvo.server_id, &session.username) { continue; }
                        members_of(&memberships, &alvo.server_id)
                    };
                    let _ = state.events.send(Broadcast::to_many(
                        audience,
                        ServerEvent::Typing { username: session.username.clone(), room_id },
                    ));
                    continue;
                }
                if input.kind == "react" {
                    let (Some(alvo), Some(emoji)) = (input.message_id, input.emoji) else { continue; };
                    // Um emoji e um punhado de bytes; limitar evita que alguem
                    // guarde um texto inteiro no lugar do simbolo.
                    let emoji: String = emoji.chars().take(8).collect();
                    if emoji.trim().is_empty() { continue; }
                    let atualizada = {
                        let mut historico = state.messages.write().await;
                        let Some(message) = historico.iter_mut().find(|item| item.id == alvo) else { continue; };
                        let quem = message.reactions.entry(emoji).or_default();
                        // Mesmo emoji duas vezes desfaz: um clique so, nos dois sentidos.
                        match quem.iter().position(|n| profile_key(n) == profile_key(&session.username)) {
                            Some(i) => { quem.remove(i); }
                            None => quem.push(session.username.clone()),
                        }
                        message.reactions.retain(|_, quem| !quem.is_empty());
                        message.clone()
                    };
                    let audience = {
                        let rooms = state.rooms.read().await;
                        let Some(sala) = rooms.iter().find(|r| r.id == atualizada.room_id).cloned() else { continue; };
                        drop(rooms);
                        let memberships = state.memberships.read().await;
                        if !is_member(&memberships, &sala.server_id, &session.username) { continue; }
                        members_of(&memberships, &sala.server_id)
                    };
                    {
                        let historico = state.messages.read().await;
                        persist_json(&state.config.data_dir, "messages.json", &*historico).await;
                    }
                    let _ = state.events.send(Broadcast::to_many(
                        audience,
                        ServerEvent::MessageUpdated { message: atualizada },
                    ));
                    continue;
                }
                if input.kind == "pin" {
                    let Some(alvo) = input.message_id else { continue; };
                    // A audiencia e conferida antes de mexer: quem nao participa
                    // do servidor nao fixa nada nele.
                    let sala_da_mensagem = {
                        let historico = state.messages.read().await;
                        let Some(message) = historico.iter().find(|item| item.id == alvo) else { continue; };
                        message.room_id.clone()
                    };
                    let audience = {
                        let rooms = state.rooms.read().await;
                        let Some(sala) = rooms.iter().find(|r| r.id == sala_da_mensagem).cloned() else { continue; };
                        drop(rooms);
                        let memberships = state.memberships.read().await;
                        if !is_member(&memberships, &sala.server_id, &session.username) { continue; }
                        members_of(&memberships, &sala.server_id)
                    };
                    let atualizada = {
                        let mut historico = state.messages.write().await;
                        let Some(message) = historico.iter_mut().find(|item| item.id == alvo) else { continue; };
                        // Um clique nos dois sentidos, como a reacao.
                        message.pinned = !message.pinned;
                        message.clone()
                    };
                    {
                        let historico = state.messages.read().await;
                        persist_json(&state.config.data_dir, "messages.json", &*historico).await;
                    }
                    let _ = state.events.send(Broadcast::to_many(
                        audience,
                        ServerEvent::MessageUpdated { message: atualizada },
                    ));
                    continue;
                }
                if input.kind != "message" { continue; }
                let text = input.text.unwrap_or_default().trim().chars().take(2000).collect::<String>();
                let room_id = input.room_id.unwrap_or_default();
                let Some(target) = state.rooms.read().await.iter().find(|r| r.id == room_id && r.kind == RoomKind::Text).cloned() else { continue; };
                let audience = {
                    let memberships = state.memberships.read().await;
                    if !is_member(&memberships, &target.server_id, &session.username) { continue; }
                    members_of(&memberships, &target.server_id)
                };
                // So entram anexos que existem e que a propria pessoa enviou.
                let anexos: Vec<StoredFile> = {
                    let files = state.files.read().await;
                    input.attachments.iter().filter_map(|id| files.get(id).cloned())
                        .filter(|file| profile_key(&file.owner) == profile_key(&session.username))
                        .take(6).collect()
                };
                if text.is_empty() && anexos.is_empty() { continue; }
                // So cita mensagem que existe na mesma sala.
                let citada = match input.reply_to {
                    Some(alvo) => state.messages.read().await.iter()
                        .any(|item| item.id == alvo && item.room_id == room_id).then_some(alvo),
                    None => None,
                };
                let message = ChatMessage { id: Uuid::new_v4(), username: session.username.clone(), text, created_at: Utc::now(), edited_at: None, room_id, attachments: anexos, reply_to: citada, reactions: BTreeMap::new(), pinned: false };
                { let mut h = state.messages.write().await; h.push(message.clone()); let excess = h.len().saturating_sub(MAX_MESSAGES); if excess > 0 { h.drain(..excess); } persist_json(&state.config.data_dir, "messages.json", &*h).await; }
                let _ = state.events.send(Broadcast::to_many(audience, ServerEvent::Message { message }));
            }
            Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => break, _ => {}
        },
        event = events.recv() => match event {
            // Eventos privados (amizade e mensagem direta) so chegam a quem esta na audiencia.
            Ok(broadcast) => if broadcast.allows(&session.username)
                && socket.send(WsMessage::Text(serde_json::to_string(&broadcast.event).unwrap_or_default().into())).await.is_err() { break; },
            Err(broadcast::error::RecvError::Closed) => break,
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
        }
    }}

    // Fechou o app ou caiu: sai da chamada tambem, senao fica um fantasma na
    // lista do canal de voz ate o servidor reiniciar.
    set_voice(&state, &session.username, &mut sala_de_voz, None).await;

    // Saiu: o ultimo socket fechado marca offline.
    let mut online = state.online.write().await;
    if let Some(count) = online.get_mut(&profile_key(&session.username)) {
        *count = count.saturating_sub(1);
        if *count == 0 {
            online.remove(&profile_key(&session.username));
            drop(online);
            let audience = presence_audience(&state, &session.username).await;
            let _ = state.events.send(Broadcast::to_many(audience, ServerEvent::PresenceChanged {
                username: session.username.clone(), online: false,
            }));
        }
    }
}

async fn load_messages(dir: &Path) -> Vec<ChatMessage> {
    match fs::read(dir.join("messages.json")).await.ok().and_then(|b| serde_json::from_slice::<Vec<ChatMessage>>(&b).ok()) {
        Some(mut v) => { if v.len() > MAX_MESSAGES { v.drain(..v.len() - MAX_MESSAGES); } v }, None => Vec::new(),
    }
}
// Sem servidor nem canal padrao: quem cria e o proprietario, e conta nova nao
// cai automaticamente em lugar nenhum.
async fn load_rooms(dir: &Path) -> Vec<RoomInfo> { load_json(dir, "rooms.json").await }
async fn load_servers(dir: &Path) -> Vec<ServerInfo> { load_json(dir, "servers.json").await }
async fn load_users(dir: &Path) -> HashMap<String, UserAccount> {
    fs::read(dir.join("users.json")).await.ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}
async fn load_profiles(dir: &Path) -> HashMap<String, Profile> {
    fs::read(dir.join("profiles.json")).await.ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}
async fn load_json<T: serde::de::DeserializeOwned + Default>(dir: &Path, file: &str) -> T {
    fs::read(dir.join(file)).await.ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}
/// Le memberships.json convertendo o formato antigo, se for o caso.
async fn load_memberships(dir: &Path) -> HashMap<String, Vec<Member>> {
    let stored: HashMap<String, StoredMembers> = load_json(dir, "memberships.json").await;
    stored.into_iter().map(|(server, members)| (server, members.into())).collect()
}
async fn load_envelopes(dir: &Path) -> Vec<Envelope> {
    let mut list: Vec<Envelope> = load_json(dir, "dms.json").await;
    if list.len() > MAX_ENVELOPES { list.drain(..list.len() - MAX_ENVELOPES); }
    list
}
async fn persist_json<T: Serialize + ?Sized>(dir: &Path, file: &str, value: &T) {
    let path = dir.join(file); let temp = dir.join(format!("{file}.tmp"));
    if let Ok(bytes) = serde_json::to_vec_pretty(value) { if fs::write(&temp, bytes).await.is_ok() { let _ = fs::rename(temp, path).await; } }
}

#[cfg(test)]
mod testes_nome {
    use super::nome_de_anexo;

    /// O nome do anexo vem de quem enviou, e por isso e entrada nao confiavel.
    #[test]
    fn nao_atravessa_pastas() {
        assert_eq!(nome_de_anexo(r"..\..\Windows\System32\algo.png", "png"), "algo.png");
        assert_eq!(nome_de_anexo("../../etc/passwd", "bin"), "passwd");
        assert_eq!(nome_de_anexo("..", "png"), "arquivo.png");
        assert_eq!(nome_de_anexo("", "png"), "arquivo.png");
    }

    /// O ponto simples precisa sobreviver: sem extensao o navegador nao sabe o
    /// que abrir, e o arquivo salvo chega sem tipo.
    #[test]
    fn extensao_sobrevive() {
        assert_eq!(nome_de_anexo("minha foto.png", "png"), "minha foto.png");
        assert_eq!(nome_de_anexo("relatorio.final.pdf", "pdf"), "relatorio.final.pdf");
        assert_eq!(nome_de_anexo("férias 2026.jpg", "jpg"), "férias 2026.jpg");
    }

    /// Nome comprido nao pode estourar o campo, e o corte nao pode deixar so
    /// espaco.
    #[test]
    fn nome_comprido_e_cortado() {
        let gigante = "a".repeat(400) + ".png";
        assert_eq!(nome_de_anexo(&gigante, "png").chars().count(), 120);
        assert_eq!(nome_de_anexo("   ", "png"), "arquivo.png");
    }
}
