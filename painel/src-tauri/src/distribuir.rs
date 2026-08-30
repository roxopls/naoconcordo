//! Gerar os clientes assinados por quem hospeda.
//!
//! Sem isto, quem instala um cliente compilado por outra pessoa continua preso
//! a ela: o executavel carrega o endereco de atualizacao e a chave publica de
//! quem o compilou, e so aceita atualizacao assinada por aquela chave. Aqui o
//! dono do servidor gera a **propria** chave, compila o proprio cliente e passa
//! a mandar atualizacao para os amigos dele — a mesma esteira do projeto, na
//! maquina dele.
//!
//! Custa caro: precisa de Node, Rust e NSIS instalados, e o primeiro build
//! demora bastante. Por isso e um caminho declarado, e nao o padrao.

use crate::config::{self, Config};
use sha2::Digest;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

/// De onde vem o codigo. Publico de proposito: quem hospeda compila o que esta
/// publicado, e nao um pacote que alguem lhe mandou.
const REPO_ZIP: &str = "https://codeload.github.com/roxopls/naoconcordo/zip/refs/tags/";
const REPO_API: &str = "https://api.github.com/repos/roxopls/naoconcordo/releases/latest";

/// O endereco deste servidor como os amigos o alcancam. Usado tanto no cliente
/// compilado quanto no manifesto de atualizacao, e por isso vive num lugar so.
fn endereco_base(config: &Config) -> String {
    format!("http://{}:{}",
        if config.endereco_publico.is_empty() { "127.0.0.1" } else { &config.endereco_publico },
        config.porta)
}

pub fn pasta_fonte() -> PathBuf { config::raiz().join("fonte") }
/// Onde fica o servidor baixado, quando ele e mais novo que o que veio junto.
pub fn pasta_servidor() -> PathBuf { config::raiz().join("servidor") }
pub fn pasta_updates() -> PathBuf { config::raiz().join("updates") }
pub fn arquivo_chave() -> PathBuf { config::raiz().join("updater.key") }

type Registro = Arc<Mutex<Vec<String>>>;

fn anotar(registro: &Registro, texto: &str) {
    if let Ok(mut lista) = registro.lock() {
        lista.push(format!("[distribuicao] {texto}"));
        let excesso = lista.len().saturating_sub(500);
        if excesso > 0 { lista.drain(0..excesso); }
    }
}

fn cliente_http() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent("naoconcordo-painel")
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())
}

/// A versao publicada mais recente do projeto.
pub fn versao_publicada() -> Result<String, String> {
    let dados: serde_json::Value = cliente_http()?
        .get(REPO_API).send().map_err(|e| format!("nao foi possivel falar com o GitHub: {e}"))?
        .json().map_err(|e| format!("resposta do GitHub ilegivel: {e}"))?;
    dados["tag_name"].as_str().map(str::to_string)
        .ok_or_else(|| "o GitHub nao devolveu nenhuma versao publicada.".into())
}

/// Roda um comando mandando cada linha da saida para o registro do painel.
///
/// A compilacao demora minutos; sem acompanhar a saida, o painel ficaria parado
/// dizendo "compilando" sem ninguem saber se travou.
fn rodar(registro: &Registro, rotulo: &str, programa: &str, args: &[&str], pasta: &Path, ambiente: &[(&str, String)]) -> Result<(), String> {
    anotar(registro, &format!("{rotulo}…"));
    let mut comando = Command::new(programa);
    comando.args(args).current_dir(pasta)
        .stdout(Stdio::piped()).stderr(Stdio::piped());
    for (chave, valor) in ambiente { comando.env(chave, valor); }
    #[cfg(windows)] { use std::os::windows::process::CommandExt; comando.creation_flags(0x0800_0000); }

    let mut filho = comando.spawn()
        .map_err(|e| format!("{rotulo}: nao foi possivel executar {programa} ({e})"))?;

    for fonte in [filho.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
                  filho.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>)] {
        let Some(fonte) = fonte else { continue };
        let destino = registro.clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            for linha in std::io::BufReader::new(fonte).lines().map_while(Result::ok) {
                if !linha.trim().is_empty() { anotar(&destino, linha.trim()); }
            }
        });
    }

    let estado = filho.wait().map_err(|e| e.to_string())?;
    if !estado.success() { return Err(format!("{rotulo} falhou. Veja o registro acima.")); }
    anotar(registro, &format!("{rotulo}: pronto"));
    Ok(())
}

