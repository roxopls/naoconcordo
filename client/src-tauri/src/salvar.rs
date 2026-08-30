//! Salvar um anexo na pasta de Downloads.
//!
//! O WebView nao tem um "salvar como" proprio, e o app nao carrega os plugins de
//! dialogo e de arquivo. Gravar direto em Downloads resolve o caso comum, que e
//! guardar a imagem que alguem mandou, sem trazer duas dependencias e sem pedir
//! permissao nova.

use base64::Engine;
use std::path::PathBuf;

/// A pasta de Downloads do usuario. Sem ela, o perfil serve de reserva.
fn pasta_de_downloads() -> PathBuf {
    if let Ok(perfil) = std::env::var("USERPROFILE") {
        let downloads = PathBuf::from(&perfil).join("Downloads");
        if downloads.is_dir() { return downloads; }
        return PathBuf::from(perfil);
    }
    PathBuf::from(".")
}

/// Tira do nome o que o sistema de arquivos recusa, e o que permitiria escrever
/// fora da pasta escolhida.
///
/// O nome vem de quem enviou o anexo, entao ele e entrada de outra pessoa: um
/// `..\\..\\algo.exe` gravaria onde o remetente quisesse.
fn nome_seguro(bruto: &str) -> String {
    let so_nome = bruto.rsplit(['/', '\\']).next().unwrap_or("arquivo");
    let limpo: String = so_nome
        .chars()
        .map(|c| if r#"<>:"/\|?*"#.contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let limpo = limpo.trim().trim_matches('.').to_string();
    if limpo.is_empty() { "arquivo".to_string() } else { limpo }
}

/// Um caminho que ainda nao existe, numerando como o Windows faz.
///
/// Sem isto, salvar duas vezes a mesma foto apagaria a primeira sem avisar.
fn caminho_livre(pasta: &std::path::Path, nome: &str) -> PathBuf {
    let candidato = pasta.join(nome);
    if !candidato.exists() { return candidato; }

    let (base, extensao) = match nome.rsplit_once('.') {
        Some((base, ext)) if !base.is_empty() => (base, format!(".{ext}")),
        _ => (nome, String::new()),
    };
    for tentativa in 1..1000 {
        let candidato = pasta.join(format!("{base} ({tentativa}){extensao}"));
        if !candidato.exists() { return candidato; }
    }
    pasta.join(format!("{base} ({}){extensao}", std::process::id()))
}

/// Grava o arquivo e devolve o caminho, para a interface poder mostrar onde foi.
#[tauri::command]
pub fn salvar_em_downloads(nome: String, conteudo_base64: String) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(conteudo_base64.as_bytes())
        .map_err(|erro| format!("conteudo invalido: {erro}"))?;

    let destino = caminho_livre(&pasta_de_downloads(), &nome_seguro(&nome));
    std::fs::write(&destino, bytes).map_err(|erro| format!("nao foi possivel salvar: {erro}"))?;
    Ok(destino.display().to_string())
}

#[cfg(test)]
mod testes {
    use super::*;

    /// O nome do anexo vem de quem enviou. Sem limpeza, um nome com `..` sairia
    /// da pasta de Downloads e gravaria onde o remetente escolhesse.
    #[test]
    fn nome_de_outra_pessoa_nao_escapa_da_pasta() {
        assert_eq!(nome_seguro(r"..\..\Windows\System32\algo.exe"), "algo.exe");
        assert_eq!(nome_seguro("/etc/passwd"), "passwd");
        assert_eq!(nome_seguro(".."), "arquivo");
        assert_eq!(nome_seguro(""), "arquivo");
    }

    /// Caractere que o Windows recusa vira sublinhado, e o resto do nome fica.
    #[test]
    fn caracteres_recusados_viram_sublinhado() {
        assert_eq!(nome_seguro("foto: a <melhor>.png"), "foto_ a _melhor_.png");
        // Acento e espaco sao validos e devem sobreviver.
        assert_eq!(nome_seguro("férias na praia.jpg"), "férias na praia.jpg");
    }

    /// Salvar duas vezes nao pode apagar a primeira.
    #[test]
    fn arquivo_repetido_ganha_numero() {
        let pasta = std::env::temp_dir().join(format!("nc-salvar-{}", std::process::id()));
        std::fs::create_dir_all(&pasta).expect("criar pasta");

        let primeiro = caminho_livre(&pasta, "foto.png");
        assert_eq!(primeiro.file_name().unwrap(), "foto.png");
        std::fs::write(&primeiro, b"a").expect("gravar");

        let segundo = caminho_livre(&pasta, "foto.png");
        assert_eq!(segundo.file_name().unwrap(), "foto (1).png");

        // Nome sem extensao tambem precisa numerar.
        std::fs::write(pasta.join("leiame"), b"a").expect("gravar");
        assert_eq!(caminho_livre(&pasta, "leiame").file_name().unwrap(), "leiame (1)");

        std::fs::remove_dir_all(&pasta).ok();
    }
}
