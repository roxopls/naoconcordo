//! Chamadas privadas P2P: num grupo privado ou numa conversa a dois.
//!
//! A midia **nao passa por aqui**. Voz, camera e tela vao direto de uma pessoa
//! para a outra (WebRTC em malha); este servidor so faz tres coisas:
//!
//! - guarda quem esta em cada chamada (em memoria, como a lista de voz);
//! - repassa as mensagens de sinalizacao (oferta, resposta, candidatos ICE)
//!   de um socket para outro, sem abrir nem guardar;
//! - entrega credenciais temporarias do TURN, o repasse que so entra em cena
//!   quando as duas pontas nao conseguem se ver direto — e mesmo ali a midia
//!   segue cifrada de ponta a ponta (DTLS-SRTP).
//!
//! Uma chamada e identificada por texto: `grupo:<id>` ou `dm:<a>|<b>`, com os
//! dois nomes em minusculas e em ordem, para os dois lados chegarem no mesmo.

use super::*;
use sha1::Sha1;

/// Uma pessoa numa chamada, por socket: a mesma conta pode estar com o app
/// aberto em duas maquinas, e so a que entrou conversa.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Participante {
    pub username: String,
    pub sessao: u64,
    pub desde: DateTime<Utc>,
    pub mudo: bool,
    pub camera: bool,
    pub tela: bool,
}

/// Quem pode ver e entrar nesta chamada. `None` quando a pessoa nao tem nada
/// a ver com ela — grupo de que nao participa, conversa de outros.
pub async fn audiencia(state: &AppState, chamada: &str, pessoa: &str) -> Option<Vec<String>> {
    if let Some(id) = chamada.strip_prefix("grupo:") {
        let grupos = state.grupos.read().await;
        let grupo = grupos.iter().find(|g| g.id == id)?;
        if !grupo.membros.iter().any(|m| profile_key(m) == profile_key(pessoa)) { return None; }
        return Some(grupo.membros.clone());
    }
    if let Some(par) = chamada.strip_prefix("dm:") {
        let (a, b) = par.split_once('|')?;
        if a >= b || (profile_key(pessoa) != a && profile_key(pessoa) != b) { return None; }
        if !friends_already(&state.friendships.read().await, a, b) { return None; }
        return Some(vec![a.to_string(), b.to_string()]);
    }
    None
}

fn avisar_estado(state: &AppState, chamada: &str, publico: Vec<String>, participantes: Vec<Participante>) {
    let _ = state.events.send(Broadcast::to_many(publico, ServerEvent::ChamadaEstado {
        chamada: chamada.to_string(), participantes,
    }));
}

/// Tira este socket de qualquer chamada em que ele esteja. Usado ao entrar
/// noutra, ao sair e quando o socket cai.
pub async fn sair(state: &AppState, sessao: u64) {
    let mudadas: Vec<(String, Vec<Participante>)> = {
        let mut chamadas = state.chamadas_privadas.write().await;
        let mut mudadas = Vec::new();
        for (id, lista) in chamadas.iter_mut() {
            let antes = lista.len();
            lista.retain(|p| p.sessao != sessao);
            if lista.len() != antes { mudadas.push((id.clone(), lista.clone())); }
        }
        chamadas.retain(|_, lista| !lista.is_empty());
        mudadas
    };
    for (id, lista) in mudadas {
        // A audiencia sai do proprio grupo/par: quem saiu da chamada continua
        // precisando saber que ela acabou.
        let publico = match lista.first() {
            Some(p) => audiencia(state, &id, &p.username).await,
            None => publico_sem_participante(state, &id).await,
        };
        if let Some(publico) = publico { avisar_estado(state, &id, publico, lista); }
    }
}

/// Audiencia de uma chamada que acabou de esvaziar: nao sobrou ninguem para
/// usar como referencia, entao vale o grupo inteiro ou o par.
async fn publico_sem_participante(state: &AppState, chamada: &str) -> Option<Vec<String>> {
    if let Some(id) = chamada.strip_prefix("grupo:") {
        return state.grupos.read().await.iter().find(|g| g.id == id).map(|g| g.membros.clone());
    }
    let (a, b) = chamada.strip_prefix("dm:")?.split_once('|')?;
    Some(vec![a.to_string(), b.to_string()])
}

