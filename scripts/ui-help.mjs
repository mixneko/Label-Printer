// 回歸測試：「說明」選單（關於、第三方授權聲明）。
//   node scripts/ui-help.mjs [輸出資料夾=.tools]
import { launch } from "./_cdp.mjs";
const MOCK = `window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd, args) => {
  if (cmd === 'plugin:app|version') return '1.0.5';
  if (cmd === 'open_url') { (window.__opened ||= []).push(args.url); return null; }
  if (cmd === 'list_printers') return ['TSC']; if (cmd === 'list_fonts') return ['Microsoft JhengHei'];
  return null; } };`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "help" });
const { ev, sleep, check } = t;
const items = () => ev("JSON.stringify([...document.querySelectorAll('#ctx-menu [role=menuitem]')].map(e => e.textContent.trim()))").then(JSON.parse);

await ev("document.getElementById('help-menu').click()"); await sleep(300);
const it = await items();
check("按「說明」出現選單：關於、第三方授權聲明", it.some((s) => s.includes("關於")) && it.some((s) => s.includes("第三方授權聲明")), JSON.stringify(it));
await ev("[...document.querySelectorAll('#ctx-menu [role=menuitem]')].find(e => e.textContent.trim().startsWith('第三方授權聲明'))?.click()"); await sleep(500);
check("開啟授權聲明對話框", await ev("document.getElementById('lic-dialog').open"));
const txt = await ev("document.getElementById('lic-text').textContent");
check("內容含主要套件（konva、qrcode、jsbarcode、calamine、tauri）", ["konva ", "qrcode ", "jsbarcode ", "calamine ", "tauri "].every((k) => txt.includes(k)));
check("含授權全文（MIT License 與 Apache License）", txt.includes("Permission is hereby granted") && txt.includes("Apache License"));
await t.shot("2-licenses");
await ev("document.getElementById('lic-close').click()"); await sleep(200);
check("關閉授權對話框", !(await ev("document.getElementById('lic-dialog').open")));

await ev("document.getElementById('help-menu').click()"); await sleep(300);
await ev("[...document.querySelectorAll('#ctx-menu [role=menuitem]')].find(e => e.textContent.trim().startsWith('關於'))?.click()"); await sleep(500);
check("開啟「關於」對話框", await ev("document.getElementById('about-dialog').open"));
await ev("document.getElementById('about-licenses').click()"); await sleep(400);
check("關於 → 第三方授權聲明", (await ev("document.getElementById('lic-dialog').open")) && !(await ev("document.getElementById('about-dialog').open")));
// ---- 新功能 ----
await ev("document.getElementById('help-menu').click()"); await sleep(300);
const it2 = await items();
check("「說明」選單多了「檢查新版本」「新功能」", it2.some((s) => s === "檢查新版本") && it2.some((s) => s === "新功能"), JSON.stringify(it2));
await ev("[...document.querySelectorAll('#ctx-menu [role=menuitem]')].find(e => e.textContent.trim() === '新功能')?.click()"); await sleep(400);
check("新功能視窗開啟並列出各版本", (await ev("document.getElementById('whatsnew-dialog').open")) && (await ev("document.querySelectorAll('#whatsnew-body h3').length")) >= 4);
check("最新版在最上面", (await ev("document.querySelector('#whatsnew-body h3').textContent")) === "版本 1.0.5");
await t.shot("3-whatsnew");
await ev("document.getElementById('whatsnew-close').click()"); await sleep(200);
// ---- 啟動時的新功能：版本比上次看過的新才顯示 ----
check("第一次安裝（沒有記錄）不打擾，只記下版本", (await ev("localStorage.getItem('label-printer.whatsnew-seen')")) === "1.0.5" && !(await ev("document.getElementById('whatsnew-dialog').open")));
// ---- 檢查新版本（模擬 GitHub 回應）----
const fake = (body, status = 200) => ev(`window.fetch = async () => ({ ok: ${status === 200}, status: ${status}, json: async () => (${JSON.stringify(body)}) })`);
const run = async () => { await ev("document.getElementById('help-menu').click()"); await sleep(250);
  await ev("[...document.querySelectorAll('#ctx-menu [role=menuitem]')].find(e => e.textContent.trim() === '檢查新版本')?.click()"); await sleep(500); };
