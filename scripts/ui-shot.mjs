// 視覺檢查用：以 Edge 無頭模式載入本機 Vite 開發伺服器，模擬 Tauri 後端回應後截圖。
// 用法（專案根目錄；腳本會自己啟動並關閉 Vite，不需要事先另外開）：
//   node scripts/ui-shot.mjs [輸出資料夾=.tools] [標籤=samples/sample-label.lpxl]
// 截圖放在「輸出資料夾\shots」。不需要 Tauri、不會連到真正的印表機。
import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { devServer, freePort } from "./_dev-server.mjs";

const [, , OUT_DIR = ".tools", TPL_PATH = "samples/sample-label.lpxl"] = process.argv;
const SCRATCH = resolve(OUT_DIR);
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT = `${SCRATCH}\\shots`;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 等到畫面真的準備好（標籤畫布已建立）；固定等待幾秒在開發伺服器第一次提供模組較慢時不可靠
const waitReady = async () => { for (let i = 0; i < 60; i++) { await sleep(250); if (await evalJs("!!document.querySelector('#stage canvas')").catch(() => false)) break; } await sleep(400); };const TPL = readFileSync(TPL_PATH, "utf8");

const server = await devServer(); // 沒指定 VITE_URL 時由腳本自己啟動 Vite，結束時只關閉自己啟動的那一個
const URL = server.url;
const DEBUG_PORT = await freePort();

const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${SCRATCH}\\edge`, "--hide-scrollbars", "--no-first-run", "about:blank"], { stdio: "ignore" });
let page;
for (let i = 0; i < 40 && !page; i++) {
  await sleep(500);
  try { page = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()).find((t) => t.type === "page"); } catch { /* 等待 Edge */ }
}
if (!page) { edge.kill(); throw new Error("Edge 沒有啟動"); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) console.log("JS 例外:", JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text));
  return r.result?.result?.value;
};
const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  (await import("node:fs")).writeFileSync(`${OUT}\\${name}.png`, Buffer.from(r.result.data, "base64"));
  console.log("已截圖", name);
};
const view = (w, h) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });

const MOCK = `
window.__TAURI_INTERNALS__ = {
  transformCallback: () => 0,
  invoke: async (cmd, args) => {
    switch (cmd) {
      case 'list_printers': return ['TSC TTP-244 Pro', 'Microsoft Print to PDF'];
      case 'list_fonts': return ['Arial','Consolas','Microsoft JhengHei','Microsoft JhengHei UI','Segoe UI','Times New Roman','新細明體','微軟正黑體'];
      case 'plugin:dialog|open': { const n = args?.options?.filters?.[0]?.name || ''; return n.includes('標籤') ? 'D:\\\\samples\\\\sample-label.lpxl' : 'D:\\\\samples\\\\sample-items.csv'; }
      case 'plugin:dialog|ask': return true;
      case 'read_text_file': return ${JSON.stringify(TPL)};
      case 'read_table': return { sheets: ['Items','Spare Parts'], sheet: 'Items', headers: ['Item','Code','Lot','Expiry'], rowNumbers: [1,2,3], rows: [['Screw M3x8 Stainless','A-1001','B2611','2027/11/30'],['Nylon Washer 6 mm','A-1002','B2611','2027/11/30'],['Anti-Static Foam Storage Box (Large)','C-20003-LONG','B2612','2028/05/31']] };
      default: console.warn('未模擬的指令', cmd); return null;
    }
  }
};`;
await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK });
await view(1366, 820);
await send("Page.navigate", { url: URL });
await waitReady();
await shot("1-empty");

// 檔案選單 → 開啟舊檔…
await evalJs("document.getElementById('file-menu').click()");
await sleep(250);
await evalJs("Array.from(document.querySelectorAll('#ctx-menu li')).find(l => l.querySelector(':scope > .label')?.textContent === '開啟舊檔…').click()");
await sleep(2500);
await evalJs("document.querySelectorAll('#layer-list li')[2].click()"); // 選到其中一個文字
await sleep(500);
await shot("2-template");

await evalJs("document.getElementById('import-file').click()");
await sleep(1500);
await evalJs("document.querySelectorAll('#data-table tr')[1].click()");
await sleep(800);
await sleep(500);
await shot("3-data");

await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
await sleep(500);
await shot("4-dark");

await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
await view(1280, 720);
await sleep(600);
await shot("5-1280");

ws.close();
edge.kill();
await server.stop();
process.exit(0);
