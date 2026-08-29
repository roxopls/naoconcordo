//! Captura de tela nativa via Windows.Graphics.Capture.
//!
//! Existe para nao chamar `getDisplayMedia`: e o WebView2 que desenha tanto o
//! seletor do Edge quanto a barra de "esta compartilhando sua tela". Capturando
//! por fora do navegador, os dois somem.
//!
//! O quadro sai do WGC em BGRA, vira NV12 e entra direto na fonte de video do
//! LiveKit — sem passar pela ponte do WebView2, que nao aguentaria a banda de
//! um 1080p sem compressao.

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use livekit::webrtc::{
    native::yuv_helper,
    video_frame::{NV12Buffer, VideoFrame, VideoRotation},
    video_source::native::NativeVideoSource,
};
use windows_capture::{
    capture::{CaptureControl, Context, GraphicsCaptureApiHandler},
    frame::Frame,
    graphics_capture_api::{GraphicsCaptureApi, InternalCaptureControl},
    monitor::Monitor,
    settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    },
    window::Window,
};

use super::encoder::EncoderHandle;
use super::sources::Target;

/// Para onde vai o quadro capturado.
///
/// Os dois motores de captura — WGC e duplicacao — entregam a mesma coisa: um
/// retangulo BGRA com folga de linha. O que muda daqui para a frente e quem
/// comprime, e essa escolha nao pertence ao motor de captura.
#[derive(Clone)]
pub enum Destino {
    /// O libwebrtc comprime, no processador desta maquina.
    Software(NativeVideoSource),
    /// A GPU comprime e o libwebrtc so empacota em RTP.
    Hardware(Arc<EncoderHandle>),
}

impl Destino {
    /// Converte para NV12 e entrega. `stride` e o passo de linha do BGRA de
    /// origem, que costuma ser maior que `largura * 4`.
    ///
    /// A conversao acontece nos dois caminhos porque nenhum codificador de
    /// hardware aceita BGRA na entrada; o que o hardware economiza e a
    /// compressao em si, que e a parte cara.
    pub fn entregar(&self, bgra: &[u8], stride: u32, largura: u32, altura: u32) {
        match self {
            Self::Software(source) => {
                // Um buffer novo por quadro, de proposito: o codificador
                // continua referenciando o quadro anterior depois de
                // `capture_frame` voltar, e reescrever aquela memoria
                // apareceria como rasgo na imagem.
                let mut nv12 = NV12Buffer::new(largura, altura);
                let (stride_y, stride_uv) = nv12.strides();
                let (data_y, data_uv) = nv12.data_mut();
                // O ARGB do libyuv e little-endian, entao os bytes batem com o
                // BGRA que o Windows entrega. Nao ha troca de canais a fazer.
                yuv_helper::argb_to_nv12(
                    bgra, stride, data_y, stride_y, data_uv, stride_uv,
                    largura as i32, altura as i32,
                );
                source.capture_frame(&VideoFrame::new(VideoRotation::VideoRotation0, nv12));
            }
            Self::Hardware(encoder) => {
                let pixels = largura as usize * altura as usize;
                // NV12 sem folga: plano Y inteiro, depois o UV entrelacado com
                // metade das linhas. E o formato que o MFT espera quando o
                // passo de linha e igual a largura.
                let mut nv12 = vec![0u8; pixels + pixels / 2];
                let (plano_y, plano_uv) = nv12.split_at_mut(pixels);
                yuv_helper::argb_to_nv12(
                    bgra, stride, plano_y, largura, plano_uv, largura,
                    largura as i32, altura as i32,
                );
                let agora = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_micros() as i64;
                encoder.submit(nv12, largura, altura, agora);
            }
        }
    }
}

