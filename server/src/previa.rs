//! Cartão de prévia de link, buscado pelo servidor.
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
//! # De onde sai cada cartão
//!
//! - **YouTube**: oEmbed oficial.
//! - **Twitter/X**: `api.vxtwitter.com`, que devolve texto, foto e o `.mp4` do
//!   vídeo — coisas que a página original não entrega a quem não faz login.
//! - **Instagram** e **TikTok**: espelhos que publicam as marcas `og:` do post
//!   (`kkinstagram` e `tnktok`), pelo mesmo motivo. O TikTok ainda tem um oEmbed
//!   oficial, que fica como reserva quando o espelho falha: ele dá título,
//!   autor e capa, mas não o vídeo.
//! - **Qualquer outro endereço**: as marcas `og:` da própria página.
//!
//! # O preço do caso geral, e o que foi feito com ele
//!
//! Ler `og:` de qualquer página significa que **o servidor busca um endereço
//! escolhido por quem escreveu a mensagem**. Sem cuidado isso é um pedido de
//! SSRF: `http://10.0.0.1/…` mandaria este servidor bater na rede interna e
//! contar o que viu. Por isso toda busca passa por `seguro::buscar`, que só fala
//! `https`, resolve o nome antes de conectar, recusa endereço que caia em rede
//! privada, de loopback, de link local ou de documentação, refaz essa conferência
//! **a cada redirecionamento** e prende a conexão ao IP já conferido — assim não
//! sobra janela entre a checagem e o `connect` para o nome trocar de resposta.
//!
//! **A mídia não é servida do site de origem.** O endereço dela volta assinado
//! por HMAC dentro de um endereço nosso, igual ao que a busca de GIF já faz:
//! assim a política de conteúdo da janela continua fechada na própria origem, e
//! quem lê a conversa não avisa o YouTube nem o Twitter de que a leu.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::gifs::{assinar, constante, empacotar, url_escape};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

/// Teto do que este servidor aceita repassar de mídia.
///
/// Capa de vídeo não chega perto; o que puxa o limite para cá é o `.mp4` de um
/// tuíte ou de um TikTok, que o cartão toca quando a pessoa aperta o play. Mais
/// que isto vira gasto de memória por um vídeo que ninguém pediu para ver
/// inteiro — o cartão existe para dar uma olhada, não para virar cinema.
const MAX_BYTES: usize = 32 * 1024 * 1024;
/// Teto da página lida em busca das marcas `og:`. Elas moram no `<head>`, então
/// o começo basta; o resto é o corpo do site, que não interessa.
const MAX_HTML: usize = 512 * 1024;
const TEMPO_LIMITE: Duration = Duration::from_secs(8);
/// Como este servidor se apresenta ao buscar a prévia.
///
/// O `reqwest` não manda `User-Agent` nenhum por padrão, e o espelho do Twitter
/// devolve **403** para quem não se identifica — medido. Um nome honesto é o
/// suficiente: não vale fingir ser navegador, e quem opera aquele serviço tem
/// direito de saber quem está batendo na porta dele.
const QUEM_SOMOS: &str = "naoconcordo/1.0 (+https://github.com/roxopls/naoconcordo)";

