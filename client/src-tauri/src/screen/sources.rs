//! Enumeracao das fontes de captura: monitores e janelas.
//!
//! Isso existe para substituir o seletor do WebView2. Quem escolhe o que
//! compartilhar e a nossa propria tela em HTML, alimentada por estas listas.

use serde::{Deserialize, Serialize};
use windows_capture::{monitor::Monitor, window::Window};

/// Uma fonte que pode ser compartilhada. O `id` volta para o Rust quando a
/// pessoa escolhe, entao precisa sobreviver a ida e volta pelo JSON.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub kind: &'static str,
    pub title: String,
    pub app: String,
    pub width: u32,
    pub height: u32,
}

/// Referencia resolvida para o capturador. Separada de `Source` porque handle
/// de sistema nao atravessa o JSON.
#[derive(Clone, Copy, Debug, Deserialize)]
pub enum Target {
    Monitor(isize),
    Window(isize),
}

impl Target {
    /// Le o `id` que a interface devolveu. Formato `monitor:<handle>` ou
    /// `window:<handle>`.
    pub fn parse(id: &str) -> Result<Self, String> {
        let (kind, raw) = id.split_once(':').ok_or_else(|| format!("fonte invalida: {id}"))?;
        let handle: isize = raw.parse().map_err(|_| format!("fonte invalida: {id}"))?;
        match kind {
            "monitor" => Ok(Self::Monitor(handle)),
            "window" => Ok(Self::Window(handle)),
            _ => Err(format!("fonte invalida: {id}")),
        }
    }

    /// Confere se a fonte ainda existe. Uma janela pode fechar entre a escolha
    /// e o inicio da captura.
    pub fn is_alive(&self) -> bool {
        match *self {
            Self::Window(handle) => Window::from_raw_hwnd(handle as *mut _).is_valid(),
            Self::Monitor(handle) => {
                Monitor::from_raw_hmonitor(handle as *mut _).width().is_ok()
            }
        }
    }
}

/// Monitores primeiro, depois janelas em ordem alfabetica: a lista fica estavel
/// entre chamadas, entao a grade nao dança na cara de quem esta escolhendo.
#[tauri::command]
pub fn screen_sources() -> Result<Vec<Source>, String> {
    let mut sources = Vec::new();

    for monitor in Monitor::enumerate().map_err(|e| e.to_string())? {
        let index = monitor.index().unwrap_or(0);
        let name = monitor.name().unwrap_or_else(|_| format!("Monitor {index}"));
        sources.push(Source {
            id: format!("monitor:{}", monitor.as_raw_hmonitor() as isize),
            kind: "monitor",
            title: name,
            app: monitor.device_string().unwrap_or_default(),
            width: monitor.width().unwrap_or(0),
            height: monitor.height().unwrap_or(0),
        });
    }

    let mut windows: Vec<Source> = Window::enumerate()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter_map(|window| {
            let title = window.title().ok()?;
            // Janela sem titulo nao da para descrever na grade, e janela nossa
            // vira espelho infinito se a pessoa escolher sem querer.
            if title.trim().is_empty() { return None; }
            let app = window.process_name().unwrap_or_default();
            if app.eq_ignore_ascii_case("naoconcordo.exe") { return None; }
            let width = window.width().ok()?;
            let height = window.height().ok()?;
            if width <= 0 || height <= 0 { return None; }
            Some(Source {
                id: format!("window:{}", window.as_raw_hwnd() as isize),
                kind: "window",
                title,
                app,
                width: width as u32,
                height: height as u32,
            })
        })
        .collect();
    windows.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));

    sources.append(&mut windows);
    Ok(sources)
}
