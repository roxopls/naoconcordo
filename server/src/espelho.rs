//! Espelho para OBS: um endereço fixo que mostra as câmeras de um canal de voz
//! fora do aplicativo.
//!
//! O OBS abre uma página como qualquer navegador (Browser Source), e não tem
//! sessão nenhuma: não dá para pedir login ali. Então o próprio endereço é a
//! credencial, e o que ele carrega é assinado — `canal`, `alvo` e a `geração`
//! do canal, com uma etiqueta de HMAC no fim.
//!
//! # Por que determinístico
//!
//! A etiqueta sai de uma conta, e não de um sorteio guardado em disco: o mesmo
//! canal devolve o mesmo endereço amanhã, e quem monta uma cena no OBS deixa a
//! fonte salva lá e esquece. Em troca, revogar não é apagar uma linha — é
//! trocar a **geração** do canal, e isso derruba todos os links dele de uma vez,
//! o que é justamente o que se quer quando um endereço vaza.
//!
//! # O que o link não é
//!
//! Não é acesso ao canal: o token que sai daqui só assina faixas, nunca
//! publica, e entra oculto na sala. Quem tem o link vê as câmeras de quem
//! ligou a câmera, enquanto o espelho estiver ligado e o alvo ainda participar
//! do servidor. Cai fora em qualquer um dos três casos.
//!
//! O aplicativo mostra no canal que o espelho está ligado — ver o cliente. É
//! deliberado: câmera que pode estar numa transmissão não pode ser surpresa
//! para quem a ligou.

use super::*;

/// Quanto vale o token que a página recebe. Igual ao da chamada; a página
/// renova antes de vencer, então transmissão longa não cai no meio.
const VALIDADE: u64 = 21600;

/// O alvo que significa "a grade do canal inteiro", no lugar de uma pessoa.
///
/// Um pedaço de caminho que não pode ser nome de usuário: `valid_name` não
/// aceita `-`, então ninguém registra uma conta que colida com a grade.
pub const GRADE: &str = "-";