/// De onde o cartão veio. O cliente usa para escolher o desenho.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Fonte {
    Youtube,
    Twitter,
    Instagram,
    Tiktok,
    /// Qualquer outra página, lida pelas marcas `og:`.
    Site,
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
    /// Idem para o vídeo, quando há um. O cartão ganha botão de play.
    pub video: String,
    /// O domínio, escrito como a pessoa reconheceria. Só nos cartões de site:
    /// nos outros o desenho já diz de onde veio.
    pub site: String,
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
/// Os sites com rota própria vêm primeiro, porque para eles existe fonte melhor
/// que a página: o YouTube esconde o título atrás de JavaScript, e Twitter,
/// Instagram e TikTok entregam meia página a quem não fez login. O que sobra cai
/// em [`Fonte::Site`], que lê as marcas `og:` de onde quer que o link aponte.
///
/// Devolve `None` só para o que não é endereço de página: não-`https`, endereço
/// malformado, e arquivo de mídia solto — este último porque o cliente já toca
/// `.mp4` e `.jpg` direto, sem precisar de cartão.
pub fn reconhecer(url: &str) -> Option<(Fonte, String)> {
    let endereco = url::simples(url)?;
    let host = endereco.0.trim_start_matches("www.").to_string();
    let caminho: Vec<&str> = endereco.1.split('/').filter(|p| !p.is_empty()).collect();

    // ------------------------------------------------------------ YouTube
    //
    // Sem `return` no caminho que falha: link de canal ou de playlist não tem
    // vídeo a pedir ao oEmbed, mas tem `og:` na página como qualquer site.
    if host == "youtu.be" {
        if let Some(id) = id_de_video(caminho.first().copied().unwrap_or("")) {
            return Some((Fonte::Youtube, id));
        }
    }
    if host == "youtube.com" || host == "m.youtube.com" || host == "youtube-nocookie.com" {
        // `/shorts/<id>` e `/watch?v=<id>` são as duas formas de link de vídeo.
        let bruto = if caminho.first() == Some(&"shorts") {
            caminho.get(1).copied().unwrap_or("")
        } else {
            endereco.2.iter().find(|(c, _)| c == "v").map(|(_, valor)| valor.as_str()).unwrap_or("")
        };
        if let Some(id) = id_de_video(bruto) {
            return Some((Fonte::Youtube, id));
        }
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

    // ---------------------------------------------------------- Instagram
    // `/p/`, `/reel/` e `/tv/` são as três formas de link de post. Perfil não
    // entra: o espelho devolve a página de perfil sem mídia nenhuma.
    let do_instagram = matches!(host.as_str(), "instagram.com" | "kkinstagram.com" | "ddinstagram.com");
    if do_instagram && matches!(caminho.first().copied(), Some("p" | "reel" | "reels" | "tv")) {
        if let Some(id) = caminho.get(1).filter(|id| codigo_simples(id)) {
            // `reels` no plural é o que o aplicativo do celular compartilha; o
            // espelho só entende `reel`.
            let tipo = if caminho[0] == "reels" { "reel" } else { caminho[0] };
            return Some((Fonte::Instagram, format!("{tipo}/{id}")));
        }
    }

    // ------------------------------------------------------------- TikTok
    // Duas formas: o link comprido `/@alguem/video/<id>` e o curto do botão de
    // compartilhar, `vm.tiktok.com/<código>`, que só o espelho sabe abrir.
    if matches!(host.as_str(), "tiktok.com" | "m.tiktok.com") && caminho.len() >= 3 && caminho[1] == "video" {
        let usuario = caminho[0];
        let apelido_ok = usuario.starts_with('@')
            && codigo_simples(usuario[1..].trim_end_matches('.'))
            && usuario[1..].chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.');
        if apelido_ok && caminho[2].chars().all(|c| c.is_ascii_digit()) && !caminho[2].is_empty() {
            return Some((Fonte::Tiktok, format!("{usuario}/video/{}", caminho[2])));
        }
    }
    if matches!(host.as_str(), "vm.tiktok.com" | "vt.tiktok.com") {
        if let Some(codigo) = caminho.first().filter(|c| codigo_simples(c)) {
            return Some((Fonte::Tiktok, (*codigo).to_string()));
        }
    }

    // -------------------------------------------------------- qualquer site
    // Arquivo de mídia fica de fora: o cliente já toca `.mp4` e desenha `.jpg`
    // sem ajuda nenhuma, e buscar a página seria trabalho para nada.
    if arquivo_de_midia(&endereco.1) {
        return None;
    }
    Some((Fonte::Site, url.to_string()))
}

/// Código de post: letras, números e os dois sinais que o Instagram e o TikTok
/// usam. Serve para não montar endereço com o que veio na mensagem.
fn codigo_simples(bruto: &str) -> bool {
    !bruto.is_empty()
        && bruto.len() <= 40
        && bruto.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// O caminho termina em arquivo que o próprio cliente abre?
fn arquivo_de_midia(caminho: &str) -> bool {
    let fim = caminho.rsplit('/').next().unwrap_or("").to_ascii_lowercase();
    [
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".mp4", ".webm", ".mov", ".mp3", ".ogg",
        ".wav", ".m4a",
    ]
    .iter()
    .any(|ext| fim.ends_with(ext))
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
    match fonte {
        Fonte::Youtube => {
            let link = format!("https://www.youtube.com/watch?v={alvo}");
            let pedido = format!(
                "https://www.youtube.com/oembed?url={}&format=json",
                url_escape(&link)
            );
            let dados: OEmbed = json(&pedido).await.map_err(|_| "Video indisponivel.".to_string())?;
            Ok(Cartao {
                fonte,
                titulo: dados.title,
                autor: dados.author_name,
                texto: String::new(),
                imagem: caminho_de_midia(chave, &dados.thumbnail_url),
                video: String::new(),
                site: String::new(),
                link,
            })
        }
        Fonte::Instagram => {
            // O espelho responde no mesmo caminho do original: trocar o nome do
            // servidor é tudo o que separa a página que esconde os dados da que
            // os publica.
            //
            // São dois porque eles caem. Vivem de fazer o que o Instagram não
            // quer, então um some, outro aparece com outro nome, e o que estava
            // de pé semana passada devolve uma página de propaganda hoje. Tentar
            // em ordem é o que faz o cartão sobreviver a isso sem nova versão do
            // aplicativo; quando nenhum responde, o link fica como texto, que é
            // exatamente o que ele era antes desta rota existir.
            let mut ultimo = "nenhum espelho respondeu".to_string();
            for espelho in ["www.kkinstagram.com", "instafix.io"] {
                match com_midia(og(chave, fonte, &format!("https://{espelho}/{alvo}/")).await) {
                    Ok(mut cartao) => {
                        cartao.link = format!("https://www.instagram.com/{alvo}/");
                        return Ok(cartao);
                    }
                    Err(motivo) => ultimo = format!("{espelho}: {motivo}"),
                }
            }
            Err(ultimo)
        }
        Fonte::Tiktok => {
            let (espelho, link) = if alvo.contains('/') {
                (format!("https://www.tnktok.com/{alvo}"), format!("https://www.tiktok.com/{alvo}"))
            } else {
                // Link curto do botão de compartilhar: só o espelho sabe para
                // onde ele aponta, e o `link` segue curto porque abrir o curto no
                // navegador leva ao mesmo lugar.
                (format!("https://vm.tnktok.com/{alvo}"), format!("https://vm.tiktok.com/{alvo}"))
            };
            let mut cartao = match com_midia(og(chave, fonte, &espelho).await) {
                Ok(cartao) => cartao,
                // O oEmbed oficial é a reserva: dá título, autor e capa, e nunca
                // o vídeo. Melhor um cartão sem play do que link cru na conversa.
                Err(motivo) => {
                    let pedido = format!("https://www.tiktok.com/oembed?url={}", url_escape(&link));
                    let dados: OEmbed = json(&pedido).await.map_err(|_| motivo)?;
                    Cartao {
                        fonte,
                        titulo: dados.title,
                        autor: dados.author_name,
                        texto: String::new(),
                        imagem: caminho_de_midia(chave, &dados.thumbnail_url),
                        video: String::new(),
                        site: String::new(),
                        link: link.clone(),
                    }
                }
            };
            cartao.link = link;
            Ok(cartao)
        }
        Fonte::Site => og(chave, fonte, alvo).await,
        Fonte::Twitter => {
            let (usuario, id) = alvo.split_once('/').ok_or("alvo invalido")?;
            let pedido = format!("https://api.vxtwitter.com/{usuario}/status/{id}");
            let dados: TuiteBruto = json(&pedido).await.map_err(|_| "Tuite indisponivel.".to_string())?;
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
                site: String::new(),
                // O link leva ao original, não ao espelho: o espelho existe para
                // a prévia, e quem clica quer a página de verdade.
                link: format!("https://x.com/{usuario}/status/{id}"),
            })
        }
    }
}

