//! Busca de GIF, sempre pelo servidor.
//!
//! O cliente nunca fala com o provedor. Duas razoes:
//!
//! - a politica de conteudo da janela do aplicativo so aceita imagem da propria
//!   origem, e afrouxar isso para um dominio de terceiro vale para tudo o que a
//!   janela carrega, nao so para os GIFs;
//! - a busca de GIF diz muito sobre quem procura. Passando por aqui, o provedor
//!   ve um servidor, e nao a lista de pessoas que usam este.
//!
//! Por isso cada miniatura volta com um endereco **deste** servidor. O endereco
//! de fora viaja assinado por HMAC dentro dele: sem a assinatura a rota de proxy
//! recusa, o que impede transformar este servidor num buscador de qualquer URL
//! da internet.
//!
//! **Qual provedor e escolha de quem hospeda**, em `GIF_PROVIDER`, e nao algo
//! decidido aqui. O Tenor fechou para novos cadastros em janeiro de 2026; o
//! proximo pode fechar tambem, e quando isso acontecer trocar de fonte tem de
//! ser uma linha no `.env`, nao uma versao nova do servidor.
//!
//! Sem `GIF_API_KEY` nada disso existe, e a rota responde dizendo isso — o botao
//! some no cliente em vez de dar erro no clique.

use std::time::Duration;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// Quantos GIFs por pagina. Enche a grade sem carregar uma pilha que ninguem
/// vai rolar.
const POR_PAGINA: u8 = 24;
/// Teto do que este servidor aceita baixar. GIF de conversa nao chega perto
/// disso; o limite existe para o caso de vir outra coisa.
const MAX_BYTES: usize = 12 * 1024 * 1024;
const TEMPO_LIMITE: Duration = Duration::from_secs(10);

/// De onde os GIFs vem.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Provedor {
    Giphy,
    Tenor,
}

impl Provedor {
    /// Le a escolha de quem hospeda. Nome desconhecido cai no Giphy em vez de
    /// derrubar o servidor: um erro de digitacao no `.env` nao pode tirar do ar
    /// um aplicativo inteiro por causa da busca de GIF.
    pub fn ler(nome: &str) -> Self {
        match nome.trim().to_ascii_lowercase().as_str() {
            "tenor" => Self::Tenor,
            _ => Self::Giphy,
        }
    }

