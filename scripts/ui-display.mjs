// 回歸測試：設計畫面上的文字不顯示 `|格式`（只顯示 {{欄位}}），但存檔／面板／列印仍保有完整內容。
//   node scripts/ui-display.mjs [輸出資料夾=.tools]
import { launch } from "./_cdp.mjs";
const MOCK = `window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd) => {
  if (cmd === 'list_printers') return ['TSC']; if (cmd === 'list_fonts') return ['Microsoft JhengHei']; return null; } };`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "display" });
const { ev, sleep, check } = t;
const RAW = "日期：{{出貨日期|yyyy/mm/dd}} {{序號|@}}";
await ev("document.getElementById('add-text').click()"); await sleep(500);
await ev(`(() => { const i = document.getElementById('prop-text'); i.value = ${JSON.stringify(RAW)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(600);
const shown = await ev("window.__lp.konva.stages[0].find('.element')[0].text()");
check("畫布上只顯示 {{欄位}}，不含 |格式", shown === "日期：{{出貨日期}} {{序號}}", shown);
check("屬性面板仍是完整內容（含格式）", (await ev("document.getElementById('prop-text').value")) === RAW);
// 重新選取後面板仍保有格式（資料沒有因顯示簡化而遺失）
await ev("document.querySelectorAll('#layer-list li')[0].click()"); await sleep(300);
check("重新選取後面板內容仍含格式", (await ev("document.getElementById('prop-text').value")) === RAW);
// 復原／重做的快照也要保有格式
await ev("document.getElementById('add-rect').click()"); await sleep(500);
await ev("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))"); await sleep(600);
await ev("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }))"); await sleep(600);
check("經過復原／重做後內容仍含格式", (await ev("window.__lp.konva.stages[0].find('.element')[0].getAttr('raw')")) === RAW);
await t.finish();
