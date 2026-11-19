# Label Printer

[繁體中文](README.md) · [English](README.en.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · **Deutsch** · [日本語](README.ja.md) · [한국어](README.ko.md)

Eine schlanke Anwendung zum Gestalten und Drucken von Etiketten als Ersatz für BarTender Designer. Zieldrucker: TSC TTP-244 Pro (203 dpi, TSPL2); gedruckt wird über einen in Windows installierten Drucker (RAW) oder direkt per Raw TCP über einen Druckserver.

Technik: Tauri 2 (Rust-Backend) + TypeScript + Konva.js (Canvas-Editor).

## Entwicklungsumgebung (Windows)

1. [Node.js LTS](https://nodejs.org/)
2. [Rust](https://rustup.rs/) (benötigt MSVC: Workload „Desktopentwicklung mit C++“ der Visual Studio Build Tools installieren)
3. WebView2 Runtime (in Windows 11 enthalten)

```powershell
npm install
npm run tauri icon app-icon.png   # nur beim ersten Mal: erzeugt src-tauri/icons
npm run tauri dev                 # Entwicklungsmodus
cargo test --manifest-path src-tauri/Cargo.toml   # Rust-Unit-Tests
```

## Build und Bereitstellung

```powershell
npm run tauri build
```

Ergebnis:

- `src-tauri/target/release/Label Printer.exe`: eine einzelne ausführbare Datei, einfach kopieren und starten (benötigt WebView2, in Win11 enthalten).
- `src-tauri/target/release/bundle/nsis/*-setup.exe`: Installationsprogramm mit eingebettetem WebView2-Bootstrapper, daher auch unter Win10 installierbar; wird für den aktuellen Benutzer installiert und braucht keine Administratorrechte.

## Architektur

- Das Frontend rendert das Etikett als 1-Bit-Bitmap, das Backend wandelt es in TSPL um (`SIZE/GAP/BITMAP/PRINT`).
- Standardmäßig geht der Auftrag über den Windows-Spooler als **RAW**-Daten an einen installierten Drucker (der Treiber übersetzt nichts, das TSPL wird unverändert gesendet). Alternativ kann auf eine direkte Raw-TCP-Verbindung umgestellt werden (z. B. `192.168.1.100:9103`).
- Es werden die in Windows installierten Schriftarten verwendet (WebView2 liest `C:\Windows\Fonts` und die Schriftarten des Benutzers). Auf einem anderen Rechner müssen dieselben Schriftarten installiert sein.
- Papier 62,5×30 mm, Etikett 60×30 mm; beides lässt sich in der Oberfläche ändern, das Etikett wird auf dem Papier zentriert.
- Etikettentext kann `{{Feld}}`-Variablen verwenden (die Spaltenüberschriften der Excel-Datei). Anzahl gedruckter Etiketten = Anzahl der in der Datentabelle markierten Zeilen.

## Beispieldateien (`samples/`)

- `範例標籤.lpxl` + `範例貨品清單.csv`: ein fiktives Produktetikett (60×30 mm) mit passenden Daten (Felder: Name, Nummer, Charge, Ablaufdatum). Es zeigt Variablen, QR-Code, Barcode, Datumsformate und den „Maximalbereich“ des Textes (ein langer Produktname wird automatisch verkleinert).
- `商品清單.xlsx` (zwei Tabellenblätter) und `商品清單-big5.csv`: zum Testen des Imports.
- xlsx-/csv-Beispiele neu erzeugen: `cargo run --manifest-path src-tauri/Cargo.toml --example make_samples`

## Roadmap

- [x] Projektgerüst, Textobjekte, Drucken
- [x] Objekte für Barcode / QR-Code / Bild / Linie / Rechteck, Schriftarten-Auswahlliste (im System installierte Schriften)
- [x] Etiketten speichern und laden
- [x] Lokale Excel- / CSV-Datenquellen (Symbolleiste „Datenquelle auswählen“), Seriendruck, Vorschau (die erste Zeile enthält die Feldnamen, jede weitere Zeile ist ein Datensatz; markieren Sie die zu druckenden Zeilen, die `{{Feld}}`-Werte stammen aus der jeweiligen Zeile. In Excel ist keine Spalte „Anzahl“ nötig; unterstützt werden .xlsx/.xlsm/.xls und .csv, bei CSV werden UTF-8 / Big5 und das Trennzeichen automatisch erkannt)
- [x] Druckkalibrierung: Druckdichte, Geschwindigkeit, Fettdruck, Abreißposition, zusätzlicher Vorschub, Feinabstimmung der Position horizontal/vertikal sowie „Extras → Kalibrierungsetikett erzeugen“ (Rahmen und mm-Skala)
- [x] Native Druckerbefehle (`BARCODE` / `QRCODE`): optional (standardmäßig aus); in den Eigenschaften eines Barcodes oder QR-Codes „Mit den nativen Befehlen des Druckers drucken“ aktivieren. Bei chinesischen Zeichen im Inhalt oder gedrehten Objekten wird automatisch auf die Bitmap zurückgegriffen
- [ ] Vertrauenswürdigkeit der Anwendung: Codesignierung (Authenticode), um Warnungen von Windows SmartScreen und Virenscannern zu verringern
- [x] Mehrsprachigkeit: Die Oberfläche unterstützt Englisch, Spanisch, Deutsch, Japanisch, Koreanisch, vereinfachtes und traditionelles Chinesisch. Beim ersten Start wird die Systemsprache gewählt; ändern lässt sie sich über die Weltkugel-Schaltfläche rechts in der Menüleiste. Diese README gibt es ebenfalls in sieben Sprachen. Die Übersetzungen müssen noch von Muttersprachlern geprüft werden

> Hinweis: Die Schwarz-/Weiß-Bitdefinition von TSPL `BITMAP` (0 = drucken) wird im Programm invertiert; bitte das Ergebnis an einem echten Drucker prüfen.

## Lizenz

Veröffentlicht unter der [MIT-Lizenz](LICENSE). Die Lizenzen der Drittanbieter-Pakete stehen im Programm unter „Hilfe → Lizenzhinweise von Drittanbietern“.
