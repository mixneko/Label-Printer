// 回歸測試：側邊面板寬度可拖曳調整、雙擊還原、鍵盤調整，重開後沿用；面板隱藏時把手也隱藏。
//   node scripts/ui-panelwidth.mjs [輸出資料夾=.tools]
import { launch } from "./_cdp.mjs";
const MOCK = `(() => {
  window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd) => {
    if (cmd === 'list_printers') return ['TSC']; if (cmd === 'list_fonts') return ['Arial'];
    return null; } };
})();`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "panelwidth" });
const { ev, sleep, check, send } = t;
const width = () => ev("Math.round(document.querySelector('aside.panel').getBoundingClientRect().width)");
const grip = () => ev("(() => { const r = document.getElementById('panel-resizer').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()");
const mouse = (type, x, y) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, pointerType: "mouse" });
const drag = async (dx) => {
  const g = await grip();
  await mouse("mouseMoved", g.x, g.y);
  await mouse("mousePressed", g.x, g.y);
  for (let i = 1; i <= 6; i++) { await mouse("mouseMoved", g.x + (dx * i) / 6, g.y); await sleep(20); }
  await mouse("mouseReleased", g.x + dx, g.y);
  await sleep(150);
};
const key = async (k) => { await ev("document.getElementById('panel-resizer').focus()"); await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: k === "ArrowLeft" ? 37 : 39 }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k }); await sleep(120); };

check("預設寬度 320", (await width()) === 320, String(await width()));
const g0 = await grip();
check("把手存在、可見、位在畫布與面板之間", g0.w > 0 && g0.h > 0 && g0.x < (await ev("document.querySelector('aside.panel').getBoundingClientRect().x + 6")));

await drag(-100);
check("往左拖 100 px → 變寬 420", (await width()) === 420, String(await width()));
await drag(60);
check("往右拖 60 px → 變窄 360", (await width()) === 360, String(await width()));
await drag(-1000);
check("拖到極限 → 上限 560", (await width()) === 560, String(await width()));
await drag(1000);
check("拖到另一端 → 下限 240", (await width()) === 240, String(await width()));

await ev("document.getElementById('panel-resizer').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))"); await sleep(120);
check("雙擊 → 還原 320", (await width()) === 320, String(await width()));
await key("ArrowLeft");
check("鍵盤 ← → 變寬 24（344）", (await width()) === 344, String(await width()));
await key("ArrowRight"); await key("ArrowRight");
check("鍵盤 → 兩次 → 變窄 48（296）", (await width()) === 296, String(await width()));

await drag(-80);
const w1 = await width();
await ev("location.reload()"); await sleep(2000);
check("重新載入後沿用上次的寬度", (await width()) === w1, `${await width()} / ${w1}`);

await ev("localStorage.setItem('label-printer.panelWidth', '99999')"); await ev("location.reload()"); await sleep(2000);
check("儲存的寬度離譜（99999）→ 夾在上限內", (await width()) <= 560, String(await width()));
await ev("localStorage.setItem('label-printer.panelWidth', 'abc')"); await ev("location.reload()"); await sleep(2000);
check("儲存的值不是數字 → 用預設 320", (await width()) === 320, String(await width()));

await ev("document.querySelector('aside.panel').hidden = true"); await sleep(100);
check("面板隱藏時把手也隱藏", (await ev("getComputedStyle(document.getElementById('panel-resizer')).display")) === "none");
await ev("document.querySelector('aside.panel').hidden = false");
check("無障礙：把手是垂直分隔線且可用鍵盤聚焦", (await ev("(() => { const g = document.getElementById('panel-resizer'); return g.getAttribute('role') === 'separator' && g.getAttribute('aria-orientation') === 'vertical' && g.tabIndex === 0 && !!g.title; })()")));

await t.shot("panel");
await t.finish();
