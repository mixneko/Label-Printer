// 回歸測試：網頁版 Excel（連線、自動更新、勾選列跟著內容走、列印前確認、登入過期）。後端以模擬取代。
//   node scripts/ui-m365.mjs [輸出資料夾=.tools]
import { launch } from "./_cdp.mjs";
const MOCK = `(() => {
  window.__calls = []; window.__jobs = 0; window.__dialogs = []; window.__answer = 'cancel';
  window.__status = 'ok'; window.__rows = [['A', '1'], ['B', '2'], ['C', '3']]; window.__ver = 0;
  const files = {};
  window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd, args) => {
    if (cmd === 'list_printers') return ['TSC TTP-244 Pro']; if (cmd === 'list_fonts') return ['Arial'];
    if (cmd === 'print_labels') { window.__jobs++; return null; }
    if (cmd === 'm365_sync') {
      window.__calls.push([cmd, args.url, args.interactive]);
      if (!args.url.startsWith('https://')) throw '請貼上 SharePoint 或 OneDrive 的網址（https 開頭）';
      const st = (args.interactive && window.__interactive) || window.__status;
      if (st !== 'ok' && st !== 'manual') return { status: st, file: '', name: '', report: ['entry: sharepoint', 'x: no file'] };
      const file = 'C:/cache/' + (++window.__ver) + '.xlsx';
      files[file] = window.__rows.map((r) => r.slice());
      return { status: st, file, name: 'stock.xlsx', report: ['download.aspx: OK'] };
    }
    if (cmd === 'm365_logout') { window.__calls.push([cmd]); return null; }
    if (cmd === 'read_table') { const rows = files[args.path]; return { sheets: ['Items'], sheet: 'Items', headers: ['Item', 'Qty'], rows, rowNumbers: rows.map((_, i) => i + 2) }; }
    if (cmd === 'plugin:dialog|message') {
      window.__dialogs.push(args.message);
      const b = args.buttons;
      if (b && b.OkCancelCustom) return window.__answer === 'ok' ? b.OkCancelCustom[0] : b.OkCancelCustom[1];
      return 'Ok';
    }
    return null; } };
})();`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "m365", width: 1280, height: 800 });
const { ev, sleep, check } = t;
const click = (id, ms = 500) => ev(`document.getElementById('${id}').click()`).then(() => sleep(ms));
const text = (id) => ev(`document.getElementById('${id}').textContent`);
const type = (v) => ev(`document.getElementById('m365-url').value = ${JSON.stringify(v)}`);
const menu = () => ev("JSON.stringify([...document.querySelectorAll('#ctx-menu [role=menuitem]')].map(e => e.textContent.trim()))").then(JSON.parse);
const pick = (label) => ev(`[...document.querySelectorAll('#ctx-menu [role=menuitem]')].find(e => e.textContent.trim().startsWith(${JSON.stringify(label)}))?.click()`).then(() => sleep(600));
const cells = () => ev("JSON.stringify([...document.querySelectorAll('#data-table tr[data-i]')].map(tr => tr.children[2].textContent))").then(JSON.parse);
const checkedItems = () => ev("JSON.stringify([...document.querySelectorAll('#data-table tr[data-i]')].filter(tr => tr.querySelector('input').checked).map(tr => tr.children[2].textContent))").then(JSON.parse);
const tick = (i) => ev(`document.querySelectorAll('#data-table tr[data-i] input')[${i}].click()`).then(() => sleep(200));
const set = (js) => ev(js);

await click("import-table"); await pick("網頁版 Excel");
check("「選擇資料來源」→「網頁版 Excel…」開啟對話框", await ev("document.getElementById('dlg-m365').open"));
await type("abc"); await click("m365-connect");
check("網址不對：在視窗裡顯示原因", (await text("m365-msg")).includes("請貼上") && (await ev("document.getElementById('dlg-m365').open")));

await set("window.__status = 'failed'");
const URL_OK = "https://contoso.sharepoint.com/:x:/s/team/Abc";
await type(URL_OK); await click("m365-connect");
check("抓不到：顯示原因與回報用資訊，對話框留著", (await text("m365-msg")).includes("抓不到") && (await ev("!document.getElementById('m365-report-box').hidden")) && (await text("m365-report")).includes("no file"));

await set("window.__status = 'ok'"); await click("m365-connect", 900);
check("連線成功：對話框關閉、資料出現在下方資料表", !(await ev("document.getElementById('dlg-m365').open")) && JSON.stringify(await cells()) === JSON.stringify(["A", "B", "C"]));
check("資料表標示網頁版與檔名、取得時間與自動更新間隔（預設 30 秒）", (await text("data-file")) === "網頁版 · stock.xlsx" && (await ev("!document.getElementById('data-web').hidden")) && (await text("data-web-at")).includes("取得於") && (await ev("document.getElementById('data-interval').value")) === "30");
check("連線時允許跳出登入視窗", (await ev("window.__calls.at(-1)[2]")) === true);
await t.shot("table");

// 勾 B；上面插入一列後手動重新讀取 → 勾選跟著 B 走
await tick(1);
await set("window.__rows = [['A', '1'], ['NEW', '9'], ['B', '2'], ['C', '3']]");
await click("data-reload", 900);
check("重新讀取：顯示新內容", JSON.stringify(await cells()) === JSON.stringify(["A", "NEW", "B", "C"]));
check("勾選的列移位後仍勾著同一筆", JSON.stringify(await checkedItems()) === JSON.stringify(["B"]));
check("新內容的列有標示", (await ev("[...document.querySelectorAll('#data-table tr.changed')].length")) === 1);

