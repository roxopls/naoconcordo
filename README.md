# naoconcordo

Aplicativo de voz, vídeo, tela e texto para um grupo de amigos.
Feito para ser auto-hospedado: um servidor seu, sem precisar depender de nenhuma empresa.

O aplicativo é feito pra **Windows inicialmente**. O servidor roda em Linux, e é assim que ele foi testado e implantado, você pode desenvolver o executável do servidor pra Windows (o que eu não recomendo porque é beeem mais pesado).

---

## Como é montado

São três coisas, e vale a pena você entender como a divisão funciona antes de configurar qualquer coisa,
porque cada um se conecta de um jeito diferente:

* **Cliente** — Tauri 2, interface em TypeScript, parte nativa em Rust. É a
parte nativa que captura a tela sem o seletor do Edge, pega o áudio por processo, comprime pela placa de vídeo e registra os atalhos globais. Nada disso existe fora do Windows, e é por isso que o
aplicativo é só de Windows (por enquanto).
* **Servidor** — Axum, em Rust, com o estado em arquivos JSON no disco. Cuida
de contas, servidores privados, canais, anexos, presença e mensagens. Não tem
banco de dados para instalar.
* **LiveKit** — o servidor de mídia, auto-hospedado. **A voz e o vídeo não
passam pelo servidor de aplicação**: ele só assina a entrada, e o
LiveKit cuida do resto.

Mensagens privadas são cifradas ponta a ponta no cliente (ECDH P-256 →
HKDF-SHA256 → AES-256-GCM). O servidor **NUNCA** vê o texto.

---

## Antes de escolher como hospedar

A pergunta que decide tudo: **os seus amigos vão te alcançar pela internet ou
por uma rede virtual?**

Voz e vídeo em tempo real precisam de UDP chegando na sua máquina. Isso não é um
detalhe: é a diferença se isso aqui é uma solução pra você ou não. Existem três cenários, do mais simples pro mais chato.

### Cenário 1 — Rede virtual (RadminVPN, Hamachi, ZeroTier, Tailscale)

**Comece por aqui se você nunca hospedou nada.** Todo mundo entra na mesma rede
virtual e passa a se enxergar como se estivesse na mesma casa. Sem precisar mexer em nada na sua rede. (muito mais fácil que os outros)

O que precisa fazer:

1. Todo mundo instala o mesmo programa de VPN e entra na mesma rede.
2. Veja qual IP a rede virtual te deu.
3. Usa esse IP nas configurações abaixo, no lugar de um domínio.

No `infra/.env`:

~~~
LIVEKIT_PUBLIC_URL=ws://SEU-IP-DA-VPN:7880
~~~

No `infra/livekit.yaml`, desligue o TURN — ele serve para atravessar
roteador, e aqui não há roteador no caminho:

~~~yaml
turn:
  enabled: false
~~~

Quando compilar o cliente, aponte para o mesmo IP:

~~~
VITE_SERVER_URL=http://SEU-IP-DA-VPN:3040
~~~

Pronto. Sem HTTPS, sem domínio, sem porta encaminhada.

Obviamente todo mundo precisa estar conectado na mesma VPN que você, se alguém estiver fora, não vai funcionar



### Cenário 2 — Servidor alugado (VPS)

O caminho mais fácil se o grupo for crescer. O provedor te dá um IP
público que não muda e portas que ninguém bloqueia.

1. Aponte um domínio para o IP do servidor (um registro `A`).
2. Libere no firewall do provedor:

|Porta|Protocolo|Para quê|
|-|-|-|
|443|TCP|interface e API, atrás do proxy reverso|
|7880|TCP|sinalização do LiveKit|
|7881|TCP|mídia quando o UDP está bloqueado na rede de quem entra|
|50000–50100|**UDP**|a mídia de verdade|
|3478|**UDP**|TURN, para quem está atrás de rede restritiva|

3. Configure o proxy reverso com certificado (o `Caddyfile` de exemplo já traz
o formato) e use `https://` e `wss://` na configuração.

### Cenário 3 — Servidor na sua casa

Funciona, e é o que eu faço aqui com os meus amigos. Só tem quatro problemas, e é bom saber
deles antes:

