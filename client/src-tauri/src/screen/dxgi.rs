//! Captura por DXGI Desktop Duplication, para Windows sem borda desligavel.
//!
//! O `Windows.Graphics.Capture` desenha a borda amarela e so aceita desliga-la
//! a partir do Windows 11 build 22000: no Windows 10 a propriedade
//! `IsBorderRequired` nao existe, entao nao ha o que pedir. Esta e a mesma API
//! que o OBS usa no "Display Capture", disponivel desde o Windows 8, e ela
//! **nao desenha aviso nenhum**.
//!
//! A contrapartida e que ela duplica um **monitor inteiro**, nunca uma janela.
//! Para compartilhar so uma janela, o quadro do monitor e recortado no
//! retangulo dela, relido a cada quadro porque a janela pode ser movida ou
//! redimensionada. Isso traz duas limitacoes que o WGC nao tem: o que passar
//! por cima aparece no recorte, e janela minimizada nao rende imagem.

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use windows::Win32::Foundation::{HMODULE, HWND, RECT};
use windows::Win32::System::Performance::QueryPerformanceFrequency;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ,
    D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_DESC,
    DXGI_OUTDUPL_FRAME_INFO, IDXGIFactory1, IDXGIOutput1, IDXGIOutputDuplication, IDXGIResource,
};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, HMONITOR, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow,
};
use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
use windows::core::Interface;

use super::capture::Destino;
use super::sources::Target;

/// Handle vivo de uma duplicacao. Igual ao do WGC: largar sem parar deixaria a
/// thread desenhando quadros para uma faixa que ja morreu.
pub struct DuplicationHandle {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    /// Por que a duplicacao parou, quando parou sozinha.
    falha: Arc<std::sync::Mutex<Option<String>>>,
    contagem: Arc<super::capture::Contagem>,
}

impl DuplicationHandle {
    pub fn falha(&self) -> Option<String> {
        self.falha.lock().ok().and_then(|vaga| vaga.clone())
    }

    pub fn contagem(&self) -> (u64, u64, u64, u64) {
        self.contagem.ler()
    }

    /// O mesmo sinal de parada do laco, para a cadencia encerrar junto.
    pub fn parada(&self) -> Arc<AtomicBool> {
        self.stop.clone()
    }
}

