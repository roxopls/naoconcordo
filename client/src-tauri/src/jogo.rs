//! O jogo aberto agora, para o "Jogando X" da lista de gente.
//!
//! Duas fontes, na ordem de confianca:
//!
//! 1. **Steam.** Enquanto um jogo roda, a Steam escreve o id dele em
//!    `HKCU\Software\Valve\Steam\RunningAppID` e o nome em `Apps\<id>\Name`.
//!    Nome certo, sem adivinhar nada, e volta a zero quando o jogo fecha.
//! 2. **Janela em tela cheia.** Para o que nao veio da Steam: a janela em
//!    primeiro plano cobrindo o monitor inteiro e, quase sempre, um jogo. O que
//!    tambem ocupa a tela sem ser jogo (navegador com video, player, o proprio
//!    Explorer) fica numa lista de fora.
//!
//! A segunda fonte tem memoria: o jogo achado continua valendo enquanto o
//! processo dele existir. Sem isso, dar Alt+Tab para responder no chat tiraria
//! o "Jogando" de quem so saiu da tela por um segundo.

#[tauri::command]
pub fn jogo_aberto() -> Option<String> {
    #[cfg(windows)]
    {
        janela::jogo_aberto()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[cfg(windows)]
mod janela {
    use std::sync::Mutex;
    use windows::Win32::Foundation::{CloseHandle, HWND, RECT};
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow};
    use windows::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RRF_RT_REG_SZ, RegGetValueW};
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId};
    use windows::core::{HSTRING, PWSTR, w};

    /// Programas que ocupam a tela inteira sem ser jogo.
    const NAO_E_JOGO: &[&str] = &[
        "explorer.exe", "naoconcordo.exe", "msedgewebview2.exe",
        "chrome.exe", "msedge.exe", "firefox.exe", "opera.exe", "opera_gx.exe", "brave.exe", "vivaldi.exe",
        "vlc.exe", "mpv.exe", "mpc-hc.exe", "mpc-hc64.exe", "mpc-be64.exe", "potplayermini64.exe", "potplayermini.exe",
        "obs64.exe", "discord.exe", "steamwebhelper.exe", "applicationframehost.exe", "video.ui.exe",
        "powerpnt.exe", "lockapp.exe", "searchhost.exe", "shellexperiencehost.exe", "startmenuexperiencehost.exe",
        "textinputhost.exe", "screenclippinghost.exe", "snippingtool.exe",
    ];
    /// Processo STILL_ACTIVE de `GetExitCodeProcess`.
    const AINDA_RODANDO: u32 = 259;

    /// O ultimo jogo achado pela tela cheia: (pid, nome).
    static LEMBRADO: Mutex<Option<(u32, String)>> = Mutex::new(None);

    pub fn jogo_aberto() -> Option<String> {
        if let Some(nome) = jogo_da_steam() { return Some(nome); }
        let mut lembrado = LEMBRADO.lock().ok()?;
        if let Some(achado) = tela_cheia_agora() { *lembrado = Some(achado); }
        match lembrado.as_ref() {
            Some((pid, nome)) if processo_vivo(*pid) => Some(nome.clone()),
            _ => { *lembrado = None; None }
        }
    }

    fn jogo_da_steam() -> Option<String> {
        let mut id = 0u32;
        let mut tamanho = 4u32;
        let ok = unsafe {
            RegGetValueW(HKEY_CURRENT_USER, w!(r"Software\Valve\Steam"), w!("RunningAppID"), RRF_RT_REG_DWORD,
                None, Some(&mut id as *mut u32 as *mut _), Some(&mut tamanho))
        };
        if ok.is_err() || id == 0 { return None; }
        let mut buffer = [0u16; 256];
        let mut tamanho = (buffer.len() * 2) as u32;
        let chave = HSTRING::from(format!(r"Software\Valve\Steam\Apps\{id}"));
        let ok = unsafe {
            RegGetValueW(HKEY_CURRENT_USER, &chave, w!("Name"), RRF_RT_REG_SZ,
                None, Some(buffer.as_mut_ptr() as *mut _), Some(&mut tamanho))
        };
        if ok.is_err() { return None; }
        let fim = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
        Some(String::from_utf16_lossy(&buffer[..fim])).filter(|nome| !nome.trim().is_empty())
    }

    fn tela_cheia_agora() -> Option<(u32, String)> {
        let janela: HWND = unsafe { GetForegroundWindow() };
        if janela.is_invalid() { return None; }
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(janela, Some(&mut pid)) };
        if pid == 0 || pid == std::process::id() { return None; }
        if !cobre_o_monitor(janela) { return None; }
        let exe = caminho_do_processo(pid)?;
        let arquivo = exe.rsplit(['\\', '/']).next().unwrap_or(&exe).to_lowercase();
        if NAO_E_JOGO.contains(&arquivo.as_str()) { return None; }
        // O titulo da janela e o nome do jogo quase sempre. Quando nao tem
        // titulo, o nome do executavel sem a extensao e o melhor que sobra.
        let mut titulo = [0u16; 256];
        let n = unsafe { GetWindowTextW(janela, &mut titulo) }.max(0) as usize;
        let nome = String::from_utf16_lossy(&titulo[..n]).trim().to_string();
        let nome = if nome.is_empty() {
            exe.rsplit(['\\', '/']).next().unwrap_or(&exe).trim_end_matches(".exe").trim_end_matches(".EXE").to_string()
        } else { nome };
        Some((pid, nome))
    }

    fn cobre_o_monitor(janela: HWND) -> bool {
        let mut retangulo = RECT::default();
        if unsafe { GetWindowRect(janela, &mut retangulo) }.is_err() { return false; }
        let monitor = unsafe { MonitorFromWindow(janela, MONITOR_DEFAULTTONEAREST) };
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() { return false; }
        let tela = info.rcMonitor;
        retangulo.left <= tela.left && retangulo.top <= tela.top
            && retangulo.right >= tela.right && retangulo.bottom >= tela.bottom
    }

    fn caminho_do_processo(pid: u32) -> Option<String> {
        let processo = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
        let mut buffer = [0u16; 1024];
        let mut tamanho = buffer.len() as u32;
        let ok = unsafe { QueryFullProcessImageNameW(processo, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut tamanho) };
        let _ = unsafe { CloseHandle(processo) };
        ok.ok()?;
        Some(String::from_utf16_lossy(&buffer[..tamanho as usize]))
    }

    fn processo_vivo(pid: u32) -> bool {
        let Ok(processo) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else { return false; };
        let mut codigo = 0u32;
        let ok = unsafe { GetExitCodeProcess(processo, &mut codigo) };
        let _ = unsafe { CloseHandle(processo) };
        ok.is_ok() && codigo == AINDA_RODANDO
    }
}
