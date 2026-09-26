//! Grupos privados: conversa de ate dez pessoas, fora de qualquer servidor.
//!
//! O texto e cifrado no aparelho de quem escreve, como nas conversas privadas.
//! A diferenca e a chave: a dois, cada par deriva a sua por ECDH; num grupo,
//! alguem sorteia uma chave AES-256 e a entrega **embrulhada** para cada membro,
//! cifrada com o segredo ECDH entre quem embrulhou e quem recebe. Este servidor
//! guarda os embrulhos e os envelopes, e nao abre nenhum dos dois.
//!
//! A chave tem **epoca**. Quem entra recebe todas as epocas (le o historico,
//! como no Discord). Quem sai deixa o grupo marcado com `rotacao_pendente`: o
//! primeiro membro que abrir o grupo sorteia a chave seguinte e embrulha para
//! quem ficou, e ate la ninguem manda mensagem nova — senao quem saiu ainda
//! leria o que vem depois.

use super::*;

/// Dez pessoas: e o tamanho que o grupo privado do Discord tambem usa, e o
/// limite pratico de uma chamada em malha, que e o que vem depois.
pub const MAX_MEMBROS: usize = 10;
const MAX_MENSAGENS: usize = 20_000;

/// A chave de uma epoca, cifrada para uma pessoa. `de` diz quem embrulhou:
/// e com a chave publica dela que quem recebe desembrulha.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChaveEmbrulhada { pub de: String, pub ciphertext: String, pub nonce: String }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrupoPrivado {
    pub id: String,
    /// Sem nome o cliente mostra os nomes dos membros, como o Discord.
    #[serde(default)] pub nome: Option<String>,
    #[serde(default)] pub icon_file: Option<String>,
    pub dono: String,
    pub membros: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub epoca: u32,
    #[serde(default)] pub rotacao_pendente: bool,
    /// epoca -> pessoa (chave de perfil) -> embrulho.
    #[serde(default)] pub chaves: BTreeMap<u32, BTreeMap<String, ChaveEmbrulhada>>,
}

/// O grupo como uma pessoa o ve: so os embrulhos dela.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrupoParaMim {
    id: String, nome: Option<String>, icon_file: Option<String>, dono: String,
    membros: Vec<String>, created_at: DateTime<Utc>, epoca: u32, rotacao_pendente: bool,
    chaves: BTreeMap<u32, ChaveEmbrulhada>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrupoMensagem {
    pub id: Uuid, pub grupo_id: String, pub from: String, pub epoca: u32,
    pub ciphertext: String, pub nonce: String, pub created_at: DateTime<Utc>,
    #[serde(default)] pub edited_at: Option<DateTime<Utc>>,
    #[serde(default)] pub attachments: Vec<StoredFile>,
    #[serde(default)] pub reply_to: Option<Uuid>,
}

impl GrupoPrivado {
    fn tem(&self, pessoa: &str) -> bool { self.membros.iter().any(|m| profile_key(m) == profile_key(pessoa)) }
    fn para(&self, pessoa: &str) -> GrupoParaMim {
        let minha = profile_key(pessoa);
        GrupoParaMim {
            id: self.id.clone(), nome: self.nome.clone(), icon_file: self.icon_file.clone(),
            dono: self.dono.clone(), membros: self.membros.clone(), created_at: self.created_at,
            epoca: self.epoca, rotacao_pendente: self.rotacao_pendente,
            chaves: self.chaves.iter()
                .filter_map(|(epoca, por)| por.get(&minha).map(|c| (*epoca, c.clone())))
                .collect(),
        }
    }
}

/// Os dois dividem algum grupo? Libera a chave publica entre quem nao e amigo.
pub async fn compartilham(state: &AppState, a: &str, b: &str) -> bool {
    state.grupos.read().await.iter().any(|g| g.tem(a) && g.tem(b))
}

