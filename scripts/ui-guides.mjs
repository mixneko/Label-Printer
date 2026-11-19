// 回歸測試：拖曳物件時的對齊線（吸附到其他物件與標籤的邊緣／中心、Alt 暫停、可關閉並記住）。用真實的滑鼠事件拖曳。
//   node scripts/ui-guides.mjs [輸出資料夾=.tools]
import { launch } from "./_cdp.mjs";
const MOCK = `window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd, args) => {
  if (cmd === 'list_printers') return ['TSC']; if (cmd === 'list_fonts') return ['Microsoft JhengHei'];
  if (cmd === 'plugin:dialog|message') return args?.buttons?.OkCancelCustom?.[0];
  return null; } };`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "guides" });
const { ev, send, sleep, check } = t;
const mouse = (type, x, y, modifiers = 0) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, modifiers });

const rects = () => ev(`JSON.stringify(window.__lp.konva.stages[0].find('.element').map(n => { const r = n.getClientRect({ relativeTo: n.getLayer(), skipStroke: true }); return { x: n.x(), y: n.y(), l: r.x, t: r.y, w: r.width, h: r.height }; }))`).then(JSON.parse);
const guideCount = () => ev("window.__lp.konva.stages[0].find('.guide').length");
const view = () => ev(`JSON.stringify((() => { const c = document.querySelector('#stage canvas').getBoundingClientRect(); return { x: c.x, y: c.y, z: window.__lp.konva.stages[0].scaleX() }; })())`).then(JSON.parse);
const place = (i, x, y) => ev(`(() => { const n = window.__lp.konva.stages[0].find('.element')[${i}]; n.x(${x}); n.y(${y}); n.getLayer().batchDraw(); })()`);

/** 把第 i 個物件從目前位置拖 (dx, dy)（單位 dots）。during 在放開滑鼠之前呼叫。 */
async function drag(i, dx, dy, { alt = false, during } = {}) {
  const [r] = (await rects()).slice(i, i + 1);
  const v = await view();
  const sx = v.x + (r.l + r.w / 2) * v.z, sy = v.y + (r.t + r.h / 2) * v.z;
  const mod = alt ? 1 : 0;
  await mouse("mouseMoved", sx, sy, mod);
  await mouse("mousePressed", sx, sy, mod);
  for (let k = 1; k <= 10; k++) { await mouse("mouseMoved", sx + (dx * v.z * k) / 10, sy + (dy * v.z * k) / 10, mod); await sleep(15); }
  await sleep(100);
  const mid = during ? await during() : null;
  await mouse("mouseReleased", sx + dx * v.z, sy + dy * v.z, mod);
  await sleep(200);
  return mid;
}

// 兩個矩形：A 固定在 (100, 50)；B 在 (300, 160)，兩者大小相同（200×100，含線寬的外框由 getClientRect skipStroke 排除）
await ev("document.getElementById('add-rect').click()"); await sleep(300);
await ev("document.getElementById('add-rect').click()"); await sleep(300);
await place(0, 100, 50); await place(1, 300, 160); await sleep(200);
let [A, B] = await rects();
check("準備：兩個矩形", !!A && !!B, JSON.stringify([A.l, A.t, B.l, B.t]));

// 1) 左邊緣靠近 A 的左邊緣（差 3 dots）→ 吸附
let mid = await drag(1, A.l + 3 - B.l, 0, { during: guideCount });
[A, B] = await rects();
check("拖曳中出現對齊線", mid >= 1, `${mid} 條`);
check("放開後 B 的左邊緣剛好對齊 A 的左邊緣", Math.abs(B.l - A.l) < 0.01, `A.left=${A.l} B.left=${B.l}`);
check("放開後對齊線消失", (await guideCount()) === 0);

