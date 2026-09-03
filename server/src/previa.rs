//! Cartão de prévia de link: YouTube e Twitter, buscados pelo servidor.
//!
//! O aplicativo embutia o player do YouTube num `iframe`. Isso trazia dois
//! problemas que só apareceram com uso real:
//!
//! - o YouTube recusa tocar quando não reconhece quem embute, e a janela do
//!   aplicativo se apresenta como `tauri.localhost`. O resultado era o "Erro de
//!   configuração do player — Erro 153" no lugar do vídeo;
//! - o Twitter nunca funcionou: a página dele não aceita ser embutida, e é por
//!   isso que existem espelhos como o vxtwitter.
//!
//! Um cartão resolve os dois de uma vez e não depende do que cada site acha do
//! nosso domínio: o servidor busca os dados, o cliente desenha, e clicar abre no
//! navegador. De quebra, sai um `iframe` de terceiro de dentro do aplicativo.
//!
//! Nenhuma chave de API é necessária. O YouTube publica um endereço de oEmbed
//! aberto, e o vxtwitter devolve JSON sem login — é justamente para isso que ele
//! existe.
//!
//! **A mídia não é servida do site de origem.** O endereço dela volta assinado
//! por HMAC dentro de um endereço nosso, igual ao que a busca de GIF já faz:
//! assim a política de conteúdo da janela continua fechada na própria origem, e
//! quem lê a conversa não avisa o YouTube nem o Twitter de que a leu.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::gifs::{assinar, constante, empacotar, url_escape};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

/// Teto do que este servidor aceita baixar de miniatura. Capa de vídeo e foto de
/// tuíte não chegam perto; o limite existe para o caso de vir outra coisa.
const MAX_BYTES: usize = 8 * 1024 * 1024;
const TEMPO_LIMITE: Duration = Duration::from_secs(8);
/// Como este servidor se apresenta ao buscar a prévia.
///
/// O `reqwest` não manda `User-Agent` nenhum por padrão, e o espelho do Twitter
/// devolve **403** para quem não se identifica — medido. Um nome honesto é o
/// suficiente: não vale fingir ser navegador, e quem opera aquele serviço tem
/// direito de saber quem está batendo na porta dele.
const QUEM_SOMOS: &str = "naoconcordo/1.0 (+https://github.com/roxopls/naoconcordo)";

/// Um cliente HTTP com o tempo limite e a identificação já postos.
fn cliente() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(TEMPO_LIMITE)
        .user_agent(QUEM_SOMOS)
        .build()
        .map_err(|erro| erro.to_string())
}

/// Os únicos servidores de onde este proxy busca mídia.
///
/// Vale mesmo com a assinatura conferida: a assinatura garante que o endereço
/// saiu daqui, e esta lista garante que nem um defeito neste arquivo transforma
/// a rota em porta para a rede interna.
const DOMINIOS_DE_MIDIA: [&str; 4] = ["ytimg.com", "youtube.com", "twimg.com", "vxtwitter.com"];

/// De onde o cartão veio. O cliente usa para escolher o desenho.
#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Fonte {
    Youtube,
    Twitter,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cartao {
    pub fonte: Fonte,
    /// Título do vídeo, ou o nome de quem escreveu o tuíte.
    pub titulo: String,
    /// Canal do vídeo, ou o `@` de quem escreveu.
    pub autor: String,
    /// O texto do tuíte. Vazio no YouTube.
    pub texto: String,
    /// Endereço **deste** servidor para a imagem, quando há uma.
    pub imagem: String,
    /// Idem para o vídeo do tuíte, quando há um.
    pub video: String,
    /// Para onde o clique leva. É o endereço original, não o do espelho.
    pub link: String,
}

// ------------------------------------------------------- o que o YouTube dá
#[derive(Deserialize)]
struct OEmbed {
    #[serde(default)]
    title: String,
    #[serde(default)]
    author_name: String,
    #[serde(default)]
    thumbnail_url: String,
}

// ------------------------------------------------------ o que o vxtwitter dá
#[derive(Deserialize)]
struct TuiteBruto {
    #[serde(default)]
    text: String,
    #[serde(default)]
    user_name: String,
    #[serde(default)]
    user_screen_name: String,
    #[serde(default)]
    media_extended: Vec<MidiaBruta>,
}

#[derive(Deserialize)]
struct MidiaBruta {
    #[serde(default, rename = "type")]
    tipo: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    thumbnail_url: String,
}

