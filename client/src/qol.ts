/// Conforto de uso: dialogos internos e memoria local de contexto.
///
/// Os dialogos existem porque `prompt`, `confirm` e `alert` do navegador abrem
/// uma janela do Windows por cima do app, com a cara do Edge — o mesmo tipo de
/// vazamento visual que o compartilhamento de tela proprio veio resolver. Aqui
/// tudo e HTML nosso, e o markup ja vive no `index.html`.
///
/// O que e salvo fica por usuario: mais de uma conta no mesmo computador nao
/// deve enxergar o rascunho nem a navegacao da outra.

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// --------------------------------------------------------- navegacao salva

export type Navigation = {
  view: "home" | "server";
  serverId: string;
  roomId: string;
  friend: string;
};

const NAV_KEY = "naoconcordo.navegacao.";

/// Guarda onde a pessoa estava, para reabrir o app no mesmo lugar.
export function saveNavigation(username: string, state: Navigation) {
  try {
    localStorage.setItem(NAV_KEY + username.toLowerCase(), JSON.stringify(state));
  } catch { /* armazenamento cheio ou bloqueado: navegacao e descartavel */ }
}

/// Devolve `null` quando nao ha nada salvo ou quando o que esta salvo nao tem a
/// forma esperada — uma versao antiga pode ter gravado outra coisa.
export function readNavigation(username: string): Navigation | null {
  try {
    const raw = localStorage.getItem(NAV_KEY + username.toLowerCase());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Navigation>;
    if (parsed.view !== "home" && parsed.view !== "server") return null;
    return {
      view: parsed.view,
      serverId: String(parsed.serverId || ""),
      roomId: String(parsed.roomId || ""),
      friend: String(parsed.friend || ""),
    };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- rascunhos

const DRAFT_KEY = "naoconcordo.rascunho.";
const draftKey = (username: string, conversation: string) =>
  DRAFT_KEY + username.toLowerCase() + "." + conversation;

/// Rascunho vazio e apagado em vez de guardado: senao o armazenamento acumula
/// uma chave morta para cada conversa que a pessoa abriu uma vez.
export function saveDraft(username: string, conversation: string, value: string) {
  try {
    if (value) localStorage.setItem(draftKey(username, conversation), value);
    else localStorage.removeItem(draftKey(username, conversation));
  } catch { /* rascunho e conveniencia, nao pode derrubar o envio */ }
}

export function readDraft(username: string, conversation: string): string {
  try {
    return localStorage.getItem(draftKey(username, conversation)) || "";
  } catch {
    return "";
  }
}

// -------------------------------------------------- arquivo de recuperacao

/// Le o `.txt` que o app gera na criacao da conta. O formato tem as linhas
/// `Usuario: <nome>` e `Codigo: <codigo>`, mas quem colar so o codigo cru
/// tambem e atendido — e o erro mais provavel de quem esta com pressa.
export function parseRecoveryFile(text: string): { username: string; code: string } {
  const linhas = text.split(/\r?\n/).map(linha => linha.trim());
  let username = "";
  let code = "";

  for (const linha of linhas) {
    const usuario = linha.match(/^usu[aá]rio\s*:\s*(.+)$/i);
    if (usuario) { username = usuario[1].trim(); continue; }
    const codigo = linha.match(/^c[oó]digo\s*:\s*(.+)$/i);
    if (codigo) { code = codigo[1].trim(); }
  }

  if (!code) {
    // Sem rotulo: procura uma linha com cara de codigo base64url. O cabecalho
    // "naoconcordo" e as frases de instrucao nao passam por aqui, porque tem
    // espaco ou sao curtas demais.
    const solta = linhas.find(linha => /^[A-Za-z0-9_-]{20,}$/.test(linha));
    if (solta) code = solta;
  }

  return { username, code };
}

// --------------------------------------------------------------- dialogos

/// Fecha o dialogo e resolve, sempre pelo mesmo caminho: com varios botoes e a
/// tecla Esc, e facil deixar um ouvinte pendurado e vazar na promessa seguinte.
function closer<T>(dialog: HTMLDialogElement, resolve: (value: T) => void, limpar: () => void) {
  return (value: T) => {
    limpar();
    dialog.close();
    resolve(value);
  };
}

export type InputRequest = {
  title: string;
  label: string;
  placeholder?: string;
  submit?: string;
  hint?: string;
  value?: string;
  maxLength?: number;
};

/// Pede um texto. Resolve com `null` se a pessoa desistir.
export function askInput(request: InputRequest): Promise<string | null> {
  return new Promise(resolve => {
    const dialog = byId<HTMLDialogElement>("input-dialog");
    const form = byId<HTMLFormElement>("input-dialog-form");
    const field = byId<HTMLInputElement>("input-dialog-value");
    const cancel = byId<HTMLButtonElement>("input-dialog-cancel");

    byId("input-dialog-title").textContent = request.title;
    byId("input-dialog-label").textContent = request.label;
    const hint = byId("input-dialog-hint");
    hint.textContent = request.hint || "";
    hint.classList.toggle("hidden", !request.hint);
    byId("input-dialog-error").textContent = "";
    byId<HTMLButtonElement>("input-dialog-submit").textContent = request.submit || "Continuar";
    field.placeholder = request.placeholder || "";
    field.value = request.value || "";
    field.maxLength = request.maxLength || 48;

    const limpar = () => {
      form.onsubmit = null;
      cancel.onclick = null;
      dialog.oncancel = null;
    };
    const finish = closer<string | null>(dialog, resolve, limpar);

    form.onsubmit = event => {
      event.preventDefault();
      const valor = field.value.trim();
      if (!valor) {
        byId("input-dialog-error").textContent = "Escreva alguma coisa.";
        return;
      }
      finish(valor);
    };
    cancel.onclick = () => finish(null);
    // Esc fecha: sem isto o dialogo fecharia sem resolver e a espera travaria.
    dialog.oncancel = event => { event.preventDefault(); finish(null); };

    dialog.showModal();
    field.focus();
    field.select();
  });
}

/// Pergunta antes de algo destrutivo. `warning` explica a consequencia e fica
/// escondido quando nao ha nada a avisar.
export function confirmAction(
  title: string,
  message: string,
  warning: string,
  confirmLabel: string,
): Promise<boolean> {
  return new Promise(resolve => {
    const dialog = byId<HTMLDialogElement>("confirm-dialog");
    const ok = byId<HTMLButtonElement>("confirm-dialog-submit");
    const cancel = byId<HTMLButtonElement>("confirm-dialog-cancel");

    byId("confirm-dialog-title").textContent = title;
    byId("confirm-dialog-message").textContent = message;
    const aviso = byId("confirm-dialog-warning");
    aviso.textContent = warning;
    aviso.classList.toggle("hidden", !warning);
    ok.textContent = confirmLabel;

    const limpar = () => {
      ok.onclick = null;
      cancel.onclick = null;
      dialog.oncancel = null;
    };
    const finish = closer<boolean>(dialog, resolve, limpar);

    ok.onclick = () => finish(true);
    cancel.onclick = () => finish(false);
    dialog.oncancel = event => { event.preventDefault(); finish(false); };

    dialog.showModal();
    // O foco comeca em cancelar: Enter sem ler nao deve apagar nada.
    cancel.focus();
  });
}

/// Avisa alguma coisa e espera o "Entendi".
export function showNotice(title: string, message: string): Promise<void> {
  return new Promise(resolve => {
    const dialog = byId<HTMLDialogElement>("notice-dialog");
    const close = byId<HTMLButtonElement>("notice-close");

    byId("notice-title").textContent = title;
    // Escapa HTML e converte quebras de linha para <br> para que as notas
    // de versao aparecam formatadas no dialogo.
    const safe = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
    byId("notice-message").innerHTML = safe;

    const limpar = () => {
      close.onclick = null;
      dialog.oncancel = null;
    };
    const finish = closer<void>(dialog, resolve, limpar);

    close.onclick = () => finish();
    dialog.oncancel = event => { event.preventDefault(); finish(); };

    dialog.showModal();
    close.focus();
  });
}
