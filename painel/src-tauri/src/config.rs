//! Configuracao e segredos do servidor.
//!
//! Tudo o que antes era um `.env` escrito a mao vive aqui, num JSON ao lado do
//! painel. Quem hospeda escolhe a porta e a pasta; o resto o painel resolve.

use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Onde ficam configuracao, dados e o LiveKit baixado.
///
/// `%APPDATA%\naoconcordo-servidor`. Fora da pasta de instalacao de proposito:
/// `Program Files` exige administrador para escrever, e o servidor grava o
/// tempo todo.
pub fn raiz() -> PathBuf {
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join("naoconcordo-servidor")
}

pub fn arquivo() -> PathBuf { raiz().join("config.json") }
pub fn pasta_dados() -> PathBuf { raiz().join("dados") }
pub fn pasta_anexos() -> PathBuf { raiz().join("anexos") }
pub fn pasta_livekit() -> PathBuf { raiz().join("livekit") }

/// O que a pessoa escolhe, e o que o painel gerou por ela.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// Endereco que os amigos vao digitar no aplicativo. So informativo: o
    /// servidor escuta em todas as interfaces.
    pub endereco_publico: String,
    pub porta: u16,
    /// Quem emite convites e ve quem usou cada um.
    pub admin: String,

    // ------------------------------------------------------------- segredos
    //
    // Gerados uma vez, na primeira execucao, e **nunca** trocados sozinhos.
    //
    // `auth_salt` entra na derivacao de toda senha: troca-lo invalida a senha de
    // todo mundo de uma vez, sem aviso e sem volta. Por isso ele nasce aqui e
    // fica; nao ha botao para regerar.
    pub auth_salt: String,
    pub access_password: String,
    pub owner_password: String,
    pub livekit_key: String,
    pub livekit_secret: String,
    /// Busca de GIF: de qual provedor e com qual chave. Chave vazia significa
    /// sem busca — o botao some no aplicativo e nada mais muda.
    ///
    /// O provedor e configuravel porque eles fecham: o Tenor parou de aceitar
    /// cadastros novos em janeiro de 2026. Trocar de fonte tem de ser um campo
    /// nesta tela, nao uma versao nova do servidor.
    #[serde(default)]
    pub gif_provider: String,
    #[serde(default)]
    pub gif_key: String,
}