/// Recusa o cartão de espelho que voltou sem foto nem vídeo.
///
/// Post apagado, privado ou com o endereço errado faz o espelho devolver a
/// página de entrada dele, que tem `og:title` — e nada mais. Sem esta peneira o
/// cartão sairia anunciando "Instagram" ou "TikTok - Make Your Day" no lugar do
/// que a pessoa colou, que é pior do que não ter cartão.
fn com_midia(resultado: Result<Cartao, String>) -> Result<Cartao, String> {
    let cartao = resultado?;
    if cartao.imagem.is_empty() && cartao.video.is_empty() {
        return Err("espelho sem midia".into());
    }
    Ok(cartao)
}

/// Busca JSON de um serviço, pela mesma porta guardada das páginas.
async fn json<T: serde::de::DeserializeOwned>(url: &str) -> Result<T, String> {
    let (bytes, _) = seguro::buscar(url, MAX_HTML, false).await?;
    serde_json::from_slice(&bytes).map_err(|_| "resposta ilegivel".to_string())
}

/// Cartão montado com as marcas `og:` de uma página.
///
/// `og:` é o único acordo que os sites de fato cumprem: quem quer aparecer bem
/// quando alguém cola o link — ou seja, todo mundo — publica título, resumo e
/// imagem ali. Ler isso dá cartão para notícia, loja, repositório e o que mais
/// vier, sem uma rota por site.
///
/// Erro quando não há título nem imagem: aí não é cartão, é link com moldura, e
/// quem chama transforma esse erro em "sem prévia".
async fn og(chave: &[u8; 32], fonte: Fonte, pagina: &str) -> Result<Cartao, String> {
    let (bytes, tipo) = seguro::buscar(pagina, MAX_HTML, true).await?;
    if !tipo.starts_with("text/html") && !tipo.starts_with("application/xhtml") {
        return Err("nao e pagina".into());
    }
    // `from_utf8_lossy`: página em Latin-1 estraga um acento e segue viva, o que
    // é melhor do que recusar o cartão inteiro por causa de um byte.
    let html = String::from_utf8_lossy(&bytes);
    let marcas = marcas_de(&html);
    // Página sem marca `og:` nem `twitter:` nenhuma não está se anunciando: ou é
    // simples demais para ter cartão, ou é a tela de "prove que não é um robô"
    // que sites como o Reddit servem a quem não é navegador. Nos dois casos o que
    // sairia dali é o `<title>` cru — "Reddit" —, que não diz nada de útil sobre
    // o link que a pessoa colou.
    if !marcas.keys().any(|chave| chave.starts_with("og:") || chave.starts_with("twitter:")) {
        return Err("pagina sem marcas de previa".into());
    }
    let pegar = |chaves: &[&str]| -> String {
        chaves.iter().find_map(|c| marcas.get(*c).cloned()).unwrap_or_default()
    };

    let titulo = pegar(&["og:title", "twitter:title", "title"]);
    let imagem = pegar(&["og:image", "og:image:url", "twitter:image", "twitter:image:src"]);
    // `og:video` às vezes aponta para um player em HTML, não para o arquivo.
    // `og:video:url` com `og:video:type` de vídeo é o que dá play de verdade.
    let video = pegar(&["og:video:secure_url", "og:video:url", "og:video"]);
    let video = if pegar(&["og:video:type"]).starts_with("text/") { String::new() } else { video };
    if titulo.is_empty() && imagem.is_empty() {
        return Err("sem marcas og".into());
    }
    Ok(Cartao {
        fonte,
        titulo,
        autor: String::new(),
        texto: pegar(&["og:description", "twitter:description", "description"]).chars().take(600).collect(),
        imagem: caminho_de_midia(chave, &imagem),
        video: caminho_de_midia(chave, &video),
        site: match fonte {
            Fonte::Site => pegar(&["og:site_name"]),
            // Nos outros o desenho do cartão já diz de onde veio, e o espelho
            // se anuncia com o nome dele, que não é o do site que a pessoa colou.
            _ => String::new(),
        },
        link: pegar(&["og:url"]),
    })
}

