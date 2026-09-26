//! Clipe dos ultimos 30 segundos da tela que esta sendo compartilhada.
//!
//! Nada e codificado de novo. O codificador da placa ja produz as unidades que
//! vao para o LiveKit; este modulo guarda uma copia delas numa fila que anda,
//! junto com o audio da tela em PCM cru, e so na hora de salvar monta um
//! arquivo Matroska em volta. Por isso o clipe nao custa processador enquanto
//! ninguem pede, e sai na qualidade exata da transmissao.
//!
//! **So existe com codificacao pela placa.** O caminho de software comprime
//! dentro do libwebrtc, onde nao ha como pegar a unidade comprimida no meio.
//!
//! O relogio do clipe e o da parede (`Instant`), nos dois fluxos: o tempo da
//! amostra do Media Foundation e o do bloco de audio vem de relogios
//! diferentes, e alinhar pela chegada deixa imagem e som juntos a poucos
//! milissegundos, que e o que importa num trecho de meio minuto.
//!
//! Matroska e nao MP4 porque aceita os tres formatos que estao aqui — H.264, AV1
//! e PCM — sem codificar o audio, e porque o formato e simples o bastante para
//! ser escrito a mao sem trazer uma dependencia.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::Instant;

use super::encoder::HwCodec;

/// Quanto o clipe cobre.
const JANELA_MS: u64 = 30_000;
/// Teto de seguranca da fila. A chave vem a cada 2 s (`CODECAPI_AVEncMPVGOPSize`),
/// entao a fila normalmente para em ~32 s; este teto so importa se um
/// codificador ignorar o GOP e passar muito tempo sem chave.
const TETO_MS: u64 = 60_000;
pub const TAXA: u32 = super::audio::SAMPLE_RATE;
pub const CANAIS: u32 = super::audio::CHANNELS;

struct Quadro { ms: u64, chave: bool, dados: Vec<u8> }

struct Fila {
    inicio: Instant,
    codec: HwCodec,
    largura: u32,
    altura: u32,
    video: VecDeque<Quadro>,
    /// Blocos de 10 ms de PCM 16 bits intercalado, com o instante de chegada.
    audio: VecDeque<(u64, Vec<i16>)>,
}

static FILA: Mutex<Option<Fila>> = Mutex::new(None);

/// Guarda uma unidade que acabou de sair do codificador.
pub fn guardar_video(codec: HwCodec, largura: u32, altura: u32, chave: bool, dados: &[u8]) {
    guardar_video_em(None, codec, largura, altura, chave, dados);
}

/// `ms` fixo e so para teste: alimentar quarenta segundos de quadros de uma
/// vez daria o mesmo instante a todos.
fn guardar_video_em(ms: Option<u64>, codec: HwCodec, largura: u32, altura: u32, chave: bool, dados: &[u8]) {
    let Ok(mut fila) = FILA.lock() else { return };
    // Troca de codec ou de tamanho (a escada de resolucao) comeca uma fila
    // nova: o arquivo tem um cabecalho so, com uma resolucao so.
    let mudou = fila.as_ref().is_none_or(|f| f.codec != codec || f.largura != largura || f.altura != altura);
    if mudou {
        // Sem chave nao da para comecar: o primeiro quadro do clipe tem de ser
        // decodificavel sozinho.
        if !chave { return; }
        *fila = Some(Fila { inicio: Instant::now(), codec, largura, altura, video: VecDeque::new(), audio: VecDeque::new() });
    }
    let Some(f) = fila.as_mut() else { return };
    let ms = ms.unwrap_or_else(|| f.inicio.elapsed().as_millis() as u64);
    f.video.push_back(Quadro { ms, chave, dados: dados.to_vec() });
    aparar(f, ms);
}

/// Guarda um bloco do audio da tela. Sem video guardado, nao ha clipe a que ele
/// pertenca, e o bloco e ignorado.
pub fn guardar_audio(bloco: &[i16]) { guardar_audio_em(None, bloco); }

fn guardar_audio_em(ms: Option<u64>, bloco: &[i16]) {
    let Ok(mut fila) = FILA.lock() else { return };
    let Some(f) = fila.as_mut() else { return };
    let ms = ms.unwrap_or_else(|| f.inicio.elapsed().as_millis() as u64);
    f.audio.push_back((ms, bloco.to_vec()));
}

