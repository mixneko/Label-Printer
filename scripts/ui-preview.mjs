// 回歸測試：預覽列印（工具列按鈕 / Ctrl+P / 資料表上的按鈕）。
// 重點是「所見即所印」：預覽畫出的黑點，必須和實際送給印表機的點陣完全一致。
//   node scripts/ui-preview.mjs [輸出資料夾=.tools]      （腳本會自己啟動並關閉 Vite）
import { launch } from "./_cdp.mjs";

const MOCK = `
window.__jobs = [];
window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd, args) => {
  if (cmd === 'list_printers') return ['TSC TTP-244 Pro'];
  if (cmd === 'list_fonts') return ['Microsoft JhengHei'];
  if (cmd === 'plugin:dialog|open') return 'D:\\\\data.xlsx';
  if (cmd === 'format_values') return args.items.map((it) => it.raw.d && it.code === 'yyyy/mm/dd' ? it.raw.d[0] + '/' + String(it.raw.d[1]).padStart(2, '0') + '/' + String(it.raw.d[2]).padStart(2, '0') : null);
  if (cmd === 'print_labels') { window.__jobs.push(JSON.parse(JSON.stringify(args))); return null; }
  if (cmd === 'read_table') return {
    sheets: ['S'], sheet: 'S', headers: ['品名', '日期'],
    rows: [['蘋果', '2026-01-05'], ['香蕉', '2026-11-18'], ['橘子', '2027-03-09']], rowNumbers: [2, 3, 4],
    raw: [[null, { d: [2026, 1, 5, 0, 0, 0, 0] }], [null, { d: [2026, 11, 18, 0, 0, 0, 0] }], [null, { d: [2027, 3, 9, 0, 0, 0, 0] }]] };
  return null; } };`;

const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "preview", height: 950 });
const { ev, send, sleep, check } = t;

const dlgOpen = () => ev("document.getElementById('pv-dialog').open");
const text = (id) => ev(`document.getElementById(${JSON.stringify(id)}).textContent`);
const hidden = (id) => ev(`document.getElementById(${JSON.stringify(id)}).hidden`);
const disabled = (id) => ev(`document.getElementById(${JSON.stringify(id)}).disabled`);
const key = async (k, code) => { await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: code }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: code }); await sleep(450); };
// 預覽畫布：黑點數量、最左邊的黑點、內容指紋
const canvasStats = () => ev(`(() => { const c = document.getElementById('pv-canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0, left = c.width, h = 2166136261; for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) { const i = (y * c.width + x) * 4; if (d[i] < 128) { n++; if (x < left) left = x; h = Math.imul(h ^ (x + y * 1000), 16777619); } }
  return JSON.stringify({ w: c.width, h: c.height, black: n, left, hash: h >>> 0 }); })()`).then(JSON.parse);
