// 產生 winget（Windows 套件管理員）用的安裝清單：從 GitHub Release 下載安裝檔、算出 SHA256，寫出三個清單檔到
//   winget/manifests/b/b51/tw/LabelPrinter/<版本>/
// 這個目錄結構和 microsoft/winget-pkgs 倉庫一致，可以整個資料夾放進該倉庫送出 Pull Request（見 winget/README.md）。
//   node scripts/make-winget.mjs 1.0.0
// 只有正式版（沒有 -a／-b 後綴）才會被 winget 收錄；預發行版請不要送。
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("用法：node scripts/make-winget.mjs 1.0.0（只接受正式版版本號）");
  process.exit(1);
}
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "mixneko/Label-Printer";
const ID = "b51.tw.LabelPrinter";
const MANIFEST_VERSION = "1.10.0";
// GitHub 會把檔名裡的空白換成句點
const url = `https://github.com/${REPO}/releases/download/v${version}/Label.Printer_${version}_x64-setup.exe`;

console.log(`下載 ${url} ...`);
const res = await fetch(url, { redirect: "follow" });
if (!res.ok) {
  console.error(`下載失敗：HTTP ${res.status}（Release 要先存在，而且是公開的）`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
const sha = createHash("sha256").update(buf).digest("hex").toUpperCase();
console.log(`大小 ${buf.length} bytes，SHA256 ${sha}`);

// microsoft/winget-pkgs 的資料夾規則：manifests/<識別碼第一個字母的小寫>/<識別碼每一段>/<版本>
const dir = join(root, "winget", "manifests", ID[0].toLowerCase(), ...ID.split("."), version);
mkdirSync(dir, { recursive: true });
const header = (type) => `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.${MANIFEST_VERSION}.schema.json\n`;
const write = (name, text) => writeFileSync(join(dir, name), text, { encoding: "utf8" });

write(`${ID}.yaml`, header("version") + `PackageIdentifier: ${ID}
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: ${MANIFEST_VERSION}
`);

write(`${ID}.installer.yaml`, header("installer") + `PackageIdentifier: ${ID}
PackageVersion: ${version}
InstallerType: nullsoft
Scope: user
InstallModes:
- interactive
- silent
- silentWithProgress
UpgradeBehavior: install
ReleaseDate: ${new Date().toISOString().slice(0, 10)}
Installers:
- Architecture: x64
  InstallerUrl: ${url}
  InstallerSha256: ${sha}
ManifestType: installer
ManifestVersion: ${MANIFEST_VERSION}
`);

write(`${ID}.locale.en-US.yaml`, header("defaultLocale") + `PackageIdentifier: ${ID}
PackageVersion: ${version}
PackageLocale: en-US
Publisher: b51.tw
PublisherUrl: https://github.com/mixneko
PublisherSupportUrl: https://github.com/${REPO}/issues
Author: mixneko
PackageName: Label Printer
PackageUrl: https://github.com/${REPO}
License: MIT
LicenseUrl: https://github.com/${REPO}/blob/main/LICENSE
Copyright: Copyright (c) 2026 mixneko
ShortDescription: Open-source, free, lightweight label designer and printer for Windows.
Description: |-
  Lay out a label once, connect a data source (Excel, CSV, SQLite, Access, SQL Server, MySQL/MariaDB, PostgreSQL or any ODBC database) and print hundreds of different labels in one go.
  Supports TSPL, ZPL, EPL2, CPCL, DPL and SBPL label printers (everything except TSPL is experimental), and an A4 sticker-sheet layout with cut guide lines for ordinary printers.
  The interface is available in English, Traditional Chinese, Simplified Chinese, Spanish, German, Japanese and Korean.
Moniker: label-printer
Tags:
- barcode
- cpcl
- csv
- epl2
- excel
- label
- label-printer
- qr-code
- sticker
- tspl
- zpl
ReleaseNotesUrl: https://github.com/${REPO}/releases/tag/v${version}
ManifestType: defaultLocale
ManifestVersion: ${MANIFEST_VERSION}
`);

write(`${ID}.locale.zh-TW.yaml`, header("locale") + `PackageIdentifier: ${ID}
PackageVersion: ${version}
PackageLocale: zh-TW
Publisher: b51.tw
PublisherUrl: https://github.com/mixneko
PublisherSupportUrl: https://github.com/${REPO}/issues
Author: mixneko
PackageName: Label Printer
PackageUrl: https://github.com/${REPO}
License: MIT
LicenseUrl: https://github.com/${REPO}/blob/main/LICENSE
Copyright: Copyright (c) 2026 mixneko
ShortDescription: 開源、免費、輕量的 Windows 標籤設計與列印軟體。
Description: |-
  排好一張標籤、連接資料來源（Excel、CSV、SQLite、Access、SQL Server、MySQL／MariaDB、PostgreSQL，或任何有 ODBC 的資料庫），就能一次印出幾百張內容各不相同的標籤。
  支援 TSPL、ZPL、EPL2、CPCL、DPL、SBPL 標籤機（TSPL 以外為實驗性質），一般印表機也能用 A4 貼紙紙排版並印出裁切輔助線。
  介面提供繁體中文、简体中文、English、Español、Deutsch、日本語、한국어。
Tags:
- 條碼
- 標籤
- 標籤機
- 貼紙
- 列印
ReleaseNotesUrl: https://github.com/${REPO}/releases/tag/v${version}
ManifestType: locale
ManifestVersion: ${MANIFEST_VERSION}
`);
console.log(`已寫入 ${dir}`);
