//! 其他印表機語言（ZPL、EPL2、CPCL、DPL、SBPL）：把已渲染好的 1-bit 點陣包成各語言的「列印圖形」指令。
//!
//! **全部為實驗性質：沒有任何一台實機驗證過。** 指令格式依各廠公開的程式設計手冊撰寫
//! （ZPL `^GF`、EPL2 `GW`、CPCL `CG`、DPL 7 位元 ASCII 圖檔 + `1Y` 記錄、SBPL `ESC G`）。
//! 這些語言只送點陣，不使用原生條碼指令（條碼與 QR 由前端畫成點陣）。
//! 解析度一律假設 203 dpi（8 dots/mm）。
//!
//! 點陣約定：每列 byte 打包、高位元在前、1 = 黑點（與前端送來的相同）。

use crate::tspl::{NativeCode, PrintJob};

/// 支援的列印語言代碼（前端選單的值）。
#[allow(dead_code)]
pub const LANGUAGES: &[&str] = &["tspl", "zpl", "epl", "cpcl", "dpl", "sbpl"];

/// 依驅動程式名稱與印表機名稱猜印表機語言；猜不出來回傳 None（前端會退回 TSPL 並讓使用者自選）。
/// 只是名稱比對，不是查詢印表機本身：廠牌名稱以外的機型（例如改名過的印表機）可能猜不到或猜錯，所以前端永遠允許手動覆蓋。
pub fn detect(driver: &str, printer: &str) -> Option<&'static str> {
    let s = format!("{driver} {printer}").to_lowercase();
    let has = |k: &str| s.contains(k);
    // 驅動名稱明確寫了語言的優先（整個單字相符，避免 "deployed" 之類誤判）
    let words: Vec<&str> = s.split(|c: char| !c.is_alphanumeric()).collect();
    for l in ["cpcl", "tspl", "zpl", "epl", "sbpl", "dpl"] {
        if words.contains(&l) { return Some(l); }
    }
    // 以廠牌判斷
    if has("tsc") || has("ttp-") || has("tdp-") || has("te200") || has("te300") || has("te210") || has("te310") { return Some("tspl"); }
    if has("datamax") { return Some("dpl"); }
    if has("sato") { return Some("sbpl"); }
    // Zebra：舊的桌上型（LP/TLP 28xx、LP 2824…）是 EPL，其餘多半是 ZPL；行動式（ZQ、iMZ、QLn、ZR）是 CPCL／ZPL 皆可，不猜
    if has("zdesigner") || has("zebra") {
        if has("lp 28") || has("tlp 28") || has("lp2844") || has("tlp2844") || has("lp 2824") || has("lp2824") { return Some("epl"); }
        if has("zq") || has("imz") || has("qln") || has("zr") { return None; }
        return Some("zpl");
    }
    // 常見的「不是標籤機」：虛擬印表機（PDF、XPS、OneNote、傳真）與一般事務機廠牌／型號。
    // 回傳 "office"，前端會把列印與預覽改成 A4／貼紙紙排版模式。名稱裡有 label／ql-（Brother 標籤機）的不算。
    if !has("label") && !has("ql-") {
        const OFFICE: &[&str] = &[
            "print to pdf", "pdf", "xps", "onenote", "fax", "laserjet", "officejet", "deskjet", "photosmart", "mfp",
            "ricoh", "kyocera", "xerox", "lexmark", "konica", "minolta", "canon", "brother", "samsung", "remote desktop easy print",
        ];
        if OFFICE.iter().any(|k| has(k)) {
            return Some("office");
        }
    }
    None
}

const DOTS_PER_MM: f32 = 8.0;

// ---------- 原生條碼／QR 指令（選用；實驗性質）----------
// 條碼類型沿用 TSPL 的名稱（128、39、EAN13、EAN8、UPCA、ITF14、CODA），各語言再對應成自己的指令。
// 規格出處：ZPL（Zebra 公開慣例）、EPL2／CPCL／DPL／SBPL 依各廠程式設計手冊；全部尚未在實機驗證。

fn ascii(content: &str) -> Result<String, String> {
    if content.is_empty() || !content.chars().all(|c| (' '..='~').contains(&c)) {
        return Err(format!("原生條碼內容只能是半形英數與符號：{content}"));
    }
    Ok(content.to_string())
}

fn at(v: i32, d: u32) -> u32 {
    (v.max(0) as u32).saturating_add(d)
}

/// EAN／UPC 只送資料位數（印表機自己補檢查碼，避免檢查碼重複或不符）
fn base_digits(code: &str, content: &str) -> String {
    let n = match code {
        "EAN13" => 12,
        "EAN8" => 7,
        "UPCA" => 11,
        _ => return content.to_string(),
    };
    content.chars().take(n).collect()
}

