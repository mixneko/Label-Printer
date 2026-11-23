// 一次跑完所有有 PASS / FAIL 判定的 UI 測試：啟動一個 Vite，讓多支測試共用，最後關閉。
//   npm run test:ui            （或 node scripts/ui-test.mjs [輸出資料夾=.tools]）
// 不需要事先另外開 Vite、也不需要事後停止；任何一項失敗時結束代碼為 1。
import { spawn } from "node:child_process";
import { devServer } from "./_dev-server.mjs";

const out = process.argv[2] ?? ".tools";
const tests = ["ui-menu.mjs", "ui-table.mjs", "ui-quality.mjs", "ui-file.mjs", "ui-format.mjs", "ui-textbox.mjs", "ui-preview.mjs", "ui-font.mjs", "ui-undo.mjs", "ui-display.mjs", "ui-closedlg.mjs", "ui-shift.mjs", "ui-help.mjs", "ui-menubar.mjs", "ui-barcode.mjs", "ui-guides.mjs", "ui-native.mjs", "ui-lpxl.mjs", "ui-i18n.mjs", "ui-tooltips.mjs", "ui-multi.mjs", "ui-update.mjs", "ui-lang.mjs", "ui-sheet.mjs", "ui-db.mjs", "ui-split.mjs", "ui-setup.mjs", "ui-natives.mjs", "ui-icons.mjs", "ui-start.mjs", "ui-ipc.mjs", "ui-suggest.mjs", "ui-zoom.mjs", "ui-hostile.mjs", "ui-paging.mjs", "ui-lastsheet.mjs"];

const server = await devServer();
const failed = [];
for (const t of tests) {
  console.log(`\n===== ${t} =====`);
  // 每支腳本最多 5 分鐘（平常不到 1 分鐘）；逾時代表 Edge 卡住，只結束這支腳本自己的行程樹並重試一次
  const run = () => new Promise((res) => {
    const p = spawn(process.execPath, [`scripts/${t}`, out], { stdio: "inherit", env: { ...process.env, VITE_URL: server.url } });
    const timer = setTimeout(() => {
      console.log(`!! ${t} 超過 5 分鐘沒結束，強制結束（只結束它自己的行程）`);
      spawn("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" });
    }, 300000);
    p.on("exit", (c) => { clearTimeout(timer); res(c ?? 1); });
    p.on("error", () => { clearTimeout(timer); res(1); });
  });
  let code = await run();
  if (code !== 0) { console.log(`!! ${t} 失敗，重試一次`); code = await run(); }
  if (code !== 0) failed.push(t);
}
await server.stop();
console.log(failed.length ? `\n失敗的測試：${failed.join("、")}` : "\n全部 UI 測試通過");
process.exit(failed.length ? 1 : 0);
