//! Encerra no LiveKit a sessao de quem saiu da chamada.
//!
//! Cada pessoa pode ter ate tres conexoes na mesma sala: a dela, a da captura
//! de tela (`nome#tela`, feita em Rust, com conexao propria) e a da janela de
//! cameras (`nome#cameras`). Sair da chamada so derruba a primeira com certeza:
//! as outras duas dependem de o aplicativo lembrar de fecha-las, e nao fecham
//! quando a conta entra por outro computador — o LiveKit tira a conexao da
//! pessoa por identidade repetida, mas a captura de tela do computador antigo
//! tem outra identidade e continua publicando numa chamada onde o dono nao
//! esta mais.
//!
//! Aqui o servidor pede ao LiveKit que remova as tres, em dois momentos:
//!
//! - quando a pessoa sai de um canal de voz ou troca de canal;
//! - quando ela entra: o que sobrou de tela e de cameras naquela sala e de uma
//!   sessao anterior, porque as duas so nascem depois de entrar.
//!
//! Queda de socket **nao** encerra nada. A conversa passa pelo tunel e a midia
//! vai direto: o socket cai sozinho com a chamada perfeita, e derrubar a
//! chamada junto transformaria um soluco do chat em queda de voz.

use std::time::{Duration, Instant};

use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use serde_json::json;

use crate::{AppState, now, profile_key};

/// Token emitido ha menos tempo que isto conta como "a pessoa esta entrando".
///
/// O aviso de saida chega pelo socket e o pedido de token chega por HTTP, sem
/// ordem garantida entre os dois. Sair e entrar de novo na mesma sala, com o
/// aviso atrasado, removeria a sessao que acabou de nascer.
const ENTRANDO: Duration = Duration::from_secs(8);

const SABORES: [&str; 3] = ["", "#tela", "#cameras"];

fn chave(sala: &str, identidade: &str) -> String { format!("{sala}\n{identidade}") }

/// Anota que saiu um token para esta identidade nesta sala.
pub async fn anotar_token(state: &AppState, sala: &str, identidade: &str) {
    let mut recentes = state.tokens_recentes.write().await;
    recentes.retain(|_, quando| quando.elapsed() < ENTRANDO);
    recentes.insert(chave(sala, identidade), Instant::now());
}

async fn entrando(state: &AppState, sala: &str, identidade: &str) -> bool {
    state.tokens_recentes.read().await.get(&chave(sala, identidade))
        .is_some_and(|quando| quando.elapsed() < ENTRANDO)
}

/// Tira uma identidade de uma sala. Nao estar la e o caso comum, e nao e erro.
async fn remover(state: &AppState, sala: &str, identidade: &str) {
    if entrando(state, sala, identidade).await { return; }
    let emitido = now();
    let claims = json!({
        "iss": state.config.livekit_key, "sub": "naoconcordo-servidor",
        "nbf": emitido.saturating_sub(10), "exp": emitido + 60,
        "video": { "roomAdmin": true, "room": sala },
    });
    let Ok(token) = encode(&Header::new(Algorithm::HS256), &claims,
        &EncodingKey::from_secret(state.config.livekit_secret.as_bytes())) else { return; };
    let Ok(cliente) = reqwest::Client::builder().timeout(Duration::from_secs(2)).build() else { return; };
    let pedido = cliente
        .post(format!("{}/twirp/livekit.RoomService/RemoveParticipant", state.config.livekit_api.trim_end_matches('/')))
        .bearer_auth(token)
        .json(&json!({ "room": sala, "identity": identidade }))
        .send().await;
    match pedido {
        Ok(resposta) if resposta.status().is_success() => eprintln!("[livekit] {identidade} removido de {sala}"),
        // 404: nao estava na sala.
        Ok(resposta) if resposta.status().as_u16() == 404 => {}
        Ok(resposta) => eprintln!("[livekit] remover {identidade} de {sala}: {}", resposta.status()),
        Err(erro) => eprintln!("[livekit] remover {identidade} de {sala}: {erro}"),
    }
}

/// A pessoa saiu deste canal de voz: encerra as tres conexoes dela na sala.
///
/// Nao faz nada se outro socket da mesma conta ainda se anuncia no canal — o
/// aplicativo aberto em duas maquinas — porque ai a sessao que vale e a outra.
pub async fn encerrar_saida(state: &AppState, username: &str, canal: &str) {
    let ainda = state.voice.read().await.get(canal)
        .is_some_and(|gente| gente.iter().any(|p| profile_key(&p.username) == profile_key(username)));
    if ainda { return; }
    let sala = format!("naoconcordo-{canal}");
    for sabor in SABORES { remover(state, &sala, &format!("{username}{sabor}")).await; }
}

/// A pessoa esta entrando: tela e cameras dela que ainda estejam na sala sao
/// resto de outra sessao.
pub async fn limpar_auxiliares(state: &AppState, username: &str, sala: &str) {
    for sabor in &SABORES[1..] { remover(state, sala, &format!("{username}{sabor}")).await; }
}
