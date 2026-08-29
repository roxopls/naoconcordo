//! Publica a tela capturada no LiveKit por uma conexao propria.
//!
//! O app ja tem uma conexao com a sala, mas ela vive dentro do WebView2 e so
//! sabe publicar o que vem de `getDisplayMedia`. Em vez de atravessar o quadro
//! ate la, esta conexao entra na mesma sala como um segundo participante, com
//! identidade `usuario-screen-<aleatorio>`, e publica so a tela.
//!
//! O token vem pronto do backend, buscado pelo lado JS, que ja tem a sessao.
//! O Rust nao conhece a autenticacao do naoconcordo.

use std::sync::Arc;

use livekit::{
    Room, RoomOptions,
    options::{DegradationPreference, TrackPublishOptions, VideoCodec, VideoEncoding},
    track::{LocalAudioTrack, LocalTrack, LocalVideoTrack, TrackSource},
    webrtc::{
        audio_source::{RtcAudioSource, native::NativeAudioSource},
        rtp_sender::VideoEncoderBackend,
        video_source::{RtcVideoSource, VideoResolution, native::NativeVideoSource},
    },
};
use serde::Serialize;
use tokio::sync::Mutex;

use super::{
    audio,
    capture::{CaptureHandle, Destino},
    encoder::{self, EncoderHandle},
    sources::Target,
};

/// Compartilhamento em andamento. Guardado no estado do Tauri para o botao de
/// parar encontrar o que desligar.
pub struct ActiveShare {
    room: Arc<Room>,
    capture: CaptureHandle,
    audio: Option<audio::AudioHandle>,
    /// Para onde a captura entrega os quadros. Guardado porque trocar de tela
    /// religa a captura, e ela precisa continuar entregando no mesmo lugar.
    destino: Destino,
    /// Codificador da GPU, quando ha um. Vive aqui so para nao ser derrubado
    /// enquanto a transmissao existe — quem fala com ele e o `Destino`.
    encoder: Option<Arc<EncoderHandle>>,
    /// A fonte de audio fica guardada para a troca de tela: o alvo da captura
    /// muda, mas a faixa publicada continua a mesma. Sem isso, trocar de janela
    /// exigiria republicar, e quem assiste veria a transmissao piscar.
    audio_source: Option<NativeAudioSource>,
    /// A faixa de video fica guardada para poder ser pausada sem largar a
    /// publicacao: parar e recomecar mudaria o sid, e quem estava assistindo
    /// teria de clicar em "Assistir" outra vez.
    video_track: LocalVideoTrack,
    /// O que esta sendo capturado, para saber quando a janela morre.
    target: Target,
    /// De onde vem o som, quando a pessoa pediu um programa especifico. Trocar
    /// de tela nao pode perder essa escolha.
    audio_target: Option<Target>,
    /// Quanto o som da tela e amplificado. 1.0 e o volume original.
    ganho_audio: f32,
    /// Guardado para a troca de tela: o novo capturador precisa do mesmo
    /// limite de quadros, senao trocar de janela viraria captura sem teto.
    fps: f64,
    /// Idem para a escolha do motor: trocar de janela nao pode voltar
    /// sozinho para o WGC no meio de um teste da duplicacao.
    forcar_duplicacao: bool,
    /// Idem para o recorte: trocar de janela mantem a barra de titulo fora.
    sem_barra: bool,
    paused: bool,
}

#[derive(Default)]
pub struct ShareState(pub Mutex<Option<ActiveShare>>);

/// Qualidade escolhida na interface, com os mesmos degraus do dialogo antigo.
#[derive(serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Quality {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub bitrate: u64,
    /// Quando a banda aperta, o que sacrificar.
    ///
    /// O LiveKit assume que compartilhar tela e mostrar documento e usa
    /// `MaintainResolution`: segura a resolucao e derruba o framerate. Num jogo
    /// isso e exatamente a travada que se ve. Com `prefer_motion`, a
    /// preferencia inverte — perde nitidez e mantem o movimento.
    #[serde(default)]
    pub prefer_motion: bool,
}

