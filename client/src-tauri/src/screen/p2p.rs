//! Tela da chamada privada, direto de uma pessoa para cada espectador.
//!
//! Mesma captura e mesmo codificador da GPU da transmissao de servidor
//! (`publisher::montar`); a diferenca e para onde a faixa vai. La, uma conexao
//! com o LiveKit. Aqui, uma `PeerConnection` por pessoa que pediu para
//! assistir, todas ligadas a mesma fonte ja comprimida: a GPU comprime uma vez
//! e o libwebrtc so empacota para cada um (`PreEncoded`).
//!
//! A sinalizacao nao passa por aqui. O lado JS pede a oferta, entrega a
//! resposta e os candidatos, e leva os candidatos daqui (evento
//! `tela-p2p-ice`) pelo WebSocket do app — o Rust nao conhece o servidor.

use std::{collections::HashMap, sync::Arc};

use livekit::webrtc::{
    MediaType,
    audio_source::native::NativeAudioSource,
    audio_track::RtcAudioTrack,
    ice_candidate::IceCandidate,
    media_stream_track::MediaStreamTrack,
    peer_connection::{OfferOptions, PeerConnection},
    peer_connection_factory::{IceServer, PeerConnectionFactory, RtcConfiguration, native::PeerConnectionFactoryExt},
    rtp_parameters::RtpEncodingParameters,
    rtp_sender::VideoEncoderBackend,
    rtp_transceiver::{RtpTransceiverDirection, RtpTransceiverInit},
    session_description::{SdpType, SessionDescription},
    video_track::RtcVideoTrack,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use super::{
    audio,
    capture::{CaptureHandle, Destino},
    encoder::{self, EncoderHandle, HwCodec},
    publisher::{self, Quality},
    sources::Target,
};

struct Transmissao {
    fabrica: PeerConnectionFactory,
    video: RtcVideoTrack,
    audio: Option<RtcAudioTrack>,
    audio_handle: Option<audio::AudioHandle>,
    /// Guardada para a troca de tela: o som segue a janela nova.
    audio_source: Option<NativeAudioSource>,
    capture: CaptureHandle,
    destino: Destino,
    encoder: Option<Arc<EncoderHandle>>,
    /// Teto da taxa por espectador: o degrau escolhido.
    bitrate: u64,
    fps: f64,
    target: Target,
    audio_target: Option<Target>,
    ganho_audio: f32,
    forcar_duplicacao: bool,
    sem_barra: bool,
    espectadores: HashMap<u64, PeerConnection>,
}

#[derive(Default)]
pub struct TelaP2pState(Mutex<Option<Transmissao>>);

#[derive(Deserialize)]
pub struct IceEntrada {
    urls: Vec<String>,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    credential: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CandidatoSaida {
    sessao: u64,
    candidate: String,
    sdp_mid: String,
    sdp_m_line_index: i32,
}

/// Comeca a capturar e comprimir. Ninguem recebe nada ainda: cada espectador
/// chega depois, por `tela_p2p_ofertar`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn tela_p2p_iniciar(
    state: tauri::State<'_, TelaP2pState>,
    source_id: String,
    quality: Quality,
    audio: bool,
    codec: Option<String>,
    #[allow(non_snake_case)] audioSource: Option<String>,
    #[allow(non_snake_case)] audioGain: Option<f32>,
    #[allow(non_snake_case)] forceDuplication: Option<bool>,
    #[allow(non_snake_case)] hideTitleBar: Option<bool>,
) -> Result<String, String> {
    let target = Target::parse(&source_id)?;
    if !target.is_alive() {
        return Err("A janela escolhida foi fechada.".into());
    }
    let audio_target = match audioSource.as_deref() {
        Some(id) if !id.is_empty() => Some(Target::parse(id)?),
        _ => None,
    };
    parar(&state).await;
    let forcar_duplicacao = forceDuplication.unwrap_or(false);
    let sem_barra = hideTitleBar.unwrap_or(true);
    let pipeline = publisher::montar(
        target,
        quality,
        encoder::Preferencia::ler(codec.as_deref()),
        forcar_duplicacao,
        sem_barra,
    )?;
    let fabrica = PeerConnectionFactory::default();
    let video = fabrica.create_video_track("tela", pipeline.source.clone());
    let ganho_audio = audioGain.unwrap_or(100.0).clamp(100.0, 300.0) / 100.0;
    let (audio_track, audio_handle, audio_source) = if audio {
        match publisher::audio_scope(audio_target.unwrap_or(target)) {
            Some(scope) => {
                let source = audio::source();
                let track = fabrica.create_audio_track("tela-audio", source.clone());
                let handle = audio::start(scope, source.clone(), tokio::runtime::Handle::current(), ganho_audio);
                (Some(track), Some(handle), Some(source))
            }
            None => (None, None, None),
        }
    } else {
        (None, None, None)
    };
    *state.0.lock().await = Some(Transmissao {
        fabrica,
        video,
        audio: audio_track,
        audio_handle,
        audio_source,
        capture: pipeline.capture,
        destino: pipeline.destino,
        encoder: pipeline.encoder,
        bitrate: quality.bitrate,
        fps: quality.fps,
        target,
        audio_target,
        ganho_audio,
        forcar_duplicacao,
        sem_barra,
        espectadores: HashMap::new(),
    });
    Ok(pipeline.descricao)
}

/// Os codecs que o destino pode receber, com o da GPU na frente. Sem isso a
/// negociacao escolheria VP8, e o `PreEncoded` mandaria H.264 rotulado de VP8.
fn preferencias(fabrica: &PeerConnectionFactory, codec: Option<HwCodec>) -> Vec<livekit::webrtc::rtp_parameters::RtpCodecCapability> {
    let mime = match codec {
        Some(HwCodec::Av1) => "video/av1",
        Some(HwCodec::H264) => "video/h264",
        None => return Vec::new(),
    };
    let (mut certo, mut parcial) = (Vec::new(), Vec::new());
    for c in fabrica.get_rtp_sender_capabilities(MediaType::Video).codecs {
        if c.mime_type.to_lowercase() != mime { continue; }
        // Mesmo criterio do LiveKit: perfil baseline 42e01f e o que qualquer
        // navegador decodifica.
        if c.sdp_fmtp_line.as_deref().is_some_and(|l| l.contains("profile-level-id=42e01f")) {
            certo.push(c);
        } else {
            parcial.push(c);
        }
    }
    certo.append(&mut parcial);
    certo
}

/// Abre a conexao para um espectador e devolve a oferta (SDP).
#[tauri::command]
pub async fn tela_p2p_ofertar(
    app: AppHandle,
    state: tauri::State<'_, TelaP2pState>,
    sessao: u64,
    ice: Vec<IceEntrada>,
) -> Result<String, String> {
    let mut guarda = state.0.lock().await;
    let t = guarda.as_mut().ok_or("Nao ha transmissao em curso.")?;
    if let Some(antiga) = t.espectadores.remove(&sessao) {
        antiga.close();
    }
    let config = RtcConfiguration {
        ice_servers: ice
            .into_iter()
            .map(|s| IceServer {
                urls: s.urls,
                username: s.username.unwrap_or_default(),
                password: s.credential.unwrap_or_default(),
            })
            .collect(),
        ..Default::default()
    };
    let pc = t.fabrica.create_peer_connection(config).map_err(|e| format!("conexao: {e:?}"))?;
    let app_ice = app.clone();
    pc.on_ice_candidate(Some(Box::new(move |c: IceCandidate| {
        let _ = app_ice.emit("tela-p2p-ice", CandidatoSaida {
            sessao,
            candidate: c.candidate(),
            sdp_mid: c.sdp_mid(),
            sdp_m_line_index: c.sdp_mline_index(),
        });
    })));
    let transceptor = pc
        .add_transceiver(
            MediaStreamTrack::Video(t.video.clone()),
            RtpTransceiverInit {
                direction: RtpTransceiverDirection::SendOnly,
                stream_ids: vec!["tela".into()],
                send_encodings: vec![RtpEncodingParameters {
                    active: true,
                    max_bitrate: Some(t.bitrate),
                    // Folga pelo mesmo motivo do `publisher`: teto exato corta
                    // quadro de uma tela que nunca entrega no ritmo perfeito.
                    max_framerate: Some(t.fps + 2.0),
                    ..Default::default()
                }],
            },
        )
        .map_err(|e| format!("video: {e:?}"))?;
    if let Some(hw) = &t.encoder {
        transceptor.sender().set_video_encoder_backend(VideoEncoderBackend::PreEncoded);
        let prefs = preferencias(&t.fabrica, Some(hw.codec()));
        if !prefs.is_empty() {
            transceptor.set_codec_preferences(prefs).map_err(|e| format!("codec: {e:?}"))?;
        }
    }
    if let Some(audio) = &t.audio {
        pc.add_transceiver(
            MediaStreamTrack::Audio(audio.clone()),
            RtpTransceiverInit {
                direction: RtpTransceiverDirection::SendOnly,
                stream_ids: vec!["tela".into()],
                send_encodings: vec![RtpEncodingParameters { active: true, max_bitrate: Some(128_000), ..Default::default() }],
            },
        )
        .map_err(|e| format!("audio: {e:?}"))?;
    }
    let oferta = pc.create_offer(OfferOptions::default()).await.map_err(|e| format!("oferta: {e:?}"))?;
    let texto = oferta.to_string();
    pc.set_local_description(oferta).await.map_err(|e| format!("oferta local: {e:?}"))?;
    t.espectadores.insert(sessao, pc);
    Ok(texto)
}

#[tauri::command]
pub async fn tela_p2p_resposta(state: tauri::State<'_, TelaP2pState>, sessao: u64, sdp: String) -> Result<(), String> {
    let pc = {
        let guarda = state.0.lock().await;
        let t = guarda.as_ref().ok_or("Nao ha transmissao em curso.")?;
        t.espectadores.get(&sessao).cloned().ok_or("Espectador desconhecido.")?
    };
    let resposta = SessionDescription::parse(&sdp, SdpType::Answer).map_err(|e| format!("resposta: {e}"))?;
    pc.set_remote_description(resposta).await.map_err(|e| format!("resposta remota: {e:?}"))?;
    // Quem chegou agora nao tem quadro de referencia: sem uma chave, veria
    // cinza ate a proxima que o codificador soltasse sozinho.
    if let Some(hw) = &state.0.lock().await.as_ref().and_then(|t| t.encoder.clone()) {
        hw.pedir_chave();
    }
    Ok(())
}

#[tauri::command]
pub async fn tela_p2p_candidato(
    state: tauri::State<'_, TelaP2pState>,
    sessao: u64,
    candidate: String,
    #[allow(non_snake_case)] sdpMid: Option<String>,
    #[allow(non_snake_case)] sdpMLineIndex: Option<i32>,
) -> Result<(), String> {
    let pc = {
        let guarda = state.0.lock().await;
        let Some(t) = guarda.as_ref() else { return Ok(()) };
        let Some(pc) = t.espectadores.get(&sessao).cloned() else { return Ok(()) };
        pc
    };
    let c = IceCandidate::parse(&sdpMid.unwrap_or_default(), sdpMLineIndex.unwrap_or(0), &candidate)
        .map_err(|e| format!("candidato: {e}"))?;
    pc.add_ice_candidate(c).await.map_err(|e| format!("candidato: {e:?}"))?;
    Ok(())
}

#[tauri::command]
pub async fn tela_p2p_remover(state: tauri::State<'_, TelaP2pState>, sessao: u64) -> Result<(), String> {
    if let Some(t) = state.0.lock().await.as_mut() {
        if let Some(pc) = t.espectadores.remove(&sessao) {
            pc.close();
        }
    }
    Ok(())
}

/// Troca a tela sem derrubar quem assiste: a faixa e as conexoes continuam.
#[tauri::command]
pub async fn tela_p2p_trocar(state: tauri::State<'_, TelaP2pState>, source_id: String) -> Result<(), String> {
    let target = Target::parse(&source_id)?;
    if !target.is_alive() {
        return Err("A janela escolhida foi fechada.".into());
    }
    let mut guarda = state.0.lock().await;
    let t = guarda.as_mut().ok_or("Nao ha transmissao para trocar.")?;
    t.capture.stop();
    (t.capture, _) = super::capture::start(target, t.destino.clone(), t.fps, t.forcar_duplicacao, t.sem_barra)?;
    t.target = target;
    // O som segue a janela nova, a menos que a pessoa tenha escolhido o
    // programa de onde ele vem.
    if t.audio_target.is_none() {
        if let (Some(source), Some(scope)) = (t.audio_source.clone(), publisher::audio_scope(target)) {
            if let Some(antigo) = t.audio_handle.take() {
                antigo.stop();
            }
            t.audio_handle = Some(audio::start(scope, source, tokio::runtime::Handle::current(), t.ganho_audio));
        }
    }
    if let Some(hw) = &t.encoder {
        hw.pedir_chave();
    }
    Ok(())
}

/// Pausa sem desligar: a conexao continua, so a imagem para.
#[tauri::command]
pub async fn tela_p2p_pausar(state: tauri::State<'_, TelaP2pState>, paused: bool) -> Result<bool, String> {
    let guarda = state.0.lock().await;
    let t = guarda.as_ref().ok_or("Nao ha transmissao para pausar.")?;
    t.video.set_enabled(!paused);
    if !paused {
        if let Some(hw) = &t.encoder {
            hw.pedir_chave();
        }
    }
    Ok(paused)
}

#[tauri::command]
pub async fn tela_p2p_parar(state: tauri::State<'_, TelaP2pState>) -> Result<(), String> {
    parar(&state).await;
    Ok(())
}

/// A janela transmitida ainda existe?
#[tauri::command]
pub async fn tela_p2p_viva(state: tauri::State<'_, TelaP2pState>) -> Result<bool, String> {
    Ok(state.0.lock().await.as_ref().is_none_or(|t| t.target.is_alive()))
}

async fn parar(state: &TelaP2pState) {
    let Some(mut t) = state.0.lock().await.take() else { return };
    for (_, pc) in t.espectadores.drain() {
        pc.close();
    }
    t.capture.stop();
    if let Some(audio) = t.audio_handle.take() {
        audio.stop();
    }
}