/// Esquece tudo. Chamado quando a transmissao para: o clipe e da transmissao
/// em curso, e guardar a anterior seria salvar a coisa errada.
pub fn limpar() {
    if let Ok(mut fila) = FILA.lock() { *fila = None; }
}

/// Anda a fila: tira do comeco o que passou da janela, mas sempre cortando
/// numa chave, para o clipe comecar decodificavel.
fn aparar(f: &mut Fila, agora: u64) {
    let limite = agora.saturating_sub(JANELA_MS);
    let corte = f.video.iter().rposition(|q| q.chave && q.ms <= limite).unwrap_or(0);
    f.video.drain(..corte);
    let teto = agora.saturating_sub(TETO_MS);
    while f.video.front().is_some_and(|q| q.ms < teto) { f.video.pop_front(); }
    let primeiro = f.video.front().map(|q| q.ms).unwrap_or(agora);
    while f.audio.front().is_some_and(|(ms, _)| *ms < primeiro) { f.audio.pop_front(); }
}

/// Monta o arquivo com o que esta na fila agora.
pub fn montar() -> Result<Vec<u8>, String> {
    let fila = FILA.lock().map_err(|_| "fila do clipe indisponivel".to_string())?;
    let Some(f) = fila.as_ref() else {
        return Err("Nada para salvar: o clipe só existe enquanto você compartilha a tela com a placa de vídeo.".into());
    };
    let inicio = f.video.iter().position(|q| q.chave).ok_or("Ainda não há imagem suficiente para um clipe.")?;
    let video: Vec<&Quadro> = f.video.iter().skip(inicio).collect();
    let base = video[0].ms;
    let audio: Vec<&(u64, Vec<i16>)> = f.audio.iter().filter(|(ms, _)| *ms >= base).collect();

    let (codec_id, privado, converter): (&str, Vec<u8>, fn(&[u8]) -> Vec<u8>) = match f.codec {
        HwCodec::H264 => ("V_MPEG4/ISO/AVC", avcc(&video[0].dados).ok_or("O quadro-chave veio sem SPS/PPS.")?, anexo_b_para_avcc),
        HwCodec::Av1 => ("V_AV1", av1c(&video[0].dados).ok_or("O quadro-chave veio sem cabeçalho de sequência.")?, sem_delimitador_temporal),
    };
    let duracao = video.last().map(|q| q.ms - base).unwrap_or(0).max(audio.last().map(|(ms, _)| ms - base).unwrap_or(0));

    let mut trilhas = Vec::new();
    trilhas.extend(elemento(0xAE, &[
        uint(0xD7, 1), uint(0x73C5, 1), uint(0x83, 1), uint(0x9C, 0),
        texto(0x86, codec_id), bin(0x63A2, &privado),
        elemento(0xE0, &[uint(0xB0, f.largura as u64), uint(0xBA, f.altura as u64)].concat()),
    ].concat()));
    if !audio.is_empty() {
        trilhas.extend(elemento(0xAE, &[
            uint(0xD7, 2), uint(0x73C5, 2), uint(0x83, 2), uint(0x9C, 0),
            texto(0x86, "A_PCM/INT/LIT"),
            elemento(0xE1, &[flutuante(0xB5, TAXA as f64), uint(0x9F, CANAIS as u64), uint(0x6264, 16)].concat()),
        ].concat()));
    }

    let mut corpo = Vec::new();
    corpo.extend(elemento(0x1549A966, &[
        uint(0x2AD7B1, 1_000_000), // tempo em milissegundos
        texto(0x4D80, "naoconcordo"), texto(0x5741, "naoconcordo"),
        flutuante(0x4489, duracao as f64),
    ].concat()));
    corpo.extend(elemento(0x1654AE6B, &trilhas));

    // Um cluster por quadro-chave: 2 s cada, bem dentro do deslocamento de 16
    // bits que o bloco carrega, e cada um comeca decodificavel.
    let mut a = 0;
    let mut i = 0;
    while i < video.len() {
        let comeco = video[i].ms - base;
        let mut fim = i + 1;
        while fim < video.len() && !video[fim].chave && video[fim].ms - base - comeco < 30_000 { fim += 1; }
        let fim_ms = if fim < video.len() { video[fim].ms - base } else { u64::MAX };
        let mut blocos = Vec::new();
        blocos.extend(uint(0xE7, comeco));
        let mut v = i;
        loop {
            let proximo_video = (v < fim).then(|| video[v].ms - base);
            let proximo_audio = (a < audio.len() && audio[a].0 - base < fim_ms).then(|| audio[a].0 - base);
            match (proximo_video, proximo_audio) {
                (Some(tv), Some(ta)) if ta < tv => { blocos.extend(bloco(2, ta - comeco, true, &pcm(&audio[a].1))); a += 1; }
                (Some(tv), _) => { blocos.extend(bloco(1, tv - comeco, video[v].chave, &converter(&video[v].dados))); v += 1; }
                (None, Some(ta)) => { blocos.extend(bloco(2, ta - comeco, true, &pcm(&audio[a].1))); a += 1; }
                (None, None) => break,
            }
        }
        corpo.extend(elemento(0x1F43B675, &blocos));
        i = fim;
    }

    let mut arquivo = elemento(0x1A45DFA3, &[
        uint(0x4286, 1), uint(0x42F7, 1), uint(0x42F2, 4), uint(0x42F3, 8),
        texto(0x4282, "matroska"), uint(0x4287, 4), uint(0x4285, 2),
    ].concat());
    arquivo.extend(elemento(0x18538067, &corpo));
    Ok(arquivo)
}

