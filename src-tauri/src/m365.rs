//! 網頁版 Excel：用另一個視窗登入 Microsoft 帳號，之後用那個登入狀態下載活頁簿，下載到的檔案交給原本的 Excel 讀取功能。
//!
//! 不需要向 Microsoft 註冊應用程式，程式也不經手密碼。登入視窗載入的是遠端網頁，
//! Tauri 會拒絕遠端來源呼叫本程式的任何命令（我們沒有給它任何 capability）。
//! 視窗平常是隱藏的：直接向下載網址要檔案（不載入 Excel 頁面，所以不會以編輯者身分開著它）；
//! 只有需要登入、或自動下載不了要使用者自己按「下載複本」時才顯示（此時用「檢視」模式開啟）。
//! 下載的檔案放在快取資料夾，只留最近兩份，程式結束時清掉。
//! 回報用的診斷字串只含網站種類、頁面名稱與參數名稱，不含公司名稱、路徑或檔名。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::webview::DownloadEvent;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const LABEL: &str = "m365";

const SHEET_EXTS: &[&str] = &["xlsx", "xlsm", "xls", "xlsb", "ods", "csv"];
/// 每個下載網址最多等多久
const WAIT: Duration = Duration::from_secs(20);
/// 停在登入頁超過這麼久，就當作需要使用者自己登入（有效的登入狀態會在這之前自動跳轉完）
const LOGIN_GRACE: Duration = Duration::from_secs(6);
/// 頁面停住這麼久沒下載，就換下一步
const SETTLE: Duration = Duration::from_secs(5);
/// 等使用者登入或自己按下載最多等多久
const USER_WAIT: Duration = Duration::from_secs(600);

#[derive(Clone)]
struct Downloaded {
    path: PathBuf,
    name: String,
}

#[derive(Default)]
struct Downloads {
    /// 下載開始過幾次、結束過幾次
    started: u64,
    finished: u64,
    /// 正在下載的檔案
    pending: Option<Downloaded>,
    /// 最後一次下載完成、還沒被拿走的檔案
    ready: Option<Downloaded>,
}

#[derive(Default)]
pub struct M365State {
    downloads: Mutex<Downloads>,
    /// 一次只做一個同步
    busy: AtomicBool,
    /// 每個貼上的網址上次成功的下載網址，下次先試它（有些要開過頁面才推得出來，背景更新得靠這個）
    known: Mutex<HashMap<String, Url>>,
    /// 保留中的下載檔（最多兩份：上一版與這一版）
    kept: Mutex<Vec<PathBuf>>,
}

#[derive(serde::Serialize)]
pub struct Synced {
    /// ok／manual（使用者自己按下載取得）／login（需要登入）／cancelled／failed／busy
    status: &'static str,
    file: String,
    name: String,
    /// 診斷用，不含任何私人資訊
    report: Vec<String>,
}

fn host_kind(url: &Url) -> &'static str {
    let host = url.host_str().unwrap_or("");
    if host.ends_with("-my.sharepoint.com") {
        "sharepoint-my"
    } else if host.ends_with(".sharepoint.com") {
        "sharepoint"
    } else if host == "onedrive.live.com" {
        "onedrive.live"
    } else if host == "1drv.ms" {
        "1drv"
    } else if host == "excel.cloud.microsoft" || host.ends_with(".cloud.microsoft") {
        "cloud.microsoft"
    } else if host.ends_with(".office.com") || host == "office.com" {
        "office.com"
    } else if host == "login.microsoftonline.com" || host == "login.live.com" || host == "login.microsoft.com" {
        "login"
    } else {
        "other"
    }
}

/// 使用者貼上的網址只接受 Microsoft 的雲端硬碟網址（登入過程中跳去哪裡不限制）
fn parse_entry(url: &str) -> Result<Url, String> {
    let parsed = Url::parse(url.trim()).ok().filter(|u| u.scheme() == "https" && !matches!(host_kind(u), "other" | "login"));
    parsed.ok_or_else(|| "請貼上 SharePoint 或 OneDrive 的網址（https 開頭）".to_string())
}

