// 回歸測試：復原 / 重做（Ctrl+Z / Ctrl+Y）。
//   node scripts/ui-undo.mjs [輸出資料夾=.tools]      （腳本會自己啟動並關閉 Vite）
import { launch } from "./_cdp.mjs";

const MOCK = `window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd) => {
  if (cmd === 'list_printers') return ['TSC']; if (cmd === 'list_fonts') return ['Microsoft JhengHei']; return null; } };`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "undo" });
const { ev, send, sleep, check } = t;

const mods = (shift) => 2 | (shift ? 8 : 0); // Ctrl(+Shift)
const combo = async (k, code, shift = false) => {
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code: "Key" + k.toUpperCase(), windowsVirtualKeyCode: code, modifiers: mods(shift) });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: "Key" + k.toUpperCase(), windowsVirtualKeyCode: code, modifiers: mods(shift) });
  await sleep(500);
};
const undo = () => combo("z", 90);
const redo = () => combo("y", 89);
const count = () => ev("window.__lp.count()");
const xs = async () => JSON.parse(await ev("JSON.stringify(window.__lp.konva.stages[0].find('.element').map(n => n.x()))"));

await ev("document.getElementById('add-text').click()"); await sleep(600);
await ev("document.getElementById('add-rect').click()"); await sleep(600);
check("新增兩個物件", (await count()) === 2, `${await count()}`);

await undo();
check("Ctrl+Z → 復原新增矩形（剩 1 個）", (await count()) === 1, `${await count()}`);
await undo();
check("再 Ctrl+Z → 復原新增文字（剩 0 個）", (await count()) === 0, `${await count()}`);
await undo();
check("沒有可復原時不出錯、仍為 0 個", (await count()) === 0);
await redo();
check("Ctrl+Y → 重做（1 個）", (await count()) === 1, `${await count()}`);
await combo("z", 90, true);
check("Ctrl+Shift+Z → 也是重做（2 個）", (await count()) === 2, `${await count()}`);

// 移動 → 復原
const x0 = (await xs())[0];
await ev("(() => { const n = window.__lp.konva.stages[0].find('.element')[0]; n.x(n.x() + 40); n.fire('dragend', {}, true); })()"); await sleep(600);
await undo();
const els = await xs();
check("移動物件後 Ctrl+Z → 位置還原", Math.abs(els[0] - x0) < 1 && els.length === 2, `${x0} → ${els[0]}`);
await redo();
const els2 = await xs();
check("Ctrl+Y → 位置再套用（比復原後多 40）", Math.abs(els2[0] - els[0] - 40) < 1, `${els[0]} → ${els2[0]}`);

// 刪除 → 復原
await ev("document.querySelectorAll('#layer-list li')[0].click()"); await sleep(300);
await ev("document.getElementById('delete').click()"); await sleep(500);
const afterDel = await count();
await undo();
check("刪除後 Ctrl+Z → 物件回來", (await count()) === afterDel + 1, `${afterDel} → ${await count()}`);

// 輸入框內的 Ctrl+Z 不攔截（留給輸入框自己復原文字）
await ev("Array.from(document.querySelectorAll('#layer-list li')).find(l => l.textContent.includes('文字'))?.click()"); await sleep(300);
check("（前置）選到文字後輸入框可用", await ev("document.getElementById('prop-text').offsetParent !== null"));
await ev("document.getElementById('prop-text').focus()");
const before = await count();
await undo();
check("焦點在輸入框時 Ctrl+Z 不動畫布", (await count()) === before, `${before} → ${await count()}`);
await t.finish();
