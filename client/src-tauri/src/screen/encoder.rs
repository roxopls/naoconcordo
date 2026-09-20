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
use windows::Win32::System::Variant::{VARIANT, VT_BOOL, VT_UI4};
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
            Self::Auto => ordem_automatica(),
            Self::H264 => &[HwCodec::H264],
            Self::Software => &[],
        }
    }
}

const AV1_PRIMEIRO: &[HwCodec] = &[HwCodec::Av1, HwCodec::H264];
const H264_PRIMEIRO: &[HwCodec] = &[HwCodec::H264, HwCodec::Av1];

/// Em que ordem tentar os codecs, olhando de quem e a placa.
///
/// Os dois codecs ficam disponiveis para todo mundo — muda so quem vai na
/// frente, e nenhum e removido: se o primeiro nao abrir, o segundo e tentado
/// como sempre.
///
/// **NVIDIA e Intel: AV1 na frente.** O AV1 da Ada (RTX 40 para cima) e do
/// QuickSync moderno e maduro, e comprime bem melhor por bit — que em tela com
/// texto e a diferenca entre legivel e borrado. Placa que nao tem AV1 nao
/// aparece na enumeracao e cai sozinha no H.264.
///
/// **AMD: H.264 na frente.** O encoder AV1 da AMD so existe de RDNA3 (RX 7000)
/// para cima, e o caminho dele por Media Foundation e novo e pouco exercitado
/// — e acabamos de descobrir, com a RX 6600, que ate o H.264 da AMD vinha com
/// metade do controle de taxa no padrao de fabrica. Enquanto nao houver medida
/// de uma placa AMD com AV1, o palpite seguro e o caminho antigo e conhecido.
/// Vantagem de tabela: H.264 e o unico codec que todo assinante decodifica sem
/// discussao, entao a escolha que protege a AMD tambem protege quem assiste.
///
/// A leitura e feita pelo nome do codificador de AV1 que o sistema registra,
/// e nao pelo adaptador de video: o que interessa e de quem e o MFT que
/// **seria usado**, que numa maquina com duas placas nao e necessariamente o
/// dono do monitor.
fn ordem_automatica() -> &'static [HwCodec] {
    let nomes = unsafe { nomes_de_codificadores(HwCodec::Av1) };
    if nomes.is_empty() {
        // Sem AV1 nenhum: a ordem nao muda nada, mas dizer isso no log evita
        // a duvida de "por que essa maquina foi para H.264".
        eprintln!("[encoder] sem codificador AV1 de hardware; ordem: H.264");
        return H264_PRIMEIRO;
    }
    let amd = nomes
        .iter()
        .any(|nome| {
            let n = nome.to_ascii_lowercase();
            n.contains("amd") || n.contains("radeon")
        });
    eprintln!("[encoder] AV1 de hardware: [{}] -> ordem: {}", nomes.join(" | "), if amd { "H.264, AV1" } else { "AV1, H.264" });
    if amd { H264_PRIMEIRO } else { AV1_PRIMEIRO }
}

/// Nomes dos MFTs de hardware registrados para este codec, sem ativar nenhum.
///
/// `MFTEnumEx` ja devolve o nome legivel no `IMFActivate`, entao da para saber
/// de quem e a placa antes de decidir o que abrir — e sem o custo (e o risco)
/// de instanciar um codificador so para perguntar.
unsafe fn nomes_de_codificadores(codec: HwCodec) -> Vec<String> {
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
    if unsafe {
        MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
            Some(&entrada),
            Some(&saida),
            &mut activates,
            &mut quantos,
        )
    }
    .is_err()
        || activates.is_null()
    {
        return Vec::new();
    }
    let mut nomes = Vec::new();
    for indice in 0..quantos as usize {
        // SAFETY: mesma posse de `abrir_codec` — cada ponteiro e lido uma vez
        // e a referencia morre com a variavel.
        let activate: Option<IMFActivate> = unsafe { std::ptr::read(activates.add(indice)) };
        let Some(activate) = activate else { continue };
        if let Some(nome) = unsafe { nome_amigavel(&activate) } {
            nomes.push(nome);
        }
    }
    unsafe { CoTaskMemFree(Some(activates as *const _)) };
    nomes
}