// ------------------------------------------------------------------ EBML

fn id(numero: u32) -> Vec<u8> {
    let bytes = numero.to_be_bytes();
    let primeiro = bytes.iter().position(|b| *b != 0).unwrap_or(3);
    bytes[primeiro..].to_vec()
}

/// Tamanho em vint de 8 bytes: sempre cabe, e o formato aceita.
fn tamanho(n: usize) -> [u8; 8] {
    let mut saida = (n as u64).to_be_bytes();
    saida[0] = 0x01;
    saida
}

fn elemento(numero: u32, dados: &[u8]) -> Vec<u8> {
    let mut saida = id(numero);
    saida.extend(tamanho(dados.len()));
    saida.extend_from_slice(dados);
    saida
}
fn uint(numero: u32, valor: u64) -> Vec<u8> {
    let bytes = valor.to_be_bytes();
    let primeiro = bytes.iter().position(|b| *b != 0).unwrap_or(7);
    elemento(numero, &bytes[primeiro..])
}
fn flutuante(numero: u32, valor: f64) -> Vec<u8> { elemento(numero, &valor.to_be_bytes()) }
fn texto(numero: u32, valor: &str) -> Vec<u8> { elemento(numero, valor.as_bytes()) }
fn bin(numero: u32, valor: &[u8]) -> Vec<u8> { elemento(numero, valor) }

/// SimpleBlock: trilha, deslocamento dentro do cluster e o quadro.
fn bloco(trilha: u8, deslocamento: u64, chave: bool, dados: &[u8]) -> Vec<u8> {
    let mut corpo = vec![0x80 | trilha];
    corpo.extend((deslocamento.min(i16::MAX as u64) as i16).to_be_bytes());
    corpo.push(if chave { 0x80 } else { 0 });
    corpo.extend_from_slice(dados);
    elemento(0xA3, &corpo)
}

fn pcm(amostras: &[i16]) -> Vec<u8> { amostras.iter().flat_map(|a| a.to_le_bytes()).collect() }

// ----------------------------------------------------------------- H.264

/// As unidades NAL de um quadro em Annex B (separadas por `00 00 01`).
fn nals(dados: &[u8]) -> Vec<&[u8]> {
    let mut inicios = Vec::new();
    let mut i = 0;
    while i + 3 <= dados.len() {
        if dados[i] == 0 && dados[i + 1] == 0 && dados[i + 2] == 1 { inicios.push(i + 3); i += 3; } else { i += 1; }
    }
    inicios.iter().enumerate().map(|(n, &comeco)| {
        let mut fim = inicios.get(n + 1).map(|p| p - 3).unwrap_or(dados.len());
        // O `00` extra do inicio de quatro bytes pertence ao separador.
        while fim > comeco && dados[fim - 1] == 0 && n + 1 < inicios.len() { fim -= 1; }
        &dados[comeco..fim]
    }).filter(|nal| !nal.is_empty()).collect()
}