/// Windows so obedece `SetIsBorderRequired(false)` de um processo que pediu e
/// recebeu o acesso "Borderless". Sem o pedido, a chamada nao falha nem avisa:
/// e ignorada, e a borda amarela continua desenhada por cima do jogo. O pedido
/// vale para o processo inteiro, entao e feito uma vez so.
///
/// Devolve `false` quando o Windows nega ou nao conhece a API — ai o pedido de
/// captura tem de sair com `DrawBorderSettings::Default`, porque pedir a opcao
/// sem ter o acesso derruba a captura inteira nas maquinas antigas.
/// Por que a borda amarela some numa maquina e continua noutra. Sao tres
/// condicoes independentes, e basta uma falhar para a borda ficar:
///
/// - `IsBorderRequired` so existe a partir do Windows 11 (build 22000). Em
///   Windows 10 nao ha API para tirar a borda, ponto.
/// - o processo precisa do acesso "Borderless" concedido;
/// - a propria captura precisa aceitar a opcao.
///
/// Devolve as tres, mais a versao do Windows, para o diagnostico sair da
/// adivinhacao.
pub fn borderless_diagnostico() -> (bool, bool, String) {
    let suportado = GraphicsCaptureApi::is_border_settings_supported().unwrap_or(false);
    let permitido = borderless_allowed();
    let versao = versao_windows();
    (suportado, permitido, versao)
}

/// Este Windows respeita "capturar tudo **menos** este programa"?
///
/// O loopback por processo do WASAPI exige build 20348. Abaixo disso a chamada
/// e aceita e a exclusao e simplesmente ignorada: compartilhar o monitor com
/// som devolve a propria conversa como eco, e nao ha ajuste que resolva. Quem
/// esta nessa faixa precisa escolher **um programa** — o modo de inclusao, que
/// funciona em qualquer versao.
pub fn exclusao_de_audio_confiavel() -> bool {
    numero_da_build() >= 20348
}

fn numero_da_build() -> u32 {
    versao_windows()
        .rsplit_once("build ")
        .and_then(|(_, resto)| resto.trim_end_matches(')').parse().ok())
        .unwrap_or(0)
}

/// Versao real do Windows. `GetVersionEx` mente para processos sem manifesto,
/// entao o numero sai do registro, que nao aplica compatibilidade.
fn versao_windows() -> String {
    use windows::Win32::System::Registry::{HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RegGetValueW};
    use windows::core::w;

    let mut buffer = [0u16; 128];
    let mut tamanho = (buffer.len() * 2) as u32;
    let ok = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            w!(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion"),
            w!("CurrentBuild"),
            RRF_RT_REG_SZ,
            None,
            Some(buffer.as_mut_ptr() as *mut _),
            Some(&mut tamanho),
        )
    };
    if ok.is_err() { return "desconhecida".into(); }
    let fim = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
    let build = String::from_utf16_lossy(&buffer[..fim]);
    let numero: u32 = build.parse().unwrap_or(0);
    let familia = if numero >= 22000 { "Windows 11" } else { "Windows 10" };
    format!("{familia} (build {build})")
}

fn borderless_allowed() -> bool {
    use std::sync::OnceLock;
    use windows::Graphics::Capture::{GraphicsCaptureAccess, GraphicsCaptureAccessKind};
    use windows::Security::Authorization::AppCapabilityAccess::AppCapabilityAccessStatus;

    static ALLOWED: OnceLock<bool> = OnceLock::new();
    *ALLOWED.get_or_init(|| {
        match GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless) {
            Ok(operacao) => matches!(operacao.join(), Ok(AppCapabilityAccessStatus::Allowed)),
            Err(_) => false,
        }
    })
}

