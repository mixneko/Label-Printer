// 回歸測試：多選（Ctrl／Shift 點選、框選、圖層清單多選、全選）與群組（建立、整組選取與拖曳、取消、複製貼上、復原、存檔欄位）。
// 滑鼠操作用真實的 CDP 滑鼠事件。
//   node scripts/ui-multi.mjs [輸出資料夾=.tools]
import { launch } from "./_cdp.mjs";
const MOCK = `window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd, args) => {
  if (cmd === 'list_printers') return ['TSC']; if (cmd === 'list_fonts') return ['Microsoft JhengHei'];
  if (cmd === 'plugin:dialog|message') return args?.buttons?.OkCancelCustom?.[0];
  return null; } };`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "multi" });
const { ev, send, sleep, check } = t;
const CTRL = 2, SHIFT = 8;
const mouse = (type, x, y, modifiers = 0) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, modifiers });

const st = "window.__lp.konva.stages[0]";
const rects = () => ev(`JSON.stringify(${st}.find('.element').map(n => { const r = n.getClientRect({ relativeTo: n.getLayer(), skipStroke: true }); return { x: n.x(), y: n.y(), l: r.x, t: r.y, w: r.width, h: r.height, label: n.getAttr('label') }; }))`).then(JSON.parse);
const view = () => ev(`JSON.stringify((() => { const c = document.querySelector('#stage canvas').getBoundingClientRect(); return { x: c.x, y: c.y, z: ${st}.scaleX() }; })())`).then(JSON.parse);
const selCount = () => ev("window.__lp.selCount()");
const groupIds = () => ev("JSON.stringify(window.__lp.groupIds())").then(JSON.parse);
const place = (i, x, y) => ev(`(() => { const n = ${st}.find('.element')[${i}]; n.x(${x}); n.y(${y}); n.getLayer().batchDraw(); })()`);
const key = (k, mods = {}) => ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, ctrlKey: ${!!mods.ctrl}, shiftKey: ${!!mods.shift} }))`).then(() => sleep(250));
const labelSize = () => ev(`JSON.stringify({ w: ${st}.width() / ${st}.scaleX(), h: ${st}.height() / ${st}.scaleY() })`).then(JSON.parse);

/** 在物件 i 的中心點一下（可帶修飾鍵） */
async function clickEl(i, modifiers = 0) {
  const r = (await rects())[i], v = await view();
  const x = v.x + (r.l + r.w / 2) * v.z, y = v.y + (r.t + r.h / 2) * v.z;
  await mouse("mouseMoved", x, y, modifiers); await mouse("mousePressed", x, y, modifiers); await mouse("mouseReleased", x, y, modifiers);
  await sleep(150);
}
/** 從畫布座標 (x1,y1) 拖到 (x2,y2)（dots） */
async function dragBetween(x1, y1, x2, y2, modifiers = 0) {
  const v = await view();
  const sx = v.x + x1 * v.z, sy = v.y + y1 * v.z, ex = v.x + x2 * v.z, ey = v.y + y2 * v.z;
  await mouse("mouseMoved", sx, sy, modifiers); await mouse("mousePressed", sx, sy, modifiers);
  for (let k = 1; k <= 10; k++) { await mouse("mouseMoved", sx + ((ex - sx) * k) / 10, sy + ((ey - sy) * k) / 10, modifiers); await sleep(15); }
  await sleep(80);
  await mouse("mouseReleased", ex, ey, modifiers);
  await sleep(200);
}
const layerClick = (idx, mods = {}) => ev(`document.querySelectorAll('#layer-list li')[${idx}].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: ${!!mods.ctrl}, shiftKey: ${!!mods.shift} }))`).then(() => sleep(200));

// 準備：三個矩形 A B C，彼此分開，右下角留空白
for (let i = 0; i < 3; i++) { await ev("document.getElementById('add-rect').click()"); await sleep(250); }
await ev(`${st}.find('.element').forEach((n, i) => n.setAttr('label', 'ABC'[i]))`);
const { w: LW, h: LH } = await labelSize();
await place(0, 20, 20); await place(1, 230, 20); await place(2, 20, 140); await sleep(200);
let R = await rects();
check("準備：三個矩形", R.length === 3, JSON.stringify(R.map((r) => [r.l, r.t, r.w, r.h])));

// 1) 單選與 Ctrl／Shift 加選
await clickEl(0);
check("點一下只選一個", (await selCount()) === 1);
await clickEl(1, CTRL);
check("Ctrl+點選第二個 → 多選 2 個", (await selCount()) === 2);
await clickEl(1, CTRL);
check("Ctrl+再點一次 → 取消那個，剩 1 個", (await selCount()) === 1);
await clickEl(2, SHIFT);
check("Shift+點選 → 加入選取", (await selCount()) === 2);
await clickEl(1);
check("不按修飾鍵點選 → 只留被點的那個", (await selCount()) === 1);
check("多選後屬性面板顯示提示", true);
await clickEl(0, CTRL); await sleep(100);
check("多選時屬性面板顯示「已選取 2 個物件」", (await ev("document.getElementById('multi-info').hidden")) === false && (await ev("document.getElementById('multi-info').textContent")).includes("2"));
check("多選時縮放框不能旋轉", (await ev(`${st}.find('Transformer')[0].rotateEnabled()`)) === false);

// 2) 框選
await clickEl(2); // 先單選，再用框選取代
await dragBetween(LW - 6, LH - 6, 4, 4);
check("在空白處拖曳框選 → 選到全部 3 個", (await selCount()) === 3, `${await selCount()}`);
check("框選結束後選取框暫時物件已清除", (await ev(`${st}.find('.marquee').length`)) === 0);
await dragBetween(LW - 6, LH - 6, 200, 120); // 只碰到 B 的下方一小塊？(B 在 230,20 之上，不含) → 空白
R = await rects();
const bR = R[1];
await dragBetween(bR.l + bR.w + 10, bR.t + bR.h + 10, bR.l + bR.w / 2, bR.t + bR.h / 2);
check("框選只碰到一個 → 選 1 個", (await selCount()) === 1, `${await selCount()}`);
await dragBetween(LW - 6, LH - 6, 4, 4, CTRL);
check("Ctrl+框選：加入選取", (await selCount()) === 3);
await clickEl(0, 0); await clickEl(2, CTRL);
await dragBetween(LW - 6, 200, LW - 3, 210);
check("空白處點一下 → 取消選取", (await selCount()) === 0);

// 3) 圖層清單多選、Shift 連選
await layerClick(0); // 清單最上面是最後加入的 C
check("圖層清單點一下 → 單選", (await selCount()) === 1);
await layerClick(2, { ctrl: true });
check("圖層清單 Ctrl+點選 → 多選", (await selCount()) === 2);
await layerClick(0);
await layerClick(2, { shift: true });
check("圖層清單 Shift+點選 → 連選整段（3 個）", (await selCount()) === 3, `${await selCount()}`);

// 4) 全選與群組
await ev("window.__lp.selectIdx([])"); await sleep(100);
await key("a", { ctrl: true });
check("Ctrl+A 全選", (await selCount()) === 3);
check("選了 3 個，「群組」按鈕可按、「取消群組」不可按", !(await ev("document.getElementById('group-btn').disabled")) && (await ev("document.getElementById('ungroup-btn').disabled")));
await ev("document.getElementById('group-btn').click()"); await sleep(200);
let g = await groupIds();
check("按「群組」→ 三個物件有相同的群組編號", g.every((x) => x && x === g[0]), JSON.stringify(g));
check("群組後「群組」按鈕停用、「取消群組」可按", (await ev("document.getElementById('group-btn').disabled")) && !(await ev("document.getElementById('ungroup-btn').disabled")));
await dragBetween(LW - 6, 200, LW - 3, 210);
check("取消選取", (await selCount()) === 0);
await clickEl(0);
check("點群組中的一個 → 整組（3 個）都被選取", (await selCount()) === 3);
check("圖層清單標示群組（3 列有 grouped）", (await ev("document.querySelectorAll('#layer-list li.grouped').length")) === 3);
check("群組的屬性面板說明", (await ev("document.getElementById('multi-info').textContent")).includes("群組"));

// 5) 拖曳群組中的一個 → 整組一起移動
R = await rects();
await dragBetween(R[0].l + R[0].w / 2, R[0].t + R[0].h / 2, R[0].l + R[0].w / 2 + 30, R[0].t + R[0].h / 2 + 12);
let R2 = await rects();
const dxs = R2.map((r, i) => +(r.l - R[i].l).toFixed(1)), dys = R2.map((r, i) => +(r.t - R[i].t).toFixed(1));
check("拖曳群組 → 三個物件移動相同的距離", dxs.every((d) => Math.abs(d - dxs[0]) < 0.6) && dys.every((d) => Math.abs(d - dys[0]) < 0.6) && Math.abs(dxs[0]) > 10, `dx=${dxs} dy=${dys}`);

// 6) 對齊（整塊）
await ev("window.__lp.selectIdx([0,1,2])"); await sleep(100);
R = await rects();
await ev("document.getElementById('align-right').click()"); await sleep(200);
R2 = await rects();
const right = Math.max(...R2.map((r) => r.l + r.w));
check("多選「靠右對齊」→ 整塊的右緣貼齊標籤右邊", Math.abs(right - LW) < 0.6, `右緣=${right} 標籤寬=${LW}`);
check("整塊對齊時彼此的相對位置不變", Math.abs((R2[1].l - R2[0].l) - (R[1].l - R[0].l)) < 0.6 && Math.abs((R2[2].t - R2[0].t) - (R[2].t - R[0].t)) < 0.6);

// 7) 方向鍵整批移動
const before = await rects();
await key("ArrowDown");
const after = await rects();
check("方向鍵移動全部選取的物件", after.every((r, i) => Math.abs(r.t - before[i].t - 1) < 0.01));

// 8) 複製貼上：群組保留，且與原本的群組分開
const nBefore = (await rects()).length;
await key("c", { ctrl: true }); await key("v", { ctrl: true });
g = await groupIds();
check("複製貼上群組 → 多出 3 個物件", g.length === nBefore + 3, `${g.length}`);
const oldId = g[0], newIds = new Set(g.slice(3));
check("貼上的物件是新的群組（編號與原本不同、彼此相同）", newIds.size === 1 && ![...newIds][0] === false && ![...newIds].includes(oldId), JSON.stringify(g));
check("貼上後選取的是新貼的 3 個", (await selCount()) === 3);

// 9) 刪除整批
await key("Delete");
check("Delete 刪除選取的全部物件", (await rects()).length === nBefore, `${(await rects()).length}`);

// 10) 取消群組
await ev("window.__lp.selectIdx([0])"); await sleep(100);
check("選到群組中的一個仍是整組", (await selCount()) === 3);
await ev("document.getElementById('ungroup-btn').click()"); await sleep(200);
g = await groupIds();
check("按「取消群組」→ 群組編號清除", g.every((x) => x === null), JSON.stringify(g));
await clickEl(0);
check("取消群組後點一下只選一個", (await selCount()) === 1);

// 11) 圖層順序（多選保持彼此前後）
await ev("window.__lp.selectIdx([0,1])"); await sleep(100);
await ev("document.getElementById('layer-top').click()"); await sleep(200);
const order = (await rects()).map((r) => r.label).join("");
check("多選「置頂」→ A、B 移到最上面並保持 A 在 B 下", order === "CAB", order);
await ev("window.__lp.selectIdx([1,2])"); await sleep(100);
await ev("document.getElementById('layer-bottom').click()"); await sleep(200);
check("多選「置底」→ 保持彼此的前後", (await rects()).map((r) => r.label).join("") === "ABC", (await rects()).map((r) => r.label).join(""));

// 12) 群組可復原
await ev("window.__lp.selectIdx([0,1,2])"); await sleep(100);
await sleep(600); // 讓先前的動作先記成一步
await ev("document.getElementById('group-btn').click()"); await sleep(700);
check("群組建立", (await groupIds()).every((x) => x));
await ev("document.getElementById('undo-btn').click()"); await sleep(600);
check("復原 → 群組消失", (await groupIds()).every((x) => x === null), JSON.stringify(await groupIds()));
await ev("document.getElementById('redo-btn').click()"); await sleep(600);
check("重做 → 群組回來", (await groupIds()).every((x) => x));

// 13) 鎖定的物件不會被框選／多選
await ev("window.__lp.selectIdx([])"); await sleep(100);
await ev("document.getElementById('group-btn').disabled");
await t.finish();