const popcount = (b64) => { const bin = Buffer.from(b64, "base64"); let n = 0; for (const byte of bin) { let v = byte; while (v) { n += v & 1; v >>= 1; } } return n; };
const setContent = async (v) => { await ev(`(() => { const x = document.getElementById('prop-text'); x.value = ${JSON.stringify(v)}; x.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(200); };

// ---------- 1. 沒有資料表：預覽「變數測試資料」的單張 ----------
await ev("document.getElementById('add-text').click()"); await sleep(300);
await setContent("品名:{{品名}}");
await ev(`(() => { const v = document.getElementById('vars'); v.value = '品名=蘋果'; v.dispatchEvent(new Event('input', { bubbles: true })); })()`);
check("工具列有「預覽列印」按鈕", await ev("!!document.getElementById('preview-print')"));
await ev("document.getElementById('preview-print').click()"); await sleep(700);
check("按下 → 開啟預覽列印視窗", await dlgOpen());
check("單張：說明來源是變數測試資料，隱藏翻頁按鈕", (await text("pv-page")).includes("變數測試資料") && (await hidden("pv-nav")));
let s = await canvasStats();
check("畫布大小 = 整張紙的點數（62.5×30 mm → 500×240）", s.w === 500 && s.h === 240, `${s.w}×${s.h}`);
check("預覽有畫出文字，且在標籤範圍內（紙張左邊 10 點的空白邊不會有黑點）", s.black > 0 && s.left >= 10, `黑點 ${s.black}，最左 ${s.left}`);
const info = await text("pv-info");
check("下方資訊：紙張／標籤尺寸、印表機、濃度、速度、撕紙位置", ["62.5 × 30", "60 × 30", "印表機：TSC TTP-244 Pro", "濃度 10", "速度 4", "撕紙位置 開"].every((x) => info.includes(x)), info);
check("總張數與按鈕", (await text("pv-total")) === "1 筆資料 × 每筆 1 張 = 1 張" && (await text("pv-print")) === "列印 1 張", `${await text("pv-total")}／${await text("pv-print")}`);
check("畫出標籤之間的間隙", !(await hidden("pv-gap")) && (await text("pv-gap-text")).includes("間隙 2 mm"));
await t.shot("1-single");

// ---------- 2. 所見即所印 ----------
const previewBlack = s.black;
await ev("document.getElementById('pv-print').click()"); await sleep(700);
let job = JSON.parse(await ev("JSON.stringify(window.__jobs.at(-1))")).jobs[0];
check("按預覽中的「列印」→ 送出 1 張，視窗關閉", !(await dlgOpen()) && (await ev("window.__jobs.length")) === 1);
check("所見即所印：預覽的黑點數 = 實際送出的點陣黑點數", popcount(job.bitmap) === previewBlack, `預覽 ${previewBlack} / 送出 ${popcount(job.bitmap)}`);
check("所見即所印：標籤在紙上的位置一致（offsetX = 預覽中標籤的起點 10）", job.offsetXDots === 10 && job.widthPx === 480, `offsetXDots=${job.offsetXDots}`);

// ---------- 3. Ctrl+P、Esc ----------
check("Ctrl+P → 開啟預覽並阻止瀏覽器預設的列印", await ev("(() => { const e = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true }); document.dispatchEvent(e); return e.defaultPrevented; })()") && (await (async () => { await sleep(600); return dlgOpen(); })()));
await key("Escape", 27);
check("按 Esc → 關閉預覽", !(await dlgOpen()));

// ---------- 4. 資料表：逐張預覽勾選的列 ----------
await setContent("品名:{{品名}} 日期:{{日期|yyyy/mm/dd}}");
await ev("document.getElementById('import-table').click()"); await sleep(900);
check("尚未勾選時，資料表上的「預覽列印」停用", await disabled("data-preview"));
await ev("document.getElementById('data-all').click()"); await sleep(200);
check("勾選後「預覽列印」可用", !(await disabled("data-preview")));
await ev("(() => { const c = document.getElementById('copies'); c.value = '2'; c.dispatchEvent(new Event('input', { bubbles: true })); })()");
await ev("document.getElementById('data-preview').click()"); await sleep(900);
check("資料表上的按鈕 → 開啟預覽", await dlgOpen());
check("第 1 / 3 張，標示對應的 Excel 列號", (await text("pv-page")) === "第 1 / 3 張（Excel 第 2 列）", await text("pv-page"));
check("顯示翻頁按鈕；第一張時「上一張」停用", !(await hidden("pv-nav")) && (await disabled("pv-prev")) && !(await disabled("pv-next")));
check("總張數 = 3 筆 × 每筆 2 張 = 6 張", (await text("pv-total")) === "3 筆資料 × 每筆 2 張 = 6 張" && (await text("pv-print")) === "列印 6 張", `${await text("pv-total")}／${await text("pv-print")}`);
const p1 = await canvasStats();
check("第一張有內容", p1.black > 0);
await t.shot("2-page1");

await ev("document.getElementById('pv-next').click()"); await sleep(600);
const p2 = await canvasStats();
check("下一張 → 第 2 / 3 張（Excel 第 3 列），內容和第一張不同", (await text("pv-page")) === "第 2 / 3 張（Excel 第 3 列）" && p2.hash !== p1.hash, `${await text("pv-page")}`);
const resolved = JSON.parse(await ev("JSON.stringify(window.__lp.resolved())"))[0];
check("預覽套用了「欄位格式」（日期照指定的 yyyy/mm/dd）", resolved["日期|yyyy/mm/dd"] === "2026/11/18", JSON.stringify(resolved));
await key("ArrowRight", 39);
check("方向鍵 → 下一張（第 3 / 3 張），最後一張時「下一張」停用", (await text("pv-page")).startsWith("第 3 / 3 張") && (await disabled("pv-next")));
await key("ArrowLeft", 37);
check("方向鍵 ← 回到上一張", (await text("pv-page")).startsWith("第 2 / 3 張"));
await key("Home", 36);
check("Home → 第一張", (await text("pv-page")).startsWith("第 1 / 3 張") && (await canvasStats()).hash === p1.hash);
await key("End", 35);
check("End → 最後一張", (await text("pv-page")).startsWith("第 3 / 3 張"));

// ---------- 5. 縮放、標示範圍 ----------
const paperW = () => ev("Math.round(document.getElementById('pv-paper').getBoundingClientRect().width)");
await ev("(() => { const z = document.getElementById('pv-zoom'); z.value = '1'; z.dispatchEvent(new Event('change', { bubbles: true })); })()"); await sleep(200);
check("縮放 1 倍：紙寬 = 500 px", (await paperW()) === 500, `${await paperW()}`);
await ev("(() => { const z = document.getElementById('pv-zoom'); z.value = '2'; z.dispatchEvent(new Event('change', { bubbles: true })); })()"); await sleep(200);
check("縮放 2 倍：紙寬 = 1000 px", (await paperW()) === 1000, `${await paperW()}`);
await ev("(() => { const z = document.getElementById('pv-zoom'); z.value = 'auto'; z.dispatchEvent(new Event('change', { bubbles: true })); })()"); await sleep(200);
const fit = await ev("(() => { const b = document.querySelector('.pv-body'); return { paper: Math.round(document.getElementById('pv-paper').getBoundingClientRect().width), body: b.clientWidth }; })()");
check("符合視窗：紙寬不超過視窗內容寬度", fit.paper <= fit.body && fit.paper > 300, `${fit.paper} / ${fit.body}`);
check("標籤範圍虛線框預設顯示，可關閉", !(await hidden("pv-area")) && await (async () => { await ev("document.getElementById('pv-area-toggle').click()"); await sleep(100); return hidden("pv-area"); })());
await ev("document.getElementById('pv-area-toggle').click()");

// ---------- 6. 從預覽列印整批 ----------
await ev("window.__jobs = []");
await ev("document.getElementById('pv-print').click()"); await sleep(800);
const batch = JSON.parse(await ev("JSON.stringify(window.__jobs.at(-1))"));
check("預覽中按「列印 6 張」→ 一次送出 3 筆資料", batch.jobs.length === 3 && batch.jobs.every((j) => j.copies === 2), `${batch.jobs.length} 筆，每筆 ${batch.jobs[0]?.copies} 張`);
check("列印後視窗關閉並顯示狀態", !(await dlgOpen()) && (await text("status")).includes("已送出列印"), await text("status"));
check("第 2 張實際送出的點陣與預覽一致", popcount(batch.jobs[1].bitmap) === (await (async () => { await ev("document.getElementById('preview-print').click()"); await sleep(800); await ev("document.getElementById('pv-next').click()"); await sleep(600); return (await canvasStats()).black; })()), `送出 ${popcount(batch.jobs[1].bitmap)}`);
await key("Escape", 27);

// ---------- 7. 設定會反映在預覽（字體加粗）----------
await ev("document.getElementById('data-none').click()"); await sleep(150);
check("取消勾選 → 資料表上的「預覽列印」又停用", await disabled("data-preview"));
await ev("document.getElementById('preview-print').click()"); await sleep(800);
const bold0 = (await canvasStats()).black;
await key("Escape", 27);
await ev("(() => { const b = document.getElementById('q-bold'); b.value = '4'; b.dispatchEvent(new Event('input', { bubbles: true })); })()");
await ev("document.getElementById('preview-print').click()"); await sleep(800);
const bold4 = (await canvasStats()).black;
check("沒有勾選資料列時，預覽回到變數測試資料（單張）", (await text("pv-page")).includes("變數測試資料"));
check("字體加粗 +4 → 預覽的黑點變多（預覽採用目前的列印設定）", bold4 > bold0, `標準 ${bold0} → +4 ${bold4}`);
check("資訊列顯示字體加粗 +4", (await text("pv-info")).includes("字體加粗 +4"));
await t.shot("3-bold");
await t.finish();
