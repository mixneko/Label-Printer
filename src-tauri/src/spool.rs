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

/// 取得 Windows 印表機使用的驅動程式名稱（例如「TSC TTP-244 Pro」「ZDesigner GK420t」），用來猜印表機語言。
pub fn driver_name(printer_name: &str) -> Result<String, String> {
    use windows::Win32::Graphics::Printing::{GetPrinterW, PRINTER_INFO_2W};
    unsafe {
        let wname = wide(printer_name);
        let mut handle = HANDLE::default();
        OpenPrinterW(PCWSTR(wname.as_ptr()), &mut handle, None)
            .map_err(|e| format!("開啟印表機「{printer_name}」失敗：{e}"))?;
        let mut needed = 0u32;
        let _ = GetPrinterW(handle, 2, None, &mut needed);
        let result = if needed == 0 {
            Err(format!("讀取印表機資訊失敗：{}", last_err()))
        } else {
            let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
            let bytes = std::slice::from_raw_parts_mut(buf.as_mut_ptr() as *mut u8, needed as usize);
            match GetPrinterW(handle, 2, Some(bytes), &mut needed) {
                Ok(()) => {
                    let info = &*(buf.as_ptr() as *const PRINTER_INFO_2W);
                    let mut s = pwstr_to_string(info.pDriverName).unwrap_or_default();
                    // 驅動程式的廠商、硬體 ID 比使用者可以改的印表機名稱可靠，附加進去一起比對（讀不到就略過）
                    if let Some(extra) = driver_extra(handle) {
                        s.push(' ');
                        s.push_str(&extra);
                    }
                    Ok(s)
                }
                Err(e) => Err(format!("讀取印表機資訊失敗：{e}")),
            }
        };
        let _ = ClosePrinter(handle);
        result
    }
}

/// 空指標（Windows 常把沒有的欄位留成 NULL）回傳 None，不去讀取。
unsafe fn pwstr_to_string(p: PWSTR) -> Option<String> {
    if p.is_null() { None } else { p.to_string().ok() }
}

/// 驅動程式的廠商名稱、硬體 ID 與提供者（DRIVER_INFO_6）；失敗回傳 None。
unsafe fn driver_extra(handle: HANDLE) -> Option<String> {
    use windows::Win32::Graphics::Printing::{GetPrinterDriverW, DRIVER_INFO_6W};
    let mut needed = 0u32;
    let _ = GetPrinterDriverW(handle, PCWSTR::null(), 6, None, &mut needed);
    if needed == 0 {
        return None;
    }
    let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
    let bytes = std::slice::from_raw_parts_mut(buf.as_mut_ptr() as *mut u8, needed as usize);
    if !GetPrinterDriverW(handle, PCWSTR::null(), 6, Some(bytes), &mut needed).as_bool() {
        return None;
    }
    let info = &*(buf.as_ptr() as *const DRIVER_INFO_6W);
    let parts: Vec<String> = [info.pszMfgName, info.pszHardwareID, info.pszProvider]
        .iter()
        .filter_map(|p| pwstr_to_string(*p))
        .filter(|s| !s.is_empty())
        .collect();
    (!parts.is_empty()).then(|| parts.join(" "))
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

#[cfg(test)]
mod tests {
    /// 手動檢查用：列出這台電腦所有印表機的驅動程式資訊與偵測到的語言（`cargo test -- --ignored --nocapture`）
    #[test]
    #[ignore]
    fn print_local_driver_info() {
        for name in super::list_printers().unwrap_or_default() {
            let driver = super::driver_name(&name);
            let lang = driver.as_ref().ok().and_then(|d| crate::langs::detect(d, &name));
            println!("{name:40} | {driver:?} | {lang:?}");
        }
    }
}