#[allow(clippy::too_many_arguments)]
pub async fn start(
    state: &ShareState,
    target: Target,
    audio_target: Option<Target>,
    url: &str,
    token: &str,
    quality: Quality,
    with_audio: bool,
    ganho_audio: f32,
    preferencia: encoder::Preferencia,
    forcar_duplicacao: bool,
    sem_barra: bool,
) -> Result<String, String> {
    if !target.is_alive() {
        return Err("A janela escolhida foi fechada.".into());
    }

    // Se ja havia um compartilhamento, ele sai antes: duas capturas publicando
    // na mesma identidade deixariam faixas orfas na sala.
    stop(state).await;

    let (room, _events) = Room::connect(url, token, RoomOptions::default())
        .await
        .map_err(|e| format!("Nao foi possivel entrar na sala: {e}"))?;
    let room = Arc::new(room);

    let resolucao = VideoResolution { width: quality.width, height: quality.height };
    // Por que a GPU nao assumiu, para a interface poder dizer. Um `eprintln!`
    // nao chega a lugar nenhum num build de release, que nao tem console — e
    // foi exatamente por isso que a primeira falha em maquina alheia chegou
    // aqui sem nenhuma informacao junto.
    let mut motivo = String::new();

    // Primeiro a GPU. `new_encoded` cria uma fonte que so aceita unidades ja
    // comprimidas, e o codificador escreve direto nela; se nao houver hardware
    // para o trabalho, a fonte comum volta e o libwebrtc comprime como antes.
    let (source, encoder) = {
        let candidata = NativeVideoSource::new_encoded(resolucao.clone());
        match encoder::iniciar(
            candidata.clone(),
            quality.width,
            quality.height,
            quality.fps,
            quality.bitrate,
            preferencia,
        ) {
            Ok(hw) => {
                eprintln!("[tela] codificando em {} ({})", hw.nome(), hw.codec().nome_livekit());
                (candidata, Some(Arc::new(hw)))
            }
            Err(erro) => {
                eprintln!("[tela] sem codificador de hardware ({erro}); usando software");
                motivo = erro;
                (NativeVideoSource::new(resolucao.clone(), true), None)
            }
        }
    };

    let destino = match &encoder {
        Some(hw) => Destino::Hardware(hw.clone()),
        None => Destino::Software(source.clone()),
    };
    let compressao = match &encoder {
        Some(hw) => format!("{} ({})", hw.nome(), hw.codec().nome_livekit()),
        None => format!("software: {motivo}"),
    };
    let (capture, motor) =
        super::capture::start(target, destino.clone(), quality.fps, forcar_duplicacao, sem_barra)?;

    let track = LocalVideoTrack::create_video_track("tela", RtcVideoSource::Native(source.clone()));
    let track_guardada = track.clone();
    room.local_participant()
        .publish_track(
            LocalTrack::Video(track),
            TrackPublishOptions {
                source: TrackSource::Screenshare,
                video_encoding: Some(VideoEncoding {
                    max_bitrate: quality.bitrate,
                    max_framerate: quality.fps,
                }),
                // Simulcast de tela gasta upload que esta escasso nesta casa e
                // ninguem aqui assiste em telinha.
                simulcast: false,
                degradation_preference: Some(if quality.prefer_motion {
                    DegradationPreference::MaintainFramerate
                } else {
                    DegradationPreference::MaintainResolution
                }),
                // Com a GPU codificando, o codec negociado tem de ser o mesmo
                // que ela produziu, e o `PreEncoded` desliga a compressao do
                // libwebrtc: ele so empacota o que chega pronto.
                video_codec: match encoder.as_deref().map(EncoderHandle::codec) {
                    Some(encoder::HwCodec::Av1) => VideoCodec::AV1,
                    Some(encoder::HwCodec::H264) => VideoCodec::H264,
                    None => VideoCodec::VP8,
                },
                video_encoder: if encoder.is_some() {
                    VideoEncoderBackend::PreEncoded
                } else {
                    VideoEncoderBackend::Auto
                },
                ..Default::default()
            },
        )
        .await
        .map_err(|e| format!("Nao foi possivel publicar a tela: {e}"))?;

    // O som vai depois do video: se o loopback falhar, o compartilhamento
    // continua de pe, so mudo. Quem desmarcou a opcao nem chega aqui.
    let (audio, audio_source) = if with_audio {
        publish_audio(&room, audio_target.unwrap_or(target), ganho_audio).await
    } else {
        (None, None)
    };

    *state.0.lock().await = Some(ActiveShare {
        room,
        capture,
        audio,
        destino,
        encoder,
        audio_source,
        video_track: track_guardada,
        target,
        audio_target,
        ganho_audio,
        fps: quality.fps,
        forcar_duplicacao,
        sem_barra,
        paused: false,
    });
    Ok(format!("captura {motor} | compressão {compressao}"))
}

