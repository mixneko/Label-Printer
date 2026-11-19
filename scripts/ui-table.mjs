// 回歸測試：資料表面板（Excel 原樣呈現 vs CSV 只取資料）與「拖拉調整高度」。
// 需要開發模式的除錯介面不是必須；用法（先在另一個視窗執行 `npx vite --port 1420 --strictPort`）：
//   node scripts/ui-table.mjs [輸出資料夾=.tools]    截圖放在「輸出資料夾\shots\table-*.png」
// 結果以 PASS / FAIL 列出；有任何 FAIL 時結束代碼為 1。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { devServer, freePort } from "./_dev-server.mjs";

const SCRATCH = resolve(process.argv[2] ?? ".tools");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT = `${SCRATCH}\\shots`; mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 等到畫面真的準備好（標籤畫布已建立）；固定等待幾秒在開發伺服器第一次提供模組較慢時不可靠
const waitReady = async () => { for (let i = 0; i < 60; i++) { await sleep(250); if (await ev("!!document.querySelector('#stage canvas')").catch(() => false)) break; } await sleep(400); };
const server = await devServer(); // 沒指定 VITE_URL 時由腳本自己啟動 Vite，結束時只關閉自己啟動的那一個
const URL = server.url;
const DEBUG_PORT = await freePort();
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${SCRATCH}\\edge5`, "--hide-scrollbars", "--no-first-run", "about:blank"], { stdio: "ignore" });
let page;
for (let i = 0; i < 40 && !page; i++) { await sleep(500); try { page = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()).find((t) => t.type === "page"); } catch { /* wait */ } }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log("JS 例外:", r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text); return r.result?.result?.value; };
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}\\table-${name}.png`, Buffer.from(r.result.data, "base64")); };
const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });

