// Malha P2P da chamada privada: uma RTCPeerConnection por pessoa.
//
// A midia vai direto de uma ponta a outra; o servidor so repassa a
// sinalizacao (ver `chamadas.rs`). Este arquivo nao sabe nada de interface:
// quem usa entrega as faixas locais, recebe as remotas e desenha.
//
// **Quem oferece e sempre o socket mais novo** (numero de sessao maior). So um
// lado oferece por par, entao nao existe oferta cruzada e nao e preciso a
// "negociacao perfeita" com rollback. Depois da primeira oferta a conexao nao
// renegocia mais: os transceptores de audio e video nascem juntos, e ligar ou
// desligar microfone e camera e `replaceTrack`, que nao mexe na SDP.
//
// A tela nao passa por aqui: ela tem conexao propria, so para quem pediu para
// assistir (ver `telaP2P`), porque em malha cada espectador custa uma copia
// inteira da subida de quem transmite.

/// `tela` separa a conexao de tela da principal, e diz de que ponta veio:
/// "t" de quem transmite, "e" de quem assiste. Sem o lado, duas pessoas
/// transmitindo uma para a outra misturariam os candidatos das duas conexoes.
type LadoDaTela = "t" | "e";
export type Sinal =
  | { sdp: RTCSessionDescriptionInit; tela?: LadoDaTela }
  | { ice: RTCIceCandidateInit; tela?: LadoDaTela }
  | { assistir: boolean };

export type ParRemoto = {
  sessao: number;
  nome: string;
  pc: RTCPeerConnection;
  audio: MediaStream;
  video: MediaStream;
  /// Transmissao de tela recebida deste par, se estiver assistindo.
  tela: { pc: RTCPeerConnection; stream: MediaStream } | null;
  iniciador: boolean;
  /// Estado da conexao, para o quadro mostrar "reconectando".
  estado: RTCPeerConnectionState;
  pendentes: RTCIceCandidateInit[];
  pendentesTela: RTCIceCandidateInit[];
};

type Ganchos = {
  enviar: (para: number, dados: Sinal) => void;
  mudou: () => void;
  /// Estado da conexao com um par, para o indicador de qualidade.
  conexao?: (sessao: number, estado: RTCPeerConnectionState) => void;
};

/// Teto de subida da camera, dividido entre quem recebe. 1,2 Mbps e o mesmo
/// da chamada de servidor; abaixo de 250 kbps a imagem nao serve mais.
const CAMERA_TOTAL = 1_200_000;
const CAMERA_PISO = 250_000;

export class MalhaP2P {
  readonly pares = new Map<number, ParRemoto>();
  microfone: MediaStreamTrack | null = null;
  camera: MediaStreamTrack | null = null;
  /// Quem entrega a minha tela a cada espectador: o navegador ou o Rust.
  private transmissor: TransmissorDeTela | null = null;
  private readonly espectadores = new Set<number>();

  constructor(private readonly eu: number, private readonly ice: RTCIceServer[], private readonly g: Ganchos) {}

  /// Acerta as conexoes com a lista da chamada: abre para quem chegou e fecha
  /// de quem saiu.
  sincronizar(participantes: { sessao: number; username: string }[]) {
    const presentes = new Set<number>();
    for (const p of participantes) {
      if (p.sessao === this.eu) continue;
      presentes.add(p.sessao);
      if (!this.pares.has(p.sessao)) this.abrir(p.sessao, p.username);
    }
    for (const sessao of [...this.pares.keys()]) {
      if (!presentes.has(sessao)) this.fechar(sessao);
    }
    for (const sessao of [...this.espectadores]) {
      if (!presentes.has(sessao)) this.pararDeEnviarTela(sessao);
    }
    this.ajustarCamera();
    this.g.mudou();
  }

  private novaConexao() {
    return new RTCPeerConnection({ iceServers: this.ice, bundlePolicy: "max-bundle" });
  }

