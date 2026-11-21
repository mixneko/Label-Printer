// 產生 index.html 裡的圖示區塊（SVG sprite）。圖示來自 Lucide（https://lucide.dev ，ISC 授權），
// 由 npm 套件 lucide-static 的 SVG 檔取出線條路徑；程式用 <use href="#i-…"> 引用。
//   node scripts/gen-icons.mjs        重新產生並寫回 index.html（在 ICONS:BEGIN／ICONS:END 之間）
//   node scripts/gen-icons.mjs --check   只檢查 index.html 是否與目前清單一致（不一致時結束代碼 1）
// 新增圖示：在下面的 ICONS 加一列「我們的 id: Lucide 圖示名稱」，再執行本腳本。
// 授權：Lucide 的授權全文由 `npm run licenses` 收進「說明 → 第三方授權聲明」。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ICONS = {
  // 既有（id 不變，只是改用 Lucide 官方圖形）
  open: "folder-open", save: "save", copy: "copy", table: "table", type: "type", qr: "qr-code", barcode: "barcode",
  square: "square", minus: "minus", image: "image", trash: "trash-2", printer: "printer", eye: "eye", "eye-off": "eye-off",
  lock: "lock", unlock: "lock-open", refresh: "refresh-cw", "zoom-in": "zoom-in", "zoom-out": "zoom-out", maximize: "maximize", focus: "focus", "door-open": "door-open", chevron: "chevron-down", x: "x",
  "align-l": "align-left", "align-c": "align-center", "align-r": "align-right", group: "group", ungroup: "ungroup",
  top: "arrow-up-to-line", up: "arrow-up", down: "arrow-down", bottom: "arrow-down-to-line",
  help: "circle-help", "eye-sm": "eye", globe: "globe", bulb: "lightbulb", undo: "undo-2", redo: "redo-2",
  // 新增：功能表、實驗標示、對話框
  flask: "flask-conical", sheet: "layout-grid", database: "database", "file-down": "file-down", "file-plus": "file-plus",
  "save-all": "save-all", scissors: "scissors", paste: "clipboard-paste", "copy-plus": "copy-plus", "select-all": "box-select",
  sliders: "sliders-horizontal", braces: "braces", ruler: "ruler", gauge: "gauge", scan: "scan-line", info: "info",
  scale: "scale", sparkles: "sparkles", panel: "panel-right", spreadsheet: "file-spreadsheet", plug: "plug",
  eraser: "eraser", download: "cloud-download", magnet: "magnet", history: "history", settings: "settings",
};

function inner(name) {
  const svg = readFileSync(join(root, "node_modules/lucide-static/icons", `${name}.svg`), "utf8");
  const m = svg.match(/<svg[^>]*>([\s\S]*?)<\/svg>/);
  if (!m) throw new Error(`讀不到圖示 ${name}`);
  return m[1].replace(/\s*\n\s*/g, "").replace(/\s+\/>/g, "/>").trim();
}

const symbols = Object.entries(ICONS).map(([id, name]) => `        <symbol id="i-${id}" viewBox="0 0 24 24">${inner(name)}</symbol>`);
const block =
`    <!-- ICONS:BEGIN -->
    <!-- 圖示：Lucide（ISC 授權，https://lucide.dev ）。由 scripts/gen-icons.mjs 自動產生，供 <use href="#i-…"> 引用；不要手改，要增減請改腳本裡的清單 -->
    <svg width="0" height="0" style="position:absolute" aria-hidden="true">
      <defs>
${symbols.join("\n")}
      </defs>
    </svg>
    <!-- ICONS:END -->`;

const file = join(root, "index.html");
const html = readFileSync(file, "utf8");
const re = /    <!-- ICONS:BEGIN -->[\s\S]*?<!-- ICONS:END -->/;
if (!re.test(html)) throw new Error("index.html 裡找不到 ICONS:BEGIN／ICONS:END 標記");
const next = html.replace(re, () => block);
if (process.argv.includes("--check")) {
  if (next !== html) { console.error("index.html 的圖示與清單不一致，請執行 node scripts/gen-icons.mjs"); process.exit(1); }
  console.log(`圖示一致（${Object.keys(ICONS).length} 個）`);
} else {
  writeFileSync(file, next);
  console.log(`已寫入 ${Object.keys(ICONS).length} 個圖示`);
}
