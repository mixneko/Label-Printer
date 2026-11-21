// 回歸測試：「檔案」選單（開啟新檔／開啟舊檔／儲存／另存新檔）與「最近開啟的檔案」。
//   node scripts/ui-file.mjs [輸出資料夾=.tools]      （腳本會自己啟動並關閉 Vite）
import { launch } from "./_cdp.mjs";

const MOCK = `
const label = (n) => JSON.stringify({ version: 1, tplWmm: 60, tplHmm: 30, elements: Array.from({ length: n }, (_, i) => ({
  kind: 'rect', x: 10 + i * 20, y: 10, rotation: 0, scaleX: 1, scaleY: 1, width: 15, height: 10, filled: true, strokeWidth: 1 })) });
window.__files = { 'D:\\\\標籤\\\\A.json': label(2), 'D:\\\\標籤\\\\B.json': label(3) };
window.__pick = null; window.__savePath = null; window.__ask = true; window.__asks = []; window.__writes = [];
window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd, args) => {
  if (cmd === 'list_printers') return ['TSC'];
  if (cmd === 'list_fonts') return ['Microsoft JhengHei'];
  if (cmd === 'plugin:dialog|open') return window.__pick;
  if (cmd === 'plugin:dialog|save') return window.__savePath;
  // @tauri-apps/plugin-dialog 的 ask() 實際呼叫 plugin:dialog|message，並以「被按下的按鈕文字」判斷結果（等於 okLabel 才算確定）
  if (cmd === 'plugin:dialog|message') { window.__asks.push(JSON.stringify(args)); const [ok, cancel] = args.buttons.OkCancelCustom; return window.__ask ? ok : cancel; }
  if (cmd === 'read_text_file') { if (!(args.path in window.__files)) throw '系統找不到指定的檔案。'; return window.__files[args.path]; }
  if (cmd === 'write_text_file') { window.__writes.push(args.path); window.__files[args.path] = args.content; return null; }
  return null; } };`;

const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "file" });
const { ev, sleep, check } = t;

const A = "D:\\標籤\\A.json";
const B = "D:\\標籤\\B.json";
const chip = () => ev("document.getElementById('tpl-name').textContent");
const count = () => ev("document.querySelectorAll('#layer-list li:not(.empty)').length");
const status = () => ev("document.getElementById('status').textContent");
const openMenu = async () => { await ev("document.getElementById('file-menu').click()"); await sleep(200); };
const menuLabels = () => ev("Array.from(document.querySelectorAll('#ctx-menu .menu:not(.sub) > li:not(.sep)')).map(l => ({ t: l.querySelector(':scope > .label').textContent, off: l.classList.contains('disabled') }))");
const labelsOnly = async () => (await menuLabels()).map((x) => x.t);
const clickItem = (text) => ev(`(() => { const li = Array.from(document.querySelectorAll('#ctx-menu li')).find(l => l.querySelector(':scope > .label')?.textContent === ${JSON.stringify(text)}); if (!li || li.classList.contains('disabled')) return false; li.click(); return true; })()`).then(async (ok) => { await sleep(350); return ok; });
const clickNth = (n) => ev(`(() => { const li = Array.from(document.querySelectorAll('#ctx-menu li')).find(l => l.querySelector(':scope > .label')?.textContent.startsWith('${n}　')); if (!li) return false; li.click(); return true; })()`).then(async (ok) => { await sleep(350); return ok; });
const recents = async () => (await labelsOnly()).filter((x) => /^\d　/.test(x));
const menuOpen = () => ev("(() => { const m = document.getElementById('ctx-menu'); return !!m && !m.hidden; })()");
const setPick = (p) => ev(`window.__pick = ${JSON.stringify(p)}`);

// ---------- 1. 選單內容 ----------
await openMenu();
let items = await menuLabels();
const names = items.map((x) => x.t);
check("檔案選單有：開啟新檔／開啟舊檔／儲存／另存新檔", ["開啟新檔", "開啟舊檔…", "儲存", "另存新檔…"].every((x) => names.includes(x)), names.join("、"));
check("一開始沒有最近開啟的檔案（停用的提示列）", items.some((x) => x.t === "（沒有最近開啟的檔案）" && x.off));
check("已移除原本工具列上獨立的開啟／儲存／另存新檔按鈕", (await ev("['open-tpl','save-tpl','saveas-tpl'].every(id => !document.getElementById(id))")));
await t.shot("1-menu");

