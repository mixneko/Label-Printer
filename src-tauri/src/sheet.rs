//! 讀取 Excel（.xlsx/.xlsm/.xls）與 CSV，轉成「欄位標題 + 資料列」的表格。
//! 第一個非空白列為欄位標題，其後每一列是一筆資料（標籤上的 {{欄位}} 取自這裡）。
//!
//! 兩種來源的呈現方式不同（使用者指定）：
//! - **Excel**：原樣呈現 —— 保留中間的空白列、列號對齊 Excel 的列號，並帶出文字顏色、底色與粗體。
//! - **CSV**（以及之後的 Access 等資料庫）：只取資料 —— 略過空白列、列號為流水號、沒有格式。
//!   之後新增資料來源時沿用 `Grid { keep_blank: false, styles: 空 }` 即可。

use crate::numfmt;
use calamine::{open_workbook_auto, Data, NumberFormat, Reader, Style, StyleRange};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Excel 儲存格的原始值（數字或日期時間）。前端要讓使用者在標籤上「自己指定欄位格式」時，
/// 需要原始值才能重新格式化；文字儲存格沒有原始值（格式對文字無意義）。
#[derive(Debug, Serialize, Deserialize, PartialEq, Clone, Copy)]
pub enum Raw {
    /// 數字
    #[serde(rename = "n")]
    Num(f64),
    /// 日期時間：[年, 月, 日, 時, 分, 秒, 毫秒]
    #[serde(rename = "d")]
    Date([u32; 7]),
}

impl Raw {
    pub fn parts(&self) -> Option<numfmt::Ymdhms> {
        match self {
            Raw::Date(p) => Some((p[0] as u16, p[1] as u8, p[2] as u8, p[3] as u8, p[4] as u8, p[5] as u8, p[6] as u16)),
            Raw::Num(_) => None,
        }
    }
}

