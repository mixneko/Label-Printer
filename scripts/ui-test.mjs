// 一次跑完所有有 PASS / FAIL 判定的 UI 測試：啟動一個 Vite，讓多支測試共用，最後關閉。
//   npm run test:ui            （或 node scripts/ui-test.mjs [輸出資料夾=.tools]）
//   同時跑幾支：預設 4，記憶體不夠或想逐支看輸出時設環境變數 UI_JOBS=1
//   只跑幾支：UI_ONLY=m365,split npm run test:ui
// 不需要事先另外開 Vite、也不需要事後停止；任何一項失敗時結束代碼為 1。
import { spawn } from "node:child_process";
import { devServer } from "./_dev-server.mjs";

const out = process.argv[2] ?? ".tools";
const all = ["ui-menu.mjs", "ui-table.mjs", "ui-quality.mjs", "ui-file.mjs", "ui-format.mjs", "ui-textbox.mjs", "ui-preview.mjs", "ui-font.mjs", "ui-undo.mjs", "ui-display.mjs", "ui-closedlg.mjs", "ui-shift.mjs", "ui-help.mjs", "ui-menubar.mjs", "ui-barcode.mjs", "ui-guides.mjs", "ui-native.mjs", "ui-lpxl.mjs", "ui-i18n.mjs", "ui-tooltips.mjs", "ui-multi.mjs", "ui-update.mjs", "ui-lang.mjs", "ui-sheet.mjs", "ui-db.mjs", "ui-split.mjs", "ui-setup.mjs", "ui-natives.mjs", "ui-icons.mjs", "ui-start.mjs", "ui-ipc.mjs", "ui-suggest.mjs", "ui-zoom.mjs", "ui-hostile.mjs", "ui-paging.mjs", "ui-lastsheet.mjs", "ui-panelwidth.mjs", "ui-donate.mjs", "ui-m365.mjs"];
const only = (process.env.UI_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const tests = only.length ? all.filter((t) => only.some((o) => t === `ui-${o}.mjs` || t === o)) : all;
// 要等很久的（有定時行為的）先開跑，整體才不會最後只剩它一支
const SLOW = ["ui-m365.mjs"];
const queue = [...tests].sort((a, b) => Number(SLOW.includes(b)) - Number(SLOW.includes(a)));
const jobs = Math.max(1, Number(process.env.UI_JOBS) || 4);

const started = Date.now();
const server = await devServer();

/** 跑一支腳本，輸出先收起來，結束後整段印出（同時跑多支時才不會混在一起） */
function run(t) {
  return new Promise((res) => {
    let text = "";
    const p = spawn(process.execPath, [`scripts/${t}`, out], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, VITE_URL: server.url } });
    p.stdout.on("data", (d) => (text += d));
    p.stderr.on("data", (d) => (text += d));
    // 每支腳本最多 5 分鐘（平常不到 1 分鐘）；逾時代表 Edge 卡住，只結束這支腳本自己的行程樹
    const timer = setTimeout(() => {
      text += `\n!! ${t} 超過 5 分鐘沒結束，強制結束（只結束它自己的行程）\n`;
      spawn("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" });
    }, 300000);
    const done = (code) => { clearTimeout(timer); console.log(`\n===== ${t} =====\n${text.trimEnd()}`); res(code); };
    p.on("close", (c) => done(c ?? 1));
    p.on("error", () => done(1));
  });
}

const retry = [];
await Promise.all(Array.from({ length: jobs }, async () => {
  for (let t = queue.shift(); t; t = queue.shift()) if ((await run(t)) !== 0) retry.push(t);
}));

// 失敗的一支一支重跑：同時跑時機器比較忙，偶發的時間差在這裡排除，仍失敗才算數
const failed = [];
for (const t of retry) {
  console.log(`\n!! ${t} 失敗，單獨重跑一次`);
  if ((await run(t)) !== 0) failed.push(t);
}

await server.stop();
console.log(`\n共 ${tests.length} 支，同時 ${jobs} 支，花了 ${Math.round((Date.now() - started) / 1000)} 秒${retry.length ? `；重跑過：${retry.join("、")}` : ""}`);
console.log(failed.length ? `失敗的測試：${failed.join("、")}` : "全部 UI 測試通過");
process.exit(failed.length ? 1 : 0);
