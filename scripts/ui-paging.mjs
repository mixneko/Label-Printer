// 回歸測試：資料表分頁（每頁 1000 列）。
//   - 資料庫：後端一頁一頁讀（read_table 帶 offset／limit），換頁後勾選的列仍保留、列印用得到
//   - Excel／CSV：整份讀進來，只分頁顯示，不一次畫出幾千列
//   node scripts/ui-paging.mjs [輸出資料夾=.tools]
import { launch } from "./_cdp.mjs";
const MOCK = `(() => {
  window.__calls = [];
  const ls = (k, d) => { try { const v = localStorage.getItem('t.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } };
  const rowsOf = (from, to) => Array.from({ length: to - from }, (_, i) => ['Item ' + (from + i + 1), 'C-' + (from + i + 1)]);
  window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd, args) => {
    if (cmd === 'list_printers') return ['TSC']; if (cmd === 'list_fonts') return ['Arial'];
    if (cmd === 'plugin:dialog|open') return ls('path', 'D:/data/shop.sqlite');
    if (cmd === 'read_table') {
      window.__calls.push({ path: args.path, sheet: args.sheet, offset: args.offset, limit: args.limit });
      const N = ls('n', 2500);
      if (args.path.endsWith('.xlsx')) {
        const rows = rowsOf(0, N);
        return { sheets: ['S'], sheet: 'S', headers: ['Item', 'Code'], rows, rowNumbers: rows.map((_, i) => i + 2) };
      }
      const off = args.offset || 0, lim = Math.min(args.limit || 1000, 1000);
      const end = Math.min(N, off + lim);
      const rows = rowsOf(off, end);
      return { kind: 'db', sheets: ['items'], sheet: 'items', headers: ['Item', 'Code'], rows, rowNumbers: rows.map((_, i) => off + i + 1),
        page: off === 0 ? { offset: off, limit: lim, total: N, more: end < N } : { offset: off, limit: lim, more: end < N } };
    }
    return null; } };
})();`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "paging" });
const { ev, sleep, check } = t;
const calls = () => ev("JSON.stringify(window.__calls)").then(JSON.parse);
const q = (js) => ev(js);
const load = async (path, n) => {
  await ev(`localStorage.setItem('t.path', ${JSON.stringify(JSON.stringify(path))}); localStorage.setItem('t.n', '${n}')`);
  await ev("window.__calls.length = 0; document.getElementById('import-table').click()");
  await sleep(500);
};
const rowsShown = () => q("document.querySelectorAll('#data-table tr[data-i]').length");
const firstNum = () => q("document.querySelector('#data-table tr[data-i] td.num')?.textContent");
const count = () => q("document.getElementById('data-count').textContent");
const pageLabel = () => q("document.getElementById('data-page').textContent");
const pagerHidden = () => q("document.getElementById('data-pager').hidden");
const click = (id) => ev(`document.getElementById('${id}').click()`).then(() => sleep(350));
const tick = (i) => ev(`(() => { const tr = document.querySelector('#data-table tr[data-i="${i}"]'); const cb = tr.querySelector('input'); cb.checked = !cb.checked; cb.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const boxOn = (i) => q(`document.querySelector('#data-table tr[data-i="${i}"] input').checked`);

// ===== 資料庫（2500 列）=====
await load("D:/data/shop.sqlite", 2500);
check("資料庫：第一次讀取不帶 offset／limit（後端預設第一頁）", JSON.stringify((await calls())[0]) === JSON.stringify({ path: "D:/data/shop.sqlite", sheet: null }));
check("資料庫：畫面只畫 1000 列，不是 2500 列", (await rowsShown()) === 1000, String(await rowsShown()));
check("資料庫：分頁列出現，顯示「第 1 / 3 頁（共 2500 列）」", !(await pagerHidden()) && (await pageLabel()) === "第 1 / 3 頁（共 2500 列）", await pageLabel());
check("資料庫：第一頁「上一頁」停用、「下一頁」可按", (await q("document.getElementById('data-prev').disabled")) === true && (await q("document.getElementById('data-next').disabled")) === false);
check("資料庫：已選 0 / 2500 列（總數是整份資料，不是目前這一頁）", (await count()) === "已選 0 / 2500 列", await count());
check("資料庫：全選／全不選／反選有提示「只作用在目前這一頁」", (await q("document.getElementById('data-all').title")).includes("目前這一頁"));

await tick(0); await tick(4);
check("資料庫：勾第 1、5 列 → 已選 2", (await count()) === "已選 2 / 2500 列");

await click("data-next");
const c1 = await calls();
check("資料庫：下一頁 → 以 offset 1000、limit 1000 向後端讀這一頁", JSON.stringify(c1.at(-1)) === JSON.stringify({ path: "D:/data/shop.sqlite", sheet: "items", offset: 1000, limit: 1000 }), JSON.stringify(c1.at(-1)));
check("資料庫：第 2 頁第一列的列號是 1001，標籤「第 2 / 3 頁」，總數沿用不變", (await firstNum()) === "1001" && (await pageLabel()) === "第 2 / 3 頁（共 2500 列）", `${await firstNum()} ${await pageLabel()}`);
check("資料庫：換頁後第一頁勾的列不在這一頁，這頁都沒勾；已選仍是 2", (await boxOn(0)) === false && (await count()) === "已選 2 / 2500 列");
check("資料庫：第 2 頁兩個按鈕都可按", (await q("document.getElementById('data-prev').disabled")) === false && (await q("document.getElementById('data-next').disabled")) === false);

await tick(2);
check("資料庫：第 2 頁勾第 3 列（全體第 1003 列）→ 已選 3", (await count()) === "已選 3 / 2500 列");

await click("data-all");
check("資料庫：全選只選目前這一頁 → 已選 1002（第 1 頁的 2 列 + 第 2 頁全部 1000 列）", (await count()) === "已選 1002 / 2500 列", await count());
check("資料庫：全選後標頭核取方塊是勾選狀態", (await q("document.getElementById('data-check-all').checked")) === true);

await click("data-prev");
check("資料庫：回第 1 頁 → 先前勾的第 1、5 列仍是勾選", (await boxOn(0)) === true && (await boxOn(4)) === true && (await boxOn(1)) === false);
check("資料庫：回第 1 頁後「上一頁」又停用", (await q("document.getElementById('data-prev').disabled")) === true);

await click("data-next"); await click("data-next");
check("資料庫：第 3 頁只有 500 列、沒有下一頁", (await rowsShown()) === 500 && (await q("document.getElementById('data-next').disabled")) === true && (await pageLabel()) === "第 3 / 3 頁（共 2500 列）", `${await rowsShown()} ${await pageLabel()}`);
await click("data-none");
check("資料庫：第 3 頁「全不選」只清掉這一頁（其他頁的勾選保留）→ 仍是 1002", (await count()) === "已選 1002 / 2500 列", await count());

// 列印預覽拿得到跨頁勾選的資料（此時第 1 頁勾 2 列、第 2 頁勾 1000 列）
await click("data-prev"); await click("data-prev");
await ev("document.getElementById('data-preview').click()"); await sleep(1200);
const pvTotal = await q("document.getElementById('pv-total').textContent");
check("資料庫：預覽列印收到全部 1002 筆（含換頁前勾的）", pvTotal.startsWith("1002 筆資料"), pvTotal);
const names = await q("document.getElementById('pv-page').textContent");
check("資料庫：預覽第一張是第 1 列（名稱用資料庫的列號，不是「Excel 第」）", names.includes("第 1 列") && !names.includes("Excel"), names);
await ev("document.getElementById('pv-close').click()"); await sleep(200);

// 重新讀取：回到第 1 頁、勾選清空
await click("data-reload");
check("資料庫：重新讀取 → 回第 1 頁、勾選清空", (await pageLabel()) === "第 1 / 3 頁（共 2500 列）" && (await count()) === "已選 0 / 2500 列", `${await pageLabel()} ${await count()}`);

// 少於一頁：不出現分頁列
await load("D:/data/small.sqlite", 40);
check("資料庫：40 列（不到一頁）→ 沒有分頁列", (await pagerHidden()) === true && (await rowsShown()) === 40);
check("資料庫：總數 40", (await count()) === "已選 0 / 40 列");

// ===== Excel／CSV（2500 列，整份讀進來）=====
await load("D:/data/big.xlsx", 2500);
check("Excel：只讀一次、不帶 offset／limit", (await calls()).length === 1 && (await calls())[0].offset === undefined);
check("Excel：畫面只畫 1000 列、分頁列「第 1 / 3 頁（共 2500 列）」", (await rowsShown()) === 1000 && (await pageLabel()) === "第 1 / 3 頁（共 2500 列）", `${await rowsShown()} ${await pageLabel()}`);
check("Excel：全選／全不選沒有「目前這一頁」提示（它們作用在全部資料列）", (await q("document.getElementById('data-all').hasAttribute('title')")) === false);
await click("data-all");
check("Excel：全選選到全部 2500 列（不只這一頁）", (await count()) === "已選 2500 / 2500 列", await count());
await click("data-next");
check("Excel：下一頁沒有再向後端讀取，第一列是 Excel 第 1001 筆（列號 1002）", (await calls()).length === 1 && (await firstNum()) === "1002", `${(await calls()).length} ${await firstNum()}`);
check("Excel：換頁後這一頁的勾選仍是勾著（勾選屬於整份資料）", (await boxOn(1000)) === true);
await click("data-next");
check("Excel：最後一頁 500 列、「下一頁」停用", (await rowsShown()) === 500 && (await q("document.getElementById('data-next').disabled")) === true);
await ev("document.getElementById('data-preview').click()"); await sleep(1200);
check("Excel：預覽列印拿到全部 2500 筆", (await q("document.getElementById('pv-total').textContent")).startsWith("2500 筆資料"));
await ev("document.getElementById('pv-close').click()"); await sleep(200);

await load("D:/data/small.xlsx", 30);
check("Excel：30 列 → 沒有分頁列", (await pagerHidden()) === true && (await rowsShown()) === 30);

await t.finish();
