//! 開啟資料檔前的安全檢查：擋掉會讓程式耗盡記憶體或直接中止的惡意／過大檔案。
//!
//! 背景（2026-11 安全稽核）：calamine 會依「有值儲存格的範圍」一次配置整塊記憶體；
//! 只有 1.4 KB 的 xlsx，把唯一一格放在 XFD1048576，就讓 Rust 配置 512 GB 而**整個程式直接中止**（不是可捕捉的錯誤）。
//! 所以交給函式庫之前，先自己掃一遍：檔案大小、壓縮包展開後大小、工作表實際用到的儲存格範圍。

use std::io::Read;
use std::path::Path;

/// 單一資料檔上限（CSV／xls／壓縮包本身）。
pub const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
/// 壓縮包（xlsx 等）展開後所有部分加總的上限，擋壓縮炸彈。
pub const MAX_UNPACKED_BYTES: u64 = 300 * 1024 * 1024;
/// 工作表範圍（含空白）的儲存格數上限；calamine 每格約 32 位元組，800 萬格約 256 MB。
pub const MAX_SHEET_CELLS: u64 = 8_000_000;


/// 檢查檔案大小。
pub fn check_size(path: &Path) -> Result<u64, String> {
    let len = std::fs::metadata(path).map_err(|e| format!("讀取檔案失敗：{e}"))?.len();
    if len > MAX_FILE_BYTES {
        return Err("檔案超過 256 MB，為避免程式當掉已拒絕開啟".to_string());
    }
    Ok(len)
}

