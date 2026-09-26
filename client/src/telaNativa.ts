// Tela da chamada privada pelo Rust: captura e GPU do app, conexao direta com
// cada espectador (ver `src-tauri/src/screen/p2p.rs`). So existe no app; no
// navegador a tela sai do `getDisplayMedia` (`TransmissorWeb`).

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { TransmissorDeTela } from "./p2p";
import type { CodecPreferido, Escolha, ShareQuality } from "./screenshare";

type CandidatoRust = { sessao: number; candidate: string; sdpMid: string; sdpMLineIndex: number };

export class TransmissorNativo implements TransmissorDeTela {
  private desligar: Promise<UnlistenFn> | null = null;

  /// Comeca a captura. Devolve o transmissor e a descricao de quem comprime.
  static async iniciar(escolha: Escolha<ShareQuality & { id: string }>, codec: CodecPreferido, forcarDuplicacao: boolean) {
    const descricao = await invoke<string>("tela_p2p_iniciar", {
      sourceId: escolha.sourceId,
      quality: {
        width: escolha.quality.width, height: escolha.quality.height, fps: escolha.quality.fps,
        bitrate: escolha.quality.bitrate, preferMotion: escolha.motion,
      },
      audio: escolha.audio,
      codec,
      audioSource: escolha.audioSource,
      audioGain: escolha.audioGain,
      forceDuplication: forcarDuplicacao,
      hideTitleBar: escolha.semBarra,
    });
    return { transmissor: new TransmissorNativo(), descricao };
  }

  aoCandidato(f: (sessao: number, ice: RTCIceCandidateInit) => void) {
    void this.desligar?.then(d => d());
    this.desligar = listen<CandidatoRust>("tela-p2p-ice", e => {
      const c = e.payload;
      f(c.sessao, { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex });
    });
  }

  async ofertar(sessao: number, ice: RTCIceServer[]): Promise<RTCSessionDescriptionInit> {
    const lista = ice.map(s => ({
      urls: Array.isArray(s.urls) ? s.urls : [s.urls],
      username: s.username ?? null,
      credential: typeof s.credential === "string" ? s.credential : null,
    }));
    const sdp = await invoke<string>("tela_p2p_ofertar", { sessao, ice: lista });
    return { type: "offer", sdp };
  }

  async resposta(sessao: number, sdp: RTCSessionDescriptionInit) {
    await invoke("tela_p2p_resposta", { sessao, sdp: sdp.sdp || "" });
  }

  async candidato(sessao: number, ice: RTCIceCandidateInit) {
    if (!ice.candidate) return;
    await invoke("tela_p2p_candidato", {
      sessao, candidate: ice.candidate, sdpMid: ice.sdpMid ?? null, sdpMLineIndex: ice.sdpMLineIndex ?? null,
    }).catch(erro => console.warn("[tela p2p] candidato", erro));
  }

  remover(sessao: number) { void invoke("tela_p2p_remover", { sessao }).catch(() => {}); }

  /// A GPU comprime uma vez para todos; quem reparte e o controle de banda de
  /// cada conexao, que pede taxa ao codificador.
  plateia() {}

  trocar(sourceId: string) { return invoke<void>("tela_p2p_trocar", { sourceId }); }
  pausar(pausada: boolean) { return invoke<boolean>("tela_p2p_pausar", { paused: pausada }); }
  viva() { return invoke<boolean>("tela_p2p_viva"); }

  encerrar() {
    void this.desligar?.then(d => d());
    this.desligar = null;
    void invoke("tela_p2p_parar").catch(() => {});
  }
}
