// 回歸測試：列印位置微調（左右／上下 mm）。以模擬的 print_labels 擷取實際送出的列印工作，並確認預覽同步。
//   node scripts/ui-shift.mjs [輸出資料夾=.tools]
import { launch } from "./_cdp.mjs";
const MOCK = `window.__jobs = [];
window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd, args) => {
  if (cmd === 'list_printers') return ['TSC']; if (cmd === 'list_fonts') return ['Microsoft JhengHei'];
  if (cmd === 'plugin:dialog|message') return args?.buttons?.OkCancelCustom?.[0]; // 一律按「放棄並…」
  if (cmd === 'print_labels') { window.__jobs.push(JSON.parse(JSON.stringify(args))); return null; }
  return null; } };`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "shift" });
const { ev, sleep, check } = t;
const setv = (id, v) => ev(`(() => { const i = document.getElementById('${id}'); i.value = '${v}'; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const printOnce = async () => { const n = await ev("window.__jobs.length"); await ev("document.getElementById('print').click()"); await sleep(900); return ev(`JSON.stringify(window.__jobs[${n}]?.job ?? window.__jobs[${n}] ?? null)`).then((s) => JSON.parse(s)); };

await ev("document.getElementById('add-text').click()"); await sleep(500);
const base = await printOnce();
check("有送出列印工作", !!base, JSON.stringify(base)?.slice(0, 80));
const j0 = base?.jobs?.[0] ?? base?.job ?? base;
const pick = (j) => ({ x: j.offsetXDots, y: j.offsetYDots });
const p0 = pick(j0);
check("預設：上下位移為 0", p0.y === 0, JSON.stringify(p0));

await setv("q-shiftx", "1"); await setv("q-shifty", "0.5");
const b1 = await printOnce(); const p1 = pick(b1?.jobs?.[0] ?? b1?.job ?? b1);
check("右移 1 mm → X 多 8 點", p1.x - p0.x === 8, `${p0.x} → ${p1.x}`);
check("下移 0.5 mm → Y 為 4 點", p1.y === 4, `${p1.y}`);

await setv("q-shiftx", "-1");
const b2 = await printOnce(); const p2 = pick(b2?.jobs?.[0] ?? b2?.job ?? b2);
check("左移 1 mm → X 少 8 點", p0.x - p2.x === 8, `${p0.x} → ${p2.x}`);

await setv("q-shifty", "-3");
check("上下位移不接受負數（夾在 0）", (await ev("document.getElementById('q-shifty').value")) === "0");
await setv("q-shiftx", "99");
check("左右位移上限 5 mm", (await ev("document.getElementById('q-shiftx').value")) === "5");

// 設定會記住
await setv("q-shiftx", "2");
const saved = JSON.parse(await ev("localStorage.getItem('label-printer.settings')"));
check("設定存入 localStorage", saved.shiftXmm === 2 && saved.shiftYmm === 0, JSON.stringify([saved.shiftXmm, saved.shiftYmm]));

// ---------- 產生校正標籤（GUI 按鈕）----------
await ev("document.getElementById('make-calibration').click()"); await sleep(1500);
const labels = JSON.parse(await ev("JSON.stringify(window.__lp.konva.stages[0].find('.element').map(n => n.getAttr('label')))"));
check("按「產生校正標籤」→ 畫布出現外框與刻度", labels.includes("外框") && labels.includes("上刻度 10") && labels.includes("左刻度 30") && labels.includes("十字橫"), `${labels.length} 個物件`);
check("刻度數量正確（上下各 61、左右各 31，含 0）", labels.filter((l) => l?.startsWith("上刻度")).length === 61 && labels.filter((l) => l?.startsWith("右刻度")).length === 31);
check("含說明文字", labels.includes("標題"));
check("校正標籤不算未儲存的變更（關閉不會詢問）", !(await ev("document.getElementById('tpl-name').classList.contains('dirty')")));
// 改變標籤尺寸後再產生，刻度跟著改
await setv("tpl-w", "50"); await setv("tpl-h", "25"); await sleep(600);
await ev("document.getElementById('make-calibration').click()"); await sleep(1500);
const l2 = JSON.parse(await ev("JSON.stringify(window.__lp.konva.stages[0].find('.element').map(n => n.getAttr('label')))"));
check("標籤改為 50×25 後，刻度跟著改（上 51、左 26）", l2.filter((l) => l?.startsWith("上刻度")).length === 51 && l2.filter((l) => l?.startsWith("左刻度")).length === 26);
await t.shot("2-calibration");
await t.finish();
