// 回歸測試：標籤檔副檔名 .lpxl（內容是 JSON）：檔案對話框篩選、預設檔名、舊 .json 仍可開、雙擊檔案開啟程式（命令列帶入的檔案）。
//   node scripts/ui-lpxl.mjs [輸出資料夾=.tools]
import { launch } from "./_cdp.mjs";

const MOCK = `
const label = (n) => JSON.stringify({ version: 1, tplWmm: 60, tplHmm: 30, elements: Array.from({ length: n }, (_, i) => ({
  kind: 'rect', x: 10 + i * 20, y: 10, rotation: 0, scaleX: 1, scaleY: 1, width: 15, height: 10, filled: true, strokeWidth: 1 })) });
window.__files = { 'D:\\\\標籤\\\\雙擊.lpxl': label(3), 'D:\\\\標籤\\\\舊版.json': label(2), 'D:\\\\標籤\\\\新版.lpxl': label(1) };
window.__pick = null; window.__savePath = null; window.__dialogs = []; window.__writes = [];
window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd, args) => {
  if (cmd === 'list_printers') return ['TSC']; if (cmd === 'list_fonts') return ['Microsoft JhengHei'];
  if (cmd === 'startup_file') return 'D:\\\\標籤\\\\雙擊.lpxl';
  if (cmd === 'plugin:dialog|open') { window.__dialogs.push({ kind: 'open', options: args?.options }); return window.__pick; }
  if (cmd === 'plugin:dialog|save') { window.__dialogs.push({ kind: 'save', options: args?.options }); return window.__savePath; }
  if (cmd === 'plugin:dialog|message') { const [ok, cancel] = args.buttons.OkCancelCustom; return window.__askAnswer === false ? cancel : ok; }
  if (cmd === 'path_exists') return args.path in window.__files;
  if (cmd === 'read_text_file') { if (!(args.path in window.__files)) throw '系統找不到指定的檔案。'; return window.__files[args.path]; }
  if (cmd === 'write_text_file') { window.__writes.push(args.path); window.__files[args.path] = args.content; return null; }
  return null; } };`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "lpxl" });
const { ev, sleep, check } = t;
const chip = () => ev("document.getElementById('tpl-name').textContent");
const count = () => ev("document.querySelectorAll('#layer-list li:not(.empty)').length");
const lastDialog = (kind) => ev(`JSON.stringify(window.__dialogs.filter(d => d.kind === '${kind}').at(-1) ?? null)`).then(JSON.parse);
const menu = async (item) => {
  await ev("document.getElementById('file-menu').click()"); await sleep(200);
  await ev(`[...document.querySelectorAll('#ctx-menu li')].find(l => l.querySelector(':scope > .label')?.textContent === ${JSON.stringify(item)})?.click()`); await sleep(500);
};

// 1) 啟動時帶入的檔案（在檔案總管雙擊 .lpxl）
for (let i = 0; i < 30 && (await count()) !== 3; i++) await sleep(200);
check("啟動時帶入的 .lpxl 檔案會直接載入（3 個物件）", (await count()) === 3, `count=${await count()}`);
check("檔名標籤顯示 雙擊.lpxl，沒有未儲存標記", (await chip()) === "雙擊.lpxl");
check("出現在最近開啟的清單", (await ev("JSON.parse(localStorage.getItem('label-printer.recent') || '[]')[0]")) === "D:\\標籤\\雙擊.lpxl");

// 2) 開啟舊檔：對話框同時接受 .lpxl 與舊的 .json
await ev("window.__pick = 'D:\\\\標籤\\\\舊版.json'");
await menu("開啟舊檔…");
const od = await lastDialog("open");
check("開啟對話框的篩選：.lpxl 與 .json", JSON.stringify(od.options.filters[0].extensions) === JSON.stringify(["lpxl", "json"]), JSON.stringify(od.options.filters));
check("舊版 .json 標籤仍然可以開啟（2 個物件）", (await count()) === 2 && (await chip()) === "舊版.json", `count=${await count()}`);