    /// Os unicos servidores de onde este proxy busca.
    ///
    /// Vale mesmo com a assinatura conferida: a assinatura garante que o
    /// endereco saiu daqui, e esta lista garante que nem um defeito neste
    /// arquivo transforma a rota em porta para a rede interna.
    fn dominios(&self) -> &'static [&'static str] {
        match self {
            Self::Giphy => &["giphy.com"],
            Self::Tenor => &["tenor.com", "googleapis.com"],
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gif {
    pub id: String,
    /// Descricao do que aparece no GIF, para quem usa leitor de tela.
    pub descricao: String,
    pub largura: u32,
    pub altura: u32,
    /// Endereco **deste** servidor para a miniatura animada.
    pub previa: String,
    /// Credencial do GIF em tamanho cheio, devolvida ao servidor na hora de
    /// enviar. Nao e uma URL de proposito: quem envia nao precisa ver para onde
    /// aponta, e assim nao ha o que adulterar.
    pub ficha: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pagina {
    pub gifs: Vec<Gif>,
    /// Cursor da proxima pagina, vazio quando acabou. O formato e do provedor:
    /// o Tenor devolve um texto, o Giphy conta a partir de quantos ja vieram.
    pub proximo: String,
}

/// Um achado antes de virar `Gif`: os dois enderecos crus e o que descrever.
struct Bruto {
    id: String,
    descricao: String,
    largura: u32,
    altura: u32,
    previa: String,
    cheio: String,
}

// ------------------------------------------------------------ o que o Tenor da
#[derive(Deserialize)]
struct RespostaTenor {
    #[serde(default)]
    results: Vec<ResultadoTenor>,
    #[serde(default)]
    next: String,
}

#[derive(Deserialize)]
struct ResultadoTenor {
    #[serde(default)]
    id: String,
    #[serde(default)]
    content_description: String,
    #[serde(default)]
    media_formats: std::collections::HashMap<String, FormatoTenor>,
}

#[derive(Deserialize)]
struct FormatoTenor {
    #[serde(default)]
    url: String,
    #[serde(default)]
    dims: Vec<u32>,
}

// ------------------------------------------------------------ o que o Giphy da
#[derive(Deserialize)]
struct RespostaGiphy {
    #[serde(default)]
    data: Vec<ResultadoGiphy>,
}

#[derive(Deserialize)]
struct ResultadoGiphy {
    #[serde(default)]
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    images: std::collections::HashMap<String, ImagemGiphy>,
}

#[derive(Deserialize)]
struct ImagemGiphy {
    #[serde(default)]
    url: String,
    /// O Giphy manda numero como texto.
    #[serde(default)]
    width: String,
    #[serde(default)]
    height: String,
}

/// Assina um endereco para ele poder voltar por `midia`.
///
/// `pub(crate)` porque as previas de link usam a mesma tecnica com outra lista
/// de dominios: assinar o endereco de fora e devolve-lo dentro de um endereco
/// nosso e o que impede a rota de proxy de virar buscador de qualquer URL.
pub(crate) fn assinar(chave: &[u8; 32], url: &str) -> String {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(chave).expect("HMAC aceita qualquer tamanho");
    mac.update(url.as_bytes());
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

/// Uma credencial e o endereco mais a assinatura dele, num pedaco so.
pub(crate) fn empacotar(chave: &[u8; 32], url: &str) -> String {
    format!("{}.{}", URL_SAFE_NO_PAD.encode(url.as_bytes()), assinar(chave, url))
}

/// Abre a credencial, conferindo a assinatura e o servidor de origem.
///
/// Devolve `None` para qualquer coisa fora do combinado, sem dizer o que estava
/// errado: quem esta testando enderecos nao ganha pista nenhuma.
pub fn abrir(chave: &[u8; 32], provedor: Provedor, ficha: &str) -> Option<String> {
    let (bruto, assinatura) = ficha.split_once('.')?;
    let url = String::from_utf8(URL_SAFE_NO_PAD.decode(bruto).ok()?).ok()?;
    let esperada = assinar(chave, &url);
    // Comparacao de tempo constante: comparar `String` com `==` para no
    // primeiro byte diferente, e isso vaza quanto do palpite estava certo.
    if !constante(assinatura.as_bytes(), esperada.as_bytes()) {
        return None;
    }
    if !hospedeiro_conhecido(provedor, &url) {
        return None;
    }
    Some(url)
}

pub(crate) fn constante(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acumulado, (x, y)| acumulado | (x ^ y)) == 0
}

/// O endereco aponta para um servidor do provedor escolhido?
fn hospedeiro_conhecido(provedor: Provedor, url: &str) -> bool {
    let Some(resto) = url.strip_prefix("https://") else { return false };
    let host = resto.split(['/', '?', '#']).next().unwrap_or("");
    // Sem credencial embutida e sem porta: `media.giphy.com@interno` tem host
    // `interno`, e comparar so a parte da frente cairia nessa.
    if host.is_empty() || host.contains('@') || host.contains(':') {
        return false;
    }
    provedor.dominios().iter().any(|dominio| {
        // O ponto antes do dominio e o que separa `media.giphy.com` de
        // `giphy.com.invasor.com`.
        host == *dominio || host.ends_with(&format!(".{dominio}"))
    })
}

/// Procura e devolve a pagina ja traduzida para o formato daqui.
///
/// `termo` vazio traz os GIFs em destaque, que e o que preenche a grade antes
/// de a pessoa digitar qualquer coisa.
pub async fn procurar(
    provedor: Provedor,
    chave_api: &str,
    chave_hmac: &[u8; 32],
    termo: &str,
    posicao: &str,
    idioma: &str,
) -> Result<Pagina, String> {
    let termo = termo.trim();
    let (endereco, corpo_tenor) = match provedor {
        Provedor::Tenor => (endereco_tenor(chave_api, termo, posicao, idioma), true),
        Provedor::Giphy => (endereco_giphy(chave_api, termo, posicao, idioma), false),
    };

    let cliente = reqwest::Client::builder()
        .timeout(TEMPO_LIMITE)
        .build()
        .map_err(|erro| erro.to_string())?;
    let resposta = cliente
        .get(&endereco)
        .send()
        .await
        .map_err(|_| "O provedor de GIF nao respondeu.".to_string())?;
    if !resposta.status().is_success() {
        // O texto do provedor pode devolver a chave junto; nao vai para o
        // cliente, so o numero.
        return Err(format!("O provedor recusou a busca ({}).", resposta.status().as_u16()));
    }
    let texto = resposta
        .text()
        .await
        .map_err(|_| "Resposta do provedor ilegivel.".to_string())?;

    let (brutos, proximo) = if corpo_tenor {
        let corpo: RespostaTenor =
            serde_json::from_str(&texto).map_err(|_| "Resposta do Tenor ilegivel.".to_string())?;
        (traduzir_tenor(corpo.results), corpo.next)
    } else {
        let corpo: RespostaGiphy =
            serde_json::from_str(&texto).map_err(|_| "Resposta do Giphy ilegivel.".to_string())?;
        let quantos = corpo.data.len();
        let brutos = traduzir_giphy(corpo.data);
        // O Giphy pagina por quantos ja vieram. Pagina incompleta e o fim.
        let proximo = if quantos < POR_PAGINA as usize {
            String::new()
        } else {
            (posicao.parse::<u32>().unwrap_or(0) + quantos as u32).to_string()
        };
        (brutos, proximo)
    };

    let gifs = brutos
        .into_iter()
        .filter(|bruto| {
            hospedeiro_conhecido(provedor, &bruto.previa) && hospedeiro_conhecido(provedor, &bruto.cheio)
        })
        .map(|bruto| Gif {
            id: bruto.id,
            descricao: bruto.descricao,
            largura: bruto.largura,
            altura: bruto.altura,
            previa: format!("/api/gifs/midia?f={}", empacotar(chave_hmac, &bruto.previa)),
            ficha: empacotar(chave_hmac, &bruto.cheio),
        })
        .collect();

    Ok(Pagina { gifs, proximo })
}

fn endereco_tenor(chave: &str, termo: &str, posicao: &str, idioma: &str) -> String {
    let base = if termo.is_empty() {
        "https://tenor.googleapis.com/v2/featured?".to_string()
    } else {
        format!("https://tenor.googleapis.com/v2/search?q={}&", url_escape(termo))
    };
    format!(
        "{base}key={}&client_key=naoconcordo&limit={POR_PAGINA}\
         &media_filter=tinygif,gif&contentfilter=medium&locale={}&pos={}",
        url_escape(chave),
        url_escape(idioma),
        url_escape(posicao),
    )
}

fn endereco_giphy(chave: &str, termo: &str, posicao: &str, idioma: &str) -> String {
    let base = if termo.is_empty() {
        "https://api.giphy.com/v1/gifs/trending?".to_string()
    } else {
        format!("https://api.giphy.com/v1/gifs/search?q={}&", url_escape(termo))
    };
    // O Giphy quer so a lingua, sem o pais: `pt_BR` vira `pt`.
    let lingua = idioma.split(['_', '-']).next().unwrap_or("pt");
    format!(
        "{base}api_key={}&limit={POR_PAGINA}&offset={}&rating=pg-13&lang={}&bundle=messaging_non_clips",
        url_escape(chave),
        url_escape(posicao),
        url_escape(lingua),
    )
}

fn traduzir_tenor(resultados: Vec<ResultadoTenor>) -> Vec<Bruto> {
    resultados
        .into_iter()
        .filter_map(|item| {
            // `tinygif` e a miniatura animada; `gif` e o que vai para a conversa.
            let previa = item.media_formats.get("tinygif")?;
            let cheio = item.media_formats.get("gif")?;
            Some(Bruto {
                id: item.id,
                descricao: item.content_description,
                largura: previa.dims.first().copied().unwrap_or(0),
                altura: previa.dims.get(1).copied().unwrap_or(0),
                previa: previa.url.clone(),
                cheio: cheio.url.clone(),
            })
        })
        .collect()
}

fn traduzir_giphy(resultados: Vec<ResultadoGiphy>) -> Vec<Bruto> {
    resultados
        .into_iter()
        .filter_map(|item| {
            // `fixed_width_small` e leve o bastante para uma grade inteira;
            // `downsized` evita mandar para a conversa o original de 8 MB.
            let previa = item.images.get("fixed_width_small")?;
            let cheio = item
                .images
                .get("downsized")
                .or_else(|| item.images.get("original"))?;
            Some(Bruto {
                id: item.id,
                descricao: item.title,
                largura: previa.width.parse().unwrap_or(0),
                altura: previa.height.parse().unwrap_or(0),
                previa: previa.url.clone(),
                cheio: cheio.url.clone(),
            })
        })
        .collect()
}

/// Baixa o que a credencial aponta.
pub async fn baixar(url: &str) -> Result<(Vec<u8>, String), String> {
    let cliente = reqwest::Client::builder()
        .timeout(TEMPO_LIMITE)
        .build()
        .map_err(|erro| erro.to_string())?;
    let resposta = cliente
        .get(url)
        .send()
        .await
        .map_err(|_| "O provedor de GIF nao respondeu.".to_string())?;
    if !resposta.status().is_success() {
        return Err("O GIF nao esta mais disponivel.".into());
    }
    let tipo = resposta
        .headers()
        .get("content-type")
        .and_then(|valor| valor.to_str().ok())
        .unwrap_or("image/gif")
        .split(';')
        .next()
        .unwrap_or("image/gif")
        .trim()
        .to_string();

    // `Content-Length` e so uma promessa de quem envia: o corte de verdade
    // acontece contando o que chega.
    if let Some(anunciado) = resposta.content_length() {
        if anunciado > MAX_BYTES as u64 {
            return Err("O GIF e grande demais.".into());
        }
    }
    let bytes = resposta.bytes().await.map_err(|_| "O download falhou.".to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("O GIF e grande demais.".into());
    }
    Ok((bytes.to_vec(), tipo))
}

/// Escapa o que vai num parametro de consulta.
pub(crate) fn url_escape(valor: &str) -> String {
    let mut saida = String::with_capacity(valor.len());
    for byte in valor.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                saida.push(*byte as char)
            }
            _ => saida.push_str(&format!("%{byte:02X}")),
        }
    }
    saida
}

