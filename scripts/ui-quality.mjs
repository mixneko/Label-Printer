// 回歸測試：「列印品質與出紙」設定（濃度、速度、字體加粗、撕紙位置、額外送紙、間隙預設與舊設定升級）。
// 用法（先在另一個視窗執行 `npx vite --port 1420 --strictPort`）：
//   node scripts/ui-quality.mjs [輸出資料夾=.tools]    截圖放在「輸出資料夾\shots\quality-*.png」
// 以模擬的 print_labels 擷取「實際送給後端的列印工作」來驗證；結果以 PASS / FAIL 列出，有 FAIL 結束代碼為 1。
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
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${SCRATCH}\\edge6`, "--hide-scrollbars", "--no-first-run", "about:blank"], { stdio: "ignore" });
let page;
for (let i = 0; i < 40 && !page; i++) { await sleep(500); try { page = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()).find((t) => t.type === "page"); } catch { /* wait */ } }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log("JS 例外:", r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text); return r.result?.result?.value; };
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}\\quality-${name}.png`, Buffer.from(r.result.data, "base64")); };

let fails = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "　" + detail : ""}`); if (!ok) fails++; };

const MOCK = `
window.__jobs = [];
window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd, args) => {
  if (cmd === 'list_printers') return ['TSC TTP-244 Pro'];
  if (cmd === 'list_fonts') return ['Microsoft JhengHei'];
  if (cmd === 'print_labels') { window.__jobs.push(JSON.parse(JSON.stringify(args))); return null; }
  return null; } };`;
await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK });
await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });

// ---------- A. 舊設定升級（schema 1：間隙 3、沒有品質欄位、濃度超出範圍）----------
await send("Page.navigate", { url: URL }); await waitReady();
await ev(`localStorage.setItem('label-printer.settings', JSON.stringify({ paperWmm: 62.5, paperHmm: 30, tplWmm: 60, tplHmm: 30, gapMm: 3, printerMode: 'windows', printerName: 'TSC TTP-244 Pro', host: '1.2.3.4', port: 9103, density: 99, speed: 0 }))`);
await send("Page.navigate", { url: URL }); await waitReady();
check("舊設定升級：間隙由 3 改為 2（與 TSC 驅動一致）", (await ev("document.getElementById('gap').value")) === "2");
check("舊設定升級：保留使用者原本的 IP", (await ev("document.getElementById('host').value")) === "1.2.3.4");
check("濃度超出範圍 → 限制在 15", (await ev("document.getElementById('q-density').value")) === "15");
check("速度超出範圍 → 限制在 1", (await ev("document.getElementById('q-speed').value")) === "1");
await ev("localStorage.clear()");
await send("Page.navigate", { url: URL }); await waitReady();

// ---------- B. 預設值與實際送出的列印工作 ----------
check("預設：濃度 10、速度 4、加粗 0、撕紙位置開、額外送紙 0、間隙 2",
  (await ev(`[q('q-density').value, q('q-speed').value, q('q-bold').value, q('q-tear').checked, q('q-offset').value, q('gap').value].join(',')`.replace(/q\(/g, "document.getElementById(").replace("[document", "[document"))) === "10,4,0,true,0,2");
await ev("document.getElementById('add-text').click()"); await sleep(400);
await ev(`(() => { const t = document.getElementById('prop-text'); t.value = '濃淡測試 ABC 123'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await ev("document.getElementById('print').click()"); await sleep(500);
let j = JSON.parse(await ev("JSON.stringify(window.__jobs.at(-1))"));
const job0 = j.jobs[0];
check("按列印送出 print_labels", j.target?.kind === "windows" && j.jobs.length === 1);
check("送出：density=10、speed=4、tear=true、offsetMm=0、gapMm=2",
  job0.density === 10 && job0.speed === 4 && job0.tear === true && job0.offsetMm === 0 && job0.gapMm === 2,
  JSON.stringify({ d: job0.density, s: job0.speed, t: job0.tear, o: job0.offsetMm, g: job0.gapMm }));

// ---------- C. 調整後再送出 ----------
const setRange = (idName, v) => ev(`(() => { const i = document.getElementById(${JSON.stringify(idName)}); i.value = ${JSON.stringify(String(v))}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const setChange = (idName, v) => ev(`(() => { const i = document.getElementById(${JSON.stringify(idName)}); i.value = ${JSON.stringify(String(v))}; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await setRange("q-density", 13);
await setChange("q-speed", 2);
await ev("(() => { const c = document.getElementById('q-tear'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); })()");
await setChange("q-offset", 1.5);
check("濃度顯示值同步", (await ev("document.getElementById('q-density-val').textContent")) === "13");
await ev("document.getElementById('print').click()"); await sleep(500);
j = JSON.parse(await ev("JSON.stringify(window.__jobs.at(-1))"));
const job1 = j.jobs[0];
check("送出：density=13、speed=2、tear=false、offsetMm=1.5",
  job1.density === 13 && job1.speed === 2 && job1.tear === false && job1.offsetMm === 1.5,
  JSON.stringify({ d: job1.density, s: job1.speed, t: job1.tear, o: job1.offsetMm }));
check("額外送紙限制在 ±20mm", await (async () => { await setChange("q-offset", 99); return (await ev("document.getElementById('q-offset').value")) === "20"; })());

// ---------- D. 字體加粗 → 黑點變多（而且預覽會即時更新）----------
const darkCount = (b64) => { const bin = Buffer.from(b64, "base64"); let n = 0; for (const byte of bin) { let v = byte; while (v) { n += v & 1; v >>= 1; } } return n; };
const black = [];
for (const level of [0, 2, 4]) {
  await setRange("q-bold", level);
  await ev("document.getElementById('print').click()"); await sleep(400);
  const jb = JSON.parse(await ev("JSON.stringify(window.__jobs.at(-1))")).jobs[0];
  black.push(darkCount(jb.bitmap));
}
check("字體加粗：黑點數隨等級增加", black[0] < black[1] && black[1] < black[2], `加粗 0/2/4 → 黑點 ${black.join(" / ")}`);
check("加粗顯示值", (await ev("document.getElementById('q-bold-val').textContent")) === "+4");
await ev("document.getElementById('preview-btn').click()"); await sleep(300);
const prev = async () => ev(`(() => { const c = document.getElementById('preview'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 128) n++; return n; })()`);
const p4 = await prev();
await setRange("q-bold", 0); await sleep(300);
const p0 = await prev();
check("預覽已開啟時，調整加粗會即時更新預覽", p0 < p4, `加粗 4 → ${p4}，加粗 0 → ${p0}`);

// ---------- E. 設定會記住 ----------
await send("Page.navigate", { url: URL }); await waitReady();
check("重新開啟後設定維持（13 / 2 / 加粗 0 / 撕紙關 / 送紙 20）",
  (await ev(`[document.getElementById('q-density').value, document.getElementById('q-speed').value, document.getElementById('q-bold').value, document.getElementById('q-tear').checked, document.getElementById('q-offset').value].join(',')`)) === "13,2,0,false,20");
await ev("document.querySelectorAll('.panel details.card')[3]?.scrollIntoView()");
await shot("1-card");

console.log(`\n${fails === 0 ? "全部通過" : fails + " 項失敗"}`);
ws.close(); edge.kill(); await server.stop();
process.exit(fails === 0 ? 0 : 1);
