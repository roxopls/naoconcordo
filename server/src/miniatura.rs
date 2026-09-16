//! Versão leve de uma imagem, para o chat montar sem carregar o original.
//!
//! O anexo vai até 50 MB, e a conversa mostrava sempre o arquivo inteiro: abrir
//! um canal com vinte fotos significava vinte imagens em tamanho cheio
//! decodificadas na memória da janela, todas ao mesmo tempo. A miniatura troca
//! isso por alguns KB por foto, e o original entra só quando a pessoa está de
//! fato olhando para ele.
//!
//! **JPEG sempre, mesmo vindo de PNG.** A miniatura é material de passagem: não
//! precisa de transparência nem de fidelidade, e o JPEG a 60 sai muito menor que
//! qualquer PNG do mesmo tamanho. Quem quer o arquivo de verdade pede o
//! original, que continua guardado como veio.
//!
//! GIF animado vira um quadro parado, de propósito: a animação é justamente o
//! que custa caro, e quem quiser vê-la recebe o original ao olhar.

use std::io::Cursor;

use image::{ImageReader, codecs::jpeg::JpegEncoder, imageops::FilterType};

/// Maior lado da miniatura. O chat desenha o anexo em cerca de 400 px, então
/// passar disso seria baixar pixel que ninguém vê.
const LADO: u32 = 400;
/// Qualidade do JPEG. Abaixo disto o borrão aparece mesmo em miniatura.
const QUALIDADE: u8 = 60;
/// Teto de memória para decodificar. Uma imagem de 50 MB pode abrir para
/// centenas de MB de bitmap, e este servidor atende outras coisas ao mesmo
/// tempo — recusar é melhor do que engasgar a máquina inteira por uma foto.
const MAX_BITMAP: u64 = 256 * 1024 * 1024;

/// Gera a miniatura. `None` quando não vale a pena, ou quando não dá.
///
/// **Bloqueia**: decodificar e redimensionar é trabalho de CPU. Quem chama roda
/// isto fora do laço assíncrono.
pub fn gerar(bytes: &[u8]) -> Option<Vec<u8>> {
    // Arquivo já pequeno não ganha nada em virar outro arquivo pequeno, e ainda
    // custaria uma decodificação por upload.
    if bytes.len() <= 64 * 1024 {
        return None;
    }

    let mut limites = image::Limits::default();
    limites.max_alloc = Some(MAX_BITMAP);
    let mut leitor = ImageReader::new(Cursor::new(bytes)).with_guessed_format().ok()?;
    leitor.limits(limites);
    let imagem = leitor.decode().ok()?;

    // `thumbnail` é a redução rápida do crate: para um borrão de 400 px ela
    // basta, e custa uma fração do filtro bom.
    let pequena = if imagem.width() > LADO || imagem.height() > LADO {
        imagem.resize(LADO, LADO, FilterType::Triangle)
    } else {
        imagem
    };

    let mut saida = Vec::new();
    // `to_rgb8` derruba o canal alfa: o JPEG não tem onde guardá-lo, e sem a
    // conversão o encoder recusa a imagem.
    JpegEncoder::new_with_quality(&mut saida, QUALIDADE)
        .encode_image(&pequena.to_rgb8())
        .ok()?;

    // Miniatura maior que o original seria o mundo ao contrário — acontece com
    // foto pequena e muito detalhada. Nesse caso o original já é a versão leve.
    (saida.len() < bytes.len()).then_some(saida)
}

/// O nome do arquivo da miniatura de um anexo.
///
/// Fica ao lado do original e deriva do id, que é o hash do conteúdo: o mesmo
/// arquivo enviado duas vezes divide anexo **e** miniatura.
pub fn nome(id: &str) -> String {
    format!("{id}.thumb.jpg")
}

#[cfg(test)]
mod testes {
    use super::*;

    /// Uma imagem de verdade, grande o suficiente para valer miniatura.
    fn imagem_grande() -> Vec<u8> {
        let mut buffer = image::RgbImage::new(1600, 1200);
        // Gradiente em vez de cor chapada: cor única comprime a quase nada e o
        // teste passaria sem provar que houve redução de verdade.
        for (x, y, pixel) in buffer.enumerate_pixels_mut() {
            *pixel = image::Rgb([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8]);
        }
        let mut png = Vec::new();
        image::DynamicImage::ImageRgb8(buffer)
            .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
            .expect("PNG de teste");
        png
    }

    #[test]
    fn encolhe_e_cabe_no_lado_maior() {
        let original = imagem_grande();
        let mini = gerar(&original).expect("deveria gerar");
        assert!(mini.len() < original.len() / 4, "mini com {} bytes", mini.len());

        let aberta = image::load_from_memory(&mini).expect("mini valida");
        assert_eq!(aberta.width().max(aberta.height()), LADO);
        // 1600x1200 reduzido para 400 de largura da 300 de altura: a proporcao
        // tem de sobreviver, senao a previa aparece esticada na conversa.
        assert_eq!((aberta.width(), aberta.height()), (400, 300));
    }

    /// Arquivo pequeno e lixo nao viram miniatura, e quem chama serve o original.
    #[test]
    fn recusa_o_que_nao_vale() {
        assert!(gerar(&[]).is_none());
        assert!(gerar(b"isto nao e imagem").is_none());
        assert!(gerar(&vec![7u8; 200 * 1024]).is_none(), "bytes crus nao sao imagem");
    }

    #[test]
    fn nome_fica_ao_lado_do_original() {
        assert_eq!(nome("abc123.png"), "abc123.png.thumb.jpg");
    }
}
