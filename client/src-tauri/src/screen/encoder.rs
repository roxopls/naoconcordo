//! Codificacao de video por hardware, via Media Foundation.
//!
//! Ate aqui a tela era comprimida pelo libwebrtc, em software: VP8 pelo
//! processador, que e o padrao do `TrackPublishOptions`. Em 1080p60 isso come
//! nucleos inteiros da maquina de quem compartilha — justamente a maquina que
//! esta rodando o jogo que os outros querem ver.
//!
//! A crate do LiveKit nao resolve isso sozinha no Windows: o `webrtc-sys` so
//! compila o NVENC dele no braco `"linux"` do `build.rs`, e pedir
//! `VideoEncoderBackend::Nvenc` aqui cai de volta no software sem avisar. O que
//! ela oferece e o caminho de passagem: `NativeVideoSource::new_encoded` aceita
//! unidades **ja comprimidas**, e o `PassthroughVideoEncoder` do lado C++ so
//! empacota em RTP. Quem codifica passa a ser este modulo.
//!
//! Media Foundation em vez do SDK da NVIDIA porque o mesmo codigo alcanca as
//! tres marcas: `MFTEnumEx` com `MFT_ENUM_FLAG_HARDWARE` devolve o NVENC na
//! NVIDIA, o AMF na AMD e o QuickSync na Intel. O preco e menos controle fino
//! de bitrate, que para tela nao faz falta.
//!
//! O codificador vive numa thread propria. Os MFTs de hardware sao
//! **assincronos**: nao se chama `ProcessInput` quando se quer, e sim quando
//! o `METransformNeedInput` chega. Fazer esse laco na thread da captura
//! seguraria o WGC, que entrega quadro no ritmo do compositor.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use livekit::webrtc::video_frame::{EncodedFrameType, EncodedVideoCodec, EncodedVideoFrame};
use livekit::webrtc::video_source::{VideoResolution, native::NativeVideoSource};

use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoTaskMemFree, CoUninitialize};
use windows::Win32::System::Variant::{VARIANT, VT_UI4};
use windows::core::{GUID, Interface, PWSTR};

/// Codec que o hardware desta maquina aceitou.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum HwCodec {
    /// Melhor compressao por bit, o que em tela de texto e a diferenca entre
    /// legivel e borrado. Encoder de hardware so existe em GPU recente.
    Av1,
    /// A reserva: toda GPU dos ultimos dez anos codifica, e todo navegador
    /// decodifica.
    H264,
}

impl HwCodec {
    fn subtipo(self) -> GUID {
        match self {
            Self::Av1 => MFVideoFormat_AV1,
            Self::H264 => MFVideoFormat_H264,
        }
    }
    fn para_livekit(self) -> EncodedVideoCodec {
        match self {
            Self::Av1 => EncodedVideoCodec::AV1,
            Self::H264 => EncodedVideoCodec::H264,
        }
    }
    pub fn nome_livekit(self) -> &'static str {
        match self {
            Self::Av1 => "AV1",
            Self::H264 => "H264",
        }
    }
}

/// Um quadro cru esperando a vez no codificador.
struct Job {
    /// NV12 empacotado: plano Y de `largura * altura`, seguido do plano UV
    /// entrelacado de metade da altura. Sem folga de linha — e o que o MFT
    /// espera quando o `stride` e igual a largura.
    ///
    /// `Arc` porque o mesmo quadro pode sair de novo quando a tela nao produz
    /// outro: guardar para repetir nao pode custar uma copia por quadro.
    nv12: Arc<Vec<u8>>,
    largura: u32,
    altura: u32,
    timestamp_us: i64,
}

/// Codificador vivo. Largar isto para a thread encerra sozinho.
pub struct EncoderHandle {
    tx: Option<SyncSender<Job>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    codec: HwCodec,
    nome: String,
    /// Quadros que a captura produziu e o codificador nao aguentou receber.
    descartados: Arc<AtomicU64>,
    /// Pedido de quadro-chave vindo de fora do laco, para quando retomar uma
    /// transmissao pausada.
    chave: Arc<AtomicBool>,
    /// Quantos quadros-chave o codificador foi mandado produzir, e quantos
    /// pedidos vieram de quem assiste.
    ///
    /// A imagem "esfarelada" e o decodificador sem quadro de referencia: ele
    /// mostra lixo ate chegar uma chave. Saber se o pedido **chegou** separa
    /// dois defeitos diferentes: se chega e a imagem continua quebrada, o
    /// problema esta no que o codificador produz; se nao chega, o caminho de
    /// volta do WebRTC e que nao esta funcionando.
    chaves: Arc<AtomicU64>,
    pedidos_de_chave: Arc<AtomicU64>,
    /// Por que o codificador parou, quando parou sozinho. Sem isto a thread
    /// morria calada e a transmissao ficava em zero quadro sem explicacao.
    falha: Arc<std::sync::Mutex<Option<String>>>,
}