let fails = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "　" + detail : ""}`); if (!ok) fails++; };

// 模擬後端：window.__kind = 'excel'（有空白列、列號不連續、紅字/粗體/底色）或 'csv'（只有資料、流水號、無格式）
const MOCK = `
window.__kind = 'excel';
const RED = { color: '#ff0000' };
window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd) => {
  if (cmd === 'list_printers') return ['TSC'];
  if (cmd === 'list_fonts') return ['Microsoft JhengHei'];
  if (cmd === 'plugin:dialog|open') return 'D:\\\\data.xlsx';
  if (cmd === 'read_table') {
    if (window.__kind === 'csv') return { sheets: ['CSV'], sheet: 'CSV', headers: ['客戶名稱','出貨日期','訂單編號'],
      rows: [['圜達實業','','115-1104-0001'],['傑比達','2026-11-18','115-1029-0004'],['加拿大鵝','','115-1111-0002']], rowNumbers: [1,2,3] };
    return { sheets: ['出貨','其他'], sheet: '出貨', headers: ['客戶名稱','出貨日期','訂單編號'],
      rows: [
        ['圜達實業','','115-1104-0001'], ['圜達實業','','115-1104-0001'],
        ['傑比達','2026-11-18','115-1029-0004'], ['傑比達','2026-11-18','115-1029-0004'],
        ['','',''], ['','',''],
        ['加拿大鵝','','115-1111-0002'], ['加拿大鵝','','115-1111-0002'] ],
      rowNumbers: [5,6,7,8,9,10,11,12],
      styles: [
        [RED, null, RED], [RED, null, RED], [null, null, null], [null, null, { bold: true, bg: '#ffff00' }],
        [null, null, null], [null, null, null], [RED, null, RED], [RED, null, RED] ] };
  }
  return null; } };`;
await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK });
await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
await send("Page.navigate", { url: URL });
await waitReady();

const q = (sel) => ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const count = () => ev("document.getElementById('data-count').textContent");

// ---------- A. Excel：原樣呈現 ----------
await ev("document.getElementById('import-table').click()");
await sleep(800);
check("Excel：資料表開啟", !(await ev("document.getElementById('data-panel').hidden")));
check("Excel：保留 2 列空白列", (await q("#data-table tr.blank")) === 2, `blank=${await q("#data-table tr.blank")}`);
check("Excel：共顯示 8 列資料（含空白列）", (await q("#data-table tr:not(:first-child)")) === 8);
const nums = await ev("Array.from(document.querySelectorAll('#data-table td.num')).map(x => x.textContent).join(',')");
check("Excel：列號對齊 Excel（5～12）", nums === "5,6,7,8,9,10,11,12", nums);
check("Excel：紅字儲存格顯示紅色", (await ev("getComputedStyle(document.querySelectorAll('#data-table tr')[1].children[2]).color")) === "rgb(255, 0, 0)");
check("Excel：沒有格式的儲存格維持預設色", (await ev("getComputedStyle(document.querySelectorAll('#data-table tr')[3].children[2]).color")) !== "rgb(255, 0, 0)");
check("Excel：粗體＋底色儲存格", (await ev(`(() => { const c = document.querySelectorAll('#data-table tr')[4].children[4]; const s = getComputedStyle(c); return s.fontWeight === '700' && s.backgroundColor === 'rgb(255, 255, 0)'; })()`)));
check("Excel：空白列的勾選框停用", await ev("Array.from(document.querySelectorAll('#data-table tr.blank td input')).every(i => i.disabled)"));
check("Excel：計數只算可列印的列", (await count()).includes("0 / 6"), await count());
await ev("document.getElementById('data-all').click()"); await sleep(200);
check("Excel：全選不含空白列", (await count()).includes("6 / 6"), await count());
await ev("document.getElementById('data-none').click()"); await sleep(100);
await ev("document.querySelectorAll('#data-table tr:not(:first-child) td input')[0].click()");
await ev("document.querySelectorAll('#data-table tr:not(:first-child) td input')[1].click()"); await sleep(100);
await ev("document.getElementById('data-invert').click()"); await sleep(200);
check("Excel：反選不含空白列（2 → 4）", (await count()).includes("4 / 6"), await count());
await ev("document.querySelectorAll('#data-table tr.blank')[0].click()"); await sleep(200);
check("Excel：點空白列不會被選為目前列", (await q("#data-table tr.active")) === 0);
await ev("document.querySelectorAll('#data-table tr:not(:first-child)')[2].click()"); await sleep(200);
check("Excel：點資料列 → 成為目前列", (await q("#data-table tr.active")) === 1);
await shot("1-excel");

// ---------- B. CSV：只取資料 ----------
await ev("window.__kind = 'csv'");
await ev("document.getElementById('data-reload').click()"); await sleep(600);
check("CSV：沒有空白列", (await q("#data-table tr.blank")) === 0);
const nums2 = await ev("Array.from(document.querySelectorAll('#data-table td.num')).map(x => x.textContent).join(',')");
check("CSV：列號為流水號 1,2,3", nums2 === "1,2,3", nums2);
check("CSV：沒有套用任何顏色", await ev("Array.from(document.querySelectorAll('#data-table tr:not(:first-child) td:not(.num)')).every(c => !c.getAttribute('style'))"));
await ev("window.__kind = 'excel'; document.getElementById('data-reload').click()"); await sleep(600);

// ---------- C. 拖拉調整資料表高度 ----------
const geom = () => ev(`JSON.stringify((() => { const g = document.getElementById('data-resizer').getBoundingClientRect(); const p = document.getElementById('data-panel').getBoundingClientRect(); return { gx: g.x + g.width / 2, gy: g.y + g.height / 2, h: p.height, win: window.innerHeight }; })())`).then(JSON.parse);
const drag = async (dy) => {
  const g = await geom();
  await mouse("mouseMoved", g.gx, g.gy); await mouse("mousePressed", g.gx, g.gy);
  for (let k = 1; k <= 8; k++) { await mouse("mouseMoved", g.gx, g.gy + (dy * k) / 8); await sleep(15); }
  await mouse("mouseReleased", g.gx, g.gy + dy); await sleep(150);
  return (await geom()).h;
};
const h0 = (await geom()).h;
check("預設高度 250", Math.abs(h0 - 250) <= 2, `h=${h0}`);
let h1 = await drag(-100); // 往上拖 100px
check("往上拖 100px → 變高約 100", Math.abs(h1 - (h0 + 100)) <= 3, `${h0} → ${h1}`);
let h2 = await drag(+60);
check("往下拖 60px → 變矮約 60", Math.abs(h2 - (h1 - 60)) <= 3, `${h1} → ${h2}`);
let h3 = await drag(+800);
check("拖到最矮 → 不低於 140", Math.abs(h3 - 140) <= 2, `h=${h3}`);
const g3 = await geom();
let h4 = await drag(-2000);
check("拖到最高 → 不超過視窗的 75%", h4 <= g3.win * 0.75 + 2 && h4 > h3, `h=${h4}（視窗 ${g3.win}）`);
await shot("2-tall");
const saved = Number(await ev("localStorage.getItem('label-printer.dataPanelHeight')"));
check("高度會記住（localStorage）", Math.abs(saved - h4) <= 2, `saved=${saved}`);
await ev("document.getElementById('data-resizer').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))"); await sleep(150);
check("雙擊把手 → 還原 250", Math.abs((await geom()).h - 250) <= 2, `h=${(await geom()).h}`);
await ev("document.getElementById('data-resizer').focus()");
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 }); await sleep(150);
check("鍵盤 ↑ → 增加 24", Math.abs((await geom()).h - 274) <= 2, `h=${(await geom()).h}`);

// 重新載入頁面後，高度應維持
await send("Page.navigate", { url: URL }); await waitReady();
await ev("document.getElementById('import-table').click()"); await sleep(800);
check("重新開啟後高度維持（274）", Math.abs((await geom()).h - 274) <= 2, `h=${(await geom()).h}`);

console.log(`\n${fails === 0 ? "全部通過" : fails + " 項失敗"}`);
ws.close(); edge.kill(); await server.stop();
process.exit(fails === 0 ? 0 : 1);
