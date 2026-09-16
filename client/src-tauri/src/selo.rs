//! Selo de nao lidas no icone da barra de tarefas e no da bandeja.
//!
//! O contador dentro do aplicativo ja existe, mas ele so serve para quem esta
//! olhando a janela. Minimizado — ou fechado para a bandeja, que e o padrao
//! aqui — o unico lugar onde a pessoa procura e o icone, e o Windows nao
//! desenha numero nenhum ali sozinho.
//!
//! **O desenho do numero vem pronto do cliente**, em pixels RGBA. Escrever um
//! numero deste lado exigiria embutir fonte e rasterizador so para isso,
//! enquanto o canvas ja tem os dois e ainda usa a mesma cor do selo da lista de
//! canais.

use tauri::image::Image;
use tauri::{AppHandle, Manager};

/// Identificador da bandeja. Precisa bater com o `with_id` em `lib.rs`: sem ele
/// nao ha como recuperar o icone depois de criado para trocar a imagem.
pub const BANDEJA: &str = "principal";

/// Recebe o selo desenhado e o aplica nos dois lugares.
///
/// `rgba` vazio significa "nenhuma nao lida": limpa o selo e devolve o icone
/// original. O `total` vem junto porque a dica da bandeja e texto, nao imagem.
#[tauri::command]
pub fn selo_de_nao_lidas(
    app: AppHandle,
    rgba: Vec<u8>,
    largura: u32,
    altura: u32,
    total: u32,
) -> Result<(), String> {
    let selo = if rgba.is_empty() {
        None
    } else {
        // Conferir antes de indexar: um tamanho que nao bate com os pixels
        // viraria leitura fora do vetor la embaixo, no laco da composicao.
        if largura == 0 || altura == 0 || rgba.len() != largura as usize * altura as usize * 4 {
            return Err("selo com dimensoes que nao batem com os pixels".into());
        }
        Some(Image::new_owned(rgba, largura, altura))
    };

    aplicar_na_barra(&app, selo.as_ref(), total);
    aplicar_na_bandeja(&app, selo.as_ref(), total);
    Ok(())
}

/// Icone sobreposto no botao da barra de tarefas.
///
/// So existe no Windows. Nos outros sistemas o equivalente e um contador que o
/// proprio ambiente desenha, entao la vai o numero cru.
fn aplicar_na_barra(app: &AppHandle, selo: Option<&Image<'_>>, total: u32) {
    let Some(janela) = app.get_webview_window(crate::PRINCIPAL) else {
        return;
    };

    #[cfg(target_os = "windows")]
    {
        let _ = total;
        let _ = janela.set_overlay_icon(selo.cloned());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = selo;
        let _ = janela.set_badge_count(if total == 0 { None } else { Some(total as i64) });
    }
}

/// Icone da bandeja, com o selo colado por cima, e a dica com o numero escrito.
///
/// A dica importa mais do que parece: em 16 px o numero fica pequeno demais
/// para ser lido, e o que se ve e "tem algo". O texto ao passar o mouse e onde
/// o valor exato aparece.
fn aplicar_na_bandeja(app: &AppHandle, selo: Option<&Image<'_>>, total: u32) {
    let Some(bandeja) = app.tray_by_id(BANDEJA) else {
        return;
    };

    let base = app.default_window_icon().cloned();
    let icone = match (base, selo) {
        (Some(base), Some(selo)) => Some(compor(&base, selo)),
        (base, _) => base,
    };
    let _ = bandeja.set_icon(icone);

    let dica = match total {
        0 => "naoconcordo".to_string(),
        1 => "naoconcordo — 1 não lida".to_string(),
        muitas => format!("naoconcordo — {muitas} não lidas"),
    };
    let _ = bandeja.set_tooltip(Some(dica));
}

/// Cola o selo no canto inferior direito do icone, ocupando pouco mais da
/// metade dele.
///
/// A reducao e por media de area, e nao por vizinho mais proximo: o selo chega
/// com dezenas de pixels e desce para 16 ou 32 na tela, e nessa razao o vizinho
/// mais proximo come pedaco do traco do numero — o `1` chega a sumir. A media e
/// feita com alfa pre-multiplicado, senao a cor do fundo transparente entraria
/// na conta e sobraria uma auréola clara em volta do circulo.
fn compor(base: &Image<'_>, selo: &Image<'_>) -> Image<'static> {
    let (largura_base, altura_base) = (base.width(), base.height());
    let alvo = (largura_base.min(altura_base) * 55 / 100).max(1);
    let x0 = largura_base.saturating_sub(alvo);
    let y0 = altura_base.saturating_sub(alvo);

    let origem = selo.rgba();
    let mut saida = base.rgba().to_vec();

    for y in 0..alvo {
        for x in 0..alvo {
            // Caixa do pixel de destino, medida no selo original.
            let sx0 = x * selo.width() / alvo;
            let sx1 = (((x + 1) * selo.width()).div_ceil(alvo)).max(sx0 + 1).min(selo.width());
            let sy0 = y * selo.height() / alvo;
            let sy1 = (((y + 1) * selo.height()).div_ceil(alvo)).max(sy0 + 1).min(selo.height());

            let (mut r, mut g, mut b, mut a, mut n) = (0u32, 0u32, 0u32, 0u32, 0u32);
            for sy in sy0..sy1 {
                for sx in sx0..sx1 {
                    let p = ((sy * selo.width() + sx) * 4) as usize;
                    let alfa = origem[p + 3] as u32;
                    r += origem[p] as u32 * alfa;
                    g += origem[p + 1] as u32 * alfa;
                    b += origem[p + 2] as u32 * alfa;
                    a += alfa;
                    n += 1;
                }
            }
            if n == 0 || a == 0 {
                continue;
            }
            // Volta de pre-multiplicado para cor normal dividindo pelo alfa
            // somado, e nao pela quantidade de pixels.
            let (r, g, b) = (r / a, g / a, b / a);
            let a = a / n;

            let d = (((y0 + y) * largura_base + (x0 + x)) * 4) as usize;
            for (canal, cor) in [r, g, b].into_iter().enumerate() {
                let fundo = saida[d + canal] as u32;
                saida[d + canal] = ((cor * a + fundo * (255 - a)) / 255) as u8;
            }
            let fundo = saida[d + 3] as u32;
            saida[d + 3] = (a + fundo * (255 - a) / 255) as u8;
        }
    }

    Image::new_owned(saida, largura_base, altura_base)
}
