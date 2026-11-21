//! 伺服器型資料庫（SQL Server、MySQL／MariaDB、PostgreSQL）的原生連線：用純 Rust 的用戶端函式庫直接連，
//! **不需要使用者另外安裝 ODBC 驅動程式**。
//!
//! - SQL Server：`tiberius`（TDS 通訊協定，支援帳號密碼與 Windows 整合驗證）
//! - MySQL／MariaDB：`mysql`
//! - PostgreSQL：`postgres`（同步介面，底層是 tokio-postgres，必須 >= 0.7.18）
//! - 加密連線一律走 Windows 內建的 SChannel（native-tls），不另外帶加密函式庫。
//!
//! 安全原則：
//! - 一律**唯讀**：自訂查詢只收單一 SELECT／WITH；連線後再要求資料庫把交易設成唯讀（MySQL、PostgreSQL）。
//!   SQL Server 沒有這種連線設定，所以請使用者用只有讀取權限的帳號。
//! - 預設**加密並驗證伺服器憑證**；使用者可以明確改成「信任自簽憑證」或「不加密」（只該用在可信任的內部網路）。
//! - 連線逾時 8 秒、查詢逾時 60 秒，最多讀 100,000 列、單一文字欄位最多 4,096 字元。
//! - 密碼只存在記憶體，不寫入任何檔案、不出現在錯誤訊息或畫面上的來源名稱。
//!
//! 來源字串（前端傳來的 `path`）：`net:` 後面接 JSON：
//! `{"kind":"mssql|mysql|postgres","host":"…","port":1433,"database":"…","user":"…","password":"…","winauth":false,"security":"verify|trust|off"}`

use crate::dbsource::{check_select, finish, listing, parse_datetime, pick, show_number, trim_decimal, Cell, MAX_ROWS, MAX_TEXT};
use crate::sheet::Grid;
use serde::Deserialize;
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
const QUERY_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Conn {
    kind: String,
    host: String,
    #[serde(default)]
    port: Option<u16>,
    database: String,
    #[serde(default)]
    user: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    winauth: bool,
    #[serde(default = "verify")]
    security: String,
}

fn verify() -> String {
    "verify".into()
}

/// 解析並檢查連線設定
fn parse(spec: &str) -> Result<Conn, String> {
    let c: Conn = serde_json::from_str(spec).map_err(|e| format!("資料庫連線設定不正確：{e}"))?;
    if !matches!(c.kind.as_str(), "mssql" | "mysql" | "postgres") {
        return Err(format!("不支援的資料庫類型：{}", c.kind));
    }
    // 伺服器位址只允許主機名稱／IP（含 IPv6 的冒號與方括號），避免奇怪字元被當成別的參數
    let ok_host = !c.host.is_empty() && c.host.len() <= 253 && c.host.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | ':' | '[' | ']'));
    if !ok_host {
        return Err("伺服器位址格式不正確".into());
    }
    if c.database.trim().is_empty() || c.database.chars().any(|ch| ch.is_control()) {
        return Err("資料庫名稱格式不正確".into());
    }
    if !matches!(c.security.as_str(), "verify" | "trust" | "off") {
        return Err(format!("資料庫連線設定不正確：security={}", c.security));
    }
    Ok(c)
}

pub fn is_net_source(path: &str) -> bool {
    path.starts_with("net:")
}

pub(crate) fn read(path: &str, sheet: Option<&str>) -> Result<(Vec<String>, String, Grid), String> {
    let c = parse(path.strip_prefix("net:").unwrap_or(path))?;
    match c.kind.as_str() {
        "mssql" => read_mssql(&c, sheet),
        "mysql" => read_mysql(&c, sheet),
        _ => read_postgres(&c, sheet),
    }
}

/// 一個可選的資料表：顯示名稱＋已加上引號的識別字
struct Table {
    display: String,
    ident: String,
}

enum Source {
    Table(String),
    Sql(String),
}

/// 依 `sheet` 決定讀哪個資料表或自訂查詢
fn choose(sheet: Option<&str>, tables: &[Table]) -> Result<(String, Source), String> {
    let names: Vec<String> = tables.iter().map(|t| t.display.clone()).collect();
    let chosen = pick(sheet, &names)?;
    if let Some(q) = chosen.strip_prefix("sql:") {
        let q = check_select(q)?.to_string();
        return Ok((chosen, Source::Sql(q)));
    }
    let ident = tables.iter().find(|t| t.display == chosen).map(|t| t.ident.clone()).unwrap_or_default();
    Ok((chosen, Source::Table(ident)))
}

/// 錯誤連同底層原因一起顯示（postgres 的 Display 只有「error connecting to server」，真正原因在 source）
fn chain(e: &dyn std::error::Error) -> String {
    let mut s = e.to_string();
    let mut cur = e.source();
    while let Some(c) = cur {
        let t = c.to_string();
        if !s.contains(&t) {
            s.push_str("：");
            s.push_str(&t);
        }
        cur = c.source();
    }
    s
}