/// Traz o codigo da versao pedida e o deixa em `fonte/`.
fn baixar_fonte(registro: &Registro, versao: &str) -> Result<PathBuf, String> {
    anotar(registro, &format!("baixando o codigo da versao {versao}"));
    let bytes = cliente_http()?
        .get(format!("{REPO_ZIP}{versao}")).send()
        .map_err(|e| format!("download do codigo falhou: {e}"))?
        .bytes().map_err(|e| format!("download incompleto: {e}"))?;

    let destino = pasta_fonte();
    // Comeca limpo: restos de uma versao anterior fariam o build misturar
    // arquivos de duas versoes, e o resultado seria dificil de explicar.
    if destino.exists() { std::fs::remove_dir_all(&destino).map_err(|e| e.to_string())?; }
    std::fs::create_dir_all(&destino).map_err(|e| e.to_string())?;

    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes.as_ref()))
        .map_err(|e| format!("o codigo baixado nao e um zip valido: {e}"))?;
    for indice in 0..zip.len() {
        let mut entrada = zip.by_index(indice).map_err(|e| e.to_string())?;
        // `enclosed_name` recusa caminhos que escapam da pasta (`..`), que e o
        // que impede um zip preparado de escrever em qualquer lugar do disco.
        let Some(interno) = entrada.enclosed_name() else { continue };
        // O zip do GitHub embrulha tudo numa pasta com o nome da versao; ela
        // sai aqui para o caminho ficar previsivel.
        let mut partes = interno.components();
        partes.next();
        let relativo: PathBuf = partes.collect();
        if relativo.as_os_str().is_empty() { continue; }
        let caminho = destino.join(relativo);
        if entrada.is_dir() { std::fs::create_dir_all(&caminho).ok(); continue; }
        if let Some(pai) = caminho.parent() { std::fs::create_dir_all(pai).map_err(|e| e.to_string())?; }
        let mut conteudo = Vec::new();
        entrada.read_to_end(&mut conteudo).map_err(|e| e.to_string())?;
        std::fs::write(&caminho, conteudo).map_err(|e| e.to_string())?;
    }
    anotar(registro, "codigo extraido");
    Ok(destino)
}

/// A chave que assina as atualizacoes deste servidor.
///
/// Sem senha, de proposito: a compilacao roda sozinha e uma senha guardada ao
/// lado da chave nao protegeria de nada. Quem tiver acesso ao arquivo tem a
/// chave, e por isso ela fica em `%APPDATA%` e nao em pasta compartilhada.
///
/// **Ela nunca e regerada.** Trocar a chave quebra a atualizacao de todos os
/// clientes ja instalados: eles so aceitam o que a chave antiga assinou, e a
/// unica saida seria cada pessoa reinstalar a mao.
pub fn garantir_chave(registro: &Registro, fonte: &Path) -> Result<String, String> {
    let chave = arquivo_chave();
    let publica = chave.with_extension("key.pub");
    if chave.exists() && publica.exists() {
        return std::fs::read_to_string(&publica).map_err(|e| e.to_string());
    }

    anotar(registro, "gerando a chave de assinatura deste servidor");
    let cliente = fonte.join("client");
    rodar(registro, "gerar chave", "npx.cmd",
        &["tauri", "signer", "generate", "-w", &chave.display().to_string(), "--password", "", "--force"],
        &cliente, &[])?;

    std::fs::read_to_string(&publica)
        .map_err(|e| format!("a chave publica nao apareceu em {}: {e}", publica.display()))
}

/// Escreve o que faz este cliente ser **deste** servidor: para onde ele fala e
/// de quem ele aceita atualizacao.
fn configurar_cliente(fonte: &Path, config: &Config, chave_publica: &str) -> Result<(), String> {
    let cliente = fonte.join("client");
    let endereco = endereco_base(config);

    std::fs::write(cliente.join(".env.local"), format!("VITE_SERVER_URL={endereco}\n"))
        .map_err(|e| format!("nao foi possivel escrever .env.local: {e}"))?;

    // O atualizador aponta para o proprio servidor, que agora serve /updates.
    let conf = serde_json::json!({
        "plugins": {
            "updater": {
                "endpoints": [format!("{endereco}/updates/latest.json")],
                "pubkey": chave_publica.trim(),
            }
        }
    });
    std::fs::write(
        cliente.join("src-tauri").join("tauri.local.conf.json"),
        serde_json::to_string_pretty(&conf).map_err(|e| e.to_string())?,
    ).map_err(|e| format!("nao foi possivel escrever tauri.local.conf.json: {e}"))
}

