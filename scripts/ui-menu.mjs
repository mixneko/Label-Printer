// 回歸測試：右鍵選單與「屬性」對話框（複製貼上、位置/大小/對齊、鎖定大小、鎖定）。
// 需要開發模式的除錯介面（window.__lp）。用法（先在另一個視窗執行 `npx vite --port 1420 --strictPort`）：
//   node scripts/ui-menu.mjs [輸出資料夾=.tools] [標籤=samples/範例標籤.lpxl]
// 結果以 PASS / FAIL 列出；截圖放在「輸出資料夾\shots\menu-*.png」。有任何 FAIL 時結束代碼為 1。
import { spawn } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { devServer, freePort } from "./_dev-server.mjs";

const SCRATCH = resolve(process.argv[2] ?? ".tools");
const TPL = readFileSync(process.argv[3] ?? "samples/範例標籤.lpxl", "utf8");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT = `${SCRATCH}\\shots`; mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 等到畫面真的準備好（標籤畫布已建立）；固定等待幾秒在開發伺服器第一次提供模組較慢時不可靠
const waitReady = async () => { for (let i = 0; i < 60; i++) { await sleep(250); if (await ev("!!document.querySelector('#stage canvas')").catch(() => false)) break; } await sleep(400); };const server = await devServer(); // 沒指定 VITE_URL 時由腳本自己啟動 Vite，結束時只關閉自己啟動的那一個
const URL = server.url;
const DEBUG_PORT = await freePort();
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${SCRATCH}\\edge4`, "--hide-scrollbars", "--no-first-run", "about:blank"], { stdio: "ignore" });
let page;
for (let i = 0; i < 40 && !page; i++) { await sleep(500); try { page = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()).find((t) => t.type === "page"); } catch { /* wait */ } }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log("JS 例外:", r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text); return r.result?.result?.value; };
const shot = async (name, clip) => { const r = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) }); writeFileSync(`${OUT}\\menu-${name}.png`, Buffer.from(r.result.data, "base64")); };

let fails = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "　" + detail : ""}`); if (!ok) fails++; };
const near = (a, b, eps = 0.6) => Math.abs(a - b) <= eps;

const MOCK = `window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd, args) => {
  if (cmd === 'list_printers') return ['TSC'];
  if (cmd === 'list_fonts') return ['Microsoft JhengHei', 'Bodoni MT Black'];
  if (cmd === 'plugin:dialog|open') return 'D:\\\\t.json';
  if (cmd === 'plugin:dialog|ask') return true;
  if (cmd === 'read_text_file') return ${JSON.stringify(TPL)};
  return null; } };`;
await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK });
await send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
await send("Page.navigate", { url: URL });
await waitReady();
// 檔案選單 → 開啟舊檔…
await ev("document.getElementById('file-menu').click()"); await sleep(250);
await ev("Array.from(document.querySelectorAll('#ctx-menu li')).find(l => l.querySelector(':scope > .label')?.textContent === '開啟舊檔…').click()");
await sleep(2500);