fn truncate(s: &str) -> String {
    if s.chars().count() > MAX_TEXT {
        s.chars().take(MAX_TEXT).collect()
    } else {
        s.to_string()
    }
}

// ---------- 日期（SQL Server 的日期是「天數＋時間單位」，自己轉成年月日）----------

/// 自 1970-01-01 起算的天數 → (年, 月, 日)（Howard Hinnant 的 civil_from_days）
fn civil_from_days(z: i64) -> (u32, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    ((if m <= 2 { y + 1 } else { y }) as u32, m, d)
}

/// 十進位數字顯示（value 是放大 10^scale 倍的整數）
fn decimal_str(value: i128, scale: u8) -> String {
    let neg = value < 0;
    let digits = value.unsigned_abs().to_string();
    let scale = scale as usize;
    let body = if scale == 0 {
        digits
    } else {
        let padded = format!("{digits:0>width$}", width = scale + 1);
        let (int, frac) = padded.split_at(padded.len() - scale);
        trim_decimal(&format!("{int}.{frac}"))
    };
    if neg { format!("-{body}") } else { body }
}

// ---------- SQL Server（tiberius）----------

fn mssql_cell(d: &tiberius::ColumnData<'static>) -> Cell {
    use tiberius::ColumnData as D;
    let num = |v: f64, s: String| Cell::Num(v, s);
    match d {
        D::U8(Some(v)) => num(*v as f64, v.to_string()),
        D::I16(Some(v)) => num(*v as f64, v.to_string()),
        D::I32(Some(v)) => num(*v as f64, v.to_string()),
        D::I64(Some(v)) => num(*v as f64, v.to_string()),
        D::F32(Some(v)) => num(*v as f64, show_number(*v as f64)),
        D::F64(Some(v)) => num(*v, show_number(*v)),
        D::Bit(Some(b)) => Cell::Text(if *b { "1" } else { "0" }.into()),
        D::String(Some(s)) => Cell::Text(truncate(s)),
        D::Guid(Some(u)) => Cell::Text(u.to_string()),
        D::Binary(Some(_)) => Cell::Text("(BLOB)".into()),
        D::Xml(Some(x)) => Cell::Text(truncate(&x.to_string())),
        D::Numeric(Some(n)) => {
            let s = decimal_str(n.value(), n.scale());
            num(s.parse().unwrap_or(0.0), s)
        }
        D::Date(Some(dt)) => {
            let (y, m, day) = civil_from_days(dt.days() as i64 - 719_162); // 自 0001-01-01 起算
            Cell::Date([y, m, day, 0, 0, 0, 0])
        }
        D::DateTime(Some(dt)) => {
            let (y, m, day) = civil_from_days(dt.days() as i64 - 25_567); // 自 1900-01-01 起算，時間是 1/300 秒
            let f = dt.seconds_fragments();
            let secs = f / 300;
            Cell::Date([y, m, day, secs / 3600, secs / 60 % 60, secs % 60, (f % 300) * 1000 / 300])
        }
        D::SmallDateTime(Some(dt)) => {
            let (y, m, day) = civil_from_days(dt.days() as i64 - 25_567);
            let mins = dt.seconds_fragments() as u32; // 實際單位是分鐘
            Cell::Date([y, m, day, mins / 60, mins % 60, 0, 0])
        }
        D::DateTime2(Some(dt)) => mssql_datetime2(dt),
        D::DateTimeOffset(Some(dt)) => mssql_datetime2(&dt.datetime2()), // 顯示當地時間，不換算時區
        D::Time(Some(t)) => {
            let (secs, _) = time_parts(t);
            Cell::Text(format!("{:02}:{:02}:{:02}", secs / 3600, secs / 60 % 60, secs % 60))
        }
        _ => Cell::Null,
    }
}

fn time_parts(t: &tiberius::time::Time) -> (u32, u32) {
    let div = 10u64.pow(t.scale() as u32);
    ((t.increments() / div) as u32, ((t.increments() % div) * 1000 / div) as u32)
}

fn mssql_datetime2(dt: &tiberius::time::DateTime2) -> Cell {
    let (y, m, day) = civil_from_days(dt.date().days() as i64 - 719_162);
    let (secs, ms) = time_parts(&dt.time());
    Cell::Date([y, m, day, secs / 3600, secs / 60 % 60, secs % 60, ms])
}

