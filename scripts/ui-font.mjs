// 回歸測試：字型選擇（輸入 + 下拉清單）。重點：點進欄位時「不會把原本的字型清空」。
//   node scripts/ui-font.mjs [輸出資料夾=.tools]      （腳本會自己啟動並關閉 Vite）
import { launch } from "./_cdp.mjs";

const FONTS = ["Arial", "Consolas", "Microsoft JhengHei", "Times New Roman", "微軟正黑體", "新細明體", "標楷體"];
const MOCK = `window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd) => {
  if (cmd === 'list_printers') return ['TSC']; if (cmd === 'list_fonts') return ${JSON.stringify(FONTS)}; return null; } };`;

const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "font" });
const { ev, send, sleep, check } = t;

const val = () => ev("document.getElementById('prop-font').value");
const listOpen = () => ev("!document.getElementById('font-list').hidden");
const items = () => ev("Array.from(document.querySelectorAll('#font-list li')).map(l => l.textContent)");
const family = async () => JSON.parse(await ev("JSON.stringify(window.__lp.text())")).fontFamily;
const key = async (k, code, extra = {}) => { await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: code, ...extra }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: code }); await sleep(200); };
const typeText = async (s) => { for (const ch of s) { await send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch }); } await sleep(250); };
const pointOf = async (sel) => JSON.parse(await ev(`JSON.stringify((() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })())`));
const click = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(300);
};

await ev("document.getElementById('add-text').click()"); await sleep(400);
check("新增文字：預設字型 Microsoft JhengHei", (await val()) === "Microsoft JhengHei" && (await family()) === "Microsoft JhengHei");

// ---------- 1. 點進欄位：不清空 ----------
let p = await pointOf("#prop-font");
await click(p.x - 30, p.y); // 真正的滑鼠點擊（不是程式呼叫 focus）
check("點進欄位 → 原本的字型沒有被清空", (await val()) === "Microsoft JhengHei", await val());
check("點進欄位 → 文字被全選（直接輸入就是取代）", await ev("(() => { const i = document.getElementById('prop-font'); return i.selectionStart === 0 && i.selectionEnd === i.value.length; })()"));
check("點進欄位 → 展開完整清單（不是只剩目前這一項）", (await listOpen()) && (await items()).length === FONTS.length, `${(await items()).length} 項`);
check("目前的字型在清單中標示", (await ev("document.querySelector('#font-list li.sel')?.textContent")) === "Microsoft JhengHei");
check("字型沒有因為點擊而改變", (await family()) === "Microsoft JhengHei");
// 點開清單不能讓側邊面板跳動（scrollIntoView 會連外層一起捲動）
const panelTopBefore = p.y;
const panelTopNow = (await pointOf("#prop-font")).y;
check("點開清單時側邊面板不會跳動（欄位位置不變）", Math.abs(panelTopNow - panelTopBefore) < 1, `${panelTopBefore} → ${panelTopNow}`);
check("清單中目前字型的項目在清單的可視範圍內", await ev("(() => { const l = document.getElementById('font-list'); const s = l.querySelector('li.sel'); return s.offsetTop >= l.scrollTop && s.offsetTop + s.offsetHeight <= l.scrollTop + l.clientHeight; })()"));
await t.shot("1-open");

// ---------- 2. 輸入關鍵字篩選（不分大小寫、子字串）----------
await typeText("tim");
check("輸入 tim → 篩選出 Times New Roman", JSON.stringify(await items()) === JSON.stringify(["Times New Roman"]), (await items()).join("、"));
check("輸入過程中，還沒選定前字型維持不變", (await family()) === "Microsoft JhengHei");
await key("Enter", 13);
check("Enter → 套用 Times New Roman，清單收起", (await family()) === "Times New Roman" && (await val()) === "Times New Roman" && !(await listOpen()), `${await family()}`);

// ---------- 3. 中文關鍵字、上下鍵 ----------
await click(p.x - 30, p.y);
await ev("document.getElementById('prop-font').select()");
await typeText("正黑");
check("輸入「正黑」→ 篩選出微軟正黑體", JSON.stringify(await items()) === JSON.stringify(["微軟正黑體"]), (await items()).join("、"));
await key("Escape", 27);
check("Esc → 收起清單並還原原字型，不套用", !(await listOpen()) && (await val()) === "Times New Roman" && (await family()) === "Times New Roman", `${await val()}`);
await click(p.x - 30, p.y);
await key("ArrowDown", 40);
await key("ArrowDown", 40);
await key("Enter", 13);
check("上下鍵移動、Enter 選定", (await family()) !== "Times New Roman" && FONTS.includes(await family()), await family());

// ---------- 4. 用滑鼠點清單項目 ----------
await click(p.x - 30, p.y);
const arial = await pointOf("#font-list li:first-child");
await click(arial.x, arial.y);
check("點清單項目 → 套用該字型並收起清單", (await family()) === "Arial" && (await val()) === "Arial" && !(await listOpen()), `${await family()}`);

// ---------- 5. ▾ 按鈕 ----------
const tg = await pointOf("#font-toggle");
await click(tg.x, tg.y);
check("按 ▾ → 展開完整清單，原字型保留", (await listOpen()) && (await items()).length === FONTS.length && (await val()) === "Arial");
await click(tg.x, tg.y);
check("再按一次 ▾ → 收起清單", !(await listOpen()));

// ---------- 6. 沒有符合、無效輸入 ----------
await click(p.x - 30, p.y);
await ev("document.getElementById('prop-font').select()");
await typeText("zzzz");
check("沒有符合的字型 → 顯示「沒有符合的字型」", JSON.stringify(await items()) === JSON.stringify(["沒有符合的字型"]));
check("輸入到一半（無效名稱）時字型維持不變", (await family()) === "Arial");
{ const sp = await pointOf(".toolbar .spacer"); await click(sp.x, sp.y); } // 點到別處（工具列空白處），離開欄位
check("離開欄位時若是無效名稱 → 還原為目前的字型", (await val()) === "Arial" && !(await listOpen()) && (await family()) === "Arial", `${await val()}`);

// ---------- 7. 選到別的物件時，欄位顯示該物件的字型 ----------
await ev("document.getElementById('add-text').click()"); await sleep(300);
check("新增另一個文字 → 欄位顯示預設字型（不是上一個物件的）", (await val()) === "Microsoft JhengHei");
await t.finish();
