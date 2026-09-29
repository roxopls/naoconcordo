/// Tamanho das coisas na tela: zoom proprio e janela que cabe no monitor.
///
/// Com o Windows em 150%, um monitor 1080p vira uns 1280x690 pontos uteis para
/// o WebView2. A janela nascia com 760 de altura e a caixa de mensagem ficava
/// para fora da tela; e tudo saia uma vez e meia maior, sem jeito de diminuir.
///
/// O padrao e **automatico**: o zoom desfaz a escala do Windows (150% vira
/// 1/1,5), e o app fica do tamanho que tem em 100%. Quem quiser outro tamanho
/// escolhe um valor fixo, e ai a escala do Windows deixa de contar.
///
/// O zoom e do **computador**, e nao da conta: fica fora das preferencias que
/// viajam, porque 80% no notebook de 150% seria miudo demais no monitor de 100%.
///
/// No navegador nada disto roda: la o Ctrl + e Ctrl - do proprio navegador ja
/// fazem exatamente isto.

import { ehTauri } from "./ambiente";

const CHAVE = "naoconcordo.zoom";

export const ZOOMS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5] as const;

/// O que a pessoa escolheu: um fator fixo, ou `null` para automatico.
export function zoomEscolhido(): number | null {
  try {
    const guardado = Number(localStorage.getItem(CHAVE));
    return (ZOOMS as readonly number[]).includes(guardado) ? guardado : null;
  } catch {
    return null;
  }
}

/// Escala do Windows no monitor em que a janela esta agora (1, 1,25, 1,5...).
async function escalaDoWindows(): Promise<number> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return await getCurrentWindow().scaleFactor();
  } catch {
    return 1;
  }
}

/// O fator que vale agora: o escolhido, ou o que desfaz a escala do Windows.
async function zoomEfetivo(): Promise<number> {
  return zoomEscolhido() ?? 1 / await escalaDoWindows();
}

async function aplicarZoom(fator: number) {
  if (!ehTauri()) return;
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().setZoom(fator);
  } catch (erro) {
    console.warn("[zoom] nao aplicado", erro);
  }
}

/// `null` volta ao automatico.
export async function mudarZoom(fator: number | null) {
  try {
    if (fator === null) localStorage.removeItem(CHAVE);
    else localStorage.setItem(CHAVE, String(fator));
  } catch { /* sem armazenamento: vale so ate fechar */ }
  await aplicarZoom(await zoomEfetivo());
}

/// Um degrau a partir do tamanho que esta na tela, ou automatico com zero.
async function passo(direcao: -1 | 0 | 1): Promise<number | null> {
  if (direcao === 0) return null;
  const agora = await zoomEfetivo();
  // O automatico pode dar um valor fora da lista (1/1,25 = 0,8 cai nela; 1/1,75
  // nao): parte do degrau mais proximo.
  let indice = 0;
  ZOOMS.forEach((fator, i) => { if (Math.abs(fator - agora) < Math.abs(ZOOMS[indice] - agora)) indice = i; });
  return ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, indice + direcao))];
}

/// Ctrl + / Ctrl - / Ctrl 0, como no navegador e no Discord. `aoMudar` avisa
/// quem mostra o valor (o seletor das configuracoes); `null` e automatico.
export function vigiarAtalhosDeZoom(aoMudar: (fator: number | null) => void) {
  if (!ehTauri()) return;
  window.addEventListener("keydown", evento => {
    if (!evento.ctrlKey || evento.altKey || evento.metaKey) return;
    const direcao = evento.key === "=" || evento.key === "+" ? 1
      : evento.key === "-" ? -1
      : evento.key === "0" ? 0
      : null;
    if (direcao === null) return;
    evento.preventDefault();
    void passo(direcao).then(fator => { void mudarZoom(fator); aoMudar(fator); });
  });
}

/// Encolhe e reposiciona a janela quando ela passa da area util do monitor.
///
/// So encolhe: quem aumentou a janela de proposito num monitor grande nao pode
/// ve-la mudar sozinha. Maximizada, o Windows ja cuida.
async function caberNoMonitor() {
  try {
    const { getCurrentWindow, currentMonitor, PhysicalSize, PhysicalPosition } = await import("@tauri-apps/api/window");
    const janela = getCurrentWindow();
    if (await janela.isMaximized()) return;
    const monitor = await currentMonitor();
    if (!monitor) return;
    const area = monitor.workArea;
    const tamanho = await janela.outerSize();
    const posicao = await janela.outerPosition();
    const largura = Math.min(tamanho.width, area.size.width);
    const altura = Math.min(tamanho.height, area.size.height);
    if (largura !== tamanho.width || altura !== tamanho.height) {
      await janela.setSize(new PhysicalSize(largura, altura));
    }
    const x = Math.min(Math.max(posicao.x, area.position.x), area.position.x + area.size.width - largura);
    const y = Math.min(Math.max(posicao.y, area.position.y), area.position.y + area.size.height - altura);
    if (x !== posicao.x || y !== posicao.y) await janela.setPosition(new PhysicalPosition(x, y));
  } catch (erro) {
    console.warn("[janela] nao deu para ajustar ao monitor", erro);
  }
}

/// Chamada uma vez na abertura da janela principal.
export async function prepararEscala() {
  if (!ehTauri()) return;
  await aplicarZoom(await zoomEfetivo());
  await caberNoMonitor();
  // Arrastar a janela para um monitor de outra escala, ou mudar a escala do
  // Windows com o app aberto: o automatico acompanha.
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().onScaleChanged(() => { void zoomEfetivo().then(aplicarZoom); });
  } catch (erro) {
    console.warn("[zoom] sem aviso de troca de escala", erro);
  }
}
