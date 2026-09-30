// Gestos de toque, para quando o aplicativo esta num celular.
//
// A tela larga nao passa por aqui: os gestos so valem onde as gavetas existem
// (abaixo de 720 px, ver o fim do `styles.css`) e onde o ponteiro e grosso — num
// laptop com tela sensivel ao toque, arrastar com o dedo dentro da conversa e
// rolagem, e virar isso em "abriu a gaveta" seria roubar o gesto de quem le.
//
// # O que cada arrasto faz
//
// - da esquerda para a direita: abre canais e servidores; com a lista de
//   pessoas aberta, fecha ela primeiro;
// - da direita para a esquerda: abre quem esta online; com os canais abertos,
//   fecha eles primeiro;
// - para baixo, sobre o palco da chamada: fecha o palco e volta para a conversa;
// - pinca sobre uma camera ou transmissao: amplia, e o meio dos dois dedos
//   arrasta a imagem. Voltar para o tamanho normal desfaz.
//
// Toque duplo para tela cheia nao mora aqui: as tiles ja tratam `dblclick`, e o
// navegador do celular o dispara no toque duplo — o que faltava era o CSS
// (`touch-action: manipulation`) impedir que ele fosse comido pelo "toque duplo
// para aproximar a pagina".

/// O que os gestos precisam saber e mexer. Quem manda e o `main.ts`: o estado
/// da tela mora la, e duplicar aqui uma copia dele seria criar duas verdades.
export type Gestos = {
  /// Abre ou fecha uma das gavetas.
  gaveta: (lado: "esquerda" | "direita", abrir: boolean) => void;
  /// Qual gaveta esta aberta agora.
  gavetaAberta: () => "esquerda" | "direita" | null;
  /// O palco da chamada esta na tela?
  palcoAberto: () => boolean;
  /// Fecha o palco.
  fecharPalco: () => void;
};

/// Quanto o dedo precisa andar para contar como arrasto.
///
/// 60 px e o que separa arrasto de tremida: mais baixo, uma rolagem torta abria
/// a gaveta sozinha.
const DISTANCIA = 60;
/// Quanto pode desviar no outro eixo. Sem este teto, rolar a conversa na
/// diagonal abriria a gaveta.
const DESVIO = 45;
/// Arrasto que passa disto e outra coisa: dedo parado na tela, escolha de texto,
/// mao apoiada.
const TEMPO_MAX = 700;
/// Ate quanto a pinca amplia. Acima de quatro vezes a imagem da chamada e so
/// borrao, e o dedo perde o que estava tentando ler.
const ZOOM_MAX = 4;

/// Este aparelho e um celular na pratica? Medido a cada gesto, e nao uma vez na
/// abertura: a janela muda de tamanho e o aparelho pode ganhar teclado e mouse.
const ehCelular = () =>
  window.matchMedia("(max-width: 720px)").matches && window.matchMedia("(pointer: coarse)").matches;

/// O arrasto comecou em cima de algo que ja usa arrasto para outra coisa?
///
/// Campo de texto, recorte da imagem da chamada e qualquer faixa que role na
/// horizontal (os controles da chamada, as abas das configuracoes) tem o gesto
/// deles, e roubar isso deixa a tela com partes que nao respondem mais.
function gestoReservado(alvo: HTMLElement | null): boolean {
  if (!alvo) return false;
  if (alvo.closest("input, textarea, [contenteditable=\"true\"], .recorte-palco, dialog, .sons-volume")) return true;
  for (let no: HTMLElement | null = alvo; no; no = no.parentElement) {
    const estilo = getComputedStyle(no);
    const rola = estilo.overflowX === "auto" || estilo.overflowX === "scroll";
    if (rola && no.scrollWidth > no.clientWidth + 4) return true;
  }
  return false;
}