/// Publica o instalador recem-compilado para os amigos.
fn publicar(registro: &Registro, fonte: &Path, versao: &str, config: &Config) -> Result<String, String> {
    let bundle = fonte.join("client").join("src-tauri").join("target").join("release").join("bundle").join("nsis");
    let mut instalador = None;
    for entrada in std::fs::read_dir(&bundle).map_err(|e| format!("nao achei o instalador em {}: {e}", bundle.display()))? {
        let caminho = entrada.map_err(|e| e.to_string())?.path();
        let nome = caminho.file_name().unwrap_or_default().to_string_lossy().to_string();
        if nome.ends_with("-setup.exe") { instalador = Some((nome, caminho)); }
    }
    let (nome, caminho) = instalador.ok_or("o build terminou mas nao produziu instalador.")?;
    let assinatura = std::fs::read_to_string(caminho.with_extension("exe.sig"))
        .map_err(|_| "o instalador saiu sem assinatura; a chave nao foi aplicada.".to_string())?;

    let updates = pasta_updates();
    std::fs::create_dir_all(&updates).map_err(|e| e.to_string())?;
    std::fs::copy(&caminho, updates.join(&nome)).map_err(|e| format!("nao foi possivel copiar o instalador: {e}"))?;

    // O manifesto que o cliente instalado consulta. A versao vem sem o "v" da
    // etiqueta do git: o comparador do atualizador espera semver puro.
    let limpa = versao.trim_start_matches('v');
    let manifesto = serde_json::json!({
        "version": limpa,
        "notes": format!("Versao {limpa}."),
        "pub_date": chrono_agora(),
        "platforms": {
            "windows-x86_64": {
                "signature": assinatura.trim(),
                // Absoluta: o atualizador baixa o arquivo por esta URL, e um
                // caminho relativo nao diria a ele em que servidor procurar.
                "url": format!("{}/updates/{nome}", endereco_base(config)),
            }
        }
    });
    std::fs::write(updates.join("latest.json"), serde_json::to_string_pretty(&manifesto).map_err(|e| e.to_string())?)
        .map_err(|e| format!("nao foi possivel escrever o manifesto: {e}"))?;

    anotar(registro, &format!("publicado: {nome}"));
    Ok(nome)
}

/// Sem a `chrono` so para isto: o formato que o atualizador aceita e ISO 8601,
/// e o relogio do sistema basta.
fn chrono_agora() -> String {
    let agora = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Conversao suficiente para um campo informativo; o atualizador nao decide
    // nada por ele.
    let dias = agora / 86_400;
    let (ano, mes, dia) = civil(dias as i64);
    let resto = agora % 86_400;
    format!("{ano:04}-{mes:02}-{dia:02}T{:02}:{:02}:{:02}Z", resto / 3600, (resto % 3600) / 60, resto % 60)
}