/// Pausa ou retoma sem despublicar.
///
/// Mutar a faixa e diferente de parar: o sid continua o mesmo, entao quem
/// assiste volta a ver sozinho quando a transmissao retoma, em vez de precisar
/// clicar em "Assistir" de novo.
pub async fn set_paused(state: &ShareState, paused: bool) -> Result<bool, String> {
    let mut guarda = state.0.lock().await;
    let Some(share) = guarda.as_mut() else {
        return Err("Nao ha transmissao para pausar.".into());
    };
    if paused {
        share.video_track.mute();
    } else {
        share.video_track.unmute();
        // Quem voltou a assistir so tem quadros de diferenca guardados, e
        // diferenca sobre imagem parada de minutos atras e um borrao.
        if let Some(encoder) = &share.encoder {
            encoder.pedir_chave();
        }
    }
    share.paused = paused;
    Ok(paused)
}

/// Numeros que o proprio WebRTC ja mantem sobre a transmissao em curso.
///
/// Servem para parar de adivinhar de onde vem a travada: `limite` diz se quem
/// segura e a CPU desta maquina ou o upload dela, e `codificador` revela se o
/// codificador e de software — o caso comum, e o caro.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Estatisticas {
    pub largura: u32,
    pub altura: u32,
    pub fps: f64,
    /// Bits por segundo que o controle de congestionamento liberou.
    pub bitrate_alvo: f64,
    /// "nenhum", "cpu", "banda" ou "outro".
    pub limite: String,
    /// Quanto tempo cada quadro custa para codificar, em milissegundos.
    pub ms_por_quadro: f64,
    pub codificador: String,
    /// Codificador de hardware, quando o WebRTC consegue dizer.
    pub eficiente: bool,
    pub quadros: u32,
    /// Quantas vezes a resolucao teve de cair para a transmissao se sustentar.
    pub quedas_de_resolucao: u32,
    /// Quadros que a captura produziu e o codificador de hardware nao aguentou
    /// receber. Cresce quando a GPU esta mais lenta que a captura — sinal de
    /// pedir menos quadros por segundo, nao de rede ruim.
    pub descartados: u64,
    /// Motivo de a captura ter parado sozinha, quando parou. Uma transmissao
    /// preta com este campo preenchido tem a resposta pronta.
    pub falha_captura: Option<String>,
    /// Idem para o codificador de hardware, que tambem morria calado.
    pub falha_encoder: Option<String>,
}

/// Estatisticas da transmissao em curso, ou `None` quando nao ha nenhuma.
pub async fn estatisticas(state: &ShareState) -> Option<Estatisticas> {
    let (track, hardware, falha_captura, falha_encoder) = {
        let guarda = state.0.lock().await;
        let share = guarda.as_ref()?;
        // O nome vem daqui, e nao do WebRTC: com a GPU comprimindo, o que ele
        // conhece e o codificador de passagem, que nao comprime nada.
        let hardware = share.encoder.as_ref().map(|hw| {
            (format!("{} ({})", hw.nome(), hw.codec().nome_livekit()), hw.descartados())
        });
        let falha_encoder = share.encoder.as_ref().and_then(|hw| hw.falha());
        (share.video_track.clone(), hardware, share.capture.falha(), falha_encoder)
    };
    let (nome_hardware, descartados) = match hardware {
        Some((nome, descartados)) => (Some(nome), descartados),
        None => (None, 0),
    };
    // Fora do cadeado: `get_stats` conversa com a thread de sinalizacao do
    // WebRTC, e segurar o estado ate a resposta travaria parar e pausar.
    let stats = track.get_stats().await.ok()?;
    for item in stats {
        let livekit::webrtc::stats::RtcStats::OutboundRtp(dados) = item else { continue };
        let fora = dados.outbound;
        let ms = if fora.frames_encoded > 0 {
            fora.total_encode_time * 1000.0 / fora.frames_encoded as f64
        } else {
            0.0
        };
        return Some(Estatisticas {
            largura: fora.frame_width,
            altura: fora.frame_height,
            fps: fora.frames_per_second,
            bitrate_alvo: fora.target_bitrate,
            limite: match fora.quality_limitation_reason {
                livekit::webrtc::stats::QualityLimitationReason::None => "nenhum",
                livekit::webrtc::stats::QualityLimitationReason::Cpu => "cpu",
                livekit::webrtc::stats::QualityLimitationReason::Bandwidth => "banda",
                livekit::webrtc::stats::QualityLimitationReason::Other => "outro",
            }
            .to_string(),
            ms_por_quadro: ms,
            eficiente: nome_hardware.is_some() || fora.power_efficient_encoder,
            codificador: nome_hardware.unwrap_or(fora.encoder_implementation),
            descartados,
            falha_captura,
            falha_encoder,
            quadros: fora.frames_encoded,
            quedas_de_resolucao: fora.quality_limitation_resolution_changes,
        });
    }
    None
}