/// A etiqueta que assina `(canal, alvo, geração)`.
///
/// Vazia só se o HMAC recusar a chave, que não acontece com chave de 32 bytes;
/// quem confere trata a vazia como "não serve" de qualquer forma.
pub fn etiqueta(chave: &[u8; 32], room_id: &str, alvo: &str, geracao: u32) -> String {
    let Ok(mut mac) = HmacSha256::new_from_slice(chave) else { return String::new() };
    // O prefixo separa este uso dos outros HMAC do servidor — convite, mídia de
    // prévia. Mesma chave, propósitos diferentes: sem ele uma etiqueta de um
    // lado poderia valer no outro.
    mac.update(format!("espelho:{room_id}:{alvo}:{geracao}").as_bytes());
    // 8 bytes em hexa: 64 bits. Adivinhar exige tentar contra um servidor que
    // responde uma por vez, e o endereço não anda em lugar público.
    mac.finalize().into_bytes().iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// Confere a etiqueta sem contar em qual byte ela errou.
fn confere(chave: &[u8; 32], room_id: &str, alvo: &str, geracao: u32, oferecida: &str) -> bool {
    let esperada = etiqueta(chave, room_id, alvo, geracao);
    if esperada.is_empty() || esperada.len() != oferecida.len() { return false; }
    esperada.bytes().zip(oferecida.bytes()).fold(0_u8, |junto, (a, b)| junto | (a ^ b)) == 0
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ajuste {
    ligado: bool,
    /// Troca a geração do canal: todos os links antigos dele param de valer.
    #[serde(default)]
    rotacionar: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pessoa { username: String, etiqueta: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Visao {
    ligado: bool,
    geracao: u32,
    /// Etiqueta da grade do canal inteiro.
    grade: String,
    /// Uma etiqueta por membro do servidor. Todos, e não só quem está na
    /// chamada agora: quem monta a cena no OBS faz isso antes de a sessão
    /// começar, com a sala vazia.
    pessoas: Vec<Pessoa>,
}

/// O canal e o servidor dele, se existir e for de voz.
async fn canal_de_voz(state: &AppState, id: &str) -> Option<RoomInfo> {
    state.rooms.read().await.iter().find(|r| r.id == id && r.kind == RoomKind::Voice).cloned()
}

/// Liga, desliga ou rotaciona o espelho do canal. Só dono e moderador.
pub async fn ajustar(
    State(state): State<AppState>,
    Caminho(id): Caminho<String>,
    headers: HeaderMap,
    Json(body): Json<Ajuste>,
) -> Response {
    let Some((_, sessao)) = authenticated(&state, &headers).await else {
        return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada.");
    };
    let Some(canal) = canal_de_voz(&state, &id).await else {
        return error(StatusCode::NOT_FOUND, "Canal de voz nao encontrado.");
    };
    {
        let memberships = state.memberships.read().await;
        if !manages(&memberships, &canal.server_id, &sessao.username) {
            return error(StatusCode::FORBIDDEN, "Somente dono ou moderador mexe no espelho.");
        }
    }
    {
        let mut rooms = state.rooms.write().await;
        if let Some(sala) = rooms.iter_mut().find(|r| r.id == id) {
            sala.espelho = body.ligado;
            // Desligar também rotaciona: o endereço que circulou por fora não
            // volta a valer quando alguém religar o espelho meses depois.
            if body.rotacionar || !body.ligado {
                sala.espelho_geracao = sala.espelho_geracao.wrapping_add(1);
            }
        }
        persist_json(&state.config.data_dir, "rooms.json", &*rooms).await;
    }
    let publico = { let memberships = state.memberships.read().await; members_of(&memberships, &canal.server_id) };
    let _ = state.events.send(Broadcast::to_many(publico, ServerEvent::CanaisOrganizados { server_id: canal.server_id }));
    StatusCode::NO_CONTENT.into_response()
}

/// Os endereços do canal, para quem administra copiar.
pub async fn ver(State(state): State<AppState>, Caminho(id): Caminho<String>, headers: HeaderMap) -> Response {
    let Some((_, sessao)) = authenticated(&state, &headers).await else {
        return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada.");
    };
    let Some(canal) = canal_de_voz(&state, &id).await else {
        return error(StatusCode::NOT_FOUND, "Canal de voz nao encontrado.");
    };
    let memberships = state.memberships.read().await;
    if !manages(&memberships, &canal.server_id, &sessao.username) {
        return error(StatusCode::FORBIDDEN, "Somente dono ou moderador ve os enderecos do espelho.");
    }
    let mut pessoas: Vec<Pessoa> = members_of(&memberships, &canal.server_id).into_iter()
        .map(|username| Pessoa {
            etiqueta: etiqueta(&state.auth_key, &id, &username, canal.espelho_geracao),
            username,
        })
        .collect();
    pessoas.sort_by(|a, b| a.username.to_lowercase().cmp(&b.username.to_lowercase()));
    Json(Visao {
        ligado: canal.espelho,
        geracao: canal.espelho_geracao,
        grade: etiqueta(&state.auth_key, &id, GRADE, canal.espelho_geracao),
        pessoas,
    }).into_response()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Acesso {
    token: String,
    url: String,
    room: String,
    /// Quem mostrar. Vazio é a grade do canal inteiro.
    alvo: String,
    /// Quantos segundos até este token vencer, para a página renovar antes.
    expira_em: u64,
}

/// O token que a página do espelho usa para entrar na sala.
///
/// **Sem sessão de propósito**: o OBS não tem uma. A etiqueta do endereço é a
/// credencial, e ela é conferida aqui a cada pedido — inclusive na renovação,
/// que é o que faz desligar o espelho ou tirar a pessoa do servidor cortar a
/// transmissão em menos de seis horas, sem ninguém avisar o OBS de nada.
pub async fn acessar(
    State(state): State<AppState>,
    Caminho((id, alvo, tag)): Caminho<(String, String, String)>,
) -> Response {
    let Some(canal) = canal_de_voz(&state, &id).await else {
        return error(StatusCode::NOT_FOUND, "Canal nao encontrado.");
    };
    // Resposta igual para etiqueta errada e espelho desligado: quem tenta
    // adivinhar não aprende qual dos dois foi.
    if !canal.espelho || !confere(&state.auth_key, &id, &alvo, canal.espelho_geracao, &tag) {
        return error(StatusCode::NOT_FOUND, "Espelho indisponivel.");
    }
    if alvo != GRADE {
        let memberships = state.memberships.read().await;
        if !is_member(&memberships, &canal.server_id, &alvo) {
            return error(StatusCode::NOT_FOUND, "Espelho indisponivel.");
        }
    }
    let livekit_room = format!("naoconcordo-{id}");
    let emitido = now();
    // Identidade fixa por endereço, pelo mesmo motivo da janela de câmeras: com
    // identidade sorteada, uma queda de rede deixa o espelho antigo na sala
    // como fantasma. Fixa, o LiveKit derruba a conexão velha quando a nova
    // entra. O prefixo `espelho#` não colide com nome de usuário, que não
    // aceita `#`.
    let sub = format!("espelho#{alvo}");
    let claims = LivekitClaims {
        iss: state.config.livekit_key.clone(),
        sub,
        name: "espelho".to_string(),
        nbf: emitido.saturating_sub(10),
        exp: emitido + VALIDADE,
        video: VideoGrant {
            room_join: true,
            room: livekit_room.clone(),
            // Só olha: não publica, não manda dado, não escreve atributo, e
            // fica oculto para quem está na chamada.
            can_publish: false,
            can_subscribe: true,
            can_publish_data: false,
            can_update_own_metadata: false,
            hidden: true,
        },
        metadata: Some(r#"{"kind":"espelho"}"#.to_string()),
    };
    match encode(&Header::new(Algorithm::HS256), &claims, &EncodingKey::from_secret(state.config.livekit_secret.as_bytes())) {
        Ok(token) => Json(Acesso {
            token,
            url: state.config.livekit_url.clone(),
            room: livekit_room,
            alvo: if alvo == GRADE { String::new() } else { alvo },
            expira_em: VALIDADE,
        }).into_response(),
        Err(erro) => {
            eprintln!("[espelho] token nao assinou: {erro}");
            error(StatusCode::INTERNAL_SERVER_ERROR, "Nao foi possivel entrar na sala.")
        }
    }
}

#[cfg(test)]
mod testes {
    use super::*;

    const CHAVE: [u8; 32] = [7; 32];

    /// O endereço é fixo: mesma entrada, mesma etiqueta, hoje e em seis meses.
    /// É o que permite deixar a fonte salva no OBS.
    #[test]
    fn etiqueta_e_estavel() {
        let a = etiqueta(&CHAVE, "sala1", "ana", 0);
        assert_eq!(a, etiqueta(&CHAVE, "sala1", "ana", 0));
        assert_eq!(a.len(), 16, "8 bytes em hexa");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    /// Cada alvo tem o seu, e a grade não é a etiqueta de ninguém: se todas
    /// batessem, um link de uma pessoa serviria para ver a sala toda.
    #[test]
    fn cada_alvo_tem_a_sua() {
        let ana = etiqueta(&CHAVE, "sala1", "ana", 0);
        let beto = etiqueta(&CHAVE, "sala1", "beto", 0);
        let grade = etiqueta(&CHAVE, "sala1", GRADE, 0);
        let outra_sala = etiqueta(&CHAVE, "sala2", "ana", 0);
        assert_ne!(ana, beto);
        assert_ne!(ana, grade);
        assert_ne!(ana, outra_sala);
    }

    /// Trocar a geração é como se revoga: os endereços que circularam param de
    /// valer todos de uma vez, sem apagar nada em disco.
    #[test]
    fn rotacao_invalida_o_que_havia() {
        let antes = etiqueta(&CHAVE, "sala1", "ana", 3);
        let depois = etiqueta(&CHAVE, "sala1", "ana", 4);
        assert_ne!(antes, depois);
        assert!(confere(&CHAVE, "sala1", "ana", 3, &antes));
        assert!(!confere(&CHAVE, "sala1", "ana", 4, &antes));
    }

    /// Chave de outro servidor não abre este espelho, e etiqueta truncada ou
    /// vazia não passa por acidente de comparação de tamanho.
    #[test]
    fn confere_recusa_o_que_nao_assinamos() {
        let boa = etiqueta(&CHAVE, "sala1", "ana", 0);
        assert!(!confere(&[9; 32], "sala1", "ana", 0, &boa));
        assert!(!confere(&CHAVE, "sala1", "ana", 0, &boa[..15]));
        assert!(!confere(&CHAVE, "sala1", "ana", 0, ""));
        assert!(!confere(&CHAVE, "sala1", "ana", 0, &boa.to_uppercase()));
    }
}
