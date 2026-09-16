/// Selo de nao lidas no icone da barra de tarefas e no da bandeja.
///
/// O numero ja aparece na lista de canais e no titulo da janela, e os dois so
/// servem para quem esta com o aplicativo na frente. Fechar a janela aqui manda
/// para a bandeja, entao o caso comum e justamente o contrario: a pessoa esta
/// jogando, o naoconcordo e um icone, e nao ha onde ver que chegou mensagem.
///
/// O desenho e feito aqui e mandado em pixels para o Rust. Desenhar do outro
/// lado exigiria embutir fonte e rasterizador so para escrever um numero.

import { ehTauri } from "./ambiente";

/// Tamanho do desenho. O Windows reduz para 16 ou 24 conforme o DPI; desenhar
/// grande e deixar ele reduzir sai melhor do que desenhar direto em 16.
const TAMANHO = 48;

/// Ultimo rotulo mandado. Sem isso, cada mensagem nova de um canal que ja tem
/// nao lidas repetiria a mesma travessia de 9 KB de pixels pela ponte.
let ultimoRotulo: string | null = null;

function rotuloDe(total: number): string {
  return total > 99 ? "99+" : String(total);
}

/// Circulo laranja com o numero em cima, na mesma cor do selo da lista de
/// canais.
///
/// O anel escuro em volta nao e enfeite: na bandeja o selo cai por cima do
/// proprio icone do aplicativo, que tambem e laranja, e sem o anel os dois se
/// fundem numa mancha so.
function desenhar(rotulo: string): ImageData | null {
  const canvas = document.createElement("canvas");
  canvas.width = TAMANHO;
  canvas.height = TAMANHO;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  const meio = TAMANHO / 2;
  ctx.fillStyle = "#17171b";
  ctx.beginPath();
  ctx.arc(meio, meio, meio, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#ff7a45";
  ctx.beginPath();
  ctx.arc(meio, meio, meio - 3, 0, Math.PI * 2);
  ctx.fill();

  // Tres caracteres ("99+") nao cabem no mesmo corpo que um digito sozinho.
  const corpo = rotulo.length >= 3 ? 22 : rotulo.length === 2 ? 27 : 32;
  ctx.fillStyle = "#17171b";
  ctx.font = `800 ${corpo}px "Segoe UI", Inter, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Um pixel abaixo do centro geometrico: `textBaseline: middle` mira o meio do
  // corpo da fonte, que fica acima do meio otico dos digitos.
  ctx.fillText(rotulo, meio, meio + 1);

  return ctx.getImageData(0, 0, TAMANHO, TAMANHO);
}

/// Poe o numero nos icones, ou tira quando nao ha nada por ler.
///
/// Silencioso de proposito: e um enfeite de sistema, e falhar nele nao pode
/// atrapalhar quem esta conversando. Mas o rotulo lembrado volta atras quando
/// da errado, senao uma falha passageira congelaria o selo no valor antigo ate
/// a contagem mudar de novo.
export async function atualizarSelo(total: number): Promise<void> {
  if (!ehTauri()) return;

  const rotulo = total > 0 ? rotuloDe(total) : "";
  if (rotulo === ultimoRotulo) return;
  const anterior = ultimoRotulo;
  ultimoRotulo = rotulo;

  try {
    const imagem = rotulo ? desenhar(rotulo) : null;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("selo_de_nao_lidas", {
      rgba: imagem ? Array.from(imagem.data) : [],
      largura: imagem ? imagem.width : 0,
      altura: imagem ? imagem.height : 0,
      total,
    });
  } catch {
    ultimoRotulo = anterior;
  }
}
