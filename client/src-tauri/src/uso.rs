//! Consumo do aplicativo inteiro, somando os processos do WebView2.
//!
//! O WebView2 e Chromium: ele nunca roda dentro do nosso processo. Sao pelo
//! menos tres a mais — o processo do navegador, um por aba renderizada e o da
//! GPU — e o Gerenciador de Tarefas mostra cada um com o nome da Microsoft, o
//! que faz o aplicativo parecer mais leve do que e.
//!
//! Juntar os processos nao e possivel: `--single-process` nao e suportado no
//! WebView2. O que da para fazer e somar, e e o que este modulo faz — anda a
//! arvore de processos a partir do nosso PID e devolve o total.
//!
//! O tempo de CPU vai cru, acumulado desde que cada processo nasceu. Virar
//! porcentagem exige duas medidas, entao quem divide pela diferenca de tempo e
//! o cliente, que ja esta chamando de tempos em tempos.

use serde::Serialize;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Uso {
    /// Memoria residente somada, em bytes.
    pub memoria: u64,
    /// Tempo de CPU somado (usuario + nucleo), em milissegundos.
    pub cpu_ms: u64,
    pub processos: u32,
    /// Para o cliente dividir e chegar na porcentagem de uma maquina inteira.
    pub nucleos: u32,
    pub grupos: Vec<Grupo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Grupo {
    pub nome: String,
    pub memoria: u64,
    pub processos: u32,
}

#[tauri::command]
pub fn uso_de_recursos() -> Uso {
    #[cfg(windows)]
    {
        janela::medir()
    }
    #[cfg(not(windows))]
    {
        Uso::default()
    }
}

#[cfg(windows)]
mod janela {
    use super::{Grupo, Uso};
    use std::collections::HashMap;
    use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    struct Processo {
        pai: u32,
        nome: String,
    }

    /// Fotografia de todos os processos da maquina.
    ///
    /// Nao da para perguntar "quem sao meus filhos" direto no Windows: a unica
    /// saida e listar tudo e olhar o pai de cada um.
    fn fotografar() -> HashMap<u32, Processo> {
        let mut mapa = HashMap::new();
        let Ok(foto) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
            return mapa;
        };
        let mut entrada = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if unsafe { Process32FirstW(foto, &mut entrada) }.is_ok() {
            loop {
                let fim = entrada
                    .szExeFile
                    .iter()
                    .position(|c| *c == 0)
                    .unwrap_or(entrada.szExeFile.len());
                mapa.insert(
                    entrada.th32ProcessID,
                    Processo {
                        pai: entrada.th32ParentProcessID,
                        nome: String::from_utf16_lossy(&entrada.szExeFile[..fim]),
                    },
                );
                if unsafe { Process32NextW(foto, &mut entrada) }.is_err() {
                    break;
                }
            }
        }
        let _ = unsafe { CloseHandle(foto) };
        mapa
    }

    fn cem_nanos(t: FILETIME) -> u64 {
        ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64
    }

    /// Memoria residente e tempo de CPU de um processo, se ele deixar perguntar.
    ///
    /// Um filho pode morrer entre a fotografia e a medida; nesse caso ele
    /// simplesmente nao entra na conta.
    fn medir_um(pid: u32) -> Option<(u64, u64)> {
        let alvo: HANDLE = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
        let mut contadores = PROCESS_MEMORY_COUNTERS {
            cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            ..Default::default()
        };
        let memoria = if unsafe {
            K32GetProcessMemoryInfo(alvo, &mut contadores, contadores.cb)
        }
        .as_bool()
        {
            contadores.WorkingSetSize as u64
        } else {
            0
        };

        let (mut criado, mut saiu, mut nucleo, mut usuario) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        let cpu = if unsafe {
            GetProcessTimes(alvo, &mut criado, &mut saiu, &mut nucleo, &mut usuario)
        }
        .is_ok()
        {
            // FILETIME conta em unidades de 100 ns.
            (cem_nanos(nucleo) + cem_nanos(usuario)) / 10_000
        } else {
            0
        };

        let _ = unsafe { CloseHandle(alvo) };
        Some((memoria, cpu))
    }

    /// Nome curto para o Gerenciador de Tarefas do aplicativo.
    fn rotulo(nome: &str) -> &'static str {
        let baixo = nome.to_ascii_lowercase();
        if baixo.contains("webview") {
            "Interface (WebView2)"
        } else if baixo.contains("naoconcordo") {
            "Aplicativo"
        } else {
            "Outros"
        }
    }

    pub fn medir() -> Uso {
        let mapa = fotografar();
        let meu = std::process::id();

        // Largura primeiro a partir do nosso PID. O PID e reciclado pelo
        // Windows, entao um processo antigo pode apontar para um pai que hoje e
        // outro programa; `vistos` impede que um ciclo desses trave o laco.
        let mut fila = vec![meu];
        let mut vistos = std::collections::HashSet::new();
        vistos.insert(meu);
        let mut membros = vec![meu];
        while let Some(atual) = fila.pop() {
            for (pid, processo) in &mapa {
                if processo.pai == atual && vistos.insert(*pid) {
                    membros.push(*pid);
                    fila.push(*pid);
                }
            }
        }

        let mut total = Uso {
            nucleos: std::thread::available_parallelism()
                .map(|n| n.get() as u32)
                .unwrap_or(1),
            ..Default::default()
        };
        let mut por_grupo: HashMap<&'static str, (u64, u32)> = HashMap::new();
        for pid in membros {
            let Some((memoria, cpu)) = medir_um(pid) else { continue };
            total.memoria += memoria;
            total.cpu_ms += cpu;
            total.processos += 1;
            let nome = mapa.get(&pid).map(|p| p.nome.as_str()).unwrap_or("");
            let entrada = por_grupo.entry(rotulo(nome)).or_insert((0, 0));
            entrada.0 += memoria;
            entrada.1 += 1;
        }
        total.grupos = por_grupo
            .into_iter()
            .map(|(nome, (memoria, processos))| Grupo {
                nome: nome.to_string(),
                memoria,
                processos,
            })
            .collect();
        // Maior primeiro: o interessante e ver quem esta pesando.
        total.grupos.sort_by(|a, b| b.memoria.cmp(&a.memoria));
        total
    }
}