/// Trata as mensagens do socket que sao desta parte. Devolve `true` quando a
/// mensagem era daqui, para o laco do socket seguir em frente.
pub async fn tratar(state: &AppState, pessoa: &str, sessao: u64, entrada: &ClientMessage) -> bool {
    match entrada.kind.as_str() {
        "chamadaEntrar" => {
            let Some(chamada) = entrada.chamada.clone() else { return true; };
            let Some(publico) = audiencia(state, &chamada, pessoa).await else { return true; };
            sair(state, sessao).await;
            let (lista, era_vazia) = {
                let mut chamadas = state.chamadas_privadas.write().await;
                let lista = chamadas.entry(chamada.clone()).or_default();
                let era_vazia = lista.is_empty();
                // Limite da malha: o mesmo do grupo.
                if lista.len() >= grupos::MAX_MEMBROS { return true; }
                lista.push(Participante {
                    username: pessoa.to_string(), sessao, desde: Utc::now(),
                    mudo: entrada.mudo.unwrap_or(false), camera: false, tela: false,
                });
                (lista.clone(), era_vazia)
            };
            avisar_estado(state, &chamada, publico.clone(), lista);
            // Quem abre a chamada faz o telefone dos outros tocar.
            if era_vazia {
                let outros: Vec<String> = publico.into_iter().filter(|m| profile_key(m) != profile_key(pessoa)).collect();
                let _ = state.events.send(Broadcast::to_many(outros, ServerEvent::ChamadaTocando {
                    chamada, de: pessoa.to_string(),
                }));
            }
            true
        }
        "chamadaSair" => { sair(state, sessao).await; true }
        "chamadaMidia" => {
            let atualizada = {
                let mut chamadas = state.chamadas_privadas.write().await;
                let mut achada = None;
                for (id, lista) in chamadas.iter_mut() {
                    if let Some(p) = lista.iter_mut().find(|p| p.sessao == sessao) {
                        if let Some(v) = entrada.mudo { p.mudo = v; }
                        if let Some(v) = entrada.camera { p.camera = v; }
                        if let Some(v) = entrada.tela { p.tela = v; }
                        achada = Some((id.clone(), lista.clone()));
                        break;
                    }
                }
                achada
            };
            if let Some((id, lista)) = atualizada {
                if let Some(publico) = audiencia(state, &id, pessoa).await { avisar_estado(state, &id, publico, lista); }
            }
            true
        }
        "sinal" => {
            let (Some(chamada), Some(para), Some(dados)) = (entrada.chamada.clone(), entrada.para, entrada.dados.clone()) else { return true; };
            // Oferta de video com muitos codecs passa de 10 KB; 64 KB e folga
            // sem virar jeito de despejar coisa grande nos outros.
            if dados.to_string().len() > 64 * 1024 { return true; }
            let destino = {
                let chamadas = state.chamadas_privadas.read().await;
                let Some(lista) = chamadas.get(&chamada) else { return true; };
                // As duas pontas precisam estar na chamada: sinal nao e jeito
                // de mandar recado para quem nao entrou.
                if !lista.iter().any(|p| p.sessao == sessao) { return true; }
                lista.iter().find(|p| p.sessao == para).map(|p| p.username.clone())
            };
            if let Some(destino) = destino {
                let _ = state.events.send(Broadcast::para_socket(&destino, para, ServerEvent::Sinal {
                    chamada, de: pessoa.to_string(), de_sessao: sessao, dados,
                }));
            }
            true
        }
        _ => false,
    }
}

/// As chamadas que esta pessoa pode ver agora, para a lista mostrar quem ja
/// esta falando antes de ela entrar.
pub async fn listar(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    let todas: Vec<(String, Vec<Participante>)> = state.chamadas_privadas.read().await
        .iter().map(|(id, lista)| (id.clone(), lista.clone())).collect();
    let mut minhas = BTreeMap::new();
    for (id, lista) in todas {
        if audiencia(&state, &id, &session.username).await.is_some() { minhas.insert(id, lista); }
    }
    Json(minhas).into_response()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IceServer { urls: Vec<String>, #[serde(skip_serializing_if = "Option::is_none")] username: Option<String>, #[serde(skip_serializing_if = "Option::is_none")] credential: Option<String> }

/// Servidores ICE para as conexoes diretas. O TURN usa credencial temporaria
/// no formato do coturn (`use-auth-secret`): usuario `<expira>:<nome>` e senha
/// HMAC-SHA1 do usuario com o segredo compartilhado. Sem `TURN_SECRET` no
/// ambiente vai so o STUN — quem esta atras de NAT dificil fica sem repasse.
pub async fn ice(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some((_, session)) = authenticated(&state, &headers).await else { return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."); };
    let lista = |nome: &str| env::var(nome).unwrap_or_default().split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect::<Vec<_>>();
    let mut servidores = Vec::new();
    let stun = lista("STUN_URLS");
    if !stun.is_empty() { servidores.push(IceServer { urls: stun, username: None, credential: None }); }
    let turn = lista("TURN_URLS");
    if let (false, Ok(segredo)) = (turn.is_empty(), env::var("TURN_SECRET")) {
        let usuario = format!("{}:{}", now() + 12 * 3600, profile_key(&session.username));
        servidores.push(IceServer { urls: turn, credential: Some(credencial_turn(&segredo, &usuario)), username: Some(usuario) });
    }
    Json(json!({ "iceServers": servidores })).into_response()
}

fn credencial_turn(segredo: &str, usuario: &str) -> String {
    let mut mac = <Hmac<Sha1> as Mac>::new_from_slice(segredo.as_bytes()).expect("hmac aceita qualquer tamanho");
    mac.update(usuario.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
}

use serde_json::json;

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn credencial_no_formato_do_coturn() {
        // Vetor conferido com `echo -n '1700000000:ana' | openssl dgst -sha1 -hmac segredo -binary | base64`.
        assert_eq!(credencial_turn("segredo", "1700000000:ana"), "SrmCfwL1NEeme25PEvh3+kCYiMU=");
        assert_ne!(credencial_turn("segredo", "1700000000:ana"), credencial_turn("outro", "1700000000:ana"));
        assert_eq!(credencial_turn("segredo", "x").len(), 28);
    }
}
