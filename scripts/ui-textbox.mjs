// 回歸測試：文字的「最大範圍」（超出範圍時自動縮小字級）。
//   node scripts/ui-textbox.mjs [輸出資料夾=.tools]      （腳本會自己啟動並關閉 Vite）
import { launch } from "./_cdp.mjs";

const MOCK = `
window.__files = {}; window.__savePath = null; window.__pick = null;
window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd, args) => {
  if (cmd === 'list_printers') return ['TSC'];
  if (cmd === 'list_fonts') return ['Microsoft JhengHei'];
  if (cmd === 'plugin:dialog|open') return window.__pick;
  if (cmd === 'plugin:dialog|save') return window.__savePath;
  if (cmd === 'plugin:dialog|message') return args.buttons.OkCancelCustom[0];
  if (cmd === 'read_text_file') { if (!(args.path in window.__files)) throw 'no file'; return window.__files[args.path]; }
  if (cmd === 'write_text_file') { window.__files[args.path] = args.content; return null; }
  if (cmd === 'print_labels') return null;
  return null; } };`;

const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "textbox" });
const { ev, sleep, check } = t;

const info = async () => JSON.parse(await ev("JSON.stringify(window.__lp.text())"));
const setContent = async (v) => { await ev(`(() => { const x = document.getElementById('prop-text'); x.value = ${JSON.stringify(v)}; x.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(150); };
const setCtl = async (id, v, evt = "change") => { await ev(`(() => { const x = document.getElementById(${JSON.stringify(id)}); x.value = ${JSON.stringify(String(v))}; x.dispatchEvent(new Event(${JSON.stringify(evt)}, { bubbles: true })); })()`); await sleep(150); };
const setBounded = async (on) => { await ev(`(() => { const c = document.getElementById('prop-bounded'); c.checked = ${on}; c.dispatchEvent(new Event('change', { bubbles: true })); })()`); await sleep(200); };
const openProps = async () => { await ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true }))"); await sleep(300); };
const closeProps = async () => { await ev("document.getElementById('pp-close').click()"); await sleep(150); };
const nodeInfo = async () => JSON.parse(await ev("JSON.stringify(window.__lp.node())"));
const LONG = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"; // 在小框裡縮到最小字級都放不進
const MID = "ABCDEFGH"; // 需要縮小，但縮到某個字級就放得進（範圍約 79 dots 時）

// ---------- 1. 啟用最大範圍 ----------
await ev("document.getElementById('add-text').click()"); await sleep(300);
await setContent("ABC");
await setCtl("prop-size", 40, "input");
let x = await info();
check("一般文字：字級 40，未啟用最大範圍", x.fontSize === 40 && x.bounded === false, JSON.stringify({ f: x.fontSize, b: x.bounded }));
check("未啟用時，細項選項隱藏、字級欄位叫「字級」", (await ev("document.getElementById('bounded-opts').hidden")) && (await ev("document.getElementById('prop-size-label').textContent")) === "字級 (dots)");
await setBounded(true);
x = await info();
check("啟用後：以目前文字的大小作為範圍，字級不變", x.bounded && x.boxW > 0 && x.boxH > 0 && x.width === x.boxW && x.height === x.boxH && x.fontSize === 40 && x.baseSize === 40, JSON.stringify(x));
check("預設：自動縮小、最小字級 8、靠左、垂直置中", x.overflow === "shrink" && x.minSize === 8 && x.align === "left" && x.valign === "middle");
check("啟用後：細項選項出現，字級欄位改叫「最大字級」", !(await ev("document.getElementById('bounded-opts').hidden")) && (await ev("document.getElementById('prop-size-label').textContent")) === "最大字級 (dots)");
check("啟用後預設不維持縱橫比（框的寬高可獨立調整）", (await nodeInfo()).ratio === false);
await t.shot("1-enabled");
const boxW = x.boxW;

// ---------- 2. 內容變長 → 縮小；變短 → 恢復 ----------
await setContent(MID);
x = await info();
check("內容太長 → 字級縮小", x.fontSize < 40 && x.fontSize >= 8, `字級 40 → ${x.fontSize}`);
check("縮小後文字寬度放得進範圍", x.textWidth <= boxW + 0.01, `文字寬 ${x.textWidth.toFixed(1)} ≤ 範圍 ${boxW}`);
check("縮小到的是「放得進去的最大字級」（再大一級就放不進）", (x.textWidth / x.fontSize) * (x.fontSize + 1) > boxW, `字級 ${x.fontSize}`);
check("縮小時範圍（文字框）大小不變", x.width === boxW && x.boxW === boxW);
const shrunk = x.fontSize;
await setContent("AB");
x = await info();
check("內容變短 → 字級恢復為設定的最大字級（不會卡在縮小後的大小）", x.fontSize === 40, `字級 ${x.fontSize}`);
await setContent(MID);
check("再變長 → 又縮回同樣的字級", (await info()).fontSize === shrunk);

// ---------- 3. 最小字級、不處理 ----------
await setContent(LONG);
await setCtl("prop-minsize", 30);
x = await info();
check("最小字級 30：再怎麼長也不小於 30", x.fontSize === 30 && x.textWidth > boxW, `字級 ${x.fontSize}，文字寬 ${x.textWidth.toFixed(1)} > 範圍 ${boxW}（到下限仍放不進，維持下限）`);
check("縮到下限仍放不進時，文字完整保留（文字框撐大，不會把字截掉）", x.width >= x.textWidth - 0.01 && x.boxW === boxW, `文字框寬 ${x.width.toFixed(1)} ≥ 文字寬 ${x.textWidth.toFixed(1)}；設定的範圍仍是 ${x.boxW}`);
await setCtl("prop-minsize", 8);
await setCtl("prop-overflow", "none");
x = await info();
check("超出範圍時選「不處理」→ 字級維持最大字級", x.fontSize === 40 && x.overflow === "none", `字級 ${x.fontSize}`);
check("「不處理」：文字完整保留，不會被截掉", x.width >= x.textWidth - 0.01, `文字框寬 ${x.width.toFixed(1)} ≥ 文字寬 ${x.textWidth.toFixed(1)}`);
await setCtl("prop-overflow", "shrink");
check("改回「自動縮小」→ 又縮小到下限", (await info()).fontSize === 8, `字級 ${(await info()).fontSize}`);
await setContent(MID);
check("內容改回較短 → 縮小到放得進的最大字級", (await info()).fontSize === shrunk);

// ---------- 4. 對齊 ----------
await setCtl("prop-align", "center");
await setCtl("prop-valign", "bottom");
x = await info();
check("水平置中、垂直靠下", x.align === "center" && x.valign === "bottom", `${x.align} / ${x.valign}`);
await setCtl("prop-align", "left");
await setCtl("prop-valign", "middle");

// ---------- 5. 屬性對話框用 mm 調整範圍 ----------
await setContent("AB");
await openProps();
check("對話框：有最大範圍的文字，寬高可以編輯", !(await ev("document.getElementById('pp-w').disabled")) && !(await ev("document.getElementById('pp-h').disabled")));
check("對話框：縱橫比選項可用", !(await ev("document.getElementById('pp-ratio').disabled")));
await setCtl("pp-w", 5); // 5 mm = 40 dots
x = await info();
check("寬度 5mm → 範圍 40 dots，文字重新縮小", x.boxW === 40 && x.fontSize < 40 && x.textWidth <= 40.01, `boxW=${x.boxW} 字級=${x.fontSize}`);
await setCtl("pp-w", 30); // 240 dots
x = await info();
check("寬度 30mm → 放得進，字級恢復 40", x.boxW === 240 && x.fontSize === 40, `boxW=${x.boxW} 字級=${x.fontSize}`);
await setCtl("pp-h", 3); // 24 dots：高度不足，字級受限於高度
x = await info();
check("高度也會限制字級（範圍高 24 dots → 字級不超過範圍高度）", x.boxH === 24 && x.textHeight <= 24.01 && x.fontSize < 40, `boxH=${x.boxH} 字級=${x.fontSize} 文字高=${x.textHeight.toFixed(1)}`);
await setCtl("pp-h", 8);
await closeProps();

// ---------- 6. 拖曳邊角：改變的是範圍，不縮放字 ----------
const o = JSON.parse(await ev("JSON.stringify((() => { const r = document.querySelector('#stage .konvajs-content').getBoundingClientRect(); return { x: r.left, y: r.top }; })())"));
const before = await info();
const a = JSON.parse(await ev("JSON.stringify(window.__lp.anchor('bottom-right'))"));
const ax = o.x + a.x, ay = o.y + a.y;
await t.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: ax, y: ay });
await t.send("Input.dispatchMouseEvent", { type: "mousePressed", x: ax, y: ay, button: "left", buttons: 1, clickCount: 1 });
for (let k = 1; k <= 8; k++) { await t.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: ax + (80 * k) / 8, y: ay + (40 * k) / 8 }); await sleep(20); }
await t.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: ax + 80, y: ay + 40, button: "left", buttons: 0, clickCount: 1 });
await sleep(400);
x = await info();
check("拖曳邊角 → 範圍變大，縮放量烘進範圍（scale 回到 1）", x.boxW > before.boxW && x.boxH > before.boxH && x.scaleX === 1 && x.scaleY === 1, `${before.boxW}×${before.boxH} → ${x.boxW}×${x.boxH}`);
check("拖曳邊角不會把字放大（字級仍由最大字級決定）", x.baseSize === 40 && x.fontSize <= 40);

// ---------- 7. 列印時每一張各自計算 ----------
await setContent("{{序號}}");
const designBefore = (await info()).fontSize;
const preview = async (value) => {
  await ev(`(() => { const v = document.getElementById('vars'); v.value = '序號=${value}'; v.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await ev("document.getElementById('preview-btn').click()"); await sleep(500);
  return JSON.parse(await ev("JSON.stringify(window.__lp.renderedSizes())"));
};
const shortSize = (await preview("AB"))[0];
const longSize = (await preview("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGH"))[0];
const mid = (await preview("ABCDEFGHIJ"))[0];
check("內容短的標籤維持最大字級", shortSize === 40, `字級 ${shortSize}`);
check("內容很長的標籤縮得更小", longSize < mid && mid <= shortSize && longSize >= 8, `短 ${shortSize} ≥ 中 ${mid} > 長 ${longSize}`);
check("列印結束後，設計畫面還原為原內容的字級", (await info()).fontSize === designBefore, `${designBefore} → ${(await info()).fontSize}`);
const bmpBlack = async () => ev(`(() => { const c = document.getElementById('preview'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 128) n++; return n; })()`);
await preview("AB"); const blackShort = await bmpBlack();
await preview("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGH"); const blackLong = await bmpBlack();
check("預覽點陣有東西（沒有因縮小而消失）", blackShort > 0 && blackLong > 0, `黑點 ${blackShort} / ${blackLong}`);

// ---------- 8. 存檔再開啟，最大範圍設定要保留 ----------
await setContent("AB");
await setCtl("prop-align", "center");
await setCtl("prop-valign", "bottom");
await setCtl("prop-minsize", 12);
const saved = await info();
await ev("window.__savePath = 'D:\\\\標籤\\\\box.json'");
await ev("document.getElementById('file-menu').click()"); await sleep(200);
await ev("Array.from(document.querySelectorAll('#ctx-menu li')).find(l => l.querySelector(':scope > .label')?.textContent === '另存新檔…').click()"); await sleep(400);
const json = await ev("window.__files['D:\\\\標籤\\\\box.json']");
const el = JSON.parse(json).elements.find((e) => e.kind === "text");
check("存檔內容：包含最大範圍設定，字級存的是「最大字級」", el.bounded === true && el.boxW === saved.boxW && el.boxH === saved.boxH && el.overflow === "shrink" && el.minSize === 12 && el.align === "center" && el.valign === "bottom" && el.fontSize === 40, JSON.stringify({ b: el.bounded, w: el.boxW, h: el.boxH, o: el.overflow, m: el.minSize, a: el.align, v: el.valign, f: el.fontSize }));
check("存檔：不帶縮放（scale = 1）", el.scaleX === 1 && el.scaleY === 1);
await t.reload();
await ev(`window.__files['D:\\\\標籤\\\\box.json'] = ${JSON.stringify(json)}`);
await ev("document.getElementById('file-menu').click()"); await sleep(200);
await ev("Array.from(document.querySelectorAll('#ctx-menu li')).find(l => l.querySelector(':scope > .label')?.textContent.startsWith('1　')).click()"); await sleep(600);
await ev("document.querySelector('#layer-list li').click()"); await sleep(300);
x = await info();
check("重新開啟後最大範圍設定仍在", x.bounded && x.boxW === saved.boxW && x.boxH === saved.boxH && x.align === "center" && x.valign === "bottom" && x.minSize === 12 && x.baseSize === 40, JSON.stringify({ b: x.bounded, w: x.boxW, a: x.align, v: x.valign, m: x.minSize, base: x.baseSize }));
check("重新開啟後，面板的選項值也還原", (await ev("document.getElementById('prop-bounded').checked && document.getElementById('prop-align').value === 'center' && document.getElementById('prop-minsize').value === '12'")));
await setContent(LONG);
check("重新開啟後，內容變長仍會縮小", (await info()).fontSize < 40);

// ---------- 9. 取消最大範圍 ----------
await setBounded(false);
x = await info();
check("取消：恢復一般文字（字級為最大字級、寬度由內容決定）", x.bounded === false && x.fontSize === 40 && Math.abs(x.width - x.textWidth) < 1.5, JSON.stringify({ f: x.fontSize, w: x.width, tw: x.textWidth }));
check("取消後恢復維持縱橫比、選項隱藏、字級欄位改回「字級」", (await nodeInfo()).ratio === true && (await ev("document.getElementById('bounded-opts').hidden")) && (await ev("document.getElementById('prop-size-label').textContent")) === "字級 (dots)");
await openProps();
check("取消後：對話框的寬高回到唯讀（大小由字級決定）", await ev("document.getElementById('pp-w').disabled && document.getElementById('pp-h').disabled"));
await closeProps();

await t.finish();
