// Sem console no Windows: o painel e uma janela, nao um comando.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() { naoconcordo_painel_lib::run() }
