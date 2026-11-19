//! 透過 Windows 假脫機（Spooler）以 RAW 資料型態送出資料到已安裝的印表機。
//! RAW 代表驅動不會轉譯內容，TSPL 指令原封不動送到印表機。

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Graphics::Printing::{
    ClosePrinter, EndDocPrinter, EndPagePrinter, EnumPrintersW, OpenPrinterW, StartDocPrinterW,
    StartPagePrinter, WritePrinter, DOC_INFO_1W, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL,
    PRINTER_INFO_4W,
};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn last_err() -> String {
    windows::core::Error::from_win32().to_string()
}

pub fn send_raw(printer_name: &str, data: &[u8]) -> Result<(), String> {
    unsafe {
        let wname = wide(printer_name);
        let mut handle = HANDLE::default();
        OpenPrinterW(PCWSTR(wname.as_ptr()), &mut handle, None)
            .map_err(|e| format!("開啟印表機「{printer_name}」失敗：{e}"))?;

        let mut doc_name = wide("Label Printer");
        let mut datatype = wide("RAW");
        let info = DOC_INFO_1W {
            pDocName: PWSTR(doc_name.as_mut_ptr()),
            pOutputFile: PWSTR::null(),
            pDatatype: PWSTR(datatype.as_mut_ptr()),
        };

        let result = write_job(handle, &info, data);
        let _ = ClosePrinter(handle);
        result
    }
}

unsafe fn write_job(handle: HANDLE, info: &DOC_INFO_1W, data: &[u8]) -> Result<(), String> {
    if StartDocPrinterW(handle, 1, info) == 0 {
        return Err(format!("StartDocPrinter 失敗：{}", last_err()));
    }
    let result = (|| {
        StartPagePrinter(handle)
            .ok()
            .map_err(|_| format!("StartPagePrinter 失敗：{}", last_err()))?;
        let mut written = 0u32;
        WritePrinter(handle, data.as_ptr() as *const _, data.len() as u32, &mut written)
            .ok()
            .map_err(|_| format!("WritePrinter 失敗：{}", last_err()))?;
        let _ = EndPagePrinter(handle);
        if written as usize != data.len() {
            return Err(format!("只寫入 {written}/{} bytes", data.len()));
        }
        Ok(())
    })();
    let _ = EndDocPrinter(handle);
    result
}

/// 列出本機已安裝（含網路連線）的印表機名稱。
pub fn list_printers() -> Result<Vec<String>, String> {
    unsafe {
        let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
        let (mut needed, mut count) = (0u32, 0u32);
        // 第一次呼叫只為取得所需緩衝區大小（預期會回報空間不足，可忽略）
        let _ = EnumPrintersW(flags, PCWSTR::null(), 4, None, &mut needed, &mut count);
        if needed == 0 {
            return Ok(vec![]);
        }
        // 以 u64 配置緩衝區，確保結構體對齊
        let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
        let bytes = std::slice::from_raw_parts_mut(buf.as_mut_ptr() as *mut u8, needed as usize);
        EnumPrintersW(flags, PCWSTR::null(), 4, Some(bytes), &mut needed, &mut count)
            .map_err(|e| format!("列舉印表機失敗：{e}"))?;
        let infos = std::slice::from_raw_parts(buf.as_ptr() as *const PRINTER_INFO_4W, count as usize);
        Ok(infos
            .iter()
            .map(|i| i.pPrinterName.to_string().unwrap_or_default())
            .filter(|n| !n.is_empty())
            .collect())
    }
}
