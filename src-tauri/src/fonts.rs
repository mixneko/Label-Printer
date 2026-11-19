//! 列出 Windows 已安裝的字型家族名稱（來源與 C:\Windows\Fonts 及使用者字型相同）。

use windows::Win32::Foundation::{HWND, LPARAM};
use windows::Win32::Graphics::Gdi::{
    EnumFontFamiliesExW, GetDC, ReleaseDC, DEFAULT_CHARSET, LOGFONTW, TEXTMETRICW,
};

unsafe extern "system" fn collect(
    lf: *const LOGFONTW,
    _tm: *const TEXTMETRICW,
    _font_type: u32,
    lparam: LPARAM,
) -> i32 {
    let names = &mut *(lparam.0 as *mut Vec<String>);
    let face = &(*lf).lfFaceName;
    let len = face.iter().position(|&c| c == 0).unwrap_or(face.len());
    let name = String::from_utf16_lossy(&face[..len]);
    // 以 @ 開頭的是直排字型別名，不列出
    if !name.is_empty() && !name.starts_with('@') {
        names.push(name);
    }
    1 // 繼續列舉
}

pub fn list_fonts() -> Result<Vec<String>, String> {
    let mut names: Vec<String> = Vec::new();
    unsafe {
        let hdc = GetDC(HWND::default());
        let lf = LOGFONTW { lfCharSet: DEFAULT_CHARSET, ..Default::default() };
        EnumFontFamiliesExW(hdc, &lf, Some(collect), LPARAM(&mut names as *mut _ as isize), 0);
        ReleaseDC(HWND::default(), hdc);
    }
    names.sort_by_key(|n| n.to_lowercase());
    names.dedup();
    Ok(names)
}