/// 儲存格的顯示格式（只包含與預設不同的部分）
#[derive(Debug, Serialize, PartialEq, Clone)]
pub struct CellStyle {
    /// 文字顏色，例如 "#ff0000"；黑色（預設）不帶
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// 底色；白色或無底色不帶
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bg: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub bold: bool,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TableData {
    pub sheets: Vec<String>,
    pub sheet: String,
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    /// 每一列顯示的列號：Excel 為工作表中的實際列號，其他來源為 1、2、3…
    pub row_numbers: Vec<u32>,
    /// 與 `rows` 同樣大小的格式；沒有格式的來源（CSV 等）為空陣列
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub styles: Vec<Vec<Option<CellStyle>>>,
    /// 與 `rows` 同樣大小的原始值（只有 Excel 的數字／日期儲存格有）；沒有的來源為空陣列
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub raw: Vec<Vec<Option<Raw>>>,
}

/// 讀進來的原始格子。`styles`、`raw` 要嘛為空，要嘛與 `rows` 同樣大小。
struct Grid {
    rows: Vec<Vec<String>>,
    styles: Vec<Vec<Option<CellStyle>>>,
    raw: Vec<Vec<Option<Raw>>>,
    /// `rows[0]` 對應的列號（Excel 為 1 起算的工作表列號）
    first_row: u32,
    /// 是否保留資料列之間的空白列（Excel 為 true；CSV 等為 false）
    keep_blank: bool,
}

pub fn read_table(path: &str, sheet: Option<&str>) -> Result<TableData, String> {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let (sheets, name, grid) = if matches!(ext.as_str(), "csv" | "txt" | "tsv") {
        let bytes = std::fs::read(path).map_err(|e| format!("讀取檔案失敗：{e}"))?;
        let rows = parse_csv(&decode_text(&bytes))?;
        let grid = Grid { rows, styles: vec![], raw: vec![], first_row: 1, keep_blank: false };
        (vec!["CSV".to_string()], "CSV".to_string(), grid)
    } else {
        read_workbook(path, sheet)?
    };
    build_table(sheets, name, grid)
}

fn read_workbook(path: &str, sheet: Option<&str>) -> Result<(Vec<String>, String, Grid), String> {
    let mut wb = open_workbook_auto(path).map_err(|e| format!("無法開啟活頁簿：{e}"))?;
    let sheets: Vec<String> = wb.sheet_names().to_vec();
    let name = sheet
        .filter(|s| sheets.iter().any(|x| x == s))
        .map(str::to_string)
        .or_else(|| sheets.first().cloned())
        .ok_or("活頁簿沒有任何工作表")?;
    let range = wb
        .worksheet_range(&name)
        .map_err(|e| format!("讀取工作表「{name}」失敗：{e}"))?;
    // 格式讀不到（例如舊式 .xls）時當作沒有格式，不影響資料
    let style_range = wb.worksheet_style(&name).unwrap_or_else(|_| StyleRange::empty());

    // Range 從「第一個有值的儲存格」開始；格式以工作表的絕對座標（0 起算）查詢
    let (r0, c0) = range.start().unwrap_or((0, 0));
    let mut rows = Vec::new();
    let mut styles = Vec::new();
    let mut raws = Vec::new();
    for (i, row) in range.rows().enumerate() {
        // 每個儲存格的格式（文字色、底色、數字格式）以絕對座標查詢
        let cell_styles: Vec<Option<&Style>> = (0..row.len())
            .map(|j| style_range.get((r0 + i as u32, c0 + j as u32)))
            .collect();
        // 值依 Excel 的「數字格式」顯示（日期照 yyyy/mm/dd、0000 保留前置零…），與 Excel 畫面一致
        rows.push(
            row.iter()
                .zip(&cell_styles)
                .map(|(c, st)| cell_to_string(c, st.and_then(|s| s.number_format.as_ref())))
                .collect(),
        );
        styles.push(cell_styles.iter().map(|st| st.and_then(to_cell_style)).collect());
        raws.push(row.iter().map(to_raw).collect());
    }
    Ok((sheets, name, Grid { rows, styles, raw: raws, first_row: r0 + 1, keep_blank: true }))
}

/// 數字與日期時間儲存格的原始值（其他型別沒有）
fn to_raw(c: &Data) -> Option<Raw> {
    match c {
        Data::Int(i) => Some(Raw::Num(*i as f64)),
        Data::Float(f) => Some(Raw::Num(*f)),
        Data::DateTime(dt) if !dt.is_duration() => {
            let (y, mo, d, h, mi, s, ms) = dt.to_ymd_hms_milli();
            Some(Raw::Date([y as u32, mo as u32, d as u32, h as u32, mi as u32, s as u32, ms as u32]))
        }
        _ => None,
    }
}

/// 「欄位格式」：用指定的 Excel 格式碼把原始值重新格式化（例如日期改成 yyyy/mm/dd、數字補零）。
/// 格式碼看不懂、或與值的型別不符（例如對日期用數字格式）時回傳 None，前端會退回 Excel 原本的顯示。
pub fn format_raw(raw: &Raw, code: &str) -> Option<String> {
    match raw {
        Raw::Num(v) => numfmt::format_number(code, *v),
        Raw::Date(_) => numfmt::format_datetime(code, None, raw.parts()?),
    }
}

fn hex(c: calamine::Color) -> String {
    format!("#{:02x}{:02x}{:02x}", c.red, c.green, c.blue)
}

/// 取出文字顏色、底色與粗體；全部都是預設值時回傳 None
fn to_cell_style(s: &Style) -> Option<CellStyle> {
    let color = s.font.as_ref().and_then(|f| f.color).filter(|c| !c.is_black()).map(hex);
    let bg = s
        .fill
        .as_ref()
        .filter(|f| f.is_visible())
        .and_then(|f| f.get_color())
        .filter(|c| !c.is_white())
        .map(hex);
    let bold = s.font.as_ref().is_some_and(|f| f.is_bold());
    if color.is_none() && bg.is_none() && !bold {
        None
    } else {
        Some(CellStyle { color, bg, bold })
    }
}

/// 儲存格轉成顯示用文字。有 Excel「數字格式」時照格式顯示（日期、時間、前置零、小數位、千分位、百分比…）；
/// 沒有格式、或格式看不懂時退回預設：整數值不帶 .0，日期轉成 yyyy-mm-dd（有時間才附時間）。
fn cell_to_string(c: &Data, fmt: Option<&NumberFormat>) -> String {
    let code = fmt.map(|f| (f.format_code.as_str(), f.format_id));
    match c {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Int(i) => code
            .and_then(|(code, _)| numfmt::format_number(code, *i as f64))
            .unwrap_or_else(|| i.to_string()),
        Data::Float(f) => code
            .and_then(|(code, _)| numfmt::format_number(code, *f))
            .unwrap_or_else(|| format_float(*f)),
        Data::Bool(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
        Data::DateTime(dt) => code
            .filter(|_| !dt.is_duration())
            .and_then(|(code, id)| numfmt::format_datetime(code, id, dt.to_ymd_hms_milli()))
            .unwrap_or_else(|| match dt.as_datetime() {
                Some(d) => {
                    if d.time() == chrono::NaiveTime::MIN {
                        d.format("%Y-%m-%d").to_string()
                    } else {
                        d.format("%Y-%m-%d %H:%M").to_string()
                    }
                }
                None => dt.as_f64().to_string(),
            }),
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
        Data::Error(_) => String::new(),
    }
}

fn format_float(f: f64) -> String {
    if f.fract() == 0.0 && f.abs() < 1e15 {
        format!("{}", f as i64)
    } else {
        f.to_string()
    }
}

/// 解碼 CSV 文字：去除 UTF-8 BOM；不是合法 UTF-8 時視為 Big5（台灣 Excel 另存 CSV 的常見編碼）
fn decode_text(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => encoding_rs::BIG5.decode(bytes).0.into_owned(),
    }
}

/// 由第一行猜分隔符號：逗號、分號或 Tab 中出現最多者
fn detect_delimiter(text: &str) -> u8 {
    let first = text.lines().next().unwrap_or("");
    [b',', b';', b'\t']
        .into_iter()
        .max_by_key(|d| first.bytes().filter(|b| b == d).count())
        .unwrap_or(b',')
}

fn parse_csv(text: &str) -> Result<Vec<Vec<String>>, String> {
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(detect_delimiter(text))
        .from_reader(text.as_bytes());
    let mut grid = Vec::new();
    for rec in rdr.records() {
        let rec = rec.map_err(|e| format!("CSV 格式錯誤：{e}"))?;
        grid.push(rec.iter().map(str::to_string).collect());
    }
    Ok(grid)
}

fn build_table(sheets: Vec<String>, sheet: String, grid: Grid) -> Result<TableData, String> {
    let is_blank = |r: &Vec<String>| r.iter().all(|c| c.trim().is_empty());
    // 第一個非空白列是欄位標題
    let head_idx = grid.rows.iter().position(|r| !is_blank(r)).ok_or("這個工作表是空的")?;
    let head = &grid.rows[head_idx];

    // 資料列的索引：Excel 保留中間的空白列（只去掉最後面的），其他來源略過所有空白列
    let mut body_idx: Vec<usize> = (head_idx + 1..grid.rows.len()).collect();
    if grid.keep_blank {
        while body_idx.last().is_some_and(|&i| is_blank(&grid.rows[i])) {
            body_idx.pop();
        }
    } else {
        body_idx.retain(|&i| !is_blank(&grid.rows[i]));
    }

    // 欄數取標題列與資料列的最大值，避免資料被截掉
    let width = body_idx.iter().map(|&i| grid.rows[i].len()).chain([head.len()]).max().unwrap_or(0);

    let mut headers: Vec<String> = Vec::with_capacity(width);
    for i in 0..width {
        let raw = head.get(i).map(|s| s.trim()).unwrap_or("");
        let base = if raw.is_empty() { format!("欄{}", i + 1) } else { raw.to_string() };
        // 標題重複時加上 _2、_3，確保每個 {{欄位}} 都唯一
        let mut name = base.clone();
        let mut n = 2;
        while headers.contains(&name) {
            name = format!("{base}_{n}");
            n += 1;
        }
        headers.push(name);
    }

    let rows: Vec<Vec<String>> = body_idx
        .iter()
        .map(|&i| {
            let mut r = grid.rows[i].clone();
            r.resize(width, String::new());
            r
        })
        .collect();
    let row_numbers: Vec<u32> = if grid.keep_blank {
        body_idx.iter().map(|&i| grid.first_row + i as u32).collect()
    } else {
        (1..=rows.len() as u32).collect()
    };
    let styles = if grid.styles.is_empty() {
        vec![]
    } else {
        body_idx
            .iter()
            .map(|&i| {
                let mut s = grid.styles[i].clone();
                s.resize(width, None);
                s
            })
            .collect()
    };
    let raw = if grid.raw.is_empty() {
        vec![]
    } else {
        body_idx
            .iter()
            .map(|&i| {
                let mut r = grid.raw[i].clone();
                r.resize(width, None);
                r
            })
            .collect()
    };
    Ok(TableData { sheets, sheet, headers, rows, row_numbers, styles, raw })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    fn tmp(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("test-tmp");
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn csv_utf8_with_bom() {
        let mut b = vec![0xEF, 0xBB, 0xBF];
        b.extend("品名,價格\n蘋果,30\n".as_bytes());
        assert_eq!(parse_csv(&decode_text(&b)).unwrap(), vec![s(&["品名", "價格"]), s(&["蘋果", "30"])]);
    }

    #[test]
    fn csv_big5_is_decoded() {
        let (bytes, _, _) = encoding_rs::BIG5.encode("品名,價格\n蘋果,30\n");
        assert_eq!(decode_text(&bytes), "品名,價格\n蘋果,30\n");
    }

    #[test]
    fn csv_delimiter_detected_and_quotes_handled() {
        assert_eq!(detect_delimiter("a;b;c"), b';');
        assert_eq!(detect_delimiter("a\tb\tc"), b'\t');
        let g = parse_csv("名稱,備註\n\"甲,乙\",\"他說\"\"好\"\"\"\n").unwrap();
        assert_eq!(g[1], s(&["甲,乙", "他說\"好\""]));
    }

    /// 沒有格式、略過空白列的來源（CSV、之後的資料庫）
    fn plain(rows: Vec<Vec<String>>) -> Grid {
        Grid { rows, styles: vec![], raw: vec![], first_row: 1, keep_blank: false }
    }

    #[test]
    fn table_dedupes_headers_fills_blanks_and_skips_empty_rows() {
        let grid = plain(vec![
            s(&["", ""]),
            s(&["品名", "價格", "", "品名"]),
            s(&["蘋果", "30"]),
            s(&["", "", ""]),
            s(&["香蕉", "20", "x", "y", "多餘"]),
        ]);
        let t = build_table(vec!["S".into()], "S".into(), grid).unwrap();
        assert_eq!(t.headers, s(&["品名", "價格", "欄3", "品名_2", "欄5"]));
        assert_eq!(t.rows.len(), 2);
        assert_eq!(t.rows[0], s(&["蘋果", "30", "", "", ""]));
        assert_eq!(t.rows[1], s(&["香蕉", "20", "x", "y", "多餘"]));
        // CSV 等來源：略過空白列，列號為流水號，沒有格式
        assert_eq!(t.row_numbers, vec![1, 2]);
        assert!(t.styles.is_empty());
    }

    #[test]
    fn excel_style_grid_keeps_interior_blank_rows_and_real_row_numbers() {
        // 工作表從第 3 列開始有值；中間有一列空白；最後還有幾列空白
        let grid = Grid {
            rows: vec![s(&["品名", "價格"]), s(&["蘋果", "30"]), s(&["", ""]), s(&["香蕉", "20"]), s(&["", ""]), s(&["", ""])],
            styles: vec![],
            raw: vec![],
            first_row: 3,
            keep_blank: true,
        };
        let t = build_table(vec!["S".into()], "S".into(), grid).unwrap();
        assert_eq!(t.rows, vec![s(&["蘋果", "30"]), s(&["", ""]), s(&["香蕉", "20"])]);
        assert_eq!(t.row_numbers, vec![4, 5, 6], "列號要對齊 Excel（標題在第 3 列）");
    }

    #[test]
    fn empty_sheet_is_an_error() {
        assert!(build_table(vec![], "S".into(), plain(vec![s(&["", ""])])).is_err());
    }

    #[test]
    fn floats_drop_trailing_zero() {
        assert_eq!(format_float(30.0), "30");
        assert_eq!(format_float(12.5), "12.5");
        assert_eq!(format_float(-7.0), "-7");
    }

    #[test]
    fn xlsx_keeps_blank_rows_row_numbers_and_cell_styles() {
        use rust_xlsxwriter::{Color, Format, Workbook};
        let path = tmp("styled.xlsx");
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        // 刻意不從 A1 開始：標題在 B3（第 3 列、第 2 欄），之後有一列空白
        ws.write_string(2, 1, "客戶").unwrap();
        ws.write_string(2, 2, "訂單").unwrap();
        let red = Format::new().set_font_color(Color::Red);
        let hl = Format::new().set_bold().set_background_color(Color::Yellow);
        ws.write_string_with_format(3, 1, "紅字公司", &red).unwrap();
        ws.write_string(3, 2, "A-1").unwrap();
        // 第 5 列（索引 4）完全空白
        ws.write_string(5, 1, "黑字公司").unwrap();
        ws.write_string_with_format(5, 2, "B-2", &hl).unwrap();
        wb.save(&path).unwrap();

        let t = read_table(path.to_str().unwrap(), None).unwrap();
        assert_eq!(t.headers, s(&["客戶", "訂單"]));
        assert_eq!(t.rows, vec![s(&["紅字公司", "A-1"]), s(&["", ""]), s(&["黑字公司", "B-2"])]);
        assert_eq!(t.row_numbers, vec![4, 5, 6], "列號對齊 Excel");

        assert_eq!(t.styles.len(), 3);
        let red_cell = t.styles[0][0].as_ref().expect("紅字應帶出格式");
        assert_eq!(red_cell.color.as_deref(), Some("#ff0000"));
        assert!(red_cell.bg.is_none() && !red_cell.bold);
        assert!(t.styles[0][1].is_none(), "沒有格式的儲存格不帶格式");
        assert!(t.styles[1].iter().all(Option::is_none), "空白列沒有格式");
        let hl_cell = t.styles[2][1].as_ref().expect("粗體加底色應帶出格式");
        assert!(hl_cell.bold);
        assert_eq!(hl_cell.bg.as_deref(), Some("#ffff00"));
        assert!(hl_cell.color.is_none());
    }

    #[test]
    fn xlsx_values_follow_the_cell_number_format() {
        use rust_xlsxwriter::{ExcelDateTime, Format, Workbook};
        let path = tmp("numfmt.xlsx");
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        for (c, h) in ["自訂日期", "內建日期", "m/d", "日期時間", "編號", "價格", "百分比", "千分位"].iter().enumerate() {
            ws.write_string(0, c as u16, *h).unwrap();
        }
        let d = ExcelDateTime::from_ymd(2026, 11, 18).unwrap();
        let d2 = ExcelDateTime::from_ymd(2026, 1, 5).unwrap();
        let dt = ExcelDateTime::from_ymd(2026, 11, 18).unwrap().and_hms(14, 5, 0).unwrap();
        ws.write_datetime_with_format(1, 0, &d, &Format::new().set_num_format("yyyy/mm/dd")).unwrap();
        ws.write_datetime_with_format(1, 1, &d, &Format::new().set_num_format_index(14)).unwrap();
        ws.write_datetime_with_format(1, 2, &d2, &Format::new().set_num_format("yyyy/m/d")).unwrap();
        ws.write_datetime_with_format(1, 3, &dt, &Format::new().set_num_format("yyyy/mm/dd hh:mm")).unwrap();
        ws.write_number_with_format(1, 4, 12.0, &Format::new().set_num_format("0000")).unwrap();
        ws.write_number_with_format(1, 5, 30.0, &Format::new().set_num_format("0.00")).unwrap();
        ws.write_number_with_format(1, 6, 0.256, &Format::new().set_num_format("0.0%")).unwrap();
        ws.write_number_with_format(1, 7, 1234567.0, &Format::new().set_num_format("#,##0")).unwrap();
        // 沒有特別格式的數字維持原樣
        ws.write_number(2, 4, 12.0).unwrap();
        ws.write_number(2, 5, 12.5).unwrap();
        // 同樣的日期，但 m/d 不補零的格式
        ws.write_datetime_with_format(2, 0, &d2, &Format::new().set_num_format("yyyy/mm/dd")).unwrap();
        wb.save(&path).unwrap();

        let t = read_table(path.to_str().unwrap(), None).unwrap();
        assert_eq!(
            t.rows[0],
            s(&["2026/11/18", "2026/11/18", "2026/1/5", "2026/11/18 14:05", "0012", "30.00", "25.6%", "1,234,567"]),
            "各儲存格要照自己的 Excel 數字格式顯示"
        );
        assert_eq!(t.rows[1][0], "2026/01/05", "mm / dd 要補零");
        assert_eq!(t.rows[1][4], "12", "General 格式的數字維持原樣");
        assert_eq!(t.rows[1][5], "12.5");
    }

    #[test]
    fn xlsx_exposes_raw_values_and_user_format_overrides_the_cell_format() {
        use rust_xlsxwriter::{ExcelDateTime, Format, Workbook};
        let path = tmp("raw.xlsx");
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.write_string(0, 0, "出貨日期").unwrap();
        ws.write_string(0, 1, "編號").unwrap();
        ws.write_string(0, 2, "備註").unwrap();
        let d = ExcelDateTime::from_ymd(2026, 1, 5).unwrap();
        // 儲存格本身的格式是 yyyy-mm-dd；使用者之後可在標籤上指定別的格式
        ws.write_datetime_with_format(1, 0, &d, &Format::new().set_num_format("yyyy-mm-dd")).unwrap();
        ws.write_number(1, 1, 12.0).unwrap();
        ws.write_string(1, 2, "文字").unwrap();
        wb.save(&path).unwrap();

        let t = read_table(path.to_str().unwrap(), None).unwrap();
        assert_eq!(t.rows[0][0], "2026-01-05", "預設（自動）照 Excel 儲存格的格式");
        assert_eq!(t.raw.len(), 1);
        assert_eq!(t.raw[0][0], Some(Raw::Date([2026, 1, 5, 0, 0, 0, 0])));
        assert_eq!(t.raw[0][1], Some(Raw::Num(12.0)));
        assert_eq!(t.raw[0][2], None, "文字沒有原始值");

        // 使用者指定的格式，用原始值重新格式化
        let date = t.raw[0][0].unwrap();
        assert_eq!(format_raw(&date, "yyyy/mm/dd").unwrap(), "2026/01/05");
        assert_eq!(format_raw(&date, "yyyy/m/d").unwrap(), "2026/1/5");
        assert_eq!(format_raw(&date, "yyyy年m月d日").unwrap(), "2026年1月5日");
        assert_eq!(format_raw(&date, "[$-404]e/m/d").unwrap(), "115/1/5");
        assert_eq!(format_raw(&date, "0.00"), None, "日期不能套用數字格式");
        let n = t.raw[0][1].unwrap();
        assert_eq!(format_raw(&n, "0000").unwrap(), "0012");
        assert_eq!(format_raw(&n, "0.00").unwrap(), "12.00");
        assert_eq!(format_raw(&n, "yyyy/mm/dd"), None, "數字不能套用日期格式");
        assert_eq!(format_raw(&n, "不是格式@"), None);
    }

    #[test]
    fn csv_has_no_raw_values() {
        let path = tmp("noraw.csv");
        std::fs::write(&path, "日期,數量\n2026/11/18,5\n").unwrap();
        let t = read_table(path.to_str().unwrap(), None).unwrap();
        assert!(t.raw.is_empty() && t.styles.is_empty());
        assert_eq!(t.rows[0], s(&["2026/11/18", "5"]), "CSV 的文字原樣保留");
    }

    #[test]
    fn csv_still_skips_blank_rows_and_has_no_styles() {
        let path = tmp("blank.csv");
        std::fs::write(&path, "品名,價格\n蘋果,30\n,\n香蕉,20\n").unwrap();
        let t = read_table(path.to_str().unwrap(), None).unwrap();
        assert_eq!(t.rows, vec![s(&["蘋果", "30"]), s(&["香蕉", "20"])]);
        assert_eq!(t.row_numbers, vec![1, 2]);
        assert!(t.styles.is_empty());
    }

    #[test]
    fn xlsx_roundtrip_with_multiple_sheets() {
        use rust_xlsxwriter::Workbook;
        let path = tmp("roundtrip.xlsx");
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("商品").unwrap();
        ws.write_string(0, 0, "品名").unwrap();
        ws.write_string(0, 1, "價格").unwrap();
        ws.write_string(1, 0, "蘋果").unwrap();
        ws.write_number(1, 1, 30.0).unwrap();
        ws.write_string(2, 0, "香蕉").unwrap();
        ws.write_number(2, 1, 12.5).unwrap();
        let ws2 = wb.add_worksheet();
        ws2.set_name("其他").unwrap();
        ws2.write_string(0, 0, "編號").unwrap();
        ws2.write_string(1, 0, "A001").unwrap();
        wb.save(&path).unwrap();

        let p = path.to_str().unwrap();
        let t = read_table(p, None).unwrap();
        assert_eq!(t.sheets, s(&["商品", "其他"]));
        assert_eq!(t.sheet, "商品");
        assert_eq!(t.headers, s(&["品名", "價格"]));
        assert_eq!(t.rows, vec![s(&["蘋果", "30"]), s(&["香蕉", "12.5"])]);

        let t2 = read_table(p, Some("其他")).unwrap();
        assert_eq!(t2.headers, s(&["編號"]));
        assert_eq!(t2.rows, vec![s(&["A001"])]);

        // 不存在的工作表名稱 → 退回第一個
        assert_eq!(read_table(p, Some("不存在")).unwrap().sheet, "商品");
    }

    #[test]
    fn bundled_samples_parse() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("samples");
        let xlsx = dir.join("商品清單.xlsx");
        let csv = dir.join("商品清單-big5.csv");
        if !xlsx.exists() || !csv.exists() {
            return; // 範例檔由 `cargo run --example make_samples` 產生
        }
        let t = read_table(xlsx.to_str().unwrap(), None).unwrap();
        assert_eq!(t.sheets, s(&["商品", "員工"]));
        assert_eq!(t.headers, s(&["品名", "價格", "條碼", "產地", "有效日期"]));
        assert_eq!(t.rows.len(), 5);
        // 範例檔的日期儲存格格式是 yyyy/mm/dd，標籤上要照 Excel 顯示成 2027/01/02（舊版會變成 2027-01-02）
        assert_eq!(t.rows[1], s(&["香蕉", "12.5", "4710088000028", "菲律賓", "2027/01/02"]));
        let e = read_table(xlsx.to_str().unwrap(), Some("員工")).unwrap();
        assert_eq!(e.rows, vec![s(&["王小明", "A001"]), s(&["陳美麗", "A002"])]);

        let c = read_table(csv.to_str().unwrap(), None).unwrap();
        assert_eq!(c.headers, s(&["品名", "價格", "條碼", "產地"]));
        assert_eq!(c.rows[2], s(&["橘子", "25", "4710088000035", "日本"]));
    }

    #[test]
    fn csv_file_by_extension() {
        let path = tmp("sample.csv");
        let (bytes, _, _) = encoding_rs::BIG5.encode("品名,價格\n蘋果,30\n");
        std::fs::write(&path, &*bytes).unwrap();
        let t = read_table(path.to_str().unwrap(), None).unwrap();
        assert_eq!(t.headers, s(&["品名", "價格"]));
        assert_eq!(t.rows, vec![s(&["蘋果", "30"])]);
    }
}
