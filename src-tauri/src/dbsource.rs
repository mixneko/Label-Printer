//! 資料庫當資料來源：SQLite 檔案、Access（.mdb／.accdb）與任何有 ODBC 驅動程式的資料庫（SQL Server、MySQL、PostgreSQL、Oracle…）。
//!
//! 一律**唯讀**：SQLite 以唯讀開啟；自訂 SQL 只接受單一的 SELECT／WITH 查詢。
//! 結果整理成與 Excel／CSV 相同的「欄位標題 + 資料列」，資料表名稱放進原本的「工作表」下拉（介面稱「資料表」）。
//! 日期與數字欄位另外附原始值（`Raw`），所以標籤上的 `{{欄位|yyyy/mm/dd}}` 這類欄位格式同樣可用。
//!
//! 來源字串（前端傳來的 `path`）：
//! - 檔案路徑：副檔名 db／sqlite／sqlite3／db3／s3db（SQLite）、mdb／accdb（Access，經 ODBC）
//! - `odbc:` 開頭：後面是 ODBC 連線字串（含帳號密碼時只存在記憶體，不寫入任何檔案）
//!
//! 資料表參數（`sheet`）：資料表／檢視表名稱，或 `sql:` 開頭的自訂查詢。

use crate::sheet::{Grid, Raw};
use odbc_api::buffers::{ColumnarBuffer, TextColumn};
use odbc_api::{ConnectionOptions, Cursor, DataType, Environment, ResultSetMetadata};
use rusqlite::types::ValueRef;
use serde::Serialize;
use std::path::Path;

/// 最多讀取的資料列數：太大的資料表會讓畫面卡住，請改用 SQL 查詢縮小範圍
pub(crate) const MAX_ROWS: usize = 100_000;
/// 單一文字欄位最多讀取的字元數（備忘錄、長文字欄位會被截斷）
pub(crate) const MAX_TEXT: usize = 4096;
const BATCH: usize = 512;

fn ext_of(path: &str) -> String {
    Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase()
}

/// 這個來源字串是不是資料庫（交給本模組處理）
pub fn is_db_source(path: &str) -> bool {
    path.starts_with("odbc:") || crate::netdb::is_net_source(path) || matches!(ext_of(path).as_str(), "db" | "sqlite" | "sqlite3" | "db3" | "s3db" | "mdb" | "accdb")
}

/// 一個儲存格的值（讀進來後再轉成顯示文字與原始值）
pub(crate) enum Cell {
    Null,
    Text(String),
    Num(f64, String),
    Date([u32; 7]),
}

impl Cell {
    fn into_pair(self) -> (String, Option<Raw>) {
        match self {
            Cell::Null => (String::new(), None),
            Cell::Text(s) => (s, None),
            Cell::Num(v, shown) => (shown, Some(Raw::Num(v))),
            Cell::Date(p) => (show_date(&p), Some(Raw::Date(p))),
        }
    }
}

/// 日期顯示：只有日期時為 yyyy-mm-dd；有時間才附時間（秒數不為 0 才附秒）
pub(crate) fn show_date(p: &[u32; 7]) -> String {
    let d = format!("{:04}-{:02}-{:02}", p[0], p[1], p[2]);
    if p[3] == 0 && p[4] == 0 && p[5] == 0 {
        d
    } else if p[5] == 0 {
        format!("{d} {:02}:{:02}", p[3], p[4])
    } else {
        format!("{d} {:02}:{:02}:{:02}", p[3], p[4], p[5])
    }
}