// 3) 另存新檔：只提供 .lpxl；舊檔另存時預設檔名換成 .lpxl
await ev("window.__savePath = 'D:\\\\標籤\\\\升級.lpxl'");
await menu("另存新檔…");
const sd = await lastDialog("save");
check("儲存對話框的篩選只有 .lpxl", JSON.stringify(sd.options.filters[0].extensions) === JSON.stringify(["lpxl"]), JSON.stringify(sd.options.filters));
check("舊版 舊版.json 另存時預設檔名升級為 .lpxl", sd.options.defaultPath === "D:\\標籤\\舊版.lpxl", sd.options.defaultPath);
check("另存成功：寫入 .lpxl 並更新檔名", (await ev("window.__writes.at(-1)")) === "D:\\標籤\\升級.lpxl" && (await chip()) === "升級.lpxl");
const written = JSON.parse(await ev("window.__files['D:\\\\標籤\\\\升級.lpxl']"));
check("存出來的內容仍是 JSON（version 1、elements 陣列）", written.version === 1 && Array.isArray(written.elements) && written.elements.length === 2);

// 4) 全新標籤第一次儲存：預設檔名 label.lpxl
await menu("開啟新檔");
await ev("document.getElementById('add-rect').click()"); await sleep(400);
await ev("window.__savePath = null");
await menu("儲存");
const sd2 = await lastDialog("save");
check("新標籤第一次儲存：預設檔名 label.lpxl", sd2.options.defaultPath === "label.lpxl", sd2.options.defaultPath);

// 5) 從舊的 .json 開啟：「儲存」一律存成同名 .lpxl（不跳對話框、原檔不動），最近開啟的記錄跟著換
await ev("localStorage.setItem('label-printer.recent', JSON.stringify([]))");
await ev("window.__pick = 'D:\\\\標籤\\\\舊版.json'");
await menu("開啟舊檔…");
check("從 舊版.json 開啟", (await chip()) === "舊版.json");
const recentBefore = await ev("JSON.parse(localStorage.getItem('label-printer.recent'))");
check("最近記錄先有 舊版.json", recentBefore[0] === "D:\\標籤\\舊版.json", JSON.stringify(recentBefore));
await ev("document.getElementById('add-rect').click()"); await sleep(400);
const jsonBefore = await ev("window.__files['D:\\\\標籤\\\\舊版.json']");
const dialogsBefore = await ev("window.__dialogs.length");
await menu("儲存");
check("儲存：寫入同名的 舊版.lpxl，不跳選檔視窗", (await ev("window.__writes.at(-1)")) === "D:\\標籤\\舊版.lpxl" && (await ev("window.__dialogs.length")) === dialogsBefore, await ev("window.__writes.at(-1)"));
check("檔名標籤換成 舊版.lpxl、沒有未儲存標記", (await chip()) === "舊版.lpxl");
check("原本的 舊版.json 沒有被更動", (await ev("window.__files['D:\\\\標籤\\\\舊版.json']")) === jsonBefore);
const recentAfter = await ev("JSON.parse(localStorage.getItem('label-printer.recent'))");
check("最近記錄跟著換：新檔在最前面、舊的 .json 已移除", recentAfter[0] === "D:\\標籤\\舊版.lpxl" && !recentAfter.includes("D:\\標籤\\舊版.json"), JSON.stringify(recentAfter));
check("之後再按「儲存」直接覆蓋 舊版.lpxl", await (async () => { await ev("document.getElementById('add-rect').click()"); await sleep(300); await menu("儲存"); return (await ev("window.__writes.at(-1)")) === "D:\\標籤\\舊版.lpxl" && (await ev("window.__dialogs.length")) === dialogsBefore; })());

// 5b) 已經有同名 .lpxl：先確認才覆蓋；取消就不存
await ev("window.__pick = 'D:\\\\標籤\\\\舊版.json'");
await menu("開啟舊檔…");
await ev("document.getElementById('add-rect').click()"); await sleep(400);
await ev("window.__askAnswer = false"); // 對「要覆蓋嗎」回答取消
const writesBefore = await ev("window.__writes.length");
await menu("儲存");
check("已有同名 .lpxl 且選「取消」：沒有寫入、仍是 舊版.json 且保留未儲存標記", (await ev("window.__writes.length")) === writesBefore && (await chip()).startsWith("舊版.json") && (await ev("document.getElementById('tpl-name').classList.contains('dirty')")));
await ev("window.__askAnswer = true");
await menu("儲存");
check("選「覆蓋」：寫入 舊版.lpxl", (await ev("window.__writes.at(-1)")) === "D:\\標籤\\舊版.lpxl" && (await chip()) === "舊版.lpxl");

// 6) 說明文字：沒有殘留舊的「.json」字樣在畫面上
const text = await ev("document.body.innerText");
check("畫面上不再叫它「範本」", !text.includes("範本"));
await t.finish();
