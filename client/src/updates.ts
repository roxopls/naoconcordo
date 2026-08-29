// Atualizacao automatica.
//
// O aplicativo consulta o endpoint do proprio servidor, baixa o pacote e so
// instala se a assinatura bater com a chave publica embutida no binario. A
// chave privada correspondente nunca entra no repositorio nem no servidor:
// quem a tiver consegue publicar uma atualizacao que le tudo antes da cifra.
//
// Sao dois canais. O stable so recebe entrega fechada; o unstable recebe as
// versoes intermediarias (`0.7.5.N`, tecnicamente `0.7.6-N`). O endpoint e o
// mesmo: quem escolhe e o cabecalho `X-Canal`, que o Caddy usa para servir
// `unstable.json` em vez de `latest.json`. Assim ninguem precisa de build
// diferente para trocar de canal.

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const CANAL_KEY = "naoconcordo.canal";
export type Canal = "stable" | "unstable";

export const canalAtual = (): Canal => (localStorage.getItem(CANAL_KEY) === "unstable" ? "unstable" : "stable");
export function definirCanal(canal: Canal) { localStorage.setItem(CANAL_KEY, canal); }

const NOTAS_KEY = "naoconcordo.notas-update";

/// Salva as notas antes do relaunch; quem abre depois le com `notasSalvas`.
export function notasSalvas(): string { return localStorage.getItem(NOTAS_KEY) || ""; }
export function limparNotas() { localStorage.removeItem(NOTAS_KEY); }

/// Procura sem instalar. Devolve `null` quando ja esta atualizado ou quando
/// roda fora do Tauri (navegador de desenvolvimento).
///
/// Separado da instalacao de proposito: instalar reinicia o aplicativo, e
/// reiniciar no meio de uma chamada e a pior hora possivel. Quem decide o
/// momento e quem clicou.
export async function procurarAtualizacao(): Promise<Update | null> {
  if (!("__TAURI_INTERNALS__" in window)) return null;
  const canal = canalAtual();
  return await check(canal === "unstable" ? { headers: { "X-Canal": "unstable" } } : undefined);
}

/// Baixa, instala e reinicia. So deve ser chamada depois de a pessoa aceitar.
export async function instalarAtualizacao(update: Update, notify: (text: string, notes: string) => void) {
  const notas = update.body || "";
  notify("Baixando a versao " + update.version + "…", notas);
  // Persiste antes de baixar: o relaunch mata o processo e as notas
  // precisam sobreviver para o pill de "Atualizado para X" mostrar o que mudou.
  localStorage.setItem(NOTAS_KEY, notas);
  await update.downloadAndInstall();
  notify("Atualizacao pronta. Reiniciando…", notas);
  await relaunch();
}

/// Verificacao automatica da abertura: acha, baixa e reinicia sozinha. Aqui
/// nao ha chamada em andamento — o aplicativo acabou de subir — entao
/// perguntar so atrasaria a atualizacao de quem nem percebeu.
export async function checkForUpdate(notify: (text: string, notes: string) => void) {
  if (!("__TAURI_INTERNALS__" in window)) return;
  try {
    const update = await procurarAtualizacao();
    if (!update) return;
    await instalarAtualizacao(update, notify);
  } catch (error) {
    // Falha de rede ou assinatura invalida nao pode derrubar o aplicativo.
    // Falha de rede na abertura fica so no console: avisar a cada abertura
    // seria barulho. No botao, quem clicou tem de saber que falhou.
    console.warn("[updater]", error);
  }
}
