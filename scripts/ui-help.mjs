// 回歸測試：「說明」選單（關於、第三方授權聲明）。
//   node scripts/ui-help.mjs [輸出資料夾=.tools]
import { launch } from "./_cdp.mjs";
const MOCK = `window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd) => {
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
await t.finish();
