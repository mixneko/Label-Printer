// 回歸測試：「請作者喝杯啤酒」按鈕，以及一次列印 15 張以上後的小視窗。
//   node scripts/ui-donate.mjs [輸出資料夾=.tools]
import { launch } from "./_cdp.mjs";
const MOCK = `(() => {
  localStorage.setItem('label-printer.settings', JSON.stringify({ printerMode: 'windows', printerName: 'TSC', printerLang: 'tspl', setupDone: true }));
  window.__opened = []; window.__jobs = 0; window.__added = false; window.__calls = [];
  window.print = () => { window.__calls.push('print'); setTimeout(() => window.dispatchEvent(new Event('afterprint')), 50); };
  window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd, args) => {
    if (cmd === 'list_printers') return ['TSC']; if (cmd === 'list_fonts') return ['Arial'];
    if (cmd === 'plugin:app|version') return '1.0.4';
    if (cmd === 'open_url') { window.__opened.push(args.url); return null; }
    if (cmd === 'print_labels') { window.__jobs++; return null; }
    if (cmd === 'watch_print_jobs') { window.__calls.push('watch'); return true; }
    if (cmd === 'print_job_added') { window.__calls.push('check'); return window.__added; }
    return null; } };
})();`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "donate" });
const { ev, sleep, check } = t;
const isOpen = (id) => ev(`document.getElementById('${id}').open`);
const click = async (id) => { await ev(`document.getElementById('${id}').click()`); await sleep(300); };
const print = async (copies) => { await ev(`document.getElementById('copies').value = '${copies}'`); await click("print"); await sleep(500); };
const loaded = (id) => ev(`(() => { const e = document.getElementById('${id}'); const i = e.querySelector('img'); return i.complete && i.naturalWidth > 0; })()`);

await ev("document.getElementById('about-dialog').showModal()"); await sleep(300);
check("關於視窗有啤酒按鈕，圖示有載入", (await loaded("about-beer")) && (await ev("document.getElementById('about-beer').textContent.trim()")) === "請作者喝杯啤酒");
await t.shot("about");
await click("about-beer");
check("按下後開啟贊助頁", JSON.stringify(await ev("window.__opened")) === '["https://ko-fi.com/mixneko"]');
await click("about-close");

await print(14);
check("印 14 張：不出現小視窗", (await ev("window.__jobs")) === 1 && !(await isOpen("beer-dialog")));
await print(15);
check("印 15 張：出現小視窗並寫出張數", (await isOpen("beer-dialog")) && (await ev("document.getElementById('beer-msg').textContent")) === "剛剛送出了 15 張標籤。");
check("橫幅圖片有載入", await loaded("beer-dialog"));
check("預設焦點在「關閉」", (await ev("document.activeElement.id")) === "beer-close");
await t.shot("popup");
await click("beer-close");
check("「關閉」可關掉，且沒有開啟網頁", !(await isOpen("beer-dialog")) && (await ev("window.__opened.length")) === 1);
await print(20);
check("同一天第二次大量列印：不再出現", !(await isOpen("beer-dialog")));
// 以下把日期記錄改成別天，模擬隔天
const nextDay = () => ev("localStorage.setItem('label-printer.beer-day', 'Thu Jan 01 2026')");
await nextDay(); await print(20); await click("beer-x");
check("右上角 × 可關掉", !(await isOpen("beer-dialog")));
await nextDay(); await print(20); await click("beer-go");
check("小視窗的啤酒按鈕開啟贊助頁並關閉視窗", !(await isOpen("beer-dialog")) && (await ev("window.__opened.length")) === 2);
// A4／貼紙紙排版：看列印佇列有沒有新工作
const sheet = async (added) => {
  await nextDay();
  await ev(`window.__added = ${added}; window.__calls = []; document.getElementById('copies').value = '16'`);
  await ev("document.getElementById('print-more').click()"); await sleep(200);
  await ev("[...document.querySelectorAll('#ctx-menu li')].find(li => li.textContent.includes('A4')).click()"); await sleep(1200);
  await click("sh-print"); await sleep(1500);
};
await sheet(false);
check("排版列印按「取消」（佇列沒有新工作）：不出現", JSON.stringify(await ev("window.__calls")) === '["watch","print","check"]' && !(await isOpen("beer-dialog")), JSON.stringify(await ev("window.__calls")));
await click("sh-close");
await sheet(true);
check("排版列印真的送出（佇列有新工作）：出現", (await isOpen("beer-dialog")) && (await ev("document.getElementById('beer-msg').textContent")) === "剛剛送出了 16 張標籤。");
await t.finish();