/// Reconhece o link e diz de onde buscar.
///
/// Devolve `None` para tudo o que não for um vídeo do YouTube ou um tuíte —
/// inclusive para link de canal, de playlist e de perfil, que não têm cartão a
/// mostrar. Quem chama trata `None` como "este link não tem prévia", sem erro.
pub fn reconhecer(url: &str) -> Option<(Fonte, String)> {
    let endereco = url::simples(url)?;
    let host = endereco.0.trim_start_matches("www.").to_string();
    let caminho: Vec<&str> = endereco.1.split('/').filter(|p| !p.is_empty()).collect();

    // ------------------------------------------------------------ YouTube
    if host == "youtu.be" {
        let id = caminho.first().copied().unwrap_or("");
        return id_de_video(id).map(|id| (Fonte::Youtube, id));
    }
    if host == "youtube.com" || host == "m.youtube.com" || host == "youtube-nocookie.com" {
        // `/shorts/<id>` e `/watch?v=<id>` são as duas formas de link de vídeo.
        if caminho.first() == Some(&"shorts") {
            return id_de_video(caminho.get(1).copied().unwrap_or("")).map(|id| (Fonte::Youtube, id));
        }
        let v = endereco.2.iter().find(|(c, _)| c == "v").map(|(_, valor)| valor.as_str()).unwrap_or("");
        return id_de_video(v).map(|id| (Fonte::Youtube, id));
    }

    // ------------------------------------------------------------ Twitter
    // Os espelhos entram junto: quem cola `vxtwitter.com/...` quer o mesmo
    // cartão de quem cola `x.com/...`.
    let do_twitter = matches!(
        host.as_str(),
        "twitter.com" | "x.com" | "vxtwitter.com" | "fxtwitter.com" | "fixupx.com" | "fixvx.com"
    );
    if do_twitter && caminho.len() >= 3 && caminho[1] == "status" {
        let usuario = caminho[0];
        let id: String = caminho[2].chars().take_while(|c| c.is_ascii_digit()).collect();
        if !id.is_empty() && usuario.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Some((Fonte::Twitter, format!("{usuario}/{id}")));
        }
    }
    None
}

/// O identificador de um vídeo do YouTube tem exatamente 11 caracteres.
fn id_de_video(bruto: &str) -> Option<String> {
    let id: String = bruto.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    (id.chars().count() == 11).then_some(id)
}

/// Um analisador de endereço enxuto, só com o que este arquivo precisa.
///
/// Traz `host`, caminho e parâmetros sem puxar uma biblioteca inteira para
/// dentro do servidor por causa de duas rotas.
mod url {
    /// `(host, caminho, [(chave, valor)])`, ou `None` se não for `https`.
    pub fn simples(bruto: &str) -> Option<(String, String, Vec<(String, String)>)> {
        let resto = bruto.strip_prefix("https://").or_else(|| bruto.strip_prefix("http://"))?;
        let (autoridade, resto) = match resto.find(['/', '?', '#']) {
            Some(i) => (&resto[..i], &resto[i..]),
            None => (resto, ""),
        };
        // Credencial embutida e porta não interessam, e aceitar as duas abriria
        // caminho para `youtube.com@interno` passar por `youtube.com`.
        if autoridade.is_empty() || autoridade.contains('@') || autoridade.contains(':') {
            return None;
        }
        let sem_ancora = resto.split('#').next().unwrap_or("");
        let (caminho, consulta) = match sem_ancora.split_once('?') {
            Some((c, q)) => (c, q),
            None => (sem_ancora, ""),
        };
        let params = consulta
            .split('&')
            .filter(|p| !p.is_empty())
            .map(|p| match p.split_once('=') {
                Some((c, v)) => (c.to_string(), descodificar(v)),
                None => (p.to_string(), String::new()),
            })
            .collect();
        Some((autoridade.to_ascii_lowercase(), caminho.to_string(), params))
    }

    /// Desfaz `%XX` e `+`. O suficiente para ler o `v=` de um endereço.
    fn descodificar(bruto: &str) -> String {
        let bytes = bruto.replace('+', " ");
        let bytes = bytes.as_bytes();
        let mut saida = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' && i + 2 < bytes.len() {
                if let Ok(byte) = u8::from_str_radix(&String::from_utf8_lossy(&bytes[i + 1..i + 3]), 16) {
                    saida.push(byte);
                    i += 3;
                    continue;
                }
            }
            saida.push(bytes[i]);
            i += 1;
        }
        String::from_utf8_lossy(&saida).into_owned()
    }
}

