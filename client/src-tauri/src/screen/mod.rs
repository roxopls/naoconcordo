//! Compartilhamento de tela proprio, sem passar pelo WebView2.

pub mod audio;
pub mod capture;
pub mod dxgi;
pub mod encoder;
pub mod publisher;
pub mod sources;
pub mod thumbnail;

pub use publisher::ShareState;

use publisher::Quality;
use sources::Target;

/// Diagnostico da borda amarela. A borda so sai quando as tres condicoes
/// batem, e elas dependem da maquina — por isso o mesmo binario tira a borda
/// num computador e nao tira noutro.
#[tauri::command]
pub fn screen_border_diag() -> serde_json::Value {
    let (suportado, permitido, versao) = capture::borderless_diagnostico();
    serde_json::json!({
        "windows": versao,
        "suportado": suportado,
        "permitido": permitido,
        "semBorda": suportado && permitido,
        // Abaixo da build 20348 o Windows ignora a exclusao do loopback por
        // processo, e o audio do monitor volta como eco.
        "audioSemEco": capture::exclusao_de_audio_confiavel(),
    })
}

/// Gera miniatura JPEG base64 de uma janela ou monitor para o seletor.
#[tauri::command]
pub fn screen_thumbnail(source_id: String) -> Result<String, String> {
    let target = Target::parse(&source_id)?;
    thumbnail::capture_thumbnail(target)
}

/// Comeca a compartilhar. `token` e `url` vem do `/api/livekit-token` com
/// `screen: true`, pedidos pelo lado JS, que e quem tem a sessao.
#[tauri::command]
pub async fn screen_share_start(
    state: tauri::State<'_, ShareState>,
    source_id: String,
    url: String,
    token: String,
    quality: Quality,
    audio: bool,
    #[allow(non_snake_case)] forceDuplication: Option<bool>,
    #[allow(non_snake_case)] hideTitleBar: Option<bool>,
    codec: Option<String>,
    #[allow(non_snake_case)] audioSource: Option<String>,
) -> Result<String, String> {
    let target = Target::parse(&source_id)?;
    // De qual programa tirar o som. Compartilhando o monitor, o padrao e "tudo
    // menos nos" — mas ha Windows que ignora essa exclusao e devolve a propria
    // chamada como eco. Escolher um programa usa o modo de inclusao, que e
    // bem suportado, e fecha a porta para o eco.
    let audio_target = match audioSource.as_deref() {
        Some(id) if !id.is_empty() => Some(Target::parse(id)?),
        _ => None,
    };
    publisher::start(
        &state,
        target,
        audio_target,
        &url,
        &token,
        quality,
        audio,
        super::screen::encoder::Preferencia::ler(codec.as_deref()),
        forceDuplication.unwrap_or(false),
        // Sem escolha explicita, a barra sai: quem compartilha uma janela quer
        // mostrar o conteudo dela, nao a moldura do Windows.
        hideTitleBar.unwrap_or(true),
    )
    .await
}

/// Troca a tela sem interromper quem assiste.
#[tauri::command]
pub async fn screen_share_switch(
    state: tauri::State<'_, ShareState>,
    source_id: String,
) -> Result<(), String> {
    publisher::switch(&state, Target::parse(&source_id)?).await
}

/// Pausa ou retoma a transmissao sem despublicar.
#[tauri::command]
pub async fn screen_share_pause(
    state: tauri::State<'_, ShareState>,
    paused: bool,
) -> Result<bool, String> {
    publisher::set_paused(&state, paused).await
}

/// A janela capturada ainda esta viva? O lado JS pergunta de tempos em tempos
/// para avisar quando o programa transmitido foi fechado — sem isso a
/// transmissao congela e ninguem entende por que.
#[tauri::command]
pub async fn screen_target_alive(state: tauri::State<'_, ShareState>) -> Result<bool, String> {
    Ok(publisher::target_alive(&state).await)
}

#[tauri::command]
pub async fn screen_share_stats(
    state: tauri::State<'_, ShareState>,
) -> Result<Option<publisher::Estatisticas>, String> {
    Ok(publisher::estatisticas(&state).await)
}

#[tauri::command]
pub async fn screen_share_stop(state: tauri::State<'_, ShareState>) -> Result<(), String> {
    publisher::stop(&state).await;
    Ok(())
}
