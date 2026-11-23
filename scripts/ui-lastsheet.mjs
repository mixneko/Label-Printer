// 回歸測試：記住上次選的工作表／資料表（Excel、資料庫檔案有多個時，下次開同一個檔案直接回到那一個）。
//   node scripts/ui-lastsheet.mjs [輸出資料夾=.tools]
import { launch } from "./_cdp.mjs";
const MOCK = `(() => {
  window.__calls = [];
  const ls = (k, d) => { try { const v = localStorage.getItem('t.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } };
  window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd, args) => {
    if (cmd === 'list_printers') return ['TSC']; if (cmd === 'list_fonts') return ['Arial'];
    if (cmd === 'plugin:dialog|open') return ls('path', 'D:/data/a.xlsx');
    if (cmd === 'read_table') {
      window.__calls.push({ path: args.path, sheet: args.sheet });
      const sheets = ls('sheets', ['Alpha', 'Beta', 'Gamma']);
      const sheet = args.sheet == null ? sheets[0] : args.sheet;
      if (!sheets.includes(sheet)) throw 'no such sheet: ' + sheet;
      return { sheets, sheet, headers: ['Item'], rows: [[sheet]], rowNumbers: [2] };
    }
    return null; } };
})();`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "lastsheet" });
const { ev, sleep, check } = t;
const calls = () => ev("JSON.stringify(window.__calls)").then(JSON.parse);
const open = async (path, sheets) => {
  await ev(`localStorage.setItem('t.path', ${JSON.stringify(JSON.stringify(path))}); localStorage.setItem('t.sheets', ${JSON.stringify(JSON.stringify(sheets))})`);
  await ev("window.__calls.length = 0; document.getElementById('import-table').click()");
  await sleep(400);
};
const shown = () => ev("document.getElementById('data-sheet').value");
const pick = async (v) => {
  await ev(`(() => { const s = document.getElementById('data-sheet'); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(300);
};
const ABC = ["Alpha", "Beta", "Gamma"];

await open("D:/data/a.xlsx", ABC);
check("第一次開：不指定工作表，顯示第一個", (await calls())[0].sheet === null && (await shown()) === "Alpha");
await pick("Gamma");
check("切到 Gamma", (await shown()) === "Gamma");

await open("D:/data/a.xlsx", ABC);
const c1 = await calls();
check("再開同一個檔案：直接讀 Gamma", c1.length === 1 && c1[0].sheet === "Gamma" && (await shown()) === "Gamma", JSON.stringify(c1));

await open("D:/data/other.xlsx", ABC);
check("開另一個檔案：不受影響，從第一個開始", (await calls())[0].sheet === null && (await shown()) === "Alpha");

await pick("Beta");
await open("D:/data/a.xlsx", ABC);
check("兩個檔案各自記住（a.xlsx 還是 Gamma）", (await shown()) === "Gamma");
await open("D:/data/other.xlsx", ABC);
check("兩個檔案各自記住（other.xlsx 是 Beta）", (await shown()) === "Beta");

await open("D:/data/a.xlsx", ["Alpha", "Beta"]);
const c2 = await calls();
check("記的工作表不存在了：退回第一個，不出錯", c2.length === 2 && c2[1].sheet === null && (await shown()) === "Alpha", JSON.stringify(c2));

await open("D:/data/one.xlsx", ["Only"]);
const saved = await ev("localStorage.getItem('label-printer.lastsheet')");
check("只有一個工作表的檔案不記錄", !saved.includes("one.xlsx"), saved);

for (let i = 0; i < 60; i++) {
  await open(`D:/data/f${i}.xlsx`, ABC);
  await pick("Beta");
}
const n = JSON.parse(await ev("localStorage.getItem('label-printer.lastsheet')")).length;
check("記錄最多 50 筆", n === 50, String(n));

await t.finish();
