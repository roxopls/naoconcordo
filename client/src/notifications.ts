/// Notificacoes nativas do Windows.
///
/// Tres chaves independentes, porque as pessoas querem coisas diferentes:
/// ligar ou desligar de vez, mostrar ou esconder o texto da mensagem, e
/// receber ou nao enquanto ja se esta numa chamada.
///
/// O texto da mensagem e o ponto delicado: a notificacao aparece na tela
/// mesmo com o computador destravado e a sala cheia. Por isso a previa vem
/// **desligada** por padrao, e sem ela a notificacao so diz que chegou algo.

import { ehTauri } from "./ambiente";

/// As mesmas tres operacoes, pelo caminho que existir.
///
/// No aplicativo vem do plugin do Tauri, que fala com a central do Windows. No
/// navegador vem da API `Notification`, que faz o mesmo por outro caminho. O
/// resto do modulo — as tres chaves, a previa desligada por padrao — nao muda.
async function permissaoConcedida(): Promise<boolean> {
  if (ehTauri()) {
    const { isPermissionGranted } = await import("@tauri-apps/plugin-notification");
    return isPermissionGranted();
  }
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

async function pedirPermissao(): Promise<boolean> {
  if (ehTauri()) {
    const { requestPermission } = await import("@tauri-apps/plugin-notification");
    return (await requestPermission()) === "granted";
  }
  if (typeof Notification === "undefined") return false;
  return (await Notification.requestPermission()) === "granted";
}

async function enviar(title: string, body: string): Promise<void> {
  if (ehTauri()) {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    sendNotification({ title, body });
    return;
  }
  new Notification(title, { body });
}

const DESKTOP_KEY = "naoconcordo.notificacoes";
const PREVIEW_KEY = "naoconcordo.notificacoes.previa";
const IN_CALL_KEY = "naoconcordo.notificacoes.emChamada";

/// `padrao` decide o que vale antes de a pessoa escolher qualquer coisa.
function readFlag(key: string, padrao: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? padrao : raw === "1";
  } catch {
    return padrao;
  }
}

function writeFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch { /* preferencia e descartavel, nao vale derrubar o app */ }
}

export const desktopNotificationsOn = () => readFlag(DESKTOP_KEY, false);
export const notificationPreviewOn = () => readFlag(PREVIEW_KEY, false);
export const notificationsInCallOn = () => readFlag(IN_CALL_KEY, false);

export const setNotificationPreview = (value: boolean) => writeFlag(PREVIEW_KEY, value);
export const setNotificationsInCall = (value: boolean) => writeFlag(IN_CALL_KEY, value);

/// Liga ou desliga as notificacoes. Ligar exige permissao do sistema, entao o
/// resultado e o que **de fato** ficou valendo, e nao o que foi pedido: quem
/// chama usa isso para devolver o interruptor ao lugar quando o Windows nega.
export async function setDesktopNotifications(wanted: boolean): Promise<boolean> {
  if (!wanted) {
    writeFlag(DESKTOP_KEY, false);
    return false;
  }

  let granted = false;
  try {
    granted = await permissaoConcedida();
    if (!granted) granted = await pedirPermissao();
  } catch {
    granted = false;
  }

  writeFlag(DESKTOP_KEY, granted);
  return granted;
}

export type MessageNotice = {
  title: string;
  /// Texto real, mostrado so com a previa ligada.
  body: string;
  /// Substituto sem conteudo, para quando a previa esta desligada.
  privateBody: string;
  inCall: boolean;
};

/// Notifica uma mensagem nova, respeitando as tres chaves.
export async function notifyMessage(notice: MessageNotice): Promise<boolean> {
  if (!desktopNotificationsOn()) return false;
  // Em chamada a pessoa ja esta no app; avisar de novo so atrapalha, a menos
  // que ela tenha pedido.
  if (notice.inCall && !notificationsInCallOn()) return false;

  try {
    // A permissao pode ter sido revogada nas configuracoes do Windows depois
    // que foi concedida; conferir aqui evita notificacao que nunca aparece.
    if (!(await permissaoConcedida())) return false;
    await enviar(notice.title, notificationPreviewOn() ? notice.body : notice.privateBody);
    return true;
  } catch {
    return false;
  }
}

/// Manda uma notificacao de teste, para a pessoa conferir se chega. Ignora as
/// chaves de previa e de chamada de proposito: o teste e sobre o caminho ate a
/// tela, nao sobre o filtro.
export async function sendTestNotification(): Promise<boolean> {
  try {
    if (!(await permissaoConcedida()) && !(await pedirPermissao())) return false;
    await enviar("naoconcordo", "As notificacoes estao funcionando.");
    return true;
  } catch {
    return false;
  }
}
