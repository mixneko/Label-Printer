// 回歸測試：「欄位格式」—— 在標籤物件的屬性中，為 {{欄位}} 指定日期／數字格式（{{欄位|格式}}），
// 並驗證預覽與列印時會向後端以「原始值＋格式碼」重新格式化、批次呼叫、找不到時退回自動。
//   node scripts/ui-format.mjs [輸出資料夾=.tools]      （腳本會自己啟動並關閉 Vite）
import { launch } from "./_cdp.mjs";

const MOCK = `
window.__fmtCalls = []; window.__printed = [];
const pad = (n, w = 2) => String(n).padStart(w, '0');
// 簡化版的後端格式化：只認得測試用到的幾個格式碼，其餘回傳 null（= 看不懂 / 型別不符）
function fmt(raw, code) {
  if (raw.d) { const [y, mo, d] = raw.d; return ({ 'yyyy/mm/dd': y + '/' + pad(mo) + '/' + pad(d), 'yyyy年m月d日': y + '年' + mo + '月' + d + '日' })[code] ?? null; }
  if (raw.n !== undefined) return code === '0000' ? pad(raw.n, 4) : code === '0.00' ? raw.n.toFixed(2) : null;
  return null;
}
window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd, args) => {
  if (cmd === 'list_printers') return ['TSC'];
  if (cmd === 'list_fonts') return ['Microsoft JhengHei'];
  if (cmd === 'plugin:dialog|open') return 'D:\\\\data.xlsx';
  if (cmd === 'format_values') { window.__fmtCalls.push(JSON.parse(JSON.stringify(args.items))); return args.items.map((it) => fmt(it.raw, it.code)); }
  if (cmd === 'print_labels') { window.__printed.push(args.jobs.length); return null; }
  if (cmd === 'read_table') return {
    sheets: ['S'], sheet: 'S', headers: ['出貨日期', '編號', '備註'],
    rows: [['2026-01-05', '12', '甲'], ['2026-11-18', '7', '乙']], rowNumbers: [2, 3],
    raw: [[{ d: [2026, 1, 5, 0, 0, 0, 0] }, { n: 12 }, null], [{ d: [2026, 11, 18, 0, 0, 0, 0] }, { n: 7 }, null]] };
  return null; } };`;

const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "format" });
const { ev, sleep, check } = t;