  private abrir(sessao: number, nome: string) {
    const pc = this.novaConexao();
    const par: ParRemoto = {
      sessao, nome, pc, audio: new MediaStream(), video: new MediaStream(), tela: null,
      iniciador: this.eu > sessao, estado: "new", pendentes: [], pendentesTela: [],
    };
    this.pares.set(sessao, par);
    pc.onicecandidate = e => { if (e.candidate) this.g.enviar(sessao, { ice: e.candidate.toJSON() }); };
    pc.ontrack = e => {
      const destino = e.track.kind === "audio" ? par.audio : par.video;
      for (const antiga of destino.getTracks()) destino.removeTrack(antiga);
      destino.addTrack(e.track);
      this.g.mudou();
    };
    let espera = 0;
    pc.onconnectionstatechange = () => {
      par.estado = pc.connectionState;
      this.g.conexao?.(sessao, pc.connectionState);
      window.clearTimeout(espera);
      // Caiu de vez: quem oferece tenta de novo com ICE novo, o que resolve a
      // troca de rede (wi-fi para cabo, IP novo) sem sair da chamada.
      if (pc.connectionState === "failed" && par.iniciador) void this.reiniciar(par);
      // "disconnected" as vezes volta sozinho em segundos (rede piscou); se
      // passar de 5 s, trata como queda.
      if (pc.connectionState === "disconnected" && par.iniciador) {
        espera = window.setTimeout(() => { if (pc.connectionState === "disconnected") void this.reiniciar(par); }, 5000);
      }
      this.g.mudou();
    };
    if (par.iniciador) {
      const audio = pc.addTransceiver("audio", { direction: "sendrecv" });
      const video = pc.addTransceiver("video", { direction: "sendrecv" });
      void audio.sender.replaceTrack(this.microfone);
      void video.sender.replaceTrack(this.camera);
      void this.ofertar(par);
    }
  }

  private async ofertar(par: ParRemoto, reiniciarIce = false) {
    const oferta = await par.pc.createOffer({ iceRestart: reiniciarIce });
    await par.pc.setLocalDescription(oferta);
    this.g.enviar(par.sessao, { sdp: par.pc.localDescription!.toJSON() });
  }

  private async reiniciar(par: ParRemoto) {
    try { await this.ofertar(par, true); } catch (erro) { console.warn("[p2p] reiniciar", erro); }
  }

  private fechar(sessao: number) {
    const par = this.pares.get(sessao);
    if (!par) return;
    par.pc.close();
    par.tela?.pc.close();
    this.pares.delete(sessao);
  }

