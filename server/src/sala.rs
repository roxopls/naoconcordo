//! O que acontece num canal de voz alem da voz: o video assistido junto, quem
//! tem prioridade de fala (o "mestre"), e a limpeza de quando a sala esvazia.
//!
//! Tudo aqui vive so em memoria, como a lista de voz: nada disso sobrevive a um
//! restart, e nem deveria — a chamada tambem nao sobrevive.

use super::*;
use std::time::{Duration, Instant};

/// Quanto esperar depois de alguem sair antes de arrumar a sala. A rede pisca e
/// o socket volta em segundos; sem a espera, um soluco da conexao de quem
/// estava sozinho apagaria a sala temporaria e pararia o video de todo mundo.
pub const ESPERA_DE_ARRUMACAO: Duration = Duration::from_secs(30);
/// Sala temporaria recem-criada em que ninguem entrou.
pub const ESPERA_SALA_NOVA: Duration = Duration::from_secs(120);
/// Salas temporarias abertas ao mesmo tempo num servidor.
pub const MAX_TEMPORARIAS: usize = 10;
/// Teto da posicao do video: doze horas cobre qualquer transmissao gravada.
const MAX_POSICAO: f64 = 12.0 * 3600.0;

/// O video que um canal de voz esta assistindo junto.
pub struct Assistindo {
    pub video: String,
    /// Onde o video estava no instante `desde`.
    pub posicao: f64,
    pub tocando: bool,
    pub desde: Instant,
    pub quem: String,
}

/// O que vai para os clientes. A posicao e calculada na hora do envio, e nao
/// mandada com relogio: assim ninguem depende do relogio do servidor bater com
/// o da propria maquina, so do atraso da mensagem, que e pequeno.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistindoVisao { pub video: String, pub posicao: f64, pub tocando: bool, pub quem: String }

impl Assistindo {
    fn agora(&self) -> f64 {
        if self.tocando { self.posicao + self.desde.elapsed().as_secs_f64() } else { self.posicao }
    }
    pub fn visao(&self) -> AssistindoVisao {
        AssistindoVisao { video: self.video.clone(), posicao: self.agora(), tocando: self.tocando, quem: self.quem.clone() }
    }
}