impl DuplicationHandle {
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for DuplicationHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// O monitor que interessa para este alvo, e a janela a recortar.
///
/// Monitor: o proprio, sem recorte. Janela: o monitor onde ela esta, com o
/// retangulo dela como recorte.
fn monitor_do_alvo(target: Target) -> (HMONITOR, Option<HWND>) {
    match target {
        Target::Monitor(handle) => (HMONITOR(handle as *mut _), None),
        Target::Window(handle) => {
            let janela = HWND(handle as *mut _);
            let monitor = unsafe { MonitorFromWindow(janela, MONITOR_DEFAULTTONEAREST) };
            (monitor, Some(janela))
        }
    }
}

/// Onde o monitor comeca na area de trabalho virtual. O retangulo da janela vem
/// em coordenadas dessa area, e o quadro duplicado comeca no canto do monitor.
fn origem_do_monitor(monitor: HMONITOR) -> Result<(i32, i32), String> {
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    let ok = unsafe { GetMonitorInfoW(monitor, &mut info) };
    if !ok.as_bool() {
        return Err("Nao foi possivel ler o monitor.".into());
    }
    Ok((info.rcMonitor.left, info.rcMonitor.top))
}

/// Abre a duplicacao do monitor pedido.
fn abrir(
    monitor: HMONITOR,
) -> Result<(ID3D11Device, ID3D11DeviceContext, IDXGIOutputDuplication), String> {
    unsafe {
        // A duplicacao e por saida de video, e a maquina pode ter varias: e
        // preciso achar a que corresponde ao HMONITOR pedido.
        //
        // O adaptador tem de ser achado **antes** do device. `DuplicateOutput`
        // exige que o device tenha sido criado no mesmo adaptador que e dono
        // daquela saida; criar no adaptador padrao e so depois procurar o
        // monitor funciona por sorte em maquina de uma placa so, e falha em
        // maquina hibrida — que e justamente a de quem nao tem placa dedicada,
        // onde a tela costuma sair pela integrada enquanto o adaptador padrao
        // e outro.
        let factory: IDXGIFactory1 =
            CreateDXGIFactory1().map_err(|e| format!("DXGI indisponivel: {e}"))?;
        let mut alvo = None;
        let mut indice_adaptador = 0;
        while let Ok(adaptador) = factory.EnumAdapters1(indice_adaptador) {
            indice_adaptador += 1;
            let mut indice_saida = 0;
            while let Ok(saida) = adaptador.EnumOutputs(indice_saida) {
                indice_saida += 1;
                let Ok(desc) = saida.GetDesc() else { continue };
                if desc.Monitor == monitor {
                    alvo = Some((adaptador.clone(), saida));
                    break;
                }
            }
            if alvo.is_some() {
                break;
            }
        }
        let Some((adaptador, saida)) = alvo else {
            return Err("Monitor nao encontrado para duplicacao.".into());
        };

        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;
        D3D11CreateDevice(
            &adaptador,
            // Com adaptador explicito o tipo tem de ser `UNKNOWN`: pedir
            // `HARDWARE` junto de um adaptador devolve E_INVALIDARG.
            D3D_DRIVER_TYPE_UNKNOWN,
            // Sem DLL de rasterizador por software: queremos a GPU.
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
        .map_err(|e| format!("Direct3D indisponivel: {e}"))?;
        let device = device.ok_or("Direct3D nao devolveu dispositivo")?;
        let context = context.ok_or("Direct3D nao devolveu contexto")?;

        let saida1: IDXGIOutput1 = saida.cast().map_err(|e| format!("Saida sem DXGI 1.1: {e}"))?;
        let dup = saida1
            .DuplicateOutput(&device)
            .map_err(|e| format!("Nao foi possivel duplicar a tela: {e}"))?;
        Ok((device, context, dup))
    }
}

/// Textura de leitura pela CPU, do tamanho do quadro duplicado.
fn textura_de_leitura(
    device: &ID3D11Device,
    largura: u32,
    altura: u32,
    formato: DXGI_FORMAT,
) -> Result<ID3D11Texture2D, String> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: largura,
        Height: altura,
        MipLevels: 1,
        ArraySize: 1,
        Format: formato,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        MiscFlags: 0,
    };
    let mut textura: Option<ID3D11Texture2D> = None;
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut textura)) }
        .map_err(|e| format!("Nao foi possivel preparar a leitura: {e}"))?;
    textura.ok_or_else(|| "Direct3D nao devolveu textura".to_string())
}

