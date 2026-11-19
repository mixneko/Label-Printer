//! 產生測試用的範例檔到專案根目錄的 samples/：
//!   cargo run --manifest-path src-tauri/Cargo.toml --example make_samples

use rust_xlsxwriter::{Format, Workbook};
use std::path::PathBuf;

fn main() {
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("samples");
    std::fs::create_dir_all(&out).unwrap();

    // 1. Excel：兩個工作表，含文字、整數、小數、日期
    let mut wb = Workbook::new();
    let date = Format::new().set_num_format("yyyy/mm/dd");

    let ws = wb.add_worksheet();
    ws.set_name("商品").unwrap();
    for (c, h) in ["品名", "價格", "條碼", "產地", "有效日期"].iter().enumerate() {
        ws.write_string(0, c as u16, *h).unwrap();
    }
    let items = [
        ("蘋果", 30.0, "4710088000011", "台灣"),
        ("香蕉", 12.5, "4710088000028", "菲律賓"),
        ("橘子", 25.0, "4710088000035", "日本"),
        ("葡萄", 120.0, "4710088000042", "智利"),
        ("西瓜", 80.0, "4710088000059", "台灣"),
    ];
    for (r, (name, price, code, origin)) in items.iter().enumerate() {
        let r = (r + 1) as u32;
        ws.write_string(r, 0, *name).unwrap();
        ws.write_number(r, 1, *price).unwrap();
        ws.write_string(r, 2, *code).unwrap(); // 條碼以文字存放，避免被當成科學記號
        ws.write_string(r, 3, *origin).unwrap();
        // Excel 日期序號：2026-12-31 = 46387
        ws.write_number_with_format(r, 4, 46387.0 + r as f64, &date).unwrap();
    }

    let ws2 = wb.add_worksheet();
    ws2.set_name("員工").unwrap();
    ws2.write_string(0, 0, "姓名").unwrap();
    ws2.write_string(0, 1, "編號").unwrap();
    for (r, (n, id)) in [("王小明", "A001"), ("陳美麗", "A002")].iter().enumerate() {
        ws2.write_string((r + 1) as u32, 0, *n).unwrap();
        ws2.write_string((r + 1) as u32, 1, *id).unwrap();
    }
    wb.save(out.join("商品清單.xlsx")).unwrap();

    // 2. CSV：Big5 編碼（台灣版 Excel 另存「CSV」的預設編碼）
    let text = "品名,價格,條碼,產地\r\n蘋果,30,4710088000011,台灣\r\n香蕉,12.5,4710088000028,菲律賓\r\n橘子,25,4710088000035,日本\r\n";
    let (bytes, _, _) = encoding_rs::BIG5.encode(text);
    std::fs::write(out.join("商品清單-big5.csv"), &*bytes).unwrap();

    println!("已產生到 {}", out.display());
}