impl EncoderHandle {
    pub fn codec(&self) -> HwCodec {
        self.codec
    }
    /// Nome que o Windows da ao codificador escolhido, para o diagnostico
    /// dizer qual placa esta trabalhando.
    pub fn nome(&self) -> &str {
        &self.nome
    }
    pub fn descartados(&self) -> u64 {
        self.descartados.load(Ordering::Relaxed)
    }

    /// Quadros-chave produzidos e pedidos recebidos, nessa ordem.
    pub fn contagem_de_chaves(&self) -> (u64, u64) {
        (
            self.chaves.load(Ordering::Relaxed),
            self.pedidos_de_chave.load(Ordering::Relaxed),
        )
    }

    /// Por que o codificador parou, quando parou.
    pub fn falha(&self) -> Option<String> {
        self.falha.lock().ok().and_then(|vaga| vaga.clone())
    }

    /// Pede um quadro-chave no proximo quadro.
    ///
    /// Retomar uma transmissao pausada e o caso que precisa disto: quem estava
    /// assistindo tem so quadros de diferenca guardados, e diferenca em cima de
    /// imagem velha e um borrao. O WebRTC acabaria pedindo por conta propria,
    /// mas so depois de o outro lado tentar decodificar e falhar.
    pub fn pedir_chave(&self) {
        self.chave.store(true, Ordering::Relaxed);
    }

    /// Entrega um quadro. Devolve `false` quando a fila esta cheia — o quadro
    /// e descartado de proposito: encher a fila so aumentaria o atraso da
    /// imagem sem aumentar a taxa que o codificador da conta.
    pub fn submit(&self, nv12: Arc<Vec<u8>>, largura: u32, altura: u32, timestamp_us: i64) -> bool {
        let Some(tx) = self.tx.as_ref() else { return false };
        match tx.try_send(Job { nv12, largura, altura, timestamp_us }) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) => {
                self.descartados.fetch_add(1, Ordering::Relaxed);
                false
            }
            Err(TrySendError::Disconnected(_)) => false,
        }
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        // Soltar o remetente acorda a thread se ela estiver esperando quadro.
        self.tx = None;
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for EncoderHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// O que a pessoa escolheu nas configuracoes.
///
/// O AV1 e a melhor escolha tecnica e a mais arriscada: quem assiste precisa
/// decodificar AV1, e nem todo navegador de nem toda maquina faz isso bem. Por
/// isso a escolha e visivel em vez de escondida no codigo.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Preferencia {
    /// AV1 quando a placa tem, H.264 quando nao tem, software em ultimo caso.
    #[default]
    Auto,
    /// So H.264: compatibilidade acima de tudo.
    H264,
    /// Nem tentar o hardware.
    Software,
}

impl Preferencia {
    pub fn ler(texto: Option<&str>) -> Self {
        match texto.unwrap_or("auto") {
            "h264" => Self::H264,
            "software" => Self::Software,
            _ => Self::Auto,
        }
    }
    fn ordem(self) -> &'static [HwCodec] {
        match self {
            Self::Auto => &[HwCodec::Av1, HwCodec::H264],
            Self::H264 => &[HwCodec::H264],
            Self::Software => &[],
        }
    }
}

/// Liga o codificador de hardware, ou devolve o motivo de nao dar.
///
/// Quem nao conseguir nenhum codec volta para o caminho de software, que
/// continua inteiro.
pub fn iniciar(
    source: NativeVideoSource,
    largura: u32,
    altura: u32,
    fps: f64,
    bitrate: u64,
    preferencia: Preferencia,
) -> Result<EncoderHandle, String> {
    let ordem = preferencia.ordem();
    if ordem.is_empty() {
        return Err("codificacao por hardware desligada nas configuracoes".into());
    }
    // Fila curta de proposito: dois quadros de folga absorvem o soluco de um
    // quadro mais pesado sem deixar a imagem atrasar em relacao ao som.
    let (tx, rx) = sync_channel::<Job>(2);
    let stop = Arc::new(AtomicBool::new(false));
    let descartados = Arc::new(AtomicU64::new(0));
    let chave = Arc::new(AtomicBool::new(false));
    let chaves = Arc::new(AtomicU64::new(0));
    let pedidos_de_chave = Arc::new(AtomicU64::new(0));
    let falha = Arc::new(std::sync::Mutex::new(None::<String>));
    // A thread responde qual codec conseguiu abrir; ate ela responder, quem
    // chamou nao sabe se ha hardware.
    let (pronto_tx, pronto_rx) = std::sync::mpsc::channel::<Result<(HwCodec, String), String>>();

    let stop_thread = stop.clone();
    let chave_thread = chave.clone();
    let chaves_thread = chaves.clone();
    let pedidos_thread = pedidos_de_chave.clone();
    let falha_thread = falha.clone();
    let thread = std::thread::Builder::new()
        .name("tela-encoder".into())
        .spawn(move || {
            rodar(
                source, rx, stop_thread, chave_thread, chaves_thread, pedidos_thread,
                falha_thread, pronto_tx, ordem, largura, altura, fps, bitrate,
            );
        })
        .map_err(|e| format!("Nao foi possivel criar a thread do codificador: {e}"))?;

    // A abertura do MFT e rapida, mas nao instantanea: o driver da placa entra
    // no caminho, e agora ainda ha o quadro de teste. Generoso e finito.
    match pronto_rx.recv_timeout(Duration::from_secs(8)) {
        Ok(Ok((codec, nome))) => Ok(EncoderHandle {
            tx: Some(tx),
            stop,
            thread: Some(thread),
            codec,
            nome,
            descartados,
            chave,
            chaves,
            pedidos_de_chave,
            falha,
        }),
        Ok(Err(erro)) => {
            stop.store(true, Ordering::Relaxed);
            drop(tx);
            let _ = thread.join();
            Err(erro)
        }
        Err(_) => {
            stop.store(true, Ordering::Relaxed);
            drop(tx);
            Err("O codificador de hardware nao respondeu a tempo.".into())
        }
    }
}

