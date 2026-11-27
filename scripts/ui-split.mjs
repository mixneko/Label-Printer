// 回歸測試：分割按鈕（列印、預覽列印、選擇資料來源、資料表的列印／預覽旁的 ▾）。
// 主按鈕一鍵照舊；▾ 裡放另一種做法（A4／貼紙紙排版、資料庫連線）。
//   node scripts/ui-split.mjs [輸出資料夾=.tools]
import { launch } from "./_cdp.mjs";
const MOCK = `(() => {
  window.__jobs = []; window.__open = 0;
  window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd, args) => {
    if (cmd === 'list_printers') return ['TSC TTP-244 Pro']; if (cmd === 'list_fonts') return ['Arial'];
    if (cmd === 'list_odbc_sources') return { drivers: [], dsns: [] };
    if (cmd === 'plugin:dialog|open') { window.__open++; return null; }
    if (cmd === 'print_labels') { window.__jobs.push(args); return null; }
    if (cmd === 'read_table') return { sheets: ['Items'], sheet: 'Items', headers: ['Item'], rows: [['A'], ['B']], rowNumbers: [1, 2] };
    return null; } };
})();`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "split", width: 1280, height: 800 });
const { ev, sleep, check } = t;
const menuItems = () => ev("JSON.stringify([...document.querySelectorAll('#ctx-menu [role=menuitem]')].map(e => e.textContent.trim().replace(/Ctrl\\+P$/, '').trim()))").then(JSON.parse);
const closeMenu = () => ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))").then(() => sleep(150));
const click = (id) => ev(`document.getElementById('${id}').click()`).then(() => sleep(300));
const pick = (label) => ev(`[...document.querySelectorAll('#ctx-menu [role=menuitem]')].find(e => e.textContent.trim().startsWith(${JSON.stringify(label)}))?.click()`).then(() => sleep(700));

check("畫面上沒有直接列印的按鈕，也沒有分開的 ▾",
  (await ev("['print', 'data-print'].every((id) => document.getElementById(id).offsetParent === null) && !document.querySelector('.split-more[id*=print], .split-more[id*=preview]')")) === true);
check("「預覽列印」按鈕上有下拉記號與說明", (await ev("!!document.querySelector('#preview-print .caret') && document.getElementById('preview-print').title.length > 0")) === true);

// 工具列在 1280 寬仍是單列
// 單列的高度約 44 px；換行的話會超過 80 px
const barH = await ev("Math.round(document.querySelector('.toolbar').getBoundingClientRect().height)");
check("工具列在 1280 寬度仍是單列（高度 < 60 px）", barH < 60, `${barH} px`);
await t.shot("toolbar");

await click("add-text");
await click("preview-print");
check("按「預覽列印」先選哪一種預覽：標籤、貼紙紙／A4（不直接列印）",
  JSON.stringify(await menuItems()) === JSON.stringify(["預覽標籤列印", "貼紙紙／A4 排版預覽…"]) && (await ev("window.__jobs.length")) === 0, JSON.stringify(await menuItems()));
await t.shot("print-menu");
await pick("預覽標籤列印");
check("→「預覽標籤列印」開啟預覽視窗", await ev("document.getElementById('pv-dialog').open"));
check("預覽視窗顯示目前的印表機", (await ev("document.getElementById('pv-printer').value")) === "TSC TTP-244 Pro");
await t.shot("preview-printer");
await click("pv-print");
check("在預覽裡按列印才送出", (await ev("window.__jobs.length")) === 1);
await click("preview-print"); await pick("貼紙紙");
check("→「貼紙紙／A4 排版預覽…」開啟排版對話框", await ev("document.getElementById('dlg-sheet').open"));
await ev("document.getElementById('sh-close').click()"); await sleep(200);

// 選擇資料來源：整顆按鈕就是選單（沒有另外的 ▾）
check("「選擇資料來源」沒有分開的 ▾", (await ev("!document.getElementById('import-table-more') && !!document.querySelector('#import-table .caret')")) === true);
await click("import-table");
check("按下去先選匯入方式：檔案、資料庫、網頁版 Excel（不直接跳選檔）", JSON.stringify(await menuItems()) === JSON.stringify(["Excel／CSV／資料庫檔案…", "連線到資料庫…", "網頁版 Excel…"]) && (await ev("window.__open")) === 0, JSON.stringify(await menuItems()));
await pick("Excel");
check("「Excel／CSV／資料庫檔案…」跳出選檔對話框", (await ev("window.__open")) === 1);
await click("import-table"); await pick("連線到資料庫");
check("▾ →「連線到資料庫…」開啟資料庫對話框", await ev("document.getElementById('dlg-db').open"));
await ev("document.getElementById('dlg-db').close()");

// 資料表面板：沒勾選時停用；勾選後按下同樣先選哪一種預覽
await ev("document.getElementById('db-kind').value = 'file'; document.getElementById('db-path').value = 'D:/x/a.sqlite'; document.getElementById('db-go').click()"); await sleep(600);
check("載入資料後資料表面板出現", await ev("!document.getElementById('data-panel').hidden"));
check("沒勾選任何列：「預覽勾選的列」停用", (await ev("document.getElementById('data-preview').disabled")) === true);
await ev("document.querySelector('#data-table tr:nth-child(2) input[type=checkbox]')?.click()"); await sleep(300);
check("勾選一列後啟用", (await ev("!document.getElementById('data-preview').disabled")) === true);
await click("data-preview");
check("「預覽勾選的列」：標籤、貼紙紙／A4 兩種", JSON.stringify(await menuItems()) === JSON.stringify(["預覽標籤列印", "貼紙紙／A4 排版預覽…"]));
await closeMenu();
check("資料表上方的按鈕列在 1280 寬度是單列", (await ev("document.querySelector('.data-bar').getBoundingClientRect().height")) < 60);
await t.shot("data-bar");
await click("file-menu");
const file = await menuItems();
check("檔案選單不再放排版列印與資料庫連線（避免與工具列重複）", !file.some((s) => s.includes("貼紙紙") || s.includes("連線到資料庫")), JSON.stringify(file));
await t.finish();
