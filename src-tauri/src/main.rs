// 發行版隱藏 Windows 的 console 視窗
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    label_printer_lib::run()
}