fn segredo() -> String {
    let mut bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

impl Config {
    fn nova() -> Self {
        Config {
            endereco_publico: String::new(),
            porta: 3040,
            admin: "admin".into(),
            auth_salt: segredo(),
            access_password: segredo(),
            owner_password: segredo(),
            // A chave do LiveKit precisa de pelo menos 3 caracteres e casa com
            // o segredo; qualquer par serve, desde que os dois lados usem o
            // mesmo — e os dois lados aqui somos nos.
            livekit_key: "naoconcordo".into(),
            livekit_secret: segredo(),
            // Nao ha como gerar estas: quem hospeda pega a sua com o
            // provedor, ou deixa em branco e fica sem o botao de GIF.
            gif_provider: "giphy".into(),
            gif_key: String::new(),
        }
    }

    /// O que o processo do servidor recebe como ambiente.
    pub fn ambiente(&self) -> Vec<(String, String)> {
        vec![
            ("ACCESS_PASSWORD".into(), self.access_password.clone()),
            ("OWNER_PASSWORD".into(), self.owner_password.clone()),
            ("AUTH_SALT".into(), self.auth_salt.clone()),
            ("ADMIN_USERNAME".into(), self.admin.clone()),
            ("LIVEKIT_API_KEY".into(), self.livekit_key.clone()),
            ("LIVEKIT_API_SECRET".into(), self.livekit_secret.clone()),
            ("LIVEKIT_PUBLIC_URL".into(), self.url_livekit()),
            // Vazia de proposito quando nao configurada: o servidor trata
            // ausente e vazia do mesmo jeito.
            ("GIF_API_KEY".into(), self.gif_key.clone()),
            ("GIF_PROVIDER".into(), self.gif_provider.clone()),
            ("DATA_DIR".into(), pasta_dados().display().to_string()),
            ("UPLOAD_DIR".into(), pasta_anexos().display().to_string()),
            // Sem disco de reserva na maquina de casa: o mesmo lugar serve.
            ("UPLOAD_FALLBACK_DIR".into(), pasta_anexos().display().to_string()),
            ("PORT".into(), self.porta.to_string()),
            // O servidor serve os instaladores desta pasta, que e a mesma em
            // que a esteira de distribuicao publica. Sem apontar aqui, ele
            // procuraria dentro da pasta de dados e nao acharia nada.
            ("UPDATES_DIR".into(), raiz().join("updates").display().to_string()),
        ]
    }

    /// Endereco do LiveKit como o **navegador do amigo** vai alcanca-lo, e nao
    /// como o servidor o ve. Apontar para 127.0.0.1 aqui faria cada cliente
    /// procurar o LiveKit dentro do proprio computador.
    pub fn url_livekit(&self) -> String {
        let host = if self.endereco_publico.is_empty() { "127.0.0.1" } else { &self.endereco_publico };
        // So o host: quem digitou "meucasa.com:3040" nao quis a porta do
        // servidor no endereco do LiveKit, que escuta na 7880.
        let host = host.split(':').next().unwrap_or(host);
        format!("ws://{host}:7880")
    }
}

/// Le a configuracao, criando-a com segredos novos na primeira vez.
pub fn carregar() -> Result<Config, String> {
    let caminho = arquivo();
    if let Ok(texto) = std::fs::read_to_string(&caminho) {
        // Arquivo corrompido nao pode virar configuracao nova: segredos novos
        // trocariam o sal e derrubariam a senha de todos. Melhor falhar alto.
        return serde_json::from_str(&texto)
            .map_err(|erro| format!("config.json ilegivel ({erro}). Ele foi preservado; conserte ou remova a mao: {}", caminho.display()));
    }
    let nova = Config::nova();
    salvar(&nova)?;
    Ok(nova)
}

/// Grava a configuracao, preservando os segredos que ja existiam.
pub fn salvar(config: &Config) -> Result<(), String> {
    let raiz = raiz();
    for pasta in [&raiz, &pasta_dados(), &pasta_anexos(), &pasta_livekit()] {
        std::fs::create_dir_all(pasta).map_err(|e| format!("nao foi possivel criar {}: {e}", pasta.display()))?;
    }
    let texto = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(arquivo(), texto).map_err(|e| format!("nao foi possivel gravar a configuracao: {e}"))
}

/// O `livekit.yaml` que o LiveKit local espera. Reescrito a cada partida: ele
/// deriva inteiramente da configuracao, e nao ha nada ali para a pessoa editar.
pub fn escrever_livekit_yaml(config: &Config) -> Result<PathBuf, String> {
    let pasta = pasta_livekit();
    // Nao depende de `salvar` ter rodado antes: quem chama daqui a um ano nao
    // vai lembrar dessa ordem, e o erro seria um "caminho nao encontrado" sem
    // nenhuma pista do que faltou.
    std::fs::create_dir_all(&pasta).map_err(|e| format!("nao foi possivel criar {}: {e}", pasta.display()))?;
    let caminho = pasta.join("livekit.yaml");
    let conteudo = format!(
        "port: 7880\n\
         rtc:\n  \
           tcp_port: 7881\n  \
           port_range_start: 50000\n  \
           port_range_end: 50200\n  \
           use_external_ip: false\n\
         keys:\n  \
           {}: {}\n\
         logging:\n  \
           level: info\n",
        config.livekit_key, config.livekit_secret
    );
    std::fs::write(&caminho, conteudo).map_err(|e| format!("nao foi possivel gravar livekit.yaml: {e}"))?;
    Ok(caminho)
}

#[cfg(test)]
mod testes {
    use super::*;

    fn exemplo() -> Config {
        let mut config = Config::nova();
        config.livekit_key = "chave".into();
        config.livekit_secret = "segredo".into();
        config
    }

    /// A continuacao de linha (`\` no fim) engole a quebra **e** o espaco da
    /// linha seguinte. Escrever o YAML indentado no codigo e facil de acertar
    /// por acidente e de quebrar sem ninguem ver: YAML mal indentado so falha
    /// quando o LiveKit tenta subir, longe daqui.
    #[test]
    fn yaml_sai_indentado_como_o_livekit_espera() {
        let config = exemplo();
        let caminho = escrever_livekit_yaml(&config).expect("gravar");
        let texto = std::fs::read_to_string(&caminho).expect("ler");

        assert!(texto.starts_with("port: 7880\n"), "achado:\n{texto}");
        assert!(texto.contains("\nrtc:\n"), "rtc na coluna zero:\n{texto}");
        assert!(texto.contains("\n  tcp_port: 7881\n"), "filho de rtc indentado:\n{texto}");
        assert!(texto.contains("\n  port_range_end: 50200\n"), "faixa de midia:\n{texto}");
        assert!(texto.contains("\nkeys:\n  chave: segredo\n"), "chave do livekit:\n{texto}");
        // Nenhuma linha pode vir com indentacao acidental de quatro espacos ou
        // mais: seria filho de outro nivel, e o LiveKit recusaria o arquivo.
        for linha in texto.lines().filter(|l| !l.trim().is_empty()) {
            let recuo = linha.len() - linha.trim_start().len();
            assert!(recuo == 0 || recuo == 2, "recuo inesperado ({recuo}) em {linha:?}");
        }
    }

    /// O endereco do LiveKit vai para o **navegador do amigo**. Deixar a porta
    /// do servidor ali faria cada cliente procurar o LiveKit na porta errada.
    #[test]
    fn url_do_livekit_ignora_a_porta_do_servidor() {
        let mut config = exemplo();
        config.endereco_publico = "26.31.4.7".into();
        assert_eq!(config.url_livekit(), "ws://26.31.4.7:7880");

        config.endereco_publico = "casa.com.br:3040".into();
        assert_eq!(config.url_livekit(), "ws://casa.com.br:7880");

        // Sem endereco escolhido, so a propria maquina se alcanca.
        config.endereco_publico = String::new();
        assert_eq!(config.url_livekit(), "ws://127.0.0.1:7880");
    }

    /// Os segredos nascem uma vez. Dois nascimentos com o mesmo sal
    /// significariam gerador quebrado, e o sal e o que protege as senhas.
    #[test]
    fn segredos_nascem_diferentes() {
        let (a, b) = (Config::nova(), Config::nova());
        assert_ne!(a.auth_salt, b.auth_salt);
        assert_ne!(a.livekit_secret, b.livekit_secret);
        assert!(a.auth_salt.len() >= 30, "sal curto demais: {}", a.auth_salt.len());
    }

    /// A porta entra no ambiente do servidor; sem isso, escolher a porta no
    /// painel nao mudaria nada e o servidor subiria sempre na 3040.
    #[test]
    fn a_porta_escolhida_chega_ao_servidor() {
        let mut config = exemplo();
        config.porta = 4050;
        let ambiente = config.ambiente();
        let porta = ambiente.iter().find(|(chave, _)| chave == "PORT").map(|(_, valor)| valor.clone());
        assert_eq!(porta.as_deref(), Some("4050"));
    }
}

#[cfg(test)]
mod testes_updates {
    use super::*;

    /// O servidor serve os instaladores de `UPDATES_DIR`; a esteira de
    /// distribuicao publica em `raiz/updates`. Sendo pastas diferentes, o amigo
    /// receberia 404 ao atualizar — e o erro so apareceria na maquina dele.
    #[test]
    fn o_servidor_serve_a_pasta_em_que_a_esteira_publica() {
        let ambiente = Config::nova().ambiente();
        let servida = ambiente.iter()
            .find(|(chave, _)| chave == "UPDATES_DIR")
            .map(|(_, valor)| PathBuf::from(valor))
            .expect("UPDATES_DIR precisa ir para o servidor");
        // Comparado com a pasta que a esteira realmente usa, e nao com uma
        // copia da mesma expressao: assim mexer num lado sem o outro quebra
        // aqui, que e o unico jeito de este teste servir para alguma coisa.
        assert_eq!(servida, crate::distribuir::pasta_updates());
    }
}
