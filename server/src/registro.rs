//! Registro persistente de quem tenta entrar numa chamada.
//!
//! Uma chamada que não conecta é o defeito mais difícil de investigar neste
//! aplicativo: quem sofre está do outro lado da internet, o sintoma é "não
//! entrou", e quando alguém avisa já passou. Sem registro, a única fonte é a
//! memória de quem estava lá.
//!
//! Cada tentativa vira uma linha, com **sucesso e fracasso no mesmo arquivo**.
//! Só os fracassos não bastam: para saber se "ninguém consegue entrar" é preciso
//! ver que os outros conseguiram, e para saber se alguém tentou dez vezes é
//! preciso ver as dez.
//!
//! Fica em arquivo, e não em memória, exatamente porque o servidor reinicia — e
//! o reinício costuma ser o que a pessoa faz quando algo dá errado, apagando a
//! prova junto.
//!
//! **Não é log de auditoria.** Guarda o nome de quem tentou e em qual canal,
//! porque sem isso não dá para cruzar com quem reclamou. Não guarda endereço de
//! rede nem conteúdo nenhum.

use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::Utc;

/// Nome do arquivo, dentro de `DATA_DIR`.
const ARQUIVO: &str = "chamadas.log";
/// A partir daqui o arquivo é rodado. Uma linha tem ~130 bytes, então 2 MB
/// guardam algo como quinze mil tentativas — meses de uso desta casa.
const MAX_BYTES: u64 = 2 * 1024 * 1024;

/// Como terminou a tentativa.
pub enum Resultado<'a> {
    /// O token saiu e a pessoa deve conseguir entrar.
    Ok,
    /// Recusado por uma regra: não participa do servidor, canal errado, etc.
    Recusado(&'a str),
    /// Falha do próprio servidor. É o caso que merece atenção.
    Falha(&'a str),
}

impl Resultado<'_> {
    fn marca(&self) -> &'static str {
        match self {
            // Alinhados para o olho achar a coluna ao correr o arquivo.
            Self::Ok => "ok   ",
            Self::Recusado(_) => "nao  ",
            Self::Falha(_) => "ERRO ",
        }
    }

    fn motivo(&self) -> &str {
        match self {
            Self::Ok => "",
            Self::Recusado(m) | Self::Falha(m) => m,
        }
    }
}

/// Que tipo de conexão a pessoa pediu. As três aparecem no mesmo canal e
/// separá-las evita ler "entrou três vezes" onde houve uma.
pub fn sabor(tela: bool, espectador: bool) -> &'static str {
    if tela {
        "tela"
    } else if espectador {
        "cameras"
    } else {
        "voz"
    }
}

/// Anota uma tentativa. Nunca falha para quem chama: registro que derruba a
/// chamada que ele deveria estar observando seria pior que registro nenhum.
pub fn anotar(data_dir: &Path, usuario: &str, canal: &str, tipo: &str, resultado: Resultado<'_>) {
    let linha = format!(
        "{} {} {:<24} {:<28} {:<8} {}\n",
        Utc::now().format("%Y-%m-%dT%H:%M:%SZ"),
        resultado.marca(),
        // 24 e o limite de um nome de usuario. Cortar em menos economizaria
        // coluna e estragaria o unico uso do arquivo: cruzar a linha com quem
        // reclamou.
        limpo(usuario, 24),
        limpo(canal, 28),
        tipo,
        limpo(resultado.motivo(), 80),
    );
    let caminho = data_dir.join(ARQUIVO);
    rodar_se_grande(&caminho);
    if let Ok(mut arquivo) = std::fs::OpenOptions::new().create(true).append(true).open(&caminho) {
        let _ = arquivo.write_all(linha.as_bytes());
    }
}

/// Tira quebra de linha e corta o comprimento.
///
/// O nome de usuário e o motivo vêm de fora; sem isto, um `\n` no meio quebraria
/// o arquivo em linhas falsas e atrapalharia justamente quem for lê-lo depois.
fn limpo(bruto: &str, limite: usize) -> String {
    bruto
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(limite)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Passou do tamanho: o atual vira `.1` e um novo começa.
///
/// Um arquivo só, crescendo para sempre, um dia enche o disco do servidor — e
/// enche calado, que é o pior jeito.
fn rodar_se_grande(caminho: &PathBuf) {
    let Ok(dados) = std::fs::metadata(caminho) else { return };
    if dados.len() < MAX_BYTES {
        return;
    }
    let anterior = caminho.with_extension("log.1");
    let _ = std::fs::rename(caminho, anterior);
}

/// As últimas `linhas` do registro, da mais nova para a mais velha.
///
/// Lê o arquivo inteiro porque ele é limitado a 2 MB por construção; paginar de
/// trás para frente seria complicação sem ganho nesta escala.
pub fn ultimas(data_dir: &Path, linhas: usize) -> Vec<String> {
    let Ok(texto) = std::fs::read_to_string(data_dir.join(ARQUIVO)) else { return Vec::new() };
    texto
        .lines()
        .rev()
        .filter(|l| !l.trim().is_empty())
        .take(linhas)
        .map(|l| l.to_string())
        .collect()
}

#[cfg(test)]
mod testes {
    use super::*;

    /// Nome com quebra de linha viraria duas linhas no arquivo, e quem lesse
    /// depois veria uma tentativa que nunca existiu.
    #[test]
    fn nao_da_para_forjar_linha() {
        let sujo = "fulano\n2020-01-01T00:00:00Z ok    invasor";
        let saida = limpo(sujo, 24);
        assert!(!saida.contains('\n'), "sobrou quebra de linha: {saida:?}");
        assert!(saida.chars().count() <= 24);
    }

    /// O que sai tem de dar para ler em coluna, e trazer o motivo do erro.
    #[test]
    fn a_linha_diz_o_que_aconteceu() {
        let dir = std::env::temp_dir().join(format!("nc-registro-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let _ = std::fs::remove_file(dir.join(ARQUIVO));

        anotar(&dir, "roxo", "casa-voz-geral", "voz", Resultado::Ok);
        anotar(&dir, "ale", "casa-voz-geral", "tela", Resultado::Falha("sem chave"));

        let linhas = ultimas(&dir, 10);
        assert_eq!(linhas.len(), 2);
        // A mais nova vem primeiro.
        assert!(linhas[0].contains("ERRO"), "{:?}", linhas[0]);
        assert!(linhas[0].contains("sem chave"));
        assert!(linhas[0].contains("tela"));
        assert!(linhas[1].contains("ok"));
        assert!(linhas[1].contains("roxo"));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Registro de uma pasta que não existe não pode derrubar nada.
    #[test]
    fn pasta_ausente_nao_quebra() {
        anotar(
            Path::new("/nao/existe/mesmo"),
            "alguem",
            "canal",
            "voz",
            Resultado::Recusado("teste"),
        );
        assert!(ultimas(Path::new("/nao/existe/mesmo"), 5).is_empty());
    }
}