/// Quanto cortar de cada lado para sobrar so a area de cliente da janela.
///
/// O WGC entrega a janela inteira, com barra de titulo e bordas. Quem so quer
/// mostrar o conteudo precisa recortar, e o recorte tem de partir dos limites
/// que o **DWM** reporta: `GetWindowRect` inclui a borda invisivel de
/// redimensionamento do Windows 10 em diante, e usar ela desalinha a imagem em
/// alguns pixels.
///
/// Devolve `(esquerda, topo, largura, altura)` em pixels da imagem capturada,
/// ou `None` quando nao da para saber — ai vale a janela inteira, como antes.
#[cfg(windows)]
fn area_de_cliente(hwnd: isize) -> Option<(u32, u32, u32, u32)> {
    use windows::Win32::Foundation::{HWND, POINT, RECT};
    use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::UI::WindowsAndMessaging::GetClientRect;

    let janela = HWND(hwnd as *mut _);
    let mut moldura = RECT::default();
    unsafe {
        DwmGetWindowAttribute(
            janela,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut moldura as *mut _ as *mut _,
            std::mem::size_of::<RECT>() as u32,
        )
    }
    .ok()?;

    let mut cliente = RECT::default();
    unsafe { GetClientRect(janela, &mut cliente) }.ok()?;
    let mut canto = POINT::default();
    if !unsafe { ClientToScreen(janela, &mut canto) }.as_bool() {
        return None;
    }

    // Dimensao impar quebra a subamostragem de croma do NV12.
    let esquerda = (canto.x - moldura.left).max(0) as u32 & !1;
    let topo = (canto.y - moldura.top).max(0) as u32 & !1;
    let largura = (cliente.right - cliente.left).max(0) as u32 & !1;
    let altura = (cliente.bottom - cliente.top).max(0) as u32 & !1;
    if largura == 0 || altura == 0 {
        return None;
    }
    Some((esquerda, topo, largura, altura))
}

/// O que o manipulador precisa para trabalhar. Vai inteiro pelo campo `flags`
/// das configuracoes, porque o WGC constroi o manipulador na thread dele.
pub struct CaptureFlags {
    pub destino: Destino,
    pub stop: Arc<AtomicBool>,
    pub intervalo: std::time::Duration,
    /// Janela cuja barra de titulo deve ficar de fora, quando pedido.
    pub recortar_janela: Option<isize>,
}

pub struct ScreenCapture {
    destino: Destino,
    stop: Arc<AtomicBool>,
    /// Espaco minimo entre dois quadros entregues.
    ///
    /// O WGC entrega no ritmo do compositor, que segue a taxa do monitor. Sem
    /// este limite, um monitor de 144 Hz faz 144 conversoes BGRA->NV12 por
    /// segundo em resolucao cheia para alimentar um codificador que so quer 30
    /// ou 60 — o resto e jogado fora depois de ja ter custado CPU.
    intervalo: std::time::Duration,
    recortar_janela: Option<isize>,
    /// Prazo do proximo quadro, em cadencia fixa.
    ///
    /// Marcar "agora" a cada quadro aceito parece equivalente e **nao e**:
    /// aceitar custa alguns microssegundos, entao o quadro seguinte — que chega
    /// exatamente um periodo de tela depois — mede um fio a menos que o
    /// intervalo e e descartado. Num monitor de 60 Hz pedindo 60 fps, isso
    /// entrega 30. O prazo avanca em passos do intervalo justamente para nao
    /// herdar esse atraso.
    proximo: std::time::Instant,
}

impl GraphicsCaptureApiHandler for ScreenCapture {
    type Flags = CaptureFlags;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            destino: ctx.flags.destino,
            stop: ctx.flags.stop,
            intervalo: ctx.flags.intervalo,
            recortar_janela: ctx.flags.recortar_janela,
            // No passado para o primeiro quadro sair na hora.
            proximo: std::time::Instant::now(),
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if self.stop.load(Ordering::Relaxed) {
            capture_control.stop();
            return Ok(());
        }

