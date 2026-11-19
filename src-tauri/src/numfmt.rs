//! 依 Excel 儲存格的「數字格式」把值轉成顯示文字，讓標籤上的內容和 Excel 畫面一致。
//!
//! - 日期／時間：`yyyy/mm/dd`、`yyyy/m/d`、`yyyy"年"m"月"d"日"`、`hh:mm`、`AM/PM`、`ddd`、民國年 `e` 等。
//! - 一般數字：`0`、`0.00`、`0000`、`#,##0`、`0%`、`"NT$"#,##0`、`(#,##0)` 等。
//! - **只支援常見格式**。遇到看不懂的格式（科學記號、分數、條件、經過時間 `[h]`…）一律回傳 `None`，
//!   由呼叫端退回原本的預設顯示，不亂猜。
//! - 星期與月份的名稱：格式碼沒有指定語系，或指定中文語系（`[$-404]` 等）時用中文（週三、11月）；
//!   指定其他語系（例如 `[$-409]`）時用英文。這是依使用者的 Windows 為繁體中文（台灣）而定。

use chrono::{Datelike, NaiveDate};

/// (年, 月, 日, 時, 分, 秒, 毫秒) —— 與 calamine 的 `ExcelDateTime::to_ymd_hms_milli()` 相同
pub type Ymdhms = (u16, u8, u8, u8, u8, u8, u16);

/// 取第一個區段（以 `;` 分隔，引號與跳脫字元內的 `;` 不算）
fn split_sections(code: &str) -> Vec<String> {
    let mut out = vec![String::new()];
    let mut in_quote = false;
    let mut escape = false;
    for c in code.chars() {
        if escape {
            out.last_mut().unwrap().push(c);
            escape = false;
            continue;
        }
        match c {
            '\\' => { escape = true; out.last_mut().unwrap().push(c); }
            '"' => { in_quote = !in_quote; out.last_mut().unwrap().push(c); }
            ';' if !in_quote => out.push(String::new()),
            _ => out.last_mut().unwrap().push(c),
        }
    }
    out
}

// ====================== 日期 / 時間 ======================

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Lit(String),
    Year(usize),
    /// 月或分，稍後依前後文判斷
    M(usize),
    Month(usize),
    Minute(usize),
    Day(usize),
    Hour(usize),
    Second(usize),
    Frac(usize),
    AmPm { short: bool },
    /// 年號紀年的年（民國年）
    Era(usize),
    EraName,
}

struct Parsed {
    toks: Vec<Tok>,
    locale: Option<u32>,
    ampm: bool,
}

fn run_len(chars: &[char], i: usize) -> usize {
    let c = chars[i].to_ascii_lowercase();
    chars[i..].iter().take_while(|x| x.to_ascii_lowercase() == c).count()
}

fn starts_with_ci(chars: &[char], i: usize, pat: &str) -> bool {
    let p: Vec<char> = pat.chars().collect();
    i + p.len() <= chars.len() && chars[i..i + p.len()].iter().zip(&p).all(|(a, b)| a.to_ascii_lowercase() == b.to_ascii_lowercase())
}