/// 解析 `YYYY-MM-DD`、`YYYY/MM/DD`，可接 ` HH:MM[:SS[.fff]]`（分隔也可以是 T）；不是日期回傳 None
pub(crate) fn parse_datetime(s: &str) -> Option<[u32; 7]> {
    let s = s.trim();
    let (date, time) = match s.find([' ', 'T']) {
        Some(i) => (&s[..i], s[i + 1..].trim()),
        None => (s, ""),
    };
    let mut d = date.split(['-', '/']);
    let (y, m, day): (u32, u32, u32) = (d.next()?.parse().ok()?, d.next()?.parse().ok()?, d.next()?.parse().ok()?);
    if d.next().is_some() || !(1..=9999).contains(&y) || !(1..=12).contains(&m) || !(1..=31).contains(&day) {
        return None;
    }
    let (mut h, mut mi, mut sec, mut ms) = (0, 0, 0, 0);
    if !time.is_empty() {
        let time = time.trim_end_matches('Z');
        let (hms, frac) = time.split_once('.').unwrap_or((time, ""));
        let mut t = hms.split(':');
        h = t.next()?.parse().ok()?;
        mi = t.next().unwrap_or("0").parse().ok()?;
        sec = t.next().unwrap_or("0").parse().ok()?;
        if h > 23 || mi > 59 || sec > 59 {
            return None;
        }
        if !frac.is_empty() {
            let f: String = frac.chars().take(3).collect();
            ms = format!("{f:0<3}").parse().ok()?;
        }
    }
    Some([y, m, day, h, mi, sec, ms])
}

pub(crate) fn show_number(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 { format!("{}", v as i64) } else { v.to_string() }
}

/// ODBC 以文字給的數字（例如 DECIMAL 的 "12.5000"）：去掉多餘的小數 0
pub(crate) fn trim_decimal(s: &str) -> String {
    if s.contains('.') && !s.contains(['e', 'E']) {
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        s.to_string()
    }
}

/// 自訂查詢只允許單一 SELECT／WITH（資料庫本身的唯讀保證不一定有，所以這裡先擋）
pub(crate) fn check_select(sql: &str) -> Result<&str, String> {
    let q = sql.trim().trim_end_matches(';').trim();
    let lower = q.to_lowercase();
    if q.is_empty() {
        return Err("SQL 查詢是空的".into());
    }
    if q.contains(';') {
        return Err("只能執行單一查詢（不可包含分號）".into());
    }
    if !(lower.starts_with("select") || lower.starts_with("with")) {
        return Err("只允許 SELECT 查詢（資料來源是唯讀的）".into());
    }
    Ok(q)
}

pub(crate) fn read(path: &str, sheet: Option<&str>) -> Result<(Vec<String>, String, Grid), String> {
    if crate::netdb::is_net_source(path) {
        return crate::netdb::read(path, sheet);
    }
    if let Some(cs) = path.strip_prefix("odbc:") {
        return read_odbc(cs, sheet);
    }
    match ext_of(path).as_str() {
        "mdb" | "accdb" => {
            if !Path::new(path).is_file() {
                return Err(format!("找不到檔案：{path}"));
            }
            read_odbc(&format!("Driver={{Microsoft Access Driver (*.mdb, *.accdb)}};DBQ={path};ReadOnly=1;"), sheet)
        }
        _ => read_sqlite(path, sheet),
    }
}

pub(crate) fn finish(headers: Vec<String>, rows: Vec<Vec<Cell>>) -> Grid {
    let n = headers.len();
    let mut out_rows = vec![headers];
    let mut out_raw: Vec<Vec<Option<Raw>>> = vec![vec![None; n]];
    for r in rows {
        let (strs, raws): (Vec<String>, Vec<Option<Raw>>) = r.into_iter().map(Cell::into_pair).unzip();
        out_rows.push(strs);
        out_raw.push(raws);
    }
    Grid { rows: out_rows, styles: vec![], raw: out_raw, first_row: 1, keep_blank: false }
}

/// 選定的資料表名稱（沒指定或不在清單內時用第一個）；自訂查詢（`sql:` 開頭）原樣保留
pub(crate) fn pick(sheet: Option<&str>, tables: &[String]) -> Result<String, String> {
    match sheet {
        Some(s) if s.starts_with("sql:") => Ok(s.to_string()),
        Some(s) if tables.iter().any(|t| t == s) => Ok(s.to_string()),
        _ => tables.first().cloned().ok_or_else(|| "資料庫裡沒有任何資料表".to_string()),
    }
}

