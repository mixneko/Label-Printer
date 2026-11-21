// 回歸測試：開啟新檔要先問紙張與標籤尺寸；直接開程式要問「建立新標籤／開啟舊標籤」。
// 開發模式預設略過啟動詢問（其他測試都跑在開發伺服器上），這裡用 localStorage 的 lp.start=1 開啟。
//   node scripts/ui-start.mjs [輸出資料夾=.tools]
import { launch } from "./_cdp.mjs";
const MOCK = `(() => {
  window.__dialogs = 0;
  window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd) => {
    if (cmd === 'list_printers') return ['TSC TTP-244 Pro'];
    if (cmd === 'list_fonts') return ['Arial'];
    if (cmd === 'plugin:dialog|open') { window.__dialogs++; return null; }
    return null; } };
})();`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "start" });
const { ev, sleep, check } = t;
const isOpen = (id) => ev(`document.getElementById('${id}').open`);
const click = (id) => ev(`document.getElementById('${id}').click()`);
const setv = (id, v) => ev(`(() => { const e = document.getElementById('${id}'); e.value = ${JSON.stringify(String(v))}; e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const stored = () => ev("JSON.parse(localStorage.getItem('label-printer.settings'))");

// ---- 直接開程式 ----
await ev("localStorage.setItem('label-printer.settings', JSON.stringify({ setupDone: true, printerLang: 'tspl', tplWmm: 60, tplHmm: 30, paperWmm: 62.5, paperHmm: 30 })); localStorage.setItem('lp.start', '1')");
await t.reload(); await sleep(700);
check("直接開程式：跳出「建立新標籤／開啟舊標籤」", await isOpen("dlg-start"));
await t.shot("start");
await click("start-open"); await sleep(400);
check("按「開啟舊標籤」：關閉詢問並跳出選檔對話框", !(await isOpen("dlg-start")) && (await ev("window.__dialogs")) === 1);
await t.reload(); await sleep(700);
await click("start-new"); await sleep(400);
check("按「建立新標籤」：接著問紙張與標籤尺寸", !(await isOpen("dlg-start")) && (await isOpen("dlg-new")));
check("尺寸欄位預填目前設定", (await ev("document.getElementById('new-tpl-w').value")) === "60" && (await ev("document.getElementById('new-paper-w').value")) === "62.5");
await t.shot("new");
await click("new-cancel"); await sleep(200);
check("取消：不改設定、對話框關閉", !(await isOpen("dlg-new")) && (await stored()).tplWmm === 60);

// ---- 最近使用清單、取消、不要再顯示 ----
await ev("localStorage.setItem('label-printer.recent', JSON.stringify(['D:/標籤/A.lpxl', 'D:/標籤/B.lpxl']))");
await t.reload(); await sleep(700);
check("最近使用清單列出檔案", (await ev("[...document.querySelectorAll('#start-recent li b')].map(b => b.textContent).join('|')")) === "A.lpxl|B.lpxl");
await t.shot("start-recent");
await click("start-cancel"); await sleep(200);
check("取消：關閉歡迎視窗，維持空白標籤", !(await isOpen("dlg-start")));
check("沒勾選「不要再顯示」：下次還會問", (await ev("localStorage.getItem('label-printer.nostart')")) === null);
await t.reload(); await sleep(700);
await ev("document.getElementById('start-never').click()");
await click("start-cancel"); await sleep(200);
check("勾選「不要再顯示」後記下", (await ev("localStorage.getItem('label-printer.nostart')")) === "1");
await t.reload(); await sleep(700);
check("記下之後不再跳出歡迎視窗", !(await isOpen("dlg-start")));

// ---- 檔案 → 開啟新檔 ----
await ev("localStorage.removeItem('lp.start')"); await t.reload(); await sleep(600);
check("沒有 lp.start 的開發模式不問（不影響其他測試）", !(await isOpen("dlg-start")));
await ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }))"); await sleep(500);
check("Ctrl+N：先問紙張與標籤尺寸", await isOpen("dlg-new"));
await setv("new-tpl-w", 40); await setv("new-tpl-h", 20); await setv("new-paper-w", 42); await setv("new-gap", 3);
await click("new-ok"); await sleep(500);
const s = await stored();
check("確定：設定寫入並存檔", s.tplWmm === 40 && s.tplHmm === 20 && s.paperWmm === 42 && s.gapMm === 3, JSON.stringify(s));
check("畫布依新尺寸重建", (await ev("document.getElementById('stage-caption').textContent")).includes("40 × 20"));
check("工具選單的欄位同步更新", (await ev("document.getElementById('tpl-w').value")) === "40");
await ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }))"); await sleep(400);
await setv("new-tpl-w", 0);
await click("new-ok"); await sleep(300);
check("輸入無效尺寸：不關閉、不改設定", (await isOpen("dlg-new")) && (await stored()).tplWmm === 40);
await click("new-cancel"); await sleep(200);
check("取消後仍是原本的標籤尺寸", (await ev("document.getElementById('stage-caption').textContent")).includes("40 × 20"));
await t.finish();