  async receber(deSessao: number, de: string, dados: Sinal) {
    if ("assistir" in dados) {
      if (dados.assistir) await this.enviarTelaPara(deSessao);
      else this.pararDeEnviarTela(deSessao);
      return;
    }
    // Sinal da conexao de tela: de quem transmite (oferta) ou de quem assiste
    // (resposta e candidatos) — nunca se mistura com a conexao principal.
    if ("tela" in dados && dados.tela === "e") { await this.receberDeEspectador(deSessao, dados); return; }
    if ("tela" in dados && dados.tela === "t") { await this.receberTela(deSessao, dados); return; }
    let par = this.pares.get(deSessao);
    if (!par) {
      // O sinal chegou antes do estado da chamada que traria esta pessoa.
      this.abrir(deSessao, de);
      par = this.pares.get(deSessao)!;
    }
    const pc = par.pc;
    if ("sdp" in dados) {
      await pc.setRemoteDescription(dados.sdp);
      if (dados.sdp.type === "offer") {
        // Os transceptores vieram da oferta; aqui so passam a mandar tambem.
        for (const t of pc.getTransceivers()) {
          t.direction = "sendrecv";
          const kind = t.receiver.track.kind;
          await t.sender.replaceTrack(kind === "audio" ? this.microfone : this.camera);
        }
        await pc.setLocalDescription(await pc.createAnswer());
        this.g.enviar(deSessao, { sdp: pc.localDescription!.toJSON() });
        this.ajustarCamera();
      }
      for (const c of par.pendentes.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      return;
    }
    if ("ice" in dados) {
      if (!pc.remoteDescription) { par.pendentes.push(dados.ice); return; }
      await pc.addIceCandidate(dados.ice).catch(() => {});
    }
  }

  /// Troca a faixa em todas as conexoes, sem renegociar.
  async definir(tipo: "microfone" | "camera", faixa: MediaStreamTrack | null) {
    if (tipo === "microfone") this.microfone = faixa; else this.camera = faixa;
    const kind = tipo === "microfone" ? "audio" : "video";
    for (const par of this.pares.values()) {
      for (const t of par.pc.getTransceivers()) {
        if (t.receiver.track.kind === kind && t.currentDirection !== "stopped") await t.sender.replaceTrack(faixa);
      }
    }
    this.ajustarCamera();
  }

  /// A subida da camera e repartida: quanto mais gente recebendo, menos para
  /// cada um — senao a malha estoura a subida de casa e leva a voz junto.
  private ajustarCamera() {
    const quantos = Math.max(1, this.pares.size);
    const teto = Math.max(CAMERA_PISO, Math.floor(CAMERA_TOTAL / quantos));
    for (const par of this.pares.values()) {
      for (const sender of par.pc.getSenders()) {
        if (sender.track?.kind !== "video") continue;
        const p = sender.getParameters();
        if (!p.encodings?.length) continue;
        p.encodings[0].maxBitrate = teto;
        void sender.setParameters(p).catch(() => {});
      }
    }
  }

  // ------------------------------------------------------------ tela

  /// Comeca (ou para, com `null`) de oferecer a tela. Ela so vai para quem
  /// pedir (`assistir`).
  transmitir(transmissor: TransmissorDeTela | null) {
    for (const sessao of [...this.espectadores]) this.pararDeEnviarTela(sessao);
    this.transmissor?.encerrar();
    this.transmissor = transmissor;
    transmissor?.aoCandidato((sessao, ice) => this.g.enviar(sessao, { ice, tela: "t" }));
  }

  /// Pede ou larga a tela de alguem.
  assistir(sessao: number, sim: boolean) {
    if (!sim) {
      const par = this.pares.get(sessao);
      par?.tela?.pc.close();
      if (par) par.tela = null;
      this.g.mudou();
    }
    this.g.enviar(sessao, { assistir: sim });
  }

  private async enviarTelaPara(sessao: number) {
    if (!this.transmissor || this.espectadores.has(sessao)) return;
    this.espectadores.add(sessao);
    try {
      const oferta = await this.transmissor.ofertar(sessao, this.ice);
      this.g.enviar(sessao, { sdp: oferta, tela: "t" });
      this.transmissor.plateia(this.espectadores.size);
      this.g.mudou();
    } catch (erro) {
      this.espectadores.delete(sessao);
      console.warn("[p2p] tela para " + sessao, erro);
    }
  }

  private pararDeEnviarTela(sessao: number) {
    if (!this.espectadores.delete(sessao)) return;
    this.transmissor?.remover(sessao);
    this.transmissor?.plateia(this.espectadores.size);
    this.g.mudou();
  }

  /// Resposta ou candidato de quem assiste a minha tela.
  private async receberDeEspectador(deSessao: number, dados: Sinal) {
    if (!this.transmissor || !this.espectadores.has(deSessao)) return;
    if ("sdp" in dados) await this.transmissor.resposta(deSessao, dados.sdp);
    else if ("ice" in dados) await this.transmissor.candidato(deSessao, dados.ice);
  }

  /// Oferta ou candidato de quem transmite para mim.
  private async receberTela(deSessao: number, dados: Sinal) {
    const par = this.pares.get(deSessao);
    if (!par) return;
    if ("sdp" in dados && dados.sdp.type === "offer") {
      par.tela?.pc.close();
      const pc = this.novaConexao();
      const stream = new MediaStream();
      par.tela = { pc, stream };
      pc.onicecandidate = e => { if (e.candidate) this.g.enviar(deSessao, { ice: e.candidate.toJSON(), tela: "e" }); };
      pc.ontrack = e => { stream.addTrack(e.track); this.g.mudou(); };
      await pc.setRemoteDescription(dados.sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      this.g.enviar(deSessao, { sdp: pc.localDescription!.toJSON(), tela: "e" });
      for (const c of par.pendentesTela.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      this.g.mudou();
      return;
    }
    if ("ice" in dados) {
      if (!par.tela?.pc.remoteDescription) { par.pendentesTela.push(dados.ice); return; }
      await par.tela.pc.addIceCandidate(dados.ice).catch(() => {});
    }
  }

  /// Quantas pessoas estao assistindo a minha tela agora.
  get plateia() { return this.espectadores.size; }

  encerrar() {
    for (const sessao of [...this.pares.keys()]) this.fechar(sessao);
    this.transmitir(null);
  }
}

/// Quem entrega a tela local a cada espectador. Dois jeitos: o navegador, com
/// a faixa do `getDisplayMedia`, e o app, com a captura e a GPU do Rust
/// (`chamada.ts` monta este com `invoke`).
export interface TransmissorDeTela {
  ofertar(sessao: number, ice: RTCIceServer[]): Promise<RTCSessionDescriptionInit>;
  resposta(sessao: number, sdp: RTCSessionDescriptionInit): Promise<void>;
  candidato(sessao: number, ice: RTCIceCandidateInit): Promise<void>;
  remover(sessao: number): void;
  aoCandidato(f: (sessao: number, ice: RTCIceCandidateInit) => void): void;
  /// Quantos estao assistindo: a subida e repartida entre eles.
  plateia(quantos: number): void;
  encerrar(): void;
}

/// A tela pelo navegador: uma conexao so de envio por espectador.
export class TransmissorWeb implements TransmissorDeTela {
  private readonly conexoes = new Map<number, RTCPeerConnection>();
  private readonly pendentes = new Map<number, RTCIceCandidateInit[]>();
  private candidato_: (sessao: number, ice: RTCIceCandidateInit) => void = () => {};
  constructor(private readonly stream: MediaStream) {}

  aoCandidato(f: (sessao: number, ice: RTCIceCandidateInit) => void) { this.candidato_ = f; }

  async ofertar(sessao: number, ice: RTCIceServer[]) {
    this.remover(sessao);
    const pc = new RTCPeerConnection({ iceServers: ice, bundlePolicy: "max-bundle" });
    this.conexoes.set(sessao, pc);
    pc.onicecandidate = e => { if (e.candidate) this.candidato_(sessao, e.candidate.toJSON()); };
    for (const faixa of this.stream.getTracks()) pc.addTransceiver(faixa, { direction: "sendonly", streams: [this.stream] });
    await pc.setLocalDescription(await pc.createOffer());
    return pc.localDescription!.toJSON();
  }

  async resposta(sessao: number, sdp: RTCSessionDescriptionInit) {
    const pc = this.conexoes.get(sessao);
    if (!pc) return;
    await pc.setRemoteDescription(sdp);
    for (const c of this.pendentes.get(sessao)?.splice(0) || []) await pc.addIceCandidate(c).catch(() => {});
  }

  async candidato(sessao: number, ice: RTCIceCandidateInit) {
    const pc = this.conexoes.get(sessao);
    if (!pc) return;
    if (!pc.remoteDescription) {
      const fila = this.pendentes.get(sessao) || [];
      fila.push(ice);
      this.pendentes.set(sessao, fila);
      return;
    }
    await pc.addIceCandidate(ice).catch(() => {});
  }

  remover(sessao: number) {
    this.conexoes.get(sessao)?.close();
    this.conexoes.delete(sessao);
    this.pendentes.delete(sessao);
  }

  /// Mesma divisao da camera, com teto de 6 Mbps para a tela inteira.
  plateia(quantos: number) {
    const teto = Math.max(500_000, Math.floor(6_000_000 / Math.max(1, quantos)));
    for (const pc of this.conexoes.values()) {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== "video") continue;
        const p = sender.getParameters();
        if (!p.encodings?.length) continue;
        p.encodings[0].maxBitrate = teto;
        void sender.setParameters(p).catch(() => {});
      }
    }
  }

  encerrar() {
    for (const sessao of [...this.conexoes.keys()]) this.remover(sessao);
  }
}