/// Cada membro recebe o grupo com os proprios embrulhos.
fn avisar_membros(state: &AppState, grupo: &GrupoPrivado) {
    for membro in &grupo.membros {
        let _ = state.events.send(Broadcast::to_one(membro, ServerEvent::GrupoAtualizado { grupo: grupo.para(membro) }));
    }
}

fn embrulho_valido(c: &ChaveEmbrulhada, quem: &str) -> bool {
    profile_key(&c.de) == profile_key(quem) && valid_b64(&c.ciphertext, 256) && valid_b64(&c.nonce, 32)
}

/// Um embrulho por membro, todos feitos por quem pede. Nem a mais nem a menos:
/// membro sem embrulho ficaria sem ler, e embrulho sobrando seria chave para
/// quem nao esta no grupo.
fn embrulhos_para(membros: &[String], chaves: &BTreeMap<String, ChaveEmbrulhada>, quem: &str)
    -> Option<BTreeMap<String, ChaveEmbrulhada>> {
    let mut saida = BTreeMap::new();
    for (pessoa, c) in chaves { saida.insert(profile_key(pessoa), c.clone()); }
    let esperado: Vec<String> = membros.iter().map(|m| profile_key(m)).collect();
    if saida.len() != esperado.len() || !esperado.iter().all(|m| saida.contains_key(m)) { return None; }
    if !saida.values().all(|c| embrulho_valido(c, quem)) { return None; }
    Some(saida)
}

async fn gravar(state: &AppState) {
    persist_json(&state.config.data_dir, "grupos.json", &*state.grupos.read().await).await;
}
async fn gravar_mensagens(state: &AppState) {
    persist_json(&state.config.data_dir, "grupos_mensagens.json", &*state.grupos_mensagens.read().await).await;
}

pub async fn carregar(dir: &Path) -> (Vec<GrupoPrivado>, Vec<GrupoMensagem>) {
    let grupos: Vec<GrupoPrivado> = load_json(dir, "grupos.json").await;
    let mut mensagens: Vec<GrupoMensagem> = load_json(dir, "grupos_mensagens.json").await;
    if mensagens.len() > MAX_MENSAGENS { mensagens.drain(..mensagens.len() - MAX_MENSAGENS); }
    (grupos, mensagens)
}

macro_rules! sessao {
    ($state:expr, $headers:expr) => {
        match authenticated(&$state, &$headers).await {
            Some((_, s)) => s,
            None => return error(StatusCode::UNAUTHORIZED, "Sessao invalida ou expirada."),
        }
    };
}

// ------------------------------------------------------------------ grupos

pub async fn listar(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let session = sessao!(state, headers);
    let meus: Vec<GrupoParaMim> = state.grupos.read().await.iter()
        .filter(|g| g.tem(&session.username)).map(|g| g.para(&session.username)).collect();
    Json(meus).into_response()
}