/// A janela capturada ainda existe? Fechar o jogo mata a captura e a
/// transmissao congela sem avisar ninguem.
pub async fn target_alive(state: &ShareState) -> bool {
    match state.0.lock().await.as_ref() {
        Some(share) => share.target.is_alive(),
        None => true,
    }
}

pub async fn stop(state: &ShareState) {
    let Some(mut share) = state.0.lock().await.take() else { return };
    share.capture.stop();
    if let Some(audio) = share.audio.take() {
        audio.stop();
    }
    share.room.close().await.ok();
}

/// Publica o audio da fonte. Devolve `None` quando o loopback nao esta
/// disponivel — Windows anterior ao 10 2004, por exemplo.
async fn publish_audio(
    room: &Room,
    target: Target,
    ganho: f32,
) -> (Option<audio::AudioHandle>, Option<NativeAudioSource>) {
    let Some(scope) = audio_scope(target) else { return (None, None) };

    let source = audio::source();
    let track = LocalAudioTrack::create_audio_track("tela", RtcAudioSource::Native(source.clone()));
    if room
        .local_participant()
        .publish_track(
            LocalTrack::Audio(track),
            TrackPublishOptions { source: TrackSource::ScreenshareAudio, ..Default::default() },
        )
        .await
        .is_err()
    {
        return (None, None);
    }

    let handle = audio::start(scope, source.clone(), tokio::runtime::Handle::current(), ganho);
    (Some(handle), Some(source))
}

/// De onde tirar o som, conforme o que esta sendo compartilhado.
fn audio_scope(target: Target) -> Option<audio::Scope> {
    let scope = match target {
        // Janela: so o que aquele programa toca.
        Target::Window(handle) => {
            let pid = windows_capture::window::Window::from_raw_hwnd(handle as *mut _)
                .process_id()
                .ok()?;
            audio::Scope::OnlyProcess(pid)
        }
        // Monitor: tudo menos nos, senao a chamada volta como eco.
        Target::Monitor(_) => audio::Scope::ExceptProcess(std::process::id()),
    };
    Some(scope)
}

/// Troca o que esta sendo capturado sem largar a faixa publicada.
///
/// E o ponto do recurso: quem assiste continua vendo, e quem transmite nao
/// precisa parar e recomecar so para mostrar outra janela.
pub async fn switch(state: &ShareState, target: Target) -> Result<(), String> {
    if !target.is_alive() {
        return Err("A janela escolhida foi fechada.".into());
    }

    let mut guarda = state.0.lock().await;
    let Some(share) = guarda.as_mut() else {
        return Err("Nao ha transmissao para trocar.".into());
    };

    // A captura antiga sai antes da nova entrar: duas alimentando a mesma
    // fonte de video entregariam quadros intercalados de duas telas.
    share.capture.stop();
    // A descricao do motor so interessa na primeira vez: trocar de tela nao
    // troca de motor de captura.
    (share.capture, _) = super::capture::start(
        target,
        share.destino.clone(),
        share.fps,
        share.forcar_duplicacao,
        share.sem_barra,
    )?;
    share.target = target;

    // O som segue a fonte: janela nova quer dizer processo novo. Mas se a
    // pessoa escolheu de onde tirar o som, trocar a imagem nao mexe nisso.
    if let (Some(handle), Some(source)) = (share.audio.as_ref(), share.audio_source.clone()) {
        let alvo_do_som = share.audio_target.unwrap_or(target);
        handle.stop();
        let ganho = share.ganho_audio;
        share.audio = audio_scope(alvo_do_som)
            .map(|scope| audio::start(scope, source, tokio::runtime::Handle::current(), ganho));
    }

    Ok(())
}