// ---- 工具函式 ----
const origin = () => ev(`(() => { const r = document.querySelector('#stage .konvajs-content').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
const node = async () => JSON.parse(await ev("JSON.stringify(window.__lp.node())"));
const count = () => ev("window.__lp.count()");
const menuVisible = () => ev("(() => { const m = document.getElementById('ctx-menu'); return !!m && !m.hidden; })()");
const menuTexts = () => ev("Array.from(document.querySelectorAll('#ctx-menu .menu:not(.sub) > li .label')).map(l => l.textContent)");
const rightClickAt = async (x, y) => {
  await ev(`(() => { window.__cmPrevented = undefined; document.addEventListener('contextmenu', (e) => { window.__cmPrevented = e.defaultPrevented; }, { once: true }); })()`);
  // 對 Konva 的內容層送出真正的 contextmenu 事件（與瀏覽器右鍵放開時送出的相同）
  await ev(`(() => { const el = document.elementFromPoint(${x}, ${y}); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y}, button: 2 })); })()`);
  await sleep(250);
};
const rightClickElement = async (i) => { const o = await origin(); const p = JSON.parse(await ev(`JSON.stringify(window.__lp.pt(${i}))`)); await rightClickAt(o.x + p.x, o.y + p.y); };
const clickMenu = async (text) => { const ok = await ev(`(() => { const li = Array.from(document.querySelectorAll('#ctx-menu li')).find(l => l.querySelector(':scope > .label')?.textContent === ${JSON.stringify(text)}); if (!li || li.classList.contains('disabled')) return false; li.click(); return true; })()`); await sleep(250); return ok; };
const setField = async (idName, v) => { await ev(`(() => { const i = document.getElementById(${JSON.stringify(idName)}); i.value = ${JSON.stringify(String(v))}; i.dispatchEvent(new Event('change', { bubbles: true })); })()`); await sleep(150); };
const clickBtn = async (sel) => { await ev(`document.querySelector(${JSON.stringify(sel)}).click()`); await sleep(200); };
const alignBtn = (label) => ev(`(() => { const b = Array.from(document.querySelectorAll('#pp-align button')).find(x => x.textContent === ${JSON.stringify(label)}); b.click(); return true; })()`).then(() => sleep(200));

const N0 = await count();
console.log(`範本載入：${N0} 個物件`);

// ---- 1. 右鍵：自訂選單取代瀏覽器預設選單 ----
await rightClickElement(0); // 範例標籤的標題文字
check("右鍵物件 → 顯示自訂選單", await menuVisible());
check("右鍵物件 → 已阻止瀏覽器預設選單", (await ev("window.__cmPrevented")) === true);
const texts = await menuTexts();
check("選單包含 剪下/複製/貼上/重複/排列/鎖定/隱藏/刪除/屬性", ["剪下", "複製", "貼上", "重複", "排列", "鎖定", "隱藏", "刪除", "屬性…"].every((t) => texts.includes(t)), texts.join("、"));
check("右鍵會選取該物件", (await node()) !== null);
// 用真正的滑鼠移動測試子選單：移到「排列」→ 展開 → 橫向移進子選單 → 仍然展開
const center = (sel) => ev(`JSON.stringify((() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })())`).then(JSON.parse);
const mouseTo = (x, y) => send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
const subShown = () => ev("getComputedStyle(document.querySelector('#ctx-menu li.has-sub > .sub')).display === 'block'");
const c0 = await center("#ctx-menu li.has-sub");
await mouseTo(c0.x, c0.y); await sleep(200);
check("滑鼠移到「排列」→ 子選單展開", await subShown());
const sub0 = await center("#ctx-menu li.has-sub > .sub > li:first-child");
let hoverOk = true;
for (let k = 1; k <= 12; k++) { await mouseTo(c0.x + ((sub0.x - c0.x) * k) / 12, c0.y + ((sub0.y - c0.y) * k) / 12); await sleep(30); hoverOk = hoverOk && (await subShown()); }
check("滑鼠由「排列」移進子選單的過程中，子選單不會收起", hoverOk);
// 選單靠近視窗下緣時，子選單要推上來，整個都看得到
await ev("document.querySelector('#ctx-menu').style.top = (window.innerHeight - 150) + 'px'"); await sleep(100);
const c1 = await center("#ctx-menu li.has-sub");
await mouseTo(c1.x, c1.y + 40); await sleep(100); await mouseTo(c1.x, c1.y); await sleep(250);
const subRect = JSON.parse(await ev("JSON.stringify(document.querySelector('#ctx-menu li.has-sub > .sub').getBoundingClientRect())"));
const winH = await ev("window.innerHeight");
check("選單在視窗下緣時，子選單不會超出視窗", subRect.bottom <= winH && subRect.top >= 0, `子選單 ${Math.round(subRect.top)}–${Math.round(subRect.bottom)}／視窗高 ${winH}`);
await ev("document.querySelector('#ctx-menu').style.top = '120px'"); await sleep(100);
const m = JSON.parse(await ev(`JSON.stringify((() => { const r = document.querySelector('#ctx-menu').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width + 230, height: r.height + 10 }; })())`));
await shot("1-context", { x: Math.max(0, m.x - 10), y: Math.max(0, m.y - 10), width: Math.min(m.width + 20, 700), height: m.height + 20, scale: 1 });

// ---- 2. 複製 / 貼上 / 重複 / 剪下 / 刪除 ----
await clickMenu("複製");
await rightClickElement(0);
check("複製後「貼上」可用", !(await ev(`document.querySelector('#ctx-menu li.disabled .label')?.textContent === '貼上'`)));
await clickMenu("貼上");
check("貼上 → 物件數 +1", (await count()) === N0 + 1, `${N0} → ${await count()}`);
const pasted = await node();
await rightClickElement(0);
await clickMenu("重複");
check("重複 → 物件數 +1", (await count()) === N0 + 2);
const last = await node();
await clickBtn("#delete");
check("刪除 → 物件數 -1", (await count()) === N0 + 1);
// 剪下最後一個
await ev(`document.querySelectorAll('#layer-list li')[0].click()`); await sleep(150);
await ev(`document.querySelectorAll('#layer-list li')[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1300, clientY: 170, button: 2 }))`); await sleep(250);
check("圖層清單的右鍵也能開選單", await menuVisible());
await clickMenu("剪下");
check("剪下 → 物件數 -1", (await count()) === N0, `${await count()}`);
// 空白處：在標籤範圍內找一個沒有物件的點（範例標籤內容變動時不必改座標）
const so = await origin();
const sz = JSON.parse(await ev("JSON.stringify((() => { const r = document.querySelector('#stage .konvajs-content').getBoundingClientRect(); return { w: r.width, h: r.height }; })())"));
let blankTexts = [];
for (const fy of [0.97, 0.9, 0.5, 0.1]) for (const fx of [0.98, 0.5, 0.02, 0.75, 0.25]) {
  await rightClickAt(so.x + sz.w * fx, so.y + sz.h * fy);
  blankTexts = await menuTexts();
  if (JSON.stringify(blankTexts) === JSON.stringify(["貼上"])) break;
  await ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
}
check("空白處右鍵只有「貼上」", JSON.stringify(blankTexts) === JSON.stringify(["貼上"]), blankTexts.join("、"));
await clickMenu("貼上");
check("從空白處貼上 → 物件數 +1", (await count()) === N0 + 1);
await clickBtn("#delete");

// ---- 3. 屬性：位置 ----
await rightClickElement(1); // 分隔線（矩形）
await clickMenu("屬性…");
check("屬性對話框開啟", await ev("document.getElementById('props-dialog').open"));
await shot("2-props");
await setField("pp-x", 10); await setField("pp-y", 12.5);
let n = await node();
check("X=10mm → 外框左緣 80 dots", near(n.bbox.x, 80), `bbox.x=${n.bbox.x.toFixed(2)}`);
check("Y=12.5mm → 外框上緣 100 dots", near(n.bbox.y, 100), `bbox.y=${n.bbox.y.toFixed(2)}`);

// ---- 4. 屬性：大小（矩形不鎖縱橫比）----
n = await node();
check("矩形預設不鎖定縱橫比", n.ratio === false);
await setField("pp-w", 30); // 30mm = 240 dots
n = await node();
check("寬 30mm → 240 dots，高度不變", near(n.w * Math.abs(n.sx), 240) && near(n.h * Math.abs(n.sy), 2), `w=${(n.w * n.sx).toFixed(1)} h=${(n.h * n.sy).toFixed(1)}`);
await clickBtn("#pp-ratio"); // 鎖定縱橫比
await setField("pp-h", 1); // 1mm = 8 dots；寬應依 240:2 比例變成 960
n = await node();
check("鎖定縱橫比後改高度 → 寬同比例連動", n.ratio === true && near(n.h * n.sy, 8) && near(n.w * n.sx, 960, 2), `w=${(n.w * n.sx).toFixed(1)} h=${(n.h * n.sy).toFixed(1)}`);
await clickBtn("#pp-ratio");

// ---- 5. 對齊標籤 ----
await setField("pp-w", 20); // 160 dots
await alignBtn("水平置中");
n = await node();
check("水平置中 → 中心在 240 dots", near(n.bbox.x + n.bbox.width / 2, 240), `中心=${(n.bbox.x + n.bbox.width / 2).toFixed(2)}`);
await alignBtn("靠右");
n = await node();
check("靠右 → 右緣在 480 dots", near(n.bbox.x + n.bbox.width, 480), `右緣=${(n.bbox.x + n.bbox.width).toFixed(2)}`);
await alignBtn("靠左");
n = await node();
check("靠左 → 左緣在 0", near(n.bbox.x, 0));
await alignBtn("垂直置中");
n = await node();
check("垂直置中 → 中心在 120 dots", near(n.bbox.y + n.bbox.height / 2, 120), `中心=${(n.bbox.y + n.bbox.height / 2).toFixed(2)}`);
await alignBtn("靠下"); n = await node();
check("靠下 → 下緣在 240 dots", near(n.bbox.y + n.bbox.height, 240));
await alignBtn("靠上"); n = await node();
check("靠上 → 上緣在 0", near(n.bbox.y, 0));

// ---- 5b. 圖層面板的對齊按鈕（靠左／置中／靠右對齊標籤）----
await setField("pp-w", 20); await alignBtn("靠左");
await clickBtn("#align-center"); n = await node();
check("圖層面板「置中對齊」→ 中心在 240 dots", near(n.bbox.x + n.bbox.width / 2, 240), `中心=${(n.bbox.x + n.bbox.width / 2).toFixed(2)}`);
await clickBtn("#align-right"); n = await node();
check("圖層面板「靠右對齊」→ 右緣在 480 dots", near(n.bbox.x + n.bbox.width, 480));
await clickBtn("#align-left"); n = await node();
check("圖層面板「靠左對齊」→ 左緣在 0", near(n.bbox.x, 0));
check("有選取物件時對齊按鈕可按", !(await ev("document.getElementById('align-left').disabled")));

// ---- 6. 旋轉、名稱、鎖定大小、隱藏 ----
await setField("pp-rot", 90); n = await node();
check("旋轉 90 度", near(n.rotation, 90));
await setField("pp-rot", 0);
await setField("pp-name", "分隔線");
n = await node(); check("名稱可自訂", n.label === "分隔線");
const layerNames = await ev(`Array.from(document.querySelectorAll('#layer-list .name')).map(x => x.textContent)`);
check("圖層清單顯示自訂名稱", layerNames.includes("分隔線"));
await clickBtn("#pp-sizelock");
n = await node();
check("鎖定大小 → 縮放控制點停用", n.sizeLocked === true && n.resizeEnabled === false);
check("鎖定大小 → 寬高欄位停用", await ev(`document.getElementById('pp-w').disabled && document.getElementById('pp-h').disabled`));
await clickBtn("#pp-sizelock");
n = await node(); check("取消鎖定大小 → 恢復", n.sizeLocked === false && n.resizeEnabled === true);
await clickBtn("#pp-close");
check("按「關閉」關閉對話框", !(await ev("document.getElementById('props-dialog').open")));

// ---- 7. 鎖定 / 隱藏（選單）----
await rightClickElement(0); // 較大的文字物件，點得準
await clickMenu("鎖定");
n = await node();
check("選單「鎖定」→ 取消選取（鎖定後畫布上點不到）", n === null);
await ev(`document.querySelectorAll('#layer-list li.locked')[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1300, clientY: 200, button: 2 }))`); await sleep(250);
const lockedTexts = await menuTexts();
check("鎖定物件的選單只有 複製/貼上/解除鎖定/屬性", JSON.stringify(lockedTexts) === JSON.stringify(["複製", "貼上", "解除鎖定", "屬性…"]), lockedTexts.join("、"));
await clickMenu("解除鎖定");
check("解除鎖定後可再選取", (await ev("document.querySelectorAll('#layer-list li.locked').length")) === 0);

// ---- 8. QR：屬性對話框（寬高連動、固定正方形）----
await clickBtn("#add-qr");
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true }))`); await sleep(300);
check("Alt+Enter 開啟屬性", await ev("document.getElementById('props-dialog').open"));
check("QR 的縱橫比鎖定且不可更改", await ev(`document.getElementById('pp-ratio').checked && document.getElementById('pp-ratio').disabled`));
await setField("pp-w", 12); // 96 dots
n = await node();
check("QR 寬 12mm → 96 dots（正方形）", n.qrSize === 96, `qrSize=${n.qrSize}`);
check("QR 高度欄位同步為 12", (await ev("document.getElementById('pp-h').value")) === "12");
await shot("3-props-qr");
await clickBtn("#pp-close");

// ---- 9. 對話框開啟時，Delete 不會刪到後面的物件 ----
await clickBtn("#add-text");
const before = await count();
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true }))`); await sleep(300);
await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`); await sleep(200);
check("屬性對話框開啟時按 Delete → 不會刪除物件", (await count()) === before, `${before} → ${await count()}`);
await clickBtn("#pp-close");
await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`); await sleep(200);
check("關閉對話框後按 Delete → 刪除選取的物件", (await count()) === before - 1, `${before} → ${await count()}`);
console.log(`\n${fails === 0 ? "全部通過" : fails + " 項失敗"}`);
ws.close(); edge.kill(); await server.stop();
process.exit(fails === 0 ? 0 : 1);