fn read_mssql(c: &Conn, sheet: Option<&str>) -> Result<(Vec<String>, String, Grid), String> {
    use futures_util::TryStreamExt;
    use tiberius::{AuthMethod, Client, Config, EncryptionLevel};
    use tokio::net::TcpStream;
    use tokio_util::compat::TokioAsyncWriteCompatExt;

    let mut cfg = Config::new();
    cfg.host(&c.host);
    cfg.port(c.port.unwrap_or(1433));
    cfg.database(&c.database);
    cfg.application_name("Label Printer");
    cfg.readonly(true);
    cfg.command_timeout(Some(QUERY_TIMEOUT));
    cfg.handshake_timeout(Some(CONNECT_TIMEOUT));
    cfg.authentication(if c.winauth { AuthMethod::Integrated } else { AuthMethod::sql_server(&c.user, &c.password) });
    match c.security.as_str() {
        "off" => cfg.encryption(EncryptionLevel::NotSupported),
        "trust" => {
            cfg.encryption(EncryptionLevel::Required);
            cfg.trust_cert();
        }
        _ => cfg.encryption(EncryptionLevel::Required),
    }
    let addr = cfg.get_addr();
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| format!("無法連線到資料庫：{e}"))?;
    rt.block_on(async {
        let tcp = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(&addr))
            .await
            .map_err(|_| format!("連線逾時：{addr} 沒有回應"))?
            .map_err(|e| format!("無法連線到資料庫：{e}"))?;
        tcp.set_nodelay(true).ok();
        let mut client = tokio::time::timeout(CONNECT_TIMEOUT * 2, Client::connect(cfg, tcp.compat_write()))
            .await
            .map_err(|_| format!("連線逾時：{addr} 沒有回應"))?
            .map_err(|e| format!("無法連線到資料庫：{e}"))?;

        let rows = client
            .simple_query("SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE IN ('BASE TABLE','VIEW') ORDER BY CASE WHEN TABLE_SCHEMA = 'dbo' THEN 0 ELSE 1 END, 1, 2")
            .await
            .map_err(|e| format!("查詢失敗：{e}"))?
            .into_first_result()
            .await
            .map_err(|e| format!("查詢失敗：{e}"))?;
        let tables: Vec<Table> = rows
            .iter()
            .filter_map(|r| Some((r.get::<&str, _>(0)?, r.get::<&str, _>(1)?)))
            .map(|(schema, name)| Table {
                display: if schema == "dbo" { name.to_string() } else { format!("{schema}.{name}") },
                ident: format!("[{}].[{}]", schema.replace(']', "]]"), name.replace(']', "]]")),
            })
            .collect();
        let (chosen, src) = choose(sheet, &tables)?;
        let sql = match src {
            Source::Table(ident) => format!("SELECT TOP {} * FROM {ident}", MAX_ROWS + 1),
            Source::Sql(q) => q,
        };
        let mut stream = client.simple_query(sql).await.map_err(|e| format!("查詢失敗：{e}"))?;
        let headers: Vec<String> = stream
            .columns()
            .await
            .map_err(|e| format!("查詢失敗：{e}"))?
            .map(|cols| cols.iter().map(|c| c.name().to_string()).collect())
            .unwrap_or_default();
        let mut out: Vec<Vec<Cell>> = Vec::new();
        let mut rows = stream.into_row_stream();
        while let Some(row) = rows.try_next().await.map_err(|e| format!("讀取資料失敗：{e}"))? {
            if out.len() >= MAX_ROWS {
                return Err(format!("資料超過 {MAX_ROWS} 列，請改用 SQL 查詢縮小範圍"));
            }
            out.push(row.into_iter().map(|d| mssql_cell(&d)).collect());
        }
        Ok((listing(&tables.iter().map(|t| t.display.clone()).collect::<Vec<_>>(), &chosen), chosen, finish(headers, out)))
    })
}

// ---------- MySQL／MariaDB ----------