#[cfg(test)]
mod testes {
    use super::*;

    const CHAVE: [u8; 32] = [7; 32];

    /// A credencial so abre com a assinatura que este servidor produziu. Sem
    /// isso, qualquer pessoa faria o servidor buscar o endereco que quisesse.
    #[test]
    fn credencial_adulterada_nao_abre() {
        let url = "https://media.giphy.com/abc/algo.gif";
        let boa = empacotar(&CHAVE, url);
        assert_eq!(abrir(&CHAVE, Provedor::Giphy, &boa).as_deref(), Some(url));

        let outra = empacotar(&[9; 32], url);
        assert_eq!(abrir(&CHAVE, Provedor::Giphy, &outra), None);

        let (bruto, _) = boa.split_once('.').unwrap();
        assert_eq!(abrir(&CHAVE, Provedor::Giphy, &format!("{bruto}.naoconfere")), None);
        assert_eq!(abrir(&CHAVE, Provedor::Giphy, "sem-ponto"), None);
    }

    /// Mesmo assinado, so os servidores do provedor valem: e a rede interna que
    /// fica de fora se um dia a assinatura vazar.
    #[test]
    fn so_o_provedor_passa() {
        for endereco in [
            "https://exemplo.com/algo.gif",
            // Sem TLS nao entra.
            "http://media.giphy.com/algo.gif",
            // Credencial embutida: o host de verdade e `interno`.
            "https://media.giphy.com@interno/algo.gif",
            // Sufixo colado, sem o ponto que separa.
            "https://giphy.com.invasor.com/algo.gif",
            "https://naogiphy.com/algo.gif",
            "https://127.0.0.1/algo.gif",
            "https://media.giphy.com:8080/algo.gif",
        ] {
            let ficha = empacotar(&CHAVE, endereco);
            assert_eq!(abrir(&CHAVE, Provedor::Giphy, &ficha), None, "passou: {endereco}");
        }
        for bom in ["https://giphy.com/a.gif", "https://media3.giphy.com/media/x/a.gif"] {
            assert!(abrir(&CHAVE, Provedor::Giphy, &empacotar(&CHAVE, bom)).is_some(), "recusou: {bom}");
        }
    }

