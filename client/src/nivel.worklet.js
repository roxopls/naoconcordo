// Nivel do microfone medido na thread de audio.
//
// Existe para o portao de ativacao por voz nao depender de relogio da pagina:
// com a janela minimizada ou atras de um jogo, o Chromium segura
// `requestAnimationFrame` de vez e `setInterval` em uma volta por segundo. Aqui o
// calculo acompanha o proprio audio, e a mensagem chega na pagina sem esse freio.
class Nivel extends AudioWorkletProcessor {
  constructor() {
    super();
    this.soma = 0;
    this.amostras = 0;
  }

  process(inputs) {
    const canal = inputs[0] && inputs[0][0];
    if (canal) {
      for (let i = 0; i < canal.length; i++) this.soma += canal[i] * canal[i];
      this.amostras += canal.length;
    }
    // ~21 ms a 48 kHz: mesma janela curta do analisador que isto substitui.
    if (this.amostras >= 1024) {
      this.port.postMessage(Math.sqrt(this.soma / this.amostras));
      this.soma = 0;
      this.amostras = 0;
    }
    return true;
  }
}

registerProcessor("naoconcordo-nivel", Nivel);
