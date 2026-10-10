// Caminho da midia ate o servidor de voz: quem escolhe e a pessoa.
//
// O servidor oferece dois enderecos para a mesma chamada, um em UDP e um em
// TCP, e a negociacao (ICE) fica com o que conectar. UDP perde um pacote e
// segue; TCP para tudo ate o pacote perdido chegar de novo — numa chamada isso
// vira imagem travada, atraso que se acumula e som fora de sincronia. Em
// compensacao ha rede que so deixa passar TCP.
//
// A negociacao nem sempre fica com o melhor dos dois, e nao ha como pedir um
// deles pela API do navegador nem pela do LiveKit. O que da para fazer e nao
// mostrar ao navegador o endereco do outro tipo: sem candidato, nao ha par, e a
// conexao so pode nascer pelo caminho escolhido.
//
// Vale para tudo que fala com o servidor de voz nesta maquina — a chamada e as
// janelas de cameras e de telas —, porque a chave mora no `localStorage`. A
// captura de tela nativa tem conexao propria, fora do navegador, e nao passa
// por aqui.

const CHAVE = "naoconcordo.caminho";

export type Caminho = "auto" | "udp" | "tcp";

export function caminhoEscolhido(): Caminho {
  const valor = localStorage.getItem(CHAVE);
  return valor === "udp" || valor === "tcp" ? valor : "auto";
}

export function guardarCaminho(caminho: Caminho) {
  if (caminho === "auto") localStorage.removeItem(CHAVE);
  else localStorage.setItem(CHAVE, caminho);
}

/// Conexoes que nao sao com o servidor de voz. A chamada privada liga uma
/// pessoa direto na outra, e ali tirar candidato e tirar a chance de conectar.
const livres = new WeakSet<RTCPeerConnection>();
export function semFiltroDeCaminho(pc: RTCPeerConnection): RTCPeerConnection {
  livres.add(pc);
  return pc;
}

/// O transporte de uma linha de candidato: `candidate:1 1 udp 2130706431 …`.
function transporte(candidato: string): string | null {
  const partes = candidato.replace(/^a=/, "").trim().split(/\s+/);
  return partes[0]?.startsWith("candidate:") && partes[2] ? partes[2].toLowerCase() : null;
}

function serve(candidato: string): boolean {
  const escolha = caminhoEscolhido();
  if (escolha === "auto") return true;
  const tipo = transporte(candidato);
  return tipo === null || tipo === escolha;
}

let instalado = false;

/// Chamar uma vez, antes de qualquer conexao. Em "auto" nada e tocado.
export function instalarFiltroDeCaminho() {
  if (instalado || typeof RTCPeerConnection === "undefined") return;
  instalado = true;
  const proto = RTCPeerConnection.prototype;

  // Os candidatos do servidor chegam de dois jeitos: dentro da descricao e um
  // a um, depois. Os dois passam pelo mesmo crivo.
  const descrever = proto.setRemoteDescription;
  proto.setRemoteDescription = function (this: RTCPeerConnection, descricao: RTCSessionDescriptionInit, ...resto: unknown[]) {
    if (!livres.has(this) && descricao?.sdp && caminhoEscolhido() !== "auto") {
      const sdp = descricao.sdp.split(/\r?\n/)
        .filter(linha => !linha.startsWith("a=candidate:") || serve(linha))
        .join("\r\n");
      descricao = { type: descricao.type, sdp };
    }
    return (descrever as (...args: unknown[]) => Promise<void>).call(this, descricao, ...resto);
  } as typeof proto.setRemoteDescription;

  const acrescentar = proto.addIceCandidate;
  proto.addIceCandidate = function (this: RTCPeerConnection, candidato?: RTCIceCandidateInit | null, ...resto: unknown[]) {
    const texto = candidato?.candidate;
    if (!livres.has(this) && texto && !serve(texto)) return Promise.resolve();
    return (acrescentar as (...args: unknown[]) => Promise<void>).call(this, candidato, ...resto);
  } as typeof proto.addIceCandidate;

  // Os nossos candidatos tambem: o servidor testa todo endereco que recebe, e
  // por um roteador permissivo o teste dele chega e abre o caminho que a pessoa
  // pediu para nao usar.
  const aviso = Object.getOwnPropertyDescriptor(proto, "onicecandidate");
  if (aviso?.get && aviso.set) {
    const guardar = aviso.set;
    Object.defineProperty(proto, "onicecandidate", {
      ...aviso,
      set(this: RTCPeerConnection, tratador: ((evento: RTCPeerConnectionIceEvent) => unknown) | null) {
        if (!tratador || livres.has(this)) { guardar.call(this, tratador); return; }
        guardar.call(this, (evento: RTCPeerConnectionIceEvent) => {
          if (evento.candidate && !serve(evento.candidate.candidate)) return;
          return tratador.call(this, evento);
        });
      },
    });
  }
}

/// Por onde a midia esta passando agora, lido das estatisticas de uma faixa.
/// `null` quando ainda nao ha par escolhido.
export async function caminhoEmUso(relatorio: RTCStatsReport | undefined): Promise<string | null> {
  if (!relatorio) return null;
  const itens = new Map<string, Record<string, unknown>>();
  relatorio.forEach((item: Record<string, unknown>) => itens.set(String(item.id), item));
  let par: Record<string, unknown> | undefined;
  for (const item of itens.values()) {
    if (item.type === "transport" && item.selectedCandidatePairId) par = itens.get(String(item.selectedCandidatePairId));
  }
  if (!par) {
    for (const item of itens.values()) if (item.type === "candidate-pair" && item.nominated && item.state === "succeeded") par = item;
  }
  const local = par && itens.get(String(par.localCandidateId));
  if (!local) return null;
  if (local.candidateType === "relay") return "retransmissão (" + String(local.relayProtocol || "udp").toUpperCase() + ")";
  return String(local.protocol || "?").toUpperCase();
}