fn video_valido(id: &str) -> bool {
    id.len() == 11 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Quem enxerga o servidor da sala. Assistir e mestre vao para todos, e nao so
/// para quem esta na chamada: quem esta de fora ve o que rola antes de entrar.
async fn publico_da_sala(state: &AppState, room_id: &str) -> Option<Vec<String>> {
    let server_id = state.rooms.read().await.iter().find(|r| r.id == room_id).map(|r| r.server_id.clone())?;
    let memberships = state.memberships.read().await;
    Some(members_of(&memberships, &server_id))
}

async fn avisar_assistindo(state: &AppState, room_id: &str, por: &str) {
    let Some(publico) = publico_da_sala(state, room_id).await else { return };
    let estado = state.assistindo.read().await.get(room_id).map(Assistindo::visao);
    let _ = state.events.send(Broadcast::to_many(publico, ServerEvent::AssistirEstado {
        room_id: room_id.to_string(), estado, por: por.to_string(),
    }));
}

async fn avisar_mestre(state: &AppState, room_id: &str) {
    let Some(publico) = publico_da_sala(state, room_id).await else { return };
    let username = state.mestres.read().await.get(room_id).cloned();
    let _ = state.events.send(Broadcast::to_many(publico, ServerEvent::MestreMudou { room_id: room_id.to_string(), username }));
}

/// Trata "assistir" e "mestre". Devolve `true` quando a mensagem era de um dos
/// dois. Os dois exigem estar na chamada: `sala` e o canal que este socket
/// anunciou, ja conferido quando foi anunciado.
pub async fn tratar(state: &AppState, pessoa: &str, sala: Option<&String>, entrada: &ClientMessage) -> bool {
    match entrada.kind.as_str() {
        "assistir" => {
            let Some(sala) = sala else { return true };
            let posicao = entrada.posicao.filter(|p| p.is_finite()).map(|p| p.clamp(0.0, MAX_POSICAO));
            let acao = entrada.acao.as_deref().unwrap_or("");
            {
                let mut assistindo = state.assistindo.write().await;
                match acao {
                    "iniciar" => {
                        let video = entrada.text.clone().unwrap_or_default();
                        if !video_valido(&video) { return true; }
                        assistindo.insert(sala.clone(), Assistindo {
                            video, posicao: posicao.unwrap_or(0.0), tocando: true, desde: Instant::now(), quem: pessoa.to_string(),
                        });
                    }
                    "tocar" | "pausar" | "ir" => {
                        let Some(atual) = assistindo.get_mut(sala) else { return true };
                        atual.posicao = posicao.unwrap_or_else(|| atual.agora());
                        if acao != "ir" { atual.tocando = acao == "tocar"; }
                        atual.desde = Instant::now();
                    }
                    "parar" => { if assistindo.remove(sala).is_none() { return true; } }
                    _ => return true,
                }
            }
            avisar_assistindo(state, sala, pessoa).await;
            true
        }
        "mestre" => {
            let Some(sala) = sala else { return true };
            if !modo_mestre_ligado(state, sala).await { return true; }
            // So o mestre escolhido para esta sala liga a prioridade. Quem
            // escolhe e dono ou moderador, no canal ou na categoria.
            let designado = mestre_designado(state, sala).await;
            if !designado.is_some_and(|nome| profile_key(&nome) == profile_key(pessoa)) { return true; }
            let mudou = {
                let mut mestres = state.mestres.write().await;
                match entrada.acao.as_deref() {
                    Some("assumir") => mestres.insert(sala.clone(), pessoa.to_string()).as_deref() != Some(pessoa),
                    // So quem e o mestre larga: tirar o dos outros e assumir.
                    Some("largar") if mestres.get(sala).is_some_and(|m| profile_key(m) == profile_key(pessoa)) => {
                        mestres.remove(sala);
                        true
                    }
                    _ => false,
                }
            };
            if mudou { avisar_mestre(state, sala).await; }
            true
        }
        _ => false,
    }
}

/// O servidor da sala deixa ter mestre?
async fn modo_mestre_ligado(state: &AppState, room_id: &str) -> bool {
    let Some(server_id) = state.rooms.read().await.iter().find(|r| r.id == room_id).map(|r| r.server_id.clone()) else { return false };
    state.servers.read().await.iter().any(|s| s.id == server_id && s.modo_mestre)
}

/// Quem foi escolhido como mestre desta sala: o do proprio canal, ou, sem um,
/// o da categoria em que ele esta. Uma campanha inteira costuma ter o mesmo
/// mestre em todas as mesas, e escolher uma vez na categoria poupa repetir.
pub async fn mestre_designado(state: &AppState, room_id: &str) -> Option<String> {
    let sala = state.rooms.read().await.iter().find(|r| r.id == room_id).cloned()?;
    if sala.mestre.is_some() { return sala.mestre; }
    let categoria = sala.category_id?;
    state.categorias.read().await.iter().find(|c| c.id == categoria).and_then(|c| c.mestre.clone())
}

/// Mudou o modo mestre, o mestre escolhido ou a categoria de um canal: quem
/// esta com a prioridade ligada e ja nao pode ter perde na hora.
pub async fn conferir_mestres_do_servidor(state: &AppState, server_id: &str) {
    let salas: Vec<String> = state.rooms.read().await.iter().filter(|r| r.server_id == server_id).map(|r| r.id.clone()).collect();
    let ligado = state.servers.read().await.iter().any(|s| s.id == server_id && s.modo_mestre);
    let mut largadas = Vec::new();
    for sala in salas {
        let Some(ativo) = state.mestres.read().await.get(&sala).cloned() else { continue };
        let designado = mestre_designado(state, &sala).await;
        if !ligado || !designado.is_some_and(|nome| profile_key(&nome) == profile_key(&ativo)) {
            state.mestres.write().await.remove(&sala);
            largadas.push(sala);
        }
    }
    for sala in largadas { avisar_mestre(state, &sala).await; }
}

/// Arruma a sala daqui a pouco. Chamado quando alguem sai e quando nasce uma
/// sala temporaria.
pub fn agendar_arrumacao(state: AppState, room_id: String, espera: Duration) {
    tokio::spawn(async move {
        tokio::time::sleep(espera).await;
        arrumar(&state, &room_id).await;
    });
}

async fn arrumar(state: &AppState, room_id: &str) {
    let presentes = nomes_na_voz(&state.voice.read().await.get(room_id).cloned().unwrap_or_default());
    let mestre = state.mestres.read().await.get(room_id).cloned();
    if presentes.is_empty() {
        if state.assistindo.write().await.remove(room_id).is_some() { avisar_assistindo(state, room_id, "").await; }
        if state.mestres.write().await.remove(room_id).is_some() { avisar_mestre(state, room_id).await; }
        apagar_se_temporaria(state, room_id).await;
    } else if let Some(mestre) = mestre {
        // O mestre saiu e a mesa continuou: a prioridade nao fica presa em
        // quem nem esta mais ouvindo.
        if !presentes.iter().any(|nome| profile_key(nome) == profile_key(&mestre)) {
            state.mestres.write().await.remove(room_id);
            avisar_mestre(state, room_id).await;
        }
    }
}

async fn apagar_se_temporaria(state: &AppState, room_id: &str) {
    let server_id = {
        let mut rooms = state.rooms.write().await;
        let Some(sala) = rooms.iter().find(|r| r.id == room_id && r.temporaria).cloned() else { return };
        rooms.retain(|r| r.id != room_id);
        persist_json(&state.config.data_dir, "rooms.json", &*rooms).await;
        sala.server_id
    };
    state.voice.write().await.remove(room_id);
    let publico = { let memberships = state.memberships.read().await; members_of(&memberships, &server_id) };
    let _ = state.events.send(Broadcast::to_many(publico, ServerEvent::CanaisOrganizados { server_id }));
}
