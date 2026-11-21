//! TSPL2 指令組裝（TSC TTP-244 Pro，203 dpi）。

use base64::Engine;
use serde::{Deserialize, Deserializer};

/// 前端以 base64 傳送點陣（比 JSON 數字陣列小很多）
fn de_base64<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
    let s = String::deserialize(d)?;
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(serde::de::Error::custom)
}

/// 由印表機原生指令列印的條碼／QR Code（選用；預設不使用，整張標籤仍以點陣為主）。
/// 座標是「標籤內」的 dots，組指令時再加上 offset_x_dots / offset_y_dots。
#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum NativeCode {
    /// BARCODE x,y,"code",height,readable,0,narrow,wide,"content"
    Barcode { x: i32, y: i32, code: String, height: u32, readable: bool, narrow: u32, wide: u32, content: String, #[serde(default)] h: u32 },
    /// QRCODE x,y,ecc,cell,A,0,M2,S7,"content"（M2＝QR Model 2；不指定時舊韌體用 Model 1，手機掃不出來）
    Qr { x: i32, y: i32, ecc: String, cell: u32, content: String, #[serde(default)] h: u32 },
}

/// 允許的原生條碼類型（TSPL2 BARCODE 的 code type）；不在清單內的一律拒絕，避免把任意文字塞進指令
const BARCODE_TYPES: &[&str] = &["128", "128M", "EAN128", "39", "93", "EAN13", "EAN8", "UPCA", "UPCE", "ITF14", "CODA", "25", "25C"];

/// 內容放進雙引號字串：只接受可列印的 ASCII（中文等需要字碼頁，不保證結果，由前端改走點陣）；雙引號以 \" 跳脫
fn quote(content: &str) -> Result<String, String> {
    if content.is_empty() {
        return Err("原生條碼內容不可為空".into());
    }
    if !content.chars().all(|c| (' '..='~').contains(&c)) {
        return Err(format!("原生條碼內容只能是半形英數與符號：{content}"));
    }
    Ok(content.replace('"', "\\\""))
}

impl NativeCode {
    /// 組成一行 TSPL 指令（不含換行）。dx / dy 是標籤在紙上的位移（dots）
    fn command(&self, dx: u32, dy: u32) -> Result<String, String> {
        let at = |v: i32, d: u32| (v.max(0) as u32).saturating_add(d);
        match self {
            NativeCode::Barcode { x, y, code, height, readable, narrow, wide, content, .. } => {
                if !BARCODE_TYPES.contains(&code.as_str()) {
                    return Err(format!("不支援的原生條碼類型：{code}"));
                }
                Ok(format!(
                    "BARCODE {},{},\"{}\",{},{},0,{},{},\"{}\"",
                    at(*x, dx), at(*y, dy), code, (*height).max(1), u8::from(*readable),
                    (*narrow).clamp(1, 10), (*wide).clamp(1, 30), quote(content)?
                ))
            }
            NativeCode::Qr { x, y, ecc, cell, content, .. } => {
                if !matches!(ecc.as_str(), "L" | "M" | "Q" | "H") {
                    return Err(format!("不支援的 QR 容錯等級：{ecc}"));
                }
                Ok(format!("QRCODE {},{},{},{},A,0,M2,S7,\"{}\"", at(*x, dx), at(*y, dy), ecc, (*cell).clamp(1, 10), quote(content)?))
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintJob {
    // camelCase 規則會產生 paperWMm / paperHMm，與前端送的 paperWmm / paperHmm 不符，故明確指定
    #[serde(rename = "paperWmm")]
    pub paper_w_mm: f32,
    #[serde(rename = "paperHmm")]
    pub paper_h_mm: f32,
    pub gap_mm: f32,
    pub offset_x_dots: u32,
    pub offset_y_dots: u32,
    pub width_px: u32,
    pub height_px: u32,
    /// 每列以 byte 打包、高位元在前；1 = 黑點。長度 = ceil(width/8) * height（傳輸時為 base64）
    #[serde(deserialize_with = "de_base64")]
    pub bitmap: Vec<u8>,
    pub copies: u32,
    /// 列印濃度 0～15（數字越大越黑；超出範圍時自動限制在範圍內）
    pub density: u8,
    /// 列印速度 1～6（吋/秒；慢一點通常比較黑、比較清晰）
    pub speed: u8,
    /// 列印後是否把標籤送到撕紙位置（對應 TSC 驅動的「列印後動作：撕開」），方便撕下
    #[serde(default = "default_tear")]
    pub tear: bool,
    /// 列印後額外多送（正）或回收（負）的紙長，單位 mm；0 = 不另外指定（對應驅動的「送紙位移」）
    #[serde(default)]
    pub offset_mm: f32,
    /// 改由印表機原生指令列印的條碼／QR（這些物件不會出現在 bitmap 裡）；沒有就是空的
    #[serde(default)]
    pub natives: Vec<NativeCode>,
    /// 印表機語言代碼（`langs::LANGUAGES`）；沒有就是 TSPL（舊版前端與既有行為）
    #[serde(default = "default_lang")]
    pub lang: String,
}

fn default_lang() -> String {
    "tspl".into()
}

fn default_tear() -> bool {
    true
}

pub fn build(job: &PrintJob) -> Result<Vec<u8>, String> {
    let width_bytes = job.width_px.div_ceil(8);
    let expected = (width_bytes * job.height_px) as usize;
    if job.bitmap.len() != expected {
        return Err(format!("點陣大小不符：預期 {expected} bytes，實際 {} bytes", job.bitmap.len()));
    }
    if job.copies == 0 {
        return Err("份數必須至少為 1".into());
    }
    if job.lang != "tspl" {
        return match job.lang.as_str() {
            "zpl" => crate::langs::zpl(job),
            "epl" => crate::langs::epl(job),
            "cpcl" => crate::langs::cpcl(job),
            "dpl" => crate::langs::dpl(job),
            "sbpl" => crate::langs::sbpl(job),
            other => Err(format!("不支援的印表機語言：{other}")),
        };
    }

    // 印表機的記憶會保留上一次工作（例如 BarTender 或驅動）留下的設定，所以出紙方式要每次明確指定
    let density = job.density.min(15);
    let speed = job.speed.clamp(1, 6);
    let mut header = format!(
        "SIZE {} mm,{} mm\r\nGAP {} mm,0 mm\r\nDENSITY {}\r\nSPEED {}\r\nDIRECTION 1\r\nSET TEAR {}\r\nSET PEEL OFF\r\nSET CUTTER OFF\r\n",
        job.paper_w_mm, job.paper_h_mm, job.gap_mm, density, speed,
        if job.tear { "ON" } else { "OFF" },
    );
    if job.offset_mm != 0.0 {
        header.push_str(&format!("OFFSET {} mm\r\n", job.offset_mm));
    }
    let mut out = format!(
        "{header}CLS\r\nBITMAP {},{},{},{},0,",
        job.offset_x_dots, job.offset_y_dots, width_bytes, job.height_px,
    )
    .into_bytes();

    // TSPL BITMAP：資料位元 0 = 列印（黑），1 = 不列印，需反相
    out.extend(job.bitmap.iter().map(|b| !b));
    out.extend_from_slice(b"\r\n");
    // 原生條碼接在點陣之後（疊在上面）
    for n in &job.natives {
        out.extend_from_slice(n.command(job.offset_x_dots, job.offset_y_dots)?.as_bytes());
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(format!("PRINT {},1\r\n", job.copies).as_bytes());
    Ok(out)
}

/// 多張標籤串成同一份資料，一次送出（同一個列印工作）
pub fn build_many(jobs: &[PrintJob]) -> Result<Vec<u8>, String> {
    if jobs.is_empty() {
        return Err("沒有要列印的標籤".into());
    }
    let mut out = Vec::new();
    for (i, j) in jobs.iter().enumerate() {
        out.extend(build(j).map_err(|e| format!("第 {} 張：{e}", i + 1))?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_many_concatenates_and_labels_errors() {
        let ok = || job(vec![0, 0, 0, 0]);
        let out = build_many(&[ok(), ok()]).unwrap();
        let s = String::from_utf8_lossy(&out);
        assert_eq!(s.matches("SIZE 62.5 mm").count(), 2);
        assert_eq!(s.matches("PRINT 3,1").count(), 2);
        let err = build_many(&[ok(), job(vec![0; 3])]).unwrap_err();
        assert!(err.starts_with("第 2 張"));
        assert!(build_many(&[]).is_err());
    }

    #[test]
    fn deserializes_base64_bitmap() {
        // 與前端實際送出的欄位一致（含新增的 tear / offsetMm）
        let json = r#"{"paperWmm":62.5,"paperHmm":30,"gapMm":3,"offsetXDots":0,"offsetYDots":0,
            "widthPx":8,"heightPx":2,"bitmap":"/wA=","copies":1,"density":8,"speed":4,"tear":false,"offsetMm":1.5}"#;
        let j: PrintJob = serde_json::from_str(json).unwrap();
        assert_eq!(j.bitmap, vec![0xFF, 0x00]);
        assert!(!j.tear);
        assert_eq!(j.offset_mm, 1.5);
        assert!(serde_json::from_str::<PrintJob>(&json.replace("/wA=", "!!")).is_err());
    }

    #[test]
    fn older_front_end_without_tear_fields_still_works() {
        // 沒有 tear / offsetMm 的舊格式：預設為撕紙位置開啟、不額外送紙
        let json = r#"{"paperWmm":62.5,"paperHmm":30,"gapMm":3,"offsetXDots":0,"offsetYDots":0,
            "widthPx":8,"heightPx":2,"bitmap":"/wA=","copies":1,"density":8,"speed":4}"#;
        let j: PrintJob = serde_json::from_str(json).unwrap();
        assert!(j.tear);
        assert_eq!(j.offset_mm, 0.0);
    }

    fn job(bitmap: Vec<u8>) -> PrintJob {
        PrintJob {
            paper_w_mm: 62.5, paper_h_mm: 30.0, gap_mm: 3.0,
            offset_x_dots: 10, offset_y_dots: 0,
            width_px: 9, height_px: 2, // 每列 2 bytes
            bitmap, copies: 3, density: 8, speed: 4, tear: true, offset_mm: 0.0, natives: vec![], lang: "tspl".into(),
        }
    }

    fn header_of(j: &PrintJob) -> String {
        let out = build(j).unwrap();
        let s = String::from_utf8_lossy(&out).into_owned();
        s.split("CLS").next().unwrap().to_string()
    }

    #[test]
    fn density_and_speed_are_clamped_to_printer_range() {
        let mut j = job(vec![0; 4]);
        j.density = 99;
        j.speed = 0;
        let h = header_of(&j);
        assert!(h.contains("DENSITY 15\r\n"), "{h}");
        assert!(h.contains("SPEED 1\r\n"), "{h}");
        j.density = 0;
        j.speed = 9;
        let h = header_of(&j);
        assert!(h.contains("DENSITY 0\r\n") && h.contains("SPEED 6\r\n"), "{h}");
    }

    #[test]
    fn tear_off_and_feed_offset_are_sent_explicitly() {
        let mut j = job(vec![0; 4]);
        let h = header_of(&j);
        assert!(h.contains("SET TEAR ON\r\n") && h.contains("SET PEEL OFF\r\n") && h.contains("SET CUTTER OFF\r\n"), "{h}");
        assert!(!h.contains("OFFSET"), "offset 為 0 時不另外送 OFFSET：{h}");
        j.tear = false;
        j.offset_mm = 2.0;
        let h = header_of(&j);
        assert!(h.contains("SET TEAR OFF\r\n"), "{h}");
        assert!(h.contains("OFFSET 2 mm\r\n"), "{h}");
    }

    #[test]
    fn builds_header_and_inverts_bitmap() {
        let out = build(&job(vec![0xFF, 0x80, 0x00, 0x00])).unwrap();
        let s = String::from_utf8_lossy(&out);
        assert!(s.starts_with("SIZE 62.5 mm,30 mm\r\nGAP 3 mm,0 mm"));
        assert!(s.contains("BITMAP 10,0,2,2,0,"));
        assert!(s.ends_with("\r\nPRINT 3,1\r\n"));
        let start = out.windows(2).position(|w| w == b"0,").unwrap(); // 粗略驗證資料區存在
        assert!(start > 0);
        assert!(out.windows(4).any(|w| w == [0x00, 0x7F, 0xFF, 0xFF]));
    }

    #[test]
    fn rejects_wrong_bitmap_size() {
        assert!(build(&job(vec![0; 3])).is_err());
    }

    #[test]
    fn native_codes_are_appended_after_the_bitmap_with_paper_offset() {
        let mut j = job(vec![0xFF, 0x80, 0x00, 0x00]);
        j.natives = vec![
            NativeCode::Barcode { x: 20, y: 30, code: "128".into(), height: 80, readable: true, narrow: 2, wide: 4, content: "SN-0001".into(), h: 0 },
            NativeCode::Qr { x: 5, y: 6, ecc: "M".into(), cell: 3, content: "https://example.com/a".into(), h: 0 },
        ];
        let out = build(&j).unwrap();
        let s = String::from_utf8_lossy(&out).into_owned();
        // 位移 offset_x_dots = 10、offset_y_dots = 0 要加進座標
        assert!(s.contains("\r\nBARCODE 30,30,\"128\",80,1,0,2,4,\"SN-0001\"\r\n"), "{s:?}");
        assert!(s.contains("\r\nQRCODE 15,6,M,3,A,0,M2,S7,\"https://example.com/a\"\r\n"), "{s:?}");
        let bitmap_at = s.find("BITMAP").unwrap();
        assert!(s.find("BARCODE").unwrap() > bitmap_at && s.find("QRCODE").unwrap() < s.find("PRINT 3,1").unwrap());
        assert!(s.ends_with("PRINT 3,1\r\n"));
    }

    #[test]
    fn no_natives_keeps_the_old_output_unchanged() {
        let s = String::from_utf8_lossy(&build(&job(vec![0xFF, 0x80, 0x00, 0x00])).unwrap()).into_owned();
        assert!(!s.contains("BARCODE") && !s.contains("QRCODE"));
        assert!(s.ends_with("\r\nPRINT 3,1\r\n"));
    }

    #[test]
    fn native_codes_are_validated_and_escaped() {
        let bc = |code: &str, content: &str| NativeCode::Barcode { x: 0, y: 0, code: code.into(), height: 50, readable: false, narrow: 2, wide: 2, content: content.into(), h: 0 };
        assert!(bc("128", "中文").command(0, 0).is_err(), "非 ASCII 要拒絕");
        assert!(bc("128", "").command(0, 0).is_err(), "空內容要拒絕");
        assert!(bc("128\"; DELETE", "A").command(0, 0).is_err(), "未知的條碼類型要拒絕");
        assert!(bc("128", "a\nb").command(0, 0).is_err(), "控制字元要拒絕");
        assert!(bc("39", "A\"B").command(0, 0).unwrap().ends_with("\"A\\\"B\""), "雙引號要跳脫");
        assert!(NativeCode::Qr { x: 0, y: 0, ecc: "X".into(), cell: 3, content: "a".into(), h: 0 }.command(0, 0).is_err());
        // 負座標夾在 0；cell / narrow 夾在合理範圍
        let c = NativeCode::Qr { x: -5, y: 2, ecc: "H".into(), cell: 99, content: "a".into(), h: 0 }.command(4, 0).unwrap();
        assert_eq!(c, "QRCODE 4,2,H,10,A,0,M2,S7,\"a\"");
    }

    #[test]
    fn deserializes_natives_from_front_end_json() {
        let json = r#"{"paperWmm":62.5,"paperHmm":30,"gapMm":3,"offsetXDots":0,"offsetYDots":0,
            "widthPx":8,"heightPx":2,"bitmap":"/wA=","copies":1,"density":8,"speed":4,
            "natives":[{"kind":"barcode","x":1,"y":2,"code":"128","height":80,"readable":true,"narrow":2,"wide":4,"content":"A"},
                       {"kind":"qr","x":3,"y":4,"ecc":"M","cell":3,"content":"B"}]}"#;
        let j: PrintJob = serde_json::from_str(json).unwrap();
        assert_eq!(j.natives.len(), 2);
        assert!(matches!(&j.natives[1], NativeCode::Qr { cell: 3, .. }));
    }

    #[test]
    fn other_languages_dispatch_and_reject_natives_and_unknown() {
        for (lang, marker) in [("zpl", "^XA"), ("epl", "GW"), ("cpcl", "CG "), ("dpl", "1Y11000"), ("sbpl", "GH")] {
            let mut j = job(vec![0xFF, 0x80, 0x00, 0x00]);
            j.lang = lang.into();
            let s = String::from_utf8_lossy(&build(&j).unwrap()).into_owned();
            assert!(s.contains(marker), "{lang}: {s:?}");
            assert!(!s.contains("BITMAP"), "{lang} 不應出現 TSPL 指令");
        }
        // 沒有 QR 原生指令的語言（EPL2、SBPL）收到 QR 要明確拒絕；ZPL、CPCL、DPL 則支援
        let mut j = job(vec![0; 4]);
        j.lang = "sbpl".into();
        j.natives = vec![NativeCode::Qr { x: 0, y: 0, ecc: "M".into(), cell: 3, content: "a".into(), h: 0 }];
        assert!(build(&j).is_err());
        j.natives.clear();
        j.lang = "nope".into();
        assert!(build(&j).is_err());
        assert!(serde_json::from_str::<PrintJob>(r#"{"paperWmm":1,"paperHmm":1,"gapMm":0,"offsetXDots":0,"offsetYDots":0,"widthPx":8,"heightPx":1,"bitmap":"AA==","copies":1,"density":1,"speed":1,"lang":"zpl"}"#).unwrap().lang == "zpl");
    }

    #[test]
    fn rejects_zero_copies() {
        let mut j = job(vec![0; 4]);
        j.copies = 0;
        assert!(build(&j).is_err());
    }
}
