// Os ajustes que seguem a conta, e não o computador.
//
// Antes tudo ficava só no `localStorage`: quem formatava, reinstalava ou entrava
// de outra máquina perdia volume de cada pessoa, atalhos e notificações sem
// entender por quê. Agora esses valores sobem para o servidor junto com a conta.
//
// A régua para decidir o que entra: **sincroniza o que descreve a pessoa, fica
// local o que descreve este computador.** O identificador do microfone não
// existe na outra máquina, o codificador depende da placa de vídeo daqui, e o
// canal de atualização costuma ser escolha de "neste PC eu testo". Levar isso
// junto escolheria um microfone que não existe do outro lado.

const CAMINHO = "/api/preferencias";

/// As chaves que viajam com a conta.
///
/// Lista fechada de propósito, e não um prefixo: assim uma chave nova nasce
/// local, e passar a sincronizá-la é uma decisão que alguém toma de caso
/// pensado, em vez de acontecer por acidente de nome.
const CHAVES = [
  // Como eu gosto de ver e ouvir
  "naoconcordo.altura-palco",
  "naoconcordo.alturaMoldura",
  "naoconcordo.som",
  "naoconcordo.notificacoes",
  "naoconcordo.notificacoes.emChamada",
  "naoconcordo.notificacoes.previa",
  "naoconcordo.atalhos",
  // O volume de cada pessoa é ajuste sobre gente, não sobre o computador: o
  // amigo que fala baixo fala baixo em qualquer máquina.
  "naoconcordo.volumes",
  "naoconcordo.quality",
  "naoconcordo.ganho-tela",
  "naoconcordo.voz.modo",
  "naoconcordo.voz.filtros",
  // Fechar a categoria da campanha que nao e sua e arrumacao pessoal:
  // refazer isso em cada computador seria o mesmo incomodo dos volumes.
  "naoconcordo.categorias-fechadas",
] as const;

// Ficam de fora, e o motivo de cada um:
//
// - `devices`, `voz.ganho`, `voz.limiar`: descrevem o microfone desta mesa;
// - `codec-tela`, `forcar-dxgi`: dependem da placa de vídeo desta máquina;
// - `canal`, `dev`: "neste computador eu testo" é escolha por computador;
// - `inicio-automatico-decidido`: abrir junto com o Windows é do Windows daqui;
// - `versao-vista`, `notas-update`: marcam o que **esta instalação** já mostrou;
// - `session`, `identity.`, `servidor`: identidade e endereço, não preferência;
// - `rascunho.`, `navegacao.`, `pins.`: estado de tela, curto demais para valer.

type Mapa = Record<string, string>;

/// O que está guardado agora, só das chaves que viajam.
function instantaneo(): Mapa {
  const atual: Mapa = {};
  for (const chave of CHAVES) {
    const valor = localStorage.getItem(chave);
    if (valor !== null) atual[chave] = valor;
  }
  return atual;
}

/// Assinatura estável do conjunto, para saber se mudou sem comparar campo a
/// campo. `JSON.stringify` de um objeto respeita a ordem de inserção, e `CHAVES`
/// tem ordem fixa, então a mesma configuração dá sempre o mesmo texto.
function assinatura(mapa: Mapa): string {
  return JSON.stringify(mapa);
}

/// O último estado que o servidor confirmou ter recebido.
let ultimoEnviado = "";
let ligado = false;

type Buscar = <T>(caminho: string, init?: RequestInit) => Promise<T>;

/// Traz os ajustes da conta e os aplica antes de a tela ser desenhada.
///
/// Chamada na entrada, e não depois: tudo o que lê essas chaves lê por função e
/// sob demanda, então gravar aqui faz o resto do aplicativo já nascer com os
/// valores certos, sem ninguém precisar reagir a nada.
///
/// Conta que ainda não guardou nada recebe os valores **desta** máquina. É o que
/// faz a migração acontecer sozinha: quem já usava o aplicativo sobe o que tinha
/// na primeira entrada, em vez de começar do zero.
export async function baixarPreferencias(api: Buscar) {
  try {
    const guardadas = await api<Mapa>(CAMINHO);
    const chegou = Object.keys(guardadas).length > 0;
    if (chegou) {
      // Substitui, não mescla: desligar uma notificação é apagar a chave, e uma
      // mesclagem nunca deixaria nada ser desligado.
      for (const chave of CHAVES) {
        const valor = guardadas[chave];
        if (valor === undefined) localStorage.removeItem(chave);
        else localStorage.setItem(chave, valor);
      }
      ultimoEnviado = assinatura(instantaneo());
    } else {
      // Primeira vez: o que está nesta máquina vira o ponto de partida da conta.
      await enviar(api, instantaneo());
    }
  } catch (erro) {
    // Servidor sem a rota, ou fora do ar: seguir com o que está guardado aqui é
    // melhor do que impedir a entrada por causa de ajuste.
    console.warn("[preferencias] nao deu para trazer da conta", erro);
  }
}

async function enviar(api: Buscar, mapa: Mapa) {
  await api<void>(CAMINHO, { method: "PUT", body: JSON.stringify(mapa) });
  ultimoEnviado = assinatura(mapa);
}

/// Passa a vigiar mudanças e a subi-las.
///
/// Vigia por comparação, em vez de interceptar cada gravação. Fosse por
/// interceptação, toda chave nova precisaria lembrar de avisar daqui — e a que
/// esquecesse falharia em silêncio, do jeito mais chato de descobrir: só quando
/// alguém trocasse de computador. Comparar custa uma dúzia de leituras.
export function vigiarPreferencias(api: Buscar) {
  if (ligado) return;
  ligado = true;
  window.setInterval(() => {
    const atual = instantaneo();
    const agora = assinatura(atual);
    if (agora === ultimoEnviado) return;
    // Otimista: marca antes da resposta para duas mudanças seguidas não virarem
    // dois envios do mesmo estado. Falhando, a comparação seguinte tenta de novo.
    ultimoEnviado = agora;
    void enviar(api, atual).catch(erro => {
      console.warn("[preferencias] nao deu para guardar na conta", erro);
      ultimoEnviado = "";
    });
  }, 3000);
}
