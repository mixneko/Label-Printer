# Label Printer

[繁體中文](README.md) · **English** · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [Deutsch](README.de.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

A lightweight label design and printing application that replaces BarTender Designer. Target printer: TSC TTP-244 Pro (203 dpi, TSPL2), printing through a Windows-installed printer (RAW) or directly over Raw TCP via a print server.

Tech stack: Tauri 2 (Rust backend) + TypeScript + Konva.js (canvas editor).

## Development environment (Windows)

1. [Node.js LTS](https://nodejs.org/)
2. [Rust](https://rustup.rs/) (requires MSVC: install the "Desktop development with C++" workload of Visual Studio Build Tools)
3. WebView2 Runtime (built into Windows 11)

```powershell
npm install
npm run tauri icon app-icon.png   # first time only: generates src-tauri/icons
npm run tauri dev                 # development mode
cargo test --manifest-path src-tauri/Cargo.toml   # Rust unit tests
```

## Build and deployment

```powershell
npm run tauri build
```

Output:

- `src-tauri/target/release/Label Printer.exe`: a single executable; just copy it and run (requires WebView2, built into Win11).
- `src-tauri/target/release/bundle/nsis/*-setup.exe`: installer with an embedded WebView2 bootstrapper, so it also installs on Win10; installs for the current user and needs no administrator rights.

## Automatic updates

The installed version checks GitHub once in the background at startup (it only reads the public release information and sends no data). If a new version exists, a dialog appears; click "Update now" to download it inside the app, verify its signature, install it and restart automatically. You can turn this off under "Help → Check for updates at startup", or check manually at any time with "Help → Check for updates". The portable version cannot update in place and opens the download page instead.

Maintainers: the release workflow (`.github/workflows/release.yml`) needs the repository secret `TAURI_SIGNING_PRIVATE_KEY` (the update-signing private key, created with `tauri signer generate`; the public key is in `src-tauri/tauri.conf.json`). If the private key is lost, updates can no longer be pushed to existing users.

## Architecture

- The front end renders the label as a 1-bit bitmap; the back end converts it to TSPL (`SIZE/GAP/BITMAP/PRINT`).
- By default the job goes through the Windows spooler as **RAW** data to an installed printer (the driver does not translate anything; the TSPL is sent as is). You can also switch to a direct Raw TCP connection (for example `192.168.1.100:9103`).
- Fonts are the ones installed in Windows (WebView2 reads `C:\Windows\Fonts` and per-user fonts). On another computer the same fonts must be installed.
- Paper is 62.5×30 mm and the label is 60×30 mm; both can be changed in the UI, and the label is centered on the paper.
- Label text can use `{{field}}` variables (the column headers of your Excel file). Number of labels printed = number of rows ticked in the data table.

## Samples (`samples/`)

- `範例標籤.lpxl` + `範例貨品清單.csv`: a fictional 60×30 mm product label and matching data (fields: name, code, batch, expiry). It demonstrates variables, QR code, barcode, date formats and the text "maximum area" (a long product name shrinks automatically).
- `商品清單.xlsx` (two worksheets) and `商品清單-big5.csv`: for testing import.
- Regenerate the xlsx / csv samples: `cargo run --manifest-path src-tauri/Cargo.toml --example make_samples`

## Roadmap

- [x] Project skeleton, text objects, printing
- [x] Barcode / QR code / image / line / rectangle objects, font drop-down (installed system fonts)
- [x] Saving and loading labels
- [x] Local Excel / CSV data sources (toolbar "Choose data source"), batch printing, preview (the first row holds the field names and every following row is one record; tick the rows to print and the `{{field}}` values come from that row. No "copies" column is needed in Excel; .xlsx/.xlsm/.xls and .csv are supported, and CSV auto-detects UTF-8 / Big5 and the delimiter)
- [x] Print calibration: density, speed, bold text, tear-off position, extra feed, horizontal/vertical position fine-tuning, and "Tools → Generate calibration label" (frame and mm ruler)
- [x] Native printer commands (`BARCODE` / `QRCODE`): optional (off by default); tick "Print with the printer's native commands" in the properties of a barcode or QR code. Content with Chinese characters, or rotated objects, automatically fall back to bitmap
- [ ] Application trust: code signing (Authenticode) to reduce Windows SmartScreen and antivirus warnings
- [x] Multi-language: the UI supports English, Spanish, German, Japanese, Korean, Simplified Chinese and Traditional Chinese. The language is chosen from the system language on first launch and can be changed with the globe button at the right of the menu bar. This README exists in seven languages too. The translations still need review by native speakers

> Note: the black/white bit definition of TSPL `BITMAP` (0 = print) is inverted in the program; please confirm the result on a real printer.

## License

Released under the [MIT License](LICENSE). Licenses of third-party packages are listed in the app under "Help → Third-party licenses".
