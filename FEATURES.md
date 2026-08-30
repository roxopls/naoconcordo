# O que o naoconcordo faz

Lista do que já está pronto e funcionando. Serve pra você saber se ele resolve o
seu problema antes de gastar uma tarde hospedando.

---

## Conta e acesso

- Entra por convite, só quem tem o código cria conta, não existe cadastro
  aberto.
- Quando você cria a conta o aplicativo gera um `.txt` com um código de
  recuperação. Perdeu a senha, arrasta o arquivo de volta. Cada recuperação
  invalida o código anterior.
- Código separado do dono, pra quem administra o servidor.
- Quem administra vê quem usou cada convite e pode revogar.

## Servidores e canais

- Servidores privados com três papéis: dono, moderador e membro.
- Dono e moderador convidam, expulsam e mudam papel, e o dono pode passar o
  servidor pra outra pessoa.
- Canais de texto e de voz, separados.
- Nome, descrição, ícone e capa do servidor, e a mudança chega na hora pra todo
  mundo.

## Conversas

- Editar e apagar as próprias mensagens.
- Responder citando outra mensagem, e a citação acompanha a original quando ela
  é editada em vez de mentir.
- Reações com emoji, um clique nos dois sentidos.
- "Fulano está digitando…"
- Menção com `@`, com aviso pra quem foi mencionado.
- Formatação: `**negrito**`, `*itálico*`, `` `código` `` e `||spoiler||`, que só
  aparece quando alguém clica.
- Mensagens fixadas no canal, com lista própria, pro combinado de horário, o
  endereço do servidor de jogo, a regra do grupo.
- Busca com Ctrl+F, que salta até a mensagem encontrada mesmo se ela estiver em
  outro canal.
- Anexos até 50 MB. Imagem e vídeo aparecem na conversa, o resto vira link, e o
  mesmo arquivo enviado duas vezes ocupa espaço uma vez só.
- Arrastar pra janela e colar da área de transferência, inclusive recorte de
  tela.
- Botão direito no anexo: copiar a imagem em si, copiar um link que abre pro
  grupo, ou abrir no visualizador.
- No visualizador o clique aproxima no ponto em que você clicou, a roda do mouse
  aproxima e arrastar move, então dá pra ler aquilo que ficou pequeno demais na
  captura.
- Links de mídia tocam na conversa: imagem, vídeo, áudio, YouTube e Twitch. O
  conteúdo vem direto da origem, sem passar pelo servidor.

## Mensagens privadas

- Cifradas ponta a ponta no seu computador, com ECDH P-256, HKDF-SHA256 e
  AES-256-GCM. O servidor guarda o envelope e NUNCA vê o texto.
- As conversas seguem a conta e não o computador, então se você entrar de outra
  máquina o histórico abre junto. A chave fica guardada no servidor dentro de um
  cofre que só a sua senha abre, e o código de recuperação abre o mesmo cofre,
  então perdeu a senha você recupera a conta e as conversas juntas.
- Impressão digital da identidade, pra você conferir por fora que está falando
  com quem pensa.
- A chave da outra pessoa fica fixada no primeiro contato, e se ela mudar o
  aplicativo avisa em vez de seguir como se nada fosse.
- Amizades com pedido, aceite e recusa.

## Perfil

- Perfil global: foto, capa e uma linha sobre você.
- Perfil por servidor: apelido e foto diferentes em cada um, como quem tem um
  nome entre os amigos do jogo e outro na família.
- Clicar em qualquer pessoa abre o perfil dela, seja na lista lateral, no
  diálogo de membros, na lista de amigos ou no autor de uma mensagem.

## Voz

- Chamadas por canal, com quem está dentro aparecendo na lista.
- Anel em quem está falando, na cor que a pessoa escolheu.
- Volume por pessoa até 200%, e dá pra silenciar alguém só pra você, separado
  pra voz e pro áudio da tela dela. Aquele amigo que fala baixo demais você
  resolve no seu computador, ninguém mais na sala é afetado e ele não precisa
  mexer em nada.
- Escolha de microfone, câmera e saída de áudio.
- Redução de ruído, cancelamento de eco e equilíbrio de volume, cada um com
  interruptor próprio, porque cada um atrapalha em alguma situação.
- Medidor de nível ao vivo, que funciona mesmo fora da chamada, então dá pra
  descobrir que o microfone está mudo antes de alguém reclamar.