/// 網址的形狀（回報用）：網站種類、最後一段如果是 .aspx 才寫出來、參數只寫名稱
fn describe(url: &Url) -> String {
    let page = url.path_segments().and_then(|mut s| s.next_back()).filter(|s| s.ends_with(".aspx")).unwrap_or("-");
    let first = url.path_segments().and_then(|mut s| s.next()).filter(|s| s.starts_with(':') || *s == "personal" || *s == "sites").unwrap_or("-");
    let keys: Vec<String> = url
        .query_pairs()
        .map(|(k, _)| k.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(20).collect())
        .collect();
    format!("{} | {first} | {page} | {}", host_kind(url), keys.join(","))
}

fn query(url: &Url, name: &str) -> Option<String> {
    url.query_pairs().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.into_owned())
}

/// 把某些參數拿掉、再設定一個參數
fn with_param(url: &Url, drop: &[&str], key: &str, value: &str) -> Url {
    let kept: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(k, _)| k != key && !drop.contains(&k.as_ref()))
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let mut out = url.clone();
    out.set_fragment(None);
    out.query_pairs_mut().clear().extend_pairs(kept).append_pair(key, value);
    out
}

fn with_download_flag(url: &Url) -> Url {
    with_param(url, &["web", "action"], "download", "1")
}

/// 在登入視窗裡開啟用的網址：指定用網頁版開（web=1，否則有些網站會叫電腦版 Excel 開檔），
/// Excel 頁面一律用「檢視」模式，不要一打開就是編輯模式
fn view_url(entry: &Url) -> Url {
    let web = with_param(entry, &["mobileredirect", "download"], "web", "1");
    if query(entry, "sourcedoc").is_none() && !entry.path().to_ascii_lowercase().starts_with("/:x:") {
        return web;
    }
    with_param(&web, &[], "action", "view")
}

/// 登入視窗只准前往網頁；`ms-excel:` 之類會叫起電腦上其他程式的網址一律擋掉
fn web_navigation_only(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "about" | "data" | "blob")
}

/// 依「目前停在哪一頁」與「使用者貼的網址」推出幾個可能的下載網址，依序嘗試
/// `/:x:/s/網站/代碼` 這類短網址（「複製連結」給的格式）：網址裡沒有檔案編號
fn is_short_link(url: &Url) -> bool {
    let mut seg = url.path_segments().into_iter().flatten();
    seg.next().is_some_and(|s| s.starts_with(':') && s.ends_with(':'))
        && seg.next().is_some_and(|s| matches!(s, "s" | "t" | "g"))
        && query(url, "sourcedoc").is_none()
}

/// 短網址不能直接打開那一頁（SharePoint 會叫電腦版 Excel 開檔），改用代碼組出下載網址
fn short_link_targets(entry: &Url) -> Vec<(&'static str, Url)> {
    use base64::Engine;
    let mut out = Vec::new();
    let seg: Vec<&str> = entry.path_segments().map(|s| s.filter(|x| !x.is_empty()).collect()).unwrap_or_default();
    // seg[0]=":x:"，seg[1]=s（網站）／t（teams）／g（個人或根網站），最後一段是代碼
    let base = match (seg.get(1).copied(), seg.len()) {
        (Some("s"), 4) => Some(format!("/sites/{}", seg[2])),
        (Some("t"), 4) => Some(format!("/teams/{}", seg[2])),
        (Some("g"), 5) => Some(format!("/{}/{}", seg[2], seg[3])),
        (Some("g"), 3) => Some(String::new()),
        _ => None,
    };
    if let (Some(base), Some(token)) = (base, seg.last()) {
        let mut u = entry.clone();
        u.set_path(&format!("{base}/_layouts/15/download.aspx"));
        u.set_fragment(None);
        u.query_pairs_mut().clear().append_pair("share", token);
        out.push(("download.aspx?share", u));
    }
    // SharePoint 內建的分享連結介面：用同一個登入狀態直接取得檔案內容
    let id = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(entry.as_str());
    let mut u = entry.clone();
    u.set_path(&format!("/_api/v2.0/shares/u!{id}/driveItem/content"));
    u.set_query(None);
    u.set_fragment(None);
    out.push(("shares-api", u));
    out
}

