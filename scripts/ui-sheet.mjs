// 回歸測試：貼紙紙／A4 排版列印（版面計算、預覽、裁切標記、安全邊界、起始格、PDF 輸出、列印）。
//   node scripts/ui-sheet.mjs [輸出資料夾=.tools]
import { writeFileSync } from "node:fs";
import { launch } from "./_cdp.mjs";
const MOCK = `(() => {
  window.__saved = null; window.__printed = null;
  window.print = () => {
    window.__printed = { pages: document.querySelectorAll('#sheet-print img').length, cls: document.body.className,
      style: document.getElementById('sheet-page-style')?.textContent, w: document.querySelector('#sheet-print img')?.style.width, h: document.querySelector('#sheet-print img')?.style.height };
    setTimeout(() => window.dispatchEvent(new Event('afterprint')), 50);
  };
  window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd, args) => {
    if (cmd === 'list_printers') return ['TSC TTP-244 Pro']; if (cmd === 'list_fonts') return ['Arial'];
    if (cmd === 'plugin:dialog|save') return 'C:/out/labels.pdf';
    if (cmd === 'write_binary_file') { window.__saved = { path: args.path, b64: args.data }; return null; }
    return null; } };
})();`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "sheet", width: 1400, height: 900 });
const { ev, sleep, check } = t;
const val = (id) => ev(`document.getElementById('${id}').value`);
const setv = (id, v) => ev(`(() => { const e = document.getElementById('${id}'); e.value = ${JSON.stringify(String(v))}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const info = () => ev("document.getElementById('sh-info').textContent");
const warn = () => ev("(() => { const w = document.getElementById('sh-warn'); return w.hidden ? '' : w.textContent; })()");
const openSheet = async () => {
  // 列印按鈕右邊的 ▾ → 「貼紙紙／A4 排版列印…」
  await ev("document.getElementById('preview-print').click()"); await sleep(250);
  await ev("[...document.querySelectorAll('#ctx-menu [role=menuitem]')].find(e => e.textContent.trim().startsWith('貼紙紙'))?.click()"); await sleep(900);
};

// ---- 純函式：版面計算 ----
const L = `await import('/src/sheetlayout.ts')`;
check("autoFit：60×30 在 A4（安全邊界 5、裁切標記）排 3 欄 9 列並置中",
  JSON.stringify(await ev(`(async () => { const m = ${L}; const c = m.autoFit({ ...m.DEFAULT_SHEET }); return [c.cols, c.rows, c.marginL, c.marginT]; })()`)) === "[3,9,15,13.5]");
check("autoFit：不印裁切線時可多排（A4 → 3 欄 9 列；安全邊界內 200×287）",
  JSON.stringify(await ev(`(async () => { const m = ${L}; const c = m.autoFit({ ...m.DEFAULT_SHEET, cut: 'none', labelW: 50, labelH: 40 }); return [c.cols, c.rows]; })()`)) === "[4,7]");
check("版面：3×9 無間距 → 4 個 X 裁切位置、10 個 Y 裁切位置；標記 = 4×2 + 10×2 = 28",
  JSON.stringify(await ev(`(async () => { const m = ${L}; const l = m.computeLayout(m.autoFit({ ...m.DEFAULT_SHEET })); return [l.cutX.length, l.cutY.length, l.marks.length, l.warnings.length]; })()`)) === "[4,10,28,0]");
check("版面：有間距時每個格子左右都各有裁切位置（3 欄間距 2 → 6 個 X）",
  (await ev(`(async () => { const m = ${L}; const l = m.computeLayout({ ...m.DEFAULT_SHEET, gapX: 2, marginL: 12, cut: 'marks' }); return l.cutX.length; })()`)) === 6);
check("安全邊界：左邊界 2 mm → 該欄格子標示為超出、並有警告",
  (await ev(`(async () => { const m = ${L}; const l = m.computeLayout({ ...m.DEFAULT_SHEET, marginL: 2, cut: 'none' }); return l.cells.filter(c => c.outside).length > 0 && l.warnings.length === 1; })()`)) === true);
check("安全邊界：裁切標記放不下（上邊界 5）時有警告",
  (await ev(`(async () => { const m = ${L}; const l = m.computeLayout({ ...m.DEFAULT_SHEET, marginT: 5, cut: 'marks' }); return l.warnings.length >= 1; })()`)) === true);
check("planPages：30 筆、每頁 27 格、從第 26 格開始 → 3 頁（2、27、1）",
  JSON.stringify(await ev(`(async () => { const m = ${L}; return m.planPages({ ...m.DEFAULT_SHEET, cols: 3, rows: 9, start: 26 }, 30).map(p => p.length); })()`)) === "[2,27,1]");
check("planPages：0 筆 → 1 個空頁；起始格超過格數時夾在最後一格",
  JSON.stringify(await ev(`(async () => { const m = ${L}; return [m.planPages(m.DEFAULT_SHEET, 0).length, m.planPages({ ...m.DEFAULT_SHEET, cols: 2, rows: 2, start: 99 }, 2).map(p => p.map(x => x.cell))]; })()`)) === "[1,[[3],[0]]]");
check("橫式與 Letter 的紙張尺寸",
  JSON.stringify(await ev(`(async () => { const m = ${L}; return [m.pageSize({ ...m.DEFAULT_SHEET, landscape: true }), m.pageSize({ ...m.DEFAULT_SHEET, paper: 'letter' })]; })()`)) === '[{"w":297,"h":210},{"w":215.9,"h":279.4}]');

// ---- 畫面 ----
await ev("localStorage.removeItem('label-printer.sheet')");
await ev("document.getElementById('add-text').click()"); await sleep(300);
await ev(`(() => { const t = document.getElementById('prop-text'); t.value = '{{Item}}'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await ev(`(() => { const v = document.getElementById('vars'); v.value = 'Item=Widget A'; v.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await ev("document.getElementById('copies').value = '30'");
await openSheet();
check("對話框開啟，首次使用：以目前標籤尺寸自動排滿（3 欄 9 列、左 15、上 13.5）",
  (await ev("document.getElementById('dlg-sheet').open")) && (await val("sh-cols")) === "3" && (await val("sh-rows")) === "9" && (await val("sh-ml")) === "15" && (await val("sh-mt")) === "13.5" && (await val("sh-lw")) === "60");
check("資訊列：30 張標籤、共 2 頁（每頁 27 格）", (await info()).startsWith("30 張標籤，共 2 頁（每頁 27 格）"), await info());
check("預設是普通紙：裁切線＝角落標記；沒有警告", (await val("sh-cut")) === "marks" && (await warn()) === "", await warn());
check("預覽畫布大小 = A4 × 4 px/mm（840 × 1188）", (await ev("[document.getElementById('sh-canvas').width, document.getElementById('sh-canvas').height].join('x')")) === "840x1188");
await t.shot("a4");
// 預覽畫布應有實際內容（標籤文字、裁切標記不是全白）
check("預覽有畫出內容（非全白）", (await ev(`(() => { const c = document.getElementById('sh-canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 128) n++; return n > 200; })()`)) === true);
check("換頁：第 1 / 2 頁 → 下一頁 → 第 2 / 2 頁", (await ev("document.getElementById('sh-page').textContent")) === "第 1 / 2 頁" && !!(await ev("document.getElementById('sh-next').click(), 1")) && (await sleep(300), (await ev("document.getElementById('sh-page').textContent")) === "第 2 / 2 頁"));

// 用途切換、起始格、安全邊界警告
await setv("sh-kind", "die"); await sleep(200);
check("切到「有模切的貼紙紙」→ 裁切線改為不印", (await val("sh-cut")) === "none");
await setv("sh-start", 26); await sleep(300);
check("起始格 26 → 共 3 頁", (await info()).includes("共 3 頁"), await info());
await setv("sh-start", 1);
await setv("sh-ml", 2); await sleep(300);
check("左邊界 2 mm（在安全邊界內）→ 顯示警告", (await warn()).includes("安全邊界"), await warn());
await setv("sh-ml", 15); await sleep(200);
await ev("document.getElementById('sh-fit').click()"); await sleep(300);
check("按「自動排滿並置中」（不印裁切線）：3 欄 9 列", (await val("sh-cols")) === "3" && (await val("sh-rows")) === "9");
await setv("sh-kind", "plain"); await sleep(200);
await setv("sh-orient", "l"); await sleep(300);
check("橫式：預覽畫布 1188 × 840", (await ev("[document.getElementById('sh-canvas').width, document.getElementById('sh-canvas').height].join('x')")) === "1188x840");
await setv("sh-orient", "p");
await setv("sh-paper", "custom"); await sleep(200);
check("自訂尺寸：出現紙寬／紙高欄位", (await ev("!document.getElementById('sh-custom').hidden")) === true);
await setv("sh-pw", 100); await setv("sh-ph", 150); await sleep(300);
check("自訂 100 × 150：預覽畫布 400 × 600", (await ev("[document.getElementById('sh-canvas').width, document.getElementById('sh-canvas').height].join('x')")) === "400x600");
await setv("sh-paper", "a4"); await ev("document.getElementById('sh-fit').click()"); await sleep(300);
await setv("sh-cut", "marks"); await sleep(200);

// 設定記住
await t.reload();
// 重新載入後標籤是空的：重新加一個文字物件，PDF 與列印才有內容可驗證
await ev("document.getElementById('add-text').click()"); await sleep(300);
await ev(`(() => { const t = document.getElementById('prop-text'); t.value = '{{Item}}'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await ev(`(() => { const v = document.getElementById('vars'); v.value = 'Item=Widget A'; v.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await ev("document.getElementById('copies').value = '30'");
await openSheet();
check("設定會記住：重新開啟後仍是 3 欄 9 列、普通紙", (await val("sh-cols")) === "3" && (await val("sh-rows")) === "9" && (await val("sh-kind")) === "plain");

// ---- 匯出 PDF ----
await setv("sh-dpi", "300");
await ev("document.getElementById('sh-pdf').click()");
for (let i = 0; i < 60 && !(await ev("window.__saved")); i++) await sleep(500);
const saved = await ev("window.__saved");
check("匯出 PDF：呼叫 write_binary_file，路徑正確", saved?.path === "C:/out/labels.pdf");
const bytes = saved ? Buffer.from(saved.b64, "base64") : Buffer.alloc(0);
const head = bytes.subarray(0, 8).toString("latin1");
const txt = bytes.toString("latin1");
check("PDF 檔頭 %PDF-1.4、結尾 %%EOF", head.startsWith("%PDF-1.4") && txt.trimEnd().endsWith("%%EOF"), head);
check("PDF 共 2 頁、頁面大小為 A4（595.28 × 841.89 pt）", txt.includes("/Count 2") && txt.includes("/MediaBox [0 0 595.28 841.89]"));
check("PDF 影像為 2480 × 3508（A4 300 dpi）", txt.includes("/Width 2480 /Height 3508"));
if (bytes.length) writeFileSync(`${process.argv[2] ?? ".tools"}\\shots\\sheet-test.pdf`, bytes);

// ---- 直接列印（經 Windows 列印對話框）----
await ev("window.__printed = null");
await ev("document.getElementById('sh-print').click()");
for (let i = 0; i < 60 && !(await ev("window.__printed")); i++) await sleep(500);
const pr = await ev("window.__printed");
check("列印：呼叫 window.print，頁面影像 2 張，套用 printing-sheet", pr?.pages === 2 && pr.cls.includes("printing-sheet"), JSON.stringify(pr));
check("列印：@page 紙張 210mm × 297mm、邊界 0；影像剛好 210mm × 297mm", pr?.style?.includes("size: 210mm 297mm") && pr.style.includes("margin: 0") && pr.w === "210mm" && pr.h === "297mm", pr?.style);
await sleep(400);
check("列印完成（afterprint）後清除列印用的暫時內容", (await ev("document.body.className.includes('printing-sheet') || document.querySelectorAll('#sheet-print img').length > 0")) === false);

await t.finish();
