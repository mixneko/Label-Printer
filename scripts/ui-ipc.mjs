// 回歸測試：後端（Rust）回傳的中文錯誤訊息會依目前語言翻譯（src/ipc.ts）。
//   node scripts/ui-ipc.mjs [輸出資料夾=.tools]
import { launch } from "./_cdp.mjs";
const MOCK = `(() => {
  window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd, args) => {
    if (cmd === 'list_printers') return ['TSC TTP-244 Pro'];
    if (cmd === 'list_fonts') return ['Arial'];
    if (cmd === 'boom') throw args.msg;
    return null; } };
})();`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "ipc" });
const { ev, sleep, check } = t;
const L = (msg) => ev(`import('/src/ipc.ts').then(m => m.localizeError(${JSON.stringify(msg)}))`);
const setLang = async (l) => { await ev(`localStorage.setItem('label-printer.lang', '${l}')`); await t.reload(); await sleep(500); };

await setLang("en");
check("英文：固定訊息", (await L("尚未選擇印表機")) === "No printer selected yet", await L("尚未選擇印表機"));
check("英文：帶佔位", (await L("找不到檔案：D:\資料\a.csv")) === "File not found: D:\資料\a.csv");
check("英文：兩個佔位", (await L("點陣大小不符：預期 10 bytes，實際 8 bytes")) === "Bitmap size mismatch: expected 10 bytes, got 8 bytes");
check("英文：遞迴（第 2 張：…）", (await L("第 2 張：EPL2 沒有 QR Code 的原生指令")) === "Label 2: EPL2 has no native QR code command", await L("第 2 張：EPL2 沒有 QR Code 的原生指令"));
check("英文：系統原文維持原樣", (await L("開啟印表機「A」失敗：Access is denied. (os error 5)")) === "Failed to open the printer “A”: Access is denied. (os error 5)");
check("英文：通用型（{api} 失敗）", (await L("WritePrinter 失敗：The device is not ready")) === "WritePrinter failed: The device is not ready");
check("認不得的訊息原樣回傳", (await L("something else")) === "something else");
check("invoke 失敗時丟出的是翻譯後的字串", (await ev(`import('/src/ipc.ts').then(m => m.invoke('boom', { msg: '尚未選擇印表機' })).then(() => 'no', (e) => e)`)) === "No printer selected yet");
await setLang("ja");
check("日文", (await L("沒有要列印的標籤")) === "印刷するラベルがありません");
await setLang("zh-TW");
check("繁中：維持原文", (await L("沒有要列印的標籤")) === "沒有要列印的標籤");
await t.finish();