fn candidates(current: &Url, entry: &Url) -> Vec<(&'static str, Url)> {
    let mut out: Vec<(&'static str, Url)> = Vec::new();
    // SharePoint／公司 OneDrive 的檢視頁：…/_layouts/15/Doc.aspx?sourcedoc={GUID}
    if let (Some(doc), Some(at)) = (query(current, "sourcedoc"), current.path().to_ascii_lowercase().find("/_layouts/")) {
        let id = doc.trim_matches(|c| c == '{' || c == '}').to_string();
        if !id.is_empty() && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
            let mut u = current.clone();
            u.set_path(&format!("{}/_layouts/15/download.aspx", &current.path()[..at]));
            u.set_fragment(None);
            u.query_pairs_mut().clear().append_pair("UniqueId", &id);
            out.push(("download.aspx", u));
        }
    }
    // 個人 OneDrive 的舊式網址
    if current.host_str() == Some("onedrive.live.com") {
        if let Some(id) = query(current, "resid").or_else(|| query(current, "id")) {
            if let Ok(mut u) = Url::parse("https://onedrive.live.com/download") {
                u.query_pairs_mut().append_pair("resid", &id);
                if let Some(key) = query(current, "authkey") {
                    u.query_pairs_mut().append_pair("authkey", &key);
                }
                out.push(("onedrive-download", u));
            }
        }
    }
    if is_short_link(entry) {
        // 不要碰短網址本身（連加上 download=1 都會讓 SharePoint 叫起電腦版 Excel）
        out.extend(short_link_targets(entry));
        return out;
    }
    // 直接的檔案路徑等：加上 download=1
    out.push(("entry+download=1", with_download_flag(entry)));
    if current.path() != entry.path() && current.host_str() == entry.host_str() {
        out.push(("current+download=1", with_download_flag(current)));
    }
    out
}

fn on_login_page(url: &Url) -> bool {
    let path = url.path().to_ascii_lowercase();
    host_kind(url) == "login" || ["/_forms/", "login", "signin", "authenticate"].iter().any(|k| path.contains(k))
}

fn download_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_cache_dir().map(|d| d.join("m365-download")).map_err(|e| e.to_string())
}

/// 清掉下載過的檔案：啟動時清一天以前的（上次當掉留下的），結束與登出時清這次的
pub fn cleanup(app: &AppHandle, only_stale: bool) {
    let Ok(dir) = download_dir(app) else { return };
    let mine = format!("{}-", std::process::id());
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let remove = if only_stale {
            let modified = entry.metadata().and_then(|m| m.modified()).ok();
            modified.and_then(|t| t.elapsed().ok()).is_some_and(|age| age > Duration::from_secs(86_400))
        } else {
            entry.file_name().to_string_lossy().starts_with(&mine)
        };
        if remove {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn on_download(app: &AppHandle, event: DownloadEvent<'_>) -> bool {
    let state = app.state::<M365State>();
    let Ok(mut d) = state.downloads.lock() else { return false };
    match event {
        DownloadEvent::Requested { destination, .. } => {
            // 只收試算表檔，其他下載一律擋掉
            let name = destination.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let Some(ext) = destination.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase) else { return false };
            if !SHEET_EXTS.contains(&ext.as_str()) {
                return false;
            }
            let Ok(dir) = download_dir(app) else { return false };
            if std::fs::create_dir_all(&dir).is_err() {
                return false;
            }
            d.started += 1;
            let path = dir.join(format!("{}-{}.{ext}", std::process::id(), d.started));
            *destination = path.clone();
            d.pending = Some(Downloaded { path, name });
        }
        DownloadEvent::Finished { success, .. } => {
            let file = d.pending.take();
            if success {
                d.ready = file;
            }
            d.finished += 1;
        }
        _ => {}
    }
    true
}

fn blank() -> Url {
    Url::parse("about:blank").expect("固定的網址")
}

fn window(app: &AppHandle, title: &str) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Ok(w);
    }
    // 登入狀態放在自己的資料夾，與程式主畫面分開
    let profile = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("m365");
    let handle = app.clone();
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(blank()))
        .title(title)
        .inner_size(1100.0, 780.0)
        .visible(false)
        .data_directory(profile)
        .on_navigation(web_navigation_only)
        .on_download(move |_, event| on_download(&handle, event))
        .build()
        .map_err(|e| format!("無法開啟登入視窗：{e}"))
}