/// Dias desde 1970 para ano/mes/dia. Algoritmo de calendario civil de Howard
/// Hinnant, o mesmo que as bibliotecas de data usam.
fn civil(dias: i64) -> (i64, u32, u32) {
    let z = dias + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// A esteira inteira: codigo, chave, configuracao, build e publicacao.
pub fn gerar_clientes(registro: Registro, versao: String, config: Config) -> Result<String, String> {
    let fonte = baixar_fonte(&registro, &versao)?;
    let cliente = fonte.join("client");

    rodar(&registro, "instalando dependencias", "npm.cmd", &["install"], &cliente, &[])?;

    let publica = garantir_chave(&registro, &fonte)?;
    configurar_cliente(&fonte, &config, &publica)?;

    let ambiente = [
        ("TAURI_SIGNING_PRIVATE_KEY", arquivo_chave().display().to_string()),
        ("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", String::new()),
    ];
    rodar(&registro, "compilando o cliente (demora)", "npm.cmd", &["run", "build:release"], &cliente, &ambiente)?;

    publicar(&registro, &fonte, &versao, &config)
}

#[cfg(test)]
mod testes {
    use super::*;

    /// O calendario e escrito a mao aqui; um erro nele passaria despercebido
    /// porque o campo e so informativo, e depois confundiria quem lesse a data
    /// de publicacao de um instalador.
    #[test]
    fn datas_conhecidas_batem() {
        assert_eq!(civil(0), (1970, 1, 1));
        assert_eq!(civil(19_723), (2024, 1, 1));
        // Ano bissexto: 29 de fevereiro existe em 2024.
        assert_eq!(civil(19_782), (2024, 2, 29));
        assert_eq!(civil(20_819), (2027, 1, 1));
    }

    /// A hora sai do resto do dia; um erro aqui daria "25:00:00" e o campo
    /// deixaria de ser ISO 8601.
    #[test]
    fn a_hora_cabe_no_dia() {
        let agora = chrono_agora();
        assert_eq!(agora.len(), 20, "formato inesperado: {agora}");
        assert!(agora.ends_with('Z'), "{agora}");
        let hora: u32 = agora[11..13].parse().expect("hora");
        let minuto: u32 = agora[14..16].parse().expect("minuto");
        let segundo: u32 = agora[17..19].parse().expect("segundo");
        assert!(hora < 24 && minuto < 60 && segundo < 60, "{agora}");
    }
}

// ----------------------------------------------------- atualizar o servidor
//
// O `naoconcordo-server.exe` viaja dentro do instalador do painel, e por isso
// envelhece com ele: quem instalou o painel uma vez ficaria com o servidor
// daquele dia para sempre, mesmo compilando clientes novos. Baixa-lo da release
// separa as duas vidas.

/// Um asset da release mais recente, com a soma esperada.
fn asset_da_release(nome_procurado: &str) -> Result<(String, String), String> {
    let dados: serde_json::Value = cliente_http()?
        .get(REPO_API).send().map_err(|e| format!("nao foi possivel falar com o GitHub: {e}"))?
        .json().map_err(|e| format!("resposta do GitHub ilegivel: {e}"))?;
    let versao = dados["tag_name"].as_str().unwrap_or("?").to_string();
    let ativos = dados["assets"].as_array().ok_or("release sem arquivos")?;
    let url = ativos.iter()
        .find(|a| a["name"].as_str() == Some(nome_procurado))
        .and_then(|a| a["browser_download_url"].as_str())
        .ok_or_else(|| format!("a release {versao} nao publicou {nome_procurado}"))?;
    Ok((versao, url.to_string()))
}

/// A soma publicada para um arquivo, lida do `SHA256SUMS.txt` da release.
///
/// Sem isto seria um executavel baixado da internet rodando na maquina de quem
/// hospeda, com a unica garantia sendo o TLS do GitHub. E o mesmo cuidado que o
/// download do LiveKit ja toma.
fn soma_da_release(nome: &str) -> Result<String, String> {
    let (_, url) = asset_da_release("SHA256SUMS.txt")
        .map_err(|_| "esta release nao publicou as somas de verificacao; nada foi baixado.".to_string())?;
    let texto = cliente_http()?.get(url).send().map_err(|e| e.to_string())?
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

/// Baixa o servidor da release publicada. Devolve a versao instalada.
pub fn atualizar_servidor(registro: &Registro) -> Result<String, String> {
    const NOME: &str = "naoconcordo-server.exe";
    let (versao, url) = asset_da_release(NOME)?;
    if versao_do_servidor().as_deref() == Some(versao.as_str()) {
        return Ok(format!("{versao} (ja era a mais recente)"));
    }

    anotar(registro, &format!("baixando o servidor {versao}"));
    let esperada = soma_da_release(NOME)?;
    let bytes = cliente_http()?.get(url).send().map_err(|e| format!("download falhou: {e}"))?
        .bytes().map_err(|e| format!("download incompleto: {e}"))?;

    let obtida = format!("{:x}", sha2::Sha256::digest(&bytes));
    if obtida != esperada {
        return Err(format!("o servidor baixado nao confere com a soma publicada (esperado {esperada}, obtido {obtida}). Nada foi trocado."));
    }

    let pasta = pasta_servidor();
    std::fs::create_dir_all(&pasta).map_err(|e| e.to_string())?;
    // Grava ao lado e so entao renomeia: uma queda no meio da escrita deixaria
    // um executavel truncado no lugar de um que funcionava.
    let provisorio = pasta.join("naoconcordo-server.novo");
    std::fs::write(&provisorio, &bytes).map_err(|e| format!("nao foi possivel gravar: {e}"))?;
    std::fs::rename(&provisorio, pasta.join(NOME)).map_err(|e| format!("nao foi possivel trocar o servidor: {e}"))?;
    std::fs::write(pasta.join("versao.txt"), &versao).ok();

    anotar(registro, &format!("servidor {versao} instalado; desligue e ligue para valer"));
    Ok(versao)
}

/// A versao do servidor baixado, se houver um.
pub fn versao_do_servidor() -> Option<String> {
    let pasta = pasta_servidor();
    pasta.join("naoconcordo-server.exe").exists()
        .then(|| std::fs::read_to_string(pasta.join("versao.txt")).ok())
        .flatten()
}
