//! Traz o LiveKit na primeira execucao.
//!
//! O LiveKit e o que faz voz, camera e tela funcionarem. Ele tem binario
//! oficial para Windows, e baixar na hora mantem o instalador do painel pequeno
//! e o LiveKit atualizavel sem lancar o painel de novo.

use crate::config;
use sha2::{Digest, Sha256};
use std::io::Read;

const REPO: &str = "https://api.github.com/repos/livekit/livekit/releases/latest";

/// O GitHub recusa pedido sem identificacao.
const AGENTE: &str = "naoconcordo-painel";

fn cliente() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(AGENTE)
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())
}

/// Nome e endereco do pacote do Windows na versao mais recente.
fn achar_pacote() -> Result<(String, String, String), String> {
    let dados: serde_json::Value = cliente()?
        .get(REPO).send().map_err(|e| format!("nao foi possivel falar com o GitHub: {e}"))?
        .json().map_err(|e| format!("resposta do GitHub ilegivel: {e}"))?;

    let versao = dados["tag_name"].as_str().unwrap_or("?").to_string();
    let ativos = dados["assets"].as_array().ok_or("release sem arquivos")?;

    let achar = |sufixo: &str| ativos.iter().find_map(|a| {
        let nome = a["name"].as_str()?;
        if !nome.ends_with(sufixo) { return None; }
        let url = a["browser_download_url"].as_str()?;
        Some((nome.to_string(), url.to_string()))
    });

    let (nome, url) = achar("windows_amd64.zip")
        .ok_or("esta versao do LiveKit nao publicou binario para Windows")?;
    let (_, url_somas) = achar("checksums.txt")
        .ok_or("esta versao do LiveKit nao publicou a lista de somas de verificacao")?;
    Ok((nome, url, format!("{versao}\u{1}{url_somas}")))
}

/// A soma esperada para `nome`, lida da lista publicada junto com o pacote.
///
/// Sem esta conferencia, um download truncado ou trocado no caminho viraria um
/// executavel rodando na maquina de quem hospeda.
fn soma_esperada(url_somas: &str, nome: &str) -> Result<String, String> {
    let texto = cliente()?.get(url_somas).send().map_err(|e| e.to_string())?
        .text().map_err(|e| e.to_string())?;
    texto.lines()
        .find_map(|linha| {
            let mut partes = linha.split_whitespace();
            let soma = partes.next()?;
            let arquivo = partes.next()?.trim_start_matches('*');
            (arquivo == nome).then(|| soma.to_lowercase())
        })
        .ok_or_else(|| format!("a lista de somas nao menciona {nome}"))
}

/// Baixa, confere e extrai. Devolve a versao instalada.
pub fn instalar_livekit() -> Result<String, String> {
    let (nome, url, juntos) = achar_pacote()?;
    let (versao, url_somas) = juntos.split_once('\u{1}').ok_or("resposta inesperada")?;
    let esperada = soma_esperada(url_somas, &nome)?;

    let bytes = cliente()?.get(&url).send().map_err(|e| format!("download falhou: {e}"))?
        .bytes().map_err(|e| format!("download incompleto: {e}"))?;

    let obtida = format!("{:x}", Sha256::digest(&bytes));
    if obtida != esperada {
        return Err(format!("o arquivo baixado nao confere com a soma publicada (esperado {esperada}, obtido {obtida}). Nada foi instalado."));
    }

    let pasta = config::pasta_livekit();
    std::fs::create_dir_all(&pasta).map_err(|e| e.to_string())?;

    let cursor = std::io::Cursor::new(bytes.as_ref());
    let mut zip = zip::ZipArchive::new(cursor).map_err(|e| format!("zip ilegivel: {e}"))?;
    let mut achou = false;
    for indice in 0..zip.len() {
        let mut entrada = zip.by_index(indice).map_err(|e| e.to_string())?;
        // So o executavel interessa, e so pelo nome final: um zip malicioso
        // poderia trazer caminhos como `..\..\Windows\System32\...`, e usar o
        // caminho de dentro do arquivo escreveria onde ele mandasse.
        let nome_interno = entrada.name().rsplit(['/', '\\']).next().unwrap_or("").to_string();
        if !nome_interno.eq_ignore_ascii_case("livekit-server.exe") { continue; }
        let mut conteudo = Vec::new();
        entrada.read_to_end(&mut conteudo).map_err(|e| e.to_string())?;
        std::fs::write(pasta.join("livekit-server.exe"), conteudo).map_err(|e| e.to_string())?;
        achou = true;
        break;
    }
    if !achou { return Err("o pacote do LiveKit nao continha livekit-server.exe".into()); }

    std::fs::write(pasta.join("versao.txt"), versao).ok();
    Ok(versao.to_string())
}

/// Qual versao esta instalada, se houver.
pub fn versao_instalada() -> Option<String> {
    let pasta = config::pasta_livekit();
    pasta.join("livekit-server.exe").exists().then(|| {
        std::fs::read_to_string(pasta.join("versao.txt")).unwrap_or_else(|_| "instalado".into())
    })
}