* **Encaminhe as portas da tabela acima no seu roteador**, apontando para a
máquina do servidor. As UDP são as que fazem a chamada existir.
* **Se você tiver dois roteadores** (o da operadora e o seu), o encaminhamento
precisa ser feito **nos dois**. Fazer só no seu não adianta: o pacote chega
primeiro no da operadora, e se ele não encaminhar, nunca chega no seu.
* **Sua operadora pode bloquear as portas 80 e 443 de entrada.** É comum em
link residencial(o meu caso também). Nesse caso, sirva em outra porta alta (8443, por exemplo),
a única consequência é que o endereço passa a ter `:8443` no fim. Se além
disso o seu IP for CGNAT, aí não há porta a encaminhar, e o primeiro cenário
resolve o seu problema.
* **IP residencial muda.** Use um DNS dinâmico, senão o endereço muda
sozinho depois de algumas horas ou dias. Pessoalmente uso o no-ip.

---

## Configurar

### Servidor

Copie `infra/.env.example` para `infra/.env` e preencha:

|Variável|O que é|
|-|-|
|`ACCESS_PASSWORD`|o convite: quem tem, cria conta|
|`OWNER_PASSWORD`|código separado, só do dono|
|`AUTH_SALT`|texto aleatório e longo; **trocar depois invalida as senhas de todo mundo**|
|`LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`|par que o servidor usa para assinar os crachás; os mesmos valores vão em `livekit.yaml`|
|`LIVEKIT_PUBLIC_URL`|endereço do LiveKit **como quem está de fora enxerga**|
|`ADMIN_USERNAME`|quem emite e revoga convites (padrão: `admin`)|

Gere as chaves de verdade, **NUNCA** invente:

~~~bash
openssl rand -base64 32
~~~

Copie também `infra/livekit.yaml.example` para `infra/livekit.yaml` e repita ali
o mesmo par de chave e segredo, em `keys:`.

Subir:

~~~bash
cd infra && docker compose up -d
~~~

Isso se for de Docker — você sempre pode adaptar do jeito que preferir.

Sem Docker, o servidor é um binário só:

~~~bash
cd server && cargo run     # escuta em 127.0.0.1:3040
~~~

### Cliente

O endereço do servidor entra no momento da compilação, por variável de
ambiente. Crie `client/.env.local`:

~~~
VITE_SERVER_URL=https://seu-endereco:8443
~~~

Sem essa variável, o cliente procura o servidor em `http://127.0.0.1:3040`, que
serve para desenvolver na mesma máquina.

Compilar (precisa de Rust, Node 20+ e as ferramentas de build da Microsoft):

~~~bash
cd client
npm install
npm run tauri dev      # desenvolvimento
npm run tauri build    # instalador
~~~

### Atualização automática (opcional)

O aplicativo sabe se atualizar sozinho, mas só aceita pacote assinado pela sua
chave. O `tauri.conf.json` publicado aqui vem **sem** endereço e **sem** chave
pública de propósito — cada instalação usa as suas.

~~~bash
npm run tauri signer generate -- -w minha.key
~~~

A chave pública vai em `plugins.updater.pubkey` e o endereço do manifesto em
`plugins.updater.endpoints`. **A chave privada nunca entra no repositório**: com
ela, qualquer um assina uma atualização falsa que todo cliente instalado aceita
como legítima.

---

## Testes

~~~bash
node test-isolated.mjs
~~~

Sobe um backend descartável, com dados próprios, e roda as suítes contra ele.
Não toca no servidor de produção.

---

## O que não está neste repositório

A configuração de implantação que depende da topologia de quem hospeda —
scripts de rede, ajuste fino do servidor de mídia — e a chave privada de
assinatura. Os arquivos `.example` trazem o formato de tudo que é preciso.



Naoconcordo está em **DESENVOLVIMENTO**, pode e vai ter erros, mas pelo menos é uma solução pro problema que estamos tendo com uma outra plataforma por aí. Eu sempre vou fazer ele de graça, mas se você quiser desenvolver algo e ganhar uma grana com isso, pode ir em frente. Se eu esqueci de explicar algo, só chamar no twitter @roxopls, que se eu tiver um tempinho eu te ajudo a resolver seu BO.