fn ecc_ok(ecc: &str) -> Result<(), String> {
    if matches!(ecc, "L" | "M" | "Q" | "H") { Ok(()) } else { Err(format!("不支援的 QR 容錯等級：{ecc}")) }
}

fn zpl_escape(s: &str) -> String {
    s.replace('_', "_5F").replace('^', "_5E").replace('~', "_7E")
}

/// ZPL：`^BY` 設定窄條寬與比例，接各條碼指令；QR 用 `^BQ`，資料以「容錯等級 + A（自動）+ 逗號」開頭。
fn zpl_native(n: &NativeCode, dx: u32, dy: u32) -> Result<String, String> {
    match n {
        NativeCode::Barcode { x, y, code, height, readable, narrow, wide, content, .. } => {
            let data = base_digits(code, &ascii(content)?);
            let w = (*narrow).clamp(1, 10);
            let ratio = (*wide as f32 / w as f32).clamp(2.0, 3.0);
            let h = (*height).max(1);
            let r = if *readable { "Y" } else { "N" };
            let sym = match code.as_str() {
                "128" | "128M" | "EAN128" => format!("^BCN,{h},{r},N,N,A"),
                "39" => format!("^B3N,N,{h},{r},N"),
                "EAN13" => format!("^BEN,{h},{r},N"),
                "EAN8" => format!("^B8N,{h},{r},N"),
                "UPCA" => format!("^BUN,{h},{r},N,Y"),
                "ITF14" | "25" => format!("^B2N,{h},{r},N,N"),
                "CODA" => format!("^BKN,N,{h},{r},N"),
                other => return Err(format!("ZPL 不支援的原生條碼類型：{other}")),
            };
            Ok(format!("^FO{},{}^BY{w},{ratio:.1},{h}{sym}^FH_^FD{}^FS\r\n", at(*x, dx), at(*y, dy), zpl_escape(&data)))
        }
        NativeCode::Qr { x, y, ecc, cell, content, .. } => {
            ecc_ok(ecc)?;
            Ok(format!("^FO{},{}^BQN,2,{}^FH_^FD{ecc}A,{}^FS\r\n", at(*x, dx), at(*y, dy), (*cell).clamp(1, 10), zpl_escape(&ascii(content)?)))
        }
    }
}

/// EPL2：`B` 指令（手冊 p.3-11）。EPL2 手冊沒有 QR 指令，QR 一律不支援（前端會改用點陣）。
fn epl_native(n: &NativeCode, dx: u32, dy: u32) -> Result<String, String> {
    match n {
        NativeCode::Barcode { x, y, code, height, readable, narrow, wide, content, .. } => {
            let data = base_digits(code, &ascii(content)?);
            let (t, eanlike) = match code.as_str() {
                "128" | "128M" | "EAN128" => ("1", false),
                "39" => ("3", false),
                "EAN13" => ("E30", true),
                "EAN8" => ("E80", true),
                "UPCA" => ("UA0", true),
                "ITF14" | "25" => ("2", false),
                "CODA" => ("K", false),
                other => return Err(format!("EPL2 不支援的原生條碼類型：{other}")),
            };
            // EAN／UPC 的窄條寬只接受 2–4；其他 1–10；寬條寬 2–30
            let nw = if eanlike { (*narrow).clamp(2, 4) } else { (*narrow).clamp(1, 10) };
            let ww = (*wide).clamp(2, 30).max(nw);
            let esc = data.replace('\\', "\\\\").replace('"', "\\\"");
            Ok(format!("B{},{},0,{t},{nw},{ww},{},{},\"{esc}\"\r\n", at(*x, dx), at(*y, dy), (*height).max(1), if *readable { "B" } else { "N" }))
        }
        NativeCode::Qr { .. } => Err("EPL2 沒有 QR Code 的原生指令".into()),
    }
}

fn cpcl_ratio(narrow: u32, wide: u32) -> u32 {
    let r = wide as f32 / narrow.max(1) as f32;
    if r < 1.75 { 0 } else if r < 2.25 { 1 } else if r < 2.75 { 2 } else if r < 3.25 { 3 } else { 4 }
}

