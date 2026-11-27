// 產生 README 用的各語言畫面截圖（docs/images/<語言>/）。
// 以 Edge 無頭模式載入本機 Vite、模擬 Tauri 後端（不連真正的印表機），載入 samples/sample-label.lpxl 與範例資料。
//   node scripts/make-readme-shots.mjs [語言代碼…]   例：node scripts/make-readme-shots.mjs en ja
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { devServer, freePort } from "./_dev-server.mjs";

const LANGS = process.argv.length > 2 ? process.argv.slice(2) : ["zh-TW", "en", "zh-CN", "es", "de", "ja", "ko"];
// 語言不只一個時，每個語言各開一個新的 Edge（--lang 與介面語言一致，避免 Edge 跳出「翻譯此頁」的提示圖示蓋在畫面上）
if (LANGS.length > 1) {
  for (const l of LANGS) spawnSync(process.execPath, [fileURLToPath(import.meta.url), l], { stdio: "inherit" });
  process.exit(0);
}
const TPL = readFileSync("samples/sample-label.lpxl", "utf8");
const SCRATCH = resolve(".tools/readme-shots");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(SCRATCH, { recursive: true });

const server = await devServer();
const port = await freePort();
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${SCRATCH}/edge`, "--hide-scrollbars", "--no-first-run", `--lang=${LANGS[0]}`, "--disable-features=Translate,TranslateUI", "about:blank"], { stdio: "ignore" });
let page;
for (let i = 0; i < 40 && !page; i++) { await sleep(500); try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch { /* wait */ } }
if (!page) { edge.kill(); throw new Error("Edge 沒有啟動"); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log("JS 例外:", r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text); return r.result?.result?.value; };
const waitReady = async () => { for (let i = 0; i < 80; i++) { await sleep(250); if (await ev("!!document.querySelector('#stage canvas') && document.querySelectorAll('#layer-list li').length > 3").catch(() => false)) break; } await sleep(500); };

const ROWS = [["Screw M3x8 Stainless", "A-1001", "B2611", "2027/11/30"], ["Nylon Washer 6 mm", "A-1002", "B2611", "2027/11/30"], ["Anti-Static Foam Storage Box (Large)", "C-20003-LONG", "B2612", "2028/05/31"], ["Hex Nut M3 Zinc", "A-1003", "B2701", "2028/01/31"], ["Cable Tie 200 mm Black", "D-3001", "B2702", "2029/06/30"]];
const MOCK = `
window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd, args) => {
  switch (cmd) {
    case 'list_printers': return ['Office Laser MFP', 'TSC TTP-244 Pro', 'Microsoft Print to PDF'];
    case 'list_odbc_sources': return { drivers: ['Microsoft Access Driver (*.mdb, *.accdb)', 'MySQL ODBC 8.0 Unicode Driver', 'ODBC Driver 17 for SQL Server', 'PostgreSQL Unicode(x64)'], dsns: [] };
    case 'list_fonts': return ['Arial', 'Segoe UI', 'Times New Roman', 'Consolas'];
    case 'startup_file': return 'D:/samples/sample-label.lpxl';
    case 'read_text_file': return ${JSON.stringify(TPL)};
    case 'plugin:dialog|open': return 'D:/samples/sample-items.csv';
    case 'path_exists': return true;
    case 'detect_printer_language': return { lang: 'tspl', driver: 'TSC TTP-244 Pro' };
    case 'is_installed': return false;
    case 'read_table': return { sheets: ['Items', 'Spare Parts'], sheet: 'Items', headers: ['Item', 'Code', 'Lot', 'Expiry'], rowNumbers: [1, 2, 3, 4, 5], rows: ${JSON.stringify(ROWS)} };
    default: return null;
  } } };`;
await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK });
await send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 820, deviceScaleFactor: 1, mobile: false });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });

for (const lang of LANGS) {
  const out = `docs/images/${lang}`; mkdirSync(out, { recursive: true });
  const shot = async (name) => { await ev("document.querySelectorAll('body > div:not([id])').forEach((e) => e.remove())"); const r = await send("Page.captureScreenshot", { format: "png" }); // Edge 在畫面左側會浮出「翻譯」小圖示（瀏覽器自己畫的，不在網頁裡，用 translate="no" 也關不掉）：從同一張圖往下 8 個格點（144 px）的背景複製一塊蓋掉
    const fixed = await ev(`new Promise((res) => { const im = new Image(); im.onload = () => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0); g.drawImage(im, 0, 380, 36, 80, 0, 236, 36, 80); res(c.toDataURL('image/png').split(',')[1]); }; im.src = 'data:image/png;base64,${r.result.data}'; })`);
    writeFileSync(`${out}/${name}.png`, Buffer.from(fixed, "base64")); console.log("已截圖", lang, name); };
  await send("Page.navigate", { url: server.url });
  await sleep(800);
  await ev(`localStorage.clear(); localStorage.setItem('label-printer.lang', ${JSON.stringify(lang)}); localStorage.setItem('label-printer.whatsnew-seen', '99.0.0');`);
  await send("Page.navigate", { url: server.url });
  await waitReady();
  await ev("document.documentElement.setAttribute('translate', 'no'); (document.head.appendChild(Object.assign(document.createElement('meta'), { name: 'google', content: 'notranslate' })))"); await sleep(1500);
  // 首次設定對話框：新安裝時的樣子（開發模式預設不跳，用 lp.wizard=1 開啟）。選好印表機後再拍，畫面上就有偵測到的語言
  await ev("localStorage.removeItem('label-printer.settings'); localStorage.setItem('lp.wizard', '1')");
  await send("Page.navigate", { url: server.url }); await waitReady(); await sleep(1500);
  await ev("(() => { const s = document.getElementById('printer-name'); s.value = 'TSC TTP-244 Pro'; s.dispatchEvent(new Event('change', { bubbles: true })); })()"); await sleep(1000);
  await shot("setup");
  await ev("localStorage.removeItem('lp.wizard'); localStorage.removeItem('label-printer.settings')");
  await send("Page.navigate", { url: server.url }); await waitReady(); await sleep(1200);
  await ev("document.querySelectorAll('#layer-list li')[5]?.click()"); await sleep(400);
  await shot("editor");
  await ev("document.getElementById('import-file').click()"); await sleep(1500);
  await ev("[...document.querySelectorAll('#data-table tr')].slice(1, 4).forEach((r) => r.querySelector('input[type=checkbox]')?.click())"); await sleep(400);
  await ev("document.querySelectorAll('#data-table tr')[1]?.querySelectorAll('td')[2]?.click()"); await sleep(600);
  await shot("data");
  // 連線到資料庫對話框（ODBC 範例）
  await ev("import('/src/dbdialog.ts').then((m) => m.openDbDialog())"); await sleep(900);
  await ev("(() => { const k = document.getElementById('db-kind'); k.value = 'odbc'; k.dispatchEvent(new Event('change', { bubbles: true })); })()"); await sleep(300);
  await ev("(() => { const s = document.getElementById('db-src'); s.value = 'drv:ODBC Driver 17 for SQL Server'; s.dispatchEvent(new Event('change', { bubbles: true })); document.getElementById('db-cs').value = 'Driver={ODBC Driver 17 for SQL Server};Server=db.example.com;Database=shop;'; document.getElementById('db-sql').value = \"SELECT Item, Code, Lot, Expiry FROM items WHERE Lot = 'B2611'\"; })()"); await sleep(500);
  await shot("db");
  await ev("document.getElementById('dlg-db').close()"); await sleep(300);
  await ev("document.getElementById('preview-direct').click()"); await sleep(1200);
  await shot("preview");
  await ev("document.getElementById('pv-dialog').close()"); await sleep(300);
  // 「列印」右邊的 ▾ 選單
  await ev("document.getElementById('preview-print').click()"); await sleep(600);
  await shot("menu");
  await ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"); await sleep(300);
  await ev("document.getElementById('dlg-quality').showModal()"); await sleep(500);
  await shot("settings");
  await ev("document.querySelectorAll('dialog[open]').forEach((d) => d.close()); document.getElementById('dlg-printer').showModal()"); await sleep(1200);
  await shot("printer");
  // 貼紙紙／A4 排版：勾選的 3 筆資料 × 每筆 9 張，剛好排滿一頁
  await ev("document.querySelectorAll('dialog[open]').forEach((d) => d.close()); document.getElementById('copies').value = '9'"); await sleep(200);
  await ev("import('/src/sheetprint.ts').then((m) => m.openSheet())"); await sleep(2500);
  await shot("sheet");
  await ev("document.querySelectorAll('dialog[open]').forEach((d) => d.close()); document.getElementById('copies').value = '1'"); await sleep(300);
  await ev("document.getElementById('make-calibration').click()"); await sleep(1200);
  await ev("document.querySelectorAll('dialog[open]').forEach((d) => d.close()); document.getElementById('data-panel') && (document.getElementById('data-panel').hidden = true)"); await sleep(500);
  await shot("calibration");
}
ws.close(); edge.kill(); await server.stop(); process.exit(0);
