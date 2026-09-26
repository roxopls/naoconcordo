//! Enquete na conversa: `/enquete Sábado ou domingo? | Sábado | Domingo`.
//!
//! Voto unico por pessoa, e trocavel: clicar em outra opcao move o voto, clicar
//! na mesma desfaz. E o que se quer para "que dia a gente joga" — ninguem vota
//! em dois dias, e todo mundo muda de ideia quando ve o resultado parcial.
//!
//! Quem votou em que fica a vista, como nas reacoes. Num grupo de amigos
//! enquete secreta nao protege ninguem, e saber quem ainda nao votou e metade
//! da utilidade.

use serde::{Deserialize, Serialize};

const MIN_OPCOES: usize = 2;
const MAX_OPCOES: usize = 10;
const MAX_PERGUNTA: usize = 200;
const MAX_OPCAO: usize = 80;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Enquete {
    pub pergunta: String,
    pub opcoes: Vec<Opcao>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Opcao {
    pub texto: String,
    /// Nome de quem votou, como `ChatMessage::reactions`.
    #[serde(default)]
    pub votos: Vec<String>,
}

/// Mesmo acordo de `dados::ler`: `None` nao e enquete, `Some(Err)` e uma
/// enquete mal escrita, e o motivo volta para quem escreveu.
pub fn ler(texto: &str) -> Option<Result<Enquete, String>> {
    let sem_barra = texto.trim().strip_prefix('/')?;
    let (verbo, resto) = match sem_barra.split_once(char::is_whitespace) {
        Some((verbo, resto)) => (verbo, resto.trim()),
        None => (sem_barra, ""),
    };
    if !matches!(verbo.to_lowercase().as_str(), "enquete" | "poll") { return None; }
    let mut partes = resto.split('|').map(str::trim);
    let pergunta: String = partes.next().unwrap_or("").chars().take(MAX_PERGUNTA).collect();
    let opcoes: Vec<Opcao> = partes
        .filter(|texto| !texto.is_empty())
        .map(|texto| Opcao { texto: texto.chars().take(MAX_OPCAO).collect(), votos: Vec::new() })
        .collect();
    if pergunta.is_empty() || !(MIN_OPCOES..=MAX_OPCOES).contains(&opcoes.len()) {
        return Some(Err(format!(
            "Escreva assim: /enquete Pergunta? | opção 1 | opção 2 (de {MIN_OPCOES} a {MAX_OPCOES} opções)."
        )));
    }
    Some(Ok(Enquete { pergunta, opcoes }))
}

impl Enquete {
    /// Aplica o clique de `quem` na opcao `indice`. `false` se o indice nao existe.
    pub fn votar(&mut self, quem: &str, indice: usize) -> bool {
        if indice >= self.opcoes.len() { return false; }
        let eu = quem.to_lowercase();
        let ja_era_esta = self.opcoes[indice].votos.iter().any(|n| n.to_lowercase() == eu);
        for opcao in &mut self.opcoes { opcao.votos.retain(|n| n.to_lowercase() != eu); }
        if !ja_era_esta { self.opcoes[indice].votos.push(quem.to_string()); }
        true
    }
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn le_pergunta_e_opcoes() {
        let e = ler("/enquete Que dia? | Sábado |  | Domingo ").unwrap().unwrap();
        assert_eq!(e.pergunta, "Que dia?");
        assert_eq!(e.opcoes.iter().map(|o| o.texto.as_str()).collect::<Vec<_>>(), ["Sábado", "Domingo"]);
    }

    #[test]
    fn recusa_enquete_sem_opcao() {
        assert!(ler("/enquete Que dia?").unwrap().is_err());
        assert!(ler("/enquete | a | b").unwrap().is_err());
        assert!(ler("/enquetex a | b | c").is_none());
    }

    #[test]
    fn voto_move_e_desfaz() {
        let mut e = ler("/poll x | a | b").unwrap().unwrap();
        assert!(e.votar("Ana", 0));
        assert!(e.votar("ana", 1));
        assert!(e.opcoes[0].votos.is_empty());
        assert_eq!(e.opcoes[1].votos, ["ana"]);
        assert!(e.votar("ANA", 1));
        assert!(e.opcoes[1].votos.is_empty());
        assert!(!e.votar("ana", 2));
    }
}