/// CPCL：`BARCODE 類型 窄條寬 比例 高 X Y 資料`（手冊 6.2）；QR 用 `BARCODE QR X Y M 2 U 格寬` + `設定,資料` + `ENDQR`。
/// 人眼可讀文字用 `BARCODE-TEXT` 開關。
fn cpcl_native(n: &NativeCode, dx: u32, dy: u32) -> Result<String, String> {
    match n {
        NativeCode::Barcode { x, y, code, height, readable, narrow, wide, content, .. } => {
            let data = base_digits(code, &ascii(content)?);
            let t = match code.as_str() {
                "128" | "128M" | "EAN128" => "128",
                "39" => "39",
                "EAN13" => "EAN13",
                "EAN8" => "EAN8",
                "UPCA" => "UPCA",
                "ITF14" | "25" => "I2OF5",
                "CODA" => "CODABAR",
                other => return Err(format!("CPCL 不支援的原生條碼類型：{other}")),
            };
            let mut s = String::new();
            if *readable {
                s.push_str("BARCODE-TEXT 7 0 5\r\n");
            }
            s.push_str(&format!("BARCODE {t} {} {} {} {} {} {data}\r\n", (*narrow).max(1), cpcl_ratio(*narrow, *wide), (*height).max(1), at(*x, dx), at(*y, dy)));
            if *readable {
                s.push_str("BARCODE-TEXT OFF\r\n");
            }
            Ok(s)
        }
        NativeCode::Qr { x, y, ecc, cell, content, .. } => {
            ecc_ok(ecc)?;
            Ok(format!("BARCODE QR {} {} M 2 U {}\r\n{ecc}A,{}\r\nENDQR\r\n", at(*x, dx), at(*y, dy), (*cell).clamp(1, 32), ascii(content)?))
        }
    }
}

/// DPL 的尺寸字元：1–9 與 A–O（A＝10 … O＝24）
fn dpl_digit(n: u32) -> char {
    let n = n.clamp(1, 24);
    if n <= 9 { (b'0' + n as u8) as char } else { (b'A' + (n - 10) as u8) as char }
}

/// DPL 的位置：公制（1/10 mm），原點在標籤左下角。top／h 是符號左上角與總高度（dots）。
fn dpl_row(paper_h_mm: f32, top: u32, h: u32) -> u32 {
    let bottom = (paper_h_mm * DOTS_PER_MM) as i64 - i64::from(top) - i64::from(h);
    (bottom.max(0) as f32 / DOTS_PER_MM * 10.0).round() as u32
}

fn dpl_col(left: u32) -> u32 {
    (left as f32 / DOTS_PER_MM * 10.0).round() as u32
}

/// DPL：條碼記錄 `1{類型}{寬}{窄}{高}{列}{行}{資料}`（英文字母大寫＝含人眼可讀文字、小寫＝不含），以 CR 結尾；
/// QR 用自動格式 `1W1d`（Model 2、容錯等級固定 M），資料以兩個 CR 結尾。
fn dpl_native(n: &NativeCode, dx: u32, dy: u32, paper_h_mm: f32) -> Result<String, String> {
    match n {
        NativeCode::Barcode { x, y, code, height, readable, narrow, wide, content, h } => {
            let data = base_digits(code, &ascii(content)?);
            let letter = match code.as_str() {
                "128" | "128M" | "EAN128" => 'E',
                "39" => 'A',
                "EAN13" => 'F',
                "EAN8" => 'G',
                "UPCA" => 'B',
                "ITF14" | "25" => 'D',
                "CODA" => 'I',
                other => return Err(format!("DPL 不支援的原生條碼類型：{other}")),
            };
            let letter = if *readable { letter } else { letter.to_ascii_lowercase() };
            let top = at(*y, dy);
            let total = if *h > 0 { *h } else { *height + if *readable { 24 } else { 0 } };
            let eee = ((*height as f32 / DOTS_PER_MM * 10.0).round() as u32).clamp(1, 999);
            Ok(format!("1{letter}{}{}{eee:03}{:04}{:04}{data}\r", dpl_digit((*wide).max(*narrow)), dpl_digit(*narrow), dpl_row(paper_h_mm, top, total), dpl_col(at(*x, dx))))
        }
        NativeCode::Qr { x, y, ecc: _, cell, content, h } => {
            let c = dpl_digit(((*cell as f32) * 1.25).round() as u32);
            let top = at(*y, dy);
            let total = if *h > 0 { *h } else { cell * 29 };
            Ok(format!("1W1d{c}{c}000{:04}{:04}{}\r\r", dpl_row(paper_h_mm, top, total), dpl_col(at(*x, dx)), ascii(content)?))
        }
    }
}

