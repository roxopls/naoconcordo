/// Compartilhamento de tela sem `getDisplayMedia`.
///
/// O WebView2 e quem desenha o seletor do Edge e a barra de "esta
/// compartilhando sua tela". Nada disso e configuravel de dentro da pagina, e a
/// unica saida e nunca pedir a tela ao navegador: a captura acontece no Rust e
/// e publicada por uma conexao propria com o LiveKit.
///
/// Este modulo cuida da escolha e dos comandos; o quadro nunca passa por aqui.

import { invoke } from "@tauri-apps/api/core";

export type Source = {
  id: string;
  kind: "monitor" | "window";
  title: string;
  app: string;
  width: number;
  height: number;
};

export type ShareQuality = { width: number; height: number; fps: number; bitrate: number; preferMotion?: boolean };

export function getSourceThumbnail(sourceId: string) {
  return invoke<string>("screen_thumbnail", { sourceId });
}

export function listSources() {
  return invoke<Source[]>("screen_sources");
}

/// Este Windows respeita "capturar tudo menos o naoconcordo"?
///
/// Abaixo da build 20348 ele aceita o pedido e ignora a exclusao: compartilhar
/// o monitor com som devolve a propria conversa como eco. Nessas maquinas a
/// unica saida e escolher um programa, que usa o modo de inclusao.
export async function audioSemEco(): Promise<boolean> {
  try {
    const diag = await invoke<{ audioSemEco: boolean }>("screen_border_diag");
    return diag.audioSemEco;
  } catch {
    return true;
  }
}

/// Quem comprime a tela. "auto" tenta a GPU (AV1, depois H.264) e cai no
/// software se nao houver hardware; "software" e o caminho antigo, com o
/// libwebrtc comprimindo no processador.
export type CodecPreferido = "auto" | "h264" | "software";

export function startShare(
  sourceId: string,
  url: string,
  token: string,
  quality: ShareQuality,
  audio: boolean,
  forceDuplication = false,
  hideTitleBar = true,
  codec: CodecPreferido = "auto",
  audioSource = "",
) {
  // Devolve quem comprimiu: nome do codificador da placa, ou "software: <motivo>".
  return invoke<string>("screen_share_start", {
    sourceId, url, token, quality, audio, forceDuplication, hideTitleBar, codec, audioSource,
  });
}

const CODEC_KEY = "naoconcordo.codec-tela";
export function codecPreferido(): CodecPreferido {
  const guardado = localStorage.getItem(CODEC_KEY);
  return guardado === "h264" || guardado === "software" ? guardado : "auto";
}
export function guardarCodec(codec: CodecPreferido) {
  localStorage.setItem(CODEC_KEY, codec);
}

/// Pausa ou retoma sem despublicar: o sid continua o mesmo e quem assiste
/// volta a ver sozinho.
export function pauseShare(paused: boolean) {
  return invoke<boolean>("screen_share_pause", { paused });
}

/// A janela transmitida ainda existe? Fechar o programa congela a transmissao
/// sem avisar ninguem.
export function targetAlive() {
  return invoke<boolean>("screen_target_alive");
}

/// Troca a fonte sem parar a transmissao: o Rust aponta a captura para outra
/// janela e a faixa publicada continua a mesma, entao quem assiste nao ve corte.
export function switchShare(sourceId: string) {
  return invoke<void>("screen_share_switch", { sourceId });
}

export function stopShare() {
  return invoke<void>("screen_share_stop");
}

type Option = { id: string; label: string; hint: string } & ShareQuality;

export type Escolha<T> = {
  sourceId: string;
  quality: T;
  audio: boolean;
  motion: boolean;
  semBarra: boolean;
  /// Programa de onde tirar o som. Vazio quer dizer "o mesmo alvo da imagem",
  /// que para monitor significa tudo menos o naoconcordo.
  audioSource: string;
};

