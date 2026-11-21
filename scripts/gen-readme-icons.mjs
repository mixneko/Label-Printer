// 產生 README 用的圖示檔 docs/icons/*.svg。圖示來自 Lucide（https://lucide.dev ，ISC 授權）。
// README 是用 <img> 引用 SVG，<img> 裡的 currentColor 會變黑色（GitHub 深色主題看不見），所以這裡把線條顏色固定為藍色；
// 授權全文一併複製到 docs/icons/LICENSE。
//   node scripts/gen-readme-icons.mjs
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const COLOR = "#2563eb";
// README 的功能亮點與提示用到的圖示（對應 .tools/gen/gen_readme.py 的 ICON 表）
const NAMES = ["tag", "file-spreadsheet", "scan-search", "a-large-small", "crosshair", "globe", "lightbulb"];

const out = join(root, "docs/icons");
mkdirSync(out, { recursive: true });
for (const name of NAMES) {
  const svg = readFileSync(join(root, "node_modules/lucide-static/icons", `${name}.svg`), "utf8");
  const body = svg.match(/<svg[^>]*>([\s\S]*?)<\/svg>/)[1].replace(/\s*\n\s*/g, "").trim();
  writeFileSync(join(out, `${name}.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${COLOR}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>\n`);
}
copyFileSync(join(root, "node_modules/lucide-static/LICENSE"), join(out, "LICENSE"));
console.log(`已產生 ${NAMES.length} 個圖示與授權檔到 docs/icons/`);