/// 開始等下載：回傳目前已結束的下載次數
fn arm(state: &M365State) -> u64 {
    state
        .downloads
        .lock()
        .map(|mut d| {
            d.ready = None;
            d.finished
        })
        .unwrap_or(0)
}

/// 有比 before 更新的下載完成了就拿走
fn arrived(state: &M365State, before: u64) -> Option<Downloaded> {
    let mut d = state.downloads.lock().ok()?;
    if d.finished > before {
        d.ready.take()
    } else {
        None
    }
}

enum Try {
    File(Downloaded),
    Login,
    Nothing,
}

fn try_download(app: &AppHandle, w: &WebviewWindow, target: Url) -> Result<Try, String> {
    let state = app.state::<M365State>();
    let before = arm(&state);
    w.navigate(target).map_err(|e| e.to_string())?;
    let started = Instant::now();
    let mut login_since: Option<Instant> = None;
    while started.elapsed() < WAIT {
        std::thread::sleep(Duration::from_millis(250));
        if let Some(file) = arrived(&state, before) {
            return Ok(Try::File(file));
        }
        let login = w.url().map(|u| on_login_page(&u)).unwrap_or(false);
        login_since = if login { Some(login_since.unwrap_or_else(Instant::now)) } else { None };
        if login_since.is_some_and(|t| t.elapsed() > LOGIN_GRACE) {
            return Ok(Try::Login);
        }
    }
    Ok(Try::Nothing)
}

/// 直接下載不到時：在隱藏的視窗用網頁版開啟，等網址變成檢視頁，再由它推出下載網址
fn via_viewer(app: &AppHandle, w: &WebviewWindow, entry: &Url, report: &mut Vec<String>) -> Result<Try, String> {
    let state = app.state::<M365State>();
    let before = arm(&state);
    w.navigate(view_url(entry)).map_err(|e| e.to_string())?;
    let started = Instant::now();
    let mut still_since = Instant::now();
    let mut last = String::new();
    while started.elapsed() < WAIT {
        std::thread::sleep(Duration::from_millis(250));
        if let Some(file) = arrived(&state, before) {
            return Ok(Try::File(file));
        }
        let Ok(current) = w.url() else { continue };
        if current.as_str() != last {
            last = current.as_str().to_string();
            still_since = Instant::now();
            continue;
        }
        if on_login_page(&current) {
            if still_since.elapsed() > LOGIN_GRACE {
                report.push("viewer: login".to_string());
                return Ok(Try::Login);
            }
            continue;
        }
        // 網址已經帶有文件編號就夠了；否則等頁面停住一陣子
        let ready = query(&current, "sourcedoc").is_some() && still_since.elapsed() > Duration::from_millis(1500);
        if current.scheme() != "about" && (ready || still_since.elapsed() > SETTLE) {
            break;
        }
    }
    let Ok(current) = w.url() else { return Ok(Try::Nothing) };
    report.push(format!("viewer: {}", describe(&current)));
    for (name, target) in candidates(&current, entry) {
        if target == with_download_flag(entry) {
            continue; // 直接下載已經試過了
        }
        match try_download(app, w, target.clone())? {
            Try::File(file) => {
                remember(&state, entry, &target);
                report.push(format!("{name}: OK"));
                return Ok(Try::File(file));
            }
            Try::Login => return Ok(Try::Login),
            Try::Nothing => report.push(format!("{name}: no file")),
        }
    }
    Ok(Try::Nothing)
}

