/// Onde este codigo esta rodando.
///
/// O mesmo pacote serve o aplicativo do Windows e a versao que abre no
/// navegador. A maior parte funciona nos dois — interface, chat, voz e camera
/// sao web puro —, mas o que depende do Rust nao existe fora do aplicativo:
/// captura de tela sem seletor do Edge, consumo por processo, atualizador,
/// bandeja.
///
/// A deteccao e por objeto injetado, nao por `navigator.userAgent`: o WebView2
/// se apresenta como Edge, entao o agente diria "navegador" nos dois casos.
export const ehTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/// Abre um endereco externo no navegador do sistema.
///
/// No aplicativo, `window.open` e engolido: o Tauri intercepta o pedido de
/// janela nova e recusa navegar para fora, sem erro. No navegador acontece o
/// contrario — o plugin nao existe e `window.open` e o caminho certo.
export async function abrirExterno(url: string): Promise<void> {
  if (!ehTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

/// Abre uma das paginas auxiliares (cameras, transmissoes) numa janela propria.
///
/// Devolve `false` quando nao foi possivel — no navegador, um bloqueador de
/// pop-up pode recusar, e quem chamou precisa saber para desfazer o estado.
export async function abrirJanela(
  rotulo: string,
  url: string,
  titulo: string,
  largura: number,
  altura: number,
): Promise<boolean> {
  if (!ehTauri()) {
    const aberta = window.open(url, rotulo, `popup=yes,width=${largura},height=${altura}`);
    return Boolean(aberta);
  }
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  // Sem a moldura do Windows: a barra desenhada pelo proprio aplicativo entra no
  // lugar dela, e assim todas as janelas ficam com a mesma cara.
  new WebviewWindow(rotulo, {
    url, title: titulo, width: largura, height: altura,
    resizable: true, decorations: false,
  });
  return true;
}
