//! Descobrir por qual endereco os amigos alcancam esta maquina, e abrir as
//! portas no firewall.
//!
//! Quem hospeda em casa quase nunca sabe o proprio IP, e menos ainda qual dos
//! varios: a placa de rede, o Wi-Fi, o Radmin, o Hamachi e o Docker aparecem
//! todos. Listar com o nome da interface deixa a escolha obvia.

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Endereco {
    pub ip: String,
    pub interface: String,
    /// Endereco de VPN (Radmin, Hamachi, ZeroTier, Tailscale). E o caminho que
    /// costuma funcionar sem mexer em roteador, entao vai destacado.
    pub vpn: bool,
}

/// As faixas que a Radmin e a Hamachi usam. Nao sao privadas comuns, e por isso
/// dao para reconhecer com seguranca razoavel.
fn parece_vpn(ip: &str, interface: &str) -> bool {
    let nome = interface.to_lowercase();
    nome.contains("radmin") || nome.contains("hamachi") || nome.contains("zerotier")
        || nome.contains("tailscale") || nome.contains("wireguard")
        // Radmin VPN entrega 26.x.x.x; Hamachi, 25.x.x.x.
        || ip.starts_with("26.") || ip.starts_with("25.")
}

/// Os IPv4 desta maquina, com o nome da interface de cada um.
///
/// Sai por `ipconfig` em vez de uma biblioteca: e uma leitura so, na abertura
/// da tela, e evita mais uma dependencia num app que ja carrega o Tauri.
#[cfg(windows)]
pub fn enderecos() -> Vec<Endereco> {
    use std::os::windows::process::CommandExt;
    let saida = std::process::Command::new("ipconfig")
        .creation_flags(0x0800_0000)
        .output();
    let Ok(saida) = saida else { return Vec::new() };
    // `ipconfig` sai na lingua do Windows; o rotulo do IPv4 muda de idioma, mas
    // a forma "algo. . . : 1.2.3.4" nao. A interface e o cabecalho anterior.
    let texto = String::from_utf8_lossy(&saida.stdout);
    let mut atual = String::from("rede");
    let mut lista = Vec::new();
    for linha in texto.lines() {
        if !linha.starts_with(' ') && linha.contains(':') {
            atual = linha.trim_end_matches(':').trim().to_string();
            continue;
        }
        let Some((rotulo, valor)) = linha.split_once(':') else { continue };
        let valor = valor.trim();
        if !rotulo.to_lowercase().contains("ipv4") { continue; }
        // O valor as vezes vem com sufixo, como "(Preferencial)".
        let valor = valor.split_whitespace().next().unwrap_or("");
        if valor.split('.').count() != 4 { continue; }
        if valor.starts_with("127.") { continue; }
        lista.push(Endereco { vpn: parece_vpn(valor, &atual), ip: valor.to_string(), interface: atual.clone() });
    }
    // VPN primeiro: e o endereco que funciona sem abrir porta no roteador.
    lista.sort_by_key(|e| !e.vpn);
    lista
}

#[cfg(not(windows))]
pub fn enderecos() -> Vec<Endereco> { Vec::new() }

/// Libera as portas do servidor e do LiveKit no firewall do Windows.
///
/// Precisa de administrador. Sem isto, a maquina responde a si mesma e a mais
/// ninguem — e o sintoma ("funciona aqui, nao funciona no PC do amigo") e dos
/// mais dificeis de adivinhar.
#[cfg(windows)]
pub fn abrir_firewall(porta: u16) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    let regras = [
        (format!("naoconcordo servidor {porta}"), format!("{porta}")),
        ("naoconcordo livekit".to_string(), "7880,7881".to_string()),
        ("naoconcordo livekit midia".to_string(), "50000-50200".to_string()),
    ];
    let mut feitas = Vec::new();
    for (nome, portas) in regras {
        for protocolo in ["TCP", "UDP"] {
            let saida = std::process::Command::new("netsh")
                .args([
                    "advfirewall", "firewall", "add", "rule",
                    &format!("name={nome} {protocolo}"),
                    "dir=in", "action=allow",
                    &format!("protocol={protocolo}"),
                    &format!("localport={portas}"),
                ])
                .creation_flags(0x0800_0000)
                .output()
                .map_err(|e| format!("nao foi possivel chamar o netsh: {e}"))?;
            if !saida.status.success() {
                let motivo = String::from_utf8_lossy(&saida.stdout);
                return Err(format!("o firewall recusou a regra. Abra o painel como administrador. ({})", motivo.trim()));
            }
        }
        feitas.push(nome);
    }
    Ok(format!("{} regras criadas.", feitas.len() * 2))
}

#[cfg(not(windows))]
pub fn abrir_firewall(_porta: u16) -> Result<String, String> {
    Err("So no Windows.".into())
}
