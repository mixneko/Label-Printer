// 回歸測試：關閉程式前的三選一對話框（儲存並關閉／取消／放棄儲存並關閉，後者紅色）。
//   node scripts/ui-closedlg.mjs [輸出資料夾=.tools]
import { launch } from "./_cdp.mjs";
const MOCK = `window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd) => {
  if (cmd === 'list_printers') return ['TSC']; if (cmd === 'list_fonts') return ['Microsoft JhengHei']; return null; } };`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "closedlg" });
const { ev, send, sleep, check } = t;

const open = () => ev("window.__r = undefined; window.__lp.askClose('測試訊息').then(v => { window.__r = v; }); 1");
const result = async () => { await sleep(250); return ev("window.__r"); };
const click = (id) => ev(`document.getElementById('${id}').click()`);

await open(); await sleep(200);
check("對話框顯示", await ev("document.getElementById('close-dialog').open"));
check("顯示傳入的訊息", (await ev("document.getElementById('close-msg').textContent")) === "測試訊息");
const labels = JSON.parse(await ev("JSON.stringify(Array.from(document.querySelectorAll('#close-dialog footer .btn')).map(b => b.textContent.trim()))"));
check("三個按鈕：儲存並關閉、取消、放棄儲存並關閉（依序）", JSON.stringify(labels) === JSON.stringify(["儲存並關閉", "取消", "放棄儲存並關閉"]), JSON.stringify(labels));
const bg = await ev("getComputedStyle(document.getElementById('close-discard')).backgroundColor");
const [r, g, b] = bg.match(/\d+/g).map(Number);
check("「放棄儲存並關閉」是紅色", r > 180 && g < 90 && b < 90, bg);
const bgSave = await ev("getComputedStyle(document.getElementById('close-save')).backgroundColor");
check("其他按鈕不是紅色", bgSave !== bg && (await ev("getComputedStyle(document.getElementById('close-cancel')).backgroundColor")) !== bg);
check("預設焦點在「儲存並關閉」", await ev("document.activeElement.id === 'close-save'"));
await t.shot("1-dialog");

await click("close-save");
check("按「儲存並關閉」→ save", (await result()) === "save");
await open(); await sleep(200); await click("close-cancel");
check("按「取消」→ cancel", (await result()) === "cancel");
await open(); await sleep(200); await click("close-discard");
check("按「放棄儲存並關閉」→ discard", (await result()) === "discard");
check("選擇後對話框關閉", !(await ev("document.getElementById('close-dialog').open")));
// Esc 視為取消
await open(); await sleep(200);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
check("按 Esc → cancel（不會誤關閉）", (await result()) === "cancel");
// 重複開啟不會殘留舊的事件（第二次點擊只解析一次）
await open(); await sleep(200); await click("close-save");
check("重複開啟後仍正確（save）", (await result()) === "save");
await t.finish();