/// SBPL：`ESC D`（窄:寬＝1:2）條碼；EAN／UPC 要人眼可讀文字時用 `ESC BD`（含說明字體）；Code128 用 `ESC BG`。
/// 位置 `ESC V`／`ESC H`（dots，有效範圍從 1 起）。手冊（SBPL Basic Command）沒有 QR 指令 → 不支援。
/// 手冊沒有 Code128／Code39／ITF／Codabar 的人眼可讀文字（要另外用文字指令印）→ 要可讀文字時前端改用點陣。
fn sbpl_native(n: &NativeCode, dx: u32, dy: u32) -> Result<String, String> {
    match n {
        NativeCode::Barcode { x, y, code, height, readable, narrow, content, .. } => {
            let data = base_digits(code, &ascii(content)?);
            let w = (*narrow).clamp(1, 12);
            let h = (*height).clamp(1, 600);
            let ean = matches!(code.as_str(), "EAN13" | "EAN8" | "UPCA");
            if *readable && !ean {
                return Err("SBPL 原生條碼的人眼可讀文字只支援 EAN／UPC".into());
            }
            let body = match code.as_str() {
                "128" | "128M" | "EAN128" => format!("\x1bBG{w:02}{h:03}{data}"),
                "39" => format!("\x1bD1{w:02}{h:03}*{data}*"),
                "CODA" => {
                    let start_stop = |c: Option<char>| c.is_some_and(|c| matches!(c.to_ascii_uppercase(), 'A'..='D'));
                    let d = if start_stop(data.chars().next()) && start_stop(data.chars().last()) { data } else { format!("A{data}A") };
                    format!("\x1bD0{w:02}{h:03}{d}")
                }
                "ITF14" | "25" => format!("\x1bD2{w:02}{h:03}{data}"),
                "EAN13" => format!("\x1b{}3{w:02}{h:03}{data}", if *readable { "BD" } else { "D" }),
                "EAN8" => format!("\x1b{}4{w:02}{h:03}{data}", if *readable { "BD" } else { "D" }),
                "UPCA" => format!("\x1b{}H{w:02}{h:03}{data}", if *readable { "BD" } else { "D" }),
                other => return Err(format!("SBPL 不支援的原生條碼類型：{other}")),
            };
            Ok(format!("\x1bV{:04}\x1bH{:04}{body}", at(*y, dy).max(1), at(*x, dx).max(1)))
        }
        NativeCode::Qr { .. } => Err("SBPL（Basic Command）沒有 QR Code 的原生指令".into()),
    }
}

fn native_block_str(job: &PrintJob, f: impl Fn(&NativeCode) -> Result<String, String>) -> Result<String, String> {
    let mut out = String::new();
    for n in &job.natives {
        out.push_str(&f(n)?);
    }
    Ok(out)
}

/// 把所有原生項目接成一段（各語言自己的結尾符號都已包含在每一項裡）
fn native_block(job: &PrintJob, f: impl Fn(&NativeCode) -> Result<String, String>) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    for n in &job.natives {
        out.extend(f(n)?.into_bytes());
    }
    Ok(out)
}

fn dots(mm: f32) -> u32 {
    (mm.max(0.0) * DOTS_PER_MM).round() as u32
}

fn hex_upper(data: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(data.len() * 2);
    for b in data {
        let _ = write!(s, "{b:02X}");
    }
    s
}

/// ZPL II：`^GFA` 以 ASCII 十六進位傳點陣（1 = 黑）。濃度 0–15 對應 `~SD` 0–30。
pub fn zpl(job: &PrintJob) -> Result<Vec<u8>, String> {
    let wb = job.width_px.div_ceil(8);
    let total = wb * job.height_px;
    let mut s = String::new();
    s.push_str(&format!("~SD{}\r\n", u32::from(job.density.min(15)) * 2));
    s.push_str("^XA\r\n^MNY\r\n^MMT\r\n^PON\r\n^LS0\r\n");
    s.push_str(&format!("^PW{}\r\n^LL{}\r\n", dots(job.paper_w_mm), dots(job.paper_h_mm)));
    s.push_str(&format!("^PR{}\r\n", job.speed.clamp(2, 6)));
    s.push_str(&format!(
        "^FO{},{}^GFA,{total},{total},{wb},{}^FS\r\n",
        job.offset_x_dots, job.offset_y_dots, hex_upper(&job.bitmap)
    ));
    s.push_str(&native_block_str(job, |n| zpl_native(n, job.offset_x_dots, job.offset_y_dots))?);
    s.push_str(&format!("^PQ{},0,1,N\r\n^XZ\r\n", job.copies));
    Ok(s.into_bytes())
}

/// EPL2：`GW` 直接寫入二進位點陣。EPL2 的資料位元 0 = 黑點，所以要反相（與 TSPL 相同）。
pub fn epl(job: &PrintJob) -> Result<Vec<u8>, String> {
    let wb = job.width_px.div_ceil(8);
    let mut out = format!(
        "\r\nN\r\nq{}\r\nQ{},{}\r\nD{}\r\nS{}\r\nZT\r\nGW{},{},{},{},",
        dots(job.paper_w_mm), dots(job.paper_h_mm), dots(job.gap_mm),
        job.density.min(15), job.speed.clamp(1, 6),
        job.offset_x_dots, job.offset_y_dots, wb, job.height_px,
    )
    .into_bytes();
    out.extend(job.bitmap.iter().map(|b| !b));
    out.extend_from_slice(b"\r\n");
    out.extend(native_block(job, |n| epl_native(n, job.offset_x_dots, job.offset_y_dots))?);
    out.extend_from_slice(format!("P{}\r\n", job.copies).as_bytes());
    Ok(out)
}