/// Tudo o que roda na thread do codificador. O COM e o Media Foundation sao
/// iniciados aqui dentro porque o MFT so pode ser usado na thread que o criou.
#[allow(clippy::too_many_arguments)]
fn rodar(
    source: NativeVideoSource,
    rx: Receiver<Job>,
    stop: Arc<AtomicBool>,
    chave: Arc<AtomicBool>,
    chaves: Arc<AtomicU64>,
    pedidos_de_chave: Arc<AtomicU64>,
    falha: Arc<std::sync::Mutex<Option<String>>>,
    pronto: std::sync::mpsc::Sender<Result<(HwCodec, String), String>>,
    ordem: &'static [HwCodec],
    largura: u32,
    altura: u32,
    fps: f64,
    bitrate: u64,
) {
    unsafe {
        // `S_FALSE` significa "esta thread ja estava em apartamento": nao e
        // erro, e nao muda nada para nos.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        if let Err(erro) = MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET) {
            let _ = pronto.send(Err(format!("Media Foundation indisponivel: {erro}")));
            CoUninitialize();
            return;
        }

        let mut mft = match Mft::abrir(ordem, largura, altura, fps, bitrate) {
            Ok(mft) => mft,
            Err(erro) => {
                let _ = pronto.send(Err(erro));
                let _ = MFShutdown();
                CoUninitialize();
                return;
            }
        };
        // Abrir o MFT nao prova que ele codifica. Ha maquina que anuncia
        // codificador de hardware e engasga no primeiro quadro — e como a faixa
        // ja vai publicada como pre-comprimida, falhar depois nao tem volta:
        // o video morre calado e quem compartilha nao descobre. Um quadro preto
        // de teste antes de responder transforma isso em fallback para
        // software, que e o que a pessoa espera de um programa que funciona.
        if let Err(erro) = mft.provar() {
            let _ = pronto.send(Err(format!("{} nao codificou o quadro de teste: {erro}", mft.nome)));
            mft.encerrar();
            drop(mft);
            let _ = MFShutdown();
            CoUninitialize();
            return;
        }
        let _ = pronto.send(Ok((mft.codec, mft.nome.clone())));

        laco(
            &source, &rx, &stop, &chave, &chaves, &pedidos_de_chave, &falha, &mut mft, ordem,
            fps, bitrate,
        );

        mft.encerrar();
        drop(mft);
        let _ = MFShutdown();
        CoUninitialize();
    }
}