// ---------- 2. 開啟舊檔 → 最近清單 ----------
await setPick(A);
await clickItem("開啟舊檔…");
check("開啟舊檔 A：載入 2 個物件", (await count()) === 2, `count=${await count()}`);
check("工具列顯示檔名 A.json", (await chip()) === "A.json");
await openMenu();
check("最近清單：1　A.json", JSON.stringify(await recents()) === JSON.stringify(["1　A.json"]), (await recents()).join("、"));
await ev("document.getElementById('file-menu').click()"); await sleep(100); // 關閉
await setPick(B);
await openMenu(); await clickItem("開啟舊檔…");
check("開啟舊檔 B：載入 3 個物件", (await count()) === 3);
await openMenu();
check("最近清單依最近使用排序：B 在前、A 在後", JSON.stringify(await recents()) === JSON.stringify(["1　B.json", "2　A.json"]), (await recents()).join("、"));

// ---------- 3. 點最近的檔案：直接開啟，不跳選檔視窗 ----------
await ev("window.__pick = null"); // 若程式又去叫選檔視窗，會得到 null 而什麼都不開
await clickNth(2);
check("點「2　A.json」→ 直接開啟 A（不需再選檔案）", (await count()) === 2 && (await chip()) === "A.json", `count=${await count()} chip=${await chip()}`);
await openMenu();
check("A 移到最前面，不重複", JSON.stringify(await recents()) === JSON.stringify(["1　A.json", "2　B.json"]), (await recents()).join("、"));
const hint = await ev("Array.from(document.querySelectorAll('#ctx-menu li')).find(l => l.querySelector('.label')?.textContent === '1　A.json')?.querySelector('.hint')?.textContent");
check("每個項目右側顯示所在資料夾", hint === "D:\\標籤", hint);
await t.shot("2-recent");
await ev("document.getElementById('file-menu').click()"); await sleep(100);

// ---------- 4. 檔案不見了：提示並從清單移除 ----------
await ev("localStorage.setItem('label-printer.recent', JSON.stringify(['D:\\\\不存在\\\\C.json', 'D:\\\\標籤\\\\A.json']))");
await t.reload();
await openMenu();
check("重新載入後，最近清單仍保留", (await recents()).length === 2);
await clickNth(1);
check("檔案不存在 → 顯示錯誤並說明已移除", (await status()).includes("無法開啟") && (await status()).includes("已從最近開啟記錄移除"), await status());
await openMenu();
check("壞掉的項目已從最近清單移除", JSON.stringify(await recents()) === JSON.stringify(["1　A.json"]), (await recents()).join("、"));
await ev("document.getElementById('file-menu').click()"); await sleep(100);

// ---------- 5. 未儲存的變更：開啟新檔前要詢問 ----------
await t.reload();
await setPick(A);
await openMenu(); await clickItem("開啟舊檔…");
await ev("document.getElementById('add-rect').click()"); await sleep(300); // 新增物件 → 未儲存
check("新增物件後，檔名出現未儲存標記", (await chip()).includes("●"), await chip());
const before = await count();
await ev("window.__ask = false; window.__asks = []");
await openMenu(); await clickItem("開啟新檔");
check("開啟新檔：有未儲存變更時會詢問", (await ev("window.__asks.length")) === 1 && (await ev("window.__asks[0]")).includes("建立新標籤"), (await ev("window.__asks[0]")) ?? "");
check("按「取消」→ 維持原樣", (await count()) === before && (await chip()).startsWith("A.json"), `count=${await count()}`);
await ev("window.__ask = true");
await openMenu(); await clickItem("開啟新檔");
await ev("document.getElementById('new-ok').click()"); await sleep(300); // 新標籤會先問尺寸
check("按「放棄並建立新標籤」→ 清空成空白標籤", (await count()) === 0 && (await chip()) === "未命名標籤", `count=${await count()} chip=${await chip()}`);
check("新檔沒有未儲存標記", !(await chip()).includes("●"));
await ev("window.__asks = []");
await openMenu(); await clickItem("開啟新檔");
await ev("document.getElementById('new-ok').click()"); await sleep(300); // 新標籤會先問尺寸
check("沒有變更時，開啟新檔不再詢問", (await ev("window.__asks.length")) === 0);