/// CPCL：`CG` 傳二進位點陣（1 = 黑）。CPCL 只有 100／200 dpi 兩種解析度宣告，這裡用 200。
pub fn cpcl(job: &PrintJob) -> Result<Vec<u8>, String> {
    let wb = job.width_px.div_ceil(8);
    let mut out = format!(
        "! 0 200 200 {} {}\r\nPW {}\r\nCG {} {} {} {} ",
        dots(job.paper_h_mm), job.copies.min(1024), dots(job.paper_w_mm),
        wb, job.height_px, job.offset_x_dots, job.offset_y_dots,
    )
    .into_bytes();
    out.extend_from_slice(&job.bitmap);
    out.extend_from_slice(b"\r\n");
    out.extend(native_block(job, |n| cpcl_native(n, job.offset_x_dots, job.offset_y_dots))?);
    out.extend_from_slice(b"FORM\r\nPRINT\r\n");
    Ok(out)
}

/// DPL（Datamax）：先以「Datamax 7 位元 ASCII 圖檔」下載到模組 A 的 `LBLPRT` 圖，再用 `1Y` 記錄列印。
/// DPL 的原點在標籤左下角，單位用公制（`<STX>m`，1/10 mm）。
/// 圖檔每一列是 `80nn` + 十六進位資料；整列相同時可用重複記錄，這裡每列都直接送出，最簡單也最穩。
/// 資料位元 1 = 黑點的假設與列順序（先送最上面一列）**尚未驗證**。
pub fn dpl(job: &PrintJob) -> Result<Vec<u8>, String> {
    let wb = job.width_px.div_ceil(8) as usize;
    let mut out = Vec::new();
    // SOH D：停用立即指令，之後才能安全傳資料
    out.extend_from_slice(b"\x01D");
    out.extend_from_slice(b"\x02m\r\n");
    out.extend_from_slice(b"\x02IAAFLBLPRT\r\n");
    for row in job.bitmap.chunks(wb) {
        out.extend_from_slice(format!("80{:02X}{}\r\n", wb, hex_upper(row)).as_bytes());
    }
    out.extend_from_slice(b"FFFF\r\n");
    // 標籤格式：左下角為原點，列位置 = 圖的底邊距離標籤底邊
    let tenth_mm = |d: u32| (d as f32 / DOTS_PER_MM * 10.0).round() as u32;
    let img_bottom = (job.paper_h_mm * DOTS_PER_MM) as i64 - i64::from(job.offset_y_dots) - i64::from(job.height_px);
    let row = tenth_mm(img_bottom.max(0) as u32);
    out.extend_from_slice(b"\x02L\r\n");
    out.extend_from_slice(format!("H{:02}\r\n", u32::from(job.density.min(15)) * 30 / 15).as_bytes());
    out.extend_from_slice(format!("1Y11000{:04}{:04}LBLPRT\r\n", row, tenth_mm(job.offset_x_dots)).as_bytes());
    out.extend(native_block(job, |n| dpl_native(n, job.offset_x_dots, job.offset_y_dots, job.paper_h_mm))?);
    out.extend_from_slice(format!("Q{:04}\r\nE\r\n", job.copies.min(9999)).as_bytes());
    Ok(out)
}