/// O laco de trabalho: eventos do MFT de um lado, quadros da captura do outro.
#[allow(clippy::too_many_arguments)]
unsafe fn laco(
    source: &NativeVideoSource,
    rx: &Receiver<Job>,
    stop: &AtomicBool,
    chave: &AtomicBool,
    chaves: &AtomicU64,
    pedidos_de_chave: &AtomicU64,
    falha: &std::sync::Mutex<Option<String>>,
    mft: &mut Mft,
    ordem: &'static [HwCodec],
    fps: f64,
    bitrate_inicial: u64,
) {
    let anotar = |motivo: String| {
        eprintln!("[encoder] {motivo}");
        if let Ok(mut vaga) = falha.lock() {
            *vaga = Some(motivo);
        }
    };
    let _ = ordem;
    // Quantos `METransformNeedInput` chegaram sem quadro para responder. O MFT
    // enfileira esses pedidos, e responder fora de ordem trava a codificacao.
    let mut precisa_entrada = 0usize;
    let mut forcar_chave = false;
    let mut bitrate_atual = bitrate_inicial;
    // Quadro recusado seguido. Um sozinho e soluco; muitos em sequencia sao
    // codificador morto — e ai vale desistir e dizer por que.
    let mut recusas = 0u32;

    while !stop.load(Ordering::Relaxed) {
        // Pedido de bitrate e de quadro-chave valem para os dois modos.
        if let Some(pedido) = source.take_rate_control_request() {
            let alvo = pedido.target_bitrate_bps.max(200_000);
            if alvo.abs_diff(bitrate_atual) * 20 > bitrate_atual {
                bitrate_atual = alvo;
                unsafe { mft.definir_bitrate(alvo) };
            }
        }
        // Contados separadamente: o pedido vem de quem assiste, e a chave e o
        // que de fato saiu daqui. Os dois numeros juntos dizem em que ponto o
        // conserto do "esfarelado" esta falhando.
        if source.take_keyframe_request() {
            pedidos_de_chave.fetch_add(1, Ordering::Relaxed);
            forcar_chave = true;
        }
        if chave.swap(false, Ordering::Relaxed) {
            forcar_chave = true;
        }

        // Codificador sincrono nao anuncia nada: recebe quadro, entrega, puxa
        // a saida. E o caminho de boa parte das placas em Windows 10.
        if !mft.assincrono {
            match rx.recv_timeout(Duration::from_millis(15)) {
                Ok(job) => {
                    if job.largura != mft.largura || job.altura != mft.altura {
                        if let Err(erro) = unsafe { trocar_tamanho(mft, &job, fps, bitrate_atual) } {
                            anotar(erro);
                            return;
                        }
                        forcar_chave = true;
                        continue;
                    }
                    if forcar_chave {
                        unsafe { mft.forcar_chave() };
                        chaves.fetch_add(1, Ordering::Relaxed);
                        forcar_chave = false;
                    }
                    if let Err(erro) = unsafe { entregar_com_folga(mft, source, &job) } {
                        recusas += 1;
                        if recusas >= 120 {
                            anotar(format!("quadro recusado {recusas} vezes seguidas: {erro}"));
                            return;
                        }
                        continue;
                    }
                    recusas = 0;
                    unsafe { mft.drenar_tudo(source) };
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
            }
            continue;
        }

        // 1. Eventos do codificador primeiro: sair de `HaveOutput` pendente
        //    libera o buffer interno da placa.
        let mut houve_evento = false;
        while let Some(tipo) = unsafe { mft.proximo_evento() } {
            houve_evento = true;
            if tipo == METransformNeedInput.0 as u32 {
                precisa_entrada += 1;
            } else if tipo == METransformHaveOutput.0 as u32 {
                unsafe { mft.drenar_saida(source) };
            }
        }

        // 2. Um quadro por pedido de entrada.
        if precisa_entrada > 0 {
            match rx.recv_timeout(Duration::from_millis(15)) {
                Ok(job) => {
                    // Janela redimensionada: o MFT nasce amarrado a um tamanho,
                    // entao a troca e um codificador novo — e o primeiro quadro
                    // dele tem de ser chave, senao quem assiste fica no lixo do
                    // tamanho antigo.
                    if job.largura != mft.largura || job.altura != mft.altura {
                        if let Err(erro) = unsafe { trocar_tamanho(mft, &job, fps, bitrate_atual) } {
                            anotar(erro);
                            return;
                        }
                        precisa_entrada = 0;
                        forcar_chave = true;
                        continue;
                    }
                    if forcar_chave {
                        unsafe { mft.forcar_chave() };
                        chaves.fetch_add(1, Ordering::Relaxed);
                        forcar_chave = false;
                    }
                    if let Err(erro) = unsafe { entregar_com_folga(mft, source, &job) } {
                        recusas += 1;
                        if recusas >= 120 {
                            anotar(format!("quadro recusado {recusas} vezes seguidas: {erro}"));
                            return;
                        }
                        continue;
                    }
                    recusas = 0;
                    precisa_entrada -= 1;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                // A captura acabou.
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
            }
        } else if !houve_evento {
            // Nada a fazer: sem esta pausa o laco viraria espera ocupada, que e
            // exatamente a CPU que este modulo veio economizar.
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}

/// Entrega um quadro, e se o codificador recusar, tira a saida presa e tenta
/// de novo.
///
/// "Nao aceita mais entrada" e o erro de quem entrega um quadro sem ter tirado
/// o resultado do anterior. E recuperavel: drenar resolve. Antes ele matava a
/// thread do codificador — a transmissao morria pelo resto da chamada por
/// causa do soluco de um quadro so.
unsafe fn entregar_com_folga(
    mft: &Mft,
    source: &NativeVideoSource,
    job: &Job,
) -> Result<(), String> {
    match unsafe { mft.entregar(job) } {
        Ok(()) => Ok(()),
        Err(_) => {
            unsafe { mft.drenar_tudo(source) };
            unsafe { mft.entregar(job) }
        }
    }
}

/// Troca o tamanho **recriando** o codificador, e nao reconfigurando o que ja
/// existe.
///
/// O MFT nasce com o tamanho do grau de qualidade escolhido, mas a captura
/// entrega o tamanho real da tela — e os dois so coincidem por acaso. Boa parte
/// dos codificadores de hardware recusa `SetOutputType` depois que o fluxo
/// comecou, entao reconfigurar no lugar falhava no primeiro quadro e a thread
/// morria calada: a transmissao ficava em zero quadro para sempre, sem erro em
/// lugar nenhum.
///
/// O codec e mantido de proposito: a faixa ja foi publicada com ele, e trocar
/// aqui deixaria quem assiste com um fluxo que o decodificador dele nao
/// entende.
unsafe fn trocar_tamanho(mft: &mut Mft, job: &Job, fps: f64, bitrate: u64) -> Result<(), String> {
    let codec = mft.codec;
    let novo = unsafe { Mft::abrir_codec(codec, job.largura, job.altura, fps, bitrate) }
        .map_err(|e| format!("nao foi possivel recriar em {}x{}: {e}", job.largura, job.altura))?;
    let mut velho = std::mem::replace(mft, novo);
    unsafe { velho.encerrar() };
    drop(velho);
    Ok(())
}

/// O codificador em si, com o que precisa ser lembrado entre quadros.
struct Mft {
    transform: IMFTransform,
    eventos: Option<IMFMediaEventGenerator>,
    codec_api: Option<ICodecAPI>,
    codec: HwCodec,
    nome: String,
    largura: u32,
    altura: u32,
    /// O MFT de hardware entrega as amostras de saida dele. Guardado porque um
    /// MFT que nao entrega exige buffer nosso a cada `ProcessOutput`.
    entrega_amostras: bool,
    /// MFT assincrono avisa por evento quando quer quadro e quando tem saida.
    /// O sincrono nao avisa nada: e chamar `ProcessInput` e depois puxar a
    /// saida ate ela acabar. Os dois existem em hardware, e tratar so o
    /// primeiro fazia a placa do outro tipo ser descartada como se nao
    /// funcionasse.
    assincrono: bool,
}

impl Mft {
    /// Abre o melhor codificador disponivel, do mais economico ao mais
    /// compativel.
    unsafe fn abrir(
        ordem: &[HwCodec],
        largura: u32,
        altura: u32,
        fps: f64,
        bitrate: u64,
    ) -> Result<Self, String> {
        let mut ultimo = String::from("nenhum codificador de hardware encontrado");
        for &codec in ordem {
            match unsafe { Self::abrir_codec(codec, largura, altura, fps, bitrate) } {
                Ok(mft) => return Ok(mft),
                Err(erro) => {
                    ultimo = format!("{}: {erro}", codec.nome_livekit());
                    eprintln!("[encoder] {ultimo}");
                }
            }
        }
        Err(ultimo)
    }

    unsafe fn abrir_codec(
        codec: HwCodec,
        largura: u32,
        altura: u32,
        fps: f64,
        bitrate: u64,
    ) -> Result<Self, String> {
        let entrada = MFT_REGISTER_TYPE_INFO {
            guidMajorType: MFMediaType_Video,
            guidSubtype: MFVideoFormat_NV12,
        };
        let saida = MFT_REGISTER_TYPE_INFO {
            guidMajorType: MFMediaType_Video,
            guidSubtype: codec.subtipo(),
        };

        let mut activates: *mut Option<IMFActivate> = std::ptr::null_mut();
        let mut quantos = 0u32;
        unsafe {
            MFTEnumEx(
                MFT_CATEGORY_VIDEO_ENCODER,
                // So hardware: um "encoder" de software aqui seria trocar seis
                // por meia duzia, com o custo extra da copia de ida e volta.
                MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
                Some(&entrada),
                Some(&saida),
                &mut activates,
                &mut quantos,
            )
        }
        .map_err(|e| format!("enumeracao falhou: {e}"))?;

        if activates.is_null() || quantos == 0 {
            if !activates.is_null() {
                unsafe { CoTaskMemFree(Some(activates as *const _)) };
            }
            return Err("sem codificador de hardware para este codec".into());
        }

        // A lista e nossa a partir daqui, inclusive a memoria dela. Cada
        // `IMFActivate` vem com a referencia ja contada, entao todos tem de ser
        // soltos — e nada de `ShutdownObject`: desligar o ativador derrubaria
        // junto o codificador que acabou de dar certo, que vive por conta
        // propria assim que `ActivateObject` devolve.
        let mut resultado = Err("nenhum codificador aceitou o formato".to_string());
        for indice in 0..quantos as usize {
            // SAFETY: `MFTEnumEx` prometeu `quantos` ponteiros validos, e cada
            // um e lido uma vez so — a posse passa para esta variavel, que
            // solta a referencia ao sair do escopo.
            let activate: Option<IMFActivate> = unsafe { std::ptr::read(activates.add(indice)) };
            let Some(activate) = activate else { continue };
            if resultado.is_err() {
                match unsafe { Self::montar(&activate, codec, largura, altura, fps, bitrate) } {
                    Ok(mft) => resultado = Ok(mft),
                    Err(erro) => resultado = Err(erro),
                }
            }
        }
        unsafe { CoTaskMemFree(Some(activates as *const _)) };
        resultado
    }

    unsafe fn montar(
        activate: &IMFActivate,
        codec: HwCodec,
        largura: u32,
        altura: u32,
        fps: f64,
        bitrate: u64,
    ) -> Result<Self, String> {
        let nome = unsafe {
            let mut texto = PWSTR::null();
            let mut tamanho = 0u32;
            match activate.GetAllocatedString(
                &MFT_FRIENDLY_NAME_Attribute,
                &mut texto,
                &mut tamanho,
            ) {
                Ok(()) => {
                    let nome = texto.to_string().unwrap_or_default();
                    // A cadeia veio do alocador do COM e nao se solta sozinha.
                    CoTaskMemFree(Some(texto.0 as *const _));
                    nome
                }
                Err(_) => "codificador de hardware".to_string(),
            }
        };

        let transform: IMFTransform = unsafe { activate.ActivateObject() }
            .map_err(|e| format!("nao abriu ({nome}): {e}"))?;

        // MFT de hardware nasce trancado: sem o destravamento assincrono, toda
        // chamada devolve MF_E_TRANSFORM_ASYNC_LOCKED.
        // Na duvida, assincrono: so enumeramos MFT de hardware, e esses sao
        // assincronos salvo excecao. Tratar um assincrono como sincrono faz
        // `ProcessInput` ser chamado fora de hora, e o MFT devolve
        // "nao aceita mais entrada".
        let mut assincrono = true;
        if let Ok(atributos) = unsafe { transform.GetAttributes() } {
            assincrono = unsafe { atributos.GetUINT32(&MF_TRANSFORM_ASYNC) }.unwrap_or(1) == 1;
            if assincrono {
                unsafe { atributos.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1) }
                    .map_err(|e| format!("nao destravou ({nome}): {e}"))?;
            }
            // Tela em chamada e video ao vivo: nada de acumular quadros para
            // decidir melhor depois.
            let _ = unsafe { atributos.SetUINT32(&MF_LOW_LATENCY, 1) };
        }

        let mut mft = Self {
            // Só o assincrono tem fila de eventos; exigir dela do sincrono
            // recusava um codificador que funciona.
            eventos: transform.cast::<IMFMediaEventGenerator>().ok(),
            codec_api: transform.cast::<ICodecAPI>().ok(),
            transform,
            codec,
            nome,
            largura,
            altura,
            entrega_amostras: true,
            assincrono,
        };
        unsafe { mft.configurar(largura, altura, fps, bitrate) }?;
        Ok(mft)
    }

    /// Tipos de midia e controle de taxa. A saida vem antes da entrada: o MFT
    /// so sabe quais entradas aceita depois de saber o que tem de produzir.
    unsafe fn configurar(
        &mut self,
        largura: u32,
        altura: u32,
        fps: f64,
        bitrate: u64,
    ) -> Result<(), String> {
        let quadro = (u64::from(largura) << 32) | u64::from(altura);
        // Taxa como fracao exata: 59,94 e 29,97 nao cabem num inteiro, e o
        // MFT recusa taxa zero.
        let (num, den) = fracao_de_fps(fps);

        let saida = unsafe { MFCreateMediaType() }.map_err(|e| e.to_string())?;
        unsafe {
            saida.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(|e| e.to_string())?;
            saida.SetGUID(&MF_MT_SUBTYPE, &self.codec.subtipo()).map_err(|e| e.to_string())?;
            saida
                .SetUINT32(&MF_MT_AVG_BITRATE, bitrate.min(u64::from(u32::MAX)) as u32)
                .map_err(|e| e.to_string())?;
            saida.SetUINT64(&MF_MT_FRAME_SIZE, quadro).map_err(|e| e.to_string())?;
            saida
                .SetUINT64(&MF_MT_FRAME_RATE, (u64::from(num) << 32) | u64::from(den))
                .map_err(|e| e.to_string())?;
            saida
                .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
                .map_err(|e| e.to_string())?;
            if self.codec == HwCodec::H264 {
                // High perfil: o Baseline nao tem CABAC, e a diferenca aparece
                // logo em tela cheia de texto.
                let _ = saida.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32);
            }
            self.transform
                .SetOutputType(0, &saida, 0)
                .map_err(|e| format!("saida recusada ({}): {e}", self.nome))?;
        }

        let entrada = unsafe { MFCreateMediaType() }.map_err(|e| e.to_string())?;
        unsafe {
            entrada.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(|e| e.to_string())?;
            entrada.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12).map_err(|e| e.to_string())?;
            entrada.SetUINT64(&MF_MT_FRAME_SIZE, quadro).map_err(|e| e.to_string())?;
            entrada
                .SetUINT64(&MF_MT_FRAME_RATE, (u64::from(num) << 32) | u64::from(den))
                .map_err(|e| e.to_string())?;
            entrada
                .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
                .map_err(|e| e.to_string())?;
            self.transform
                .SetInputType(0, &entrada, 0)
                .map_err(|e| format!("entrada NV12 recusada ({}): {e}", self.nome))?;
        }

        if let Ok(info) = unsafe { self.transform.GetOutputStreamInfo(0) } {
            self.entrega_amostras =
                info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 != 0;
        }

        if let Some(api) = &self.codec_api {
            // Taxa constante: numa chamada quem manda e o teto de upload, nao a
            // qualidade media de um arquivo que se assiste depois.
            unsafe {
                let _ = api.SetValue(
                    &CODECAPI_AVEncCommonRateControlMode,
                    &variante_u32(eAVEncCommonRateControlMode_CBR.0 as u32),
                );
                let _ = api.SetValue(
                    &CODECAPI_AVEncCommonMeanBitRate,
                    &variante_u32(bitrate.min(u64::from(u32::MAX)) as u32),
                );
                // Grupo de imagens longo: quem pede quadro-chave aqui e o
                // WebRTC, quando alguem novo comeca a assistir ou a rede perdeu
                // pacote. Chave periodica sem pedido so gastaria banda.
                let _ = api.SetValue(
                    &CODECAPI_AVEncMPVGOPSize,
                    &variante_u32((fps.max(1.0) * 10.0) as u32),
                );
            }
        }

        unsafe {
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
            self.transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)
                .map_err(|e| e.to_string())?;
            self.transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)
                .map_err(|e| e.to_string())?;
        }
        self.largura = largura;
        self.altura = altura;
        Ok(())
    }

    /// Proximo evento do MFT, sem esperar. `None` quando a fila esta vazia.
    unsafe fn proximo_evento(&self) -> Option<u32> {
        let eventos = self.eventos.as_ref()?;
        let evento = unsafe { eventos.GetEvent(MF_EVENT_FLAG_NO_WAIT) }.ok()?;
        unsafe { evento.GetType() }.ok()
    }

    /// Puxa tudo o que houver de saida. E assim que se trabalha com o MFT
    /// sincrono: entregou um quadro, tira o que sair ate faltar entrada.
    unsafe fn drenar_tudo(&self, source: &NativeVideoSource) {
        // Teto para nao girar para sempre se o MFT devolver saida sem parar.
        for _ in 0..8 {
            let antes = unsafe { self.puxar_saida() };
            match antes {
                Some(amostra) => unsafe { self.entregar_amostra(source, amostra) },
                None => return,
            }
        }
    }

    unsafe fn definir_bitrate(&self, bps: u64) {
        if let Some(api) = &self.codec_api {
            unsafe {
                let _ = api.SetValue(
                    &CODECAPI_AVEncCommonMeanBitRate,
                    &variante_u32(bps.min(u64::from(u32::MAX)) as u32),
                );
            }
        }
    }

    unsafe fn forcar_chave(&self) {
        if let Some(api) = &self.codec_api {
            unsafe {
                let _ = api.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &variante_u32(1));
            }
        }
    }

    /// Copia o NV12 para uma amostra e entrega ao codificador.
    unsafe fn entregar(&self, job: &Job) -> Result<(), String> {
        let buffer = unsafe { MFCreateMemoryBuffer(job.nv12.len() as u32) }
            .map_err(|e| e.to_string())?;
        unsafe {
            let mut destino: *mut u8 = std::ptr::null_mut();
            buffer.Lock(&mut destino, None, None).map_err(|e| e.to_string())?;
            std::ptr::copy_nonoverlapping(job.nv12.as_ptr(), destino, job.nv12.len());
            buffer.Unlock().map_err(|e| e.to_string())?;
            buffer.SetCurrentLength(job.nv12.len() as u32).map_err(|e| e.to_string())?;

            let amostra = MFCreateSample().map_err(|e| e.to_string())?;
            amostra.AddBuffer(&buffer).map_err(|e| e.to_string())?;
            // Media Foundation conta em unidades de 100 ns.
            amostra.SetSampleTime(job.timestamp_us * 10).map_err(|e| e.to_string())?;
            self.transform.ProcessInput(0, &amostra, 0).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Limpa o que o teste deixou e **rearma o fluxo**.
    ///
    /// `COMMAND_FLUSH` sozinho e uma armadilha: num MFT assincrono ele faz o
    /// codificador parar de emitir `METransformNeedInput` ate receber
    /// `NOTIFY_START_OF_STREAM` de novo. Sem esta segunda mensagem, o teste de
    /// vida provava que a placa funciona e no gesto seguinte a desligava — o
    /// laco principal ficava esperando para sempre um pedido que nao vinha, e
    /// a transmissao saia com zero quadro.
    unsafe fn rearmar(&self) -> Result<(), String> {
        unsafe {
            self.transform
                .ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0)
                .map_err(|e| e.to_string())?;
            self.transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Codifica um quadro preto e espera a resposta. E o teste de vida do
    /// codificador, feito antes de qualquer coisa depender dele.
    unsafe fn provar(&mut self) -> Result<(), String> {
        let pixels = self.largura as usize * self.altura as usize;
        // Preto em NV12: luminancia no piso e croma no meio da escala.
        let mut preto = vec![0x10u8; pixels + pixels / 2];
        preto[pixels..].fill(0x80);
        let teste = Job { nv12: Arc::new(preto), largura: self.largura, altura: self.altura, timestamp_us: 0 };

        let limite = std::time::Instant::now() + Duration::from_secs(3);
        let mut entregue = false;

        // O sincrono nao avisa nada: entrega e puxa.
        if !self.assincrono {
            unsafe { self.entregar(&teste) }?;
            while std::time::Instant::now() < limite {
                if unsafe { self.puxar_saida() }.is_some() {
                    unsafe { self.rearmar() }?;
                    return Ok(());
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            return Err("nenhuma saida em 3s (codificador sincrono)".into());
        }

        while std::time::Instant::now() < limite {
            while let Some(tipo) = unsafe { self.proximo_evento() } {
                if tipo == METransformNeedInput.0 as u32 && !entregue {
                    unsafe { self.entregar(&teste) }?;
                    entregue = true;
                } else if tipo == METransformHaveOutput.0 as u32 {
                    // Sai amostra, existe codificador. O quadro em si nao serve
                    // para nada: a faixa ainda nem foi publicada.
                    if unsafe { self.puxar_saida() }.is_some() {
                        unsafe { self.rearmar() }?;
                        return Ok(());
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        Err(if entregue {
            "nenhuma saida em 3s".into()
        } else {
            "o codificador nunca pediu quadro".into()
        })
    }

    /// Tira uma amostra do codificador, ou `None` quando nao havia nenhuma.
    unsafe fn puxar_saida(&self) -> Option<IMFSample> {
        let mut buffers = [MFT_OUTPUT_DATA_BUFFER {
            dwStreamID: 0,
            pSample: std::mem::ManuallyDrop::new(if self.entrega_amostras {
                None
            } else {
                unsafe { MFCreateSample() }.ok()
            }),
            dwStatus: 0,
            pEvents: std::mem::ManuallyDrop::new(None),
        }];
        let mut status = 0u32;
        let resultado = unsafe { self.transform.ProcessOutput(0, &mut buffers, &mut status) };

        // A amostra e nossa a partir daqui, dando certo ou nao.
        let amostra = std::mem::ManuallyDrop::into_inner(unsafe {
            std::ptr::read(&buffers[0].pSample)
        });
        let eventos = std::mem::ManuallyDrop::into_inner(unsafe {
            std::ptr::read(&buffers[0].pEvents)
        });
        drop(eventos);
        std::mem::forget(std::mem::replace(
            &mut buffers[0].pSample,
            std::mem::ManuallyDrop::new(None),
        ));

        if let Err(erro) = resultado {
            // Falta de entrada nao e problema: o proximo `NeedInput` resolve.
            if erro.code() != MF_E_TRANSFORM_NEED_MORE_INPUT {
                eprintln!("[encoder] saida falhou: {erro}");
            }
            return None;
        }
        amostra
    }

    /// Tira uma unidade comprimida do codificador e entrega ao LiveKit.
    unsafe fn drenar_saida(&self, source: &NativeVideoSource) {
        let Some(amostra) = (unsafe { self.puxar_saida() }) else { return };
        unsafe { self.entregar_amostra(source, amostra) };
    }

    /// Manda uma amostra ja comprimida para a faixa publicada.
    unsafe fn entregar_amostra(&self, source: &NativeVideoSource, amostra: IMFSample) {
        let chave = unsafe { amostra.GetUINT32(&MFSampleExtension_CleanPoint) }.unwrap_or(0) == 1;
        let timestamp_us = unsafe { amostra.GetSampleTime() }.unwrap_or(0) / 10;

        let Ok(buffer) = (unsafe { amostra.ConvertToContiguousBuffer() }) else { return };
        unsafe {
            let mut dados: *mut u8 = std::ptr::null_mut();
            let mut tamanho = 0u32;
            if buffer.Lock(&mut dados, None, Some(&mut tamanho)).is_err() {
                return;
            }
            if tamanho > 0 {
                let payload = std::slice::from_raw_parts(dados, tamanho as usize);
                source.capture_encoded_frame(&EncodedVideoFrame {
                    codec: self.codec.para_livekit(),
                    payload,
                    timestamp_us,
                    frame_type: if chave {
                        EncodedFrameType::Key
                    } else {
                        EncodedFrameType::Delta
                    },
                    resolution: VideoResolution { width: self.largura, height: self.altura },
                    frame_metadata: None,
                });
            }
            let _ = buffer.Unlock();
        }
    }

    unsafe fn encerrar(&mut self) {
        unsafe {
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
        }
    }
}

/// Taxa de quadros como fracao. Os degraus da interface sao inteiros, mas a
/// captura pode pedir 59,94 quando o monitor e de 60 Hz de verdade.
fn fracao_de_fps(fps: f64) -> (u32, u32) {
    let arredondado = fps.round();
    if (fps - arredondado).abs() < 0.01 {
        return (arredondado.max(1.0) as u32, 1);
    }
    ((fps * 1000.0).round() as u32, 1000)
}

/// `ICodecAPI` fala em `VARIANT`, e todos os controles que usamos sao
/// inteiros sem sinal.
fn variante_u32(valor: u32) -> VARIANT {
    let mut variante = VARIANT::default();
    unsafe {
        let interno = &mut variante.Anonymous.Anonymous;
        interno.vt = VT_UI4;
        interno.Anonymous.ulVal = valor;
    }
    variante
}