/// Monta o cartão, buscando no site de origem.
pub async fn montar(chave: &[u8; 32], fonte: Fonte, alvo: &str) -> Result<Cartao, String> {
    let cliente = cliente()?;

    match fonte {
        Fonte::Youtube => {
            let link = format!("https://www.youtube.com/watch?v={alvo}");
            let pedido = format!(
                "https://www.youtube.com/oembed?url={}&format=json",
                url_escape(&link)
            );
            let resposta = cliente.get(&pedido).send().await.map_err(|_| "O YouTube nao respondeu.".to_string())?;
            if !resposta.status().is_success() {
                return Err("Video indisponivel.".into());
            }
            let dados: OEmbed = resposta.json().await.map_err(|_| "Resposta do YouTube ilegivel.".to_string())?;
            Ok(Cartao {
                fonte,
                titulo: dados.title,
                autor: dados.author_name,
                texto: String::new(),
                imagem: caminho_de_midia(chave, &dados.thumbnail_url),
                video: String::new(),
                link,
            })
        }
        Fonte::Twitter => {
            let (usuario, id) = alvo.split_once('/').ok_or("alvo invalido")?;
            let pedido = format!("https://api.vxtwitter.com/{usuario}/status/{id}");
            let resposta = cliente.get(&pedido).send().await.map_err(|_| "O espelho do Twitter nao respondeu.".to_string())?;
            if !resposta.status().is_success() {
                return Err("Tuite indisponivel.".into());
            }
            let dados: TuiteBruto = resposta.json().await.map_err(|_| "Resposta do espelho ilegivel.".to_string())?;
            // A primeira mídia é a que o cartão mostra: um tuíte com quatro fotos
            // vira um cartão com uma foto e o texto, não uma galeria.
            let primeira = dados.media_extended.first();
            let (imagem, video) = match primeira {
                Some(m) if m.tipo == "video" || m.tipo == "gif" => (
                    caminho_de_midia(chave, &m.thumbnail_url),
                    caminho_de_midia(chave, &m.url),
                ),
                Some(m) => (caminho_de_midia(chave, &m.url), String::new()),
                None => (String::new(), String::new()),
            };
            Ok(Cartao {
                fonte,
                titulo: dados.user_name,
                autor: if dados.user_screen_name.is_empty() {
                    String::new()
                } else {
                    format!("@{}", dados.user_screen_name)
                },
                texto: dados.text.chars().take(600).collect(),
                imagem,
                video,
                // O link leva ao original, não ao espelho: o espelho existe para
                // a prévia, e quem clica quer a página de verdade.
                link: format!("https://x.com/{usuario}/status/{id}"),
            })
        }
    }
}

/// Endereço **deste** servidor para uma mídia de fora. Vazio se não der.
fn caminho_de_midia(chave: &[u8; 32], url: &str) -> String {
    if url.is_empty() || !hospedeiro_de_midia(url) {
        return String::new();
    }
    format!("/api/previa/midia?f={}", empacotar(chave, url))
}

/// Abre a credencial de mídia, conferindo assinatura e servidor.
pub fn abrir_midia(chave: &[u8; 32], ficha: &str) -> Option<String> {
    let (bruto, assinatura) = ficha.split_once('.')?;
    let url = String::from_utf8(URL_SAFE_NO_PAD.decode(bruto).ok()?).ok()?;
    if !constante(assinatura.as_bytes(), assinar(chave, &url).as_bytes()) {
        return None;
    }
    hospedeiro_de_midia(&url).then_some(url)
}