/// 回傳給前端的資料表清單：所有資料表，若目前是自訂查詢就再加上它
pub(crate) fn listing(tables: &[String], chosen: &str) -> Vec<String> {
    let mut v = tables.to_vec();
    if chosen.starts_with("sql:") {
        v.push(chosen.to_string());
    }
    v
}

// ---------- SQLite ----------

fn read_sqlite(path: &str, sheet: Option<&str>) -> Result<(Vec<String>, String, Grid), String> {
    use rusqlite::{Connection, OpenFlags};
    if !Path::new(path).is_file() {
        return Err(format!("找不到檔案：{path}"));
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| format!("無法開啟資料庫：{e}"))?;
    let tables: Vec<String> = {
        let mut st = conn
            .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name")
            .map_err(|e| format!("這不是有效的 SQLite 資料庫：{e}"))?;
        let it = st.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        it.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };
    let chosen = pick(sheet, &tables)?;
    let sql = match chosen.strip_prefix("sql:") {
        Some(q) => check_select(q)?.to_string(),
        None => format!("SELECT * FROM \"{}\"", chosen.replace('"', "\"\"")),
    };
    let mut st = conn.prepare(&sql).map_err(|e| format!("查詢失敗：{e}"))?;
    let headers: Vec<String> = st.column_names().into_iter().map(|s| s.to_string()).collect();
    // 宣告型別含 DATE／TIME 的欄位，文字內容符合日期格式時當作日期（讓欄位格式可用）
    let is_date: Vec<bool> = st
        .columns()
        .map(|c| c.decl_type().map(|t| { let u = t.to_uppercase(); u.contains("DATE") || u.contains("TIME") }).unwrap_or(false))
        .collect();
    let mut rows: Vec<Vec<Cell>> = Vec::new();
    let mut q = st.query([]).map_err(|e| format!("查詢失敗：{e}"))?;
    while let Some(row) = q.next().map_err(|e| format!("讀取資料失敗：{e}"))? {
        if rows.len() >= MAX_ROWS {
            return Err(format!("資料超過 {MAX_ROWS} 列，請改用 SQL 查詢縮小範圍"));
        }
        let mut r = Vec::with_capacity(headers.len());
        for i in 0..headers.len() {
            r.push(match row.get_ref(i).map_err(|e| e.to_string())? {
                ValueRef::Null => Cell::Null,
                ValueRef::Integer(v) => Cell::Num(v as f64, v.to_string()),
                ValueRef::Real(v) => Cell::Num(v, show_number(v)),
                ValueRef::Text(b) => {
                    let s = String::from_utf8_lossy(b).into_owned();
                    match is_date[i].then(|| parse_datetime(&s)).flatten() {
                        Some(d) => Cell::Date(d),
                        None => Cell::Text(s),
                    }
                }
                ValueRef::Blob(_) => Cell::Text("(BLOB)".into()),
            });
        }
        rows.push(r);
    }
    Ok((listing(&tables, &chosen), chosen, finish(headers, rows)))
}

// ---------- ODBC（Access、SQL Server、MySQL、PostgreSQL、Oracle…）----------

fn odbc_err(e: odbc_api::Error) -> String {
    e.to_string()
}