- O microfone abre sempre, ao falar (com sensibilidade ajustável) ou apertando
  uma tecla.
- Atalhos globais pra falar, mutar e ensurdecer, que funcionam com o jogo em
  primeiro plano, que é justamente quando eles servem pra alguma coisa.

## Câmera

- Câmera em 1080p quando a webcam permite.
- Janela separada pras câmeras, pra deixar num segundo monitor.
- Esconder a câmera de alguém. A pessoa continua transmitindo, você
  simplesmente para de receber, e a banda para junto.

## Compartilhamento de tela

Essa é a parte com mais trabalho por baixo, e a razão de o aplicativo existir.

- Sem o seletor do navegador e sem a barra de aviso, porque a captura acontece
  em Rust, fora do WebView, então nenhuma das duas coisas aparece.
- Sem a borda amarela, onde o Windows deixa desligar.
- Miniaturas ao vivo na hora de escolher o que compartilhar.
- Compressão pela placa de vídeo, com NVENC, AMF ou QuickSync escolhidos
  sozinhos, então sobra processador pro jogo. Se a placa não der conta, o
  processador assume e nada quebra.
- AV1 quando a placa tem, com H.264 como reserva. As Configurações mostram
  quais formatos o seu aplicativo consegue receber.
- Áudio só do que você está compartilhando. Se for uma janela, vai o som
  daquele programa. Se for o monitor inteiro, vai tudo MENOS o naoconcordo,
  então a voz dos outros nunca volta como eco.
- Trocar de tela sem parar a transmissão, e quem está assistindo nem percebe.
- Pausar sem derrubar, com o botão direito no botão de compartilhar.
- Qualidade em degraus, de 720p30 a 1080p60, com aviso de quanto cada um
  consome.
- Ninguém recebe a sua tela sem pedir, aparece um convite com "Assistir" e só aí
  a imagem e o som começam. Numa chamada cheia é isso que decide se vários
  megabits entram sem você ter pedido.
- Modo grande e tela cheia, com a interface sumindo quando o mouse para.
- Janela separada pras transmissões, também pro segundo monitor.
- Painel de diagnóstico, no modo desenvolvedor, com quadros por segundo, tempo
  de compressão, o que está limitando (processador ou rede) e qual codificador
  está trabalhando.

## Notificações e presença

- Quem está online, e quem está numa chamada agora.
- Notificação com som, aviso do Windows e prévia do texto, cada uma ligada ou
  desligada por você.
- Contador de não lidas por canal, e selo separado quando mencionaram você.
- Escolher se quer ser notificado durante uma chamada.

## Aplicativo

- Aponte pra qualquer servidor pela tela de entrada, sem recompilar nada, e ele
  testa o endereço antes de gravar.
- Atualização automática com pacote assinado, e o aplicativo recusa qualquer
  atualização que não venha da chave de quem hospeda.
- Dois canais, estável e de teste, com as novidades de cada versão aparecendo no
  aviso.
- Volta onde você estava ao reabrir, com o rascunho da mensagem que você não
  chegou a enviar.
- Diálogos próprios em vez das janelinhas do Windows.
- Consumo por processo visível nas Configurações.
- Versão para navegador, servida do mesmo endereço, pra quem só quer entrar
  rápido.

## Hospedar no Windows

Um aplicativo separado, pra quem quer um servidor e não quer Linux nem terminal.

- Gera as chaves sozinho e escreve toda a configuração.
- Baixa o LiveKit e sobe os dois processos, com o registro à vista.
- Mostra os endereços da sua máquina com o nome de cada placa, e o da VPN vem
  primeiro, que é o que costuma funcionar sem você mexer no roteador.
- Libera as portas no firewall num botão.
- Mostra o endereço pronto pra copiar e passar pros seus amigos.
- Gera os aplicativos deles assinados pela sua chave, então as atualizações
  passam a sair de você.

---

## O que ainda não existe

Pra ninguém instalar esperando o que não tem:

- Só Windows. A captura de tela usa API que só existe lá. O servidor roda em
  Linux ou em Windows, pelo painel.
- Sem chamada de vídeo em grupo com muita gente, ele é feito pra um grupo
  pequeno de amigos e não pra reunião de empresa.
- Sem aplicativo de celular.
- Estado em arquivos JSON e não em banco de dados. Funciona bem no tamanho pro
  qual foi feito, e não foi testado além disso.
