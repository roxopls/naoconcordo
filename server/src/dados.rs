//! Rolagem de dados na conversa: `/r 2d6+3 ataque`.
//!
//! O sorteio acontece **aqui**, e nao no cliente, pelo mesmo motivo de um mestre
//! nao aceitar o dado rolado atras da mao: resultado vindo do computador de quem
//! rola e resultado que a pessoa pode escolher. O servidor sorteia, guarda cada
//! face junto da mensagem, e todo mundo ve o mesmo numero.
//!
//! A gramatica e a que se escreve na mesa: termos somados ou subtraidos, cada um
//! um numero (`5`) ou um punhado de dados (`2d6`, `d20`), com `kh`/`kl` para
//! ficar com os maiores ou menores (`2d20kh1` e a vantagem do D&D).

use rand::Rng;
use serde::{Deserialize, Serialize};

const MAX_TERMOS: usize = 10;
const MAX_DADOS_POR_TERMO: u32 = 100;
const MAX_DADOS_NO_TOTAL: u32 = 200;
const MAX_LADOS: u32 = 1000;
const MAX_NUMERO: i64 = 100_000;
const MAX_MOTIVO: usize = 60;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rolagem {
    /// A expressao como foi entendida, sem espacos: `2d20kh1+5`.
    pub expressao: String,
    /// O "ataque" de `/r d20+5 ataque`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub motivo: Option<String>,
    pub termos: Vec<Termo>,
    pub total: i64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "tipo", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Termo {
    /// `sinal` e 1 ou -1. `descartados` sao os indices de `faces` que o
    /// `kh`/`kl` deixou de fora: o cartao mostra riscados em vez de esconder,
    /// porque ver o 3 que foi jogado fora e parte de confiar na vantagem.
    Dados { sinal: i64, quantidade: u32, lados: u32, faces: Vec<u32>, descartados: Vec<usize> },
    Numero { sinal: i64, valor: i64 },
}

/// `None` quando o texto nao e um pedido de rolagem. `Some(Err)` quando e, mas
/// esta escrito de um jeito que nao da para rolar — a mensagem nao sai e a
/// pessoa recebe o motivo.
pub fn ler(texto: &str) -> Option<Result<Rolagem, String>> {
    let sem_barra = texto.trim().strip_prefix('/')?;
    let (verbo, resto) = match sem_barra.split_once(char::is_whitespace) {
        Some((verbo, resto)) => (verbo, resto.trim()),
        None => (sem_barra, ""),
    };
    if !matches!(verbo.to_lowercase().as_str(), "r" | "rolar" | "roll" | "dado") { return None; }
    Some(rolar(resto))
}

fn rolar(resto: &str) -> Result<Rolagem, String> {
    // Os pedacos do comeco que tem cara de expressao formam a expressao; o
    // primeiro que nao tem comeca o motivo. Assim `/r 2d6 + 3 dano` funciona com
    // ou sem espaco, e `dano` nunca e lido como um `d` perdido.
    let mut expressao = String::new();
    let mut palavras = resto.split_whitespace().peekable();
    while let Some(palavra) = palavras.peek() {
        let minuscula = palavra.to_lowercase();
        let so_simbolos = minuscula.chars().all(|c| c.is_ascii_digit() || "dkhl+-".contains(c));
        let tem_cara = minuscula.chars().any(|c| c.is_ascii_digit()) || minuscula == "+" || minuscula == "-";
        if !so_simbolos || !tem_cara { break; }
        expressao.push_str(&minuscula);
        palavras.next();
    }
    // Um primeiro pedaco com cara de dado que nao passou (`3d6kx1`) e erro de
    // digitacao, e nao motivo: rolar um d20 no lugar dele seria mentir.
    if expressao.is_empty() {
        if let Some(palavra) = palavras.peek() {
            let mut letras = palavra.to_lowercase().chars().collect::<Vec<_>>().into_iter();
            let comeca_como_dado = match letras.next() {
                Some(c) if c.is_ascii_digit() => true,
                Some('d') => letras.next().is_some_and(|c| c.is_ascii_digit()),
                _ => false,
            };
            if comeca_como_dado { return Err(invalida(palavra)); }
        }
    }
    let motivo: String = palavras.collect::<Vec<_>>().join(" ").chars().take(MAX_MOTIVO).collect();
    // `/r` sozinho, ou so com motivo, e o dado mais pedido de todos.
    if expressao.is_empty() { expressao = "d20".into(); }

    let mut termos = Vec::new();
    let mut dados_usados = 0u32;
    let mut total = 0i64;
    for (sinal, pedaco) in separar(&expressao)? {
        if termos.len() >= MAX_TERMOS { return Err(format!("No máximo {MAX_TERMOS} termos por rolagem.")); }
        let termo = match pedaco.split_once('d') {
            None => {
                let valor: i64 = pedaco.parse().map_err(|_| invalida(&expressao))?;
                if valor > MAX_NUMERO { return Err("Número grande demais.".into()); }
                total += sinal * valor;
                Termo::Numero { sinal, valor }
            }
            Some((quantidade, resto)) => {
                let quantidade: u32 = if quantidade.is_empty() { 1 } else { quantidade.parse().map_err(|_| invalida(&expressao))? };
                let (lados, manter) = match resto.find('k') {
                    Some(i) => (&resto[..i], Some(&resto[i..])),
                    None => (resto, None),
                };
                let lados: u32 = lados.parse().map_err(|_| invalida(&expressao))?;
                if quantidade == 0 || quantidade > MAX_DADOS_POR_TERMO {
                    return Err(format!("De 1 a {MAX_DADOS_POR_TERMO} dados por termo."));
                }
                if !(2..=MAX_LADOS).contains(&lados) { return Err(format!("O dado precisa ter de 2 a {MAX_LADOS} lados.")); }
                dados_usados += quantidade;
                if dados_usados > MAX_DADOS_NO_TOTAL { return Err(format!("No máximo {MAX_DADOS_NO_TOTAL} dados por rolagem.")); }
                let mut rng = rand::rng();
                let faces: Vec<u32> = (0..quantidade).map(|_| rng.random_range(1..=lados)).collect();
                let descartados = match manter {
                    None => Vec::new(),
                    Some(regra) => descartar(&faces, regra).ok_or_else(|| invalida(&expressao))?,
                };
                let soma: i64 = faces.iter().enumerate()
                    .filter(|(i, _)| !descartados.contains(i))
                    .map(|(_, face)| *face as i64).sum();
                total += sinal * soma;
                Termo::Dados { sinal, quantidade, lados, faces, descartados }
            }
        };
        termos.push(termo);
    }
    Ok(Rolagem { expressao, motivo: Some(motivo).filter(|m| !m.is_empty()), termos, total })
}

fn invalida(expressao: &str) -> String {
    format!("Não entendi \"{expressao}\". Exemplos: /r d20, /r 2d6+3, /r 2d20kh1.")
}

/// Corta `2d6+3-1` em `[(1, "2d6"), (1, "3"), (-1, "1")]`.
fn separar(expressao: &str) -> Result<Vec<(i64, String)>, String> {
    let mut saida = Vec::new();
    let mut sinal = 1;
    let mut atual = String::new();
    for c in expressao.chars() {
        if c == '+' || c == '-' {
            if atual.is_empty() {
                // Sinal no comeco (`-2`) vale; dois seguidos (`2+-3`) nao.
                if !saida.is_empty() || sinal == -1 { return Err(invalida(expressao)); }
            } else {
                saida.push((sinal, std::mem::take(&mut atual)));
            }
            sinal = if c == '-' { -1 } else { 1 };
        } else {
            atual.push(c);
        }
    }
    if atual.is_empty() { return Err(invalida(expressao)); }
    saida.push((sinal, atual));
    Ok(saida)
}

/// Os indices que ficam de fora por `khN` (mantem os N maiores) ou `klN`.
fn descartar(faces: &[u32], regra: &str) -> Option<Vec<usize>> {
    let (maiores, n) = if let Some(n) = regra.strip_prefix("kh") { (true, n) }
        else if let Some(n) = regra.strip_prefix("kl") { (false, n) }
        else { return None; };
    let manter: usize = n.parse().ok()?;
    if manter == 0 || manter > faces.len() { return None; }
    let mut ordem: Vec<usize> = (0..faces.len()).collect();
    // Estavel: no empate, fica o dado que veio primeiro, e o cartao risca sempre
    // o mesmo entre dois iguais.
    ordem.sort_by(|a, b| if maiores { faces[*b].cmp(&faces[*a]) } else { faces[*a].cmp(&faces[*b]) });
    let mut fora: Vec<usize> = ordem[manter..].to_vec();
    fora.sort();
    Some(fora)
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn nao_e_rolagem() {
        assert!(ler("oi").is_none());
        assert!(ler("/tocar musica").is_none());
        assert!(ler("/rx 2d6").is_none());
    }

    #[test]
    fn sozinho_e_d20() {
        let r = ler("/r").unwrap().unwrap();
        assert_eq!(r.expressao, "d20");
        assert!((1..=20).contains(&r.total));
    }

    #[test]
    fn soma_com_espaco_e_motivo() {
        let r = ler("/rolar 2d6 + 3 dano de fogo").unwrap().unwrap();
        assert_eq!(r.expressao, "2d6+3");
        assert_eq!(r.motivo.as_deref(), Some("dano de fogo"));
        assert!((5..=15).contains(&r.total));
        assert_eq!(r.termos.len(), 2);
    }

    #[test]
    fn vantagem_descarta_o_menor() {
        for _ in 0..50 {
            let r = ler("/r 2d20kh1").unwrap().unwrap();
            let Termo::Dados { faces, descartados, .. } = &r.termos[0] else { panic!() };
            assert_eq!(descartados.len(), 1);
            assert_eq!(r.total, *faces.iter().max().unwrap() as i64);
        }
    }

    #[test]
    fn subtrai() {
        let r = ler("/r 1d4-10").unwrap().unwrap();
        assert!((-9..=-6).contains(&r.total));
    }

    #[test]
    fn recusa_o_que_nao_da() {
        assert!(ler("/r 0d6").unwrap().is_err());
        assert!(ler("/r 101d6").unwrap().is_err());
        assert!(ler("/r d1").unwrap().is_err());
        assert!(ler("/r 2d6+").unwrap().is_err());
        assert!(ler("/r 2d6++3").unwrap().is_err());
        assert!(ler("/r 2d6kh3").unwrap().is_err());
        assert!(ler("/r 3d6kx1").unwrap().is_err());
        assert!(ler("/r 2d6+3x").unwrap().is_err());
    }

    #[test]
    fn so_motivo_rola_d20() {
        let r = ler("/r iniciativa").unwrap().unwrap();
        assert_eq!(r.expressao, "d20");
        assert_eq!(r.motivo.as_deref(), Some("iniciativa"));
    }
}