/// 依資料庫回報的引號字元把識別字（資料表名稱）括起來；只有英數與底線時直接使用
fn quote_ident(name: &str, quote: Option<char>) -> String {
    if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return name.to_string();
    }
    match quote {
        Some('[') => format!("[{}]", name.replace(']', "]]")),
        Some(q) if q != ' ' => format!("{q}{}{q}", name.replace(q, &format!("{q}{q}"))),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

fn read_odbc(cs: &str, sheet: Option<&str>) -> Result<(Vec<String>, String, Grid), String> {
    let env = Environment::new().map_err(odbc_err)?;
    let conn = env
        .connect_with_connection_string(cs, ConnectionOptions { login_timeout_sec: Some(8), ..ConnectionOptions::default() }) // 連不上時 8 秒就回報，不要讓使用者等 15 秒以上
        .map_err(|e| format!("無法連線到資料庫：{e}"))?;
    let quote = conn.identifier_quote_char().ok().flatten();

    // 一般資料庫的資料表型別是 TABLE／VIEW；少數驅動（例如 Excel）把工作表標成別的型別，找不到時改列出所有型別
    let mut tables: Vec<String> = Vec::new();
    for kinds in ["TABLE,VIEW", ""] {
        for row in conn.tables("", "", "", kinds).map_err(odbc_err)? {
            let row = row.map_err(odbc_err)?;
            let ty = row.table_type.as_str().ok().flatten().unwrap_or("").to_uppercase();
            if let Ok(Some(name)) = row.table.as_str() {
                // 跳過 Access 的系統資料表與暫存物件
                if !name.is_empty() && !name.starts_with("MSys") && !name.starts_with('~') && !ty.contains("TEMPORARY") {
                    tables.push(name.to_string());
                }
            }
        }
        if !tables.is_empty() {
            break;
        }
    }
    tables.sort();
    tables.dedup();

    let chosen = pick(sheet, &tables)?;
    let sql = match chosen.strip_prefix("sql:") {
        Some(q) => check_select(q)?.to_string(),
        None => format!("SELECT * FROM {}", quote_ident(&chosen, quote)),
    };

    let mut cursor = conn
        .execute(&sql, (), None)
        .map_err(|e| format!("查詢失敗：{e}"))?
        .ok_or("查詢沒有回傳結果")?;
    let ncols = cursor.num_result_cols().map_err(odbc_err)?.max(0) as u16;
    let headers: Vec<String> = cursor.column_names().map_err(odbc_err)?.collect::<Result<_, _>>().map_err(odbc_err)?;
    let types: Vec<DataType> = (1..=ncols).map(|i| cursor.col_data_type(i)).collect::<Result<_, _>>().map_err(odbc_err)?;
    // 文字一律用 UTF-16 緩衝（驅動程式負責轉碼），中文與其他語言才不會依系統碼頁而亂碼
    let bufs: Vec<(u16, TextColumn<u16>)> = (1..=ncols)
        .zip(&types)
        .map(|(i, t)| {
            let len = t.utf16_len().map(|n| n.get()).unwrap_or(MAX_TEXT).clamp(32, MAX_TEXT);
            (i, TextColumn::<u16>::new(BATCH, len))
        })
        .collect();
    let mut block = cursor.bind_buffer(ColumnarBuffer::new(bufs)).map_err(odbc_err)?;

    let mut rows: Vec<Vec<Cell>> = Vec::new();
    while let Some(batch) = block.fetch().map_err(odbc_err)? {
        for r in 0..batch.num_rows() {
            if rows.len() >= MAX_ROWS {
                return Err(format!("資料超過 {MAX_ROWS} 列，請改用 SQL 查詢縮小範圍"));
            }
            let mut out = Vec::with_capacity(ncols as usize);
            for (c, t) in types.iter().enumerate() {
                let text = batch.column(c).get(r).map(String::from_utf16_lossy);
                out.push(match text {
                    None => Cell::Null,
                    Some(s) => classify(t, s),
                });
            }
            rows.push(out);
        }
    }
    Ok((listing(&tables, &chosen), chosen, finish(headers, rows)))
}

/// 依欄位型別把文字轉成儲存格：日期／時間戳 → 日期；數字型別 → 數字（失敗則當文字）；其餘為文字
fn classify(t: &DataType, s: String) -> Cell {
    match t {
        DataType::Date | DataType::Timestamp { .. } => parse_datetime(&s).map(Cell::Date).unwrap_or(Cell::Text(s)),
        DataType::TinyInt | DataType::SmallInt | DataType::Integer | DataType::BigInt | DataType::Real | DataType::Float { .. }
        | DataType::Double | DataType::Decimal { .. } | DataType::Numeric { .. } => match s.trim().parse::<f64>() {
            Ok(v) => Cell::Num(v, trim_decimal(s.trim())),
            Err(_) => Cell::Text(s),
        },
        _ => Cell::Text(s),
    }
}

/// 這台電腦的 ODBC 驅動程式與已設定的資料來源名稱（DSN），給連線對話框當選單
#[derive(Serialize)]
pub struct OdbcSources {
    pub drivers: Vec<String>,
    pub dsns: Vec<String>,
}

pub fn list_sources() -> Result<OdbcSources, String> {
    let env = Environment::new().map_err(odbc_err)?;
    let mut drivers: Vec<String> = env.drivers().map_err(odbc_err)?.into_iter().map(|d| d.description).collect();
    let mut dsns: Vec<String> = env.data_sources().map_err(odbc_err)?.into_iter().map(|d| d.server_name).collect();
    drivers.sort();
    drivers.dedup();
    dsns.sort();
    dsns.dedup();
    Ok(OdbcSources { drivers, dsns })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> String {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("test-tmp");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        let _ = std::fs::remove_file(&p);
        p.to_string_lossy().into_owned()
    }

    fn sample_sqlite(name: &str) -> String {
        let path = tmp(name);
        let c = rusqlite::Connection::open(&path).unwrap();
        c.execute_batch(
            "CREATE TABLE items (id INTEGER, 品名 TEXT, price REAL, expiry DATE, note TEXT);
             INSERT INTO items VALUES (1, '螺絲 M3', 12.5, '2027-11-30', NULL);
             INSERT INTO items VALUES (2, 'Washer \"6\"', 3, '2028-01-31 08:30:00', 'ok');
             CREATE TABLE \"my table\" (a TEXT);
             INSERT INTO \"my table\" VALUES ('x');
             CREATE VIEW v_items AS SELECT id, 品名 FROM items;",
        )
        .unwrap();
        path
    }

    #[test]
    fn detects_db_sources() {
        for p in ["a.db", "A.SQLITE", "x.sqlite3", "y.db3", "z.mdb", "z.ACCDB", "odbc:Driver={SQL Server};"] {
            assert!(is_db_source(p), "{p}");
        }
        for p in ["a.xlsx", "a.csv", "a.txt", "dbfile"] {
            assert!(!is_db_source(p), "{p}");
        }
    }

    #[test]
    fn sqlite_tables_rows_types_and_raw_values() {
        let path = sample_sqlite("db-basic.sqlite");
        let t = crate::sheet::read_table(&path, None).unwrap();
        assert_eq!(t.kind, Some("db"));
        assert_eq!(t.sheets, vec!["items", "my table", "v_items"]);
        assert_eq!(t.sheet, "items");
        assert_eq!(t.headers, vec!["id", "品名", "price", "expiry", "note"]);
        assert_eq!(t.rows[0], vec!["1", "螺絲 M3", "12.5", "2027-11-30", ""]);
        assert_eq!(t.rows[1], vec!["2", "Washer \"6\"", "3", "2028-01-31 08:30", "ok"]);
        assert_eq!(t.row_numbers, vec![1, 2]);
        // 數字與日期附原始值，文字與空值沒有；Excel 的格式碼對它們同樣有效
        assert_eq!(t.raw[0][0], Some(Raw::Num(1.0)));
        assert_eq!(t.raw[0][2], Some(Raw::Num(12.5)));
        assert_eq!(t.raw[0][3], Some(Raw::Date([2027, 11, 30, 0, 0, 0, 0])));
        assert!(t.raw[0][1].is_none() && t.raw[0][4].is_none());
        assert_eq!(crate::sheet::format_raw(t.raw[0][3].as_ref().unwrap(), "yyyy/mm/dd").as_deref(), Some("2027/11/30"));
    }

    #[test]
    fn sqlite_other_tables_views_and_quoted_names() {
        let path = sample_sqlite("db-tables.sqlite");
        let t = crate::sheet::read_table(&path, Some("my table")).unwrap();
        assert_eq!((t.sheet.as_str(), t.headers.clone(), t.rows.clone()), ("my table", vec!["a".to_string()], vec![vec!["x".to_string()]]));
        let v = crate::sheet::read_table(&path, Some("v_items")).unwrap();
        assert_eq!(v.headers, vec!["id", "品名"]);
        // 不存在的名稱退回第一個資料表，不會被拿去組 SQL
        let f = crate::sheet::read_table(&path, Some("items\"; DROP TABLE items; --")).unwrap();
        assert_eq!(f.sheet, "items");
        assert_eq!(crate::sheet::read_table(&path, None).unwrap().rows.len(), 2);
    }

    #[test]
    fn sqlite_custom_query_is_select_only() {
        let path = sample_sqlite("db-query.sqlite");
        let q = "sql:SELECT 品名 AS name, price * 2 AS double FROM items WHERE id = 1;";
        let t = crate::sheet::read_table(&path, Some(q)).unwrap();
        assert_eq!(t.sheet, q);
        assert!(t.sheets.contains(&q.to_string()) && t.sheets.len() == 4);
        assert_eq!(t.headers, vec!["name", "double"]);
        assert_eq!(t.rows, vec![vec!["螺絲 M3".to_string(), "25".to_string()]]);
        for bad in ["sql:DELETE FROM items", "sql:SELECT 1; DROP TABLE items", "sql:  ", "sql:PRAGMA table_info(items)", "sql:INSERT INTO items VALUES (9,'x',1,'2020-01-01','')"] {
            assert!(crate::sheet::read_table(&path, Some(bad)).is_err(), "{bad}");
        }
        // 唯讀開啟：資料沒有被動到
        assert_eq!(crate::sheet::read_table(&path, None).unwrap().rows.len(), 2);
    }

    #[test]
    fn sqlite_errors_are_reported() {
        assert!(crate::sheet::read_table("D:/不存在/none.sqlite", None).unwrap_err().contains("找不到檔案"));
        let bad = tmp("not-a-db.db");
        std::fs::write(&bad, "this is not sqlite").unwrap();
        assert!(crate::sheet::read_table(&bad, None).is_err());
        let empty = tmp("empty.sqlite");
        rusqlite::Connection::open(&empty).unwrap().execute_batch("CREATE TABLE t (a)").unwrap();
        assert_eq!(crate::sheet::read_table(&empty, None).unwrap().rows.len(), 0);
    }

    #[test]
    fn parses_dates_and_trims_decimals() {
        assert_eq!(parse_datetime("2026-11-21"), Some([2026, 11, 21, 0, 0, 0, 0]));
        assert_eq!(parse_datetime("2026/1/5 08:09"), Some([2026, 1, 5, 8, 9, 0, 0]));
        assert_eq!(parse_datetime("2026-11-21T10:30:15.5Z"), Some([2026, 11, 21, 10, 30, 15, 500]));
        assert_eq!(parse_datetime("2026-11-21 10:30:15.000"), Some([2026, 11, 21, 10, 30, 15, 0]));
        for bad in ["hello", "2026-13-01", "2026-11-21 25:00", "12:30", "2026-11", ""] {
            assert_eq!(parse_datetime(bad), None, "{bad}");
        }
        assert_eq!(show_date(&[2026, 11, 21, 10, 30, 15, 0]), "2026-11-21 10:30:15");
        assert_eq!(trim_decimal("12.5000"), "12.5");
        assert_eq!(trim_decimal("12.0000"), "12");
        assert_eq!(trim_decimal("100"), "100");
        assert_eq!(trim_decimal("1.5E+10"), "1.5E+10");
    }

    #[test]
    fn quotes_identifiers_by_driver_quote_char() {
        assert_eq!(quote_ident("items", Some('"')), "items");
        assert_eq!(quote_ident("my table", Some('"')), "\"my table\"");
        assert_eq!(quote_ident("my table", Some('`')), "`my table`");
        assert_eq!(quote_ident("a\"b c", None), "\"a\"\"b c\"");
        assert_eq!(quote_ident("my]table x", Some('[')), "[my]]table x]");
    }


    /// 用這台電腦上的 Excel ODBC 驅動讀範例 xlsx，驗證 ODBC 這條路徑（資料表清單、UTF-16 文字、型別、日期）。
    /// 沒有安裝該驅動時略過（不算失敗）。
    #[test]
    fn odbc_path_with_the_excel_driver() {
        const DRIVER: &str = "Microsoft Excel Driver (*.xls, *.xlsx, *.xlsm, *.xlsb)";
        if !list_sources().map(|s| s.drivers.iter().any(|d| d == DRIVER)).unwrap_or(false) {
            eprintln!("略過：沒有安裝 {DRIVER}");
            return;
        }
        let xlsx = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("samples").join("sample-items.xlsx");
        let cs = format!("odbc:Driver={{{DRIVER}}};DBQ={};ReadOnly=1;", xlsx.canonicalize().unwrap().to_string_lossy().trim_start_matches(r"\?\"));
        // 預設（第一個）資料表就能讀；名稱含空白與單引號的工作表（'Spare Parts$'）也要能讀
        let first = crate::sheet::read_table(&cs, None).unwrap();
        assert_eq!(first.kind, Some("db"));
        assert!(first.sheets.iter().any(|s| s == "Items$") && first.sheets.iter().any(|s| s.contains("Spare Parts")), "{:?}", first.sheets);
        let t = crate::sheet::read_table(&cs, Some("Items$")).unwrap();
        assert_eq!(t.sheet, "Items$");
        assert_eq!(t.headers, vec!["Item", "Code", "Lot", "Expiry"]);
        assert!(!t.rows.is_empty() && t.rows[0][0].contains("Screw"), "{:?}", t.rows.first());
        assert!(matches!(t.raw[0][3], Some(Raw::Date(_))), "到期日應為日期：{:?}", t.raw[0][3]);
        // 自訂查詢（欄位別名、WHERE）
        let q = "sql:SELECT Item AS name, Code FROM [Items$] WHERE Code = 'A-1002'".to_string();
        let r = crate::sheet::read_table(&cs, Some(&q)).unwrap();
        assert_eq!(r.headers, vec!["name", "Code"]);
        assert_eq!(r.rows.len(), 1);
        assert!(crate::sheet::read_table(&cs, Some("sql:DELETE FROM [Items$]")).is_err());
    }

    #[test]
    fn check_select_accepts_only_one_select() {
        assert!(check_select(" SELECT * FROM t; ").is_ok());
        assert!(check_select("with a as (select 1) select * from a").is_ok());
        for bad in ["", "update t set a=1", "select 1; select 2", "drop table t", "exec sp_who"] {
            assert!(check_select(bad).is_err(), "{bad}");
        }
    }

    /// 手動測試（需要本機有 SQL Server 的 ODBC 驅動程式）：連不上的主機要回傳有內容的錯誤訊息，而且不能卡太久。
    ///   cargo test --manifest-path src-tauri/Cargo.toml odbc_unreachable -- --ignored --nocapture
    #[test]
    #[ignore]
    fn odbc_unreachable_host_reports_error() {
        let t = std::time::Instant::now();
        let cs = "Driver={ODBC Driver 17 for SQL Server};Server=127.0.0.1,1;Database=x;UID=u;PWD=p;";
        let r = read(&format!("odbc:{cs}"), None);
        let msg = r.err().expect("應該連線失敗");
        println!("{:?} 後回傳：{msg}", t.elapsed());
        assert!(msg.len() > 12, "錯誤訊息是空的：{msg}");
    }
}