#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
pub struct CriarInput { #[serde(default)] nome: Option<String>, membros: Vec<String>, chaves: BTreeMap<String, ChaveEmbrulhada> }

pub async fn criar(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<CriarInput>) -> Response {
    let session = sessao!(state, headers);
    let eu = session.username.clone();
    let mut membros = vec![eu.clone()];
    {
        let amizades = state.friendships.read().await;
        for nome in body.membros.iter().map(|n| normalize_name(n)) {
            if membros.iter().any(|m| profile_key(m) == profile_key(&nome)) { continue; }
            // So entra quem e amigo de quem cria: grupo nao e jeito de falar
            // com desconhecido.
            if !friends_already(&amizades, &eu, &nome) {
                return error(StatusCode::FORBIDDEN, "Só dá para chamar amigos para o grupo.");
            }
            membros.push(nome);
        }
    }
    if membros.len() < 2 { return error(StatusCode::BAD_REQUEST, "Escolha pelo menos um amigo."); }
    if membros.len() > MAX_MEMBROS { return error(StatusCode::BAD_REQUEST, "O grupo aceita até 10 pessoas."); }
    let nome = body.nome.map(|n| n.trim().chars().take(50).collect::<String>()).filter(|n| !n.is_empty());
    let Some(embrulhos) = embrulhos_para(&membros, &body.chaves, &eu) else {
        return error(StatusCode::BAD_REQUEST, "Chave do grupo incompleta.");
    };
    let grupo = GrupoPrivado {
        id: Uuid::new_v4().to_string(), nome, icon_file: None, dono: eu.clone(), membros,
        created_at: Utc::now(), epoca: 1, rotacao_pendente: false,
        chaves: BTreeMap::from([(1, embrulhos)]),
    };
    state.grupos.write().await.push(grupo.clone());
    gravar(&state).await;
    avisar_membros(&state, &grupo);
    (StatusCode::CREATED, Json(grupo.para(&eu))).into_response()
}

#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
pub struct EditarInput {
    #[serde(default, deserialize_with = "double_option")] nome: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")] icon_file: Option<Option<String>>,
}

/// Qualquer membro renomeia e troca o icone, como no Discord.
pub async fn editar(State(state): State<AppState>, headers: HeaderMap, Caminho(id): Caminho<String>, Json(body): Json<EditarInput>) -> Response {
    let session = sessao!(state, headers);
    if let Some(Some(arquivo)) = &body.icon_file {
        if !arquivo_e_imagem(&state, arquivo).await { return error(StatusCode::BAD_REQUEST, "O ícone precisa ser uma imagem."); }
    }
    let grupo = {
        let mut grupos = state.grupos.write().await;
        let Some(grupo) = grupos.iter_mut().find(|g| g.id == id && g.tem(&session.username)) else {
            return error(StatusCode::NOT_FOUND, "Grupo não encontrado.");
        };
        if let Some(nome) = body.nome {
            grupo.nome = nome.map(|n| n.trim().chars().take(50).collect::<String>()).filter(|n| !n.is_empty());
        }
        if let Some(icone) = body.icon_file { grupo.icon_file = icone; }
        grupo.clone()
    };
    gravar(&state).await;
    avisar_membros(&state, &grupo);
    Json(grupo.para(&session.username)).into_response()
}

#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
pub struct AdicionarInput { username: String, chaves: BTreeMap<u32, ChaveEmbrulhada> }

/// Qualquer membro chama um amigo dele. Quem chama embrulha **todas** as epocas
/// para o novo membro, e e isso que deixa o historico legivel para quem chega.
pub async fn adicionar(State(state): State<AppState>, headers: HeaderMap, Caminho(id): Caminho<String>, Json(body): Json<AdicionarInput>) -> Response {
    let session = sessao!(state, headers);
    let novo = normalize_name(&body.username);
    if !friends_already(&state.friendships.read().await, &session.username, &novo) {
        return error(StatusCode::FORBIDDEN, "Só dá para chamar amigos para o grupo.");
    }
    let grupo = {
        let mut grupos = state.grupos.write().await;
        let Some(grupo) = grupos.iter_mut().find(|g| g.id == id && g.tem(&session.username)) else {
            return error(StatusCode::NOT_FOUND, "Grupo não encontrado.");
        };
        if grupo.tem(&novo) { return error(StatusCode::CONFLICT, "Essa pessoa já está no grupo."); }
        if grupo.membros.len() >= MAX_MEMBROS { return error(StatusCode::BAD_REQUEST, "O grupo aceita até 10 pessoas."); }
        if grupo.rotacao_pendente { return error(StatusCode::CONFLICT, "A chave do grupo está sendo trocada. Tente de novo."); }
        let epocas: Vec<u32> = grupo.chaves.keys().copied().collect();
        if epocas.len() != body.chaves.len() || !epocas.iter().all(|e| body.chaves.get(e).is_some_and(|c| embrulho_valido(c, &session.username))) {
            return error(StatusCode::BAD_REQUEST, "Chave do grupo incompleta.");
        }
        let quem = profile_key(&novo);
        for (epoca, chave) in body.chaves {
            grupo.chaves.entry(epoca).or_default().insert(quem.clone(), chave);
        }
        grupo.membros.push(novo.clone());
        grupo.clone()
    };
    gravar(&state).await;
    avisar_membros(&state, &grupo);
    Json(grupo.para(&session.username)).into_response()
}

/// Sair (a propria pessoa) ou tirar alguem (so o dono). Nos dois casos a chave
/// precisa ser trocada antes da proxima mensagem.
pub async fn remover(State(state): State<AppState>, headers: HeaderMap, Caminho((id, pessoa)): Caminho<(String, String)>) -> Response {
    let session = sessao!(state, headers);
    let alvo = normalize_name(&pessoa);
    let (grupo, apagado) = {
        let mut grupos = state.grupos.write().await;
        let Some(posicao) = grupos.iter().position(|g| g.id == id && g.tem(&session.username)) else {
            return error(StatusCode::NOT_FOUND, "Grupo não encontrado.");
        };
        let grupo = &mut grupos[posicao];
        let sou_eu = profile_key(&alvo) == profile_key(&session.username);
        if !sou_eu && profile_key(&grupo.dono) != profile_key(&session.username) {
            return error(StatusCode::FORBIDDEN, "Só o dono tira alguém do grupo.");
        }
        if !grupo.tem(&alvo) { return error(StatusCode::NOT_FOUND, "Essa pessoa não está no grupo."); }
        let quem = profile_key(&alvo);
        grupo.membros.retain(|m| profile_key(m) != quem);
        // O servidor deixa de entregar as chaves a ela; o que ja estava no
        // aparelho dela nao tem como voltar, e por isso a chave troca.
        for por in grupo.chaves.values_mut() { por.remove(&quem); }
        if grupo.membros.is_empty() {
            (grupos.remove(posicao), true)
        } else {
            if profile_key(&grupo.dono) == quem { grupo.dono = grupo.membros[0].clone(); }
            grupo.rotacao_pendente = true;
            (grupo.clone(), false)
        }
    };
    if apagado {
        state.grupos_mensagens.write().await.retain(|m| m.grupo_id != grupo.id);
        gravar_mensagens(&state).await;
    }
    gravar(&state).await;
    let _ = state.events.send(Broadcast::to_one(&alvo, ServerEvent::GrupoRemovido { grupo_id: grupo.id.clone() }));
    if !apagado { avisar_membros(&state, &grupo); }
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
pub struct RotacionarInput { epoca: u32, chaves: BTreeMap<String, ChaveEmbrulhada> }

/// A chave seguinte, sorteada por um membro que ficou. `epoca` tem de ser a
/// proxima: dois membros abrindo o grupo juntos sorteiam os dois, e so o
/// primeiro vale — o segundo leva 409 e recarrega.
pub async fn rotacionar(State(state): State<AppState>, headers: HeaderMap, Caminho(id): Caminho<String>, Json(body): Json<RotacionarInput>) -> Response {
    let session = sessao!(state, headers);
    let grupo = {
        let mut grupos = state.grupos.write().await;
        let Some(grupo) = grupos.iter_mut().find(|g| g.id == id && g.tem(&session.username)) else {
            return error(StatusCode::NOT_FOUND, "Grupo não encontrado.");
        };
        if body.epoca != grupo.epoca + 1 { return error(StatusCode::CONFLICT, "A chave já foi trocada."); }
        let Some(embrulhos) = embrulhos_para(&grupo.membros, &body.chaves, &session.username) else {
            return error(StatusCode::BAD_REQUEST, "Chave do grupo incompleta.");
        };
        grupo.chaves.insert(body.epoca, embrulhos);
        grupo.epoca = body.epoca;
        grupo.rotacao_pendente = false;
        grupo.clone()
    };
    gravar(&state).await;
    avisar_membros(&state, &grupo);
    Json(grupo.para(&session.username)).into_response()
}

// --------------------------------------------------------------- mensagens

async fn grupo_de(state: &AppState, id: &str, pessoa: &str) -> Option<GrupoPrivado> {
    state.grupos.read().await.iter().find(|g| g.id == id && g.tem(pessoa)).cloned()
}

pub async fn historico(State(state): State<AppState>, headers: HeaderMap, Caminho(id): Caminho<String>) -> Response {
    let session = sessao!(state, headers);
    if grupo_de(&state, &id, &session.username).await.is_none() { return error(StatusCode::NOT_FOUND, "Grupo não encontrado."); }
    let lista: Vec<GrupoMensagem> = state.grupos_mensagens.read().await.iter().filter(|m| m.grupo_id == id).cloned().collect();
    Json(lista).into_response()
}

#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
pub struct MensagemInput {
    epoca: u32, ciphertext: String, nonce: String,
    #[serde(default)] attachments: Vec<String>, #[serde(default)] reply_to: Option<Uuid>,
}

pub async fn enviar(State(state): State<AppState>, headers: HeaderMap, Caminho(id): Caminho<String>, Json(body): Json<MensagemInput>) -> Response {
    let session = sessao!(state, headers);
    let Some(grupo) = grupo_de(&state, &id, &session.username).await else { return error(StatusCode::NOT_FOUND, "Grupo não encontrado."); };
    if grupo.rotacao_pendente || body.epoca != grupo.epoca {
        return error(StatusCode::CONFLICT, "A chave do grupo mudou. Tente de novo.");
    }
    if !valid_b64(&body.ciphertext, 8 * 1024) { return error(StatusCode::BAD_REQUEST, "Envelope invalido."); }
    if !valid_b64(&body.nonce, 32) { return error(StatusCode::BAD_REQUEST, "Nonce invalido."); }
    let anexos: Vec<StoredFile> = {
        let files = state.files.read().await;
        body.attachments.iter().filter_map(|a| files.get(a).cloned())
            .filter(|f| profile_key(&f.owner) == profile_key(&session.username))
            .take(6).collect()
    };
    let citada = match body.reply_to {
        Some(alvo) => state.grupos_mensagens.read().await.iter().any(|m| m.id == alvo && m.grupo_id == id).then_some(alvo),
        None => None,
    };
    let mensagem = GrupoMensagem {
        id: Uuid::new_v4(), grupo_id: id, from: session.username.clone(), epoca: body.epoca,
        ciphertext: body.ciphertext, nonce: body.nonce, created_at: Utc::now(), edited_at: None,
        attachments: anexos, reply_to: citada,
    };
    {
        let mut lista = state.grupos_mensagens.write().await;
        lista.push(mensagem.clone());
        let sobra = lista.len().saturating_sub(MAX_MENSAGENS);
        if sobra > 0 { lista.drain(..sobra); }
    }
    gravar_mensagens(&state).await;
    let _ = state.events.send(Broadcast::to_many(grupo.membros.clone(), ServerEvent::GrupoMensagem { mensagem: mensagem.clone() }));
    (StatusCode::CREATED, Json(mensagem)).into_response()
}

#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
pub struct EditarMensagemInput { epoca: u32, ciphertext: String, nonce: String }

/// Editar e recifrar com a chave atual, venha a mensagem de que epoca vier.
pub async fn editar_mensagem(State(state): State<AppState>, headers: HeaderMap, Caminho((id, mensagem_id)): Caminho<(String, Uuid)>, Json(body): Json<EditarMensagemInput>) -> Response {
    let session = sessao!(state, headers);
    let Some(grupo) = grupo_de(&state, &id, &session.username).await else { return error(StatusCode::NOT_FOUND, "Grupo não encontrado."); };
    if grupo.rotacao_pendente || body.epoca != grupo.epoca {
        return error(StatusCode::CONFLICT, "A chave do grupo mudou. Tente de novo.");
    }
    if !valid_b64(&body.ciphertext, 8 * 1024) || !valid_b64(&body.nonce, 32) { return error(StatusCode::BAD_REQUEST, "Envelope invalido."); }
    let atualizada = {
        let mut lista = state.grupos_mensagens.write().await;
        let Some(m) = lista.iter_mut().find(|m| m.id == mensagem_id && m.grupo_id == id) else {
            return error(StatusCode::NOT_FOUND, "Mensagem nao encontrada.");
        };
        if profile_key(&m.from) != profile_key(&session.username) { return error(StatusCode::FORBIDDEN, "Voce so pode editar suas mensagens."); }
        m.epoca = body.epoca; m.ciphertext = body.ciphertext; m.nonce = body.nonce; m.edited_at = Some(Utc::now());
        m.clone()
    };
    gravar_mensagens(&state).await;
    let _ = state.events.send(Broadcast::to_many(grupo.membros.clone(), ServerEvent::GrupoMensagemEditada { mensagem: atualizada.clone() }));
    Json(atualizada).into_response()
}

pub async fn apagar_mensagem(State(state): State<AppState>, headers: HeaderMap, Caminho((id, mensagem_id)): Caminho<(String, Uuid)>) -> Response {
    let session = sessao!(state, headers);
    let Some(grupo) = grupo_de(&state, &id, &session.username).await else { return error(StatusCode::NOT_FOUND, "Grupo não encontrado."); };
    {
        let mut lista = state.grupos_mensagens.write().await;
        let Some(posicao) = lista.iter().position(|m| m.id == mensagem_id && m.grupo_id == id) else {
            return error(StatusCode::NOT_FOUND, "Mensagem nao encontrada.");
        };
        if profile_key(&lista[posicao].from) != profile_key(&session.username) { return error(StatusCode::FORBIDDEN, "Voce so pode apagar suas mensagens."); }
        lista.remove(posicao);
    }
    gravar_mensagens(&state).await;
    let _ = state.events.send(Broadcast::to_many(grupo.membros.clone(), ServerEvent::GrupoMensagemApagada { grupo_id: id, mensagem_id }));
    StatusCode::NO_CONTENT.into_response()
}

#[cfg(test)]
mod testes {
    use super::*;

    fn chave(de: &str) -> ChaveEmbrulhada {
        ChaveEmbrulhada { de: de.into(), ciphertext: "AAAA".into(), nonce: "BBBB".into() }
    }

    #[test]
    fn embrulhos_cobrem_exatamente_os_membros() {
        let membros = vec!["Ana".to_string(), "bia".to_string()];
        let certo = BTreeMap::from([("ana".to_string(), chave("Ana")), ("Bia".to_string(), chave("ana"))]);
        assert!(embrulhos_para(&membros, &certo, "ana").is_some());
        let faltando = BTreeMap::from([("ana".to_string(), chave("ana"))]);
        assert!(embrulhos_para(&membros, &faltando, "ana").is_none());
        let sobrando = BTreeMap::from([
            ("ana".to_string(), chave("ana")), ("bia".to_string(), chave("ana")), ("caio".to_string(), chave("ana")),
        ]);
        assert!(embrulhos_para(&membros, &sobrando, "ana").is_none());
        // Embrulho feito por outra pessoa nao vale: `de` tem de ser quem pede.
        let de_outro = BTreeMap::from([("ana".to_string(), chave("bia")), ("bia".to_string(), chave("bia"))]);
        assert!(embrulhos_para(&membros, &de_outro, "ana").is_none());
    }

    #[test]
    fn cada_um_ve_so_o_proprio_embrulho() {
        let grupo = GrupoPrivado {
            id: "g".into(), nome: None, icon_file: None, dono: "ana".into(),
            membros: vec!["ana".into(), "bia".into()], created_at: Utc::now(), epoca: 1, rotacao_pendente: false,
            chaves: BTreeMap::from([(1, BTreeMap::from([
                ("ana".to_string(), ChaveEmbrulhada { de: "ana".into(), ciphertext: "PARA_ANA".into(), nonce: "n".into() }),
                ("bia".to_string(), ChaveEmbrulhada { de: "ana".into(), ciphertext: "PARA_BIA".into(), nonce: "n".into() }),
            ]))]),
        };
        let visto = grupo.para("Bia");
        assert_eq!(visto.chaves.len(), 1);
        assert_eq!(visto.chaves[&1].ciphertext, "PARA_BIA");
    }
}