fn parse_date_code(section: &str) -> Option<Parsed> {
    let chars: Vec<char> = section.chars().collect();
    let mut toks: Vec<Tok> = Vec::new();
    let mut locale = None;
    let mut ampm = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '"' => {
                let mut s = String::new();
                i += 1;
                while i < chars.len() && chars[i] != '"' { s.push(chars[i]); i += 1; }
                i += 1;
                toks.push(Tok::Lit(s));
            }
            '\\' => { if i + 1 < chars.len() { toks.push(Tok::Lit(chars[i + 1].to_string())); } i += 2; }
            '_' => { toks.push(Tok::Lit(" ".into())); i += 2; }
            '*' => i += 2,
            '[' => {
                let end = chars[i..].iter().position(|&x| x == ']').map(|p| i + p)?;
                let inner: String = chars[i + 1..end].iter().collect();
                if let Some(rest) = inner.strip_prefix('$') {
                    // [$-404] 或 [$NT$-404]：語系；F800 / F400 是「系統長日期 / 時間」，無法還原
                    let tag = rest.rsplit('-').next().unwrap_or("");
                    let id = u32::from_str_radix(tag, 16).ok();
                    if matches!(id, Some(0xF800) | Some(0xF400)) { return None; }
                    locale = id;
                } else if matches!(inner.chars().next().map(|c| c.to_ascii_lowercase()), Some('h') | Some('m') | Some('s')) {
                    return None; // [h]:mm 這類「經過時間」
                }
                // 其餘（顏色等）忽略
                i = end + 1;
            }
            'y' | 'Y' => { let n = run_len(&chars, i); toks.push(Tok::Year(n)); i += n; }
            'm' | 'M' => { let n = run_len(&chars, i); toks.push(Tok::M(n)); i += n; }
            'd' | 'D' => { let n = run_len(&chars, i); toks.push(Tok::Day(n)); i += n; }
            'h' | 'H' => { let n = run_len(&chars, i); toks.push(Tok::Hour(n)); i += n; }
            's' | 'S' => { let n = run_len(&chars, i); toks.push(Tok::Second(n)); i += n; }
            'e' | 'E' => { let n = run_len(&chars, i); toks.push(Tok::Era(n)); i += n; }
            'g' | 'G' => { let n = run_len(&chars, i); toks.push(Tok::EraName); i += n; }
            'a' | 'A' => {
                if starts_with_ci(&chars, i, "am/pm") { ampm = true; toks.push(Tok::AmPm { short: false }); i += 5; }
                else if starts_with_ci(&chars, i, "a/p") { ampm = true; toks.push(Tok::AmPm { short: true }); i += 3; }
                else { toks.push(Tok::Lit(c.to_string())); i += 1; }
            }
            '.' if matches!(toks.last(), Some(Tok::Second(_))) && chars.get(i + 1) == Some(&'0') => {
                let zeros = chars[i + 1..].iter().take_while(|&&x| x == '0').count();
                toks.push(Tok::Frac(zeros));
                i += 1 + zeros;
            }
            _ => { toks.push(Tok::Lit(c.to_string())); i += 1; }
        }
    }

    // 「m」緊接在時(h)之後、或緊接在秒(s)之前，是「分」而不是「月」（中間的 : 等符號不算）
    for idx in 0..toks.len() {
        if let Tok::M(n) = toks[idx] {
            let prev = toks[..idx].iter().rev().find(|t| !matches!(t, Tok::Lit(_)));
            let next = toks[idx + 1..].iter().find(|t| !matches!(t, Tok::Lit(_)));
            toks[idx] = if matches!(prev, Some(Tok::Hour(_))) || matches!(next, Some(Tok::Second(_))) { Tok::Minute(n) } else { Tok::Month(n) };
        }
    }
    let has_date_or_time = toks.iter().any(|t| !matches!(t, Tok::Lit(_)));
    has_date_or_time.then_some(Parsed { toks, locale, ampm })
}

const ZH_MONTH: [&str; 12] = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"];
const EN_MONTH: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ZH_WEEK_SHORT: [&str; 7] = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];
const ZH_WEEK_FULL: [&str; 7] = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
const EN_WEEK: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