/// As marcas `<meta>` da página, por `property` ou `name`, mais o `<title>`.
///
/// Um analisador de HTML inteiro seria uma dependência grande para ler seis
/// campos que vivem no começo do `<head>`. Isto percorre as marcas `<meta>` uma
/// vez e para aí: atributo mal formado vira marca ausente, e marca ausente já é
/// caso normal.
fn marcas_de(html: &str) -> std::collections::HashMap<String, String> {
    let baixo = html.to_ascii_lowercase();
    let mut saida = std::collections::HashMap::new();

    for (inicio, _) in baixo.match_indices("<meta") {
        let fim = baixo[inicio..].find('>').map(|i| inicio + i).unwrap_or(baixo.len());
        let (tag, tag_baixo) = (&html[inicio..fim], &baixo[inicio..fim]);
        let Some(nome) = atributo(tag, tag_baixo, "property").or_else(|| atributo(tag, tag_baixo, "name")) else {
            continue;
        };
        let Some(valor) = atributo(tag, tag_baixo, "content") else { continue };
        if valor.is_empty() {
            continue;
        }
        // A primeira vence: página com `og:image` repetido anuncia a principal
        // primeiro, e a última costuma ser o ícone do rodapé.
        saida.entry(nome.to_ascii_lowercase()).or_insert_with(|| decodificar_entidades(&valor));
    }

    if let Some(inicio) = baixo.find("<title") {
        if let Some(abre) = baixo[inicio..].find('>').map(|i| inicio + i + 1) {
            if let Some(fecha) = baixo[abre..].find("</title>").map(|i| abre + i) {
                let texto = decodificar_entidades(html[abre..fecha].trim());
                if !texto.is_empty() {
                    saida.entry("title".into()).or_insert(texto);
                }
            }
        }
    }
    saida
}

/// O valor de um atributo entre aspas, ou `None`.
fn atributo(tag: &str, tag_baixo: &str, nome: &str) -> Option<String> {
    let mut procura = 0;
    loop {
        let achado = procura + tag_baixo[procura..].find(nome)?;
        let antes = tag_baixo[..achado].chars().next_back().unwrap_or(' ');
        let resto = tag_baixo[achado + nome.len()..].trim_start();
        // O nome tem de estar solto e seguido de `=`: senão `name` casaria
        // dentro de `itemprop-name`, e `content` dentro de `data-content-id`.
        if !antes.is_whitespace() || !resto.starts_with('=') {
            procura = achado + nome.len();
            continue;
        }
        let depois = achado + nome.len() + (tag_baixo[achado + nome.len()..].len() - resto.len()) + 1;
        let valor = tag[depois..].trim_start();
        let aspas = valor.chars().next()?;
        if aspas != '"' && aspas != '\'' {
            return None;
        }
        let fim = valor[1..].find(aspas)? + 1;
        return Some(valor[1..fim].to_string());
    }
}