/// Comeca a duplicar e alimenta `destino` com os quadros.
pub fn start(
    target: Target,
    destino: Destino,
    fps: f64,
    contagem: Arc<super::capture::Contagem>,
    ultimo: Arc<super::capture::Ultimo>,
) -> Result<DuplicationHandle, String> {
    let (monitor, janela) = monitor_do_alvo(target);
    let (origem_x, origem_y) = origem_do_monitor(monitor)?;

    // A abertura acontece dentro da thread, mas o erro precisa voltar para quem
    // chamou: sem isso, uma maquina sem DXGI falharia em silencio e a
    // transmissao ficaria preta sem ninguem entender por que.
    let (aviso, espera) = std::sync::mpsc::channel::<Result<(), String>>();
    // Falha depois do `Ok` inicial nao tem para quem voltar: quem chamou ja
    // seguiu em frente com uma captura que parece viva. O motivo fica aqui, e o
    // painel de diagnostico o mostra — sem isso, a duplicacao morre em silencio
    // e quem compartilha so ve tela preta do outro lado.
    let falha = Arc::new(std::sync::Mutex::new(None::<String>));
    let anotar = falha.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let parar = stop.clone();

    // `HMONITOR` e `HWND` sao ponteiros e nao atravessam a fronteira da thread
    // sozinhos; o numero atravessa, e do outro lado vira handle de novo.
    let monitor_bruto = monitor.0 as isize;
    let janela_bruta = janela.map(|j| j.0 as isize);
    // Intervalo minimo entre quadros aproveitados.
    //
    // A duplicacao entrega na taxa do monitor: num 144 Hz seriam 144 copias da
    // tela inteira por segundo para alimentar um codificador que quer 60. O
    // quadro que chega cedo demais e liberado sem ser copiado — e ai o custo
    // que sobra e so o do `AcquireNextFrame`, nao o da tela inteira.
    let intervalo = std::time::Duration::from_secs_f64(1.0 / fps.max(1.0));

    let contagem_thread = contagem.clone();
    let thread = std::thread::spawn(move || {
        let contagem = contagem_thread;
        let ultimo = ultimo;
        let anotar = |motivo: String| {
            eprintln!("[captura] duplicacao encerrada: {motivo}");
            if let Ok(mut vaga) = anotar.lock() {
                *vaga = Some(motivo);
            }
        };
        let monitor = HMONITOR(monitor_bruto as *mut _);
        let janela = janela_bruta.map(|j| HWND(j as *mut _));

        let (device, context, dup) = match abrir(monitor) {
            Ok(partes) => {
                let _ = aviso.send(Ok(()));
                partes
            }
            Err(erro) => {
                let _ = aviso.send(Err(erro));
                return;
            }
        };
        // O tamanho vem da duplicacao, nao de `DesktopCoordinates`.
        //
        // `CopyResource` **nao devolve erro**: origem e destino de tamanhos ou
        // formatos diferentes viram uma copia que nao acontece, e a textura de
        // leitura segue com o que tinha — preto. Como a coordenada do desktop
        // passa por escala de DPI e a textura duplicada e em pixel fisico, num
        // notebook em 125% os dois numeros divergem e a transmissao inteira sai
        // preta, sem nenhum erro em lugar nenhum.
        let dup_desc: DXGI_OUTDUPL_DESC = unsafe { dup.GetDesc() };
        let largura_tela = dup_desc.ModeDesc.Width;
        let altura_tela = dup_desc.ModeDesc.Height;
        // Mesmo motivo: o formato tem de bater. E o resto do caminho le BGRA,
        // entao tela em 10 bits (HDR) tem de recusar aqui e deixar o WGC
        // assumir, em vez de transmitir cor embaralhada.
        if dup_desc.ModeDesc.Format != DXGI_FORMAT_B8G8R8A8_UNORM {
            anotar(format!(
                "a tela nao esta em BGRA de 8 bits (formato {:?})",
                dup_desc.ModeDesc.Format
            ));
            return;
        }
        let leitura = match textura_de_leitura(&device, largura_tela, altura_tela, dup_desc.ModeDesc.Format) {
            Ok(textura) => textura,
            Err(erro) => {
                anotar(erro);
                return;
            }
        };
        // Prazo do proximo quadro, em cadencia fixa. Marcar "agora" a cada
        // quadro aceito parece equivalente e nao e: o quadro seguinte chega um
        // periodo de tela depois e mede um fio a menos que o intervalo, entao e
        // descartado — 60 fps pedidos viram 30 entregues.
        let mut proximo = std::time::Instant::now();
        // Ritmo da fonte e relogio dos carimbos: mesmos motivos do WGC, ver
        // `ScreenCapture::folga` e `Relogio` em `capture.rs`.
        let mut ultima_chegada: Option<std::time::Instant> = None;
        let mut periodo_fonte: Option<std::time::Duration> = None;
        let mut relogio = super::capture::Relogio::novo();
        // A duplicacao conta em batidas do contador de alta resolucao, nao em
        // microssegundos.
        let batidas_por_segundo = {
            let mut f = 0i64;
            unsafe { QueryPerformanceFrequency(&mut f) }.ok();
            f
        };

        while !parar.load(Ordering::Relaxed) {
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut recurso: Option<IDXGIResource> = None;
            // 100 ms: tela parada nao gera quadro nenhum, e o laco precisa
            // acordar de tempos em tempos para ver o pedido de parada.
            if let Err(erro) = unsafe { dup.AcquireNextFrame(100, &mut info, &mut recurso) } {
                if erro.code() == DXGI_ERROR_WAIT_TIMEOUT {
                    continue;
                }
                // ACCESS_LOST vem de troca de resolucao, Ctrl+Alt+Del ou
                // mudanca de modo de tela cheia. Sair daqui para o publicador
                // perceber, em vez de girar em erro.
                anotar(if erro.code() == DXGI_ERROR_ACCESS_LOST {
                    "a duplicacao foi perdida (troca de resolucao ou tela cheia)".to_string()
                } else {
                    format!("a duplicacao parou: {erro}")
                });
                break;
            }
            let Some(recurso) = recurso else { continue };

            // Cedo demais: solta e espera o proximo, sem tocar na tela. A folga
            // vale para o quadro que chega um fio antes do prazo, que e o quadro
            // certo e nao um adiantado.
            let agora = std::time::Instant::now();
            contagem.chegados.fetch_add(1, Ordering::Relaxed);
            if let Some(anterior) = ultima_chegada {
                let medida = agora.saturating_duration_since(anterior);
                periodo_fonte = Some(match periodo_fonte {
                    Some(atual) => (atual * 7 + medida) / 8,
                    None => medida,
                });
            }
            ultima_chegada = Some(agora);
            let folga = match periodo_fonte {
                Some(periodo) => periodo.min(intervalo) / 2,
                None => intervalo / 4,
            };
            if agora + folga < proximo {
                contagem.fora_de_ritmo.fetch_add(1, Ordering::Relaxed);
                let _ = unsafe { dup.ReleaseFrame() };
                continue;
            }
            proximo += intervalo;
            if proximo < agora {
                proximo = agora + intervalo;
            }

            // Do relogio da duplicacao, antes de copiar e converter.
            let captura_us = if batidas_por_segundo > 0 {
                info.LastPresentTime * 1_000_000 / batidas_por_segundo
            } else {
                0
            };
            let timestamp_us = relogio.epoca(captura_us);

            if let Ok(quadro) = recurso.cast::<ID3D11Texture2D>() {
                unsafe { context.CopyResource(&leitura, &quadro) };
                let mut mapa = D3D11_MAPPED_SUBRESOURCE::default();
                if unsafe { context.Map(&leitura, 0, D3D11_MAP_READ, 0, Some(&mut mapa)) }.is_ok() {
                    // O recorte e relido a cada quadro: a janela pode ter sido
                    // movida ou redimensionada desde o quadro anterior.
                    let (x, y, largura, altura) =
                        recorte(janela, origem_x, origem_y, largura_tela, altura_tela);
                    if largura >= 2 && altura >= 2 {
                        enviar(&destino, &mapa, x, y, largura, altura, timestamp_us, &ultimo);
                        contagem.entregues.fetch_add(1, Ordering::Relaxed);
                    }
                    unsafe { context.Unmap(&leitura, 0) };
                }
            }
            let _ = unsafe { dup.ReleaseFrame() };
        }
    });

    match espera.recv() {
        Ok(Ok(())) => Ok(DuplicationHandle { stop, thread: Some(thread), falha, contagem }),
        Ok(Err(erro)) => Err(erro),
        Err(_) => Err("A duplicacao de tela nao iniciou.".into()),
    }
}

