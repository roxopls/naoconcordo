//! Painel de quem hospeda o naoconcordo no Windows.
//!
//! O servidor sempre rodou em Linux, com `.env` escrito a mao e Docker. Este
//! painel existe para o outro caso: alguem que quer um servidor para os amigos e
//! nao quer nem Linux nem terminal. Ele gera os segredos, baixa o LiveKit,
//! escreve a configuracao, sobe os dois processos e diz o endereco para passar
//! adiante.

mod baixar;
mod config;
mod distribuir;
mod processos;
mod rede;

use config::Config;
use serde::Serialize;
use std::sync::Mutex;
use tauri::Manager;

struct Estado {
    supervisor: Mutex<processos::Supervisor>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Situacao {
    servidor: bool,
    livekit: bool,
    versao_livekit: Option<String>,
    config: Config,
    enderecos: Vec<rede::Endereco>,
    pasta: String,
}

#[tauri::command]
fn situacao(estado: tauri::State<Estado>) -> Result<Situacao, String> {
    let (servidor, livekit) = estado.supervisor.lock().map_err(|_| "painel ocupado")?.rodando();
    Ok(Situacao {
        servidor,
        livekit,
        versao_livekit: baixar::versao_instalada(),
        config: config::carregar()?,
        enderecos: rede::enderecos(),
        pasta: config::raiz().display().to_string(),
    })
}

#[tauri::command]
fn salvar_config(nova: Config) -> Result<(), String> {
    // Os segredos nunca vem da tela: eles nao aparecem la, e aceita-los daqui
    // abriria caminho para trocar o sal de autenticacao por engano — o que
    // invalidaria a senha de todos os usuarios de uma vez.
    let mut atual = config::carregar()?;
    atual.endereco_publico = nova.endereco_publico.trim().to_string();
    atual.porta = if nova.porta == 0 { 3040 } else { nova.porta };
    atual.admin = if nova.admin.trim().is_empty() { "admin".into() } else { nova.admin.trim().to_string() };
    config::salvar(&atual)
}

#[tauri::command]
fn iniciar(estado: tauri::State<Estado>) -> Result<(), String> {
    let config = config::carregar()?;
    estado.supervisor.lock().map_err(|_| "painel ocupado")?.iniciar(&config)
}

#[tauri::command]
fn parar(estado: tauri::State<Estado>) -> Result<(), String> {
    estado.supervisor.lock().map_err(|_| "painel ocupado")?.parar();
    Ok(())
}

#[tauri::command]
fn registro(estado: tauri::State<Estado>) -> Result<Vec<String>, String> {
    Ok(estado.supervisor.lock().map_err(|_| "painel ocupado")?.registro())
}

/// Baixar bloqueia; sai da linha da interface para a janela nao congelar.
#[tauri::command]
async fn instalar_livekit() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(baixar::instalar_livekit)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn abrir_firewall() -> Result<String, String> {
    rede::abrir_firewall(config::carregar()?.porta)
}

/// A versao publicada do projeto, para comparar com a que este servidor gerou.
#[tauri::command]
async fn versao_publicada() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(distribuir::versao_publicada)
        .await
        .map_err(|e| e.to_string())?
}

/// Compila e publica os clientes deste servidor.
///
/// Demora minutos e escreve no registro enquanto anda; sai da linha da interface
/// para a janela continuar respondendo.
#[tauri::command]
async fn gerar_clientes(estado: tauri::State<'_, Estado>, versao: String) -> Result<String, String> {
    let registro = {
        let supervisor = estado.supervisor.lock().map_err(|_| "painel ocupado")?;
        supervisor.linhas.clone()
    };
    let config = config::carregar()?;
    tauri::async_runtime::spawn_blocking(move || distribuir::gerar_clientes(registro, versao, config))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn abrir_pasta(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(config::raiz().display().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Existe um ambiente capaz de compilar o instalador do cliente aqui?
///
/// Compilar exige Node, Rust, o Tauri CLI e o NSIS — varios gigabytes. O caminho
/// esperado e outro: entregar o instalador oficial e passar o endereco, que o
/// aplicativo agora aceita sem recompilar. O botao so aparece para quem ja tem
/// as ferramentas, em vez de prometer o que a maquina nao pode cumprir.
#[tauri::command]
fn ferramentas_de_build() -> Vec<String> {
    let mut faltando = Vec::new();
    for (programa, argumento) in [("node", "--version"), ("npm", "--version"), ("cargo", "--version")] {
        let achou = std::process::Command::new(programa)
            .arg(argumento)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !achou { faltando.push(programa.to_string()); }
    }
    faltando
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Estado { supervisor: Mutex::new(processos::Supervisor::default()) })
        .invoke_handler(tauri::generate_handler![
            situacao, salvar_config, iniciar, parar, registro,
            instalar_livekit, abrir_firewall, abrir_pasta, ferramentas_de_build,
            versao_publicada, gerar_clientes,
        ])
        .on_window_event(|janela, evento| {
            // Fechar a janela derruba o servidor. Deixa-lo no ar sem nada na
            // tela seria pior: ninguem lembraria de desligar, e a proxima
            // partida encontraria a porta ocupada por um processo fantasma.
            if let tauri::WindowEvent::Destroyed = evento {
                if let Some(estado) = janela.app_handle().try_state::<Estado>() {
                    if let Ok(mut supervisor) = estado.supervisor.lock() { supervisor.parar(); }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o painel");
}
