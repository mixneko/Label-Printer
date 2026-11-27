// 回歸測試：連線到資料庫（SQLite／Access 檔案、ODBC 連線字串、選填 SQL 查詢）。
//   node scripts/ui-db.mjs [輸出資料夾=.tools]
import { launch } from "./_cdp.mjs";
const MOCK = `(() => {
  window.__calls = [];
  const ls = (k, d) => { try { const v = localStorage.getItem('t.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } };
  window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd, args) => {
    if (cmd === 'list_printers') return ['TSC']; if (cmd === 'list_fonts') return ['Arial'];
    if (cmd === 'list_odbc_sources') return { drivers: ['Microsoft Access Driver (*.mdb, *.accdb)', 'ODBC Driver 17 for SQL Server'], dsns: ['MyShop'] };
    if (cmd === 'plugin:dialog|open') return 'D:/data/shop.sqlite';
    if (cmd === 'read_table') {
      window.__calls.push({ path: args.path, sheet: args.sheet });
      if (ls('fail', false)) throw 'ODBC 連線失敗：帳號或密碼錯誤';
      const sheet = args.sheet || 'items';
      const isSql = sheet.startsWith('sql:');
      return { kind: args.path.endsWith('.xlsx') ? undefined : 'db', sheets: isSql ? ['items', 'orders', sheet] : ['items', 'orders'], sheet,
        headers: ['Item', 'Code'], rows: [['Screw', 'A-1'], ['Washer', 'A-2']], rowNumbers: [1, 2] };
    }
    return null; } };
})();`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "db" });
const { ev, sleep, check } = t;
const calls = () => ev("JSON.stringify(window.__calls)").then(JSON.parse);
const val = (id) => ev(`document.getElementById('${id}').value`);
const setv = (id, v) => ev(`(() => { const e = document.getElementById('${id}'); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const dlgOpen = () => ev("document.getElementById('dlg-db').open");
const msg = () => ev("document.getElementById('db-msg').textContent");
const openDlg = async () => {
  // 選擇資料來源按鈕右邊的 ▾ → 「連線到資料庫…」
  await ev("document.getElementById('import-table').click()"); await sleep(250);
  await ev("[...document.querySelectorAll('#ctx-menu [role=menuitem]')].find(e => e.textContent.trim().startsWith('連線到資料庫'))?.click()"); await sleep(600);
};

// 先用一般的 Excel 路徑確認標籤仍是「工作表」
await ev("document.getElementById('import-file').click()"); await sleep(400); // 對話框回傳 .sqlite（模擬）→ 也是資料庫
check("選擇資料來源選到 .sqlite 檔：以檔名顯示、標籤為「資料表」", (await ev("document.getElementById('data-file').textContent")) === "shop.sqlite" && (await ev("document.getElementById('data-sheet-label').textContent")) === "資料表");
check("資料庫的資料表清單放進下拉（items、orders）", (await ev("[...document.getElementById('data-sheet').options].map(o => o.value).join(',')")) === "items,orders");
await ev("document.getElementById('data-close').click()"); await sleep(200);

// ---- 對話框 ----
await openDlg();
check("「選擇資料來源」旁的 ▾ →「連線到資料庫…」開啟對話框", await dlgOpen());
check("預設類型：SQLite／Access 檔案（顯示檔案欄位、隱藏 ODBC 欄位）", (await val("db-kind")) === "file" && (await ev("!document.getElementById('db-file-fields').hidden && document.getElementById('db-odbc-fields').hidden")));
await setv("db-kind", "odbc"); await sleep(200);
check("切到 ODBC：顯示連線字串欄位", await ev("document.getElementById('db-file-fields').hidden && !document.getElementById('db-odbc-fields').hidden"));
check("驅動程式與資料來源名稱（DSN）列在下拉：1 + 2 + 1 項", (await ev("document.querySelectorAll('#db-src option').length")) === 4 && (await ev("[...document.querySelectorAll('#db-src optgroup')].map(g => g.label).join('|')")) === "驅動程式|資料來源名稱（DSN）");
await setv("db-src", "drv:ODBC Driver 17 for SQL Server"); await sleep(150);
check("選驅動程式 → 帶入連線字串範本", (await val("db-cs")) === "Driver={ODBC Driver 17 for SQL Server};");
await setv("db-src", "dsn:MyShop"); await sleep(150);
check("選 DSN → 帶入 DSN=名稱;", (await val("db-cs")) === "DSN=MyShop;");

// 空白
await setv("db-cs", "");
await ev("document.getElementById('db-go').click()"); await sleep(300);
check("沒填連線字串：提示、對話框不關、沒有呼叫 read_table", (await msg()) === "請輸入檔案路徑或連線字串" && (await dlgOpen()) && (await calls()).length === 1);

// ODBC + 密碼 + SQL 查詢
const CS = "Driver={ODBC Driver 17 for SQL Server};Server=h;Database=d;UID=u;PWD=secret123;";
await setv("db-cs", CS);
await setv("db-sql", "SELECT Item, Code FROM items WHERE Code <> ''");
await ev("document.getElementById('db-go').click()"); await sleep(600);
const c = await calls();
check("連線：read_table 收到 odbc: 前綴的連線字串與 sql: 查詢", c.at(-1).path === "odbc:" + CS && c.at(-1).sheet === "sql:SELECT Item, Code FROM items WHERE Code <> ''", JSON.stringify(c.at(-1)));
check("成功後對話框關閉、資料表面板出現", !(await dlgOpen()) && (await ev("!document.getElementById('data-panel').hidden")));
const label = await ev("document.getElementById('data-file').textContent");
check("來源名稱顯示 ODBC（驅動程式、主機、資料庫），帳號與密碼都不顯示", label.startsWith("ODBC · Driver={ODBC Driver 17 for SQL Server};Server=h;Database=d;") && !/secret123|PWD|UID/i.test(label), label);
check("頁面任何地方都沒有明文密碼（含 localStorage）", (await ev("(document.body.innerText + JSON.stringify(Object.entries(localStorage))).includes('secret123')")) === false);
check("自訂查詢列在資料表下拉並被選取", (await ev("document.getElementById('data-sheet').value")).startsWith("sql:SELECT Item"));
check("資料列載入（2 筆），欄位 Item／Code", (await ev("document.querySelectorAll('#data-table tr').length")) >= 3 && (await ev("[...document.querySelectorAll('#data-chips .chip')].map(c => c.textContent).join(',')")) === "{{Item}},{{Code}}");

// 切換資料表、重新讀取
await ev("(() => { const s = document.getElementById('data-sheet'); s.value = 'orders'; s.dispatchEvent(new Event('change', { bubbles: true })); })()"); await sleep(400);
check("切換資料表：以原本的連線字串讀 orders", JSON.stringify((await calls()).at(-1)) === JSON.stringify({ path: "odbc:" + CS, sheet: "orders" }));
await ev("document.getElementById('data-reload').click()"); await sleep(400);
check("重新讀取：同一個來源與資料表", JSON.stringify((await calls()).at(-1)) === JSON.stringify({ path: "odbc:" + CS, sheet: "orders" }));

// 檔案模式
await openDlg();
await setv("db-kind", "file");
await ev("document.getElementById('db-browse').click()"); await sleep(400);
check("選擇檔案：路徑欄填入", (await val("db-path")) === "D:/data/shop.sqlite");
await setv("db-path", '"D:/data/my shop.accdb"');
await setv("db-sql", "");
await ev("document.getElementById('db-go').click()"); await sleep(500);
check("檔案模式：路徑去掉引號後原樣傳給 read_table（不加 odbc:）、沒有 sheet", JSON.stringify((await calls()).at(-1)) === JSON.stringify({ path: "D:/data/my shop.accdb", sheet: null }));
check("檔案模式的來源名稱用檔名", (await ev("document.getElementById('data-file').textContent")) === "my shop.accdb");

// 失敗：顯示原因、對話框不關、原本的資料表面板不變
await ev("localStorage.setItem('t.fail', 'true')");
await openDlg();
await setv("db-kind", "odbc"); await setv("db-cs", "DSN=bad;"); await setv("db-sql", "");
await ev("document.getElementById('db-go').click()"); await sleep(500);
check("連線失敗：顯示原因、對話框保持開啟", (await msg()).includes("帳號或密碼錯誤") && (await dlgOpen()));
check("失敗後原本載入的來源不受影響", (await ev("document.getElementById('data-file').textContent")) === "my shop.accdb");
await ev("localStorage.removeItem('t.fail')");
await ev("document.getElementById('dlg-db').close()");

// 填表式：SQL Server／MySQL／PostgreSQL（程式內建連線，不必裝驅動程式、不必懂連線字串、不必寫 SQL）
await openDlg();
await setv("db-kind", "sqlserver"); await setv("db-host", ""); await setv("db-name", "");
check("伺服器型：顯示伺服器欄位、隱藏檔案與連線字串欄位", await ev("!document.getElementById('db-server-fields').hidden && document.getElementById('db-file-fields').hidden && document.getElementById('db-odbc-fields').hidden"));
check("三種伺服器型資料庫都可選（不需要 ODBC 驅動程式，不反灰）", await ev("['sqlserver', 'mysql', 'postgres'].every((v) => ![...document.querySelectorAll('#db-kind option')].find((x) => x.value === v).disabled)"));
check("連線安全性預設「加密並驗證憑證」，另有「信任自簽憑證」「不加密」", (await val("db-security")) === "verify" && (await ev("[...document.querySelectorAll('#db-security option')].map((o) => o.value).join('|')")) === "verify|trust|off");
check("SQL 收在「進階」摺疊區（預設收合）", await ev("document.getElementById('db-adv').open === false"));
await ev("document.getElementById('db-go').click()"); await sleep(300);
check("沒填伺服器與資料庫名稱：提示", (await msg()) === "請輸入伺服器與資料庫名稱");
await setv("db-host", "10.0.0.5"); await setv("db-port", "1433"); await setv("db-name", "shop"); await setv("db-user", "sa"); await setv("db-pass", "pw1");
const n0 = (await calls()).length;
await ev("document.getElementById('db-go').click()"); await sleep(600);
const c2 = await calls();
const spec = (c) => JSON.parse(c.path.slice(4));
check("SQL Server：以 net: 來源送出（JSON，不含連線字串與驅動程式名稱）", c2.length === n0 + 1 && c2.at(-1).path.startsWith("net:") && JSON.stringify(spec(c2.at(-1))) === JSON.stringify({ kind: "mssql", host: "10.0.0.5", port: 1433, database: "shop", user: "sa", password: "pw1", winauth: false, security: "verify" }), JSON.stringify(c2.at(-1)));
check("來源名稱不含帳號與密碼", (await ev("document.getElementById('data-file').textContent")) === "SQL Server · 10.0.0.5 / shop");
await openDlg();
check("再開對話框：記得上次的伺服器與資料庫（密碼不記）", (await val("db-host")) === "10.0.0.5" && (await val("db-name")) === "shop" && (await val("db-pass")) === "" && (await val("db-kind")) === "sqlserver");
await ev("document.getElementById('db-winauth').click()"); await sleep(100);
check("Windows 驗證：隱藏帳號密碼", await ev("document.getElementById('db-cred').hidden"));
await setv("db-security", "trust");
await ev("document.getElementById('db-go').click()"); await sleep(600);
const w = spec((await calls()).at(-1));
check("Windows 驗證＋信任自簽憑證：winauth、security 帶進設定", w.winauth === true && w.security === "trust" && w.kind === "mssql");
await openDlg();
check("再開：記得連線安全性", (await val("db-security")) === "trust");
await setv("db-kind", "mysql"); await setv("db-port", ""); await setv("db-security", "off");
await ev("document.getElementById('db-go').click()"); await sleep(600);
const my = spec((await calls()).at(-1));
check("MySQL：kind、預設埠（不填就不送）、不加密", my.kind === "mysql" && my.port === undefined && my.security === "off" && my.winauth === false && my.user === "sa", JSON.stringify(my));
await openDlg();
await setv("db-kind", "postgres"); await setv("db-security", "verify");
await setv("db-sql", "SELECT 1 AS a");
await ev("document.getElementById('db-go').click()"); await sleep(600);
const pgc = (await calls()).at(-1);
check("PostgreSQL＋自訂查詢：kind postgres、sheet 為 sql:", spec(pgc).kind === "postgres" && pgc.sheet === "sql:SELECT 1 AS a");
await ev("localStorage.setItem('t.fail', 'true')");
await openDlg(); await setv("db-kind", "sqlserver"); await setv("db-sql", "");
await ev("document.getElementById('db-go').click()"); await sleep(500);
check("連線失敗：顯示原因並提示可調整「連線安全性」", (await msg()).includes("帳號或密碼錯誤") && (await msg()).includes("連線安全性") && (await ev("document.getElementById('db-msg').className.includes('err')")));
await ev("localStorage.removeItem('t.fail')");
const lbl = await ev("import('/src/dbdialog.ts').then(m => JSON.stringify([m.netLabel('mysql', ' h ', ' d '), m.buildNetSource('postgres', { host: 'h', port: '70000', name: 'n', user: 'u', pass: 'p', winauth: true, security: 'verify' })]))");
check("來源名稱／來源字串：埠超出範圍就不送、只有 SQL Server 才帶 winauth", lbl === JSON.stringify(["MySQL · h / d", 'net:{"kind":"postgres","host":"h","database":"n","user":"u","password":"p","winauth":false,"security":"verify"}']), lbl);
await ev("document.getElementById('dlg-db').close()");

// 一般 Excel 檔仍標示「工作表」
await ev("(window.__TAURI_INTERNALS__.invoke = ((orig) => async (c, a) => c === 'plugin:dialog|open' ? 'D:/data/book.xlsx' : orig(c, a))(window.__TAURI_INTERNALS__.invoke), 1)");
await ev("document.getElementById('import-file').click()"); await sleep(500);
check("Excel 檔：標籤仍是「工作表」", (await ev("document.getElementById('data-sheet-label').textContent")) === "工作表" && (await ev("document.getElementById('data-file').textContent")) === "book.xlsx");
await t.finish();
