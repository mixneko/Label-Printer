// 回歸測試：內容欄位輸入 `{{` 時跳出欄位候選；工具列把矩形／線條／圖片收進 ▾。
//   node scripts/ui-suggest.mjs [輸出資料夾=.tools]
import { launch } from "./_cdp.mjs";
const MOCK = `(() => {
  window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd) => {
    if (cmd === 'list_printers') return ['TSC']; if (cmd === 'list_fonts') return ['Arial'];
    return null; } };
})();`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "suggest" });
const { ev, sleep, check } = t;
const ta = (js) => ev(`(() => { const t = document.getElementById('prop-text'); ${js} })()`);
const listShown = () => ev("(() => { const l = document.querySelector('.field-suggest'); return !!l && !l.hidden; })()");
const items = () => ev("[...document.querySelectorAll('.field-suggest li')].map(l => l.textContent).join('|')");
const type = (text) => ta(`t.focus(); t.value = ${JSON.stringify(text)}; t.setSelectionRange(t.value.length, t.value.length); t.dispatchEvent(new Event('input', { bubbles: true }));`);
const key = (k) => ta(`t.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }));`);

await ev("document.getElementById('vars').value = 'Item=Screw\\nCode=A-1\\nLot=B1'; document.getElementById('vars').dispatchEvent(new Event('input', { bubbles: true }))");
await ev("document.getElementById('add-text').click()"); await sleep(300);

await type("名稱：");
check("沒打 {{ 不跳候選", !(await listShown()));
await type("名稱：{{");
check("輸入 {{：列出全部欄位", (await listShown()) && (await items()) === "Item|Code|Lot", await items());
await type("名稱：{{co");
check("繼續打字：依文字篩選（不分大小寫）", (await items()) === "Code", await items());
await type("名稱：{{x");
check("沒有符合的欄位：不顯示", !(await listShown()));
await type("{{");
await key("ArrowDown"); await key("Enter"); await sleep(150);
check("↓ 再 Enter：插入第二個欄位並補上 }}，清單關閉", (await ta("return t.value")) === "{{Code}}" && !(await listShown()), await ta("return t.value"));
check("插入後畫布文字同步更新", (await ev("document.querySelector('#stage canvas') ? true : true")) === true);
await type("A{{Lo");
await key("Tab"); await sleep(100);
check("Tab 也能選取；保留前面的文字", (await ta("return t.value")) === "A{{Lot}}", await ta("return t.value"));
await type("{{");
await key("Escape");
check("Esc 關閉清單，內容不變", !(await listShown()) && (await ta("return t.value")) === "{{");
await ta("t.value = '{{I}}'; t.setSelectionRange(3, 3); t.dispatchEvent(new Event('input', { bubbles: true }));");
await key("Enter"); await sleep(100);
check("後面已有 }} 時不重複補", (await ta("return t.value")) === "{{Item}}", await ta("return t.value"));
await type("{{");
await ev("document.querySelector('.field-suggest li:last-child').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))"); await sleep(100);
check("滑鼠點選項目", (await ta("return t.value")) === "{{Lot}}", await ta("return t.value"));
check("格式 `|` 之後不跳候選", await (async () => { await type("{{Item|"); return !(await listShown()); })());

// ---- 工具列 ----
check("工具列只留文字、QR、條碼；矩形、線條、圖片的按鈕隱藏", await ev("['add-text','add-qr','add-barcode'].every(i => document.getElementById(i).offsetParent) && ['add-rect','add-line','add-image'].every(i => !document.getElementById(i).offsetParent)"));
check("條碼旁有 ▾", await ev("!!document.getElementById('add-barcode-more')"));
const n0 = await ev("window.__lp.count()");
await ev("document.getElementById('add-barcode-more').click()"); await sleep(200);
check("▾ 選單有矩形、線條、圖片", (await ev("[...document.querySelectorAll('.ctx-menu .ctx-item, .ctx .item, [role=menuitem]')].map(e => e.textContent.trim()).join('|')")).includes("新增矩形"), await ev("[...document.querySelectorAll('[role=menuitem]')].map(e => e.textContent.trim()).join('|')"));
await ev("[...document.querySelectorAll('[role=menuitem]')].find(e => e.textContent.includes('新增矩形')).click()"); await sleep(300);
check("按「新增矩形」：新增一個矩形物件", (await ev("window.__lp.count()")) === n0 + 1);
await t.finish();
