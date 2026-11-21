// 回歸測試：只有圖示（沒有可見文字）的按鈕都要有滑鼠懸停說明（title 或 aria-label），各語言與窄視窗都一樣。
//   node scripts/ui-tooltips.mjs
import { launch } from "./_cdp.mjs";
const MOCK = `window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd) => {
  if (cmd === 'list_printers') return ['TSC']; if (cmd === 'list_fonts') return ['Microsoft JhengHei'];
  return null; } };`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "tooltips" });
const { ev, sleep, check } = t;

// 找出「看得到、但畫面上沒有任何文字」的按鈕：文字被 CSS 隱藏（font-size:0 / 窄視窗的 .lbl）或本來就只有圖示
const audit = () => ev(`JSON.stringify((() => {
  const out = [];
  for (const b of document.querySelectorAll('button')) {
    const r = b.getBoundingClientRect();
    if (!r.width || !r.height) continue;                       // 看不到的不算
    const cs = getComputedStyle(b);
    let visibleText = '';
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) { if (parseFloat(getComputedStyle(n).fontSize) > 0) visibleText += c.textContent; }
        else if (c.nodeType === 1 && c.tagName.toLowerCase() !== 'svg') {
          const s = getComputedStyle(c); if (s.display !== 'none' && s.visibility !== 'hidden') walk(c);
        }
      }
    };
    walk(b);
    if (visibleText.trim()) continue;                          // 有文字的按鈕不用提示
    const tip = (b.getAttribute('title') || b.getAttribute('aria-label') || '').trim();
    if (!tip) out.push(b.id || b.className || b.outerHTML.slice(0, 60));
  }
  return out;
})())`).then(JSON.parse);

for (const [lang, width] of [["zh-TW", 1280], ["en", 1280], ["de", 1280], ["ja", 1280], ["ko", 1280], ["zh-TW", 1000]]) {
  await ev(`window.__lp.i18n.changeLang('${lang}')`);
  await t.send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const missing = await audit();
  check(`${lang}／${width}px：只有圖示的按鈕都有懸停說明`, missing.length === 0, missing.join("、"));
}
// 檢查本身要有效：拿掉一顆圖示按鈕的說明，必須被抓出來
await ev("window.__lp.i18n.changeLang('en')"); await sleep(300);
await ev("document.getElementById('align-left').removeAttribute('title')");
check("檢查有效：拿掉對齊按鈕的說明會被抓到", (await audit()).includes("align-left"));
// ---- 自訂提示：真實滑鼠停在按鈕上 → 出現說明；移開 → 消失且 title 還原 ----
await ev("window.__lp.i18n.changeLang('zh-TW')"); await sleep(300);
const c = await ev(`JSON.stringify((() => { const r = document.getElementById('add-barcode').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })())`).then(JSON.parse);
await t.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 }); await sleep(100);
await t.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.x, y: c.y }); await sleep(100);
check("剛移上去還沒出現（有延遲）", !(await ev("document.getElementById('tooltip')?.matches(':popover-open') ?? false")));
await sleep(600);
check("停留後出現說明，內容是 title（新增條碼）", (await ev("document.getElementById('tooltip')?.matches(':popover-open')")) && (await ev("document.getElementById('tooltip').textContent")) === "新增條碼");
check("顯示期間原生 title 暫時收起（避免重複出現）", (await ev("document.getElementById('add-barcode').hasAttribute('title')")) === false);
const box = await ev("JSON.stringify(document.getElementById('tooltip').getBoundingClientRect())").then(JSON.parse);
check("提示在視窗內、在按鈕下方", box.left >= 0 && box.right <= 1280 && box.top > c.y, JSON.stringify(box));
await t.shot("tooltip");
await t.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 400 }); await sleep(200);
check("移開後提示消失、title 還原", !(await ev("document.getElementById('tooltip').matches(':popover-open')")) && (await ev("document.getElementById('add-barcode').getAttribute('title')")) === "新增條碼");
// 按下去也要立刻收起
await t.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.x, y: c.y }); await sleep(700);
await t.send("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", buttons: 1, clickCount: 1 });
await t.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", buttons: 0, clickCount: 1 }); await sleep(200);
check("按下按鈕 → 提示立刻收起、title 還原", !(await ev("document.getElementById('tooltip').matches(':popover-open')")) && (await ev("document.getElementById('add-barcode').getAttribute('title')")) === "新增條碼");
await t.finish();