/// 顯示視窗，等使用者登入（登入後通常會自己接著下載），或自己按「下載複本」
fn wait_for_user(app: &AppHandle, w: &WebviewWindow, entry: &Url, need_login: bool, report: &mut Vec<String>) -> Result<(&'static str, Option<Downloaded>), String> {
    let state = app.state::<M365State>();
    let mut before = arm(&state);
    if !need_login {
        w.navigate(view_url(entry)).map_err(|e| e.to_string())?;
    }
    w.show().and_then(|()| w.set_focus()).map_err(|e| e.to_string())?;
    let started = Instant::now();
    let mut was_login = need_login;
    let mut still_since = Instant::now();
    let mut last = String::new();
    // 登入完（或檢視頁載入完）自動推下載網址只做一輪，推不出來就留給使用者自己下載
    let mut pushed = false;
    while started.elapsed() < USER_WAIT {
        std::thread::sleep(Duration::from_millis(300));
        if app.get_webview_window(LABEL).is_none() {
            return Ok(("cancelled", None));
        }
        if let Some(file) = arrived(&state, before) {
            // 使用者在檢視頁自己按下載的，之後沒辦法自動更新
            return Ok((if was_login { "ok" } else { "manual" }, Some(file)));
        }
        let Ok(current) = w.url() else { continue };
        if current.as_str() != last {
            last = current.as_str().to_string();
            still_since = Instant::now();
        }
        if on_login_page(&current) {
            was_login = true;
            pushed = false;
            continue;
        }
        if !pushed && current.scheme() == "https" && still_since.elapsed() > SETTLE {
            pushed = true;
            was_login = false;
            report.push(format!("page: {}", describe(&current)));
            for (name, target) in candidates(&current, entry) {
                match try_download(app, w, target.clone())? {
                    Try::File(file) => {
                        remember(&state, entry, &target);
                        report.push(format!("{name}: OK"));
                        return Ok(("ok", Some(file)));
                    }
                    Try::Login => break,
                    Try::Nothing => report.push(format!("{name}: no file")),
                }
            }
            if is_short_link(entry) {
                return Ok(("failed", None));
            }
            // 都推不出來：回到檢視頁，讓使用者自己按「下載複本」
            w.navigate(view_url(entry)).map_err(|e| e.to_string())?;
            before = arm(&state);
            still_since = Instant::now();
        }
    }
    Ok(("cancelled", None))
}

/// 只留最近兩份下載檔
fn keep(state: &M365State, path: PathBuf) {
    if let Ok(mut kept) = state.kept.lock() {
        kept.push(path);
        while kept.len() > 2 {
            let _ = std::fs::remove_file(kept.remove(0));
        }
    }
}

fn finish(state: &M365State, status: &'static str, file: Option<Downloaded>, report: Vec<String>) -> Synced {
    let (file, name) = match file {
        Some(f) => {
            keep(state, f.path.clone());
            (f.path.to_string_lossy().into_owned(), f.name)
        }
        None => (String::new(), String::new()),
    };
    Synced { status, file, name, report }
}

fn remember(state: &M365State, entry: &Url, target: &Url) {
    if let Ok(mut known) = state.known.lock() {
        known.insert(entry.as_str().to_string(), target.clone());
    }
}

fn run_sync(app: &AppHandle, entry: &Url, interactive: bool, title: &str) -> Result<Synced, String> {
    let state = app.state::<M365State>();
    let w = window(app, title)?;
    let mut report = vec![format!("entry: {}", describe(entry))];

    let mut targets = candidates(entry, entry);
    if let Some(url) = state.known.lock().ok().and_then(|m| m.get(entry.as_str()).cloned()) {
        targets.retain(|(_, t)| *t != url);
        targets.insert(0, ("last-ok", url));
    }
    let mut need_login = false;
    for (name, target) in targets {
        match try_download(app, &w, target.clone())? {
            Try::File(file) => {
                remember(&state, entry, &target);
                report.push(format!("{name}: OK"));
                let _ = w.hide();
                return Ok(finish(&state, "ok", Some(file), report));
            }
            Try::Login => {
                let at = w.url().map(|u| describe(&u)).unwrap_or_default();
                report.push(format!("{name}: login ({at})"));
                need_login = true;
                break;
            }
            Try::Nothing => report.push(format!("{name}: no file")),
        }
    }
    if !need_login && !is_short_link(entry) {
        match via_viewer(app, &w, entry, &mut report)? {
            Try::File(file) => {
                let _ = w.hide();
                let _ = w.navigate(blank());
                return Ok(finish(&state, "ok", Some(file), report));
            }
            Try::Login => need_login = true,
            Try::Nothing => {}
        }
    }
    if !interactive {
        let _ = w.navigate(blank());
        return Ok(finish(&state, if need_login { "login" } else { "failed" }, None, report));
    }
    // 短網址不需要登入卻下載不到：沒有可以安全顯示的頁面，直接回報失敗
    if is_short_link(entry) && !need_login {
        let _ = w.navigate(blank());
        return Ok(finish(&state, "failed", None, report));
    }
    let (status, file) = wait_for_user(app, &w, entry, need_login, &mut report)?;
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.hide();
        // 離開 Excel 頁面，不要在背景一直開著它
        let _ = w.navigate(blank());
    }
    Ok(finish(&state, status, file, report))
}