// ---------- 6. 另存新檔 → 最近清單 ----------
await ev("document.getElementById('add-rect').click()"); await sleep(300);
await ev("window.__savePath = 'D:\\\\標籤\\\\新的.lpxl'");
await openMenu(); await clickItem("另存新檔…");
check("另存新檔：寫入指定路徑", (await ev("window.__writes.at(-1)")) === "D:\\標籤\\新的.lpxl", await ev("window.__writes.at(-1)"));
check("儲存後檔名更新、未儲存標記消失", (await chip()) === "新的.lpxl");
await openMenu();
check("另存的檔案出現在最近清單最前面", (await recents())[0] === "1　新的.lpxl", (await recents()).join("、"));
await ev("window.__writes = []; window.__savePath = null");
await clickItem("儲存");
check("「儲存」已有檔案 → 直接覆蓋，不再跳選檔視窗", (await ev("window.__writes.at(-1)")) === "D:\\標籤\\新的.lpxl");

// ---------- 7. 快捷鍵 Ctrl+N ----------
await ev("document.getElementById('add-rect').click()"); await sleep(200);
await ev("window.__ask = true");
await ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }))"); await sleep(400);
await ev("document.getElementById('new-ok').click()"); await sleep(300); // 新標籤會先問尺寸
check("Ctrl+N → 開啟新檔", (await count()) === 0 && (await chip()) === "未命名標籤");

// ---------- 8. 再按一次「檔案」按鈕要收起選單（用真正的滑鼠事件）----------
const btn = JSON.parse(await ev("JSON.stringify((() => { const r = document.getElementById('file-menu').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })())"));
const click = async () => {
  await t.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: btn.x, y: btn.y });
  await t.send("Input.dispatchMouseEvent", { type: "mousePressed", x: btn.x, y: btn.y, button: "left", buttons: 1, clickCount: 1 });
  await t.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: btn.x, y: btn.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(250);
};
await click();
check("按「檔案」→ 開啟選單", await menuOpen());
await click();
check("再按一次「檔案」→ 收起選單", !(await menuOpen()));
await click();
await t.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 600, y: 500, button: "left", buttons: 1, clickCount: 1 });
await t.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 600, y: 500, button: "left", buttons: 0, clickCount: 1 });
await sleep(200);
check("點選單外面 → 收起選單", !(await menuOpen()));

// ---------- 9. 清除記錄、最多顯示 9 筆 ----------
await ev("localStorage.setItem('label-printer.recent', JSON.stringify(Array.from({ length: 12 }, (_, i) => 'D:\\\\標籤\\\\f' + (i + 1) + '.json')))");
await t.reload();
await openMenu();
const rs = await recents();
check("最近清單最多顯示 9 筆，並依序編號 1～9", rs.length === 9 && rs[0] === "1　f1.json" && rs[8] === "9　f9.json", `${rs.length} 筆：${rs[0]} … ${rs.at(-1)}`);
await setPick(A);
await clickItem("開啟舊檔…"); // 再開啟一個檔案 → 記錄會被修剪成最多 10 筆
const stored = JSON.parse(await ev("localStorage.getItem('label-printer.recent')"));
check("localStorage 最多保留 10 筆，新開啟的在最前面", stored.length === 10 && stored[0] === A, `${stored.length} 筆，第一筆 ${stored[0]}`);
await openMenu();
await clickItem("清除最近開啟記錄");
await openMenu();
check("清除最近開啟記錄 → 清單為空", (await recents()).length === 0 && (await labelsOnly()).includes("（沒有最近開啟的檔案）"));

await t.finish();