// 2) 離得遠（20 dots）→ 不吸附
await place(1, 300, 160);
await drag(1, A.l + 20 - 300, 0);
[A, B] = await rects();
check("距離遠（約 20 dots）不吸附", Math.abs(B.l - (A.l + 20)) < 1.5, `B.left=${B.l}，A.left+20=${A.l + 20}`);

// 3) 按住 Alt 暫停吸附
await place(1, 300, 160); await sleep(100);
[A, B] = await rects();
mid = await drag(1, A.l + 3 - B.l, 0, { alt: true, during: guideCount });
[A, B] = await rects();
check("按住 Alt：不吸附、沒有對齊線", Math.abs(B.l - (A.l + 3)) < 1.5 && mid === 0, `B.left=${B.l}（A.left+3=${A.l + 3}），線 ${mid}`);

// 4) 對齊標籤中心線（水平中心 = 240、垂直中心 = 120）
await place(1, 300, 160); await sleep(100);
[A, B] = await rects();
mid = await drag(1, 240 - (B.l + B.w / 2) + 2, 0, { during: guideCount });
[A, B] = await rects();
check("靠近標籤水平中心線 → 吸附到中心", Math.abs(B.l + B.w / 2 - 240) < 0.01 && mid >= 1, `中心 ${B.l + B.w / 2}`);

// 5) 同時吸附兩個方向（對齊 A 的左邊與上邊）
await place(1, 300, 160); await sleep(100);
[A, B] = await rects();
mid = await drag(1, A.l - 2 - B.l, A.t + 3 - B.t, { during: async () => { await t.shot("2-during"); return guideCount(); } });
[A, B] = await rects();
check("左右、上下同時吸附（橫豎各一條線）", Math.abs(B.l - A.l) < 0.01 && Math.abs(B.t - A.t) < 0.01 && mid >= 2, `線 ${mid}`);

// 6) 對齊後的存檔位置與復原
check("拖曳後標籤顯示有未儲存的變更", await ev("document.getElementById('tpl-name').classList.contains('dirty')"));

// 7) 「檢視 → 對齊線」可關閉，並記住
await ev("document.getElementById('menu-view').click()"); await sleep(200);
const viewItems = await ev("JSON.stringify([...document.querySelectorAll('#ctx-menu > .menu > li')].map(e => e.textContent.trim()))").then(JSON.parse);
check("「檢視」選單有「對齊線」並打勾", viewItems.some((s) => s.startsWith("對齊線") && s.endsWith("✓")), JSON.stringify(viewItems));
await ev("[...document.querySelectorAll('#ctx-menu > .menu > li')].find(e => e.textContent.startsWith('對齊線'))?.click()"); await sleep(200);
check("關閉後記在 localStorage", (await ev("localStorage.getItem('label-printer.guides')")) === "off");
await place(1, 300, 160); await sleep(100);
[A, B] = await rects();
mid = await drag(1, A.l + 3 - B.l, 0, { during: guideCount });
[A, B] = await rects();
check("關閉對齊線後拖曳不吸附、沒有線", Math.abs(B.l - (A.l + 3)) < 1.5 && mid === 0, `B.left=${B.l}，線 ${mid}`);
await ev("document.getElementById('menu-view').click()"); await sleep(200);
const viewItems2 = await ev("JSON.stringify([...document.querySelectorAll('#ctx-menu > .menu > li')].map(e => e.textContent.trim()))").then(JSON.parse);
check("關閉後選單不再打勾", viewItems2.some((s) => s.startsWith("對齊線") && !s.endsWith("✓")), JSON.stringify(viewItems2));
await ev("[...document.querySelectorAll('#ctx-menu > .menu > li')].find(e => e.textContent.startsWith('對齊線'))?.click()"); await sleep(200);
check("再選一次重新開啟", (await ev("localStorage.getItem('label-printer.guides')")) === "on");

// 8) 對齊線不是標籤物件：不會被列入物件數、存檔
check("對齊線不算標籤上的物件", (await ev("window.__lp.count()")) === 2);
await t.shot("1-guides");
await t.finish();
