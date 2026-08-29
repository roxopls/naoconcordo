# O que o naoconcordo faz

Lista do que já está pronto e funcionando. Serve para saber se ele resolve o
seu problema antes de você gastar uma tarde hospedando.

---

## Conta e acesso

- **Entra por convite.** Só quem tem o código de acesso cria conta. Não há
  cadastro aberto.
- **Recuperação por arquivo.** Ao criar a conta, o aplicativo gera um `.txt`
  com um código de recuperação. Perdeu a senha, arrasta o arquivo de volta. Cada
  recuperação invalida o código anterior.
- **Código separado do dono**, para quem administra o servidor.
- **Convites rastreáveis**: quem administra vê quem usou cada código, e pode
  revogar.

## Servidores e canais

- **Servidores privados** com três papéis: dono, moderador e membro.
- Dono e moderador **convidam, expulsam e mudam papel**; o dono pode **passar o
  servidor** para outra pessoa.
- **Canais de texto e de voz**, separados.
- **Personalização do servidor**: nome, descrição, ícone e capa, com as
  mudanças chegando na hora para todo mundo.

## Conversas

- **Editar e apagar** as próprias mensagens.
- **Responder** citando outra mensagem — a citação acompanha a original quando
  ela é editada, em vez de mentir.
- **Reações com emoji**, um clique nos dois sentidos.
- **"Fulano está digitando…"**
- **Menção com `@`**, com aviso para quem foi mencionado.
- **Formatação**: `**negrito**`, `*itálico*`, `` `código` `` e `||spoiler||`,
  que só aparece quando alguém clica.
- **Mensagens fixadas** no canal, com lista própria — para o combinado de
  horário, o endereço do servidor de jogo, a regra do grupo.
- **Busca com Ctrl+F**, com salto até a mensagem encontrada, mesmo em outro
  canal.
- **Anexos até 50 MB**. Imagem e vídeo aparecem na conversa; o resto vira link.
  Arquivo idêntico enviado duas vezes ocupa espaço uma vez só.
- **Arrastar para a janela** e **colar da área de transferência**, inclusive
  recorte de tela.
- **Botão direito no anexo**: copiar a imagem em si, copiar um link que abre
  para o grupo, ou abrir no visualizador.
- **Links de mídia tocam na conversa** — imagem, vídeo, áudio, YouTube e Twitch.
  O conteúdo vem direto da origem, sem passar pelo servidor.

## Mensagens privadas

- **Cifradas ponta a ponta no seu computador**: ECDH P-256 → HKDF-SHA256 →
  AES-256-GCM. O servidor guarda o envelope e **nunca vê o texto**.
- **Impressão digital** da identidade, para conferir por fora que você está
  falando com quem pensa.
- **Chave fixada no primeiro contato**: se a chave da outra pessoa mudar, o
  aplicativo avisa em vez de seguir como se nada fosse.
- **Amizades** com pedido, aceite e recusa.

## Perfil

- **Perfil global**: foto, capa e uma linha sobre você.
- **Perfil por servidor**: apelido e foto diferentes em cada servidor, como
  quem tem um nome entre os amigos do jogo e outro na família.
- **Clicar em qualquer pessoa abre o perfil dela** — na lista lateral, no
  diálogo de membros, na lista de amigos e no autor de qualquer mensagem.

## Voz

- **Chamadas por canal**, com quem está dentro aparecendo na lista.
- **Anel em quem está falando.**
- **Volume por pessoa**, e **silenciar uma pessoa só para você** — separado
  para a voz e para o áudio da tela dela.
- **Escolha de microfone, câmera e saída de áudio.**
- **Filtros**: redução de ruído, cancelamento de eco e equilíbrio de volume,
  cada um com interruptor — porque cada um atrapalha em alguma situação.
- **Medidor de nível ao vivo**, que funciona mesmo fora da chamada: dá para
  descobrir que o microfone está mudo antes de alguém reclamar.
