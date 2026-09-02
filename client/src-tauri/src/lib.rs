mod salvar;
mod screen;
mod uso;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};

/// Rotulo da janela principal. A segunda janela ("cameras") fecha de verdade;
/// so a principal e que vai para a bandeja.
const PRINCIPAL: &str = "main";

/// Traz a janela de volta. `show` sozinho deixa ela atras das outras, e
/// `unminimize` e preciso porque esconder uma janela minimizada guarda esse
/// estado — sem isso ela reaparece na barra sem nunca desenhar.
fn mostrar_janela(app: &AppHandle) {
    if let Some(janela) = app.get_webview_window(PRINCIPAL) {
        let _ = janela.unminimize();
        let _ = janela.show();
        let _ = janela.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Um aplicativo por maquina. Precisa ser o primeiro plugin: ele decide
        // se este processo continua vivo antes de qualquer outra coisa subir.
        //
        // Fechar a janela manda para a bandeja em vez de encerrar, entao quem
        // achava que tinha fechado clicava no atalho de novo e ganhava um
        // segundo aplicativo inteiro — duas conexoes de voz da mesma pessoa,
        // uma ouvindo a outra. Agora a segunda partida so traz a janela que ja
        // existe de volta.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            mostrar_janela(app);
        }))
        // Atualizacao automatica: o pacote precisa estar assinado com a chave
        // privada do updater, que fica fora do repositorio e fora do servidor.
        // Abrir junto com o Windows. Fica desligado ate a pessoa marcar nas
        // configuracoes: aplicativo que se instala na inicializacao sozinho e
        // exatamente o que ninguem quer.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(screen::ShareState::default())
        .invoke_handler(tauri::generate_handler![
            uso::uso_de_recursos,
            salvar::salvar_em_downloads,
            screen::sources::screen_sources,
            screen::screen_border_diag,
            screen::screen_thumbnail,
            screen::screen_share_start,
            screen::screen_share_switch,
            screen::screen_share_pause,
            screen::screen_target_alive,
            screen::screen_share_stats,
            screen::screen_share_stop,
        ])
        // Fechar esconde em vez de encerrar: quem fecha a janela quase sempre
        // quer parar de ver, nao sair da chamada nem deixar de receber
        // mensagem. Sair de verdade fica no menu da bandeja.
        .on_window_event(|janela, evento| {
            if let WindowEvent::CloseRequested { api, .. } = evento {
                if janela.label() == PRINCIPAL {
                    api.prevent_close();
                    let _ = janela.hide();
                }
            }
        })
        .setup(|app| {
            let abrir = MenuItem::with_id(app, "abrir", "Abrir naoconcordo", true, None::<&str>)?;
            let sair = MenuItem::with_id(app, "sair", "Sair", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&abrir, &sair])?;
            let mut tray = TrayIconBuilder::new()
                .tooltip("naoconcordo")
                .menu(&menu)
                // Sem isso o clique esquerdo abriria o menu, e o caminho curto
                // para voltar ao app viraria dois cliques.
                .show_menu_on_left_click(false)
                .on_menu_event(|app, evento| match evento.id.as_ref() {
                    "abrir" => mostrar_janela(app),
                    "sair" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, evento| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = evento
                    {
                        mostrar_janela(tray.app_handle());
                    }
                });
            if let Some(icone) = app.default_window_icon() {
                tray = tray.icon(icone.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erro ao executar o naoconcordo");
}
