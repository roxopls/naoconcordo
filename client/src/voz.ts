/// Como o microfone abre, o que ele filtra e quanto ele esta captando.
///
/// Existe separado do `main.ts` porque sao tres assuntos que so se encontram no
/// microfone: o filtro (o que o WebRTC processa antes de enviar), o portao (o
/// que decide se a faixa vai ao ar) e o medidor (o que a pessoa ve enquanto
/// decide o limiar). Os tres leem o mesmo nivel de audio, entao dividir por
/// arquivo evitaria repetir o `AnalyserNode` em cada um.

// `no-inline` e obrigatorio: arquivo pequeno o vite embute como `data:`, e o
// CSP do aplicativo (`script-src 'self'`) recusa worklet vindo de `data:`. A
// recusa nao quebra nada visivel — a medicao cai no relogio de reserva, que e
// justamente o que o worklet existe para evitar.
import NIVEL_WORKLET from "./nivel.worklet.js?url&no-inline";

// O supressor de ruido por rede neural. Mesmo motivo do `no-inline` acima: o
// CSP recusa worklet vindo de `data:`.
import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";
import RNNOISE_WORKLET from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url&no-inline";
import RNNOISE_WASM from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import RNNOISE_WASM_SIMD from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";

export type ModoVoz = "sempre" | "voz" | "ptt";
/// Quem reduz o ruido de fundo.
///
/// `webrtc` e o que o proprio WebView faz, de graca, dentro do `getUserMedia`.
/// `rnnoise` e uma rede neural pequena que roda aqui, num `AudioWorklet`, entre
/// o microfone e a chamada: ela distingue voz de ruido em vez de so cortar o que
/// e constante, entao segura teclado mecanico, ventilador e cachorro ao fundo,
/// que e onde o do WebView entrega os pontos.
export type MotorDeRuido = "webrtc" | "rnnoise";
export type Filtros = { ruido: boolean; eco: boolean; ganho: boolean; motor: MotorDeRuido };

const MODO_KEY = "naoconcordo.voz.modo";
const LIMIAR_KEY = "naoconcordo.voz.limiar";
const FILTROS_KEY = "naoconcordo.voz.filtros";

export function lerModo(): ModoVoz {
  const valor = localStorage.getItem(MODO_KEY);
  return valor === "voz" || valor === "ptt" ? valor : "sempre";
}
export function guardarModo(modo: ModoVoz) {
  localStorage.setItem(MODO_KEY, modo);
}

/// Limiar em 1..60, na mesma escala do medidor. Guardado como numero para o
/// controle deslizante e a comparacao usarem a mesma unidade.
export function lerLimiar(): number {
  const valor = Number(localStorage.getItem(LIMIAR_KEY));
  return Number.isFinite(valor) && valor >= 1 && valor <= 60 ? valor : 12;
}
export function guardarLimiar(valor: number) {
  localStorage.setItem(LIMIAR_KEY, String(valor));
}

const PADRAO: Filtros = { ruido: true, eco: true, ganho: true, motor: "webrtc" };

export function lerFiltros(): Filtros {
  try {
    const bruto = JSON.parse(localStorage.getItem(FILTROS_KEY) || "null") as Partial<Filtros> | null;
    if (!bruto) return PADRAO;
    return {
      ruido: bruto.ruido !== false,
      eco: bruto.eco !== false,
      ganho: bruto.ganho !== false,
      // Quem ja usava o aplicativo continua no motor do WebView ate escolher o
      // outro: trocar o som do microfone de alguem sem aviso nao e atualizacao,
      // e susto.
      motor: bruto.motor === "rnnoise" ? "rnnoise" : "webrtc",
    };
  } catch {
    return PADRAO;
  }
}
export function guardarFiltros(filtros: Filtros) {
  localStorage.setItem(FILTROS_KEY, JSON.stringify(filtros));
}