/// Matroska guarda H.264 com o tamanho na frente de cada NAL, e nao com o
/// separador. O delimitador de unidade de acesso (tipo 9) sai: nesse formato
/// ele e proibido.
fn anexo_b_para_avcc(dados: &[u8]) -> Vec<u8> {
    let mut saida = Vec::with_capacity(dados.len() + 16);
    for nal in nals(dados).into_iter().filter(|nal| nal[0] & 0x1F != 9) {
        saida.extend((nal.len() as u32).to_be_bytes());
        saida.extend_from_slice(nal);
    }
    saida
}

/// O `avcC`: perfil e nivel tirados do SPS, mais o SPS e o PPS em si.
fn avcc(chave: &[u8]) -> Option<Vec<u8>> {
    let unidades = nals(chave);
    let sps = unidades.iter().find(|nal| nal[0] & 0x1F == 7)?;
    let pps = unidades.iter().find(|nal| nal[0] & 0x1F == 8)?;
    if sps.len() < 4 { return None; }
    let mut saida = vec![1, sps[1], sps[2], sps[3], 0xFF, 0xE1];
    saida.extend((sps.len() as u16).to_be_bytes());
    saida.extend_from_slice(sps);
    saida.push(1);
    saida.extend((pps.len() as u16).to_be_bytes());
    saida.extend_from_slice(pps);
    Some(saida)
}

// ------------------------------------------------------------------- AV1

/// As OBUs de um quadro: (tipo, bytes da OBU inteira).
fn obus(dados: &[u8]) -> Vec<(u8, &[u8])> {
    let mut saida = Vec::new();
    let mut i = 0;
    while i < dados.len() {
        let cabecalho = dados[i];
        let tipo = (cabecalho >> 3) & 0x0F;
        let extensao = cabecalho & 0x04 != 0;
        let com_tamanho = cabecalho & 0x02 != 0;
        let mut j = i + 1 + extensao as usize;
        let fim = if com_tamanho {
            let (valor, lidos) = leb128(&dados[j.min(dados.len())..]);
            j += lidos;
            j + valor as usize
        } else {
            dados.len()
        };
        let fim = fim.min(dados.len());
        saida.push((tipo, &dados[i..fim]));
        if fim <= i { break; }
        i = fim;
    }
    saida
}

fn leb128(dados: &[u8]) -> (u64, usize) {
    let mut valor = 0u64;
    for (n, byte) in dados.iter().take(8).enumerate() {
        valor |= ((byte & 0x7F) as u64) << (7 * n);
        if byte & 0x80 == 0 { return (valor, n + 1); }
    }
    (valor, dados.len().min(8))
}

/// Matroska pede o AV1 sem o delimitador temporal (OBU tipo 2).
fn sem_delimitador_temporal(dados: &[u8]) -> Vec<u8> {
    obus(dados).into_iter().filter(|(tipo, _)| *tipo != 2).flat_map(|(_, obu)| obu.to_vec()).collect()
}

