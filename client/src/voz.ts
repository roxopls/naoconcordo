/// Como o microfone abre, o que ele filtra e quanto ele esta captando.
///
/// Existe separado do `main.ts` porque sao tres assuntos que so se encontram no
/// microfone: o filtro (o que o WebRTC processa antes de enviar), o portao (o
/// que decide se a faixa vai ao ar) e o medidor (o que a pessoa ve enquanto
/// decide o limiar). Os tres leem o mesmo nivel de audio, entao dividir por
/// arquivo evitaria repetir o `AnalyserNode` em cada um.

export type ModoVoz = "sempre" | "voz" | "ptt";
export type Filtros = { ruido: boolean; eco: boolean; ganho: boolean };

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

export function lerFiltros(): Filtros {
  try {
    const bruto = JSON.parse(localStorage.getItem(FILTROS_KEY) || "null") as Partial<Filtros> | null;
    if (!bruto) return { ruido: true, eco: true, ganho: true };
    return {
      ruido: bruto.ruido !== false,
      eco: bruto.eco !== false,
      ganho: bruto.ganho !== false,
    };
  } catch {
    return { ruido: true, eco: true, ganho: true };
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
    noiseSuppression: filtros.ruido,
    autoGainControl: filtros.ganho,
    ...(deviceId ? { deviceId } : {}),
  };
}

/// Mede o nivel de uma faixa de audio e chama de volta ate ser desligado.
///
/// O valor sai em 0..100 numa escala **perceptual**, nao linear: a raiz
/// quadrada da media quadratica cresce rapido demais no comeco e a barra
/// passaria a vida encostada no zero. Devolve a funcao que desliga tudo —
/// esquecer de chamar deixa o `AudioContext` vivo segurando o microfone.
export function medir(
  track: MediaStreamTrack,
  aoNivel: (nivel: number) => void,
): () => void {
  const contexto = new AudioContext();
  const fonte = contexto.createMediaStreamSource(new MediaStream([track]));
  const analisador = contexto.createAnalyser();
  // Janela curta: o medidor precisa acompanhar a fala, nao suaviza-la.
  analisador.fftSize = 512;
  analisador.smoothingTimeConstant = 0.2;
  fonte.connect(analisador);

  const amostras = new Float32Array(analisador.fftSize);
  let vivo = true;
  let quadro = 0;

  const passo = () => {
    if (!vivo) return;
    analisador.getFloatTimeDomainData(amostras);
    let soma = 0;
    for (const amostra of amostras) soma += amostra * amostra;
    const rms = Math.sqrt(soma / amostras.length);
    aoNivel(Math.min(100, Math.round(Math.sqrt(rms) * 140)));
    quadro = requestAnimationFrame(passo);
  };
  quadro = requestAnimationFrame(passo);

  return () => {
    vivo = false;
    cancelAnimationFrame(quadro);
    fonte.disconnect();
    void contexto.close().catch(() => { /* ja fechado */ });
  };
}

/// Quanto tempo o microfone continua aberto depois que o nivel cai.
///
/// Sem esta cauda, a ativacao por voz corta entre as palavras e a frase chega
/// picotada do outro lado — o silencio dentro de uma frase e mais longo do que
/// parece quando medido em milissegundos.
export const CAUDA_MS = 450;