/// O que o LiveKit deve pedir ao Windows na hora de abrir o microfone.
///
/// Sao os tres processamentos do WebRTC, e cada um tem contraindicacao: o
/// cancelamento de eco e inutil com fone e come agudos; o ganho automatico
/// salva quem fala longe do microfone e estraga quem ja tem ganho ajustado; a
/// reducao de ruido come o comeco das palavras em voz baixa. Por isso sao
/// escolha, e nao decisao nossa.
export function opcoesDeCaptura(deviceId?: string) {
  const filtros = lerFiltros();
  return {
    echoCancellation: filtros.eco,
    // Com o RNNoise ligado, o do WebView sai: dois supressores em fila brigam
    // pelo mesmo sinal, e o segundo recebe uma voz que o primeiro ja mexeu —
    // o resultado e voz com buraco, nao silencio melhor.
    noiseSuppression: filtros.ruido && filtros.motor === "webrtc",
    autoGainControl: filtros.ganho,
    ...(deviceId ? { deviceId } : {}),
  };
}

/// O RNNoise esta ligado, e portanto a cadeia de audio precisa existir?
export function comRnnoise(): boolean {
  const filtros = lerFiltros();
  return filtros.ruido && filtros.motor === "rnnoise";
}

/// Mede o nivel de uma faixa de audio e chama de volta ate ser desligado.
///
/// O valor sai em 0..100 numa escala **perceptual**, nao linear: a raiz
/// quadrada da media quadratica cresce rapido demais no comeco e a barra
/// passaria a vida encostada no zero. Devolve a funcao que desliga tudo —
/// esquecer de chamar deixa o `AudioContext` vivo segurando o microfone.
///
/// **Nada de `requestAnimationFrame`.** O quadro de animacao para por completo
/// com a janela minimizada ou coberta por um jogo em tela cheia, e o portao de
/// voz congelava no ultimo estado — fechado, na pratica, porque quase ninguem
/// esta falando no instante do alt-tab. O microfone ficava mudo para a sala ate
/// a janela voltar.
///
/// O caminho principal e um `AudioWorklet` (`nivel.worklet.js`): mede na thread
/// de audio e manda o valor por mensagem, que nao passa pelo freio de pagina em
/// segundo plano. `setInterval` tambem e freado — medido: uma volta por segundo
/// com a aba escondida, o que abriria o portao um segundo atrasado e cortaria o
/// comeco da fala. Ele fica so como reserva, lendo o analisador enquanto o
/// worklet nao responde (carregando, ou ambiente sem suporte).
///
/// Nivel `-1` quer dizer "nao da para medir agora" (contexto de audio parado).
///
/// `aoFalhar` avisa quando a medicao morreu de vez (faixa encerrada, trocar ou
/// tirar o microfone): quem usa decide o que fazer, e o portao abre.
export function medir(
  track: MediaStreamTrack,
  aoNivel: (nivel: number) => void,
  aoFalhar?: () => void,
): () => void {
  const contexto = new AudioContext();
  const fonte = contexto.createMediaStreamSource(new MediaStream([track]));
  const analisador = contexto.createAnalyser();
  // Janela curta: o medidor precisa acompanhar a fala, nao suaviza-la.
  analisador.fftSize = 512;
  analisador.smoothingTimeConstant = 0.2;
  fonte.connect(analisador);

  const amostras = new Float32Array(analisador.fftSize);
  const escala = (rms: number) => Math.min(100, Math.round(Math.sqrt(rms) * 140));
  let vivo = true;
  let ultimaDoWorklet = 0;
  let worklet: AudioWorkletNode | null = null;
  let silencio: GainNode | null = null;

  const falhar = () => {
    if (!vivo) return;
    parar();
    aoFalhar?.();
  };

  const passo = () => {
    if (!vivo) return;
    if (track.readyState === "ended") { falhar(); return; }
    // Contexto parado nao mede nada, e ler zero ali fecharia o portao de vez.
    // -1 diz "sem medicao" a quem usa, que decide (o portao abre).
    if (contexto.state !== "running") {
      void contexto.resume().catch(() => { /* proxima volta */ });
      aoNivel(-1);
      return;
    }
    // Worklet respondendo ha pouco: ele manda, a reserva fica quieta.
    if (performance.now() - ultimaDoWorklet < 300) return;
    analisador.getFloatTimeDomainData(amostras);
    let soma = 0;
    for (const amostra of amostras) soma += amostra * amostra;
    aoNivel(escala(Math.sqrt(soma / amostras.length)));
  };
  const relogio = window.setInterval(passo, 30);

  void contexto.audioWorklet?.addModule(NIVEL_WORKLET).then(() => {
    if (!vivo) return;
    worklet = new AudioWorkletNode(contexto, "naoconcordo-nivel");
    worklet.port.onmessage = evento => {
      if (!vivo) return;
      ultimaDoWorklet = performance.now();
      if (track.readyState === "ended") { falhar(); return; }
      aoNivel(escala(evento.data as number));
    };
    fonte.connect(worklet);
    // Ligado ao destino por um ganho zero: no ar para o grafo processar, sem
    // devolver o proprio microfone no alto-falante.
    silencio = contexto.createGain();
    silencio.gain.value = 0;
    worklet.connect(silencio).connect(contexto.destination);
  }).catch(erro => console.warn("[voz] worklet indisponivel, medindo por relogio", erro));

  const parar = () => {
    vivo = false;
    window.clearInterval(relogio);
    if (worklet) worklet.port.onmessage = null;
    fonte.disconnect();
    worklet?.disconnect();
    silencio?.disconnect();
    void contexto.close().catch(() => { /* ja fechado */ });
  };
  return parar;
}