/// SBPL（SATO）：`ESC G` 傳十六進位點陣（每 8×8 為一個區塊，寬高都要是 8 的倍數）。
/// 位置用 `ESC H`（橫）／`ESC V`（縱），單位 dots，原點在左上角。
pub fn sbpl(job: &PrintJob) -> Result<Vec<u8>, String> {
    let wb = job.width_px.div_ceil(8) as usize;
    let rows = job.height_px as usize;
    let padded_rows = rows.div_ceil(8) * 8;
    let mut out = Vec::new();
    out.extend_from_slice(b"\x02\x1bA");
    out.extend_from_slice(format!("\x1bH{:04}\x1bV{:04}", job.offset_x_dots.max(1), job.offset_y_dots.max(1)).as_bytes());
    out.extend_from_slice(format!("\x1bGH{:03}{:03}", wb, padded_rows / 8).as_bytes());
    for r in 0..padded_rows {
        if r < rows {
            out.extend_from_slice(hex_upper(&job.bitmap[r * wb..(r + 1) * wb]).as_bytes());
        } else {
            out.extend_from_slice("00".repeat(wb).as_bytes());
        }
    }
    out.extend(native_block(job, |n| sbpl_native(n, job.offset_x_dots, job.offset_y_dots))?);
    out.extend_from_slice(format!("\x1bQ{}\x1bZ\x03", job.copies).as_bytes());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job() -> PrintJob {
        let json = r#"{"paperWmm":62.5,"paperHmm":30,"gapMm":2,"offsetXDots":10,"offsetYDots":4,
            "widthPx":9,"heightPx":2,"bitmap":"/4AAAA==","copies":3,"density":8,"speed":4}"#;
        serde_json::from_str(json).unwrap() // 位元組：FF 80 | 00 00
    }

    #[test]
    fn detects_language_from_driver_or_printer_name() {
        assert_eq!(detect("TSC TTP-244 Pro", "TSC TTP-244 Pro"), Some("tspl"));
        assert_eq!(detect("ZDesigner GK420t", "Zebra GK420t"), Some("zpl"));
        assert_eq!(detect("ZDesigner GK420t (EPL)", "x"), Some("epl"));
        assert_eq!(detect("ZDesigner LP 2844", "x"), Some("epl"));
        assert_eq!(detect("ZDesigner ZT410-203dpi ZPL", "x"), Some("zpl"));
        assert_eq!(detect("Datamax-O'Neil E-4205A", "x"), Some("dpl"));
        assert_eq!(detect("SATO CL4NX 203dpi", "x"), Some("sbpl"));
        assert_eq!(detect("ZDesigner ZQ520", "x"), None);
        assert_eq!(detect("Generic / Text Only", "Label1"), None);
        // 不是標籤機：虛擬印表機與事務機 → "office"（前端改用 A4／貼紙紙排版）
        for (d, p) in [("Microsoft Print To PDF", "Microsoft Print to PDF"), ("Send to Microsoft OneNote 16 Driver", "OneNote (Desktop)"),
                       ("HP Universal Printing PCL 6", "HP LaserJet Pro MFP M428"), ("Canon Generic Plus UFR II", "Canon iR-ADV"),
                       ("Remote Desktop Easy Print", "x (redirected 2)"), ("Brother HL-L2350DW series", "Brother HL-L2350DW"),
                       ("Microsoft XPS Document Writer v4", "Microsoft XPS Document Writer")] {
            assert_eq!(detect(d, p), Some("office"), "{d} / {p}");
        }
        // 標籤機優先，不會被當成事務機；Brother 的標籤機（QL）不算事務機
        assert_eq!(detect("TSC TTP-244 Pro", "Brother-sounding TSC"), Some("tspl"));
        assert_eq!(detect("Brother QL-820NWB", "x"), None);
        assert_eq!(detect("Datamax-O'Neil E-4205A", "HP shared"), Some("dpl"));
    }


    fn nj(lang: &str, natives: Vec<NativeCode>) -> PrintJob {
        let mut j = job();
        j.lang = lang.into();
        j.natives = natives;
        j
    }

    fn bc(code: &str, content: &str, readable: bool) -> NativeCode {
        NativeCode::Barcode { x: 20, y: 30, code: code.into(), height: 80, readable, narrow: 2, wide: 4, content: content.into(), h: 0 }
    }

    fn qr(ecc: &str) -> NativeCode {
        NativeCode::Qr { x: 5, y: 6, ecc: ecc.into(), cell: 3, content: "https://example.com/a".into(), h: 0 }
    }

    fn text(out: Vec<u8>) -> String {
        String::from_utf8_lossy(&out).into_owned()
    }

    #[test]
    fn zpl_native_barcodes_and_qr() {
        // job() 的位移：offset_x 10、offset_y 4
        let s = text(crate::tspl::build(&nj("zpl", vec![bc("128", "SN-0001", true), bc("EAN13", "4006381333931", false), bc("39", "AB_1", false), qr("Q")])).unwrap());
        assert!(s.contains("^FO30,34^BY2,2.0,80^BCN,80,Y,N,N,A^FH_^FDSN-0001^FS\r\n"), "{s}");
        assert!(s.contains("^FO30,34^BY2,2.0,80^BEN,80,N,N^FH_^FD400638133393^FS\r\n"), "EAN13 只送 12 位，檢查碼由印表機算：{s}");
        assert!(s.contains("^B3N,N,80,N,N^FH_^FDAB_5F1^FS"), "底線要跳脫：{s}");
        assert!(s.contains("^FO15,10^BQN,2,3^FH_^FDQA,https://example.com/a^FS\r\n"), "{s}");
        assert!(s.find("^GFA").unwrap() < s.find("^BCN").unwrap() && s.find("^BQN").unwrap() < s.find("^PQ").unwrap());
    }

    #[test]
    fn epl_native_barcodes_and_no_qr() {
        let s = text(crate::tspl::build(&nj("epl", vec![bc("128", "SN-0001", true), bc("EAN13", "4006381333931", false), bc("CODA", "A123B", false)])).unwrap());
        assert!(s.contains("\r\nB30,34,0,1,2,4,80,B,\"SN-0001\"\r\n"), "{s:?}");
        assert!(s.contains("B30,34,0,E30,2,4,80,N,\"400638133393\"\r\n"), "{s:?}");
        assert!(s.contains("B30,34,0,K,2,4,80,N,\"A123B\"\r\n"), "{s:?}");
        assert!(s.ends_with("P3\r\n"), "{s:?}");
        assert!(crate::tspl::build(&nj("epl", vec![qr("M")])).unwrap_err().contains("QR"));
        // 引號與反斜線要跳脫
        assert!(epl_native(&bc("39", "A\"B\\C", false), 0, 0).unwrap().contains("\"A\\\"B\\\\C\""));
    }

    #[test]
    fn cpcl_native_barcodes_and_qr() {
        let out = crate::tspl::build(&nj("cpcl", vec![bc("128", "SN-0001", true), bc("ITF14", "12345678901231", false), qr("H")])).unwrap();
        let s = text(out);
        assert!(s.contains("BARCODE-TEXT 7 0 5\r\nBARCODE 128 2 1 80 30 34 SN-0001\r\nBARCODE-TEXT OFF\r\n"), "{s:?}");
        assert!(s.contains("BARCODE I2OF5 2 1 80 30 34 12345678901231\r\n"), "{s:?}");
        assert!(s.contains("BARCODE QR 15 10 M 2 U 3\r\nHA,https://example.com/a\r\nENDQR\r\n"), "{s:?}");
        assert!(s.find("CG ").unwrap() < s.find("BARCODE 128").unwrap() && s.find("ENDQR").unwrap() < s.find("FORM").unwrap());
        assert_eq!((cpcl_ratio(2, 4), cpcl_ratio(2, 3), cpcl_ratio(2, 5), cpcl_ratio(2, 6), cpcl_ratio(2, 7)), (1, 0, 2, 3, 4));
    }

    #[test]
    fn dpl_native_barcodes_and_qr() {
        // 標籤高 30 mm；條碼左上角 (20+10, 30+4) dots、整體高 80 → 底邊離標籤底 240-34-80=126 dots = 157.5 → 158（1/10 mm）；左 30 dots = 37.5 → 38
        let s = text(crate::tspl::build(&nj("dpl", vec![bc("128", "SN-0001", false), bc("39", "AB12", true), qr("M")])).unwrap());
        // 記錄 = 1 + 類型 + 寬 + 窄 + 高(3 位，1/10mm) + 列(4 位) + 行(4 位) + 資料；寬 4 窄 2；高 80 dots = 100
        assert!(s.contains("\n1e4210001580038SN-0001\r"), "{s:?}");
        // 要可讀文字：大寫類型字母，整體高多 24 dots → 底邊多 3 mm 往上：列變小
        assert!(s.contains("\r1A4210001280038AB12\r"), "{s:?}");
        assert!(s.contains("1W1d44000") && s.contains("https://example.com/a\r\r"), "{s:?}");
        assert!(s.find("1Y11000").unwrap() < s.find("1e4210").unwrap() && s.find("1W1d").unwrap() < s.find("Q0003").unwrap());
        assert_eq!((dpl_digit(1), dpl_digit(9), dpl_digit(10), dpl_digit(24), dpl_digit(99)), ('1', '9', 'A', 'O', 'O'));
    }

    #[test]
    fn sbpl_native_barcodes_follow_the_manual() {
        let s = text(crate::tspl::build(&nj("sbpl", vec![bc("128", "123456", false), bc("39", "AB12", false), bc("EAN13", "4006381333931", true), bc("EAN8", "96385074", false), bc("CODA", "12345", false)])).unwrap());
        // ESC V 縱、ESC H 橫（dots，4 位）；Code128＝ESC BG 窄條 2 位 高 3 位
        assert!(s.contains("\u{1b}V0034\u{1b}H0030\u{1b}BG02080123456"), "{s:?}");
        assert!(s.contains("\u{1b}D10208" ) || s.contains("\u{1b}D1020"), "{s:?}");
        assert!(s.contains("*AB12*"), "Code39 要加 * 起訖：{s:?}");
        assert!(s.contains("\u{1b}BD302080400638133393"), "EAN13 要可讀文字用 ESC BD，只送 12 位：{s:?}");
        assert!(s.contains("\u{1b}D40208" ) && s.contains("9638507"), "{s:?}");
        assert!(s.contains("\u{1b}D002080A12345A"), "Codabar 沒有起訖字元時補 A：{s:?}");
        assert!(s.ends_with("\u{1b}Q3\u{1b}Z\u{3}"));
        assert!(crate::tspl::build(&nj("sbpl", vec![qr("M")])).unwrap_err().contains("QR"));
        // 手冊沒有 Code128 等的可讀文字指令 → 不替使用者悄悄略過
        assert!(crate::tspl::build(&nj("sbpl", vec![bc("128", "123", true)])).is_err());
    }

    #[test]
    fn sbpl_positions_start_at_one() {
        // 手冊：ESC H／ESC V 的有效範圍從 1 起，0 會是無效值
        let mut j = job();
        j.lang = "sbpl".into();
        j.offset_x_dots = 0;
        j.offset_y_dots = 0;
        let s = text(crate::tspl::build(&j).unwrap());
        assert!(s.contains("\u{1b}H0001\u{1b}V0001"), "{s:?}");
    }

    #[test]
    fn native_content_is_validated_for_every_language() {
        for lang in ["zpl", "epl", "cpcl", "dpl", "sbpl"] {
            assert!(crate::tspl::build(&nj(lang, vec![bc("128", "中文", false)])).is_err(), "{lang}: 非 ASCII");
            assert!(crate::tspl::build(&nj(lang, vec![bc("128", "", false)])).is_err(), "{lang}: 空內容");
            assert!(crate::tspl::build(&nj(lang, vec![bc("NOPE", "A", false)])).is_err(), "{lang}: 未知類型");
        }
        assert!(crate::tspl::build(&nj("zpl", vec![qr("X")])).is_err(), "未知容錯等級");
    }

    #[test]
    fn zpl_uses_gfa_with_uppercase_hex_and_no_inversion() {
        let s = String::from_utf8(zpl(&job()).unwrap()).unwrap();
        assert!(s.contains("^PW500\r\n^LL240\r\n"), "{s}");
        assert!(s.contains("^FO10,4^GFA,4,4,2,FF800000^FS"), "{s}");
        assert!(s.contains("~SD16\r\n") && s.contains("^PR4\r\n"), "{s}");
        assert!(s.ends_with("^PQ3,0,1,N\r\n^XZ\r\n"), "{s}");
    }

    #[test]
    fn epl_inverts_bitmap_and_sets_size() {
        let out = epl(&job()).unwrap();
        let s = String::from_utf8_lossy(&out).into_owned();
        assert!(s.contains("N\r\nq500\r\nQ240,16\r\nD8\r\nS4\r\nZT\r\nGW10,4,2,2,"), "{s:?}");
        assert!(out.windows(4).any(|w| w == [0x00, 0x7F, 0xFF, 0xFF]));
        assert!(s.ends_with("\r\nP3\r\n"));
    }

    #[test]
    fn cpcl_header_and_cg() {
        let out = cpcl(&job()).unwrap();
        assert!(out.starts_with(b"! 0 200 200 240 3\r\nPW 500\r\nCG 2 2 10 4 "));
        assert!(out.ends_with(b"\xFF\x80\x00\x00\r\nFORM\r\nPRINT\r\n"));
    }

    #[test]
    fn dpl_downloads_ascii_image_then_prints_it() {
        let s = String::from_utf8(dpl(&job()).unwrap()).unwrap();
        assert!(s.starts_with("\u{1}D\u{2}m\r\n\u{2}IAAFLBLPRT\r\n8002FF80\r\n80020000\r\nFFFF\r\n"), "{s:?}");
        // 圖底邊 = 240 - 4 - 2 = 234 dots = 292.5 → 293（1/10 mm）；左邊 10 dots = 12.5 → 13
        assert!(s.contains("\u{2}L\r\nH16\r\n1Y1100002930013LBLPRT\r\n"), "{s:?}");
        assert!(s.ends_with("Q0003\r\nE\r\n"));
    }

    #[test]
    fn sbpl_pads_rows_to_blocks_and_frames_with_stx_etx() {
        let s = String::from_utf8(sbpl(&job()).unwrap()).unwrap();
        assert!(s.starts_with("\u{2}\u{1b}A\u{1b}H0010\u{1b}V0004\u{1b}GH002001FF80"), "{s:?}");
        assert!(s.ends_with("\u{1b}Q3\u{1b}Z\u{3}"));
        // 8 列 × 2 byte × 2 hex 字元 = 32 字元的點陣資料
        let data = s.split("GH002001").nth(1).unwrap().split('\u{1b}').next().unwrap();
        assert_eq!(data.len(), 32);
    }
}
