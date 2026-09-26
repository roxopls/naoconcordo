//! Lembrete na conversa: `/lembrar sáb 20h Sessão de RPG`.
//!
//! **O horario e lido no cliente**, e nao aqui. "Sabado as 20h" depende do
//! fuso de quem escreveu, e o servidor roda em UTC sem saber onde cada um
//! mora; o cliente sabe, converte e manda o instante pronto. Aqui so se confere
//! que o instante faz sentido e se dispara na hora.
//!
//! A mensagem do pedido fica na conversa como confirmacao ("lembrete marcado
//! para..."), para todo mundo saber. Na hora, sai uma mensagem nova citando a
//! primeira, que notifica o canal. Apagar a mensagem do pedido cancela.

use super::*;
use std::time::Duration;

const MAX_POR_PESSOA: usize = 20;
const MAX_TEXTO: usize = 200;
const MAX_DIAS: i64 = 90;
const INTERVALO: Duration = Duration::from_secs(15);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lembrete {
    pub quando: DateTime<Utc>,
    pub texto: String,
    /// `false` na mensagem do pedido, `true` na que dispara.
    #[serde(default)]
    pub disparado: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PedidoDeLembrete { pub quando: DateTime<Utc>, #[serde(default)] pub texto: String }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pendente {
    /// A mensagem do pedido: e ela que a disparada cita, e apaga-la cancela.
    pub mensagem: Uuid,
    pub room_id: String,
    pub username: String,
    pub texto: String,
    pub quando: DateTime<Utc>,
}

/// `true` se o texto e um pedido de lembrete.
pub fn e_pedido(texto: &str) -> bool {
    let primeira = texto.trim().split_whitespace().next().unwrap_or("").to_lowercase();
    primeira == "/lembrar" || primeira == "/lembrete"
}

pub async fn validar(state: &AppState, pessoa: &str, pedido: Option<PedidoDeLembrete>) -> Result<Lembrete, String> {
    let pedido = pedido.ok_or("Não entendi quando. Exemplos: /lembrar 20h, /lembrar sáb 19:30, /lembrar em 30min.")?;
    let agora = Utc::now();
    if pedido.quando <= agora { return Err("Esse horário já passou.".into()); }
    if pedido.quando > agora + chrono::Duration::days(MAX_DIAS) { return Err(format!("No máximo {MAX_DIAS} dias adiante.")); }
    let meus = state.lembretes.read().await.iter().filter(|p| profile_key(&p.username) == profile_key(pessoa)).count();
    if meus >= MAX_POR_PESSOA { return Err(format!("Você já tem {MAX_POR_PESSOA} lembretes marcados.")); }
    let texto: String = pedido.texto.trim().chars().take(MAX_TEXTO).collect();
    Ok(Lembrete { quando: pedido.quando, texto: if texto.is_empty() { "Lembrete".into() } else { texto }, disparado: false })
}

pub async fn guardar(state: &AppState, mensagem: &ChatMessage, lembrete: &Lembrete) {
    let mut lembretes = state.lembretes.write().await;
    lembretes.push(Pendente {
        mensagem: mensagem.id, room_id: mensagem.room_id.clone(), username: mensagem.username.clone(),
        texto: lembrete.texto.clone(), quando: lembrete.quando,
    });
    persist_json(&state.config.data_dir, "lembretes.json", &*lembretes).await;
}

/// A mensagem do pedido foi apagada: o lembrete vai junto.
pub async fn cancelar(state: &AppState, mensagem: Uuid) {
    let mut lembretes = state.lembretes.write().await;
    let antes = lembretes.len();
    lembretes.retain(|p| p.mensagem != mensagem);
    if lembretes.len() != antes { persist_json(&state.config.data_dir, "lembretes.json", &*lembretes).await; }
}

/// Confere a cada 15 s se algum lembrete venceu. Quinze segundos de atraso no
/// pior caso e nada para "a sessao comeca as 20h".
pub fn vigiar(state: AppState) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(INTERVALO).await;
            disparar_vencidos(&state).await;
        }
    });
}

async fn disparar_vencidos(state: &AppState) {
    let agora = Utc::now();
    let vencidos: Vec<Pendente> = {
        let mut lembretes = state.lembretes.write().await;
        let (vencidos, resto): (Vec<Pendente>, Vec<Pendente>) = lembretes.drain(..).partition(|p| p.quando <= agora);
        *lembretes = resto;
        if !vencidos.is_empty() { persist_json(&state.config.data_dir, "lembretes.json", &*lembretes).await; }
        vencidos
    };
    for pendente in vencidos {
        // Canal apagado ou pessoa que saiu do servidor: o lembrete morre calado.
        let Some(sala) = state.rooms.read().await.iter().find(|r| r.id == pendente.room_id).cloned() else { continue };
        let publico = {
            let memberships = state.memberships.read().await;
            if !is_member(&memberships, &sala.server_id, &pendente.username) { continue; }
            members_of(&memberships, &sala.server_id)
        };
        let citada = state.messages.read().await.iter().any(|m| m.id == pendente.mensagem).then_some(pendente.mensagem);
        let message = ChatMessage {
            id: Uuid::new_v4(), username: pendente.username.clone(), text: format!("⏰ {}", pendente.texto),
            created_at: Utc::now(), edited_at: None, room_id: pendente.room_id.clone(), attachments: Vec::new(),
            reply_to: citada, reactions: BTreeMap::new(), pinned: false, rolagem: None, enquete: None,
            lembrete: Some(Lembrete { quando: pendente.quando, texto: pendente.texto.clone(), disparado: true }),
        };
        {
            let mut historico = state.messages.write().await;
            historico.push(message.clone());
            let excesso = historico.len().saturating_sub(MAX_MESSAGES);
            if excesso > 0 { historico.drain(..excesso); }
            persist_json(&state.config.data_dir, "messages.json", &*historico).await;
        }
        let _ = state.events.send(Broadcast::to_many(publico, ServerEvent::Message { message }));
    }
}