const msg = () => ev("document.getElementById('update-msg').textContent");
const goHidden = () => ev("document.getElementById('update-go').hidden");
await fake({ tag_name: "v1.0.5", html_url: "https://github.com/mixneko/Label-Printer/releases/tag/v1.0.5" }); await run();
check("版本相同：已是最新版本、沒有下載按鈕", (await msg()) === "目前已是最新版本（1.0.5）" && (await goHidden()));
await ev("document.getElementById('update-close').click()"); await sleep(150);
await fake({ tag_name: "v1.0.6", html_url: "https://github.com/mixneko/Label-Printer/releases/tag/v1.0.6" }); await run();
check("有新版本（1.0.6 > 1.0.5，預發行後綴依字母比較）：顯示並出現下載按鈕", (await msg()) === "有新版本 1.0.6（目前 1.0.5）" && !(await goHidden()), await msg());
await ev("document.getElementById('update-go').click()"); await sleep(200);
check("前往下載頁面：呼叫 open_url 並帶上 release 網址", JSON.stringify(await ev("window.__opened")) === JSON.stringify(["https://github.com/mixneko/Label-Printer/releases/tag/v1.0.6"]));
await ev("document.getElementById('update-close').click()"); await sleep(150);
await fake({}, 404); await run();
check("找不到 release", (await msg()) === "找不到已發布的版本。" && (await goHidden()));
await ev("document.getElementById('update-close').click()"); await sleep(150);
await ev("window.fetch = async () => { throw new Error('offline'); }"); await run();
check("離線：顯示錯誤說明、沒有下載按鈕", (await msg()).startsWith("無法檢查新版本") && (await goHidden()));
await ev("document.getElementById('update-close').click()"); await sleep(150);
// ---- 更新後第一次開啟：自動顯示「上次看過的版本之後」的新功能 ----
await ev("localStorage.setItem('label-printer.whatsnew-seen', '0.9.1')");
await ev("location.reload()"); await sleep(2500);
check("更新後第一次開啟自動顯示新功能（完整歷史由新到舊堆疊）", (await ev("document.getElementById('whatsnew-dialog').open"))
  && JSON.stringify(await ev("[...document.querySelectorAll('#whatsnew-body h3')].map(h => h.textContent)")) === JSON.stringify(["版本 1.0.5", "版本 1.0.4", "版本 1.0.3", "版本 1.0.2", "版本 1.0.1", "版本 1.0.0", "版本 0.9.9", "版本 0.9.8", "版本 0.9.7", "版本 0.9.6", "版本 0.9.5", "版本 0.9.4", "版本 0.9.3", "版本 0.9.2", "版本 0.9.1", "版本 0.9.0"]));
// ---- 從沒有「看過的版本」記錄的舊版（0.8.7）直接升級：留有設定 → 要顯示 0.8.7 之後的全部說明 ----
await ev("localStorage.removeItem('label-printer.whatsnew-seen'); localStorage.setItem('label-printer.settings', '{}')");
await ev("location.reload()"); await sleep(2500);
check("從 0.8.7 跳版升級：自動列出 0.9.0～1.0.5 全部說明", (await ev("document.getElementById('whatsnew-dialog').open"))
  && JSON.stringify(await ev("[...document.querySelectorAll('#whatsnew-body h3')].map(h => h.textContent)")) === JSON.stringify(["版本 1.0.5", "版本 1.0.4", "版本 1.0.3", "版本 1.0.2", "版本 1.0.1", "版本 1.0.0", "版本 0.9.9", "版本 0.9.8", "版本 0.9.7", "版本 0.9.6", "版本 0.9.5", "版本 0.9.4", "版本 0.9.3", "版本 0.9.2", "版本 0.9.1", "版本 0.9.0"]));
check("看過之後記下目前版本", (await ev("localStorage.getItem('label-printer.whatsnew-seen')")) === "1.0.5");
// ---- 版本比較：預發行後綴 ----
const cv = (a, b) => ev(`(async () => (await import('/src/update.ts')).compareVersions(${JSON.stringify(a)}, ${JSON.stringify(b)}))()`);
check("版本比較：1.0.1 > 1.0.0 > 1.0.0-e > 1.0.0-a > 0.9.9；0.9.10 > 0.9.9；相同為 0",
  (await cv("1.0.1", "1.0.0")) > 0 && (await cv("1.0.0", "1.0.0-e")) > 0 && (await cv("1.0.0-e", "1.0.0-a")) > 0 && (await cv("1.0.0-a", "0.9.9")) > 0 && (await cv("0.9.10", "0.9.9")) > 0 && (await cv("v1.0.0", "1.0.0")) === 0);
await t.finish();