/// Nome legivel de um `IMFActivate`, com a cadeia do COM devolvida ao alocador.
unsafe fn nome_amigavel(activate: &IMFActivate) -> Option<String> {
    unsafe {
        let mut texto = PWSTR::null();
        let mut tamanho = 0u32;
        activate
            .GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut texto, &mut tamanho)
            .ok()?;
        let nome = texto.to_string().unwrap_or_default();
        CoTaskMemFree(Some(texto.0 as *const _));
        Some(nome)
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
    // A ordem de verdade so e resolvida dentro da thread: descobrir de quem e
    // a placa passa por `MFTEnumEx`, e o Media Foundation so esta de pe depois
    // do `MFStartup` que a thread faz. Aqui cabe apenas a escolha que nao
    // depende dele.
    if preferencia == Preferencia::Software {
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
                falha_thread, pronto_tx, preferencia, largura, altura, fps, bitrate,
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
    preferencia: Preferencia,
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

        // Agora sim: o Media Foundation esta de pe, e da para perguntar a ele
        // quais codificadores existem antes de escolher em que ordem tenta-los.
        let ordem = preferencia.ordem();
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
        // As chaves que sairam desde a volta passada. Recolhidas com `replace`
        // porque `trocar_tamanho` troca o `Mft` inteiro: o que nao for lido
        // antes disso se perde, e um punhado de chaves a menos na conta importa
        // menos do que o numero parar de andar.
        let emitidas = mft.chaves_emitidas.replace(0);
        if emitidas > 0 {
            chaves.fetch_add(emitidas, Ordering::Relaxed);
        }

        // Pedido de bitrate e de quadro-chave valem para os dois modos.
        if let Some(pedido) = source.take_rate_control_request() {
            let alvo = pedido.target_bitrate_bps.max(200_000);
            if alvo.abs_diff(bitrate_atual) * 20 > bitrate_atual {
                bitrate_atual = alvo;
                unsafe { mft.definir_bitrate(alvo, fps) };
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
    /// A passada de linha que **este** MFT usa para ler o NV12 que mandamos.
    ///
    /// Nao e sempre a largura. Codificador de hardware costuma querer a largura
    /// alinhada para cima — 16 na maioria, 32, 64 ou 256 em alguns drivers — e
    /// como nosso NV12 vai empacotado, a conta so batia por sorte: 1920, 2560 e
    /// 3840 ja sao multiplos de 16, entao tela cheia funcionava. Janela pequena
    /// de largura 742 ou 1006 nao e, e o MFT passava a ler cada linha alguns
    /// bytes adiante da anterior — o erro se acumulava linha a linha e a imagem
    /// escorria para o lado, ate o proximo quadro-chave recomecar o estrago.
    ///
    /// O caminho de software nunca sofreu disso porque respeita a passada que o
    /// libwebrtc declara. Aqui passamos a fazer o mesmo: perguntar e obedecer.
    passo: u32,
    /// O MFT de hardware entrega as amostras de saida dele. Guardado porque um
    /// MFT que nao entrega exige buffer nosso a cada `ProcessOutput`.
    entrega_amostras: bool,
    /// SPS e PPS do H.264 — o "manual" que o decodificador precisa ler antes de
    /// entender qualquer quadro.
    ///
    /// O codificador de hardware costuma manda-los junto do primeiro
    /// quadro-chave e nao repetir. Quem estava assistindo desde o comeco tem o
    /// manual guardado; quem chegou depois, ou quem perdeu justamente aqueles
    /// pacotes, nao tem — e nenhum quadro-chave posterior o traz de volta. A
    /// imagem fica esfarelada e **nao se recupera sozinha**, por mais chaves que
    /// venham.
    ///
    /// Guardado uma vez, na configuracao da saida, e reposto na frente de todo
    /// quadro-chave. Repetir e barato (algumas dezenas de bytes) e legal: o
    /// padrao permite parametros repetidos, e todo decodificador aceita.
    cabecalho: Vec<u8>,
    /// MFT assincrono avisa por evento quando quer quadro e quando tem saida.
    /// O sincrono nao avisa nada: e chamar `ProcessInput` e depois puxar a
    /// saida ate ela acabar. Os dois existem em hardware, e tratar so o
    /// primeiro fazia a placa do outro tipo ser descartada como se nao
    /// funcionasse.
    assincrono: bool,
    /// Quadros-chave que de fato **sairam** do codificador, contados na saida
    /// pelo `MFSampleExtension_CleanPoint`.
    ///
    /// Antes o painel contava o pedido, nao a entrega: `forcar_chave` descarta
    /// o erro do `SetValue`, entao um codificador que ignora o pedido — o AMF
    /// da AMD ignora `AVEncVideoForceKeyFrame` com frequencia — aparecia com a
    /// mesma contagem de um que obedece. O laco recolhe este numero a cada
    /// volta e soma no contador compartilhado.
    chaves_emitidas: std::cell::Cell<u64>,
    /// Pedido de chave ainda nao entregue ao codificador.
    ///
    /// Alem do `ICodecAPI`, o pedido vai marcado no proprio quadro de entrada
    /// (`MFSampleExtension_ForceKeyFrame`), que e o caminho que o AMF respeita.
    chave_pendente: std::cell::Cell<bool>,
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
        let nome = unsafe { nome_amigavel(activate) }
            .unwrap_or_else(|| "codificador de hardware".to_string());

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
            // Ate o tipo de entrada ser negociado, o melhor palpite e a largura.
            passo: largura,
            entrega_amostras: true,
            cabecalho: Vec::new(),
            assincrono,
            chaves_emitidas: std::cell::Cell::new(0),
            chave_pendente: std::cell::Cell::new(false),
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

            // Lido **depois** de a saida ser aceita: e nesse momento que o
            // codificador preenche o cabecalho, com os valores que ele mesmo
            // escolheu.
            self.cabecalho.clear();
            if self.codec == HwCodec::H264 {
                if let Ok(atual) = self.transform.GetOutputCurrentType(0) {
                    if let Ok(tamanho) = atual.GetBlobSize(&MF_MT_MPEG_SEQUENCE_HEADER) {
                        let mut bytes = vec![0u8; tamanho as usize];
                        let mut escritos = 0u32;
                        if atual.GetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &mut bytes, Some(&mut escritos)).is_ok() {
                            bytes.truncate(escritos as usize);
                            self.cabecalho = bytes;
                        }
                    }
                }
            }
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
            // Dizer a passada que de fato mandamos. Sem isto o MFT calcula a
            // dele e le nosso buffer com ela.
            entrada
                .SetUINT32(&MF_MT_DEFAULT_STRIDE, self.largura)
                .map_err(|e| e.to_string())?;
            // Ha MFT que recusa passada nao alinhada. Nesse caso o tipo vai sem
            // ela e nos e que nos ajustamos: `passo_negociado` le a escolha
            // dele logo abaixo.
            if self.transform.SetInputType(0, &entrada, 0).is_err() {
                entrada.DeleteItem(&MF_MT_DEFAULT_STRIDE).map_err(|e| e.to_string())?;
                self.transform
                    .SetInputType(0, &entrada, 0)
                    .map_err(|e| format!("entrada NV12 recusada ({}): {e}", self.nome))?;
            }
            self.passo = self.passo_negociado();
        }

        if let Ok(info) = unsafe { self.transform.GetOutputStreamInfo(0) } {
            self.entrega_amostras =
                info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 != 0;
        }

        if let Some(api) = &self.codec_api {
            // Taxa constante: numa chamada quem manda e o teto de upload, nao a
            // qualidade media de um arquivo que se assiste depois.
            //
            // O que cada ajuste resolve esta anotado um a um: o AMF da AMD
            // aceita alguns e ignora outros calados, e foi por isso que a tela
            // de uma RX 6600 saia em blocos derretidos enquanto a mesma tela
            // pelo processador saia limpa. `aplicados` guarda os que o
            // codificador aceitou, e o nome que vai ao painel diz quais foram —
            // sem isso a proxima investigacao recomeca no escuro.
            let mut aplicados: Vec<&str> = Vec::new();
            let mut recusados: Vec<&str> = Vec::new();
            let mut tentar = |rotulo: &'static str, guid: &windows::core::GUID, valor: VARIANT| {
                if unsafe { api.SetValue(guid, &valor) }.is_ok() {
                    aplicados.push(rotulo);
                } else {
                    recusados.push(rotulo);
                }
            };

            tentar(
                "cbr",
                &CODECAPI_AVEncCommonRateControlMode,
                variante_u32(eAVEncCommonRateControlMode_CBR.0 as u32),
            );
            tentar(
                "bitrate",
                &CODECAPI_AVEncCommonMeanBitRate,
                variante_u32(bitrate.min(u64::from(u32::MAX)) as u32),
            );
            // Baixa latencia pelo `ICodecAPI`, e nao so pelo atributo
            // `MF_LOW_LATENCY` do MFT. Sao dois interruptores diferentes: o
            // atributo e uma dica para o pipeline, este aqui e o que o AMF le
            // para desligar lookahead e a janela longa de decisao. Sem ele o
            // controle de taxa da AMD distribui os bits olhando muito para
            // tras, e cena com movimento estoura o orcamento antes de ele
            // reagir — que e exatamente o "derretido em blocos" com o que esta
            // parado ainda nitido.
            tentar("lowlatency", &CODECAPI_AVEncCommonLowLatency, variante_bool(true));
            // Teto igual a media: em CBR de verdade os dois andam juntos. Sem
            // o teto, o AMF trata o valor medio como alvo frouxo.
            tentar(
                "maxbitrate",
                &CODECAPI_AVEncCommonMaxBitRate,
                variante_u32(bitrate.min(u64::from(u32::MAX)) as u32),
            );
            // Tamanho do balde (VBV/HRD), em bits. O padrao da AMD e grande o
            // bastante para o codificador gastar varios quadros de orcamento
            // num quadro so e passar os seguintes se recuperando — em video
            // gravado ninguem ve, numa chamada e o esfarelamento. Dois quadros
            // de folga: o suficiente para um corte de cena, pouco o bastante
            // para nao virar divida.
            let balde = ((bitrate as f64 / fps.max(1.0)) * 2.0) as u64;
            tentar(
                "vbv",
                &CODECAPI_AVEncCommonBufferSize,
                variante_u32(balde.clamp(1, u64::from(u32::MAX)) as u32),
            );
            // 0 e "o mais rapido", 100 e "o melhor". O padrao do AMF puxa para
            // a velocidade; numa GPU que esta codificando um quadro a cada
            // 16 ms com folga, essa troca nao paga.
            tentar("qualidade", &CODECAPI_AVEncCommonQualityVsSpeed, variante_u32(66));
                // Dois segundos entre quadros-chave, e nao dez.
                //
                // O raciocinio antigo era: chave so quando o WebRTC pedir, e
                // chave periodica sem pedido gasta banda. Vale numa rede que nao
                // perde pacote. Numa que perde, o pedido tambem se perde ou
                // chega atrasado — o LiveKit ainda limita quantos passa por
                // segundo — e ate a chave chegar o decodificador do outro lado
                // mostra lixo. Com dez segundos de intervalo, "lixo ate a
                // proxima chave" e ate dez segundos de imagem esfarelada.
                //
                // Dois segundos poem um teto no estrago que independe de pedido
                // nenhum chegar. Custa banda: quadro-chave e caro. Mas imagem
                // que se remonta sozinha em dois segundos e melhor do que imagem
                // limpa que, quando quebra, fica quebrada.
            tentar(
                "gop",
                &CODECAPI_AVEncMPVGOPSize,
                variante_u32((fps.max(1.0) * 2.0) as u32),
            );

            eprintln!(
                "[encoder] {}: aceitou [{}], recusou [{}]",
                self.nome,
                aplicados.join(" "),
                recusados.join(" ")
            );
            // O nome e o unico campo deste modulo que chega ao painel. Colar os
            // ajustes nele evita atravessar tres camadas so para mostrar um
            // texto, e e o que transforma "a imagem esta feia" em um relato com
            // dado dentro.
            if let Some(corte) = self.nome.find(" [") {
                self.nome.truncate(corte);
            }
            if !recusados.is_empty() {
                self.nome.push_str(&format!(" [sem: {}]", recusados.join(",")));
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

    /// Segue a estimativa de banda do WebRTC.
    ///
    /// O teto e o balde andam junto com a media: mexer so na media deixa o
    /// codificador em CBR com um balde dimensionado para a taxa antiga, que e
    /// o pior dos dois mundos — apertado quando a banda sobe, frouxo quando
    /// ela cai.
    unsafe fn definir_bitrate(&self, bps: u64, fps: f64) {
        let Some(api) = &self.codec_api else { return };
        let teto = bps.min(u64::from(u32::MAX)) as u32;
        let balde = (((bps as f64 / fps.max(1.0)) * 2.0) as u64).clamp(1, u64::from(u32::MAX)) as u32;
        unsafe {
            let _ = api.SetValue(&CODECAPI_AVEncCommonMeanBitRate, &variante_u32(teto));
            let _ = api.SetValue(&CODECAPI_AVEncCommonMaxBitRate, &variante_u32(teto));
            let _ = api.SetValue(&CODECAPI_AVEncCommonBufferSize, &variante_u32(balde));
        }
    }

    /// Pede um quadro-chave pelos dois caminhos que existem.
    ///
    /// `AVEncVideoForceKeyFrame` no `ICodecAPI` e o caminho que o NVENC segue.
    /// O AMF da AMD costuma aceitar a chamada e nao produzir chave nenhuma;
    /// o que ele respeita e a marca no proprio quadro de entrada, posta em
    /// `entregar`. Pedir pelos dois nao custa nada e nao ha efeito de pedir
    /// duas vezes: sai uma chave so.
    unsafe fn forcar_chave(&self) {
        if let Some(api) = &self.codec_api {
            unsafe {
                let _ = api.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &variante_u32(1));
            }
        }
        self.chave_pendente.set(true);
    }

    /// A passada de linha que o MFT diz que vai usar para ler a entrada.
    ///
    /// Sem resposta, ou com resposta que nao cabe, fica a largura — que e o que
    /// mandamos. Passada menor que a largura nao existe; passada absurdamente
    /// grande e sinal de valor negativo (imagem de baixo para cima) lido como
    /// `u32`, e nenhum dos dois merece confianca.
    unsafe fn passo_negociado(&self) -> u32 {
        let declarado = unsafe { self.transform.GetInputCurrentType(0) }
            .ok()
            .and_then(|tipo| unsafe { tipo.GetUINT32(&MF_MT_DEFAULT_STRIDE) }.ok());
        match declarado {
            Some(valor) if valor >= self.largura && valor <= self.largura.saturating_mul(4) => valor,
            _ => self.largura,
        }
    }

    /// Copia o NV12 para uma amostra e entrega ao codificador.
    unsafe fn entregar(&self, job: &Job) -> Result<(), String> {
        let largura = job.largura as usize;
        let altura = job.altura as usize;
        let passo = (self.passo as usize).max(largura);
        // Com passada igual a largura, o quadro ja esta no formato certo e vai
        // num `memcpy` so. Com folga, cada linha e posta no lugar dela.
        let tamanho = if passo == largura { job.nv12.len() } else { passo * (altura + altura / 2) };
        let buffer = unsafe { MFCreateMemoryBuffer(tamanho as u32) }
            .map_err(|e| e.to_string())?;
        unsafe {
            let mut destino: *mut u8 = std::ptr::null_mut();
            buffer.Lock(&mut destino, None, None).map_err(|e| e.to_string())?;
            if passo == largura {
                std::ptr::copy_nonoverlapping(job.nv12.as_ptr(), destino, job.nv12.len());
            } else {
                // A folga no fim de cada linha fica como veio: o codificador le
                // `largura` pixels por linha e nunca a mostra.
                let destino = std::slice::from_raw_parts_mut(destino, tamanho);
                let (origem_y, origem_uv) = job.nv12.split_at(largura * altura);
                let (destino_y, destino_uv) = destino.split_at_mut(passo * altura);
                copiar_com_folga(origem_y, largura, destino_y, passo, altura);
                // O plano UV entrelacado tem metade das linhas, cada uma do
                // mesmo comprimento do Y — e por isso a mesma passada.
                copiar_com_folga(origem_uv, largura, destino_uv, passo, altura / 2);
            }
            buffer.Unlock().map_err(|e| e.to_string())?;
            buffer.SetCurrentLength(tamanho as u32).map_err(|e| e.to_string())?;

            let amostra = MFCreateSample().map_err(|e| e.to_string())?;
            amostra.AddBuffer(&buffer).map_err(|e| e.to_string())?;
            // Media Foundation conta em unidades de 100 ns.
            amostra.SetSampleTime(job.timestamp_us * 10).map_err(|e| e.to_string())?;
            // A marca vai no quadro, nao no codificador: e assim que o AMF
            // aceita o pedido de chave. Limpa antes do `ProcessInput` para que
            // um erro na entrega nao deixe o pedido grudado em todo quadro
            // seguinte, o que transformaria a transmissao numa sequencia de
            // chaves e mataria a banda.
            if self.chave_pendente.replace(false) {
                let _ = amostra.SetUINT32(
                    &MFSampleExtension_VideoEncodePictureType,
                    eAVEncH264PictureType_IDR.0 as u32,
                );
            }
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

    /// O comeco de `todo` e exatamente `prefixo`?
fn comeca_com(todo: &[u8], prefixo: &[u8]) -> bool {
    todo.len() >= prefixo.len() && &todo[..prefixo.len()] == prefixo
}

/// Tira uma unidade comprimida do codificador e entrega ao LiveKit.
    unsafe fn drenar_saida(&self, source: &NativeVideoSource) {
        let Some(amostra) = (unsafe { self.puxar_saida() }) else { return };
        unsafe { self.entregar_amostra(source, amostra) };
    }

    /// Manda uma amostra ja comprimida para a faixa publicada.
    unsafe fn entregar_amostra(&self, source: &NativeVideoSource, amostra: IMFSample) {
        let chave = unsafe { amostra.GetUINT32(&MFSampleExtension_CleanPoint) }.unwrap_or(0) == 1;
        if chave {
            self.chaves_emitidas.set(self.chaves_emitidas.get() + 1);
        }
        let timestamp_us = unsafe { amostra.GetSampleTime() }.unwrap_or(0) / 10;

        let Ok(buffer) = (unsafe { amostra.ConvertToContiguousBuffer() }) else { return };
        unsafe {
            let mut dados: *mut u8 = std::ptr::null_mut();
            let mut tamanho = 0u32;
            if buffer.Lock(&mut dados, None, Some(&mut tamanho)).is_err() {
                return;
            }
            if tamanho > 0 {
                let bruto = std::slice::from_raw_parts(dados, tamanho as usize);
                // O cabecalho vai na frente de todo quadro-chave, mas so quando
                // o codificador ja nao o mandou: repetir e legal, mas procurar
                // antes evita crescer a unidade a toa em placa que ja faz certo.
                let mut com_cabecalho;
                let payload = if chave && !self.cabecalho.is_empty() && !Self::comeca_com(bruto, &self.cabecalho) {
                    com_cabecalho = Vec::with_capacity(self.cabecalho.len() + bruto.len());
                    com_cabecalho.extend_from_slice(&self.cabecalho);
                    com_cabecalho.extend_from_slice(bruto);
                    &com_cabecalho[..]
                } else {
                    bruto
                };
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
/// `VARIANT` booleano. `VT_BOOL` verdadeiro e -1, e nao 1: valor 1 e aceito
/// por uns e recusado por outros, e o `ICodecAPI` e do segundo grupo.
fn variante_bool(valor: bool) -> VARIANT {
    let mut variante = VARIANT::default();
    unsafe {
        let interno = &mut variante.Anonymous.Anonymous;
        interno.vt = VT_BOOL;
        interno.Anonymous.boolVal = windows::Win32::Foundation::VARIANT_BOOL(if valor { -1 } else { 0 });
    }
    variante
}

fn variante_u32(valor: u32) -> VARIANT {
    let mut variante = VARIANT::default();
    unsafe {
        let interno = &mut variante.Anonymous.Anonymous;
        interno.vt = VT_UI4;
        interno.Anonymous.ulVal = valor;
    }
    variante
}

/// Copia `linhas` de `largura` bytes para um destino com passada maior.
///
/// Igual ao `copiar_plano` do caminho de software; vive aqui porque aquele e
/// privado do modulo da captura e sao dois donos diferentes do mesmo problema.
fn copiar_com_folga(origem: &[u8], largura: usize, destino: &mut [u8], passo: usize, linhas: usize) {
    for linha in 0..linhas {
        let de = linha * largura;
        let para = linha * passo;
        if de + largura > origem.len() || para + largura > destino.len() {
            break;
        }
        destino[para..para + largura].copy_from_slice(&origem[de..de + largura]);
    }
}