fn mysql_quote(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

fn read_mysql(c: &Conn, sheet: Option<&str>) -> Result<(Vec<String>, String, Grid), String> {
    use mysql::consts::{ColumnFlags, ColumnType as T};
    use mysql::prelude::Queryable;
    use mysql::{Conn as MyConn, OptsBuilder, SslOpts, Value};

    let ssl = match c.security.as_str() {
        "off" => None,
        "trust" => Some(SslOpts::default().with_danger_accept_invalid_certs(true).with_danger_skip_domain_validation(true)),
        _ => Some(SslOpts::default()),
    };
    let opts = OptsBuilder::new()
        .ip_or_hostname(Some(c.host.clone()))
        .tcp_port(c.port.unwrap_or(3306))
        .user(Some(c.user.clone()))
        .pass(Some(c.password.clone()))
        .db_name(Some(c.database.clone()))
        .tcp_connect_timeout(Some(CONNECT_TIMEOUT))
        .read_timeout(Some(QUERY_TIMEOUT))
        .write_timeout(Some(QUERY_TIMEOUT))
        .ssl_opts(ssl);
    let mut conn = MyConn::new(opts).map_err(|e| format!("無法連線到資料庫：{e}"))?;
    conn.query_drop("SET SESSION TRANSACTION READ ONLY").map_err(|e| format!("查詢失敗：{e}"))?;

    let names: Vec<String> = conn
        .query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME")
        .map_err(|e| format!("查詢失敗：{e}"))?;
    let tables: Vec<Table> = names.into_iter().map(|n| Table { ident: mysql_quote(&n), display: n }).collect();
    let (chosen, src) = choose(sheet, &tables)?;
    let sql = match src {
        Source::Table(ident) => format!("SELECT * FROM {ident} LIMIT {}", MAX_ROWS + 1),
        Source::Sql(q) => format!("SELECT * FROM ({q}) AS _q LIMIT {}", MAX_ROWS + 1),
    };
    let mut rs = conn.query_iter(sql).map_err(|e| format!("查詢失敗：{e}"))?;
    let cols: Vec<(String, T, ColumnFlags)> = rs.columns().as_ref().iter().map(|c| (c.name_str().to_string(), c.column_type(), c.flags())).collect();
    let headers: Vec<String> = cols.iter().map(|c| c.0.clone()).collect();
    let mut out: Vec<Vec<Cell>> = Vec::new();
    for row in rs.by_ref() {
        let row = row.map_err(|e| format!("讀取資料失敗：{e}"))?;
        if out.len() >= MAX_ROWS {
            return Err(format!("資料超過 {MAX_ROWS} 列，請改用 SQL 查詢縮小範圍"));
        }
        // 文字通訊協定：所有值都是文字（Bytes），依欄位型別再解讀
        let cells = row
            .unwrap()
            .into_iter()
            .zip(&cols)
            .map(|(v, (_, ty, flags))| match v {
                Value::Bytes(b) => {
                    let Ok(s) = std::str::from_utf8(&b) else { return Cell::Text("(BLOB)".into()) };
                    let binary_blob = flags.contains(ColumnFlags::BINARY_FLAG) && matches!(ty, T::MYSQL_TYPE_BLOB | T::MYSQL_TYPE_TINY_BLOB | T::MYSQL_TYPE_MEDIUM_BLOB | T::MYSQL_TYPE_LONG_BLOB);
                    if binary_blob {
                        return Cell::Text("(BLOB)".into());
                    }
                    match ty {
                        T::MYSQL_TYPE_TINY | T::MYSQL_TYPE_SHORT | T::MYSQL_TYPE_LONG | T::MYSQL_TYPE_LONGLONG | T::MYSQL_TYPE_INT24 | T::MYSQL_TYPE_FLOAT | T::MYSQL_TYPE_DOUBLE | T::MYSQL_TYPE_DECIMAL | T::MYSQL_TYPE_NEWDECIMAL => {
                            match s.parse::<f64>() {
                                Ok(n) => Cell::Num(n, trim_decimal(s)),
                                Err(_) => Cell::Text(truncate(s)),
                            }
                        }
                        T::MYSQL_TYPE_DATE | T::MYSQL_TYPE_DATETIME | T::MYSQL_TYPE_TIMESTAMP | T::MYSQL_TYPE_NEWDATE => {
                            parse_datetime(s).map(Cell::Date).unwrap_or_else(|| Cell::Text(truncate(s))) // 0000-00-00 這類無效日期維持文字
                        }
                        _ => Cell::Text(truncate(s)),
                    }
                }
                Value::NULL => Cell::Null,
                other => Cell::Text(truncate(&other.as_sql(true).trim_matches('\'').to_string())),
            })
            .collect();
        out.push(cells);
    }
    drop(rs);
    Ok((listing(&tables.iter().map(|t| t.display.clone()).collect::<Vec<_>>(), &chosen), chosen, finish(headers, out)))
}

// ---------- PostgreSQL ----------

fn pg_quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn read_postgres(c: &Conn, sheet: Option<&str>) -> Result<(Vec<String>, String, Grid), String> {
    use postgres::types::Type;
    use postgres::config::SslMode;
    use postgres::{Config, NoTls, SimpleQueryMessage};

    let mut cfg = Config::new();
    cfg.host(&c.host).port(c.port.unwrap_or(5432)).user(&c.user).password(&c.password).dbname(&c.database).application_name("Label Printer").connect_timeout(CONNECT_TIMEOUT);
    let mut client = if c.security == "off" {
        cfg.ssl_mode(SslMode::Disable);
        cfg.connect(NoTls)
    } else {
        cfg.ssl_mode(SslMode::Require);
        let tls = native_tls::TlsConnector::builder()
            .danger_accept_invalid_certs(c.security == "trust")
            .danger_accept_invalid_hostnames(c.security == "trust")
            .build()
            .map_err(|e| format!("無法連線到資料庫：{e}"))?;
        cfg.connect(postgres_native_tls::MakeTlsConnector::new(tls))
    }
    .map_err(|e| format!("無法連線到資料庫：{}", chain(&e)))?;
    client
        .batch_execute(&format!("SET statement_timeout = {}; SET default_transaction_read_only = on", QUERY_TIMEOUT.as_millis()))
        .map_err(|e| format!("查詢失敗：{e}"))?;

    let rows = client
        .simple_query("SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY (table_schema <> 'public'), 1, 2")
        .map_err(|e| format!("查詢失敗：{e}"))?;
    let mut tables: Vec<Table> = Vec::new();
    for m in &rows {
        if let SimpleQueryMessage::Row(r) = m {
            if let (Some(schema), Some(name)) = (r.get(0), r.get(1)) {
                tables.push(Table {
                    display: if schema == "public" { name.to_string() } else { format!("{schema}.{name}") },
                    ident: format!("{}.{}", pg_quote(schema), pg_quote(name)),
                });
            }
        }
    }
    let (chosen, src) = choose(sheet, &tables)?;
    let sql = match src {
        Source::Table(ident) => format!("SELECT * FROM {ident} LIMIT {}", MAX_ROWS + 1),
        Source::Sql(q) => format!("SELECT * FROM ({q}) AS _q LIMIT {}", MAX_ROWS + 1),
    };
    // 先 prepare 取得欄位型別（簡單查詢只回文字，不帶型別），再用簡單查詢讀資料（全部是文字，由型別決定怎麼解讀）
    let stmt = client.prepare(&sql).map_err(|e| format!("查詢失敗：{e}"))?;
    let cols: Vec<(String, Type)> = stmt.columns().iter().map(|c| (c.name().to_string(), c.type_().clone())).collect();
    let headers: Vec<String> = cols.iter().map(|c| c.0.clone()).collect();
    let msgs = client.simple_query(&sql).map_err(|e| format!("讀取資料失敗：{e}"))?;
    let mut out: Vec<Vec<Cell>> = Vec::new();
    for m in msgs {
        let SimpleQueryMessage::Row(r) = m else { continue };
        if out.len() >= MAX_ROWS {
            return Err(format!("資料超過 {MAX_ROWS} 列，請改用 SQL 查詢縮小範圍"));
        }
        out.push(
            cols.iter()
                .enumerate()
                .map(|(i, (_, ty))| match r.get(i) {
                    None => Cell::Null,
                    Some(s) => pg_cell(s, ty),
                })
                .collect(),
        );
    }
    Ok((listing(&tables.iter().map(|t| t.display.clone()).collect::<Vec<_>>(), &chosen), chosen, finish(headers, out)))
}

fn pg_cell(s: &str, ty: &postgres::types::Type) -> Cell {
    use postgres::types::Type;
    if *ty == Type::INT2 || *ty == Type::INT4 || *ty == Type::INT8 || *ty == Type::FLOAT4 || *ty == Type::FLOAT8 || *ty == Type::NUMERIC || *ty == Type::OID {
        return match s.parse::<f64>() {
            Ok(n) if n.is_finite() => Cell::Num(n, trim_decimal(s)),
            _ => Cell::Text(truncate(s)), // NaN、Infinity 等不是一般數字，維持文字
        };
    }
    if *ty == Type::DATE || *ty == Type::TIMESTAMP || *ty == Type::TIMESTAMPTZ {
        // timestamptz 的文字結尾帶時區（+08、-05:30），只取當地的日期時間
        let cut = if *ty == Type::TIMESTAMPTZ { s.rfind(['+', '-']).filter(|&i| i > 10).map(|i| &s[..i]).unwrap_or(s) } else { s };
        return parse_datetime(cut).map(Cell::Date).unwrap_or_else(|| Cell::Text(truncate(s)));
    }
    if *ty == Type::BOOL {
        return Cell::Text(if s == "t" { "true" } else { "false" }.into());
    }
    if *ty == Type::BYTEA {
        return Cell::Text("(BLOB)".into());
    }
    Cell::Text(truncate(s))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_453), (2025, 12, 31));
        assert_eq!(civil_from_days(-719_162), (1, 1, 1)); // 0001-01-01
        assert_eq!(civil_from_days(19_782), (2024, 2, 29)); // 閏日
    }

    #[test]
    fn sql_server_datetime_values() {
        use tiberius::time::{Date, DateTime, DateTime2, SmallDateTime, Time};
        use tiberius::ColumnData as D;
        // 2026-11-21 是 1970 年起第 20_778 天、1900 年起第 46_345 天
        let (y, m, d) = civil_from_days(20_778);
        assert_eq!((y, m, d), (2026, 11, 21));
        match mssql_cell(&D::DateTime(Some(DateTime::new(46_345, 300 * (13 * 3600 + 5 * 60 + 9) + 150)))) {
            Cell::Date(p) => assert_eq!(p, [2026, 11, 21, 13, 5, 9, 500]),
            _ => panic!("不是日期"),
        }
        match mssql_cell(&D::SmallDateTime(Some(SmallDateTime::new(46_345, 13 * 60 + 5)))) {
            Cell::Date(p) => assert_eq!(p, [2026, 11, 21, 13, 5, 0, 0]),
            _ => panic!("不是日期"),
        }
        match mssql_cell(&D::Date(Some(Date::new(719_162 + 20_453)))) {
            Cell::Date(p) => assert_eq!(&p[..3], &[2025, 12, 31]),
            _ => panic!("不是日期"),
        }
        let t = Time::new((7 * 3600 + 8 * 60 + 9) * 10_000_000 + 5_000_000, 7);
        match mssql_cell(&D::Time(Some(t))) {
            Cell::Text(s) => assert_eq!(s, "07:08:09"),
            _ => panic!("不是時間"),
        }
        match mssql_cell(&D::DateTime2(Some(DateTime2::new(Date::new(719_162), t)))) {
            Cell::Date(p) => assert_eq!(p, [1970, 1, 1, 7, 8, 9, 500]),
            _ => panic!("不是日期"),
        }
    }

    #[test]
    fn decimals_are_shown_without_trailing_zeros() {
        assert_eq!(decimal_str(1250, 2), "12.5");
        assert_eq!(decimal_str(-5, 3), "-0.005");
        assert_eq!(decimal_str(42, 0), "42");
        assert_eq!(decimal_str(100, 2), "1");
        assert_eq!(decimal_str(0, 4), "0");
    }

    #[test]
    fn postgres_text_values_follow_the_column_type() {
        use postgres::types::Type;
        assert!(matches!(pg_cell("12.50", &Type::NUMERIC), Cell::Num(n, ref s) if n == 12.5 && s == "12.5"));
        assert!(matches!(pg_cell("NaN", &Type::NUMERIC), Cell::Text(_)));
        assert!(matches!(pg_cell("2026-11-21", &Type::DATE), Cell::Date([2026, 11, 21, 0, 0, 0, 0])));
        assert!(matches!(pg_cell("2026-11-21 13:05:09.250+08", &Type::TIMESTAMPTZ), Cell::Date([2026, 11, 21, 13, 5, 9, 250])));
        assert!(matches!(pg_cell("2026-11-21 13:05:09", &Type::TIMESTAMP), Cell::Date([2026, 11, 21, 13, 5, 9, 0])));
        assert!(matches!(pg_cell("t", &Type::BOOL), Cell::Text(ref s) if s == "true"));
        assert!(matches!(pg_cell("\\xdeadbeef", &Type::BYTEA), Cell::Text(ref s) if s == "(BLOB)"));
        assert!(matches!(pg_cell("hello", &Type::TEXT), Cell::Text(ref s) if s == "hello"));
    }

    #[test]
    fn connection_settings_are_validated() {
        let ok = r#"{"kind":"mysql","host":"db.example.com","database":"shop","user":"u","password":"p"}"#;
        assert!(parse(ok).is_ok());
        for bad in [
            r#"{"kind":"oracle","host":"h","database":"d"}"#,
            r#"{"kind":"mysql","host":"","database":"d"}"#,
            r#"{"kind":"mysql","host":"h;DROP","database":"d"}"#,
            r#"{"kind":"mysql","host":"h h","database":"d"}"#,
            r#"{"kind":"mysql","host":"h","database":""}"#,
            r#"{"kind":"mysql","host":"h","database":"d","security":"whatever"}"#,
            "not json",
        ] {
            assert!(parse(bad).is_err(), "{bad}");
        }
        assert_eq!(parse(ok).unwrap().security, "verify", "預設要加密並驗證憑證");
    }

    #[test]
    fn custom_queries_are_read_only() {
        let t = vec![Table { display: "items".into(), ident: "`items`".into() }];
        assert!(matches!(choose(Some("sql:select 1"), &t), Ok((_, Source::Sql(_)))));
        for bad in ["sql:drop table items", "sql:select 1; select 2", "sql:update items set a=1", "sql:"] {
            assert!(choose(Some(bad), &t).is_err(), "{bad}");
        }
        assert!(matches!(choose(Some("items"), &t), Ok((_, Source::Table(ref i))) if i == "`items`"));
        assert!(matches!(choose(None, &t), Ok((ref n, _)) if n == "items"));
    }

    /// 手動測試（不需要任何資料庫）：三種資料庫連不上的主機都要在逾時內回傳有內容的錯誤。
    ///   cargo test --manifest-path src-tauri/Cargo.toml native_clients_report -- --ignored --nocapture
    #[test]
    #[ignore]
    fn native_clients_report_unreachable_hosts() {
        for kind in ["mssql", "mysql", "postgres"] {
            for security in ["verify", "off"] {
                let t = std::time::Instant::now();
                let spec = format!(r#"{{"kind":"{kind}","host":"127.0.0.1","port":1,"database":"d","user":"u","password":"p","security":"{security}"}}"#);
                let msg = read(&format!("net:{spec}"), None).err().expect("應該連線失敗");
                println!("{kind}/{security}: {:?} → {msg}", t.elapsed());
                assert!(msg.len() > 8 && !msg.contains("\"p\""), "{msg}");
                assert!(t.elapsed() < Duration::from_secs(20));
            }
        }
    }

    // ---------- 對真實伺服器的整合測試（手動，需要本機的 MariaDB／PostgreSQL）----------
    // 準備：把 .tools/dbtest 的 MariaDB（埠 33061，root 密碼 rootpw，資料庫 shop，唯讀帳號 ro／ropw）與
    //       PostgreSQL（埠 54329，trust，資料庫 shop，角色 ro）啟動，再執行：
    //   cargo test --manifest-path src-tauri/Cargo.toml live_ -- --ignored --nocapture

    fn live(kind: &str, port: u16, user: &str, pass: &str, security: &str, sheet: Option<&str>) -> Result<(Vec<String>, String, Grid), String> {
        let spec = format!(r#"{{"kind":"{kind}","host":"127.0.0.1","port":{port},"database":"shop","user":"{user}","password":"{pass}","security":"{security}"}}"#);
        read(&format!("net:{spec}"), sheet)
    }

    fn raw_num(g: &Grid, r: usize, c: usize) -> Option<f64> {
        match g.raw[r][c] {
            Some(crate::sheet::Raw::Num(n)) => Some(n),
            _ => None,
        }
    }
    fn raw_date(g: &Grid, r: usize, c: usize) -> Option<[u32; 7]> {
        match g.raw[r][c] {
            Some(crate::sheet::Raw::Date(d)) => Some(d),
            _ => None,
        }
    }

    #[test]
    #[ignore]
    fn live_mariadb() {
        let (tables, chosen, _) = live("mysql", 33061, "ro", "ropw", "off", None).unwrap();
        println!("MariaDB 資料表：{tables:?}，預設讀 {chosen}");
        assert_eq!(tables, vec!["cheap", "items"]);
        let (_, _, g) = live("mysql", 33061, "ro", "ropw", "off", Some("items")).unwrap();
        println!("{:#?}", g.rows);
        assert_eq!(g.rows[0], ["id", "name", "price", "qty", "made", "stamp", "note", "pic", "ratio"]);
        let r1 = &g.rows[1];
        assert_eq!((r1[1].as_str(), r1[2].as_str(), r1[3].as_str()), ("螺絲 Screw", "12.5", "100"));
        assert_eq!(raw_num(&g, 1, 2), Some(12.5));
        assert_eq!(raw_date(&g, 1, 4), Some([2026, 11, 21, 0, 0, 0, 0]));
        assert_eq!(raw_date(&g, 1, 5), Some([2026, 11, 21, 13, 5, 9, 0]));
        assert_eq!((r1[6].as_str(), r1[7].as_str()), ("備註一", "(BLOB)"));
        assert_eq!(g.rows[2][3], "", "NULL 要是空白");
        assert_eq!(raw_date(&g, 3, 4), None, "0000-00-00 不是有效日期，維持文字");
        assert_eq!(g.rows[3][4], "0000-00-00");
        assert_eq!(raw_num(&g, 3, 8), Some(1e10));
        // 走和前端相同的入口（read_table → 資料庫分派 → TableData），確認 net: 來源有被接上
        let td = crate::sheet::read_table(r#"net:{"kind":"mysql","host":"127.0.0.1","port":33061,"database":"shop","user":"ro","password":"ropw","security":"off"}"#, Some("items")).unwrap();
        assert_eq!(td.headers.len(), 9);
        assert_eq!(td.rows.len(), 3);
        // 自訂查詢與唯讀
        let (_, ch, g) = live("mysql", 33061, "ro", "ropw", "off", Some("sql:SELECT name, price FROM items WHERE id = 1 ORDER BY name")).unwrap();
        assert!(ch.starts_with("sql:") && g.rows.len() == 2 && g.rows[1][0] == "螺絲 Screw");
        let (_, _, g) = live("mysql", 33061, "ro", "ropw", "off", Some("sql:SELECT @@session.transaction_read_only AS ro")).unwrap();
        assert_eq!(g.rows[1][0], "1", "連線要設成唯讀交易");
        assert!(live("mysql", 33061, "ro", "ropw", "off", Some("sql:DELETE FROM items")).is_err());
        assert!(live("mysql", 33061, "ro", "ropw", "off", Some("sql:SELECT 1; DROP TABLE items")).is_err());
        // 檢視表
        let (_, _, g) = live("mysql", 33061, "ro", "ropw", "off", Some("cheap")).unwrap();
        assert_eq!(g.rows.len(), 3);
        // 安全預設：伺服器沒有 TLS 時，「加密並驗證」要失敗，不能默默降級成明文
        let e = live("mysql", 33061, "ro", "ropw", "verify", None).err().expect("不該降級成明文");
        println!("verify 對自簽憑證的伺服器：{e}");
        assert!(!e.contains("ropw"));
        // 明確選「信任自簽憑證」才連得上（MariaDB 11.8 會自動產生自簽憑證）
        let (_, _, g) = live("mysql", 33061, "ro", "ropw", "trust", Some("sql:SELECT (SELECT VARIABLE_VALUE FROM information_schema.SESSION_STATUS WHERE VARIABLE_NAME = 'Ssl_cipher') AS cipher")).unwrap();
        println!("信任自簽憑證後的連線：{:?}", g.rows[1]);
        assert!(!g.rows[1][0].is_empty(), "要真的走加密（有 cipher）：{:?}", g.rows[1]);
        // 帳密錯誤
        let e = live("mysql", 33061, "ro", "wrong", "off", None).err().expect("密碼錯誤要失敗");
        println!("密碼錯誤：{e}");
        assert!(!e.contains("wrong"), "錯誤訊息不能含密碼：{e}");
    }

    #[test]
    #[ignore]
    fn live_postgres() {
        let (tables, chosen, _) = live("postgres", 54329, "ro", "x", "off", None).unwrap();
        println!("PostgreSQL 資料表：{tables:?}，預設讀 {chosen}");
        assert_eq!(tables, vec!["cheap", "items", "hr.staff"], "public 的資料表排前面，其他 schema 在後");
        let (_, _, g) = live("postgres", 54329, "ro", "x", "off", Some("items")).unwrap();
        println!("{:#?}", g.rows);
        assert_eq!(g.rows[0], ["id", "name", "price", "qty", "made", "stamp", "stz", "note", "pic", "ratio", "ok"]);
        let r1 = &g.rows[1];
        assert_eq!((r1[1].as_str(), r1[2].as_str(), r1[3].as_str()), ("螺絲 Screw", "12.5", "100"));
        assert_eq!(raw_num(&g, 1, 2), Some(12.5));
        assert_eq!(raw_date(&g, 1, 4), Some([2026, 11, 21, 0, 0, 0, 0]));
        assert_eq!(raw_date(&g, 1, 5), Some([2026, 11, 21, 13, 5, 9, 250]));
        assert!(raw_date(&g, 1, 6).is_some(), "timestamptz 也要能當日期：{}", r1[6]);
        assert_eq!((r1[7].as_str(), r1[8].as_str(), r1[10].as_str()), ("備註一", "(BLOB)", "true"));
        assert_eq!(g.rows[2][3], "", "NULL 要是空白");
        assert_eq!(raw_num(&g, 3, 9), Some(1e10));
        // 其他 schema 的資料表
        let (_, _, g) = live("postgres", 54329, "ro", "x", "off", Some("hr.staff")).unwrap();
        assert_eq!((g.rows[1][0].as_str(), g.rows[1][1].as_str()), ("1", "Ann"));
        // 自訂查詢與唯讀
        let (_, _, g) = live("postgres", 54329, "ro", "x", "off", Some("sql:SELECT current_setting('transaction_read_only') AS ro")).unwrap();
        assert_eq!(g.rows[1][0], "on", "連線要設成唯讀交易");
        assert!(live("postgres", 54329, "ro", "x", "off", Some("sql:DELETE FROM items")).is_err());
        let (_, _, g) = live("postgres", 54329, "ro", "x", "off", Some("cheap")).unwrap();
        assert_eq!(g.rows.len(), 3);
        // 安全預設：伺服器用自簽憑證時，「加密並驗證」要失敗；明確選「信任自簽憑證」才連得上，而且真的是加密連線
        // （測試前要讓 PostgreSQL 開 ssl；伺服器沒開 TLS 時 verify 同樣會失敗，不會降級成明文）
        let e = live("postgres", 54329, "ro", "x", "verify", None).err().expect("不該降級成明文");
        println!("verify 對自簽憑證（或沒有 TLS）的伺服器：{e}");
        if let Ok((_, _, g)) = live("postgres", 54329, "ro", "x", "trust", Some("sql:SELECT ssl::text AS encrypted FROM pg_stat_ssl WHERE pid = pg_backend_pid()")) {
            println!("信任自簽憑證後的連線：{:?}", g.rows[1]);
            assert_eq!(g.rows[1][0], "true", "要真的走加密");
        }
        // 不存在的資料庫帳號：要有清楚的錯誤
        let e = live("postgres", 54329, "nobody", "x", "off", Some("items"));
        println!("trust 模式下不存在的角色：{:?}", e.as_ref().err());
    }
}
