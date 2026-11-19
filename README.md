# Label Printer

取代 BarTender Designer 的輕量標籤排版與列印軟體。目標印表機：TSC TTP-244 Pro（203 dpi，TSPL2），經由 print server 以 Raw TCP 直接列印。

技術：Tauri 2（Rust 後端）+ TypeScript + Konva.js（畫布編輯器）。

## 開發環境（Windows）

1. [Node.js LTS](https://nodejs.org/)
2. [Rust](https://rustup.rs/)（需要 MSVC：安裝 Visual Studio Build Tools 的「使用 C++ 的桌面開發」）
3. WebView2 Runtime（Windows 11 已內建）

```powershell
npm install
npm run tauri icon app-icon.png   # 只需第一次：產生 src-tauri/icons
npm run tauri dev                 # 開發模式
cargo test --manifest-path src-tauri/Cargo.toml   # Rust 單元測試
```

## 打包與部署

```powershell
npm run tauri build
```

產出：

- `src-tauri/target/release/Label Printer.exe`：單一執行檔，複製即可使用（需 WebView2，Win11 內建）。
- `src-tauri/target/release/bundle/nsis/*-setup.exe`：安裝檔，內嵌 WebView2 啟動器，Win10 也能安裝；安裝於目前使用者，不需系統管理員權限。

## 架構

- 前端把標籤渲染為 1-bit 點陣，後端轉成 TSPL（`SIZE/GAP/BITMAP/PRINT`）。
- 預設經 Windows 假脫機以 **RAW** 資料型態送到已安裝的印表機（驅動不轉譯，TSPL 原封不動送出）；也可切換為直連 Raw TCP（如 `192.168.1.100:9103`）。
- 字型使用 Windows 系統已安裝字型（WebView2 讀取 `C:\Windows\Fonts` 與使用者字型），換電腦時該電腦也需安裝同樣字型。
- 紙張 62.5×30 mm、範本 60×30 mm，皆可在介面調整；範本會置中於紙張。
- 範本文字可使用 `{{欄位}}` 變數（Excel 欄位標題）。列印張數 = 在資料表中勾選的列數。

## 範例檔（`samples/`）

- `範例標籤.lpxl` + `範例貨品清單.csv`：虛構的 60×30 mm 貨品標籤與對應資料（欄位：品名、編號、批號、效期），示範變數、QR Code、條碼、日期格式與文字「最大範圍」（品名太長會自動縮小）。
- `商品清單.xlsx`（兩個工作表）、`商品清單-big5.csv`：測試匯入用。
- 重新產生 xlsx / csv 範例：`cargo run --manifest-path src-tauri/Cargo.toml --example make_samples`

## 路線圖

- [x] 專案骨架、文字物件、列印
- [x] 條碼 / QR Code / 圖片 / 線條 / 矩形物件、字型下拉選單（系統已安裝字型）
- [x] 範本存檔與載入（JSON）
- [x] 本機 Excel / CSV 資料來源（工具列「選擇資料來源」）、批次列印、預覽（第一列為欄位標題，每一列是一筆資料；在表格中勾選哪幾列就印幾張，標籤上的 `{{欄位}}` 取自該列。Excel 不需要「份數」欄；支援 .xlsx/.xlsm/.xls 與 .csv，CSV 自動判斷 UTF-8 / Big5 與分隔符號）
- [ ] Microsoft 365 Excel（Microsoft Graph, OAuth）：暫不做；用 OneDrive 同步到本機後直接選取該檔案即可
- [x] 列印校正：濃度、速度、字體加粗、撕紙位置、額外送紙、位置左右/上下微調，以及「工具 → 產生校正標籤」（外框與 mm 刻度）
- [x] 原生條碼指令（`BARCODE` / `QRCODE`）：選用（預設關閉），在條碼或 QR 的屬性勾選「使用印表機原生指令列印」；內容含中文、旋轉時自動改用點陣

> 注意：TSPL `BITMAP` 的黑白位元定義（0 = 列印）已在程式中反相處理，需以實機確認列印結果。

## 授權

本專案以 [MIT 授權](LICENSE) 釋出。第三方套件各自的授權聲明見程式內「說明 → 第三方授權聲明」。
