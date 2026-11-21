// 回歸測試：畫布縮放（Ctrl＋滾輪、縮放按鈕、檢視選單、快捷鍵），縮放只影響顯示、不影響列印。
//   node scripts/ui-zoom.mjs [輸出資料夾=.tools]
import { launch } from "./_cdp.mjs";
const MOCK = `(() => {
  window.__jobs = [];
  window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd, args) => {
    if (cmd === 'list_printers') return ['TSC TTP-244 Pro']; if (cmd === 'list_fonts') return ['Arial'];
    if (cmd === 'print_labels') { window.__jobs.push(args); return null; }
    return null; } };
})();`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "zoom" });
const { ev, sleep, check } = t;
await ev("localStorage.setItem('label-printer.settings', JSON.stringify({ setupDone: true, printerMode: 'windows', printerName: 'TSC TTP-244 Pro', printerLang: 'tspl' }))");
await t.reload(); await sleep(700);

const pct = () => ev("document.getElementById('zoom-label').textContent").then((s) => parseInt(s));
const stageW = () => ev("Math.round(document.getElementById('stage').getBoundingClientRect().width)");
const wheel = (deltaY) => ev(`(() => { const w = document.querySelector('.canvas-wrap'); const r = w.getBoundingClientRect(); w.dispatchEvent(new WheelEvent('wheel', { deltaY: ${deltaY}, ctrlKey: true, bubbles: true, cancelable: true, clientX: r.x + 50, clientY: r.y + 50 })); })()`);
const key = (k) => ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, ctrlKey: true, bubbles: true, cancelable: true }))`);
const click = (id) => ev(`document.getElementById('${id}').click()`);

const fit = await pct(); const w0 = await stageW();
check("預設是符合視窗：顯示倍率標示（50%～300%）", fit >= 50 && fit <= 300, `${fit}%`);
await click("zoom-in"); await sleep(150);
const p1 = await pct();
check("按「放大」：倍率變大、畫布變寬", p1 > fit && (await stageW()) > w0, `${fit}% → ${p1}%`);
await click("zoom-out"); await click("zoom-out"); await sleep(150);
const p2 = await pct();
check("按兩次「縮小」：倍率比一開始小、畫布變窄", p2 < fit && (await stageW()) < w0, `${p2}%`);
await wheel(-100); await sleep(100);
const p3 = await pct();
check("Ctrl＋滾輪往上：放大", p3 > p2, `${p2}% → ${p3}%`);
await wheel(100); await wheel(100); await sleep(100);
check("Ctrl＋滾輪往下：縮小", (await pct()) < p3);
await ev("(() => { const w = document.querySelector('.canvas-wrap'); w.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })); })()"); await sleep(100);
const before = await pct();
await ev("(() => { const w = document.querySelector('.canvas-wrap'); w.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })); })()"); await sleep(100);
check("沒按 Ctrl 的滾輪不縮放（維持捲動）", (await pct()) === before);
await key("0"); await sleep(150);
check("Ctrl+0：回到符合視窗", (await pct()) === fit && (await stageW()) === w0, `${await pct()}%`);
await key("1"); await sleep(150);
check("Ctrl+1：實際大小 100%", (await pct()) === 100 && (await stageW()) === Math.round(60 * 8), `${await pct()}% ${await stageW()}px`);
await key("="); await sleep(100);
check("Ctrl＋加號：放大", (await pct()) > 100);
await key("-"); await key("-"); await sleep(100);
check("Ctrl＋減號：縮小", (await pct()) < 100);
for (let i = 0; i < 30; i++) await click("zoom-in");
await sleep(150);
check("放大有上限（800%）", (await pct()) === 800, `${await pct()}%`);
for (let i = 0; i < 40; i++) await click("zoom-out");
await sleep(150);
check("縮小有下限（25%）", (await pct()) === 25, `${await pct()}%`);

// 縮放後仍可正常選取、不影響列印
await key("1"); await sleep(150);
await ev("document.getElementById('add-text').click()"); await sleep(300);
check("縮放後新增物件仍可選取", (await ev("window.__lp.count()")) >= 1);
const bytesAt = async () => { await ev("window.__jobs.length = 0; document.getElementById('print').click()"); await sleep(700); return ev("window.__jobs[0] ? window.__jobs[0].jobs[0].bitmap.length : -1"); };
const b100 = await bytesAt();
await key("0"); await sleep(150);
const bFit = await bytesAt();
for (let i = 0; i < 5; i++) await click("zoom-in");
await sleep(150);
const bBig = await bytesAt();
check("列印的點陣大小與縮放無關（100%、符合視窗、放大都相同）", b100 > 0 && b100 === bFit && bFit === bBig, `${b100} / ${bFit} / ${bBig}`);

// 檢視選單
await ev("document.getElementById('menu-view').click()"); await sleep(250);
const items = await ev("[...document.querySelectorAll('[role=menuitem]')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim()).join('|')");
check("「檢視」選單有放大、縮小、符合視窗、實際大小", ["放大", "縮小", "符合視窗", "實際大小 (100%)"].every((x) => items.includes(x)), items);
await ev("[...document.querySelectorAll('[role=menuitem]')].find((e) => e.textContent.includes('符合視窗')).click()"); await sleep(200);
check("選單「符合視窗」", (await pct()) === fit);
await ev("document.getElementById('zoom-label').click()"); await sleep(100);
await click("zoom-in"); await sleep(100);
await click("zoom-label"); await sleep(150);
check("按倍率標示：回到符合視窗", (await pct()) === fit);
await t.shot("fit");
await t.finish();