/// Amplia uma tile de video com dois dedos.
///
/// O que se move e a imagem dentro da moldura, e nao a moldura: a grade continua
/// do tamanho que estava, e a tile ampliada nao empurra as outras da tela.
function instalarPinca(palco: HTMLElement) {
  let tile: HTMLElement | null = null;
  let distancia0 = 0;
  let meio0 = { x: 0, y: 0 };
  let zoom0 = 1;
  let deslocamento0 = { x: 0, y: 0 };

  const medir = (toques: TouchList) => {
    const [a, b] = [toques[0], toques[1]];
    return {
      distancia: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
      meio: { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 },
    };
  };
  const ler = (elemento: HTMLElement, nome: string) => Number(elemento.style.getPropertyValue(nome) || 0);

  palco.addEventListener("touchstart", evento => {
    if (!ehCelular() || evento.touches.length !== 2) return;
    const achado = (evento.target as HTMLElement | null)?.closest<HTMLElement>(".track-tile");
    if (!achado) return;
    tile = achado;
    const { distancia, meio } = medir(evento.touches);
    distancia0 = distancia;
    meio0 = meio;
    zoom0 = Number(tile.style.getPropertyValue("--zoom") || 1);
    deslocamento0 = { x: ler(tile, "--zoom-x"), y: ler(tile, "--zoom-y") };
  }, { passive: true });

  palco.addEventListener("touchmove", evento => {
    if (!tile || evento.touches.length !== 2) return;
    // `preventDefault` aqui, e so aqui: sem ele o navegador amplia a pagina
    // inteira junto, e a pessoa fica com dois zooms empilhados.
    evento.preventDefault();
    const { distancia, meio } = medir(evento.touches);
    if (distancia0 <= 0) return;
    const zoom = Math.min(ZOOM_MAX, Math.max(1, zoom0 * (distancia / distancia0)));
    tile.style.setProperty("--zoom", String(zoom));
    // No tamanho normal a imagem volta para o lugar: imagem inteira torta
    // dentro da moldura nao e nada que alguem tenha pedido.
    if (zoom <= 1.01) {
      tile.style.removeProperty("--zoom");
      tile.style.removeProperty("--zoom-x");
      tile.style.removeProperty("--zoom-y");
      tile.classList.remove("ampliada");
      return;
    }
    tile.classList.add("ampliada");
    tile.style.setProperty("--zoom-x", (deslocamento0.x + (meio.x - meio0.x)) + "px");
    tile.style.setProperty("--zoom-y", (deslocamento0.y + (meio.y - meio0.y)) + "px");
  }, { passive: false });

  const soltar = () => { tile = null; };
  palco.addEventListener("touchend", soltar, { passive: true });
  palco.addEventListener("touchcancel", soltar, { passive: true });
}

export function instalarGestos(g: Gestos) {
  let inicio: { x: number; y: number; em: number } | null = null;
  let reservado = false;

  document.addEventListener("touchstart", evento => {
    if (evento.touches.length !== 1) { inicio = null; return; }
    const toque = evento.touches[0];
    inicio = { x: toque.clientX, y: toque.clientY, em: Date.now() };
    reservado = gestoReservado(evento.target as HTMLElement | null);
  }, { passive: true });

  document.addEventListener("touchend", evento => {
    const comeco = inicio;
    inicio = null;
    if (!comeco || reservado || !ehCelular()) return;
    // Um dedo so: o que sobra de uma pinca nao e arrasto.
    if (evento.touches.length > 0) return;
    const fim = evento.changedTouches[0];
    if (!fim) return;
    if (Date.now() - comeco.em > TEMPO_MAX) return;
    const dx = fim.clientX - comeco.x;
    const dy = fim.clientY - comeco.y;

    if (Math.abs(dx) >= DISTANCIA && Math.abs(dy) <= DESVIO) {
      const aberta = g.gavetaAberta();
      if (dx > 0) {
        // Para a direita: fecha a lista de pessoas se ela estiver na frente,
        // senao traz canais e servidores.
        if (aberta === "direita") g.gaveta("direita", false);
        else if (!aberta) g.gaveta("esquerda", true);
      } else {
        if (aberta === "esquerda") g.gaveta("esquerda", false);
        else if (!aberta) g.gaveta("direita", true);
      }
      return;
    }

    // Para baixo sobre o palco: volta para a conversa. So com gaveta nenhuma
    // aberta — ali embaixo o arrasto vertical e rolagem da lista.
    if (dy >= DISTANCIA && Math.abs(dx) <= DESVIO && !g.gavetaAberta() && g.palcoAberto()) {
      const naChamada = (fim.target as HTMLElement | null)?.closest(".stage");
      if (naChamada) g.fecharPalco();
    }
  }, { passive: true });

  const palco = document.querySelector<HTMLElement>(".stage");
  if (palco) instalarPinca(palco);
}