// 移位後第一次按列印先停下，第二次才印
await set("window.__dialogs = []"); await click("data-print", 900);
check("勾選列移位過：列印先停下並說明", (await ev("window.__jobs")) === 0 && (await ev("window.__dialogs.some(m => m.includes('變動或移位'))")));
await click("data-print", 1200);
check("看過後再按一次：內容沒變就直接印", (await ev("window.__jobs")) === 1);

// 沒勾到的列改變：直接印
await set("window.__rows = [['A', '100'], ['NEW', '9'], ['B', '2'], ['C', '3']]; window.__dialogs = []");
await click("data-print", 1200);
check("別的列改了、勾選列沒變：先抓最新資料再直接印", (await ev("window.__jobs")) === 2 && (await ev("window.__dialogs.length")) === 0 && (await ev("document.querySelector('#data-table tr[data-i] td:nth-child(4)').textContent")) === "100");

// 勾選列內容改了：取消勾選並停下
await set("window.__rows = [['A', '100'], ['NEW', '9'], ['B', '22'], ['C', '3']]; window.__dialogs = []");
await click("data-print", 1200);
check("勾選列內容改了：不印、取消該列勾選", (await ev("window.__jobs")) === 2 && (await checkedItems()).length === 0 && (await ev("window.__dialogs.length")) === 1);

// 抓不到最新資料：由使用者決定
await tick(2);
await set("window.__status = 'failed'; window.__dialogs = []; window.__answer = 'cancel'"); await click("data-print", 900);
check("抓不到最新資料：詢問，選取消就不印", (await ev("window.__jobs")) === 2 && (await ev("window.__dialogs[0]")).includes("抓不到最新資料"));
await set("window.__answer = 'ok'"); await click("data-print", 900);
check("選「照這份繼續」就印", (await ev("window.__jobs")) === 3);

// 預覽前也確認
await set("window.__status = 'ok'; window.__rows = [['X', '0'], ['A', '100'], ['NEW', '9'], ['B', '22'], ['C', '3']]; window.__dialogs = []");
await click("data-preview-direct", 900);
check("預覽前發現移位：不開預覽", !(await ev("document.getElementById('pv-dialog').open")) && (await ev("window.__dialogs.length")) === 1);
await click("data-preview-direct", 900);
check("再按一次：開啟預覽", await ev("document.getElementById('pv-dialog').open"));
// 預覽開著時雲端資料移位：在預覽裡按列印會先停下
const jobsBefore = await ev("window.__jobs");
await set("window.__rows = [['Y', '0'], ['X', '0'], ['A', '100'], ['NEW', '9'], ['B', '22'], ['C', '3']]; window.__dialogs = []");
await click("pv-print", 1200);
check("預覽裡按列印時資料剛好移位：不印、關閉預覽並說明", (await ev("window.__jobs")) === jobsBefore && !(await ev("document.getElementById('pv-dialog').open")) && (await ev("window.__dialogs.length")) === 1);
await click("data-preview-direct", 900); await click("pv-print", 1500);
check("看過後重新預覽再按列印：送出", (await ev("window.__jobs")) === jobsBefore + 1);
await click("data-preview-direct", 900);
await click("pv-close");

// 定時更新（15 秒）；登入過期時跳一次登入視窗，沒登入就暫停
await ev("(() => { const s = document.getElementById('data-interval'); s.value = '15'; s.dispatchEvent(new Event('change')); })()");
await set("window.__calls = []; window.__rows = [['Z', '1']]");
await sleep(17500);
check("定時更新：時間到自動抓、不跳視窗、資料換新", JSON.stringify(await cells()) === JSON.stringify(["Z"]) && (await ev("window.__calls.length")) === 1 && (await ev("window.__calls[0][2]")) === false);
await set("window.__calls = []; window.__status = 'login'; window.__interactive = 'cancelled'");
await sleep(17500);
check("登入過期：背景檢查後跳一次登入視窗", JSON.stringify(await ev("window.__calls.map(c => c[2])")) === JSON.stringify([false, true]), JSON.stringify(await ev("window.__calls")));
check("沒登入：提示手上是幾點的資料", (await ev("document.body.textContent.includes('登入已過期')")));
await sleep(17000);
check("之後暫停，不會一直跳視窗", (await ev("window.__calls.length")) === 2);

// 最近清單、登出、換來源
await set("window.__status = 'ok'; window.__interactive = ''");
await click("import-table");
check("選單出現最近用過的檔案", (await menu()).includes("stock.xlsx"), JSON.stringify(await menu()));
await pick("stock.xlsx"); await sleep(600);
check("點最近的檔案直接連線", !(await ev("document.getElementById('dlg-m365').open")) && JSON.stringify(await cells()) === JSON.stringify(["Z"]));
await click("import-table"); await pick("網頁版 Excel…");
await t.shot("dialog");
await click("m365-logout");
check("登出", (await ev("window.__calls.at(-1)[0]")) === "m365_logout" && (await text("m365-msg")).includes("已登出"));
await ev("document.querySelector('#dlg-m365 [data-dlg-close]').click()"); await sleep(200);
await click("data-close");
check("關閉資料表", await ev("document.getElementById('data-panel').hidden"));
await t.finish();