/// Desfaz as cinco entidades que aparecem em título e resumo de verdade.
fn decodificar_entidades(bruto: &str) -> String {
    bruto
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        // `&amp;` por último: antes dele, `&amp;quot;` viraria aspas.
        .replace("&amp;", "&")
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

/// O endereço tem forma de mídia buscável?
///
/// Só a forma. **Quem decide de fato é [`seguro::buscar`]**, que resolve o nome
/// e recusa o que cair em rede interna — a lista fixa de domínios que morava
/// aqui não sobreviveu ao cartão de qualquer site, onde a imagem vem do CDN que
/// aquele site escolheu.
fn hospedeiro_de_midia(url: &str) -> bool {
    let Some(resto) = url.strip_prefix("https://") else { return false };
    let host = resto.split(['/', '?', '#']).next().unwrap_or("");
    // Sem credencial embutida e sem porta, como no resto do arquivo.
    !host.is_empty() && !host.contains('@') && !host.contains(':')
}

/// Baixa a mídia para repassar ao cliente.
///
/// O tipo é conferido: esta rota existe para imagem e vídeo de cartão, e servir
/// o que o site mandar transformaria o servidor em hospedeiro de qualquer coisa
/// que alguém conseguisse assinar.
pub async fn baixar(url: &str) -> Result<(Vec<u8>, String), String> {
    let (bytes, tipo) = seguro::buscar(url, MAX_BYTES, false).await?;
    if !tipo.starts_with("image/") && !tipo.starts_with("video/") {
        return Err("nao e midia".into());
    }
    Ok((bytes, tipo))
}

/// A porta de saída deste arquivo para a internet.
///
/// Tudo o que o servidor busca por causa de um link passa por aqui, porque o
/// endereço veio de quem escreveu a mensagem. As regras, todas medidas contra o
/// mesmo ataque — fazer este servidor bater na rede de dentro e contar o que viu:
///
/// - só `https`, sem porta e sem credencial no endereço;
/// - o nome é resolvido **antes** de conectar, e todo IP tem de ser público;
/// - a conexão é presa ao IP conferido, então não adianta o nome responder uma
///   coisa na conferência e outra no `connect`;
/// - redirecionamento é seguido à mão, no máximo três, refazendo a conferência
///   em cada salto — `Location: http://169.254.169.254/` é o truque clássico;
/// - tempo limite e teto de bytes, com o teto conferido no que chega e não só no
///   `Content-Length`, que o site anuncia e pode mentir.
mod seguro {
    use std::net::{IpAddr, SocketAddr};

    use super::{QUEM_SOMOS, TEMPO_LIMITE};

    /// Busca um endereço e devolve `(bytes, tipo)`.
    ///
    /// `truncar` diz o que fazer com resposta maior que o teto: a página vale
    /// pelo começo, onde moram as marcas `og:`, e uma capa de portal passa
    /// tranquilamente de 512 KB de HTML. Mídia é o contrário — meio arquivo não
    /// serve para nada, e recusar é a resposta certa.
    pub async fn buscar(url: &str, teto: usize, truncar: bool) -> Result<(Vec<u8>, String), String> {
        let mut atual = url.to_string();

        for _ in 0..4 {
            let host = hospedeiro(&atual)?;
            let destino = resolver(&host).await?;
            let cliente = reqwest::Client::builder()
                .timeout(TEMPO_LIMITE)
                .user_agent(QUEM_SOMOS)
                .redirect(reqwest::redirect::Policy::none())
                .resolve(&host, destino)
                .build()
                .map_err(|erro| erro.to_string())?;

            let resposta = cliente.get(&atual).send().await.map_err(|_| "nao respondeu".to_string())?;
            let status = resposta.status();
            if status.is_redirection() {
                let destino = resposta
                    .headers()
                    .get("location")
                    .and_then(|v| v.to_str().ok())
                    .ok_or("redirecionamento sem destino")?;
                atual = absoluto(&atual, destino)?;
                continue;
            }
            if !status.is_success() {
                return Err(format!("respondeu {}", status.as_u16()));
            }

            let tipo = resposta
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/octet-stream")
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if !truncar && resposta.content_length().is_some_and(|anunciado| anunciado > teto as u64) {
                return Err("grande demais".into());
            }
            // Em pedaços, e não `bytes()` de uma vez: assim o teto vale para o
            // que de fato chega, e não para o tamanho que o site anunciou.
            let mut resposta = resposta;
            let mut corpo: Vec<u8> = Vec::new();
            while let Some(pedaco) = resposta.chunk().await.map_err(|_| "download falhou".to_string())? {
                corpo.extend_from_slice(&pedaco);
                if corpo.len() >= teto {
                    if !truncar {
                        return Err("grande demais".into());
                    }
                    corpo.truncate(teto);
                    break;
                }
            }
            return Ok((corpo, tipo));
        }
        Err("redirecionou demais".into())
    }

    /// O nome do servidor de um endereço `https` aceitável.
    fn hospedeiro(url: &str) -> Result<String, String> {
        let resto = url.strip_prefix("https://").ok_or("so https")?;
        let host = resto.split(['/', '?', '#']).next().unwrap_or("");
        if host.is_empty() || host.contains('@') || host.contains(':') {
            return Err("endereco recusado".into());
        }
        Ok(host.to_ascii_lowercase())
    }

    /// Resolve o nome e devolve o endereço a usar, recusando rede interna.
    ///
    /// **Todas** as respostas têm de ser públicas, e não apenas a escolhida: um
    /// nome que responde `1.2.3.4` e `127.0.0.1` está tentando exatamente isto,
    /// e aceitar a primeira boa deixaria o sorteio decidir.
    async fn resolver(host: &str) -> Result<SocketAddr, String> {
        let achados: Vec<SocketAddr> = tokio::net::lookup_host((host, 443))
            .await
            .map_err(|_| "nome nao resolve".to_string())?
            .collect();
        if achados.is_empty() {
            return Err("nome nao resolve".into());
        }
        if !achados.iter().all(|addr| publico(addr.ip())) {
            return Err("endereco interno".into());
        }
        Ok(achados[0])
    }

    /// Junta um `Location` ao endereço de onde ele veio.
    pub fn absoluto(base: &str, destino: &str) -> Result<String, String> {
        if destino.starts_with("https://") {
            return Ok(destino.to_string());
        }
        // `//outro.site/caminho` herda o esquema de quem redirecionou, e quem
        // redirecionou era `https` — é a única forma sem esquema que vale.
        if let Some(resto) = destino.strip_prefix("//") {
            return Ok(format!("https://{resto}"));
        }
        if destino.contains("://") {
            // `http://` no meio do caminho é justamente o salto que não pode.
            return Err("redirecionou para fora do https".into());
        }
        let raiz = base.strip_prefix("https://").unwrap_or(base);
        let host = raiz.split(['/', '?', '#']).next().unwrap_or("");
        if destino.starts_with('/') {
            return Ok(format!("https://{host}{destino}"));
        }
        let caminho = &raiz[host.len()..];
        let pasta = caminho.rsplit_once('/').map(|(antes, _)| antes).unwrap_or("");
        Ok(format!("https://{host}{pasta}/{destino}"))
    }

    /// O IP é da internet, e não de uma rede que só existe aqui dentro?
    ///
    /// Escrito à mão porque `IpAddr::is_global` ainda é instável no Rust estável,
    /// e depender de `nightly` por uma função seria caro demais.
    pub fn publico(ip: IpAddr) -> bool {
        match ip {
            IpAddr::V4(v4) => {
                let [a, b, ..] = v4.octets();
                !(v4.is_private()
                    || v4.is_loopback()
                    || v4.is_link_local()
                    || v4.is_broadcast()
                    || v4.is_documentation()
                    || v4.is_unspecified()
                    || v4.is_multicast()
                    // `0.0.0.0/8`, o `100.64.0.0/10` das operadoras, o
                    // `192.0.0.0/24` da IETF e todo o `240.0.0.0/4` reservado.
                    || a == 0
                    || (a == 100 && (64..128).contains(&b))
                    || (a == 192 && b == 0 && v4.octets()[2] == 0)
                    || a >= 240)
            }
            IpAddr::V6(v6) => {
                // Endereço IPv4 vestido de IPv6 vale pela regra do IPv4: sem isto
                // `::ffff:127.0.0.1` entraria como se fosse da internet.
                if let Some(v4) = v6.to_ipv4_mapped() {
                    return publico(IpAddr::V4(v4));
                }
                let primeiro = v6.segments()[0];
                !(v6.is_loopback()
                    || v6.is_unspecified()
                    || v6.is_multicast()
                    // `fc00::/7` local único e `fe80::/10` de link local.
                    || (primeiro & 0xfe00) == 0xfc00
                    || (primeiro & 0xffc0) == 0xfe80)
            }
        }
    }
}

#[cfg(test)]
mod testes {
    use super::*;

    const CHAVE: [u8; 32] = [3; 32];

    /// Reconhecer o link decide qual fonte monta o cartão. Errar aqui manda o
    /// servidor pedir dados ao serviço errado, ou pedir dados de link que não
    /// tem cartão nenhum a mostrar.
    #[test]
    fn reconhece_cada_fonte() {
        let casos: [(&str, Option<(Fonte, &str)>); 16] = [
            ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", Some((Fonte::Youtube, "dQw4w9WgXcQ"))),
            ("https://youtu.be/dQw4w9WgXcQ?si=abc", Some((Fonte::Youtube, "dQw4w9WgXcQ"))),
            ("https://www.youtube.com/shorts/dQw4w9WgXcQ", Some((Fonte::Youtube, "dQw4w9WgXcQ"))),
            ("https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=30s", Some((Fonte::Youtube, "dQw4w9WgXcQ"))),
            ("https://x.com/fulano/status/1234567890", Some((Fonte::Twitter, "fulano/1234567890"))),
            ("https://vxtwitter.com/fulano/status/1234567890", Some((Fonte::Twitter, "fulano/1234567890"))),
            ("https://www.instagram.com/p/Abc123_-x/", Some((Fonte::Instagram, "p/Abc123_-x"))),
            // `reels` no plural e o que o aplicativo compartilha; o espelho so
            // entende `reel`, entao a forma normalizada e a que sai daqui.
            ("https://www.instagram.com/reels/Abc123/", Some((Fonte::Instagram, "reel/Abc123"))),
            ("https://www.tiktok.com/@alguem/video/7412345678901234567", Some((Fonte::Tiktok, "@alguem/video/7412345678901234567"))),
            ("https://vm.tiktok.com/ZMabcdef1/", Some((Fonte::Tiktok, "ZMabcdef1"))),
            // Sem rota propria: cai no leitor de `og:`, que e o caso geral.
            ("https://www.youtube.com/@alguem", Some((Fonte::Site, "https://www.youtube.com/@alguem"))),
            ("https://x.com/fulano", Some((Fonte::Site, "https://x.com/fulano"))),
            ("https://exemplo.com/noticia/hoje", Some((Fonte::Site, "https://exemplo.com/noticia/hoje"))),
            // Arquivo de midia o cliente abre sozinho; cartao seria trabalho a toa.
            ("https://exemplo.com/foto.JPG", None),
            ("https://exemplo.com/clipe.mp4?x=1", None),
            // Endereco que nao e pagina https nenhuma.
            ("ftp://exemplo.com/arquivo", None),
        ];
        for (entrada, esperado) in casos {
            let obtido = reconhecer(entrada);
            match (&obtido, &esperado) {
                (Some((f, a)), Some((ef, ea))) => assert!(f == ef && a == ea, "{entrada} deu {a}"),
                (None, None) => {}
                _ => panic!("{entrada} deu {:?}", obtido.map(|(f, a)| (f, a))),
            }
        }
    }

    /// Endereço embutido com credencial ou porta não vira cartão nenhum: é assim
    /// que `youtube.com@interno` tentaria passar por `youtube.com`.
    #[test]
    fn endereco_disfarcado_nao_passa() {
        assert!(reconhecer("https://youtube.com@interno/watch?v=dQw4w9WgXcQ").is_none());
        assert!(reconhecer("https://youtube.com:8080/watch?v=dQw4w9WgXcQ").is_none());
        // Nome parecido nao vira cartao de YouTube — vira cartao de site comum,
        // que le a pagina dele e mostra o que ela mesma diz que e.
        assert_eq!(reconhecer("https://naoyoutube.com/watch?v=dQw4w9WgXcQ").map(|(f, _)| f), Some(Fonte::Site));
    }

    /// A mídia só volta com a assinatura deste servidor. Sem isso a rota viraria
    /// buscador de qualquer URL da internet para quem quisesse.
    #[test]
    fn midia_so_com_assinatura() {
        let boa = "https://i.ytimg.com/vi/abc/hqdefault.jpg";
        let ficha = empacotar(&CHAVE, boa);
        assert_eq!(abrir_midia(&CHAVE, &ficha).as_deref(), Some(boa));

        // Assinada com outra chave.
        assert_eq!(abrir_midia(&CHAVE, &empacotar(&[9; 32], boa)), None);
        // Assinada por nos, mas em forma que a busca recusa.
        assert_eq!(abrir_midia(&CHAVE, &empacotar(&CHAVE, "http://exemplo.com/x.jpg")), None);
        assert_eq!(abrir_midia(&CHAVE, &empacotar(&CHAVE, "https://exemplo.com@interno/x.jpg")), None);
        assert_eq!(abrir_midia(&CHAVE, "sem-ponto"), None);
    }

    /// O cartão de site traz imagem de qualquer CDN, entao a barreira nao e mais
    /// a lista de dominios — e a conferencia de IP na hora de buscar.
    #[test]
    fn midia_de_qualquer_site_entra_assinada() {
        assert!(caminho_de_midia(&CHAVE, "https://cdn.exemplo.com/foto.jpg").starts_with("/api/previa/midia?f="));
        assert_eq!(caminho_de_midia(&CHAVE, ""), "");
        assert_eq!(caminho_de_midia(&CHAVE, "http://exemplo.com/foto.jpg"), "");
    }

    /// Rede de dentro não é buscável, em nenhuma das formas de escrevê-la.
    #[test]
    fn endereco_interno_nao_e_publico() {
        use std::net::IpAddr;
        let internos = [
            "127.0.0.1", "10.0.0.150", "192.168.0.1", "172.16.5.4", "169.254.169.254",
            "0.0.0.0", "100.64.1.1", "255.255.255.255", "::1", "fd00::1", "fe80::1",
            "::ffff:127.0.0.1", "::ffff:10.0.0.150",
        ];
        for bruto in internos {
            let ip: IpAddr = bruto.parse().unwrap();
            assert!(!seguro::publico(ip), "{bruto} passou");
        }
        for bruto in ["1.1.1.1", "179.118.205.13", "2606:4700:4700::1111"] {
            let ip: IpAddr = bruto.parse().unwrap();
            assert!(seguro::publico(ip), "{bruto} foi recusado");
        }
    }

    /// As marcas `og:` saem da página como estão escritas, e o que não é marca
    /// de verdade fica de fora.
    #[test]
    fn le_as_marcas_da_pagina() {
        let html = r#"<html><head>
            <title>Titulo da aba &amp; cia</title>
            <meta property="og:title" content="Uma not&#237;cia" />
            <meta name='og:description' content='Resumo com &quot;aspas&quot; &amp; e comercial'>
            <meta property="og:image" content="https://cdn.exemplo.com/capa.jpg">
            <meta property="og:image" content="https://cdn.exemplo.com/rodape.jpg">
            <meta data-content="isto nao e marca" itemprop-name="nem isto">
        </head></html>"#;
        let marcas = marcas_de(html);
        assert_eq!(marcas.get("og:title").unwrap(), "Uma not&#237;cia");
        assert_eq!(marcas.get("og:description").unwrap(), "Resumo com \"aspas\" & e comercial");
        // A primeira imagem vence: a ultima costuma ser o icone do rodape.
        assert_eq!(marcas.get("og:image").unwrap(), "https://cdn.exemplo.com/capa.jpg");
        assert_eq!(marcas.get("title").unwrap(), "Titulo da aba & cia");
        assert!(marcas.get("data-content").is_none());
    }

    /// Redirecionamento só continua dentro do `https`, e é onde mora o truque de
    /// mandar o servidor para a rede de dentro depois da conferência.
    #[test]
    fn redirecionamento_so_segue_https() {
        let base = "https://exemplo.com/noticias/hoje";
        assert_eq!(seguro::absoluto(base, "/outra"), Ok("https://exemplo.com/outra".into()));
        assert_eq!(seguro::absoluto(base, "amanha"), Ok("https://exemplo.com/noticias/amanha".into()));
        assert_eq!(seguro::absoluto(base, "https://outro.com/x"), Ok("https://outro.com/x".into()));
        assert!(seguro::absoluto(base, "http://169.254.169.254/").is_err());
    }

    /// Bate nos sites de verdade e imprime o que cada um devolveu.
    ///
    /// Fora da suíte normal — `cargo test fio_real -- --ignored --nocapture` —
    /// porque depende da internet e do humor de cada site. Existe para o dia em
    /// que alguém disser "o cartão do TikTok parou": em um comando dá para ver
    /// se o espelho caiu, se o site passou a exigir navegador ou se o defeito é
    /// nosso, sem precisar publicar versão para descobrir.
    #[tokio::test]
    #[ignore]
    async fn fio_real() {
        for (rotulo, url) in [
            ("youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
            ("tuite", "https://x.com/elonmusk/status/1519480761749016577"),
            ("reddit", "https://www.reddit.com/r/rust/comments/1g0b1bq/"),
            ("steam", "https://store.steampowered.com/app/620/Portal_2/"),
            ("site", "https://www.rust-lang.org/"),
            ("noticia", "https://g1.globo.com/"),
            ("github", "https://github.com/rust-lang/rust"),
            ("instagram", "https://www.instagram.com/p/C8Qk4kFsQ2h/"),
            ("tiktok", "https://www.tiktok.com/@tiktok/video/7106594312292453675"),
        ] {
            let Some((fonte, alvo)) = reconhecer(url) else {
                println!("{rotulo}: nao reconhecido");
                continue;
            };
            match montar(&CHAVE, fonte, &alvo).await {
                Ok(c) => println!(
                    "{rotulo}: {:?} titulo={:?} autor={:?} site={:?} img={} video={}",
                    fonte, c.titulo, c.autor, c.site, !c.imagem.is_empty(), !c.video.is_empty()
                ),
                Err(e) => println!("{rotulo}: ERRO {e}"),
            }
        }
    }
}