fn render_date(p: &Parsed, (y, mo, d, h, mi, s, ms): Ymdhms) -> String {
    let zh = matches!(p.locale, None | Some(0x404) | Some(0x804) | Some(0xC04) | Some(0x1004) | Some(0x1404));
    let weekday = NaiveDate::from_ymd_opt(y as i32, mo as u32, d as u32).map(|dt| dt.weekday().num_days_from_sunday() as usize);
    let month_idx = (mo.max(1) as usize - 1).min(11);
    let mut out = String::new();
    for t in &p.toks {
        match t {
            Tok::Lit(s) => out.push_str(s),
            Tok::Year(n) => out.push_str(&if *n <= 2 { format!("{:02}", y % 100) } else { format!("{y:04}") }),
            Tok::Month(n) => out.push_str(&match n {
                1 => mo.to_string(),
                2 => format!("{mo:02}"),
                3 => if zh { format!("{mo}月") } else { EN_MONTH[month_idx][..3].to_string() },
                4 => (if zh { ZH_MONTH[month_idx] } else { EN_MONTH[month_idx] }).to_string(),
                _ => if zh { ZH_MONTH[month_idx].chars().next().unwrap().to_string() } else { EN_MONTH[month_idx][..1].to_string() },
            }),
            Tok::Day(n) => out.push_str(&match n {
                1 => d.to_string(),
                2 => format!("{d:02}"),
                3 => weekday.map(|w| if zh { ZH_WEEK_SHORT[w].to_string() } else { EN_WEEK[w][..3].to_string() }).unwrap_or_default(),
                _ => weekday.map(|w| (if zh { ZH_WEEK_FULL[w] } else { EN_WEEK[w] }).to_string()).unwrap_or_default(),
            }),
            Tok::Hour(n) => {
                let hh = if p.ampm { (h + 11) % 12 + 1 } else { h };
                out.push_str(&if *n == 1 { hh.to_string() } else { format!("{hh:02}") });
            }
            Tok::Minute(n) => out.push_str(&if *n == 1 { mi.to_string() } else { format!("{mi:02}") }),
            Tok::Second(n) => out.push_str(&if *n == 1 { s.to_string() } else { format!("{s:02}") }),
            Tok::Frac(n) => {
                out.push('.');
                out.push_str(&format!("{ms:03}")[..(*n).min(3)]);
            }
            Tok::AmPm { short } => {
                let pm = h >= 12;
                out.push_str(match (zh, short, pm) {
                    (true, _, false) => "上午",
                    (true, _, true) => "下午",
                    (false, false, false) => "AM",
                    (false, false, true) => "PM",
                    (false, true, false) => "A",
                    (false, true, true) => "P",
                });
            }
            Tok::Era(n) => {
                let roc = (y as i32 - 1911).max(1);
                out.push_str(&if *n >= 2 { format!("{roc:02}") } else { roc.to_string() });
            }
            Tok::EraName => out.push_str("民國"),
            Tok::M(_) => unreachable!("M 已在解析後分成 Month / Minute"),
        }
    }
    out
}

/// 依格式碼顯示日期時間；格式碼看不懂時回傳 None。
/// 內建格式 14（短日期）與 22（日期＋時間）會依系統語系顯示，這裡採台灣的 `yyyy/m/d`。
pub fn format_datetime(code: &str, id: Option<u32>, parts: Ymdhms) -> Option<String> {
    let code = match id {
        Some(14) => "yyyy/m/d",
        Some(22) => "yyyy/m/d h:mm",
        _ => code.trim(),
    };
    if code.is_empty() || code.eq_ignore_ascii_case("general") {
        return None;
    }
    let first = split_sections(code).into_iter().next()?;
    let parsed = parse_date_code(&first)?;
    Some(render_date(&parsed, parts))
}

// ====================== 一般數字 ======================

struct NumPattern {
    prefix: String,
    suffix: String,
    /// 整數部分的「0」個數（不足時左邊補 0）
    int_min: usize,
    dec_min: usize,
    dec_max: usize,
    thousands: bool,
    percent: usize,
    /// 區段裡沒有任何數字佔位符，只是一段文字（例如零值顯示「零」）：直接輸出 `prefix`
    literal_only: bool,
}

