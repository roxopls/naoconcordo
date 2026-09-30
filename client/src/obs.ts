// Espelho para o OBS.
//
// Uma pagina que so assiste: entra na sala com o token que o servidor da para o
// endereco assinado (ver `espelho.rs`), assina as faixas de camera e desenha,
// sem barra, sem rotulo e com fundo transparente. O que o OBS captura e a
// imagem, e nada mais.
//
// O endereco vem no **hash**, e nao na consulta: hash nao viaja em cabecalho
// `Referer` nem entra no registro de acesso do servidor de arquivos, e a
// etiqueta que ele carrega e a credencial desta pagina.
//
//     .../app/obs.html#<canal>/<alvo>/<etiqueta>
//
// `alvo` e `-` para a grade do canal inteiro, ou o nome de quem mostrar.

import { RemoteParticipant, RemoteTrack, Room, RoomEvent, Track } from "livekit-client";
import { grade } from "./gridlayout";

type Acesso = { token: string; url: string; room: string; alvo: string; expiraEm: number };

// A pagina e servida pelo mesmo dominio do servidor (o Caddy cuida das duas
// coisas), entao nao ha nada a configurar aqui — e no OBS nao haveria onde.
const API = location.origin;

const caixa = document.getElementById("grade") as HTMLDivElement;
const aviso = document.getElementById("aviso") as HTMLDivElement;

/// Quanto esperar antes de tentar de novo quando o servidor recusa ou cai.
///
/// Meio minuto, e nao alguns segundos: o caso comum de recusa e "espelho
/// desligado", que nao se resolve em tres segundos, e uma pagina que insiste
/// depressa vira uma enxurrada de pedidos por transmissao esquecida aberta.
const ESPERA_MS = 30_000;
/// De quanto em quanto tempo reconferir se o endereco continua valendo.
///
/// Sem isto, desligar o espelho so cortaria a transmissao quando a conexao
/// caisse por conta — o que pode nao acontecer em horas. Com isto, para em
/// cinco minutos no pior caso.
const RECONFERIR_MS = 5 * 60_000;

let proporcaoReal = 16 / 9;
const ajustar = grade(caixa, () => proporcaoReal);

function dizer(texto: string) {
  aviso.textContent = texto;
}

/// Aprende a proporcao com o primeiro quadro, como as janelas do aplicativo:
/// webcam 16:9 numa grade calculada para 4:3 deixa faixa preta dos dois lados,
/// e no OBS faixa preta e pior do que em qualquer outro lugar.
function aprenderProporcao(media: HTMLVideoElement) {
  const ler = () => {
    if (!media.videoWidth || !media.videoHeight) return;
    const nova = media.videoWidth / media.videoHeight;
    if (Math.abs(nova - proporcaoReal) < 0.01) return;
    proporcaoReal = nova;
    ajustar();
  };
  media.addEventListener("loadedmetadata", ler);
  media.addEventListener("resize", ler);
  ler();
}

