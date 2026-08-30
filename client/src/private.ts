// Identidade criptografica local e cifra das mensagens privadas.
//
// A chave privada e gerada no dispositivo e nunca sai dele: para o servidor so
// vai a chave publica. Cada par de amigos deriva um segredo por ECDH P-256,
// passa por HKDF-SHA256 e cifra o conteudo com AES-256-GCM.
//
// A chave privada acompanha a **conta**, e nao o computador: ela e guardada no
// servidor dentro de um cofre cifrado por uma chave derivada da senha, que o
// servidor nunca ve. Entrando de outra maquina, a pessoa abre o mesmo historico.
//
// Limites conhecidos, que a interface comunica ao usuario:
// - o servidor ainda ve remetente, destinatario, horario e tamanho aproximado;
// - a senha passa a ser a raiz do sigilo: quem souber a senha **e** tiver o
//   banco do servidor abre o cofre e le o historico. Senha fraca enfraquece as
//   conversas, o que antes nao acontecia;
// - o codigo de recuperacao abre o mesmo cofre, e portanto vale tanto quanto a
//   senha; o arquivo baixado avisa disso;
// - ECDH estatico protege contra leitura pelo servidor, mas nao oferece o
//   forward secrecy de um protocolo com ratchet.

const IDENTITY_PREFIX = "naoconcordo.identity.";
const PIN_PREFIX = "naoconcordo.pins.";
const KDF_INFO = "naoconcordo-dm-v1";

export type Identity = { publicKey: string; privateKey: JsonWebKey };
export type PinCheck = { status: "novo" | "conhecido" | "mudou"; pinned?: string };
/// A identidade cifrada como sai daqui para o servidor.
export type Embrulho = { ciphertext: string; nonce: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromBase64Url(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/// Carrega a identidade do usuario, criando uma na primeira vez.
export async function loadIdentity(username: string): Promise<Identity> {
  const storageKey = IDENTITY_PREFIX + username.toLowerCase();
  const saved = localStorage.getItem(storageKey);
  if (saved) {
    try { return JSON.parse(saved) as Identity; } catch { localStorage.removeItem(storageKey); }
  }
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const identity: Identity = {
    publicKey: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
  };
  localStorage.setItem(storageKey, JSON.stringify(identity));
  return identity;
}

/// Apaga a identidade local. O historico antigo deixa de ser legivel.
export function forgetIdentity(username: string) {
  localStorage.removeItem(IDENTITY_PREFIX + username.toLowerCase());
}

async function importPrivate(identity: Identity) {
  return crypto.subtle.importKey("jwk", identity.privateKey, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}
async function importPublic(publicKey: string) {
  return crypto.subtle.importKey("raw", fromBase64Url(publicKey) as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
}

/// Segredo compartilhado do par, derivado por ECDH e esticado por HKDF.
async function conversationKey(identity: Identity, friendPublicKey: string) {
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: await importPublic(friendPublicKey) },
    await importPrivate(identity),
    256,
  );
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(KDF_INFO) },
    material,
    256,
  );
  return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// Remetente e destinatario entram como dado autenticado: um envelope nao pode
// ser reaproveitado noutra conversa ou devolvido ao proprio remetente.
function associatedData(from: string, to: string) {
  return encoder.encode(from.toLowerCase() + ":" + to.toLowerCase());
}

export async function sealMessage(identity: Identity, friendPublicKey: string, from: string, to: string, text: string) {
  const key = await conversationKey(identity, friendPublicKey);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: associatedData(from, to) },
    key,
    encoder.encode(text),
  );
  return { ciphertext: toBase64Url(new Uint8Array(sealed)), nonce: toBase64Url(nonce) };
}

export async function openMessage(identity: Identity, friendPublicKey: string, from: string, to: string, ciphertext: string, nonce: string) {
  const key = await conversationKey(identity, friendPublicKey);
  const opened = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(nonce) as BufferSource, additionalData: associatedData(from, to) },
    key,
    fromBase64Url(ciphertext) as BufferSource,
  );
  return decoder.decode(opened);
}