fn parse_num_pattern(section: &str) -> Option<NumPattern> {
    #[derive(Clone)]
    enum N { Lit(String), Digit(char), Dot, Comma }
    let chars: Vec<char> = section.chars().collect();
    let mut toks: Vec<N> = Vec::new();
    let mut percent = 0;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '"' => {
                let mut s = String::new();
                i += 1;
                while i < chars.len() && chars[i] != '"' { s.push(chars[i]); i += 1; }
                i += 1;
                toks.push(N::Lit(s));
            }
            '\\' => { if i + 1 < chars.len() { toks.push(N::Lit(chars[i + 1].to_string())); } i += 2; }
            '_' => { toks.push(N::Lit(" ".into())); i += 2; }
            '*' => i += 2,
            '[' => {
                let end = chars[i..].iter().position(|&x| x == ']').map(|p| i + p)?;
                let inner: String = chars[i + 1..end].iter().collect();
                if let Some(rest) = inner.strip_prefix('$') {
                    // [$NT$-404] → 貨幣符號 NT$
                    let sym = rest.rsplit_once('-').map(|(a, _)| a).unwrap_or(rest);
                    if !sym.is_empty() { toks.push(N::Lit(sym.to_string())); }
                } else if inner.starts_with(['<', '>', '=']) {
                    return None; // 條件格式
                }
                i = end + 1; // 顏色等忽略
            }
            '0' | '#' | '?' => { toks.push(N::Digit(c)); i += 1; }
            '.' => { toks.push(N::Dot); i += 1; }
            ',' => { toks.push(N::Comma); i += 1; }
            '%' => { percent += 1; toks.push(N::Lit("%".into())); i += 1; }
            '@' | '/' => return None,
            c if c.is_ascii_alphabetic() => return None, // E+、日期字母、General 等
            _ => { toks.push(N::Lit(c.to_string())); i += 1; }
        }
    }

    let join = |ts: &[N]| ts.iter().filter_map(|t| if let N::Lit(s) = t { Some(s.as_str()) } else { None }).collect::<String>();
    let is_digitish = |t: &N| matches!(t, N::Digit(_) | N::Dot | N::Comma);
    let (Some(first), Some(last)) = (toks.iter().position(is_digitish), toks.iter().rposition(is_digitish)) else {
        return Some(NumPattern {
            prefix: join(&toks), suffix: String::new(), int_min: 0, dec_min: 0, dec_max: 0, thousands: false, percent: 0, literal_only: true,
        });
    };
    // 數字佔位符之間夾著文字（例如 0-0000）：不支援
    if toks[first..=last].iter().any(|t| matches!(t, N::Lit(_))) { return None; }
    // 結尾的逗號（千為單位縮放）：不支援
    if matches!(toks[last], N::Comma) { return None; }

    let body = &toks[first..=last];
    let mut seen_dot = false;
    let (mut int_min, mut dec_min, mut dec_max, mut thousands) = (0, 0, 0, false);
    for t in body {
        match t {
            N::Dot => { if seen_dot { return None; } seen_dot = true; }
            N::Comma => { if seen_dot { return None; } thousands = true; }
            N::Digit(c) => {
                if seen_dot { dec_max += 1; if *c == '0' { dec_min = dec_max; } }
                else if *c == '0' { int_min += 1; }
            }
            N::Lit(_) => {}
        }
    }
    Some(NumPattern { prefix: join(&toks[..first]), suffix: join(&toks[last + 1..]), int_min, dec_min, dec_max, thousands, percent, literal_only: false })
}

/// 四捨五入（0.5 進位，與 Excel 相同）到小數 d 位，回傳（整數位字串, 小數位字串）。
/// 先用 12 位小數的十進位字串再進位，避免 2.675 因二進位誤差變成 2.67。
fn round_half_up(x: f64, d: usize) -> (String, String) {
    let s = format!("{x:.12}");
    let (int_s, frac_s) = s.split_once('.').unwrap_or((&s, ""));
    let mut digits: Vec<u8> = int_s.bytes().chain(frac_s.bytes().take(d)).map(|b| b - b'0').collect();
    while digits.len() < int_s.len() + d { digits.push(0); }
    if frac_s.as_bytes().get(d).is_some_and(|&b| b >= b'5') {
        let mut k = digits.len();
        loop {
            if k == 0 { digits.insert(0, 1); break; }
            k -= 1;
            if digits[k] == 9 { digits[k] = 0; } else { digits[k] += 1; break; }
        }
    }
    let split = digits.len() - d;
    let to_s = |ds: &[u8]| ds.iter().map(|x| (x + b'0') as char).collect::<String>();
    (to_s(&digits[..split]), to_s(&digits[split..]))
}

fn group_thousands(int_digits: &str) -> String {
    let mut out = String::new();
    for (i, c) in int_digits.chars().enumerate() {
        if i > 0 && (int_digits.len() - i) % 3 == 0 { out.push(','); }
        out.push(c);
    }
    out
}