/// Quanto tempo o microfone continua aberto depois que o nivel cai.
///
/// Sem esta cauda, a ativacao por voz corta entre as palavras e a frase chega
/// picotada do outro lado — o silencio dentro de uma frase e mais longo do que
/// parece quando medido em milissegundos.
export const CAUDA_MS = 450;

// ------------------------------------------------------- ganho do microfone

const GANHO_KEY = "naoconcordo.voz.ganho";

/// Quanto o microfone e amplificado, em porcentagem. 100 e o som como o Windows
/// entrega; acima disso o aplicativo amplifica por conta.
///
/// O teto e 300 porque amplificar sem limite nao resolve microfone ruim — passa
/// a somar chiado junto com a voz, e a partir de certo ponto satura e distorce.
export function lerGanho(): number {
  const valor = Number(localStorage.getItem(GANHO_KEY));
  return Number.isFinite(valor) && valor >= 100 && valor <= 300 ? valor : 100;
}
export function guardarGanho(valor: number) {
  localStorage.setItem(GANHO_KEY, String(valor));
}

/// O binario do RNNoise, buscado uma vez so.
///
/// Sao ~100 KB que nao mudam entre uma chamada e outra; guardar a promessa
/// evita baixar de novo a cada vez que o microfone abre, e faz as aberturas
/// seguintes entrarem sem espera nenhuma.
let rnnoiseBinario: Promise<ArrayBuffer> | null = null;
/// Os contextos que ja carregaram o worklet. `addModule` duas vezes no mesmo
/// contexto e erro, e um `WeakSet` esquece o contexto junto com ele.
const comWorklet = new WeakSet<AudioContext>();

/// A cadeia que entra entre o microfone e o que e publicado.
///
/// Microfone -> [RNNoise] -> [ganho] -> chamada, com os dois degraus do meio
/// opcionais. Os dois moram na mesma classe porque o LiveKit so aceita **um**
/// processador por faixa: em classes separadas, ligar o ganho desligaria o
/// supressor de ruido sem avisar ninguem.
///
/// Vai como `TrackProcessor` do LiveKit em vez de faixa propria: assim ligar,
/// desligar e trocar de dispositivo continuam sendo trabalho dele, e nos so
/// acrescentamos um degrau no meio do caminho.
export class CadeiaDoMicrofone {
  name = "cadeia-do-microfone";
  processedTrack?: MediaStreamTrack;
  private contexto?: AudioContext;
  private no?: GainNode;
  private ruido?: RnnoiseWorkletNode;
  private fonte?: MediaStreamAudioSourceNode;
  private destino?: MediaStreamAudioDestinationNode;
  /// O contexto e nosso, e portanto nosso para fechar. Quando vem do LiveKit,
  /// fecha-lo derrubaria o audio dele junto.
  private contextoProprio = false;

