// 回歸測試：圖示（Lucide）。圖示庫完整、功能表項目都有圖示、「實驗中」標示用圖示、授權有收進去。
//   node scripts/ui-icons.mjs [輸出資料夾=.tools]
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { launch } from "./_cdp.mjs";
const MOCK = `window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd) => {
  if (cmd === 'list_printers') return ['TSC']; if (cmd === 'list_fonts') return ['Arial'];
  return null; } };`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "icons" });
const { ev, sleep, check } = t;

// ---- 圖示庫 ----
check("index.html 的圖示庫與 scripts/gen-icons.mjs 的清單一致", (() => { try { execSync("node scripts/gen-icons.mjs --check", { stdio: "pipe" }); return true; } catch { return false; } })());
const missing = await ev(`(() => { const ids = new Set([...document.querySelectorAll('symbol')].map((s) => s.id)); return [...document.querySelectorAll('use')].map((u) => (u.getAttribute('href') || '').slice(1)).filter((h) => h && !ids.has(h)); })()`);
check("畫面上每個 <use href=\"#i-…\"> 都找得到對應的圖示", missing.length === 0, JSON.stringify(missing));
check("每個圖示都有內容（有路徑或圖形）", (await ev("[...document.querySelectorAll('symbol')].every((s) => s.children.length > 0)")) === true);
check("圖示庫有 60 個以上", (await ev("document.querySelectorAll('symbol').length")) >= 60);
const lic = readFileSync("src/licenses.txt", "utf8");
check("授權聲明收了 Lucide（ISC）全文與 Feather（MIT）說明", lic.includes("lucide-static") && lic.includes("Lucide Icons and Contributors") && lic.includes("Feather") && lic.includes("Permission to use, copy, modify"));

// ---- 功能表：每個項目都有圖示 ----
const items = async (btn) => {
  await ev(`document.getElementById('${btn}').click()`); await sleep(300);
  const r = await ev(`JSON.stringify([...document.querySelectorAll('#ctx-menu > .menu > li:not(.sep)')].map((li) => ({ label: li.querySelector('.label')?.textContent ?? '', icon: li.querySelector('.ic-slot use')?.getAttribute('href') ?? '' })))`).then(JSON.parse);
  await ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"); await sleep(150);
  return r;
};
for (const [name, btn, minItems] of [["插入", "menu-insert", 6], ["編輯", "menu-edit", 10], ["檢視", "menu-view", 3], ["工具", "menu-tools", 6], ["說明", "help-menu", 5]]) {
  const r = await items(btn);
  const bare = r.filter((x) => !x.icon).map((x) => x.label);
  check(`「${name}」選單：${r.length} 個項目都有圖示`, r.length >= minItems && bare.length === 0, bare.join("、"));
}
const file = await items("file-menu");
const fileBare = file.filter((x) => !x.icon && !x.label.includes("沒有最近開啟")).map((x) => x.label);
check("「檔案」選單：開啟新檔、開啟舊檔、儲存、另存新檔都有圖示", file.filter((x) => x.icon).length >= 4 && fileBare.length === 0, fileBare.join("、"));
check("選單項目的圖示有對應到圖示庫", (await ev(`(() => { document.getElementById('menu-edit').click(); const ids = new Set([...document.querySelectorAll('symbol')].map((s) => '#' + s.id)); const ok = [...document.querySelectorAll('#ctx-menu .ic-slot use')].every((u) => ids.has(u.getAttribute('href'))); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return ok; })()`)) === true);
await ev("document.getElementById('menu-edit').click()"); await sleep(300);
await t.shot("edit-menu");
await ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"); await sleep(150);

// ▾ 選單
for (const [btn, n] of [["preview-print", 2], ["import-table", 3]]) {
  await ev(`document.getElementById('${btn}').click()`); await sleep(250);
  const c = await ev("[...document.querySelectorAll('#ctx-menu .ic-slot use')].length");
  check(`${btn} 的選單項目都有圖示`, c === n, String(c));
  await ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"); await sleep(150);
}

// ---- 沒有圖示的項目要留空位（文字才會對齊）----
await ev("document.getElementById('file-menu').click()"); await sleep(250);
const aligned = await ev("(() => { const lis = [...document.querySelectorAll('#ctx-menu > .menu > li:not(.sep)')]; return lis.every((li) => li.querySelector('.ic-slot')); })()");
check("檔案選單：沒有圖示的項目（最近開啟）也留了圖示空位，文字對齊", aligned === true);
await ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"); await sleep(150);

// ---- 實驗中標示：沒有表情符號，用圖示 ----
check("原始碼與介面都不再使用 ❗／⚠ 表情符號", !readFileSync("src/main.ts", "utf8").match(/[❗⚠]/) && !readFileSync("index.html", "utf8").match(/[❗⚠]/));
// QR 資訊列：整數／太小時前面有圖示
await ev("document.getElementById('add-qr').click()"); await sleep(500);
await ev("(() => { const i = document.getElementById('qr-size'); if (i) { i.value = '100'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); } })()"); await sleep(300);
const qrInfo = await ev("JSON.stringify({ text: document.getElementById('qr-info')?.textContent ?? '', icon: document.querySelector('#qr-info svg use')?.getAttribute('href') ?? '' })").then(JSON.parse);
check("QR 資訊列不再有 ✓／⚠ 文字符號", !/[✓⚠]/.test(qrInfo.text), qrInfo.text);
await t.shot("full");
await t.finish();