    /// Cada provedor aceita so o proprio dominio: credencial assinada para um
    /// nao vale depois de quem hospeda trocar de fonte.
    #[test]
    fn provedores_nao_se_misturam() {
        let giphy = empacotar(&CHAVE, "https://media.giphy.com/a.gif");
        let tenor = empacotar(&CHAVE, "https://media.tenor.com/a.gif");
        assert!(abrir(&CHAVE, Provedor::Giphy, &giphy).is_some());
        assert!(abrir(&CHAVE, Provedor::Tenor, &tenor).is_some());
        assert_eq!(abrir(&CHAVE, Provedor::Giphy, &tenor), None);
        assert_eq!(abrir(&CHAVE, Provedor::Tenor, &giphy), None);
    }

    /// Nome errado no `.env` nao pode derrubar o servidor.
    #[test]
    fn provedor_desconhecido_cai_no_padrao() {
        assert_eq!(Provedor::ler("tenor"), Provedor::Tenor);
        assert_eq!(Provedor::ler("  TENOR "), Provedor::Tenor);
        assert_eq!(Provedor::ler("giphy"), Provedor::Giphy);
        assert_eq!(Provedor::ler("digitei errado"), Provedor::Giphy);
        assert_eq!(Provedor::ler(""), Provedor::Giphy);
    }

    /// O termo de busca vai para dentro de uma URL: `&` e `=` do usuario nao
    /// podem virar parametro novo.
    #[test]
    fn termo_escapa() {
        assert_eq!(url_escape("gato & cão"), "gato%20%26%20c%C3%A3o");
        assert_eq!(url_escape("a&key=roubada"), "a%26key%3Droubada");
        let endereco = endereco_giphy("chave", "a&api_key=roubada", "0", "pt_BR");
        assert!(endereco.contains("q=a%26api_key%3Droubada"));
        assert!(endereco.contains("api_key=chave&"));
    }
}
