//! 產生測試用的範例檔到專案根目錄的 samples/：
//!   cargo run --manifest-path src-tauri/Cargo.toml --example make_samples
//! 範例標籤 sample-label.lpxl 與這裡的資料用同一組欄位：Item、Code、Lot、Expiry。

use rust_xlsxwriter::{Format, Workbook};
use std::path::PathBuf;

fn main() {
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("samples");
    std::fs::create_dir_all(&out).unwrap();

    // 1. Excel：兩個工作表（欄位相同），到期日是真正的日期儲存格（格式 yyyy/mm/dd）
    let mut wb = Workbook::new();
    let date = Format::new().set_num_format("yyyy/mm/dd");
    let head = ["Item", "Code", "Lot", "Expiry"];
    // (品名, 代碼, 批號, Excel 日期序號：46721 = 2027/11/30)
    let items = [
        ("Screw M3x8 Stainless", "A-1001", "B2611", 46721.0),
        ("Nylon Washer 6 mm", "A-1002", "B2611", 46721.0),
        ("Anti-Static Foam Storage Box (Large)", "C-20003-LONG", "B2612", 46904.0),
        ("Hex Nut M3 Zinc", "A-1003", "B2701", 46783.0),
        ("Cable Tie 200 mm Black", "D-3001", "B2702", 47299.0),
    ];
    let spare = [("Rubber Foot 10 mm", "E-4001", "B2703", 47026.0), ("Spring 5x20 mm", "E-4002", "B2703", 47026.0)];
    for (name, list) in [("Items", &items[..]), ("Spare Parts", &spare[..])] {
        let ws = wb.add_worksheet();
        ws.set_name(name).unwrap();
        for (c, h) in head.iter().enumerate() {
            ws.write_string(0, c as u16, *h).unwrap();
        }
        for (r, (n, code, lot, exp)) in list.iter().enumerate() {
            let r = (r + 1) as u32;
            ws.write_string(r, 0, *n).unwrap();
            ws.write_string(r, 1, *code).unwrap();
            ws.write_string(r, 2, *lot).unwrap();
            ws.write_number_with_format(r, 3, *exp, &date).unwrap();
        }
    }
    wb.save(out.join("sample-items.xlsx")).unwrap();

    // 2. CSV：Big5 編碼（台灣版 Excel 另存「CSV」的預設編碼），品名是中文，用來測編碼自動判斷
    let text = "Item,Code,Lot,Expiry\r\n不鏽鋼螺絲 M3x8,A-1001,B2611,2027/11/30\r\n尼龍墊片 6 mm,A-1002,B2611,2027/11/30\r\n防靜電泡棉收納盒（大）,C-20003-LONG,B2612,2028/05/31\r\n";
    let (bytes, _, _) = encoding_rs::BIG5.encode(text);
    std::fs::write(out.join("sample-items-big5.csv"), &*bytes).unwrap();

    println!("已產生到 {}", out.display());
}