/// Mostra a grade de fontes e devolve o que a pessoa escolheu, ou `null` se
/// desistir. `qualities` vem de fora para nao duplicar os degraus do app, e o
/// tipo e generico para o `id` voltar estreito como entrou.
export function pickSource<T extends Option>(
  qualities: T[],
  current: T,
  byId: <E extends HTMLElement>(id: string) => E,
): Promise<Escolha<T> | null> {
  return new Promise(async resolve => {
    const dialog = byId<HTMLDialogElement>("source-dialog");
    const grid = byId("source-grid");
    const qualityBox = byId("source-quality");
    const startButton = byId<HTMLButtonElement>("source-start");
    const audioBox = byId<HTMLInputElement>("source-audio");
    const audioFonte = byId<HTMLSelectElement>("source-audio-fonte");
    const audioLinha = byId("source-audio-fonte-linha");
    const motionBox = byId<HTMLInputElement>("source-motion");
    const barraBox = byId<HTMLInputElement>("source-barra");
    const barraLinha = byId("source-barra-linha");

    let chosenSource = "";
    let chosenQuality = current;

    const ehMonitor = () =>
      sources.some(item => item.id === chosenSource && item.kind === "monitor");

    /// O que a pessoa marcou, junto. Existe para o botao e o duplo clique nao
    /// montarem o mesmo objeto de dois jeitos.
    const escolhido = (): Escolha<T> => ({
      sourceId: chosenSource,
      quality: chosenQuality,
      audio: audioBox.checked,
      motion: motionBox.checked,
      semBarra: barraBox.checked,
      // So vale para monitor: numa janela o som ja e o daquele programa.
      audioSource: ehMonitor() && audioBox.checked ? audioFonte.value : "",
    });

    const finish = (value: Escolha<T> | null) => {
      startButton.onclick = null;
      audioBox.onchange = null;
      byId<HTMLButtonElement>("source-cancel").onclick = null;
      dialog.close();
      resolve(value);
    };

    grid.replaceChildren(document.createTextNode("Procurando janelas..."));
    dialog.showModal();
    byId<HTMLButtonElement>("source-cancel").onclick = () => finish(null);

    const semEco = await audioSemEco();
    let sources: Source[];
    try {
      sources = await listSources();
    } catch {
      grid.replaceChildren(document.createTextNode("Nao foi possivel listar as telas."));
      return;
    }

    const paint = () => {
      startButton.disabled = !chosenSource;
      audioFonte.onchange = paint;
      // Monitor nao tem barra de titulo: oferecer a opcao ali so confundiria.
      const ehJanela = sources.some(item => item.id === chosenSource && item.kind === "window");
      barraLinha.classList.toggle("hidden", !ehJanela);
      // Compartilhando o monitor, o padrao e tudo que a maquina toca menos o
      // naoconcordo. Ha Windows que ignora essa exclusao e devolve a chamada
      // como eco; escolher um programa aqui fecha essa porta.
      const mostrarFonte = ehMonitor() && audioBox.checked;
      audioLinha.classList.toggle("hidden", !mostrarFonte);
      // Onde a exclusao nao funciona, "tudo" nao e uma escolha valida: avisa e
      // segura o botao ate a pessoa escolher um programa.
      const vaiEcoar = mostrarFonte && !semEco && !audioFonte.value;
      byId("source-audio-aviso").classList.toggle("hidden", !vaiEcoar);
      startButton.disabled = !chosenSource || vaiEcoar;
      for (const card of grid.querySelectorAll(".source-card")) {
        card.classList.toggle("active", (card as HTMLElement).dataset.id === chosenSource);
      }
    };

    grid.replaceChildren(...sources.map(source => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "source-card";
      card.dataset.id = source.id;

      const thumb = document.createElement("div");
      thumb.className = "source-thumb";
      getSourceThumbnail(source.id).then(dataUri => {
        const img = document.createElement("img");
        img.src = dataUri;
        img.alt = source.title;
        thumb.replaceChildren(img);
      }).catch(() => {
        // Sem miniatura; fica o placeholder cinza
      });

      const badge = document.createElement("span");
      badge.className = "source-kind";
      badge.textContent = source.kind === "monitor" ? "Tela" : "Janela";

      const title = document.createElement("strong");
      title.textContent = source.title;

      const detail = document.createElement("small");
      // Para monitor, o nome do app fica vazio e sobra so a resolucao.
      detail.textContent = [source.app, `${source.width}x${source.height}`]
        .filter(Boolean).join(" — ");

      card.append(thumb, badge, title, detail);
      card.onclick = () => { chosenSource = source.id; paint(); };
      // Duplo clique comeca direto: escolher e confirmar num gesto so.
      card.ondblclick = () => { chosenSource = source.id; finish(escolhido()); };
      return card;
    }));

    // Degraus de qualidade num slider: a ordem ja e crescente, entao arrastar
    // para a direita sempre significa "mais pesado". Um radio por degrau
    // ocupava a altura toda do dialogo e escondia a grade de fontes.
    const range = document.createElement("input");
    range.type = "range";
    range.className = "quality-range";
    range.min = "0";
    range.max = String(qualities.length - 1);
    range.step = "1";
    range.value = String(Math.max(0, qualities.findIndex(item => item.id === chosenQuality.id)));

    const ticks = document.createElement("div");
    ticks.className = "quality-ticks";
    ticks.replaceChildren(...qualities.map(item => {
      const tick = document.createElement("span");
      tick.textContent = item.label;
      // Clicar no rotulo salta para o degrau: o alvo do slider e fino demais.
      tick.onclick = () => { range.value = String(qualities.indexOf(item)); mostrar(); };
      return tick;
    }));

    const readout = document.createElement("p");
    readout.className = "quality-readout";

    const mostrar = () => {
      chosenQuality = qualities[Number(range.value)] || qualities[0];
      readout.textContent = chosenQuality.hint + " — até "
        + Math.round(chosenQuality.bitrate / 100000) / 10 + " Mbps";
      for (const [indice, tick] of Array.from(ticks.children).entries()) {
        tick.classList.toggle("active", indice === Number(range.value));
      }
    };
    range.oninput = mostrar;

    qualityBox.replaceChildren(range, ticks, readout);
    mostrar();

    // Por aplicativo, e nao por janela: duas janelas do mesmo programa sao a
    // mesma arvore de processos, e o loopback pega a arvore inteira.
    const programas = new Map<string, string>();
    for (const item of sources) {
      if (item.kind !== "window" || !item.app) continue;
      if (!programas.has(item.app)) programas.set(item.app, item.id);
    }
    audioFonte.replaceChildren(
      new Option("Tudo o que a máquina tocar", ""),
      ...[...programas].map(([app, id]) => new Option("Somente " + app, id)),
    );
    audioBox.onchange = paint;

    paint();
    startButton.onclick = () => {
      if (!chosenSource) return;
      finish(escolhido());
    };
  });
}
