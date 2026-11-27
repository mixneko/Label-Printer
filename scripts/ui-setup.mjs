// 回歸測試：首次設定（新安裝時要使用者自己選列印用的印表機與標籤語言，不替使用者決定）。
// 開發模式預設略過這個對話框（其他測試都跑在開發伺服器上），這裡用 localStorage 的 lp.wizard=1 開啟。
//   node scripts/ui-setup.mjs [輸出資料夾=.tools]
import { launch } from "./_cdp.mjs";
const MOCK = `(() => {
  window.__jobs = [];
  window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd, args) => {
    if (cmd === 'list_printers') return ['Office Laser MFP', 'TSC TTP-244 Pro', 'Zebra ZD420', 'Mystery Printer'];
    if (cmd === 'list_fonts') return ['Arial'];
    if (cmd === 'detect_printer_language') { const m = { 'TSC TTP-244 Pro': 'tspl', 'Zebra ZD420': 'zpl', 'Office Laser MFP': 'office' }; return { lang: m[args.name] ?? null, driver: args.name + ' driver' }; }
    if (cmd === 'print_labels') { window.__jobs.push(args); return null; }
    return null; } };
})();`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "setup" });
const { ev, sleep, check } = t;
const val = (id) => ev(`document.getElementById('${id}').value`);
const open = () => ev("document.getElementById('dlg-printer').open");
const vis = (id) => ev(`!document.getElementById('${id}').hidden`);
const stored = () => ev("JSON.parse(localStorage.getItem('label-printer.settings') || 'null')");
const setv = (id, v) => ev(`(() => { const e = document.getElementById('${id}'); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const fresh = async () => { await ev("localStorage.removeItem('label-printer.settings'); localStorage.setItem('lp.wizard', '1')"); await t.reload(); await sleep(600); };

// ---- 新安裝：自動跳出，不替使用者選 ----
await fresh();
check("新安裝：自動跳出印表機設定對話框（首次設定模式）", (await open()) && (await vis("printer-title-setup")) && !(await vis("printer-title")) && (await vis("printer-setup-msg")));
check("首次設定：顯示「確定」「稍後再設定」，隱藏一般的「關閉」", (await vis("printer-setup-ok")) && (await vis("printer-setup-later")) && !(await vis("printer-close")));
check("沒有預先替使用者選印表機（停在「請選擇印表機」，不是事務機也不是 TSC）", (await val("printer-name")) === "" && (await ev("document.getElementById('printer-name').options[0].textContent")) === "（請選擇印表機）");
check("清單列出這台電腦所有印表機", (await ev("[...document.getElementById('printer-name').options].slice(1).map(o => o.value).join('|')")) === "Office Laser MFP|TSC TTP-244 Pro|Zebra ZD420|Mystery Printer");
check("還沒選印表機：「確定」停用", await ev("document.getElementById('printer-setup-ok').disabled"));
await t.shot("dialog");

// 還沒選就按列印：不送出，並提示
await ev("document.getElementById('printer-setup-later').click()"); await sleep(300);
check("按「稍後再設定」關閉對話框，設定仍未完成", !(await open()) && (await stored())?.setupDone === false);
await ev("document.getElementById('add-text').click()"); await sleep(300);
await ev("document.getElementById('print').click()"); await sleep(500);
check("還沒選印表機就按列印：不送出 print_labels，並帶回設定對話框", (await ev("window.__jobs.length")) === 0 && (await open()) && (await vis("printer-title-setup")));
check("狀態列提示尚未選擇印表機", (await ev("document.getElementById('status').textContent")).includes("尚未選擇印表機"));

// 選印表機：確定啟用、語言自動偵測
await setv("printer-name", "Zebra ZD420"); await sleep(500);
check("選了印表機：「確定」啟用", (await ev("!document.getElementById('printer-setup-ok').disabled")) === true);
check("同時顯示偵測到的標籤語言（ZPL）", (await ev("document.getElementById('printer-lang-hint').textContent")).includes("ZPL"));
await ev("document.getElementById('printer-setup-ok').click()"); await sleep(400);
const s = await stored();
check("按「確定」：對話框關閉，記下印表機並標記設定完成", !(await open()) && s.printerName === "Zebra ZD420" && s.setupDone === true, JSON.stringify({ n: s.printerName, d: s.setupDone }));
check("狀態列說明已設定的印表機", (await ev("document.getElementById('status').textContent")).includes("Zebra ZD420"));
await ev("document.getElementById('print').click()"); await sleep(500);
check("設定完成後列印：送出，使用選的印表機與偵測到的語言", (await ev("window.__jobs.length")) === 1 && (await ev("window.__jobs[0].target.name")) === "Zebra ZD420" && (await ev("window.__jobs[0].jobs[0].lang")) === "zpl");

// ---- 重新啟動：已完成就不再問 ----
await t.reload(); await sleep(600);
check("重新啟動後不再跳出對話框，印表機維持所選", !(await open()) && (await val("printer-name")) === "Zebra ZD420");
await ev("document.getElementById('dlg-printer').showModal()"); await sleep(200);
check("之後從「工具 → 印表機…」開啟是一般模式（有「關閉」、沒有「確定」）", (await vis("printer-close")) && !(await vis("printer-setup-ok")) && (await vis("printer-title")));
await ev("document.getElementById('dlg-printer').close()");

// ---- 稍後再設定：下次啟動再問 ----
await fresh();
check("新安裝（再來一次）：跳出對話框", await open());
await ev("document.getElementById('dlg-printer').dispatchEvent(new Event('cancel')); document.getElementById('dlg-printer').close()"); await sleep(300);
await t.reload(); await sleep(600);
check("沒完成設定就關掉（稍後再設定／Esc）：下次啟動會再問", await open());

// ---- 直連 TCP：要填位址才能確定 ----
await setv("printer-mode", "tcp"); await sleep(300);
check("直連 TCP：位址是預設範例值時可以確定，清空位址就不行", (await ev("!document.getElementById('printer-setup-ok').disabled")) === true);
await setv("host", ""); await sleep(200);
check("清空位址：「確定」停用", await ev("document.getElementById('printer-setup-ok').disabled"));
await setv("host", "10.0.0.5");
await setv("printer-lang", "zpl");
await ev("document.getElementById('printer-setup-ok').click()"); await sleep(300);
const s2 = await stored();
check("TCP 設定完成：記下連線方式、位址與語言", s2.printerMode === "tcp" && s2.host === "10.0.0.5" && s2.printerLang === "zpl" && s2.setupDone === true);

// ---- 一般印表機（不是標籤機）：列印與預覽直接切成 A4／貼紙紙排版 ----
// 判斷不出來的印表機：不替使用者猜，要自己選語言或「一般印表機」才能確定
await fresh();
await setv("printer-name", "Mystery Printer"); await sleep(500);
check("判斷不出是不是標籤機：「確定」停用，並要求自己選", (await ev("document.getElementById('printer-setup-ok').disabled")) && (await ev("document.getElementById('printer-lang-hint').textContent")).includes("無法判斷這台是不是標籤機"));
check("語言選單有「一般印表機」選項", (await ev("[...document.getElementById('printer-lang').options].some(o => o.value === 'office')")) === true);
await setv("printer-lang", "office"); await sleep(300);
check("手動選了「一般印表機」：「確定」啟用，說明列印會改用 A4／貼紙紙排版", (await ev("!document.getElementById('printer-setup-ok').disabled")) && (await ev("document.getElementById('printer-lang-hint').textContent")).includes("改用 A4"));
// 自動偵測為事務機
await fresh();
await setv("printer-name", "Office Laser MFP"); await sleep(500);
check("驅動判斷為事務機：自動視為一般印表機，「確定」可按", (await ev("!document.getElementById('printer-setup-ok').disabled")) && (await ev("document.getElementById('printer-lang-hint').textContent")).includes("一般印表機"));
await ev("document.getElementById('printer-setup-ok').click()"); await sleep(400);
await ev("window.__jobs.length = 0; document.getElementById('add-text').click()"); await sleep(300);
const sheetOpen = () => ev("document.getElementById('dlg-sheet').open");
const closeSheet = async () => { await ev("document.getElementById('sh-close').click()"); await sleep(250); };
await ev("document.getElementById('print').click()"); await sleep(900);
check("一般印表機：按「列印」直接開啟 A4／貼紙紙排版，不送標籤指令", (await sheetOpen()) && (await ev("window.__jobs.length")) === 0);
await closeSheet();
await ev("document.getElementById('preview-direct').click()"); await sleep(900);
check("一般印表機：按「預覽列印」也直接進 A4／貼紙紙排版（不是標籤預覽）", (await sheetOpen()) && !(await ev("document.getElementById('pv-dialog').open")));
await closeSheet();
await ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }))"); await sleep(900);
check("一般印表機：Ctrl+P 也進 A4／貼紙紙排版", await sheetOpen());
await closeSheet();
await ev("document.getElementById('preview-print').click()"); await sleep(250);
const off = await ev("JSON.stringify([...document.querySelectorAll('#ctx-menu [role=menuitem]')].map(e => [e.textContent.trim(), e.getAttribute('aria-disabled') === 'true' || e.classList.contains('disabled')]))").then(JSON.parse);
check("「預覽列印」選單裡標籤預覽停用並說明原因，排版選項可用", off[0][1] === true && off[0][0].includes("目前選的是一般印表機") && off[1][1] === false, JSON.stringify(off));
await ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"); await sleep(200);
// 換回標籤機：恢復原本的行為
await setv("printer-name", "Zebra ZD420"); await sleep(500);
await ev("document.getElementById('print').click()"); await sleep(500);
check("換成標籤機後：按「列印」又是直接送出標籤", (await ev("window.__jobs.length")) === 1 && !(await sheetOpen()));
await ev("document.getElementById('preview-direct').click()"); await sleep(900);
check("換成標籤機後：「預覽列印」又是標籤預覽", (await ev("document.getElementById('pv-dialog').open")) && !(await sheetOpen()));
await ev("document.getElementById('pv-close').click()"); await sleep(250);

// ---- 從舊版升級：已有設定、沒有 setupDone 欄位 → 不打擾 ----
await ev("localStorage.setItem('label-printer.settings', JSON.stringify({ paperWmm: 62.5, paperHmm: 30, tplWmm: 60, tplHmm: 30, gapMm: 2, printerMode: 'windows', printerName: 'Office Laser MFP', host: '1.2.3.4', port: 9103, density: 10, speed: 4 }))");
await t.reload(); await sleep(600);
check("舊版升級（設定已存在）：不跳出對話框，維持原本選的印表機", !(await open()) && (await val("printer-name")) === "Office Laser MFP");
// 舊版（0.9.x）一直是 TSPL：升級後明確記成 TSPL，即使印表機名稱認不出來也照常列印（不會被「猜不出來」擋下）
await ev("localStorage.setItem('label-printer.settings', JSON.stringify({ paperWmm: 62.5, paperHmm: 30, tplWmm: 60, tplHmm: 30, gapMm: 2, printerMode: 'windows', printerName: 'Mystery Printer', host: '1.2.3.4', port: 9103, density: 10, speed: 4 }))");
await t.reload(); await sleep(600);
check("舊版升級：沒有「印表機語言」設定的使用者記成 TSPL", (await val("printer-lang")) === "tspl");
await ev("window.__jobs.length = 0; document.getElementById('add-text').click()"); await sleep(300);
await ev("document.getElementById('print').click()"); await sleep(500);
check("舊版升級：照常以 TSPL 列印，不被擋下", (await ev("window.__jobs.length")) === 1 && (await ev("window.__jobs[0].jobs[0].lang")) === "tspl");
await t.finish();