        // Descartar antes de tocar no buffer: o custo esta na conversao, e
        // quadro descartado depois dela ja gastou tudo o que se queria evitar.
        //
        // A folga existe porque o quadro que chega um fio antes do prazo e o
        // quadro certo, nao um quadro adiantado: sem ela, jitter de um
        // milissegundo derruba metade da taxa.
        let agora = std::time::Instant::now();
        if agora + self.intervalo / 4 < self.proximo {
            return Ok(());
        }
        // Cadencia fixa. Se a captura engasgou e o prazo ficou para tras, volta
        // a contar de agora em vez de tentar recuperar o atraso de uma vez.
        self.proximo += self.intervalo;
        if self.proximo < agora {
            self.proximo = agora + self.intervalo;
        }

        let width = frame.width();
        let height = frame.height();
        // Dimensao impar quebra a subamostragem de croma do NV12, e a janela
        // muda de tamanho enquanto a pessoa arrasta a borda.
        let (width, height) = (width & !1, height & !1);
        if width == 0 || height == 0 {
            return Ok(());
        }

        let source_buffer = frame.buffer()?;
        let stride = source_buffer.width() * 4;
        let mut packed = Vec::new();
        let bgra = source_buffer.as_nopadding_buffer(&mut packed);

        // Recorte para a area de cliente: tira barra de titulo e bordas. O
        // `stride` continua o da imagem inteira — e assim que o libyuv anda de
        // uma linha para a outra dentro de um retangulo maior.
        let (mut width, mut height) = (width, height);
        let mut inicio = 0usize;
        if let Some(hwnd) = self.recortar_janela {
            if let Some((x, y, w, h)) = area_de_cliente(hwnd) {
                let w = w.min(width.saturating_sub(x));
                let h = h.min(height.saturating_sub(y));
                let fim = (y as usize + h as usize).saturating_sub(1) * stride as usize
                    + (x as usize + w as usize) * 4;
                // Janela redimensionada entre a medida e o quadro deixaria a
                // conta apontar para fora do buffer.
                if w >= 2 && h >= 2 && fim <= bgra.len() {
                    inicio = y as usize * stride as usize + x as usize * 4;
                    width = w;
                    height = h;
                }
            }
        }
        let bgra = &bgra[inicio..];

        self.destino.entregar(bgra, stride, width, height);
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        // A janela compartilhada fechou. Sinaliza para quem publica encerrar.
        self.stop.store(true, Ordering::Relaxed);
        Ok(())
    }
}

/// Handle vivo de uma captura, seja qual for o motor. Largar isso sem chamar
/// `stop` deixa a thread rodando, entao o publicador guarda o handle enquanto
/// estiver compartilhando.
pub enum CaptureHandle {
    /// Windows.Graphics.Capture: captura janela de verdade e e mais barato,
    /// mas desenha a borda amarela quando o Windows nao deixa desliga-la.
    Wgc {
        control: Option<CaptureControl<ScreenCapture, <ScreenCapture as GraphicsCaptureApiHandler>::Error>>,
        stop: Arc<AtomicBool>,
    },
    /// DXGI Desktop Duplication: sem borda e sem aviso, em qualquer Windows a
    /// partir do 8. Duplica o monitor; janela sai por recorte.
    Dxgi(super::dxgi::DuplicationHandle),
}

impl CaptureHandle {
    /// Por que a captura parou sozinha, quando parou. So a duplicacao sabe
    /// responder: o WGC avisa pelo `on_closed`, que ja levanta o `stop`.
    pub fn falha(&self) -> Option<String> {
        match self {
            Self::Dxgi(handle) => handle.falha(),
            Self::Wgc { .. } => None,
        }
    }

    pub fn stop(&mut self) {
        match self {
            Self::Wgc { control, stop } => {
                stop.store(true, Ordering::Relaxed);
                if let Some(control) = control.take() {
                    let _ = control.stop();
                }
            }
            Self::Dxgi(handle) => handle.stop(),
        }
    }
}

