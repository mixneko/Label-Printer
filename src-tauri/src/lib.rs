mod dbsource;
mod fonts;
mod guard;
mod langs;
mod netdb;
mod numfmt;
mod printer;
mod sheet;
mod spool;
mod tspl;

use printer::PrinterTarget;
use tspl::PrintJob;

/// 前端傳來已渲染好的 1-bit 點陣（可多張），這裡組成 TSPL 並以單一列印工作送到印表機。
#[tauri::command]
async fn print_labels(target: PrinterTarget, jobs: Vec<PrintJob>) -> Result<(), String> {
    let payload = tspl::build_many(&jobs)?;
    // 假脫機與 socket 都是阻塞式，放到專用執行緒避免卡住 UI
    tauri::async_runtime::spawn_blocking(move || printer::send(&target, &payload))
        .await
        .map_err(|e| e.to_string())?
}

/// 列出 Windows 已安裝的印表機。
#[tauri::command]
async fn list_printers() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(spool::list_printers)
        .await
        .map_err(|e| e.to_string())?
}

/// 依 Windows 驅動程式名稱猜印表機語言。回傳 `{ lang, driver }`：猜不出來時 lang 為 null。
#[derive(serde::Serialize)]
struct DetectedLang {
    lang: Option<&'static str>,
    driver: String,
}

#[tauri::command]
async fn detect_printer_language(name: String) -> Result<DetectedLang, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let driver = spool::driver_name(&name)?;
        Ok(DetectedLang { lang: langs::detect(&driver, &name), driver })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 列出 Windows 已安裝的字型家族。
#[tauri::command]
async fn list_fonts() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(fonts::list_fonts)
        .await
        .map_err(|e| e.to_string())?
}

/// 讀取使用者在對話框中選定的 Excel / CSV 檔，回傳欄位標題與資料列。
#[tauri::command]
async fn read_table(path: String, sheet: Option<String>, offset: Option<u64>, limit: Option<u64>) -> Result<sheet::TableData, String> {
    // offset／limit 只對資料庫有意義（一頁一頁讀，每頁最多 1000 列）；檔案類來源忽略
    tauri::async_runtime::spawn_blocking(move || sheet::read_table_page(&path, sheet.as_deref(), offset, limit))
        .await
        .map_err(|e| e.to_string())?
}

/// 這台電腦的 ODBC 驅動程式與已設定的資料來源名稱（資料庫連線對話框的選單）。
#[tauri::command]
async fn list_odbc_sources() -> Result<dbsource::OdbcSources, String> {
    tauri::async_runtime::spawn_blocking(dbsource::list_sources)
        .await
        .map_err(|e| e.to_string())?
}

/// 前端要求重新格式化的一筆資料：Excel 儲存格的原始值，加上使用者在標籤上指定的格式碼。
#[derive(serde::Deserialize)]
struct FormatItem {
    raw: sheet::Raw,
    code: String,
}

/// 「欄位格式」：把原始值（數字／日期）用使用者指定的 Excel 格式碼重新格式化。
/// 每一筆回傳格式化後的文字；格式碼看不懂或與值型別不符時為 null，前端會退回 Excel 原本的顯示。
#[tauri::command]
fn format_values(items: Vec<FormatItem>) -> Vec<Option<String>> {
    items.iter().map(|it| sheet::format_raw(&it.raw, &it.code)).collect()
}

/// 從命令列參數挑出要開啟的標籤檔：第一個存在、副檔名是 .lpxl 或 .json 的路徑。
fn pick_startup_file<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    args.into_iter().find(|a| {
        let l = a.to_lowercase();
        (l.ends_with(".lpxl") || l.ends_with(".json")) && std::path::Path::new(a).is_file()
    })
}

/// 在檔案總管雙擊標籤檔開啟程式時，Windows 把檔案路徑放在命令列參數；回傳它（沒有就是 None）。
#[tauri::command]
fn startup_file() -> Option<String> {
    pick_startup_file(std::env::args().skip(1))
}

/// 用預設瀏覽器開啟「檢查新版本」找到的下載頁面。只允許本專案的 GitHub 網址，避免被拿去開任意連結。
const OPEN_URL_PREFIX: &str = "https://github.com/mixneko/Label-Printer";

fn url_allowed(url: &str) -> bool {
    url.starts_with(OPEN_URL_PREFIX)
        && matches!(url.as_bytes().get(OPEN_URL_PREFIX.len()), None | Some(b'/') | Some(b'?') | Some(b'#'))
        && url.chars().all(|c| c.is_ascii_graphic())
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url_allowed(&url) {
        return Err("不允許的網址".into());
    }
    #[cfg(windows)]
    {
        // 不經 shell：參數原樣交給 rundll32
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        Err("此平台不支援".into())
    }
}

/// 這個程式是不是用安裝檔裝出來的（安裝資料夾裡有 NSIS 的 uninstall.exe）。
/// 只有安裝版能原地更新；免安裝版自己執行，更新時改成開啟下載頁。
#[tauri::command]
fn is_installed() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("uninstall.exe")))
        .is_some_and(|p| p.is_file())
}

/// 檔案是否已存在（儲存時避免默默覆蓋同名檔案）。
#[tauri::command]
fn path_exists(path: String) -> bool {
    std::path::Path::new(&path).is_file()
}

