//! Sobe e derruba o servidor e o LiveKit, e guarda o que eles escrevem.
//!
//! Os dois sao processos filhos do painel. Fechar o painel derruba os dois: um
//! servidor que continua no ar sem nada na tela e um servidor que ninguem
//! lembra de desligar.

use crate::config::{self, Config};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

/// Sem isto cada processo filho abre uma janela preta de console por cima do
/// painel. `CREATE_NO_WINDOW`, do Windows.
#[cfg(windows)]
const SEM_JANELA: u32 = 0x0800_0000;

#[derive(Default)]
pub struct Supervisor {
    servidor: Option<Child>,
    livekit: Option<Child>,
    /// Ultimas linhas dos dois, para a aba de log. Limitado: um servidor que
    /// roda a semana inteira encheria a memoria com o proprio historico.
    pub linhas: Arc<Mutex<Vec<String>>>,
}

const MAX_LINHAS: usize = 500;

fn anotar(linhas: &Arc<Mutex<Vec<String>>>, quem: &str, texto: &str) {
    if let Ok(mut lista) = linhas.lock() {
        lista.push(format!("[{quem}] {texto}"));
        let excesso = lista.len().saturating_sub(MAX_LINHAS);
        if excesso > 0 { lista.drain(0..excesso); }
    }
}

/// Liga a saida do processo ao registro do painel, numa linha de cada vez.
fn acompanhar(filho: &mut Child, quem: &'static str, linhas: Arc<Mutex<Vec<String>>>) {
    for fonte in [filho.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
                  filho.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>)] {
        let Some(fonte) = fonte else { continue };
        let destino = linhas.clone();
        std::thread::spawn(move || {
            for linha in BufReader::new(fonte).lines().map_while(Result::ok) {
                anotar(&destino, quem, &linha);
            }
        });
    }
}

impl Supervisor {
    pub fn rodando(&mut self) -> (bool, bool) {
        (vivo(&mut self.servidor), vivo(&mut self.livekit))
    }

    pub fn registro(&self) -> Vec<String> {
        self.linhas.lock().map(|l| l.clone()).unwrap_or_default()
    }

    /// Sobe os dois. Se ja estiverem no ar, nao faz nada: apertar "iniciar"
    /// duas vezes nao pode virar dois servidores brigando pela mesma porta.
    pub fn iniciar(&mut self, config: &Config) -> Result<(), String> {
        config::salvar(config)?;
        let (srv, lk) = self.rodando();

        if !srv {
            let caminho = caminho_do_servidor()?;
            let mut comando = Command::new(&caminho);
            comando.envs(config.ambiente())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            #[cfg(windows)] { use std::os::windows::process::CommandExt; comando.creation_flags(SEM_JANELA); }
            let mut filho = comando.spawn()
                .map_err(|e| format!("nao foi possivel iniciar o servidor ({}): {e}", caminho.display()))?;
            acompanhar(&mut filho, "servidor", self.linhas.clone());
            anotar(&self.linhas, "painel", &format!("servidor iniciado na porta {}", config.porta));
            self.servidor = Some(filho);
        }

        if !lk {
            let caminho = config::pasta_livekit().join("livekit-server.exe");
            if caminho.exists() {
                let yaml = config::escrever_livekit_yaml(config)?;
                let mut comando = Command::new(&caminho);
                comando.arg("--config").arg(&yaml)
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());
                #[cfg(windows)] { use std::os::windows::process::CommandExt; comando.creation_flags(SEM_JANELA); }
                match comando.spawn() {
                    Ok(mut filho) => {
                        acompanhar(&mut filho, "livekit", self.linhas.clone());
                        anotar(&self.linhas, "painel", "livekit iniciado na porta 7880");
                        self.livekit = Some(filho);
                    }
                    // O chat funciona sem o LiveKit; so a chamada nao. Derrubar
                    // tudo por causa disso seria pior do que seguir capenga e
                    // dizer o que falta.
                    Err(erro) => anotar(&self.linhas, "painel", &format!("livekit nao subiu: {erro}")),
                }
            } else {
                anotar(&self.linhas, "painel", "livekit ainda nao foi baixado; voz e tela ficam indisponiveis");
            }
        }
        Ok(())
    }

    pub fn parar(&mut self) {
        for (quem, alvo) in [("servidor", &mut self.servidor), ("livekit", &mut self.livekit)] {
            if let Some(filho) = alvo.as_mut() {
                let _ = filho.kill();
                let _ = filho.wait();
                anotar(&self.linhas, "painel", &format!("{quem} parado"));
            }
            *alvo = None;
        }
    }
}

/// `try_wait` devolve `Ok(None)` enquanto o processo vive. Um filho que morreu
/// e nao foi colhido continuaria aparecendo como vivo para o sistema, entao a
/// colheita acontece aqui mesmo.
fn vivo(alvo: &mut Option<Child>) -> bool {
    let Some(filho) = alvo.as_mut() else { return false };
    match filho.try_wait() {
        Ok(None) => true,
        _ => { *alvo = None; false }
    }
}

/// O executavel do servidor viaja dentro do instalador do painel, ao lado dele.
/// Em desenvolvimento ele costuma estar na pasta de build do outro projeto, e
/// procurar nos dois lugares evita ter que copiar a mao a cada teste.
fn caminho_do_servidor() -> Result<std::path::PathBuf, String> {
    // O baixado vem primeiro: o que veio no instalador envelhece junto com o
    // painel, e quem atualizou o servidor espera rodar o que baixou.
    let baixado = crate::distribuir::pasta_servidor().join("naoconcordo-server.exe");
    if baixado.exists() { return Ok(baixado); }

    // Instalado, o servidor fica em `binarios/` ao lado do painel, que e onde o
    // empacotador poe os recursos. Ao lado direto tambem serve, para quem
    // colocar o executavel na mao.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(pasta) = exe.parent() {
            for relativo in ["binarios/naoconcordo-server.exe", "naoconcordo-server.exe"] {
                let caminho = pasta.join(relativo);
                if caminho.exists() { return Ok(caminho); }
            }
        }
    }

    let desenvolvimento = std::path::PathBuf::from(r"C:\lk\ncsrv\release\naoconcordo-server.exe");
    if desenvolvimento.exists() { return Ok(desenvolvimento); }

    Err("naoconcordo-server.exe nao foi encontrado ao lado do painel.".into())
}
