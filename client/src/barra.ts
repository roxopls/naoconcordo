// A barra de título do aplicativo, para qualquer janela.
//
// A janela principal já desenhava a própria barra, com o cartão do servidor. As
// janelas de telas e de câmeras ficavam com a moldura do Windows, e o aplicativo
// aparecia com duas caras conforme a janela.
//
// Aqui mora a versão simples, só com o nome e os três botões. A janela principal
// continua com a dela, que carrega o ícone e o nome do servidor.

import { bloquearRecarregar, ehTauri } from "./ambiente";

/// Desenha a barra no topo da janela e liga os botões.
///
/// Fora do Tauri não faz nada: no navegador a moldura é da aba, e desenhar uma
/// barra falsa com botões que não fecham nada seria pior do que não ter.
export async function instalarBarra(titulo: string) {
  if (!ehTauri()) return;
  // Estas janelas passam por aqui na abertura, entao e o lugar natural.
  bloquearRecarregar();

  const barra = document.createElement("header");
  barra.className = "titlebar";
  // Arrastar e o duplo clique para maximizar vêm daqui; os botões abaixo
  // cuidam só do clique direto.
  barra.setAttribute("data-tauri-drag-region", "");

  const nome = document.createElement("div");
  nome.className = "titlebar-servidor";
  nome.setAttribute("data-tauri-drag-region", "");
  const forte = document.createElement("strong");
  forte.textContent = titulo;
  forte.setAttribute("data-tauri-drag-region", "");
  nome.append(forte);

  const botoes = document.createElement("div");
  botoes.className = "titlebar-botoes";

  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const janela = getCurrentWindow();
    botoes.append(
      botao("Minimizar", "M2 6h8", () => void janela.minimize()),
      botao("Maximizar", null, () => void janela.toggleMaximize()),
      botao("Fechar", "M3 3l6 6M9 3l-6 6", () => void janela.close(), true),
    );
  } catch (erro) {
    // Sem os controles da janela a barra não tem função, e uma faixa sem botões
    // só comeria espaço no topo.
    console.warn("[janela] controles indisponiveis", erro);
    return;
  }

  barra.append(nome, botoes);
  document.body.prepend(barra);
  document.body.classList.add("com-barra");
}

/// Um botão da barra. `desenho` nulo usa o quadrado de maximizar.
function botao(rotulo: string, desenho: string | null, aoClicar: () => void, fechar = false) {
  const elemento = document.createElement("button");
  elemento.type = "button";
  elemento.title = rotulo;
  elemento.setAttribute("aria-label", rotulo);
  if (fechar) elemento.className = "fechar";

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 12 12");
  if (desenho) {
    const traco = document.createElementNS("http://www.w3.org/2000/svg", "path");
    traco.setAttribute("d", desenho);
    svg.append(traco);
  } else {
    const quadro = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    quadro.setAttribute("x", "2.5");
    quadro.setAttribute("y", "2.5");
    quadro.setAttribute("width", "7");
    quadro.setAttribute("height", "7");
    quadro.setAttribute("rx", "1");
    svg.append(quadro);
  }

  elemento.append(svg);
  elemento.onclick = aoClicar;
  return elemento;
}
