// 回歸測試：條碼寬度依內容自動調整、畫布上用「變數測試資料」（沒有就用範例）、展開方向（左→右／右→左）。
//   node scripts/ui-barcode.mjs [輸出資料夾=.tools]
import { launch } from "./_cdp.mjs";
const MOCK = `window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd, args) => {
  if (cmd === 'list_printers') return ['TSC']; if (cmd === 'list_fonts') return ['Microsoft JhengHei'];
  if (cmd === 'plugin:dialog|message') return args?.buttons?.OkCancelCustom?.[0];
  return null; } };`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "barcode" });
const { ev, sleep, check } = t;
const node = () => ev("JSON.stringify(window.__lp.node())").then(JSON.parse);
const setProp = (id, v) => ev(`(() => { const i = document.getElementById('${id}'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); })()`).then(() => sleep(250));
const setVars = (v) => setProp("vars", v);
const withRow = (row) => ev(`JSON.stringify(window.__lp.barcodeWith(${JSON.stringify(row)}))`).then(JSON.parse);

await ev("document.getElementById('add-barcode').click()"); await sleep(500);
await setProp("prop-text", "{{產品序號}}");
let n = await node();
check("內容是還沒有值的變數時，畫布顯示範例條碼而不是「條碼內容無效」（寬度不是錯誤框的 220）", n.w !== 220 && n.h !== 48 && n.w > 150, `${n.w}×${n.h}`);
const sampleW = n.w;

await setVars("產品序號=ABC123");
n = await node();
check("有「變數測試資料」時，畫布依測試資料的內容調整寬度（6 個字比範例 10 個字窄）", n.w < sampleW && n.w > 100, `${sampleW} → ${n.w}`);
const w6 = n.w;
await setVars("產品序號=ABC123456789");
n = await node();
check("測試資料變長 → 條碼變寬", n.w > w6, `${w6} → ${n.w}`);
check("預設展開方向是「從左向右」", n.anchor === "left" && (await ev("document.getElementById('prop-anchor').value")) === "left");

// 左邊固定：內容變長，x 不變
const x0 = n.x;
await setVars("產品序號=AB");
n = await node();
check("向右展開：內容變短，左邊緣（x）不動、右邊緣往左縮", n.x === x0, `x ${x0} → ${n.x}，w=${n.w}`);

// 改成向左展開
await setVars("產品序號=ABC123");
n = await node();
const right0 = n.x + n.w;
await setProp("prop-anchor", "right");
n = await node();
check("切換成「從右向左展開」：位置不動、右邊緣不變", n.anchor === "right" && n.x + n.w === right0, `右邊緣 ${right0} → ${n.x + n.w}`);
await setVars("產品序號=ABC123456789");
n = await node();
check("向左展開：內容變長，右邊緣固定、左邊緣往左移", n.x + n.w === right0 && n.x < right0 - 200 + 1000 && n.w > w6, `右邊緣 ${n.x + n.w}，x=${n.x}，w=${n.w}`);
await setVars("產品序號=AB");
n = await node();
check("向左展開：內容變短，右邊緣固定、左邊緣往右移", n.x + n.w === right0, `右邊緣 ${n.x + n.w}，w=${n.w}`);

// 像列印一樣用「這一張」的資料
await setVars("");
const r1 = await withRow({ 產品序號: "A1" });
const r2 = await withRow({ 產品序號: "ABCDEFGHIJ" });
check("列印時每張依自己的內容算寬度（短的比長的窄）", r1.w < r2.w, `${r1.w} vs ${r2.w}`);
check("向左展開：每一張的右邊緣都在同一個位置", r1.x + r1.w === right0 && r2.x + r2.w === right0, `${r1.x + r1.w} / ${r2.x + r2.w} / ${right0}`);
const miss = await withRow({});
check("列印時缺少欄位仍視為無效（不會印出範例條碼）", miss.w === 220 && miss.h === 48, `${miss.w}×${miss.h}`);
n = await node();
check("列印用的重新產生之後，設計畫面還原（右邊緣不變）", n.x + n.w === right0, `${n.x + n.w}`);

// 復原／重做保留展開方向與位置
await ev("document.getElementById('add-text').click()"); await sleep(500);
await ev("document.getElementById('undo-btn').click()"); await sleep(600);
await ev("document.querySelector('#layer-list li').click()"); await sleep(300);
n = await node();
check("復原再選回條碼：展開方向仍是「從右向左」，右邊緣不變", n.anchor === "right" && n.x + n.w === right0, `${n.anchor} ${n.x + n.w}`);

// 向右展開的條碼用 x 存檔；改回向右
await setProp("prop-anchor", "left");
n = await node();
check("切回「從左向右」", n.anchor === "left" && (await ev("document.getElementById('prop-anchor').value")) === "left");
await setVars("產品序號=ABC123456789");
const grown = await node();
await setVars("產品序號=AB");
n = await node();
check("切回後左邊緣固定", n.x === grown.x, `${grown.x} → ${n.x}`);

// 面板與說明文字
check("屬性面板有「展開方向」與不能手動拉寬的說明", (await ev("document.getElementById('prop-anchor').options.length")) === 2 && (await ev("document.querySelector('[data-kinds=barcode] .hint').textContent")).includes("不能手動拉寬"));
await t.shot("1-barcode");
await t.finish();