/// 下載雲端上目前的檔案。interactive 為 true 時，需要登入會把視窗跳出來；背景定時更新用 false。
/// 建立視窗的命令必須是 async，否則在 Windows 上會卡死。
#[tauri::command]
pub async fn m365_sync(app: AppHandle, url: String, interactive: bool, title: String) -> Result<Synced, String> {
    let entry = parse_entry(&url)?;
    if app.state::<M365State>().busy.swap(true, Ordering::SeqCst) {
        return Ok(Synced { status: "busy", file: String::new(), name: String::new(), report: vec![] });
    }
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || run_sync(&handle, &entry, interactive, &title)).await;
    app.state::<M365State>().busy.store(false, Ordering::SeqCst);
    result.map_err(|e| e.to_string())?
}

/// 清掉登入狀態（cookie、快取）與下載過的檔案，關閉登入視窗
#[tauri::command]
pub async fn m365_logout(app: AppHandle, title: String) -> Result<(), String> {
    let w = window(&app, &title)?;
    w.clear_all_browsing_data().map_err(|e| e.to_string())?;
    cleanup(&app, false);
    tauri::async_runtime::spawn_blocking(move || {
        // 清除是非同步進行的，稍等再關視窗
        std::thread::sleep(Duration::from_millis(1500));
        w.destroy().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn only_microsoft_drive_urls_are_accepted() {
        for ok in ["https://contoso.sharepoint.com/:x:/s/team/Abc?e=1", "https://contoso-my.sharepoint.com/personal/a/Doc.aspx", "https://onedrive.live.com/edit.aspx?resid=1", " https://1drv.ms/x/s!abc "] {
            assert!(parse_entry(ok).is_ok(), "{ok}");
        }
        for bad in ["http://contoso.sharepoint.com/a", "https://sharepoint.com.evil.example/a", "https://evil.example/contoso.sharepoint.com", "file:///C:/a.xlsx", "javascript:alert(1)", "https://login.live.com/", ""] {
            assert!(parse_entry(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn viewer_page_becomes_download_aspx() {
        let current = u("https://contoso.sharepoint.com/sites/team/_layouts/15/Doc.aspx?sourcedoc=%7B1A2B-3C%7D&file=secret.xlsx&action=default");
        let entry = u("https://contoso.sharepoint.com/:x:/s/team/Abc?e=xyz");
        let c = candidates(&current, &entry);
        assert_eq!(c[0].1.as_str(), "https://contoso.sharepoint.com/sites/team/_layouts/15/download.aspx?UniqueId=1A2B-3C");
        assert_eq!(c[1].1.as_str(), "https://contoso.sharepoint.com/sites/team/_layouts/15/download.aspx?share=Abc");
    }

    #[test]
    fn personal_onedrive_uses_resid() {
        let current = u("https://onedrive.live.com/edit.aspx?resid=AB!12&authkey=k1");
        let c = candidates(&current, &current);
        assert_eq!(c[0].0, "onedrive-download");
        assert_eq!(query(&c[0].1, "resid").as_deref(), Some("AB!12"));
        assert_eq!(query(&c[0].1, "authkey").as_deref(), Some("k1"));
    }

    #[test]
    fn excel_pages_are_shown_in_view_mode() {
        let edit = u("https://contoso.sharepoint.com/:x:/r/sites/t/_layouts/15/doc2.aspx?sourcedoc=%7Babc%7D&file=a.xlsx&action=default&mobileredirect=true");
        let v = view_url(&edit);
        assert_eq!(query(&v, "action").as_deref(), Some("view"));
        assert_eq!(query(&v, "mobileredirect"), None);
        assert_eq!(query(&v, "file").as_deref(), Some("a.xlsx"));
        let other = u("https://contoso.sharepoint.com/Shared%20Documents/a.xlsx");
        assert_eq!(view_url(&other).as_str(), "https://contoso.sharepoint.com/Shared%20Documents/a.xlsx?web=1");
        let short = view_url(&u("https://contoso.sharepoint.com/:x:/s/team/Abc?e=xyz"));
        assert_eq!(query(&short, "web").as_deref(), Some("1"));
        assert_eq!(query(&short, "action").as_deref(), Some("view"));
        assert_eq!(query(&short, "e").as_deref(), Some("xyz"));
    }

    #[test]
    fn the_sign_in_window_cannot_launch_other_programs() {
        assert!(web_navigation_only(&u("https://contoso.sharepoint.com/a")));
        assert!(web_navigation_only(&u("about:blank")));
        for bad in ["ms-excel:ofv|u|https://contoso.sharepoint.com/a.xlsx", "ms-word:ofe|u|x", "file:///C:/a.xlsx", "odopen://sync"] {
            assert!(!web_navigation_only(&u(bad)), "{bad}");
        }
    }

    #[test]
    fn login_pages_are_recognised() {
        assert!(on_login_page(&u("https://login.microsoftonline.com/x/oauth2/authorize")));
        assert!(on_login_page(&u("https://contoso.sharepoint.com/_forms/default.aspx")));
        assert!(!on_login_page(&u("https://contoso.sharepoint.com/sites/t/_layouts/15/download.aspx?UniqueId=1")));
    }

    #[test]
    fn short_links_are_turned_into_download_urls_without_opening_them() {
        let e = u("https://contoso.sharepoint.com/:x:/s/team/EeaE-Yh_9?e=abc");
        assert!(is_short_link(&e));
        let c = candidates(&e, &e);
        assert_eq!(c[0].1.as_str(), "https://contoso.sharepoint.com/sites/team/_layouts/15/download.aspx?share=EeaE-Yh_9");
        assert_eq!(c[1].0, "shares-api");
        assert!(c[1].1.path().starts_with("/_api/v2.0/shares/u!") && c[1].1.path().ends_with("/driveItem/content"));
        assert!(c.iter().all(|(_, t)| !t.path().starts_with("/:x:")), "不可以再去開短網址本身");
        let personal = u("https://contoso-my.sharepoint.com/:x:/g/personal/a_contoso_com/Tok?e=1");
        assert_eq!(candidates(&personal, &personal)[0].1.path(), "/personal/a_contoso_com/_layouts/15/download.aspx");
        let teams = u("https://contoso.sharepoint.com/:x:/t/ops/Tok");
        assert_eq!(candidates(&teams, &teams)[0].1.path(), "/teams/ops/_layouts/15/download.aspx");
        // 網址列的網址不是短網址
        assert!(!is_short_link(&u("https://contoso.sharepoint.com/:x:/r/sites/t/_layouts/15/doc2.aspx?sourcedoc=%7Babc%7D")));
        assert!(!is_short_link(&u("https://contoso.sharepoint.com/Shared%20Documents/a.xlsx")));
    }

    #[test]
    fn report_never_contains_names_or_values() {
        let d = describe(&u("https://acme-my.sharepoint.com/personal/john_acme/_layouts/15/Doc.aspx?sourcedoc=%7Babc%7D&file=%E5%87%BA%E8%B2%A8.xlsx"));
        assert_eq!(d, "sharepoint-my | personal | Doc.aspx | sourcedoc,file");
    }
}