/// O endereco pedido, lido do hash.
function pedido(): { canal: string; alvo: string; etiqueta: string } | null {
  const partes = decodeURIComponent(location.hash.replace(/^#/, "")).split("/").filter(Boolean);
  if (partes.length !== 3) return null;
  return { canal: partes[0], alvo: partes[1], etiqueta: partes[2] };
}

/// Esta faixa entra na tela?
///
/// Na grade, toda camera entra. No link de uma pessoa, so a dela — comparando
/// por nome **e** por identidade, porque a identidade da conexao da pessoa e o
/// proprio nome de usuario, e o `name` e o apelido que ela escolheu.
function interessa(alvo: string, participante: RemoteParticipant): boolean {
  if (!alvo) return true;
  const quero = alvo.toLowerCase();
  return participante.identity.toLowerCase() === quero || (participante.name || "").toLowerCase() === quero;
}

function desenhar(track: RemoteTrack) {
  if (!track.sid || document.getElementById("cam-" + track.sid)) return;
  const quadro = document.createElement("div");
  quadro.id = "cam-" + track.sid;
  quadro.className = "quadro";
  const media = track.attach();
  if (media instanceof HTMLVideoElement) {
    media.autoplay = true;
    media.playsInline = true;
    // Mudo sempre: o audio da chamada nao sai por aqui. Quem transmite mistura
    // o som no OBS, e um audio a mais nesta pagina seria eco na live.
    media.muted = true;
    aprenderProporcao(media);
  }
  quadro.append(media);
  caixa.append(quadro);
  ajustar();
  dizer("");
}

function apagar(sid?: string) {
  if (!sid) return;
  document.getElementById("cam-" + sid)?.remove();
  ajustar();
  if (!caixa.children.length) dizer("Sem câmera no ar.");
}

/// Pede o acesso. `null` quando o endereco nao vale mais — espelho desligado,
/// etiqueta trocada, pessoa fora do servidor.
async function pedirAcesso(): Promise<Acesso | null> {
  const alvo = pedido();
  if (!alvo) return null;
  const caminho = `/api/espelho/${encodeURIComponent(alvo.canal)}/${encodeURIComponent(alvo.alvo)}/${encodeURIComponent(alvo.etiqueta)}`;
  const resposta = await fetch(API + caminho);
  if (!resposta.ok) return null;
  return await resposta.json() as Acesso;
}

async function rodar() {
  if (!pedido()) { dizer("Endereço incompleto. Copie o link outra vez no aplicativo."); return; }
  let acesso: Acesso | null = null;
  try { acesso = await pedirAcesso(); } catch { /* servidor fora do ar */ }
  if (!acesso) {
    dizer("Espelho indisponível.");
    window.setTimeout(() => void rodar(), ESPERA_MS);
    return;
  }

  // Copia constante: o `let` acima nao continua estreitado dentro dos
  // tratadores de evento, e `acesso!` em cada um deles seria pior de ler.
  const dados = acesso;
  const sala = new Room({ adaptiveStream: true, dynacast: true });
  let vigia = 0;
  let caiu = false;
  /// Uma saida so, venha ela de onde vier: a sala caiu, o endereco deixou de
  /// valer, o servidor sumiu. Sem isto, dois caminhos de saida marcariam dois
  /// `setTimeout` e a pagina reconectaria em dobro a cada volta.
  const encerrar = (motivo: string) => {
    if (caiu) return;
    caiu = true;
    window.clearInterval(vigia);
    dizer(motivo);
    void sala.disconnect().catch(() => { /* ja caiu */ });
    caixa.replaceChildren();
    window.setTimeout(() => void rodar(), ESPERA_MS);
  };

  sala
    .on(RoomEvent.TrackPublished, (publicacao, participante) => {
      const quer = publicacao.source === Track.Source.Camera && interessa(dados.alvo, participante);
      void publicacao.setSubscribed(quer);
    })
    .on(RoomEvent.TrackSubscribed, (track, _publicacao, participante) => {
      if (track.source === Track.Source.Camera && interessa(dados.alvo, participante)) desenhar(track);
    })
    .on(RoomEvent.TrackUnsubscribed, track => apagar(track.sid))
    .on(RoomEvent.Disconnected, () => encerrar("Desconectado. Tentando de novo…"));

  try {
    await sala.connect(acesso.url, acesso.token, { autoSubscribe: false });
  } catch {
    encerrar("Não foi possível entrar na sala.");
    return;
  }
  dizer("Sem câmera no ar.");
  // O que ja estava publicado antes desta pagina abrir.
  for (const participante of sala.remoteParticipants.values()) {
    for (const publicacao of participante.trackPublications.values()) {
      if (publicacao.source === Track.Source.Camera && interessa(dados.alvo, participante)) {
        void publicacao.setSubscribed(true);
      }
    }
  }

  // O endereco pode ser revogado enquanto a transmissao corre. A conexao em si
  // sobreviveria: quem confere e este vigia.
  vigia = window.setInterval(() => {
    void pedirAcesso()
      .then(ainda => { if (!ainda) encerrar("Espelho desligado."); })
      .catch(() => { /* servidor piscou; a proxima volta confere de novo */ });
  }, RECONFERIR_MS);
}

void rodar();
