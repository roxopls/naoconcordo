//! Audio do compartilhamento, capturado por loopback de processo (WASAPI).
//!
//! O loopback comum captura a placa inteira, o que devolve para a chamada a voz
//! das outras pessoas saindo do seu fone — eco. O loopback por processo resolve
//! isso de duas maneiras, conforme o que esta sendo compartilhado:
//!
//! - janela: captura so a arvore de processos daquela janela;
//! - monitor: captura tudo **menos** a nossa propria arvore, que e de onde sai
//!   a voz dos outros.
//!
//! Nos dois casos o naoconcordo nunca se escuta.

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use livekit::webrtc::{
    audio_frame::AudioFrame,
    audio_source::{AudioSourceOptions, native::NativeAudioSource},
};
use wasapi::{AudioClient, Direction, SampleType, StreamMode, WaveFormat, initialize_mta};

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u32 = 2;
/// O WebRTC trabalha em blocos de 10 ms.
const FRAME_SAMPLES: usize = (SAMPLE_RATE as usize / 100) * CHANNELS as usize;

/// Quem capturar e como.
#[derive(Clone, Copy)]
pub enum Scope {
    /// So esta arvore de processos. Usado quando se compartilha uma janela.
    OnlyProcess(u32),
    /// Tudo menos esta arvore. Usado quando se compartilha um monitor inteiro,
    /// passando o nosso proprio processo para nao capturar a chamada.
    ExceptProcess(u32),
}

pub struct AudioHandle {
    stop: Arc<AtomicBool>,
}

impl AudioHandle {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl Drop for AudioHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Sobe a captura numa thread propria e alimenta `source`.
///
/// Falhar aqui nao derruba o compartilhamento: video sem som e melhor que nada,
/// e loopback de processo exige Windows 10 2004 ou mais novo.
pub fn start(
    scope: Scope,
    source: NativeAudioSource,
    runtime: tokio::runtime::Handle,
    ganho: f32,
) -> AudioHandle {
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();

    std::thread::spawn(move || {
        if let Err(err) = pump(scope, source, runtime, &flag, ganho) {
            eprintln!("audio do compartilhamento parou: {err}");
        }
    });

    AudioHandle { stop }
}

fn pump(
    scope: Scope,
    source: NativeAudioSource,
    runtime: tokio::runtime::Handle,
    stop: &AtomicBool,
    ganho: f32,
) -> Result<(), String> {
    // COM em MTA: esta thread nunca toca interface.
    initialize_mta().ok().map_err(|e| e.to_string())?;

    let (pid, include_tree) = match scope {
        Scope::OnlyProcess(pid) => (pid, true),
        Scope::ExceptProcess(pid) => (pid, false),
    };

    let mut client =
        AudioClient::new_application_loopback_client(pid, include_tree).map_err(|e| e.to_string())?;

    // Pedimos i16 direto: e o formato que o WebRTC consome, entao o
    // `autoconvert` do WASAPI faz a conversao e nos poupamos um passo.
    let format = WaveFormat::new(16, 16, &SampleType::Int, SAMPLE_RATE as usize, CHANNELS as usize, None);
    let mode = StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 200_000 };
    client.initialize_client(&format, &Direction::Capture, &mode).map_err(|e| e.to_string())?;

    let event = client.set_get_eventhandle().map_err(|e| e.to_string())?;
    let capture = client.get_audiocaptureclient().map_err(|e| e.to_string())?;
    client.start_stream().map_err(|e| e.to_string())?;

    let mut queue: std::collections::VecDeque<u8> = std::collections::VecDeque::new();
    let mut block = vec![0i16; FRAME_SAMPLES];

    while !stop.load(Ordering::Relaxed) {
        // Sem timeout a thread ficaria presa quando o processo alvo emudece.
        if event.wait_for_event(500).is_err() {
            continue;
        }
        if capture.read_from_device_to_deque(&mut queue).is_err() {
            continue;
        }

        // A fila vem em bytes; o WebRTC quer blocos exatos de 10 ms.
        while queue.len() >= FRAME_SAMPLES * 2 {
            for sample in block.iter_mut() {
                let low = queue.pop_front().unwrap_or(0);
                let high = queue.pop_front().unwrap_or(0);
                let cru = i16::from_le_bytes([low, high]);
                // Amplificar com teto, e nao deixar transbordar: passar de
                // `i16::MAX` daria a volta e viraria estalo, que soa muito pior
                // do que o volume baixo que a pessoa veio corrigir.
                *sample = if ganho == 1.0 {
                    cru
                } else {
                    (cru as f32 * ganho).clamp(i16::MIN as f32, i16::MAX as f32) as i16
                };
            }
            let frame = AudioFrame {
                data: std::borrow::Cow::Borrowed(&block),
                sample_rate: SAMPLE_RATE,
                num_channels: CHANNELS,
                samples_per_channel: (FRAME_SAMPLES / CHANNELS as usize) as u32,
            };
            // `capture_frame` e assincrono, mas esta thread e sincrona: o
            // bloqueio aqui e o proprio controle de ritmo da captura.
            if runtime.block_on(source.capture_frame(&frame)).is_err() {
                return Ok(());
            }
        }
    }

    client.stop_stream().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn source() -> NativeAudioSource {
    NativeAudioSource::new(AudioSourceOptions::default(), SAMPLE_RATE, CHANNELS, 1000)
}