const setContent = async (text) => { await ev(`(() => { const t = document.getElementById('prop-text'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(200); };
const content = () => ev("document.getElementById('prop-text').value");
const rows = () => ev("document.querySelectorAll('#fmt-list .fmt-row').length");
const rowNames = () => ev("Array.from(document.querySelectorAll('#fmt-list .fmt-row code')).map(c => c.textContent)");
const boxHidden = () => ev("document.getElementById('fmt-box').hidden");
const pickFormat = async (rowIdx, value) => { await ev(`(() => { const s = document.querySelectorAll('#fmt-list .fmt-row select')[${rowIdx}]; s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`); await sleep(250); };
const customInput = async (rowIdx, text) => { await ev(`(() => { const i = document.querySelectorAll('#fmt-list .fmt-row .fmt-custom')[${rowIdx}]; i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('change', { bubbles: true })); })()`); await sleep(250); };
const resolved = async () => JSON.parse(await ev("JSON.stringify(window.__lp.resolved())"));
const calls = async () => JSON.parse(await ev("JSON.stringify(window.__fmtCalls)"));
const clickDataRow = async (n) => { await ev(`document.querySelectorAll('#data-table tr:not(:first-child)')[${n}].click()`); await sleep(400); };

// ---------- 1. 欄位格式清單 ----------
await ev("document.getElementById('add-text').click()"); await sleep(300);
check("新增文字（預設內容含 {{欄位}}）→ 顯示「欄位格式」區塊", !(await boxHidden()) && (await rows()) === 1);
await setContent("日期:{{出貨日期}} 編號:{{編號}}");
check("內容有 2 個欄位 → 清單 2 列", (await rows()) === 2 && JSON.stringify(await rowNames()) === JSON.stringify(["{{出貨日期}}", "{{編號}}"]), (await rowNames()).join("、"));
const opts = await ev("Array.from(document.querySelectorAll('#fmt-list .fmt-row select')[0].options).map(o => o.value)");
check("選項含：自動、日期與數字預設格式、自訂", opts[0] === "" && opts.includes("yyyy/mm/dd") && opts.includes("0000") && opts.at(-1) === "__custom__", `${opts.length} 個選項`);
check("預設是「自動」（內容不含 |）", !(await content()).includes("|"));
await t.shot("1-list");

// ---------- 2. 指定格式 → 改寫內容 ----------
await pickFormat(0, "yyyy/mm/dd");
check("日期選 yyyy/mm/dd → {{出貨日期|yyyy/mm/dd}}", (await content()) === "日期:{{出貨日期|yyyy/mm/dd}} 編號:{{編號}}", await content());
await pickFormat(1, "0000");
check("編號選 0000 → {{編號|0000}}", (await content()) === "日期:{{出貨日期|yyyy/mm/dd}} 編號:{{編號|0000}}", await content());
check("清單選單反映目前格式", (await ev("Array.from(document.querySelectorAll('#fmt-list .fmt-row select')).map(s => s.value).join(',')")) === "yyyy/mm/dd,0000");
await pickFormat(0, "__custom__");
check("選「自訂格式…」→ 出現輸入框", await ev("!document.querySelectorAll('#fmt-list .fmt-custom')[0].hidden"));
await customInput(0, "yyyy.m.d|}{");
check("自訂格式：不合法字元（| { }）會被移除", (await content()).startsWith("日期:{{出貨日期|yyyy.m.d}}"), await content());
check("自訂格式重建後，選單顯示「自訂」且輸入框帶入格式", (await ev("(() => { const s = document.querySelectorAll('#fmt-list .fmt-row select')[0]; const i = document.querySelectorAll('#fmt-list .fmt-custom')[0]; return s.value === '__custom__' && i.value === 'yyyy.m.d' && !i.hidden; })()")));
// 自訂的內容剛好等於內建格式時，顯示成該內建選項（而不是「自訂」）
await customInput(0, "yyyy年m月d日");
check("自訂輸入的格式若等於內建格式 → 選單顯示該內建選項", (await ev("document.querySelectorAll('#fmt-list .fmt-row select')[0].value")) === "yyyy年m月d日");
await pickFormat(0, "");
check("改回「自動」→ 移除格式", (await content()).startsWith("日期:{{出貨日期}}"), await content());
await pickFormat(0, "yyyy/mm/dd");

// 打字新增欄位 → 清單即時更新
await setContent((await content()) + " {{新欄位}}");
check("在內容中打新的 {{新欄位}} → 清單增加一列", (await rows()) === 3 && (await rowNames()).includes("{{新欄位}}"));
await setContent("日期:{{出貨日期|yyyy/mm/dd}} 編號:{{編號|0000}}");

// ---------- 3. 區塊的顯示條件 ----------
await ev("document.getElementById('add-rect').click()"); await sleep(250);
check("選到矩形 → 不顯示欄位格式", await boxHidden());
await ev("document.querySelectorAll('#layer-list li')[1].click()"); await sleep(250); // 回到文字
check("回到文字 → 清單恢復，且保留已選的格式", !(await boxHidden()) && (await ev("Array.from(document.querySelectorAll('#fmt-list .fmt-row select')).map(s => s.value).join(',')")) === "yyyy/mm/dd,0000");
await setContent("沒有任何欄位的文字");
check("內容沒有欄位 → 隱藏欄位格式", await boxHidden());
await setContent("日期:{{出貨日期|yyyy/mm/dd}} 編號:{{編號|0000}}");

// ---------- 4. 選擇資料來源 → 預覽時以原始值重新格式化 ----------
await ev("document.getElementById('import-file').click()"); await sleep(900);
const before = (await calls()).length;
await clickDataRow(0);
let cs = await calls();
check("點資料列預覽 → 向後端要求格式化（一次呼叫）", cs.length === before + 1, `呼叫次數 ${before} → ${cs.length}`);
const last = cs.at(-1);
check("送出的是「原始值＋格式碼」", JSON.stringify(last) === JSON.stringify([{ raw: { d: [2026, 1, 5, 0, 0, 0, 0] }, code: "yyyy/mm/dd" }, { raw: { n: 12 }, code: "0000" }]), JSON.stringify(last));
let r = (await resolved())[0];
check("預覽用的資料列：指定格式的值照格式顯示", r["出貨日期|yyyy/mm/dd"] === "2026/01/05" && r["編號|0000"] === "0012", JSON.stringify(r));
check("原本「自動」的值仍保留（照 Excel 的顯示）", r["出貨日期"] === "2026-01-05" && r["編號"] === "12");

// ---------- 5. 批次列印：多列只呼叫一次 ----------
await ev("document.getElementById('data-all').click()"); await sleep(200);
const b2 = (await calls()).length;
await ev("document.getElementById('data-print').click()"); await sleep(600);
cs = await calls();
check("列印 2 列 → 只呼叫一次後端（批次）", cs.length === b2 + 1, `${b2} → ${cs.length}`);
check("批次內容：2 列 × 2 個格式 = 4 筆", cs.at(-1).length === 4, `${cs.at(-1).length} 筆`);
check("實際送出 print_labels（2 張）", (await ev("window.__printed.at(-1)")) === 2);
const rs = await resolved();
check("第 2 列也正確格式化", rs[1]["出貨日期|yyyy/mm/dd"] === "2026/11/18" && rs[1]["編號|0000"] === "0007", JSON.stringify(rs[1]));

// ---------- 6. 沒有原始值／看不懂的格式 → 退回自動 ----------
await setContent("備註:{{備註|0000}} 日期:{{出貨日期|[h]:mm}}");
await clickDataRow(1);
cs = await calls();
check("文字儲存格（沒有原始值）不送去格式化", cs.at(-1).length === 1 && cs.at(-1)[0].code === "[h]:mm", JSON.stringify(cs.at(-1)));
r = (await resolved())[0];
check("備註（文字）沒有格式化結果 → 退回原本的文字", !("備註|0000" in r) && r["備註"] === "乙");
check("看不懂的格式碼（後端回 null）→ 不放進結果，退回自動", !("出貨日期|[h]:mm" in r) && r["出貨日期"] === "2026-11-18", Object.keys(r).join(","));

// ---------- 7. 完全沒用到欄位格式 → 不呼叫後端 ----------
await setContent("日期:{{出貨日期}}");
const b3 = (await calls()).length;
await clickDataRow(0);
check("沒有使用欄位格式時，不向後端要求格式化", (await calls()).length === b3);

// ---------- 8. 手動測試資料（沒有原始值）----------
await setContent("日期:{{出貨日期|yyyy/mm/dd}}");
await ev(`(() => { const v = document.getElementById('vars'); v.value = '出貨日期=2026/11/18'; v.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const b4 = (await calls()).length;
await ev("document.getElementById('preview-btn').click()"); await sleep(500);
r = (await resolved())[0];
check("手動填的測試資料沒有原始值 → 不格式化，直接用填的文字", (await calls()).length === b4 && !("出貨日期|yyyy/mm/dd" in r) && r["出貨日期"] === "2026/11/18", JSON.stringify(r));

await t.shot("2-final");
await t.finish();
