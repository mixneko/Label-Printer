use serde::Deserialize;
use std::io::Write;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use crate::spool;

/// 列印目的地：Windows 已安裝的印表機（預設），或直連 Raw TCP。
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PrinterTarget {
    Windows { name: String },
    Tcp { host: String, port: u16 },
}

pub fn send(target: &PrinterTarget, payload: &[u8]) -> Result<(), String> {
    match target {
        PrinterTarget::Windows { name } => {
            if name.trim().is_empty() {
                return Err("尚未選擇印表機".into());
            }
            spool::send_raw(name, payload)
        }
        PrinterTarget::Tcp { host, port } => send_tcp(host, *port, payload),
    }
}

fn send_tcp(host: &str, port: u16, payload: &[u8]) -> Result<(), String> {
    let target = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("無法解析印表機位址 {host}:{port}：{e}"))?
        .next()
        .ok_or_else(|| format!("找不到印表機位址 {host}:{port}"))?;

    let mut stream = TcpStream::connect_timeout(&target, Duration::from_secs(3))
        .map_err(|e| format!("連線印表機失敗 {host}:{port}：{e}"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| e.to_string())?;
    stream.write_all(payload).map_err(|e| format!("傳送資料失敗：{e}"))?;
    stream.flush().map_err(|e| e.to_string())
}