/// 依格式碼顯示數字；格式碼是 General、或看不懂時回傳 None。
pub fn format_number(code: &str, v: f64) -> Option<String> {
    let code = code.trim();
    if code.is_empty() || code.eq_ignore_ascii_case("general") || !v.is_finite() {
        return None;
    }
    let sections = split_sections(code);
    // 區段：正數;負數;零;文字。只有一個區段時，負數自動加負號
    let (sec, own_sign) = if v < 0.0 && sections.len() >= 2 { (&sections[1], true) }
        else if v == 0.0 && sections.len() >= 3 { (&sections[2], false) }
        else { (&sections[0], false) };
    let pat = parse_num_pattern(sec)?;
    if pat.literal_only {
        return Some(pat.prefix);
    }

    let x = v.abs() * 100f64.powi(pat.percent as i32);
    let (mut int_s, mut frac_s) = round_half_up(x, pat.dec_max);
    let trimmed = int_s.trim_start_matches('0');
    int_s = trimmed.to_string();
    // 左邊補 0 到至少 int_min 位；沒有整數佔位符且整數為 0 時不顯示整數（例如 #.00 → .50）
    while int_s.len() < pat.int_min { int_s.insert(0, '0'); }
    // 小數部分：多餘的結尾 0（對應 # 佔位符）省略
    while frac_s.len() > pat.dec_min && frac_s.ends_with('0') { frac_s.pop(); }
    if pat.thousands { int_s = group_thousands(&int_s); }

    let mut out = String::new();
    if v < 0.0 && !own_sign && (x != 0.0) { out.push('-'); }
    out.push_str(&pat.prefix);
    out.push_str(&int_s);
    if pat.dec_max > 0 {
        out.push('.');
        out.push_str(&frac_s);
    }
    out.push_str(&pat.suffix);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOV18: Ymdhms = (2026, 11, 18, 0, 0, 0, 0);
    const JAN5: Ymdhms = (2026, 1, 5, 0, 0, 0, 0);
    fn dt(code: &str, p: Ymdhms) -> Option<String> { format_datetime(code, Some(164), p) }

    #[test]
    fn user_case_yyyy_slash_mm_slash_dd() {
        assert_eq!(dt("yyyy/mm/dd", NOV18).unwrap(), "2026/11/18");
        assert_eq!(dt("yyyy/mm/dd", JAN5).unwrap(), "2026/01/05", "mm / dd 要補零");
        assert_eq!(dt("yyyy/m/d", JAN5).unwrap(), "2026/1/5", "m / d 不補零");
    }

    #[test]
    fn common_date_patterns() {
        assert_eq!(dt("yyyy-mm-dd", JAN5).unwrap(), "2026-01-05");
        assert_eq!(dt("mm/dd/yyyy", JAN5).unwrap(), "01/05/2026");
        assert_eq!(dt("yy/m/d", JAN5).unwrap(), "26/1/5");
        assert_eq!(dt("yyyy\"年\"m\"月\"d\"日\"", JAN5).unwrap(), "2026年1月5日");
        assert_eq!(dt("yyyy年m月d日", JAN5).unwrap(), "2026年1月5日");
        assert_eq!(dt("[$-404]yyyy/m/d", JAN5).unwrap(), "2026/1/5");
        assert_eq!(dt("yyyy.mm.dd", NOV18).unwrap(), "2026.11.18");
        assert_eq!(dt("yyyy/mm/dd;@", NOV18).unwrap(), "2026/11/18", "多個區段取第一個");
    }

    #[test]
    fn time_and_minutes_vs_months() {
        let t: Ymdhms = (2026, 11, 18, 14, 5, 9, 250);
        assert_eq!(dt("yyyy/mm/dd hh:mm", t).unwrap(), "2026/11/18 14:05");
        assert_eq!(dt("hh:mm:ss", t).unwrap(), "14:05:09");
        assert_eq!(dt("mm:ss", t).unwrap(), "05:09", "m 緊接在 s 前是分");
        assert_eq!(dt("h:mm", t).unwrap(), "14:05");
        assert_eq!(dt("hh:mm:ss.000", t).unwrap(), "14:05:09.250");
        assert_eq!(dt("h:mm AM/PM", t).unwrap(), "2:05 下午");
        assert_eq!(dt("[$-409]h:mm AM/PM", t).unwrap(), "2:05 PM");
        assert_eq!(dt("[$-409]h:mm A/P", t).unwrap(), "2:05 P");
    }

    #[test]
    fn month_and_weekday_names() {
        assert_eq!(dt("mmm", NOV18).unwrap(), "11月");
        assert_eq!(dt("mmmm", NOV18).unwrap(), "十一月");
        assert_eq!(dt("ddd", NOV18).unwrap(), "週三");
        assert_eq!(dt("dddd", NOV18).unwrap(), "星期三");
        assert_eq!(dt("[$-409]mmm dd, yyyy", NOV18).unwrap(), "Nov 18, 2026");
        assert_eq!(dt("[$-409]dddd", NOV18).unwrap(), "Wednesday");
        assert_eq!(dt("[$-409]mmmm", NOV18).unwrap(), "November");
    }

    #[test]
    fn roc_year_and_builtin_ids() {
        assert_eq!(dt("[$-404]e/m/d", NOV18).unwrap(), "115/11/18");
        assert_eq!(dt("[$-404]ggge\"年\"m\"月\"d\"日\"", NOV18).unwrap(), "民國115年11月18日");
        // 內建格式 14 依系統語系顯示；這裡採台灣的 yyyy/m/d，不理會檔案內記載的 mm-dd-yy
        assert_eq!(format_datetime("mm-dd-yy", Some(14), JAN5).unwrap(), "2026/1/5");
        assert_eq!(format_datetime("m/d/yy h:mm", Some(22), (2026, 1, 5, 9, 3, 0, 0)).unwrap(), "2026/1/5 9:03");
    }

    #[test]
    fn unsupported_date_formats_return_none() {
        assert_eq!(dt("[h]:mm", NOV18), None, "經過時間");
        assert_eq!(dt("[$-F800]dddd, mmmm dd, yyyy", NOV18), None, "系統長日期");
        assert_eq!(dt("General", NOV18), None);
        assert_eq!(dt("", NOV18), None);
        assert_eq!(dt("0.00", NOV18), None, "沒有任何日期符號");
    }

    #[test]
    fn numbers_basic() {
        assert_eq!(format_number("0", 30.4).unwrap(), "30");
        assert_eq!(format_number("0", 30.5).unwrap(), "31");
        assert_eq!(format_number("0.00", 30.0).unwrap(), "30.00");
        assert_eq!(format_number("0.00", 2.675).unwrap(), "2.68", "與 Excel 一樣四捨五入");
        assert_eq!(format_number("0000", 12.0).unwrap(), "0012", "前置 0 要保留");
        assert_eq!(format_number("00000", 1234.0).unwrap(), "01234");
        assert_eq!(format_number("#,##0", 1234567.0).unwrap(), "1,234,567");
        assert_eq!(format_number("#,##0.00", 1234.5).unwrap(), "1,234.50");
        assert_eq!(format_number("#,##0", 999.0).unwrap(), "999");
        assert_eq!(format_number("0.0", 0.04).unwrap(), "0.0");
        assert_eq!(format_number("0.#", 5.0).unwrap(), "5.", "與 Excel 相同：# 不顯示多餘的 0，但小數點保留");
        assert_eq!(format_number("0.#", 5.25).unwrap(), "5.3", "只留一位小數，四捨五入");
        assert_eq!(format_number("0.##", 5.25).unwrap(), "5.25");
    }

    #[test]
    fn numbers_percent_literals_and_signs() {
        assert_eq!(format_number("0%", 0.256).unwrap(), "26%");
        assert_eq!(format_number("0.0%", 0.256).unwrap(), "25.6%");
        assert_eq!(format_number("\"NT$\"#,##0", 1500.0).unwrap(), "NT$1,500");
        assert_eq!(format_number("[$NT$-404]#,##0", 1500.0).unwrap(), "NT$1,500");
        assert_eq!(format_number("0\" 件\"", 5.0).unwrap(), "5 件");
        assert_eq!(format_number("#,##0.00", -1234.5).unwrap(), "-1,234.50", "單一區段的負數自動加負號");
        assert_eq!(format_number("#,##0;(#,##0)", -1200.0).unwrap(), "(1,200)", "負數區段自行決定外觀");
        assert_eq!(format_number("0.00;-0.00;\"零\"", 0.0).unwrap(), "零", "第三區段是零");
        assert_eq!(format_number("[Red]0.00", 3.0).unwrap(), "3.00", "顏色忽略");
        assert_eq!(format_number("0.00_);(0.00)", 3.0).unwrap(), "3.00 ");
    }

    #[test]
    fn unsupported_number_formats_return_none() {
        for code in ["General", "", "@", "0.00E+00", "# ?/?", "0-0000", "[>100]0", "0,", "m/d/yyyy"] {
            assert_eq!(format_number(code, 12.5), None, "{code}");
        }
    }
}
