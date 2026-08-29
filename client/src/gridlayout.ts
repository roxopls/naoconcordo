/// Grade de video que se adapta ao formato do espaco.
///
/// Uma grade de CSS puro (`auto-fit` com largura minima) so sabe encher linhas
/// da esquerda para a direita: numa janela alta e estreita ela deixa uma coluna
/// de tiles minusculas com o resto vazio, e numa janela larga e baixa ela
/// empilha quando deveria enfileirar. Como o numero de participantes e pequeno,
/// da para simplesmente testar todas as divisoes possiveis e ficar com a que
/// deixa a imagem maior.
///
/// O criterio e a area util de cada tile **respeitando a proporcao do video**:
/// nao adianta a celula ser larga se o video de 16:9 so vai usar uma faixa dela.

/// Melhor numero de colunas para `quantidade` tiles em `largura`x`altura`.
///
/// `vao` e o espaco entre duas tiles. Ele entra na conta porque cresce com o
/// numero de faixas: ignorar isso faz a grade escolher uma divisao que so cabe
/// no papel, e as tiles estouram o espaco disponivel.
///
/// Devolve 1 quando nao ha o que medir, para o chamador nunca dividir por zero.
export function melhoresColunas(
  largura: number,
  altura: number,
  quantidade: number,
  proporcao: number,
  vao = 0,
): number {
  if (quantidade <= 1 || largura <= 0 || altura <= 0) return 1;

  let melhor = 1;
  let maiorLado = 0;
  for (let colunas = 1; colunas <= quantidade; colunas += 1) {
    const linhas = Math.ceil(quantidade / colunas);
    const larguraUtil = largura - vao * (colunas - 1);
    const alturaUtil = altura - vao * (linhas - 1);
    if (larguraUtil <= 0 || alturaUtil <= 0) continue;
    // O video ocupa o maior retangulo com a proporcao certa que cabe na celula.
    const ladoUtil = Math.min(larguraUtil / colunas / proporcao, alturaUtil / linhas);
    if (ladoUtil > maiorLado) {
      maiorLado = ladoUtil;
      melhor = colunas;
    }
  }
  return melhor;
}

/// Aplica a grade e mantem ela em dia enquanto o elemento existir.
///
/// `proporcao` aceita uma funcao porque a proporcao real so aparece quando o
/// primeiro quadro chega: o chute inicial erra para quem tem webcam 16:9, e
/// errar a proporcao aqui vira faixa preta sobrando na tile.
///
/// Devolve a funcao que refaz a conta, para quem adiciona ou remove uma tile
/// poder chamar sem esperar o `ResizeObserver`.
export function grade(
  container: HTMLElement,
  proporcao: number | (() => number) = 16 / 9,
): () => void {
  const aplicar = () => {
    const quantidade = container.children.length;
    if (!quantidade) return;
    const estilo = getComputedStyle(container);
    // `clientWidth` inclui o preenchimento; o espaco das tiles e o que sobra.
    const largura = container.clientWidth
      - (parseFloat(estilo.paddingLeft) || 0)
      - (parseFloat(estilo.paddingRight) || 0);
    const altura = container.clientHeight
      - (parseFloat(estilo.paddingTop) || 0)
      - (parseFloat(estilo.paddingBottom) || 0);
    const razao = typeof proporcao === "function" ? proporcao() : proporcao;
    const colunas = melhoresColunas(
      largura,
      altura,
      quantidade,
      razao > 0 ? razao : 16 / 9,
      parseFloat(estilo.rowGap) || 0,
    );
    container.style.gridTemplateColumns = `repeat(${colunas}, 1fr)`;
    container.style.gridTemplateRows = `repeat(${Math.ceil(quantidade / colunas)}, 1fr)`;
  };
  // O observador cobre o redimensionamento da janela e o arrasto da alca do
  // painel destacado, que nao emitem `resize` no elemento.
  new ResizeObserver(aplicar).observe(container);
  aplicar();
  return aplicar;
}