/// O `av1C`: quatro bytes de configuracao mais o cabecalho de sequencia.
///
/// O perfil sai dos tres primeiros bits do cabecalho. O nivel vai como 31
/// ("sem restricao"), e o croma como 4:2:0 de 8 bits, que e o que o
/// codificador da placa entrega aqui: ler o nivel de verdade exigiria
/// interpretar o cabecalho inteiro, e os decodificadores usam o cabecalho que
/// vai junto logo depois.
fn av1c(chave: &[u8]) -> Option<Vec<u8>> {
    let (_, sequencia) = obus(chave).into_iter().find(|(tipo, _)| *tipo == 1)?;
    let extensao = sequencia[0] & 0x04 != 0;
    let mut j = 1 + extensao as usize;
    if sequencia[0] & 0x02 != 0 { j += leb128(&sequencia[j..]).1; }
    let perfil = sequencia.get(j)? >> 5;
    let mut saida = vec![0x81, (perfil << 5) | 31, 0x0C, 0];
    saida.extend_from_slice(sequencia);
    Some(saida)
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn annex_b_vira_tamanho_na_frente() {
        let quadro = [0, 0, 0, 1, 0x09, 0x10, 0, 0, 1, 0x67, 1, 2, 3, 0, 0, 1, 0x68, 4, 0, 0, 0, 1, 0x65, 9, 9];
        let convertido = anexo_b_para_avcc(&quadro);
        assert_eq!(convertido, [0, 0, 0, 4, 0x67, 1, 2, 3, 0, 0, 0, 2, 0x68, 4, 0, 0, 0, 3, 0x65, 9, 9]);
        let config = avcc(&quadro).unwrap();
        assert_eq!(&config[..6], &[1, 1, 2, 3, 0xFF, 0xE1]);
    }

    #[test]
    fn av1_perde_so_o_delimitador() {
        // TD (tipo 2, tamanho 0), cabecalho de sequencia (tipo 1, 2 bytes), quadro (tipo 6, 1 byte).
        let quadro = [0x12, 0x00, 0x0A, 0x02, 0x20, 0x00, 0x32, 0x01, 0x7F];
        assert_eq!(sem_delimitador_temporal(&quadro), [0x0A, 0x02, 0x20, 0x00, 0x32, 0x01, 0x7F]);
        let config = av1c(&quadro).unwrap();
        assert_eq!(&config[..4], &[0x81, (1 << 5) | 31, 0x0C, 0]);
    }

    #[test]
    fn clipe_comeca_numa_chave_e_cobre_a_janela() {
        limpar();
        let quadro = [0, 0, 0, 1, 0x67, 1, 2, 3, 0, 0, 0, 1, 0x68, 4, 0, 0, 0, 1, 0x65, 1];
        guardar_video(HwCodec::H264, 64, 64, false, &quadro);
        assert!(montar().is_err(), "sem chave nao ha clipe");
        guardar_video(HwCodec::H264, 64, 64, true, &quadro);
        guardar_audio(&[0i16; 960]);
        guardar_video(HwCodec::H264, 64, 64, false, &quadro);
        let arquivo = montar().unwrap();
        assert_eq!(&arquivo[..4], &[0x1A, 0x45, 0xDF, 0xA3]);
        limpar();
    }

    /// Com ffmpeg a mao: `CLIPE_H264=arquivo.h264` (Annex B com AUD) ou
    /// `CLIPE_AV1=arquivo.obu`, 30 fps. Grava `CLIPE_SAIDA` para o ffprobe.
    #[test]
    #[ignore]
    fn clipe_de_arquivo_real() {
        let (codec, caminho) = match (std::env::var("CLIPE_H264"), std::env::var("CLIPE_AV1")) {
            (Ok(c), _) => (HwCodec::H264, c),
            (_, Ok(c)) => (HwCodec::Av1, c),
            _ => return,
        };
        let dados = std::fs::read(caminho).unwrap();
        // Quebra em quadros pelo delimitador: AUD no H.264, TD no AV1.
        let mut quadros: Vec<Vec<u8>> = Vec::new();
        match codec {
            HwCodec::H264 => {
                for nal in nals(&dados) {
                    if nal[0] & 0x1F == 9 || quadros.is_empty() { quadros.push(Vec::new()); }
                    let q = quadros.last_mut().unwrap();
                    q.extend([0, 0, 0, 1]);
                    q.extend_from_slice(nal);
                }
            }
            HwCodec::Av1 => {
                for (tipo, obu) in obus(&dados) {
                    if tipo == 2 || quadros.is_empty() { quadros.push(Vec::new()); }
                    quadros.last_mut().unwrap().extend_from_slice(obu);
                }
            }
        }
        limpar();
        for (i, q) in quadros.iter().enumerate() {
            let chave = match codec {
                HwCodec::H264 => nals(q).iter().any(|n| n[0] & 0x1F == 5),
                HwCodec::Av1 => obus(q).iter().any(|(t, _)| *t == 1),
            };
            let ms = i as u64 * 1000 / 30;
            guardar_video_em(Some(ms), codec, 640, 360, chave, q);
            // Um tom de 440 Hz, 10 ms por bloco, para ouvir que o som veio junto.
            for b in 0..3u64 {
                let t0 = (ms + b * 10) as f64 / 1000.0;
                let bloco: Vec<i16> = (0..480).flat_map(|n| {
                    let v = ((t0 + n as f64 / 48000.0) * 440.0 * std::f64::consts::TAU).sin() * 8000.0;
                    [v as i16, v as i16]
                }).collect();
                guardar_audio_em(Some(ms + b * 10), &bloco);
            }
        }
        let arquivo = montar().unwrap();
        std::fs::write(std::env::var("CLIPE_SAIDA").unwrap(), arquivo).unwrap();
        limpar();
    }
}