fn hospedeiro_de_midia(url: &str) -> bool {
    let Some(resto) = url.strip_prefix("https://") else { return false };
    let host = resto.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() || host.contains('@') || host.contains(':') {
        return false;
    }
    DOMINIOS_DE_MIDIA
        .iter()
        // O ponto antes do domínio separa `i.ytimg.com` de `ytimg.com.invasor.com`.
        .any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

/// Baixa a mídia para repassar ao cliente.
pub async fn baixar(url: &str) -> Result<(Vec<u8>, String), String> {
    let cliente = cliente()?;
    let resposta = cliente.get(url).send().await.map_err(|_| "nao respondeu".to_string())?;
    if !resposta.status().is_success() {
        return Err("indisponivel".into());
    }
    let tipo = resposta
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .split(';')
        .next()
        .unwrap_or("image/jpeg")
        .trim()
        .to_string();
    if let Some(anunciado) = resposta.content_length() {
        if anunciado > MAX_BYTES as u64 {
            return Err("grande demais".into());
        }
    }
    let bytes = resposta.bytes().await.map_err(|_| "download falhou".to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("grande demais".into());
    }
    Ok((bytes.to_vec(), tipo))
}

#[cfg(test)]
mod testes {
    use super::*;

    const CHAVE: [u8; 32] = [3; 32];

    /// Reconhecer o link é o que decide se aparece cartão. Errar para mais faria
    /// o servidor buscar dados de link que não são vídeo nem tuíte.
    #[test]
    fn reconhece_video_e_tuite() {
        let casos: [(&str, Option<(Fonte, &str)>); 10] = [
            ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", Some((Fonte::Youtube, "dQw4w9WgXcQ"))),
            ("https://youtu.be/dQw4w9WgXcQ?si=abc", Some((Fonte::Youtube, "dQw4w9WgXcQ"))),
            ("https://www.youtube.com/shorts/dQw4w9WgXcQ", Some((Fonte::Youtube, "dQw4w9WgXcQ"))),
            ("https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=30s", Some((Fonte::Youtube, "dQw4w9WgXcQ"))),
            // Canal e playlist nao sao video: nao ha cartao a montar.
            ("https://www.youtube.com/@alguem", None),
            ("https://www.youtube.com/playlist?list=PL123", None),
            ("https://x.com/fulano/status/1234567890", Some((Fonte::Twitter, "fulano/1234567890"))),
            ("https://vxtwitter.com/fulano/status/1234567890", Some((Fonte::Twitter, "fulano/1234567890"))),
            // Perfil sem tuite nenhum.
            ("https://x.com/fulano", None),
            ("https://exemplo.com/qualquer", None),
        ];
        for (entrada, esperado) in casos {
            let obtido = reconhecer(entrada);
            match (obtido, esperado) {
                (Some((f, a)), Some((ef, ea))) => {
                    assert!(f == ef && a == ea, "{entrada} deu {a}");
                }
                (None, None) => {}
                (obtido, _) => panic!("{entrada} deu {:?}", obtido.map(|(_, a)| a)),
            }
        }
    }

    /// Endereço embutido com credencial não pode passar por domínio conhecido.
    #[test]
    fn endereco_disfarcado_nao_passa() {
        assert!(reconhecer("https://youtube.com@interno/watch?v=dQw4w9WgXcQ").is_none());
        assert!(reconhecer("https://youtube.com:8080/watch?v=dQw4w9WgXcQ").is_none());
        assert!(reconhecer("https://naoyoutube.com/watch?v=dQw4w9WgXcQ").is_none());
    }

    /// A mídia só volta com a assinatura deste servidor, e só de domínio da
    /// lista. Sem isso a rota viraria buscador de qualquer URL da internet.
    #[test]
    fn midia_so_com_assinatura_e_dominio_certo() {
        let boa = "https://i.ytimg.com/vi/abc/hqdefault.jpg";
        let ficha = empacotar(&CHAVE, boa);
        assert_eq!(abrir_midia(&CHAVE, &ficha).as_deref(), Some(boa));

        // Assinada com outra chave.
        assert_eq!(abrir_midia(&CHAVE, &empacotar(&[9; 32], boa)), None);
        // Assinada por nós, mas para um domínio de fora da lista.
        let interno = "https://127.0.0.1/segredo";
        assert_eq!(abrir_midia(&CHAVE, &empacotar(&CHAVE, interno)), None);
        // Sufixo colado, sem o ponto que separa.
        let falso = "https://ytimg.com.invasor.com/x.jpg";
        assert_eq!(abrir_midia(&CHAVE, &empacotar(&CHAVE, falso)), None);
        assert_eq!(abrir_midia(&CHAVE, "sem-ponto"), None);
    }

    /// Domínio fora da lista não vira endereço nosso: fica vazio, e o cartão sai
    /// sem imagem em vez de apontar para um lugar que o proxy vai recusar.
    #[test]
    fn midia_de_fora_nao_entra_no_cartao() {
        assert_eq!(caminho_de_midia(&CHAVE, "https://exemplo.com/foto.jpg"), "");
        assert!(caminho_de_midia(&CHAVE, "https://pbs.twimg.com/media/x.jpg").starts_with("/api/previa/midia?f="));
    }
}
