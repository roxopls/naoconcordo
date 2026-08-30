// Qual servidor este aplicativo usa.
//
// O endereco vinha compilado dentro do executavel (`VITE_SERVER_URL`), entao
// hospedar o proprio servidor obrigava a recompilar o cliente inteiro — com
// Node, Rust, Tauri e NSIS instalados. Era o passo que mais afastava quem so
// queria um servidor para os amigos.
//
// Agora ele e escolhido em tempo de execucao e guardado no aparelho. O valor
// compilado continua valendo como padrao: quem instala e nao mexe em nada cai
// no servidor de sempre.

const CHAVE = "naoconcordo.servidor";

/// O que veio no build. Serve de padrao e de "voltar ao original".
export const PADRAO = (import.meta.env.VITE_SERVER_URL as string | undefined) || "http://127.0.0.1:3040";

/// Tira o que atrapalha e completa o que falta.
///
/// Quem digita um endereco raramente escreve o esquema, e quase sempre deixa
/// uma barra no fim. Sem isto, `https://casa.com/` viraria pedidos para
/// `https://casa.com//api/...`, que alguns servidores respondem com 404.
export function normalizar(bruto: string): string {
  const limpo = bruto.trim().replace(/\/+$/, "");
  if (!limpo) return "";
  // Sem esquema, assume `https`: quem hospeda hoje na internet tem TLS, e
  // errar para o lado seguro e melhor do que mandar senha em texto claro.
  const comEsquema = /^https?:\/\//i.test(limpo) ? limpo : "https://" + limpo;
  try {
    const url = new URL(comEsquema);
    return url.origin;
  } catch { return ""; }
}

/// O endereco em uso. Lido a cada chamada para a janela de telas e a de cameras
/// enxergarem a mesma escolha da janela principal.
export function endereco(): string {
  try {
    const guardado = localStorage.getItem(CHAVE);
    if (guardado) return guardado;
  } catch { /* armazenamento bloqueado; o padrao resolve */ }
  return PADRAO;
}

/// O endereco do WebSocket, derivado do mesmo lugar.
export const paraWs = (http: string) => http.replace(/^http/, "ws");

/// Guarda a escolha. Devolve `false` se o endereco nao fizer sentido.
export function guardar(bruto: string): boolean {
  const limpo = normalizar(bruto);
  if (!limpo) return false;
  try { localStorage.setItem(CHAVE, limpo); } catch { return false; }
  return true;
}

/// Volta ao endereco compilado.
export function esquecer() {
  try { localStorage.removeItem(CHAVE); } catch { /* nada a fazer */ }
}

/// Este aparelho ja aponta para um servidor escolhido a mao?
export function ehProprio() {
  try { return Boolean(localStorage.getItem(CHAVE)); } catch { return false; }
}

/// Bate na porta antes de a pessoa se comprometer com o endereco.
///
/// Sem isto, um endereco errado so aparece como "nao foi possivel entrar" no
/// meio do login, misturado com senha errada e conta inexistente.
export async function testar(bruto: string): Promise<{ ok: boolean; detalhe: string }> {
  const alvo = normalizar(bruto);
  if (!alvo) return { ok: false, detalhe: "Endereço inválido." };
  const relogio = new AbortController();
  const prazo = window.setTimeout(() => relogio.abort(), 6000);
  const comecou = performance.now();
  try {
    const resposta = await fetch(alvo + "/health", { signal: relogio.signal });
    if (!resposta.ok) return { ok: false, detalhe: "Respondeu " + resposta.status + "; não parece um servidor naoconcordo." };
    return { ok: true, detalhe: "Respondeu em " + Math.round(performance.now() - comecou) + " ms." };
  } catch (erro) {
    // Rede fora, endereco inexistente, porta fechada e certificado recusado
    // chegam aqui do mesmo jeito: o navegador nao conta qual foi.
    const abortou = erro instanceof DOMException && erro.name === "AbortError";
    return { ok: false, detalhe: abortou ? "Não respondeu em 6 segundos." : "Não foi possível alcançar este endereço." };
  } finally { window.clearTimeout(prazo); }
}
