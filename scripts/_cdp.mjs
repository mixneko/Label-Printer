// UI 測試共用：啟動（或沿用）Vite、以 Edge 無頭模式載入畫面、提供 CDP 操作與 PASS / FAIL 判定。
// 用法見 ui-file.mjs / ui-format.mjs。Vite 的啟動與關閉由 _dev-server.mjs 負責（不使用背景工作）。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { devServer, freePort } from "./_dev-server.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

/**
 * @param {object} o
 * @param {string} [o.outDir]   輸出資料夾（截圖放在其下的 shots）
 * @param {string} o.mock       在頁面載入前注入的腳本（通常是模擬 window.__TAURI_INTERNALS__）
 * @param {string} o.prefix     截圖檔名前綴
 */
export async function launch({ outDir = ".tools", mock, prefix, width = 1400, height = 900, dark = false }) {
  const SCRATCH = resolve(outDir);
  const OUT = `${SCRATCH}\\shots`;
  mkdirSync(OUT, { recursive: true });
  const server = await devServer();
  const debugPort = await freePort();
  const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${SCRATCH}\\edge-${prefix}`, "--lang=zh-TW", "--hide-scrollbars", "--no-first-run", "about:blank"], { stdio: "ignore" });
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    await sleep(500);
    try { page = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === "page"); } catch { /* 等待 Edge */ }
  }
  if (!page) { edge.kill(); await server.stop(); throw new Error("Edge 沒有啟動"); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) console.log("JS 例外:", r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };

  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: mock });
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  const url = server.url;
  // 載入頁面，並等到畫面真的準備好（標籤畫布已建立）才繼續。固定等待幾秒不可靠：
  // 開發伺服器第一次提供模組較慢時，頁面還沒好就開始檢查會造成不穩定的失敗。
  const load = async () => {
    await send("Page.navigate", { url });
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      if (await ev("!!document.querySelector('#stage canvas') && typeof window.__lp === 'object'").catch(() => false)) break;
    }
    await sleep(400); // 讓印表機清單、字型清單等非同步初始化跑完
  };
  await load();

  let fails = 0;
  let passes = 0;
  return {
    ev, send, sleep,
    /** 重新載入頁面（localStorage 會保留；模擬的 window 變數會重置） */
    reload: load,
    shot: async (name) => {
      const r = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(`${OUT}\\${prefix}-${name}.png`, Buffer.from(r.result.data, "base64"));
    },
    check: (name, ok, detail = "") => {
      console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "　" + detail : ""}`);
      ok ? passes++ : fails++;
    },
    finish: async () => {
      console.log(`\n${fails === 0 ? `全部通過（${passes} 項）` : `${fails} 項失敗`}`);
      ws.close();
      edge.kill();
      await server.stop();
      process.exit(fails === 0 ? 0 : 1);
    },
  };
}