- **Como o microfone abre**: sempre, ao falar (com sensibilidade ajustável) ou
  apertando uma tecla.
- **Atalhos globais** para falar, mutar e ensurdecer — funcionam com o jogo em
  primeiro plano, que é quando servem para alguma coisa.

## Câmera

- Câmera em 1080p quando a webcam permite.
- **Janela separada** para as câmeras, para deixar num segundo monitor.
- **Esconder a câmera de alguém** — a pessoa continua transmitindo, você
  simplesmente para de receber, e a banda para junto.

## Compartilhamento de tela

Esta é a parte com mais trabalho por baixo, e a razão de o aplicativo existir.

- **Sem o seletor do navegador e sem a barra de aviso.** A captura acontece em
  Rust, fora do WebView, então nenhuma das duas coisas aparece.
- **Sem a borda amarela** onde o Windows permite desligá-la.
- **Miniaturas ao vivo** na hora de escolher o que compartilhar.
- **Compressão pela placa de vídeo** — NVENC, AMF ou QuickSync, escolhidos
  sozinhos. Sobra processador para o jogo. Sem placa capaz, o processador
  assume e nada quebra.
- **AV1 quando a placa tem**, com H.264 como reserva. As Configurações mostram
  quais formatos o seu aplicativo consegue receber.
- **Áudio só do que você está compartilhando.** Compartilhando uma janela, vai
  o som daquele programa; compartilhando o monitor, vai tudo **menos** o
  naoconcordo — então a voz dos outros nunca volta como eco.
- **Trocar de tela sem parar a transmissão**: quem assiste nem percebe.
- **Pausar sem derrubar**, com o botão direito no botão de compartilhar.
- **Qualidade em degraus**, de 720p30 a 1080p60, com aviso de quanto cada um
  consome.
- **Ninguém recebe sua tela sem pedir**: aparece um convite com "Assistir", e
  só aí a imagem e o som começam. Em chamada cheia, isso é a diferença entre
  vários megabits entrando sem pedido ou não.
- **Modo grande** e **tela cheia**, com a interface sumindo quando o mouse
  para.
- **Janela separada** para as transmissões, também para o segundo monitor.
- **Painel de diagnóstico** (modo desenvolvedor) com quadros por segundo, tempo
  de compressão, o que está limitando — processador ou rede — e qual
  codificador está trabalhando.

## Notificações e presença

- **Quem está online**, e quem está numa chamada agora.
- Notificação com **som**, **aviso do Windows** e **prévia do texto**, cada uma
  ligada ou desligada por você.
- **Contador de não lidas** por canal, e selo separado quando mencionaram você.
- Escolher se quer ser notificado **durante uma chamada**.

## Aplicativo

- **Atualização automática**, com pacote assinado — o aplicativo recusa
  qualquer atualização que não venha da chave de quem hospeda.
- **Dois canais**: estável e de teste, com as novidades de cada versão
  aparecendo no aviso.
- **Volta onde você estava** ao reabrir, com o rascunho da mensagem que não
  chegou a enviar.
- **Diálogos próprios** em vez das janelinhas do Windows.
- **Consumo por processo** visível nas Configurações.
- **Versão para navegador**, servida do mesmo endereço, para quem só quer
  entrar rápido.

---

## O que ainda não existe

Para ninguém instalar esperando o que não tem:

- **Só Windows.** A captura de tela usa API que só existe lá. O servidor roda
  em Linux.
- **Um dispositivo por conta.** A chave das mensagens privadas mora no
  computador onde você entrou; não há como levá-la para outro.
- **Sem chamada de vídeo em grupo com muita gente.** É feito para um grupo
  pequeno de amigos, não para reunião de empresa.
- **Sem aplicativo de celular.**
- **Estado em arquivos JSON**, não em banco de dados. Funciona bem no tamanho
  para o qual foi feito, e não foi testado além disso.
