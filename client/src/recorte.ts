/// Escolher que pedaco da imagem entra, antes de enviar.
///
/// Sem isto o app recortava pelo centro na hora de desenhar, e quem mandava uma
/// foto em pe descobria depois que a cabeca tinha ficado de fora. Aqui a pessoa
/// arrasta e aproxima ate enquadrar, e o que sobe ja e o recorte.
///
/// **GIF passa direto.** Recortar num `canvas` guarda um quadro so, e o
/// resultado seria uma imagem parada no lugar da animacao — pior do que o
/// enquadramento torto que a pessoa veio corrigir.

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/// Largura da imagem final. Alto o bastante para tela grande, baixo o bastante
/// para o arquivo nao pesar.
const LARGURA_FINAL = 1024;

export type Recorte = {
  /// Largura dividida pela altura da area util. 1 para foto redonda.
  proporcao: number;
  /// Aparece no alto do dialogo, dizendo o que esta sendo enquadrado.
  titulo: string;
  /// Desenha a moldura como circulo, para bater com o que se ve depois.
  redondo?: boolean;
};

/// Devolve o arquivo recortado, ou `null` se a pessoa desistir.
export function recortarImagem(arquivo: File, pedido: Recorte): Promise<File | null> {
  // Animacao nao sobrevive ao canvas; melhor entregar o original.
  if (arquivo.type === "image/gif") return Promise.resolve(arquivo);

  return new Promise(resolve => {
    const dialogo = byId<HTMLDialogElement>("recorte-dialog");
    const palco = byId("recorte-palco");
    const moldura = byId("recorte-moldura");
    const imagem = byId<HTMLImageElement>("recorte-imagem");
    const zoom = byId<HTMLInputElement>("recorte-zoom");
    const confirmar = byId<HTMLButtonElement>("recorte-ok");
    const cancelar = byId<HTMLButtonElement>("recorte-cancelar");

    byId("recorte-titulo").textContent = pedido.titulo;
    moldura.classList.toggle("redondo", Boolean(pedido.redondo));
    // A moldura tem largura fixa e altura pela proporcao pedida: e o mesmo
    // enquadramento que a imagem tera depois, e nao uma aproximacao.
    const larguraMoldura = 320;
    moldura.style.width = larguraMoldura + "px";
    moldura.style.height = Math.round(larguraMoldura / pedido.proporcao) + "px";

    const endereco = URL.createObjectURL(arquivo);
    let escala = 1, minimo = 1, x = 0, y = 0;
    let arrastando = false, ultimoX = 0, ultimoY = 0;

    const aplicar = () => {
      const largura = imagem.naturalWidth * escala;
      const altura = imagem.naturalHeight * escala;
      const alturaMoldura = moldura.offsetHeight;
      // A imagem nunca descola da moldura: sem estes limites da para arrastar
      // ate sobrar tarja preta no recorte.
      x = Math.min(0, Math.max(larguraMoldura - largura, x));
      y = Math.min(0, Math.max(alturaMoldura - altura, y));
      imagem.style.width = largura + "px";
      imagem.style.height = altura + "px";
      imagem.style.transform = "translate(" + x + "px," + y + "px)";
    };

    const fim = (valor: File | null) => {
      dialogo.close();
      URL.revokeObjectURL(endereco);
      imagem.onload = null;
      palco.onpointerdown = null;
      confirmar.onclick = null;
      cancelar.onclick = null;
      resolve(valor);
    };

    imagem.onload = () => {
      const alturaMoldura = moldura.offsetHeight;
      // Comeca no menor tamanho que ainda cobre a moldura inteira.
      minimo = Math.max(larguraMoldura / imagem.naturalWidth, alturaMoldura / imagem.naturalHeight);
      escala = minimo;
      x = (larguraMoldura - imagem.naturalWidth * escala) / 2;
      y = (alturaMoldura - imagem.naturalHeight * escala) / 2;
      zoom.min = "1";
      zoom.max = "300";
      zoom.value = "1";
      aplicar();
    };
    imagem.src = endereco;

    zoom.oninput = () => {
      const antes = escala;
      escala = minimo * (1 + Number(zoom.value) / 100);
      // Aproximar mantendo o centro no lugar: sem isto a imagem foge para o
      // canto e a pessoa precisa reposicionar a cada ajuste.
      const centroX = larguraMoldura / 2, centroY = moldura.offsetHeight / 2;
      x = centroX - (centroX - x) * (escala / antes);
      y = centroY - (centroY - y) * (escala / antes);
      aplicar();
    };

    palco.onpointerdown = evento => {
      arrastando = true;
      ultimoX = evento.clientX;
      ultimoY = evento.clientY;
      palco.setPointerCapture(evento.pointerId);
    };
    palco.onpointermove = evento => {
      if (!arrastando) return;
      x += evento.clientX - ultimoX;
      y += evento.clientY - ultimoY;
      ultimoX = evento.clientX;
      ultimoY = evento.clientY;
      aplicar();
    };
    palco.onpointerup = evento => {
      arrastando = false;
      palco.releasePointerCapture(evento.pointerId);
    };

    cancelar.onclick = () => fim(null);
    confirmar.onclick = () => {
      const alturaFinal = Math.round(LARGURA_FINAL / pedido.proporcao);
      const tela = document.createElement("canvas");
      tela.width = LARGURA_FINAL;
      tela.height = alturaFinal;
      const pincel = tela.getContext("2d");
      if (!pincel) { fim(null); return; }

      // Do tamanho da moldura para o tamanho final, mantendo a mesma janela.
      const fator = LARGURA_FINAL / larguraMoldura;
      pincel.drawImage(
        imagem,
        x * fator,
        y * fator,
        imagem.naturalWidth * escala * fator,
        imagem.naturalHeight * escala * fator,
      );
      void tela.toBlob(saida => {
        if (!saida) { fim(null); return; }
        // Sempre PNG: o original pode ser JPEG com fundo branco onde o recorte
        // deixou sobra, e PNG guarda o vazio como vazio.
        fim(new File([saida], arquivo.name.replace(/\.[^.]+$/, "") + ".png", { type: "image/png" }));
      }, "image/png");
    };

    void alturaDaMoldura(moldura);
    dialogo.showModal();
  });
}

/// O `offsetHeight` da moldura so existe depois de ela estar no fluxo. Ler uma
/// vez antes de abrir evita o primeiro calculo sair com zero.
function alturaDaMoldura(moldura: HTMLElement) {
  return moldura.offsetHeight;
}
