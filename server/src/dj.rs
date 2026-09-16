//! A ponte entre a conversa e o bot DJ.
//!
//! O bot (`../dj/bot.py`) só conhece sala, fila e áudio. Quem conhece pessoa,
//! sessão e permissão é este servidor, então a divisão é esta: a conversa chega
//! aqui, este arquivo confere quem pediu e em que chamada a pessoa está, e só
//! então fala com o bot pelo `localhost`.
//!
//! O bot devolve o estado da fila **empurrando** para cá (`/api/dj/interno/estado`),
//! e daqui ele sai pelo mesmo WebSocket que já leva mensagem e presença. Painel
//! que pergunta de tempos em tempos ou chega atrasado, ou bate no servidor à toa
//! enquanto ninguém mexe na música.
//!
//! **Sem `DJ_SECRET` no ambiente, o DJ não existe**: os comandos ficam sendo
//! mensagem comum e o painel não aparece. É o mesmo acordo da busca de GIF —
//! quem hospeda sem o recurso continua com tudo o mais de pé.

use std::time::Duration;

use serde_json::{Value, json};

/// Como quem hospeda ligou o bot. `None` quando não ligou.
#[derive(Clone)]
pub struct Ligacao {
    pub url: String,
    pub segredo: String,
    /// Como o bot enxerga **este** servidor. Serve para uma coisa só: transformar
    /// anexo da conversa em endereço que o `ffmpeg` sabe abrir.
    pub nosso_endereco: String,
}

impl Ligacao {
    /// Lê o ambiente. O endereço tem padrão porque o bot mora no mesmo host; o
    /// segredo não tem, porque sem ele não há recurso.
    pub fn do_ambiente() -> Option<Self> {
        let segredo = std::env::var("DJ_SECRET").ok().filter(|s| !s.trim().is_empty())?;
        Some(Self {
            url: std::env::var("DJ_URL").unwrap_or_else(|_| "http://127.0.0.1:8791".into()),
            segredo,
            nosso_endereco: std::env::var("DJ_BACKEND_SELF")
                .unwrap_or_else(|_| "http://127.0.0.1:3040".into()),
        })
    }
}

/// O que alguém pediu ao DJ.
#[derive(Debug, PartialEq)]
pub enum Comando {
    /// Link, busca por texto, ou vazio quando o pedido é o anexo da mensagem.
    Tocar(String),
    Pular,
    Pausar,
    Parar,
    /// Não muda nada: serve para o painel reaparecer para quem fechou.
    Fila,
}

/// Reconhece o comando no texto da mensagem, ou `None` se não for um.
///
/// Os dois nomes de cada comando existem porque a conversa é em português e o
/// dedo está acostumado com o inglês dos outros aplicativos. Aceitar os dois
/// custa uma linha e evita a pergunta "é `/skip` ou `/pular`?".
pub fn ler_comando(texto: &str) -> Option<Comando> {
    let texto = texto.trim();
    let sem_barra = texto.strip_prefix('/')?;
    let (verbo, resto) = match sem_barra.split_once(char::is_whitespace) {
        Some((verbo, resto)) => (verbo, resto.trim()),
        None => (sem_barra, ""),
    };
    match verbo.to_lowercase().as_str() {
        "tocar" | "play" | "p" => Some(Comando::Tocar(resto.chars().take(400).collect())),
        "pular" | "skip" | "next" => Some(Comando::Pular),
        "pausar" | "pause" => Some(Comando::Pausar),
        "parar" | "stop" => Some(Comando::Parar),
        "fila" | "queue" | "q" => Some(Comando::Fila),
        _ => None,
    }
}

/// Manda o comando ao bot e devolve o que ele respondeu.
///
/// A resposta do bot vem em duas formas: `{"erro": "..."}` com status de erro,
/// que vira o aviso que a pessoa lê, e o resto, que só o painel usa. O texto do
/// erro sai do bot porque é lá que se sabe o que deu errado — "nada encontrado"
/// e "passa de três horas" não são coisas que este arquivo poderia adivinhar.
pub async fn falar(ligacao: &Ligacao, rota: &str, corpo: Value) -> Result<Value, String> {
    let cliente = reqwest::Client::builder()
        // Resolver um link do YouTube leva alguns segundos; o resto é instantâneo.
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|erro| erro.to_string())?;
    let resposta = cliente
        .post(format!("{}/{rota}", ligacao.url.trim_end_matches('/')))
        .header("X-DJ-Secret", &ligacao.segredo)
        .json(&corpo)
        .send()
        .await
        .map_err(|_| "O DJ não respondeu.".to_string())?;

    let status = resposta.status();
    let dados: Value = resposta.json().await.unwrap_or_else(|_| json!({}));
    if status.is_success() {
        return Ok(dados);
    }
    Err(dados
        .get("erro")
        .and_then(Value::as_str)
        .unwrap_or("O DJ não conseguiu atender.")
        .to_string())
}

#[cfg(test)]
mod testes {
    use super::*;

    /// O comando é lido do texto da mensagem, então errar para mais engoliria
    /// mensagem que ninguém quis que virasse comando.
    #[test]
    fn le_o_comando_e_o_resto_da_linha() {
        assert_eq!(ler_comando("/tocar cidade negra"), Some(Comando::Tocar("cidade negra".into())));
        assert_eq!(ler_comando("  /play  https://youtu.be/abc  "), Some(Comando::Tocar("https://youtu.be/abc".into())));
        // Sem resto: é o caso de mandar o anexo junto com o comando.
        assert_eq!(ler_comando("/tocar"), Some(Comando::Tocar(String::new())));
        assert_eq!(ler_comando("/PULAR"), Some(Comando::Pular));
        assert_eq!(ler_comando("/q"), Some(Comando::Fila));

        // Texto comum continua sendo texto comum.
        assert_eq!(ler_comando("tocar alguma coisa"), None);
        assert_eq!(ler_comando("/qualquer outra coisa"), None);
        assert_eq!(ler_comando("olha /play nesse link"), None);
        assert_eq!(ler_comando(""), None);
    }
}
