"""Bot DJ: entra no canal de voz como participante e toca o que a fila mandar.

Por que um processo separado, e não mais uma parte do servidor:

- o `yt-dlp` quebra toda vez que o YouTube muda alguma coisa, e conserto dele é
  `pip install -U yt-dlp` mais um restart deste container. Dentro do servidor
  Rust, a mesma correção viraria versão nova do backend;
- decodificar áudio é trabalho contínuo e ruidoso. Um vídeo problemático travando
  o processo aqui deixa a sala sem música; travando dentro do backend, deixaria a
  conversa inteira parada;
- o SDK do LiveKit em Python vem com binário pronto. Em Rust ele compila a
  libwebrtc junto, o que engordaria o build do servidor por causa de um recurso
  que nem todo mundo usa.

O desenho é o mesmo de um bot de Discord: **quem manda são os outros**. O
servidor recebe o comando na conversa, confere quem pediu e em que chamada a
pessoa está, e chama uma rota daqui. Este processo não conhece usuário, sessão
nem permissão — só sala, fila e áudio.

## O caminho do som

`yt-dlp` **não baixa nada**: ele resolve o endereço do áudio já servido pelo
próprio site, e o `ffmpeg` lê esse endereço e devolve PCM cru pela saída padrão.
Esse PCM vai em pedaços de 20 ms para o LiveKit. Nada toca em disco, e é por isso
que este container não tem volume nenhum.

Tocar vídeo do YouTube assim vai contra os termos de uso dele. Isso é do
conhecimento de quem hospeda, e a responsabilidade pelo que toca é de quem manda
o comando — o mesmo acordo de qualquer bot de música.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import time
from dataclasses import dataclass, field

import aiohttp
import jwt
from aiohttp import web
from livekit import rtc
from yt_dlp import YoutubeDL

# ------------------------------------------------------------------ ajustes

LIVEKIT_URL = os.environ.get("DJ_LIVEKIT_URL", "ws://127.0.0.1:7880")
LIVEKIT_KEY = os.environ["LIVEKIT_API_KEY"]
LIVEKIT_SECRET = os.environ["LIVEKIT_API_SECRET"]
BACKEND_URL = os.environ.get("DJ_BACKEND_URL", "http://127.0.0.1:3040")
SEGREDO = os.environ["DJ_SECRET"]
PORTA = int(os.environ.get("DJ_PORT", "8791"))

# 48 kHz estéreo é o que o LiveKit quer e o que o Opus usa; converter aqui evita
# que ele reamostre depois.
TAXA = 48000
CANAIS = 2
# 20 ms por quadro: é o tamanho de pacote do Opus. Quadro maior aumenta a demora
# para o som começar, menor multiplica chamadas sem ganhar nada.
AMOSTRAS_POR_QUADRO = TAXA // 50
BYTES_POR_QUADRO = AMOSTRAS_POR_QUADRO * CANAIS * 2

# Sem ninguém pedindo nada, o bot sai da sala. Ele ocupa uma vaga de participante
# e continua assinando o áudio de todo mundo enquanto estiver lá dentro.
OCIOSO_ATE_SAIR = 60.0
# Nenhum vídeo justifica segurar a fila por horas; a fila é para a conversa
# continuar, não para tocar podcast de madrugada.
DURACAO_MAXIMA = 3 * 60 * 60

# O `yt-dlp` fala com o YouTube; o que ele traz é endereço de áudio, não arquivo.
# `default_search` faz `/tocar cidade negra` virar busca em vez de erro.
YDL_OPCOES = {
    "format": "bestaudio/best",
    "noplaylist": True,
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "default_search": "ytsearch1",
    "source_address": "0.0.0.0",
}


# -------------------------------------------------------------------- fila


@dataclass
class Faixa:
    titulo: str
    autor: str
    duracao: int
    """Endereço que o `ffmpeg` abre. Vale algumas horas e depois vence."""
    fonte: str
    """Endereço para uma pessoa abrir, quando existe."""
    link: str
    capa: str
    quem: str

    def resumo(self) -> dict:
        return {
            "titulo": self.titulo,
            "autor": self.autor,
            "duracao": self.duracao,
            "link": self.link,
            "capa": self.capa,
            "quem": self.quem,
        }


@dataclass
class Sala:
    """O que o bot sabe sobre uma chamada: a fila e o que está tocando nela."""

    id: str
    fila: list[Faixa] = field(default_factory=list)
    tocando: Faixa | None = None
    pausado: bool = False
    """Quanto do que toca agora já saiu, em segundos."""
    decorrido: float = 0.0
    sala: rtc.Room | None = None
    fonte: rtc.AudioSource | None = None
    tarefa: asyncio.Task | None = None
    ffmpeg: asyncio.subprocess.Process | None = None
    """Levantado por `/pular`: faz o laço soltar a faixa atual sem parar a fila."""
    pulando: bool = False
    ocioso_desde: float = 0.0

    def estado(self) -> dict:
        return {
            "roomId": self.id,
            "tocando": self.tocando.resumo() if self.tocando else None,
            "decorrido": round(self.decorrido),
            "pausado": self.pausado,
            "fila": [faixa.resumo() for faixa in self.fila],
        }


salas: dict[str, Sala] = {}
http: aiohttp.ClientSession | None = None


async def avisar(sala: Sala) -> None:
    """Conta ao servidor como está a fila, para ele repassar a quem está vendo.

    Empurrado, e não perguntado: painel que pergunta de tempos em tempos ou chega
    atrasado ou bate no servidor à toa enquanto ninguém mexe na música.
    """
    if http is None:
        return
    try:
        await http.post(
            f"{BACKEND_URL}/api/dj/interno/estado",
            json=sala.estado(),
            headers={"X-DJ-Secret": SEGREDO},
            timeout=aiohttp.ClientTimeout(total=5),
        )
    except Exception as erro:  # o painel atrasa; a música não para por isso
        print(f"[dj] aviso nao chegou ao servidor: {erro}", flush=True)


# ------------------------------------------------------------- o que tocar


def _resolver(pedido: str, quem: str) -> Faixa:
    """Descobre o que é o pedido e de onde sai o áudio dele. **Bloqueia.**"""
    with YoutubeDL(YDL_OPCOES) as ydl:
        dados = ydl.extract_info(pedido, download=False)
    # Busca devolve uma lista de um item só, por causa do `ytsearch1`.
    if dados.get("_type") == "playlist" or "entries" in dados:
        entradas = [e for e in dados.get("entries") or [] if e]
        if not entradas:
            raise ValueError("nada encontrado")
        dados = entradas[0]

    duracao = int(dados.get("duration") or 0)
    if duracao > DURACAO_MAXIMA:
        raise ValueError("passa de três horas")
    fonte = dados.get("url")
    if not fonte:
        raise ValueError("sem faixa de áudio")
    return Faixa(
        titulo=dados.get("title") or "sem título",
        autor=dados.get("uploader") or dados.get("channel") or "",
        duracao=duracao,
        fonte=fonte,
        link=dados.get("webpage_url") or "",
        capa=dados.get("thumbnail") or "",
        quem=quem,
    )


async def resolver(pedido: str, quem: str) -> Faixa:
    """`_resolver` fora do laço de eventos: ele fala com a rede e demora."""
    return await asyncio.get_running_loop().run_in_executor(None, _resolver, pedido, quem)


# ------------------------------------------------------------------- tocar


def ficha(sala_id: str) -> str:
    """Token de entrada na sala, assinado com a mesma chave que o servidor usa.

    Assinado aqui em vez de pedido ao servidor porque é só isto: uma assinatura
    com uma chave que este container já precisa ter para falar com o LiveKit.

    O bot **publica e não assina**: o áudio dos outros não lhe serve de nada, e
    não assinar tira da sala uma cópia a mais de cada microfone.
    """
    agora = int(time.time())
    return jwt.encode(
        {
            "iss": LIVEKIT_KEY,
            "sub": "dj#bot",
            "name": "DJ",
            "nbf": agora - 10,
            "exp": agora + 21600,
            "metadata": '{"kind":"dj"}',
            "video": {
                "roomJoin": True,
                "room": f"naoconcordo-{sala_id}",
                "canPublish": True,
                "canSubscribe": False,
                "canPublishData": False,
                "canUpdateOwnMetadata": False,
                "hidden": False,
            },
        },
        LIVEKIT_SECRET,
        algorithm="HS256",
    )


async def entrar(sala: Sala) -> None:
    """Conecta à chamada e publica a faixa por onde a música sai."""
    if sala.sala is not None:
        return
    quarto = rtc.Room()
    await quarto.connect(LIVEKIT_URL, ficha(sala.id))
    fonte = rtc.AudioSource(TAXA, CANAIS)
    faixa = rtc.LocalAudioTrack.create_audio_track("dj", fonte)
    opcoes = rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
    await quarto.local_participant.publish_track(faixa, opcoes)
    sala.sala, sala.fonte = quarto, fonte
    print(f"[dj] entrou em {sala.id}", flush=True)


async def sair(sala: Sala) -> None:
    if sala.sala is not None:
        with contextlib.suppress(Exception):
            await sala.sala.disconnect()
        print(f"[dj] saiu de {sala.id}", flush=True)
    sala.sala = None
    sala.fonte = None


async def tocar_faixa(sala: Sala, faixa: Faixa) -> None:
    """Passa uma faixa inteira para dentro da chamada, 20 ms por vez."""
    processo = await asyncio.create_subprocess_exec(
        "ffmpeg",
        # O endereço do YouTube cai sozinho no meio de faixa longa; sem estas
        # três linhas o `ffmpeg` desiste na primeira tosse da rede.
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-reconnect_delay_max", "5",
        "-i", faixa.fonte,
        "-vn",
        "-f", "s16le",
        "-ar", str(TAXA),
        "-ac", str(CANAIS),
        "-loglevel", "error",
        "pipe:1",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    sala.ffmpeg = processo
    sala.decorrido = 0.0
    assert processo.stdout is not None
    try:
        while not sala.pulando:
            if sala.pausado:
                # Sem ler do cano: o `ffmpeg` enche o buffer dele e espera, que é
                # de graça e volta na hora em que a pausa sair.
                await asyncio.sleep(0.2)
                continue
            pedaco = await processo.stdout.readexactly(BYTES_POR_QUADRO)
            quadro = rtc.AudioFrame(
                data=pedaco,
                sample_rate=TAXA,
                num_channels=CANAIS,
                samples_per_channel=AMOSTRAS_POR_QUADRO,
            )
            # `capture_frame` segura a vez quando a fila do LiveKit enche, e é
            # isso que faz a música sair no tempo certo sem relógio nosso.
            await sala.fonte.capture_frame(quadro)
            sala.decorrido += AMOSTRAS_POR_QUADRO / TAXA
    except asyncio.IncompleteReadError:
        pass  # acabou a faixa, que é o fim normal
    finally:
        sala.ffmpeg = None
        if processo.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                processo.kill()
            await processo.wait()


async def rodar(sala: Sala) -> None:
    """O laço da sala: tira da fila, toca, repete, e vai embora quando esvazia."""
    try:
        while True:
            if not sala.fila:
                sala.tocando = None
                sala.decorrido = 0.0
                await avisar(sala)
                sala.ocioso_desde = time.monotonic()
                while not sala.fila:
                    if time.monotonic() - sala.ocioso_desde > OCIOSO_ATE_SAIR:
                        return
                    await asyncio.sleep(1)

            faixa = sala.fila.pop(0)
            sala.tocando = faixa
            sala.pulando = False
            sala.pausado = False
            try:
                # `entrar` junto no mesmo `try`: se o LiveKit não atender, a fila
                # não pode morrer com a tentativa — a próxima volta a tentar.
                await entrar(sala)
                await avisar(sala)
                await tocar_faixa(sala, faixa)
            except Exception as erro:
                # Uma faixa que não toca não pode levar a fila junto: o mais
                # comum é endereço vencido, e a próxima costuma tocar.
                print(f"[dj] {faixa.titulo}: {erro}", flush=True)
    finally:
        sala.tocando = None
        sala.pausado = False
        sala.decorrido = 0.0
        sala.tarefa = None
        await sair(sala)
        await avisar(sala)


def pegar(sala_id: str) -> Sala:
    sala = salas.get(sala_id)
    if sala is None:
        sala = Sala(id=sala_id)
        salas[sala_id] = sala
    return sala


def acordar(sala: Sala) -> None:
    """Garante que existe um laço tocando esta sala."""
    if sala.tarefa is None or sala.tarefa.done():
        sala.tarefa = asyncio.create_task(rodar(sala))


# ------------------------------------------------------------------- rotas
#
# Só o servidor fala com estas rotas, pelo `localhost`, com o segredo no
# cabeçalho. Não há autenticação de pessoa aqui de propósito: quem confere se
# alguém pode mexer na música é quem conhece as pessoas.


def conferido(pedido: web.Request) -> None:
    if pedido.headers.get("X-DJ-Secret") != SEGREDO:
        raise web.HTTPUnauthorized(text="segredo errado")


async def rota_tocar(pedido: web.Request) -> web.Response:
    conferido(pedido)
    corpo = await pedido.json()
    sala = pegar(corpo["roomId"])
    if len(sala.fila) >= 50:
        return web.json_response({"erro": "a fila está cheia"}, status=409)
    try:
        faixa = await resolver(corpo["pedido"], corpo.get("quem") or "")
    except Exception as erro:
        return web.json_response({"erro": str(erro)}, status=400)
    sala.fila.append(faixa)
    acordar(sala)
    await avisar(sala)
    return web.json_response({"faixa": faixa.resumo(), "posicao": len(sala.fila)})


async def rota_pular(pedido: web.Request) -> web.Response:
    conferido(pedido)
    sala = pegar((await pedido.json())["roomId"])
    if sala.tocando is None:
        return web.json_response({"erro": "não há nada tocando"}, status=409)
    sala.pulando = True
    sala.pausado = False
    return web.json_response({"ok": True})


async def rota_pausar(pedido: web.Request) -> web.Response:
    conferido(pedido)
    sala = pegar((await pedido.json())["roomId"])
    if sala.tocando is None:
        return web.json_response({"erro": "não há nada tocando"}, status=409)
    sala.pausado = not sala.pausado
    await avisar(sala)
    return web.json_response({"pausado": sala.pausado})


async def rota_parar(pedido: web.Request) -> web.Response:
    conferido(pedido)
    sala = pegar((await pedido.json())["roomId"])
    sala.fila.clear()
    sala.pulando = True
    sala.pausado = False
    if sala.tarefa is not None:
        sala.tarefa.cancel()
    return web.json_response({"ok": True})


async def rota_estado(pedido: web.Request) -> web.Response:
    conferido(pedido)
    return web.json_response(pegar(pedido.query.get("roomId", "")).estado())


async def ao_abrir(app: web.Application) -> None:
    global http
    http = aiohttp.ClientSession()


async def ao_fechar(app: web.Application) -> None:
    for sala in list(salas.values()):
        if sala.tarefa is not None:
            sala.tarefa.cancel()
        await sair(sala)
    if http is not None:
        await http.close()


def montar() -> web.Application:
    app = web.Application()
    app.add_routes(
        [
            web.post("/tocar", rota_tocar),
            web.post("/pular", rota_pular),
            web.post("/pausar", rota_pausar),
            web.post("/parar", rota_parar),
            web.get("/estado", rota_estado),
            web.get("/saude", lambda _: web.json_response({"ok": True})),
        ]
    )
    app.on_startup.append(ao_abrir)
    app.on_cleanup.append(ao_fechar)
    return app


if __name__ == "__main__":
    # `127.0.0.1` e não `0.0.0.0`: o container é `network_mode: host`, e escutar
    # em tudo publicaria o controle da música na rede de casa.
    web.run_app(montar(), host="127.0.0.1", port=PORTA, print=None)