/// Impressao digital curta da chave, para conferir por outro canal.
export async function fingerprint(publicKey: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", fromBase64Url(publicKey) as BufferSource));
  const hex = [...digest.slice(0, 20)].map(byte => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  return (hex.match(/.{4}/g) || []).join(" ");
}

/// Compara a chave recebida com a que foi fixada no primeiro contato.
export function checkPin(owner: string, friend: string, publicKey: string): PinCheck {
  const pins = readPins(owner);
  const pinned = pins[friend.toLowerCase()];
  if (!pinned) return { status: "novo" };
  return pinned === publicKey ? { status: "conhecido", pinned } : { status: "mudou", pinned };
}
export function savePin(owner: string, friend: string, publicKey: string) {
  const pins = readPins(owner);
  pins[friend.toLowerCase()] = publicKey;
  localStorage.setItem(PIN_PREFIX + owner.toLowerCase(), JSON.stringify(pins));
}
export function dropPin(owner: string, friend: string) {
  const pins = readPins(owner);
  delete pins[friend.toLowerCase()];
  localStorage.setItem(PIN_PREFIX + owner.toLowerCase(), JSON.stringify(pins));
}
function readPins(owner: string): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(PIN_PREFIX + owner.toLowerCase()) || "{}") as Record<string, string>; }
  catch { return {}; }
}

// --------------------------------------------------------------- o cofre
//
// O que viaja para o servidor e a identidade cifrada. A chave que abre nasce da
// senha (ou do codigo de recuperacao) aqui no aparelho.

/// Prefixo que separa a chave do cofre do verificador de login.
///
/// **Isto e o que impede o servidor de abrir o cofre.** O verificador que ele
/// guarda sai do mesmo PBKDF2, sobre a mesma senha, com o mesmo numero de
/// voltas; sem um sal diferente as duas derivacoes dariam o mesmo material, e o
/// que o servidor ja tem em maos abriria tudo.
const COFRE_SAL = "naoconcordo-cofre-v1:";

/// A chave que abre o cofre, derivada de um segredo que so o usuario tem.
///
/// `sal` e `voltas` sao os mesmos que o servidor manda para o login — o que
/// muda e o prefixo acima.
export async function chaveDoCofre(segredo: string, sal: string, voltas: number) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(segredo), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: encoder.encode(COFRE_SAL + sal), iterations: voltas, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/// Fecha a identidade no cofre.
export async function fecharCofre(identity: Identity, chave: CryptoKey): Promise<Embrulho> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const claro = encoder.encode(JSON.stringify(identity));
  const cifrado = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, chave, claro as BufferSource);
  return { ciphertext: toBase64Url(new Uint8Array(cifrado)), nonce: toBase64Url(nonce) };
}

/// Abre o cofre. Lanca se a chave estiver errada — senha trocada noutro
/// aparelho, por exemplo — e quem chama decide o que dizer.
export async function abrirCofre(embrulho: Embrulho, chave: CryptoKey): Promise<Identity> {
  const claro = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(embrulho.nonce) as BufferSource },
    chave,
    fromBase64Url(embrulho.ciphertext) as BufferSource,
  );
  return JSON.parse(decoder.decode(claro)) as Identity;
}

/// Grava no aparelho a identidade que veio do cofre, para as proximas aberturas
/// nao dependerem de ter a senha em maos — a sessao salva entra sem digitar.
export function guardarIdentidadeLocal(username: string, identity: Identity) {
  localStorage.setItem(IDENTITY_PREFIX + username.toLowerCase(), JSON.stringify(identity));
}

/// A identidade deste aparelho, se houver. Diferente de `loadIdentity`, **nao
/// cria** uma nova: quem esta decidindo entre cofre e aparelho precisa saber que
/// aqui nao havia nada, em vez de receber uma identidade recem-inventada.
export function identidadeLocal(username: string): Identity | null {
  const saved = localStorage.getItem(IDENTITY_PREFIX + username.toLowerCase());
  if (!saved) return null;
  try { return JSON.parse(saved) as Identity; } catch { return null; }
}