/// 試算表（活頁簿）檔案：大小、壓縮炸彈、工作表範圍。非壓縮包格式（舊式 .xls）只檢查大小。
pub fn check_workbook(path: &Path) -> Result<(), String> {
    check_size(path)?;
    let mut head = [0u8; 4];
    {
        let mut f = std::fs::File::open(path).map_err(|e| format!("讀取檔案失敗：{e}"))?;
        if f.read(&mut head).unwrap_or(0) < 4 || &head[..2] != b"PK" {
            return Ok(()); // 不是 zip：交給函式庫處理（xls 是 OLE 格式）
        }
    }
    let file = std::fs::File::open(path).map_err(|e| format!("讀取檔案失敗：{e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("無法開啟活頁簿：{e}"))?;
    if zip.len() > 10_000 {
        return Err("壓縮包內的檔案過多，為避免程式當掉已拒絕開啟".to_string());
    }
    // 先用宣告的大小粗篩（宣告可能說謊，下面實際讀取時還會用 take 限制）
    let mut total: u64 = 0;
    for i in 0..zip.len() {
        let e = zip.by_index_raw(i).map_err(|e| format!("無法開啟活頁簿：{e}"))?;
        total = total.saturating_add(e.size());
    }
    if total > MAX_UNPACKED_BYTES {
        return Err("檔案展開後超過 300 MB，為避免程式當掉已拒絕開啟".to_string());
    }
    let mut budget = MAX_UNPACKED_BYTES;
    for i in 0..zip.len() {
        let e = zip.by_index(i).map_err(|e| format!("無法開啟活頁簿：{e}"))?;
        let name = e.name().map(|n| n.into_owned()).unwrap_or_default();
        if !(name.starts_with("xl/worksheets/") && name.ends_with(".xml")) {
            continue;
        }
        // 實際讀取，最多讀到預算用完（宣告大小不可信）
        let mut buf = Vec::new();
        let mut limited = e.take(budget.min(MAX_UNPACKED_BYTES) + 1);
        limited.read_to_end(&mut buf).map_err(|e| format!("無法開啟活頁簿：{e}"))?;
        if buf.len() as u64 > budget {
            return Err("檔案展開後超過 300 MB，為避免程式當掉已拒絕開啟".to_string());
        }
        budget -= buf.len() as u64;
        let area = used_area(&buf);
        if area > MAX_SHEET_CELLS {
            return Err(format!("工作表「{name}」的範圍過大（約 {area} 格），為避免程式當掉已拒絕開啟"));
        }
    }
    Ok(())
}

/// 掃描工作表 XML 裡 `<c r="B7"` 與 `<row r="7"` 的座標，回傳涵蓋所有儲存格的矩形面積。
fn used_area(xml: &[u8]) -> u64 {
    let (mut min_r, mut max_r, mut min_c, mut max_c) = (u64::MAX, 0u64, u64::MAX, 0u64);
    let mut any = false;
    let mut i = 0usize;
    while i + 6 < xml.len() {
        // 找 `<c r="`（儲存格）；`<row r="` 的列號也納入，避免只有空列卻宣告超大列號
        if xml[i] == b'<' {
            let (is_cell, skip) = if xml[i..].starts_with(b"<c r=\"") {
                (true, 6)
            } else if xml[i..].starts_with(b"<row r=\"") {
                (false, 8)
            } else {
                i += 1;
                continue;
            };
            let mut j = i + skip;
            let (mut col, mut row) = (0u64, 0u64);
            while j < xml.len() && xml[j].is_ascii_alphabetic() {
                col = col.saturating_mul(26).saturating_add((xml[j].to_ascii_uppercase() - b'A' + 1) as u64);
                j += 1;
            }
            while j < xml.len() && xml[j].is_ascii_digit() {
                row = row.saturating_mul(10).saturating_add((xml[j] - b'0') as u64);
                j += 1;
            }
            if row > 0 {
                any = true;
                min_r = min_r.min(row);
                max_r = max_r.max(row);
                if is_cell && col > 0 {
                    min_c = min_c.min(col);
                    max_c = max_c.max(col);
                }
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
    if !any {
        return 0;
    }
    let rows = max_r - min_r + 1;
    let cols = if max_c >= min_c { max_c - min_c + 1 } else { 1 };
    rows.saturating_mul(cols)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn area_of_normal_sheet() {
        let xml = br#"<sheetData><row r="1"><c r="A1"/><c r="C1"/></row><row r="3"><c r="B3"/></row></sheetData>"#;
        assert_eq!(used_area(xml), 3 * 3); // A..C × 1..3
    }

    #[test]
    fn area_of_sparse_sheet_is_huge() {
        let xml = br#"<row r="1"><c r="A1"/></row><row r="1048576"><c r="XFD1048576"/></row>"#;
        assert!(used_area(xml) > MAX_SHEET_CELLS);
    }

    fn make_xlsx(name: &str, sheet_xml: &str) -> std::path::PathBuf {
        use std::io::Write;
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("test-tmp");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        let mut z = zip::ZipWriter::new(std::fs::File::create(&p).unwrap());
        let opt = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        z.start_file("xl/worksheets/sheet1.xml", opt).unwrap();
        z.write_all(sheet_xml.as_bytes()).unwrap();
        z.finish().unwrap();
        p
    }

    #[test]
    fn sparse_xlsx_is_rejected_before_reaching_calamine() {
        let p = make_xlsx("guard-sparse.xlsx", r#"<sheetData><row r="1"><c r="A1"/></row><row r="1048576"><c r="XFD1048576"/></row></sheetData>"#);
        let e = check_workbook(&p).unwrap_err();
        assert!(e.contains("範圍過大"), "{e}");
        // 經由 read_table 入口同樣被擋，且不會中止程式
        assert!(crate::sheet::read_table(p.to_str().unwrap(), None).is_err());
    }

    #[test]
    fn normal_xlsx_passes() {
        let p = make_xlsx("guard-ok.xlsx", r#"<sheetData><row r="1"><c r="A1"/><c r="B1"/></row></sheetData>"#);
        assert!(check_workbook(&p).is_ok());
    }

    #[test]
    fn non_zip_files_only_get_size_check() {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("test-tmp");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("guard-plain.xls");
        std::fs::write(&p, b"not a zip at all").unwrap();
        assert!(check_workbook(&p).is_ok());
    }

    #[test]
    fn empty_sheet_is_zero() {
        assert_eq!(used_area(b"<sheetData></sheetData>"), 0);
    }

    #[test]
    fn row_only_huge_number_counts() {
        let xml = br#"<row r="1"><c r="A1"/></row><row r="9999999999"></row>"#;
        assert!(used_area(xml) > MAX_SHEET_CELLS);
    }
}