impl Drop for CaptureHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Liga a captura da fonte escolhida e manda os quadros para `source`.
///
/// Sem borda e sem janela secundaria: a borda amarela do WGC e mais um aviso
/// visual de captura, exatamente o que este trabalho veio remover.
pub fn start(
    target: Target,
    destino: Destino,
    fps: f64,
    forcar_duplicacao: bool,
    sem_barra: bool,
) -> Result<(CaptureHandle, String), String> {
    // Por que a duplicacao nao entrou, quando ela era a escolhida. Vai junto
    // na descricao que chega a interface: depurar captura em maquina alheia sem
    // isso e adivinhacao, porque build de release nao tem console.
    let mut queda: Option<String> = None;

    // Escolha do motor. O WGC e o preferido: captura a janela de verdade, sem
    // depender de ela estar visivel, e nao gasta CPU copiando a tela inteira.
    // So que nele a borda amarela e inegociavel quando este Windows nao deixa
    // desliga-la — no Windows 10 a propriedade nem existe. Nesse caso vale mais
    // trocar de motor do que entregar a tela com a moldura piscando.
    // `forcar_duplicacao` existe para testar o caminho do Windows 10 numa
    // maquina que nao precisaria dele: sem isso, o codigo que so roda la nunca
    // seria exercitado por quem o escreveu.
    if forcar_duplicacao
        || !(GraphicsCaptureApi::is_border_settings_supported().unwrap_or(false)
            && borderless_allowed())
    {
        match super::dxgi::start(target, destino.clone(), fps) {
            Ok(handle) => return Ok((CaptureHandle::Dxgi(handle), "duplicação".into())),
            // DXGI pode faltar em maquina virtual ou sessao remota. Ai o WGC
            // com borda ainda e melhor do que nao compartilhar nada.
            Err(erro) => {
                eprintln!("[captura] duplicacao indisponivel ({erro}), usando WGC");
                queda = Some(erro);
            }
        }
    }

    let stop = Arc::new(AtomicBool::new(false));
    let flags = CaptureFlags {
        destino,
        stop: stop.clone(),
        intervalo: std::time::Duration::from_secs_f64(1.0 / fps.max(1.0)),
        // So faz sentido para janela: monitor nao tem barra de titulo.
        recortar_janela: match (sem_barra, target) {
            (true, Target::Window(hwnd)) => Some(hwnd),
            _ => None,
        },
    };

    // Pedir uma opcao que o Windows daquela maquina nao conhece nao devolve a
    // opcao ignorada: devolve erro e a captura nao abre. Entao a preferencia so
    // e pedida quando existe. Em Windows mais antigo, o compartilhamento
    // funciona — com a borda amarela e o cursor no padrao do sistema.
    let border = if GraphicsCaptureApi::is_border_settings_supported().unwrap_or(false)
        && borderless_allowed()
    {
        DrawBorderSettings::WithoutBorder
    } else {
        DrawBorderSettings::Default
    };
    let cursor = if GraphicsCaptureApi::is_cursor_settings_supported().unwrap_or(false) {
        CursorCaptureSettings::WithCursor
    } else {
        CursorCaptureSettings::Default
    };

    let control = match target {
        Target::Monitor(handle) => {
            let monitor = Monitor::from_raw_hmonitor(handle as *mut _);
            ScreenCapture::start_free_threaded(Settings::new(
                monitor,
                cursor,
                border,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Default,
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                flags,
            ))
            .map_err(|e| e.to_string())?
        }
        Target::Window(handle) => {
            let window = Window::from_raw_hwnd(handle as *mut _);
            ScreenCapture::start_free_threaded(Settings::new(
                window,
                cursor,
                border,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Default,
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                flags,
            ))
            .map_err(|e| e.to_string())?
        }
    };

    let motor = match queda {
        Some(erro) => format!("WGC (duplicação indisponível: {erro})"),
        None => "WGC".to_string(),
    };
    Ok((CaptureHandle::Wgc { control: Some(control), stop }, motor))
}
