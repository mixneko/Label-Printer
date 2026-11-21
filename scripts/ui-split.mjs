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

check("五個按鈕旁都有 ▾（列印、預覽列印、選擇資料來源、資料表的預覽與列印）",
  (await ev("['print', 'preview-print', 'import-table', 'data-print', 'data-preview'].every((id) => !!document.getElementById(id + '-more'))")) === true);
check("▾ 都有說明文字（滑過會顯示）", (await ev("['print', 'preview-print', 'import-table', 'data-print', 'data-preview'].every((id) => document.getElementById(id + '-more').title.length > 0)")) === true);

// 工具列在 1280 寬仍是單列
// 單列的高度約 44 px；換行的話會超過 80 px
const barH = await ev("Math.round(document.querySelector('.toolbar').getBoundingClientRect().height)");
check("工具列在 1280 寬度仍是單列（高度 < 60 px）", barH < 60, `${barH} px`);
await t.shot("toolbar");

// 列印：主按鈕一鍵照舊（直接送出，不跳選單）
await click("add-text");
await click("print");
check("按「列印」仍是一鍵送出 print_labels，沒有跳出選單", (await ev("window.__jobs.length")) === 1 && (await ev("document.getElementById('ctx-menu')?.hidden !== false")) === true);

// 列印 ▾
await click("print-more");
check("列印的 ▾：列印到標籤機、貼紙紙／A4 排版列印…", JSON.stringify(await menuItems()) === JSON.stringify(["列印到標籤機", "貼紙紙／A4 排版列印…"]), JSON.stringify(await menuItems()));
await t.shot("print-menu");
await pick("列印到標籤機");
check("▾ →「列印到標籤機」等同按主按鈕", (await ev("window.__jobs.length")) === 2);
await click("print-more"); await pick("貼紙紙");
check("▾ →「貼紙紙／A4 排版列印…」開啟排版對話框", await ev("document.getElementById('dlg-sheet').open"));
await ev("document.getElementById('sh-close').click()"); await sleep(200);

// 預覽 ▾
await click("preview-print-more");
check("預覽列印的 ▾：預覽標籤列印、貼紙紙／A4 排版預覽…", JSON.stringify(await menuItems()) === JSON.stringify(["預覽標籤列印", "貼紙紙／A4 排版預覽…"]), JSON.stringify(await menuItems()));
await pick("預覽標籤列印");
check("▾ →「預覽標籤列印」開啟原本的預覽視窗", await ev("document.getElementById('pv-dialog').open"));
await ev("document.getElementById('pv-close').click()"); await sleep(200);
await click("preview-print-more"); await pick("貼紙紙");
check("▾ →「貼紙紙／A4 排版預覽…」開啟排版對話框", await ev("document.getElementById('dlg-sheet').open"));
await ev("document.getElementById('sh-close').click()"); await sleep(200);

// 資料來源 ▾
await click("import-table");
check("按「選擇資料來源」仍是直接跳出選檔對話框", (await ev("window.__open")) === 1 && (await ev("document.getElementById('dlg-db').open")) === false);
await click("import-table-more");
check("資料來源的 ▾：Excel／CSV／資料庫檔案…、連線到資料庫…", JSON.stringify(await menuItems()) === JSON.stringify(["Excel／CSV／資料庫檔案…", "連線到資料庫…"]), JSON.stringify(await menuItems()));
await pick("Excel");
check("▾ →「Excel／CSV／資料庫檔案…」等同按主按鈕（又跳一次選檔對話框）", (await ev("window.__open")) === 2);
await click("import-table-more"); await pick("連線到資料庫");
check("▾ →「連線到資料庫…」開啟資料庫對話框", await ev("document.getElementById('dlg-db').open"));
await ev("document.getElementById('dlg-db').close()");

// 資料表面板：沒勾選時 ▾ 跟著停用；檔案選單不再放這兩項
await ev("document.getElementById('db-kind').value = 'file'; document.getElementById('db-path').value = 'D:/x/a.sqlite'; document.getElementById('db-go').click()"); await sleep(600);
check("載入資料後資料表面板出現", await ev("!document.getElementById('data-panel').hidden"));
check("沒勾選任何列：資料表的列印／預覽 ▾ 也停用", (await ev("document.getElementById('data-print-more').disabled && document.getElementById('data-preview-more').disabled")) === true);
await ev("document.querySelector('#data-table tr:nth-child(2) input[type=checkbox]')?.click()"); await sleep(300);
check("勾選一列後 ▾ 啟用", (await ev("!document.getElementById('data-print-more').disabled && !document.getElementById('data-preview-more').disabled")) === true);
await click("data-print-more");
check("資料表的列印 ▾：列印到標籤機、貼紙紙／A4 排版列印…", JSON.stringify(await menuItems()) === JSON.stringify(["列印到標籤機", "貼紙紙／A4 排版列印…"]));
await closeMenu();
await click("file-menu");
const file = await menuItems();
check("檔案選單不再放排版列印與資料庫連線（避免與工具列重複）", !file.some((s) => s.includes("貼紙紙") || s.includes("連線到資料庫")), JSON.stringify(file));
await t.finish();
