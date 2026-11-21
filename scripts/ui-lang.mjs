// 回歸測試：印表機語言。Windows 驅動可自動偵測（依驅動程式名稱），直連 Raw TCP 必須手動選；
// 送給後端的列印工作帶 lang；非 TSPL 不使用原生條碼指令。
//   node scripts/ui-lang.mjs [輸出資料夾=.tools]
import { launch } from "./_cdp.mjs";
const MOCK = `(() => {
  window.__jobs = [];
  const ls = (k, d) => { try { const v = localStorage.getItem('t.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } };
  window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd, args) => {
    if (cmd === 'list_printers') return ['ZDesigner GK420t', 'TSC TTP-244 Pro', 'Mystery Printer'];
    if (cmd === 'list_fonts') return ['Microsoft JhengHei'];
    if (cmd === 'detect_printer_language') {
      const m = { 'ZDesigner GK420t': 'zpl', 'TSC TTP-244 Pro': 'tspl', 'Mystery Printer': null };
      return { lang: m[args.name] ?? null, driver: args.name + ' driver' };
    }
    if (cmd === 'print_labels') { window.__jobs.push(JSON.parse(JSON.stringify(args))); return null; }
    return null; } };
})();`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "lang" });
const { ev, sleep, check } = t;
const $v = (id) => ev(`document.getElementById('${id}').value`);
const hint = () => ev("document.getElementById('printer-lang-hint').textContent");
const opts = () => ev("[...document.querySelectorAll('#printer-lang option')].map(o => o.value).join(',')");
const pick = async (id, v) => { await ev(`(() => { const s = document.getElementById('${id}'); s.value = '${v}'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`); await sleep(300); };
const printAndGet = async () => {
  await ev("document.getElementById('add-text').click()"); await sleep(300);
  await ev("window.__jobs.length = 0; document.getElementById('print').click()"); await sleep(500);
  return JSON.parse(await ev("JSON.stringify(window.__jobs.at(-1))"));
};

// 第一次啟動：Windows 模式、自動偵測（程式預設優先選名稱含 TSC 的印表機，所以先明確選 Zebra 那台）
await pick("printer-name", "ZDesigner GK420t");
check("Windows 模式的語言選單有「自動偵測」且排第一", (await opts()).startsWith("auto,tspl,zpl,epl,cpcl,dpl,sbpl"), await opts());
check("預設選「自動」", (await $v("printer-lang")) === "auto");
check("顯示偵測結果（ZPL）與驅動名稱", (await hint()).includes("ZPL II") && (await hint()).includes("ZDesigner GK420t driver"), await hint());
check("非 TSPL 顯示實驗性質警告", (await hint()).includes("實驗性質"));
let j = await printAndGet();
check("自動偵測為 ZPL → 送出 lang=zpl、沒有原生條碼", j.jobs[0].lang === "zpl" && j.jobs[0].natives.length === 0, j.jobs[0].lang);

// 換成 TSC → TSPL，沒有實驗性警告
await pick("printer-name", "TSC TTP-244 Pro");
check("換到 TSC 印表機 → 偵測為 TSPL，沒有實驗警告", (await hint()).includes("TSPL") && !(await hint()).includes("實驗性質"), await hint());
j = await printAndGet();
check("TSC → 送出 lang=tspl", j.jobs[0].lang === "tspl");

// 猜不出來：不替使用者猜（猜成標籤機會把指令碼送到事務機，印出亂碼）→ 擋下列印，要使用者自己選
await pick("printer-name", "Mystery Printer");
check("猜不出來：提示無法判斷這台是不是標籤機", (await hint()).includes("無法判斷這台是不是標籤機"), await hint());
await ev("document.getElementById('add-text').click()"); await sleep(300);
await ev("window.__jobs.length = 0; document.getElementById('print').click()"); await sleep(600);
check("猜不出來 → 不送出任何列印工作，並開啟印表機設定", (await ev("window.__jobs.length")) === 0 && (await ev("document.getElementById('dlg-printer').open")));
check("狀態列說明原因", (await ev("document.getElementById('status').textContent")).includes("無法判斷這台是不是標籤機"));
await ev("document.getElementById('printer-close').click()"); await sleep(250);

// 手動覆蓋
await pick("printer-lang", "dpl");
j = await printAndGet();
check("手動選 DPL → 送出 lang=dpl（不受偵測影響）", j.jobs[0].lang === "dpl");
await t.reload();
check("手動選擇後存檔，重新載入仍是 DPL", (await $v("printer-lang")) === "dpl");

// 直連 TCP：沒有「自動」，必須自己選
await pick("printer-lang", "auto");
await pick("printer-mode", "tcp");
check("TCP 模式的語言選單沒有「自動偵測」", !(await opts()).includes("auto"), await opts());
check("TCP 模式提示要自己選語言", (await hint()).includes("Raw TCP"), await hint());
check("TCP 模式選單預設 TSPL（原本的「自動」退回 TSPL）", (await $v("printer-lang")) === "tspl");
j = await printAndGet();
check("TCP + TSPL → 送出 target=tcp、lang=tspl", j.target.kind === "tcp" && j.jobs[0].lang === "tspl");
await pick("printer-lang", "zpl");
j = await printAndGet();
check("TCP 選 ZPL → 送出 lang=zpl", j.jobs[0].lang === "zpl" && j.target.kind === "tcp");

await t.finish();
