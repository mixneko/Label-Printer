//! 監看 Windows 列印佇列「有沒有新工作」。`window.print()` 的列印視窗不會告訴程式使用者按了「列印」還是「取消」，
//! 但按「列印」會在某台印表機新增一個工作，按「取消」不會。只看有沒有新增，不讀工作的內容或名稱。

use std::sync::Mutex;
use std::time::Duration;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0};
use windows::Win32::Graphics::Printing::{
    ClosePrinter, FindClosePrinterChangeNotification, FindFirstPrinterChangeNotification, OpenPrinterW,
    PRINTER_CHANGE_ADD_JOB,
};
use windows::Win32::System::Threading::WaitForMultipleObjects;

/// `WaitForMultipleObjects` 一次最多 64 個
const MAX_WATCHED: usize = 64;

pub struct PrintWatch {
    /// (印表機控制代碼, 通知控制代碼)
    watched: Vec<(HANDLE, HANDLE)>,
}

// 這些控制代碼不綁定建立它的執行緒
unsafe impl Send for PrintWatch {}

impl PrintWatch {
    /// 對每台印表機（含網路印表機）開始監看；開不起來的略過，一台都沒有回傳 None。
    pub fn start() -> Option<Self> {
        let mut watched = Vec::new();
        for name in crate::spool::list_printers().ok()? {
            if watched.len() == MAX_WATCHED {
                break;
            }
            let wname: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
            unsafe {
                let mut printer = HANDLE::default();
                if OpenPrinterW(PCWSTR(wname.as_ptr()), &mut printer, None).is_err() {
                    continue;
                }
                let change = FindFirstPrinterChangeNotification(printer, PRINTER_CHANGE_ADD_JOB, 0, None);
                if change == INVALID_HANDLE_VALUE || change.is_invalid() {
                    let _ = ClosePrinter(printer);
                    continue;
                }
                watched.push((printer, change));
            }
        }
        (!watched.is_empty()).then_some(Self { watched })
    }

    /// 開始監看之後是否有新的列印工作；還沒有的話最多再等 `timeout`。
    pub fn job_added(&self, timeout: Duration) -> bool {
        let handles: Vec<HANDLE> = self.watched.iter().map(|w| w.1).collect();
        let result = unsafe { WaitForMultipleObjects(&handles, false, timeout.as_millis() as u32) };
        result.0.wrapping_sub(WAIT_OBJECT_0.0) < handles.len() as u32
    }
}

impl Drop for PrintWatch {
    fn drop(&mut self) {
        for (printer, change) in self.watched.drain(..) {
            unsafe {
                let _ = FindClosePrinterChangeNotification(change);
                let _ = ClosePrinter(printer);
            }
        }
    }
}

#[derive(Default)]
pub struct PrintWatchState(pub Mutex<Option<PrintWatch>>);

#[cfg(test)]
mod tests {
    use super::*;
    use windows::core::PWSTR;
    use windows::Win32::Graphics::Printing::{AbortPrinter, StartDocPrinterW, DOC_INFO_1W};

    /// 手動檢查（需要「Microsoft Print to PDF」）：建立一個工作後立刻中止，不會印出任何東西。
    /// `cargo test print_watch -- --ignored`
    #[test]
    #[ignore]
    fn print_watch_notices_a_new_job_only() {
        let watch = PrintWatch::start().expect("沒有可監看的印表機");
        assert!(!watch.job_added(Duration::from_secs(2)), "沒有送工作時不該回報");

        let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("test-tmp");
        std::fs::create_dir_all(&dir).unwrap();
        let (printer_name, mut doc, mut kind) = (wide("Microsoft Print to PDF"), wide("watch test"), wide("RAW"));
        let mut out = wide(dir.join("watch.pdf").to_str().unwrap());
        unsafe {
            let mut printer = HANDLE::default();
            OpenPrinterW(PCWSTR(printer_name.as_ptr()), &mut printer, None).unwrap();
            let info = DOC_INFO_1W {
                pDocName: PWSTR(doc.as_mut_ptr()),
                pOutputFile: PWSTR(out.as_mut_ptr()),
                pDatatype: PWSTR(kind.as_mut_ptr()),
            };
            assert!(StartDocPrinterW(printer, 1, &info) != 0, "StartDocPrinter 失敗");
            let _ = AbortPrinter(printer);
            let _ = ClosePrinter(printer);
        }
        assert!(watch.job_added(Duration::from_secs(10)), "新增工作後應該回報");
    }
}