  async init(opcoes: { track: MediaStreamTrack; audioContext?: AudioContext }) {
    // O tipo do LiveKit diz que `audioContext` sempre vem, mas ele so preenche
    // quando a sala ja tem um contexto criado — e ai `createMediaStreamSource`
    // estourava em "cannot read properties of undefined". Abrir o nosso quando
    // faltar e o que faz o ganho existir em qualquer caso.
    const queroRnnoise = comRnnoise();
    // O RNNoise foi treinado a 48 kHz e o worklet conta com isso. Emprestado o
    // contexto do LiveKit em outra taxa, o certo e abrir o nosso na taxa dele:
    // reamostrar aqui sairia mais caro do que um contexto a mais.
    const empresta = opcoes.audioContext && (!queroRnnoise || opcoes.audioContext.sampleRate === 48000);
    this.contextoProprio = !empresta;
    this.contexto = empresta ? opcoes.audioContext! : new AudioContext(queroRnnoise ? { sampleRate: 48000 } : {});
    // Politica de reproducao automatica: contexto novo pode nascer suspenso, e
    // suspenso ele nao processa nada — o microfone sairia mudo.
    if (this.contexto.state === "suspended") await this.contexto.resume();
    this.fonte = this.contexto.createMediaStreamSource(new MediaStream([opcoes.track]));
    this.destino = this.contexto.createMediaStreamDestination();

    if (queroRnnoise) {
      try {
        this.ruido = await abrirRnnoise(this.contexto);
      } catch (erro) {
        // Sem o supressor a chamada segue com o som cru, que e pior do que o
        // prometido e melhor do que microfone mudo. Quem escolheu o RNNoise ve
        // o aviso e pode voltar ao do WebView.
        console.warn("[voz] rnnoise indisponivel", erro);
      }
    }

    const ganho = lerGanho();
    if (ganho !== 100) {
      this.no = this.contexto.createGain();
      this.no.gain.value = ganho / 100;
    }
    // A fila e montada com o que existe: sem ruido e sem ganho ela e so fonte
    // ligada ao destino, e a faixa sai igual a que entrou.
    const fila: AudioNode[] = [this.fonte, this.ruido, this.no, this.destino].filter(Boolean) as AudioNode[];
    fila.reduce((antes, agora) => antes.connect(agora));
    this.processedTrack = this.destino.stream.getAudioTracks()[0];
  }

  async restart(opcoes: { track: MediaStreamTrack; audioContext?: AudioContext }) {
    await this.destroy();
    await this.init(opcoes);
  }

  async destroy() {
    this.fonte?.disconnect();
    this.no?.disconnect();
    this.ruido?.disconnect();
    // O worklet segura memoria do lado do WASM; `destroy` e o que a devolve.
    this.ruido?.destroy();
    this.destino?.disconnect();
    if (this.contextoProprio) await this.contexto?.close().catch(() => { /* ja fechado */ });
    this.fonte = undefined;
    this.no = undefined;
    this.ruido = undefined;
    this.destino = undefined;
    this.contexto = undefined;
    this.processedTrack = undefined;
  }

  /// Muda o volume ao vivo, sem refazer a faixa: quem esta na chamada nao
  /// percebe corte enquanto a pessoa arrasta o controle.
  ///
  /// Devolve `false` quando nao ha no de ganho para mexer — em 100% nao ha — e
  /// ai quem chamou precisa remontar a cadeia.
  definir(porcentagem: number): boolean {
    if (!this.no) return porcentagem === 100;
    this.no.gain.value = porcentagem / 100;
    return true;
  }
}

/// Carrega o worklet e o WASM do RNNoise e devolve o no pronto para entrar.
async function abrirRnnoise(contexto: AudioContext): Promise<RnnoiseWorkletNode> {
  rnnoiseBinario ??= loadRnnoise({ url: RNNOISE_WASM, simdUrl: RNNOISE_WASM_SIMD });
  const binario = await rnnoiseBinario;
  if (!comWorklet.has(contexto)) {
    await contexto.audioWorklet.addModule(RNNOISE_WORKLET);
    comWorklet.add(contexto);
  }
  // Mono: o microfone e uma voz so, e o worklet processa cada canal separado —
  // pedir dois dobraria o custo por nada.
  return new RnnoiseWorkletNode(contexto, { maxChannels: 1, wasmBinary: binario });
}