/// 讀寫檔案的命令只服務「標籤檔」與「匯出的 PDF」。就算網頁部分被攻擊者控制，也不能拿這些命令去
/// 讀任意檔案、或覆蓋腳本／執行檔／開機啟動捷徑（只放行固定的副檔名，且必須是完整路徑）。
const LABEL_EXTS: &[&str] = &["lpxl", "json"];
const MAX_LABEL_BYTES: u64 = 64 * 1024 * 1024;

fn check_file_kind(path: &str, exts: &[&str]) -> Result<(), String> {
    let p = std::path::Path::new(path);
    let ext_ok = p
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| exts.iter().any(|x| x.eq_ignore_ascii_case(e)));
    // 路徑要是完整路徑（檔案對話框回傳的都是），且不含 `..`
    let plain = p.is_absolute() && !p.components().any(|c| matches!(c, std::path::Component::ParentDir));
    if ext_ok && plain {
        Ok(())
    } else {
        Err("不允許存取這種檔案".into())
    }
}

/// 讀取使用者在對話框中選定的文字檔（範本 JSON）。
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    check_file_kind(&path, LABEL_EXTS)?;
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_LABEL_BYTES {
        return Err("標籤檔過大，已拒絕開啟".into());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("讀取檔案失敗：{e}"))
}

/// 寫入使用者在對話框中選定的文字檔（範本 JSON）。
#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    check_file_kind(&path, LABEL_EXTS)?;
    std::fs::write(&path, content).map_err(|e| format!("寫入檔案失敗：{e}"))
}

/// 寫入二進位檔（例如匯出的 PDF）；內容以 base64 傳入。
#[tauri::command]
fn write_binary_file(path: String, data: String) -> Result<(), String> {
    use base64::Engine;
    check_file_kind(&path, &["pdf"])?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| format!("資料格式錯誤：{e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("寫入檔案失敗：{e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            print_labels,
            open_url,
            list_printers,
            detect_printer_language,
            list_fonts,
            read_table,
            list_odbc_sources,
            format_values,
            read_text_file,
            write_text_file,
            write_binary_file,
            path_exists,
            startup_file,
            is_installed
        ])
        .run(tauri::generate_context!())
        .expect("啟動 Tauri 失敗");
}

#[cfg(test)]
mod tests {
    use super::{check_file_kind, pick_startup_file, url_allowed, LABEL_EXTS};

    #[test]
    fn file_commands_only_allow_label_and_pdf_files() {
        assert!(check_file_kind("C:\\Users\\a\\label.lpxl", LABEL_EXTS).is_ok());
        assert!(check_file_kind("C:\\Users\\a\\OLD.JSON", LABEL_EXTS).is_ok());
        assert!(check_file_kind("C:\\Users\\a\\x.pdf", &["pdf"]).is_ok());
        // 其他檔案、腳本、執行檔、相對路徑、上層目錄、沒有副檔名都不行
        for bad in ["C:\\Windows\\win.ini", "C:\\Users\\a\\Startup\\a.bat", "C:\\x\\run.exe", "C:\\x\\evil.lpxl.lnk", "label.lpxl", "C:\\x\\..\\y\\a.lpxl", "C:\\x\\noext"] {
            assert!(check_file_kind(bad, LABEL_EXTS).is_err(), "{bad}");
        }
        assert!(check_file_kind("C:\\x\\a.lpxl", &["pdf"]).is_err());
    }

    #[test]
    fn open_url_only_allows_the_project_repo() {
        assert!(url_allowed("https://github.com/mixneko/Label-Printer"));
        assert!(url_allowed("https://github.com/mixneko/Label-Printer/releases/tag/v0.9.3"));
        assert!(!url_allowed("https://github.com/mixneko/Label-Printer-evil/x"));
        assert!(!url_allowed("https://evil.example/https://github.com/mixneko/Label-Printer"));
        assert!(!url_allowed("http://github.com/mixneko/Label-Printer"));
        assert!(!url_allowed("https://github.com/mixneko/Label-Printer/a b"));
        assert!(!url_allowed("file:///C:/Windows/System32/calc.exe"));
    }

    #[test]
    fn picks_the_first_existing_label_file_argument() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("test-tmp");
        std::fs::create_dir_all(&dir).unwrap();
        let lpxl = dir.join("開啟測試.LPXL");
        let json = dir.join("舊版.json");
        let txt = dir.join("其他.txt");
        for p in [&lpxl, &json, &txt] {
            std::fs::write(p, "{}").unwrap();
        }
        let s = |p: &std::path::Path| p.to_string_lossy().into_owned();
        // 副檔名不分大小寫；跳過不是標籤檔的參數與不存在的檔案
        assert_eq!(pick_startup_file(vec!["--flag".into(), s(&txt), "C:\\不存在.lpxl".into(), s(&lpxl), s(&json)]), Some(s(&lpxl)));
        assert_eq!(pick_startup_file(vec![s(&json)]), Some(s(&json)));
        assert_eq!(pick_startup_file(vec![s(&txt)]), None);
        assert_eq!(pick_startup_file(Vec::<String>::new()), None);
    }
}