/// Retangulo a recortar do quadro do monitor, em pixels do proprio monitor.
/// Sem janela, e o monitor inteiro.
fn recorte(
    janela: Option<HWND>,
    origem_x: i32,
    origem_y: i32,
    largura_tela: u32,
    altura_tela: u32,
) -> (u32, u32, u32, u32) {
    let tela_inteira = (0, 0, largura_tela & !1, altura_tela & !1);
    let Some(janela) = janela else { return tela_inteira };

    let mut rect = RECT::default();
    if unsafe { GetWindowRect(janela, &mut rect) }.is_err() {
        return tela_inteira;
    }
    // Coordenadas do monitor, nao da area de trabalho virtual, e presas dentro
    // da tela: janela meio para fora leria memoria que nao pertence ao quadro.
    let esquerda = (rect.left - origem_x).max(0) as u32;
    let topo = (rect.top - origem_y).max(0) as u32;
    let direita = ((rect.right - origem_x).max(0) as u32).min(largura_tela);
    let baixo = ((rect.bottom - origem_y).max(0) as u32).min(altura_tela);
    // Dimensao impar quebra a subamostragem de croma do NV12.
    let largura = direita.saturating_sub(esquerda) & !1;
    let altura = baixo.saturating_sub(topo) & !1;
    (esquerda, topo, largura, altura)
}

/// Entrega o pedaco recortado. A conversao e a compressao ficam com o
/// `Destino`, que e o mesmo do caminho do WGC.
fn enviar(
    destino: &Destino,
    mapa: &D3D11_MAPPED_SUBRESOURCE,
    x: u32,
    y: u32,
    largura: u32,
    altura: u32,
    timestamp_us: i64,
    ultimo: &super::capture::Ultimo,
) {
    let stride = mapa.RowPitch as usize;
    let inicio = y as usize * stride + x as usize * 4;
    let total = (altura as usize - 1) * stride + largura as usize * 4;
    // SAFETY: o mapa cobre a tela inteira, e o recorte ja foi preso dentro dos
    // limites dela por `recorte`, entao o intervalo existe dentro do mapa.
    let bgra = unsafe { std::slice::from_raw_parts((mapa.pData as *const u8).add(inicio), total) };

    destino.entregar(bgra, stride as u32, largura, altura, timestamp_us, ultimo);
}
