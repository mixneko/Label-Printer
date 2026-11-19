// 回歸測試：以真實滑鼠事件拖拉 QR 的縮放控制點，確認大小「連續、成比例」變化，並檢查屬性面板與未儲存標記。
// 需要開發模式的除錯介面（window.__lp，只在 `vite` 開發伺服器存在）。
// 用法（先在另一個視窗執行 `npx vite --port 1420 --strictPort`）：
//   node scripts/ui-drag-qr.mjs [輸出資料夾=.tools]    截圖放在「輸出資料夾\shots\qr-drag.png」
// 預期：拖拉後大小各不相同且接近滑鼠移動量；「每模組」說明隨之更新；檔名標籤出現「●」。// 以真實滑鼠事件拖拉 QR 的縮放控制點，確認大小跟著拖曳連續變化
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

import { resolve } from "node:path";
import { devServer, freePort } from "./_dev-server.mjs";
const SCRATCH = resolve(process.argv[2] ?? ".tools");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT = `${SCRATCH}\\shots`; mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 等到畫面真的準備好（標籤畫布已建立）；固定等待幾秒在開發伺服器第一次提供模組較慢時不可靠
const waitReady = async () => { for (let i = 0; i < 60; i++) { await sleep(250); if (await ev("!!document.querySelector('#stage canvas')").catch(() => false)) break; } await sleep(400); };const server = await devServer(); // 沒指定 VITE_URL 時由腳本自己啟動 Vite，結束時只關閉自己啟動的那一個
const URL = server.url;
const DEBUG_PORT = await freePort();
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${SCRATCH}\\edge3`, "--hide-scrollbars", "--no-first-run", "about:blank"], { stdio: "ignore" });
let page;
for (let i = 0; i < 40 && !page; i++) { await sleep(500); try { page = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()).find((t) => t.type === "page"); } catch { /* wait */ } }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
const mouse = (type, x, y) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });

const MOCK = `window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd) => cmd === 'list_printers' ? ['TSC'] : cmd === 'list_fonts' ? ['Microsoft JhengHei'] : null };`;
await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK });
await send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
await send("Page.navigate", { url: URL });
await waitReady();
await ev("document.getElementById('add-qr').click()");
await sleep(600);

const state = () => ev(`(() => { const r = document.querySelector('#stage .konvajs-content').getBoundingClientRect(); return { left: r.left, top: r.top, w: r.width, size: document.getElementById('prop-qrsize').value, info: document.getElementById('qr-info').textContent, snapDisabled: document.getElementById('qr-snap').disabled }; })()`);

const nodeNow = () => ev("JSON.stringify(window.__lp.node())").then((v) => JSON.parse(v));
let s = await state();
console.log(`初始：大小=${s.size}　${s.info}`);
console.log("  node:", JSON.stringify(await nodeNow()));
const sizes = [Number(s.size)];
for (const delta of [9, 31, -40, 55]) {
  s = await state();
  const a = JSON.parse(await ev("JSON.stringify(window.__lp.anchor('bottom-right'))")); // 舞台座標（已含縮放）
  const ax = s.left + a.x, ay = s.top + a.y;
  const before = await nodeNow();
  await mouse("mouseMoved", ax, ay);
  await mouse("mousePressed", ax, ay);
  for (let k = 1; k <= 8; k++) { await mouse("mouseMoved", ax + (delta * k) / 8, ay + (delta * k) / 8); await sleep(20); }
  await mouse("mouseReleased", ax + delta, ay + delta);
  await sleep(300);
  const t = await state(); const after = await nodeNow();
  const z = s.w / 480;
  console.log(`拖 ${delta >= 0 ? "+" : ""}${delta}px（約 ${(delta / z).toFixed(1)} dots）→ 大小 ${before?.qrSize} → ${after?.qrSize}　位置 (${before?.x},${before?.y}) → (${after?.x},${after?.y})　每模組 ${t.info.match(/約 ([\d.]+) 點/)?.[1]}`);
  sizes.push(Number(after?.qrSize));
}
// 手動輸入大小與「對齊整數模組」
await ev(`(() => { const i = document.getElementById('prop-qrsize'); i.value = '80'; i.dispatchEvent(new Event('change')); })()`);
await sleep(300); s = await state();
console.log(`輸入 80 → 大小=${s.size}　${s.info}`);
await ev("document.getElementById('qr-snap').click()");
await sleep(300); s = await state();
console.log(`按「對齊整數模組」→ 大小=${s.size}　${s.info}（按鈕停用=${s.snapDisabled}）`);
console.log('縮放後工具列檔名標籤:', await ev("document.getElementById('tpl-name').textContent"));
console.log("拖曳得到的大小序列:", sizes.join(" → "));

const r = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(`${OUT}\\qr-drag.png`, Buffer.from(r.result.data, "base64"));
ws.close(); edge.kill(); await server.stop(); process.exit(0);



