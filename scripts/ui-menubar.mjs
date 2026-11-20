// 回歸測試：功能表列（檔案／插入／編輯／檢視／工具／說明）與工具列的上一步／取消上一步／刪除。
//   node scripts/ui-menubar.mjs [輸出資料夾=.tools]
import { launch } from "./_cdp.mjs";
const MOCK = `window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd, args) => {
  if (cmd === 'list_printers') return ['TSC']; if (cmd === 'list_fonts') return ['Microsoft JhengHei'];
  if (cmd === 'plugin:dialog|message') return args?.buttons?.OkCancelCustom?.[0];
  return null; } };`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "menubar" });
const { ev, sleep, check } = t;
const $ = (id) => `document.getElementById('${id}')`;
const items = () => ev("JSON.stringify([...document.querySelectorAll('#ctx-menu > .menu > li')].map(e => ({ t: e.textContent.trim(), d: e.classList.contains('disabled'), sep: e.classList.contains('sep') })))").then(JSON.parse);
const labels = async () => (await items()).filter((i) => !i.sep).map((i) => i.t);
const menuOpen = () => ev("!!document.getElementById('ctx-menu') && !document.getElementById('ctx-menu').hidden");
const click = async (id) => { await ev(`${$(id)}.click()`); await sleep(200); };
const pick = async (text) => { await ev(`[...document.querySelectorAll('#ctx-menu > .menu > li')].find(e => e.textContent.trim().startsWith(${JSON.stringify(text)}))?.click()`); await sleep(500); };
const count = () => ev("window.__lp.count()");
const alt = (k) => ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', altKey: true, bubbles: true, cancelable: true }))`).then(() => sleep(250));

// 版面
check("功能表列有 6 個項目", (await ev("document.querySelectorAll('#menubar .mb:not(.theme-btn):not(.lang-btn)').length")) === 6);
check("功能表文字含快捷字母", (await ev("[...document.querySelectorAll('#menubar .mb:not(.theme-btn):not(.lang-btn)')].map(b => b.textContent).join(' ')")) === "檔案(F) 插入(I) 編輯(E) 檢視(V) 工具(T) 說明(H)");
check("工具列仍有選擇資料來源、新增圖示、上一步、取消上一步、刪除、預覽列印、列印", await ev(["import-table", "add-text", "add-qr", "add-barcode", "add-rect", "add-line", "add-image", "undo-btn", "redo-btn", "delete", "preview-print", "print"].map((i) => `!!${$(i)}`).join(" && ")));
check("工具列只有一列（高度小於 60 px）", (await ev("document.querySelector('.toolbar').getBoundingClientRect().height")) < 60);
check("一開始上一步／取消上一步都是停用", (await ev(`${$("undo-btn")}.disabled && ${$("redo-btn")}.disabled`)));

// 插入
await click("menu-insert");
check("「插入」選單：文字、QR Code、條碼、矩形、線條、圖片", JSON.stringify(await labels()) === JSON.stringify(["文字", "QR Code", "條碼", "矩形", "線條", "圖片…"]), JSON.stringify(await labels()));
check("按下去的功能表按鈕有凹陷樣式", await ev(`${$("menu-insert")}.classList.contains('on')`));
await pick("文字"); await sleep(400);
check("插入 → 文字：畫布多一個物件", (await count()) === 1);
check("選單收起、按鈕恢復", !(await menuOpen()) && !(await ev(`${$("menu-insert")}.classList.contains('on')`)));
await click("menu-insert"); await pick("QR Code"); await sleep(400);
await click("menu-insert"); await pick("條碼"); await sleep(400);
await click("menu-insert"); await pick("矩形"); await click("menu-insert"); await pick("線條"); await sleep(400);
check("插入 QR、條碼、矩形、線條後共 5 個物件", (await count()) === 5, String(await count()));

// 上一步／取消上一步
await sleep(500);
check("新增後「上一步」可按、「取消上一步」仍停用", !(await ev(`${$("undo-btn")}.disabled`)) && (await ev(`${$("redo-btn")}.disabled`)));
await click("undo-btn"); await sleep(500);
check("按「上一步」→ 少一個物件", (await count()) === 4, String(await count()));
check("按過後「取消上一步」變可按", !(await ev(`${$("redo-btn")}.disabled`)));
await click("redo-btn"); await sleep(500);
check("按「取消上一步」→ 回到 5 個物件", (await count()) === 5, String(await count()));
check("取消上一步之後它又變停用", await ev(`${$("redo-btn")}.disabled`));

// 編輯（先在圖層清單選取一個物件）
await ev("document.querySelector('#layer-list li').click()"); await sleep(300);
await click("menu-edit");
let it = await items();
const byName = (n) => it.find((i) => i.t.startsWith(n));
check("「編輯」選單項目齊全", ["復原", "重做", "剪下", "複製", "貼上", "重複", "刪除", "屬性"].every((n) => byName(n)), JSON.stringify(it.filter((i) => !i.sep).map((i) => i.t)));
check("有選取物件：複製、刪除可用；沒複製過：貼上停用；沒有可重做：重做停用", !byName("複製").d && !byName("刪除").d && byName("貼上").d && byName("重做").d);
await pick("複製"); await click("menu-edit");
check("複製後貼上變可用", !(await items()).find((i) => i.t.startsWith("貼上")).d);
await pick("貼上"); await sleep(400);
check("編輯 → 貼上：多一個物件", (await count()) === 6, String(await count()));
await click("menu-edit"); await pick("刪除"); await sleep(400);
check("編輯 → 刪除：少一個物件", (await count()) === 5, String(await count()));
await click("menu-edit"); await pick("復原"); await sleep(500);
check("編輯 → 復原：刪除被還原", (await count()) === 6, String(await count()));

// 切換、再按收起、Esc
await click("menu-insert");
await ev(`${$("menu-tools")}.dispatchEvent(new MouseEvent('mouseenter'))`); await sleep(200);
check("開著功能表時滑到「工具」直接切換", (await labels())[0] === "變數測試資料…" && (await ev(`${$("menu-tools")}.classList.contains('on')`)) && !(await ev(`${$("menu-insert")}.classList.contains('on')`)));
await ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"); await sleep(150);
check("Esc 關閉功能表", !(await menuOpen()));
// 沒開著時滑過不會開
await ev(`${$("menu-edit")}.dispatchEvent(new MouseEvent('mouseenter'))`); await sleep(150);
check("沒有功能表開著時滑過不會開啟", !(await menuOpen()));
// 再按一次收起（以真實的 mousedown + click 順序）
const press = (id) => ev(`(() => { const b = ${$(id)}; for (const type of ['mousedown', 'mouseup', 'click']) b.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true })); })()`).then(() => sleep(200));
await press("menu-view");
check("按「檢視」開啟", await menuOpen());
await press("menu-view");
check("再按一次「檢視」收起", !(await menuOpen()));

// Alt 快捷鍵
const alts = [["f", "開啟新檔"], ["i", "文字"], ["e", "復原"], ["v", "預覽列印"], ["t", "變數測試資料"], ["h", "關於 Label Printer"]];
for (const [k, first] of alts) {
  await alt(k);
  check(`Alt+${k.toUpperCase()} 開啟對應的功能表（第一項「${first}」）`, (await labels())[0].startsWith(first), JSON.stringify((await labels())[0]));
  await ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"); await sleep(100);
}

// 檢視：側邊面板顯示／隱藏
await click("menu-view");
check("「檢視」選單：預覽列印、對齊線（✓）、側邊面板（✓）", JSON.stringify((await items()).filter((i) => !i.sep).map((i) => i.t)) === JSON.stringify(["預覽列印Ctrl+P", "對齊線（拖曳時吸附）✓", "側邊面板✓"]), JSON.stringify((await items()).map((i) => i.t)));
await pick("側邊面板");
check("取消勾選 → 側邊面板隱藏", await ev("document.querySelector('aside.panel').hidden"));
await click("menu-view"); await pick("側邊面板");
check("再選一次 → 側邊面板回來", !(await ev("document.querySelector('aside.panel').hidden")));
await click("menu-view"); await pick("預覽列印"); await sleep(600);
check("檢視 → 預覽列印：開啟預覽視窗", await ev("document.getElementById('pv-dialog').open"));
await ev("document.getElementById('pv-close').click()"); await sleep(300);

// 工具
await click("menu-tools");
check("「工具」選單：四個設定視窗、產生校正標籤、重新讀取資料來源（沒載入資料時停用）",
  JSON.stringify(await labels()) === JSON.stringify(["變數測試資料…", "紙張與標籤尺寸…", "列印品質與出紙…", "印表機…", "產生校正標籤", "重新讀取資料來源"]) && (await items()).find((i) => i.t.startsWith("重新讀取")).d, JSON.stringify(await labels()));
await ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"); await sleep(100);
check("側邊欄只剩「圖層」「選取物件」兩張卡片", JSON.stringify(await ev("JSON.stringify([...document.querySelectorAll('aside.panel .card > summary')].map(s => s.firstChild.textContent.trim()))").then(JSON.parse)) === JSON.stringify(["圖層", "選取物件"]));
const dlgs = [
  ["變數測試資料", "dlg-vars", ["vars", "vars-scan", "preview-btn"]],
  ["紙張與標籤尺寸", "dlg-paper", ["paper-w", "paper-h", "tpl-w", "tpl-h", "gap"]],
  ["列印品質與出紙", "dlg-quality", ["q-density", "q-speed", "q-shiftx", "q-shifty", "make-calibration"]],
  ["印表機", "dlg-printer", ["printer-mode", "printer-name", "host", "port"]],
];
for (const [name, id, fields] of dlgs) {
  await click("menu-tools"); await pick(name);
  check(`工具 → ${name}：開啟小視窗`, await ev(`${$(id)}.open`));
  check(`${name}視窗含欄位 ${fields.join("、")}`, await ev(fields.map((f) => `${$(id)}.contains(${$(f)})`).join(" && ")));
  check(`${name}視窗的欄位看得到（有尺寸）`, await ev(fields.slice(0, 1).map((f) => `${$(f)}.getBoundingClientRect().width > 0`).join(" && ")));
  await ev(`${$(id)}.querySelector('[data-dlg-close]').click()`); await sleep(200);
  check(`按「關閉」收起${name}視窗`, !(await ev(`${$(id)}.open`)));
}
// 視窗裡改設定仍然有效（欄位 id 與事件都沒變）
await click("menu-tools"); await pick("紙張與標籤尺寸");
await ev("(() => { const i = document.getElementById('tpl-w'); i.value = '55'; i.dispatchEvent(new Event('change', { bubbles: true })); })()"); await sleep(300);
check("在小視窗裡改標籤寬 → 設定與畫布說明同步", (JSON.parse(await ev("localStorage.getItem('label-printer.settings')")).tplWmm === 55) && (await ev("document.getElementById('stage-caption').textContent")).includes("55"));
await ev("document.getElementById('dlg-paper').close()"); await sleep(200);
// 校正標籤按鈕在「列印品質與出紙」視窗裡：按下去視窗會收起，才看得到畫布
await click("menu-tools"); await pick("列印品質與出紙");
await t.shot("2-quality-dialog");
await ev("document.getElementById('make-calibration').click()"); await sleep(1200);
check("視窗裡的「產生校正標籤」：視窗收起且畫布出現校正標籤", !(await ev("document.getElementById('dlg-quality').open")) && JSON.parse(await ev("JSON.stringify(window.__lp.konva.stages[0].find('.element').map(n => n.getAttr('label')))")).includes("外框"));

await click("menu-tools"); await pick("產生校正標籤"); await sleep(1200);
const cal = JSON.parse(await ev("JSON.stringify(window.__lp.konva.stages[0].find('.element').map(n => n.getAttr('label')))"));
check("工具 → 產生校正標籤：畫布出現外框與刻度", cal.includes("外框") && cal.includes("十字橫"), `${cal.length} 個物件`);
check("校正標籤之後「上一步」停用（新標籤，歷史重置）", await ev(`${$("undo-btn")}.disabled`));

// 檔案選單不再含校正標籤；說明
await click("file-menu");
check("「檔案」選單不含「產生校正標籤」", !(await labels()).some((l) => l.includes("校正")), JSON.stringify(await labels()));
await ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"); await sleep(100);
await click("help-menu");
check("「說明」選單：關於、第三方授權聲明、檢查新版本、新功能、啟動時自動檢查更新（預設打勾）", JSON.stringify(await labels()) === JSON.stringify(["關於 Label Printer", "第三方授權聲明", "檢查新版本", "新功能", "啟動時自動檢查更新✓"]));
await t.shot("1-bar");
await ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"); await sleep(100);

// ---------- 外觀：自動／亮／暗（燈泡按鈕） ----------
const theme = () => ev("JSON.stringify({ attr: document.documentElement.getAttribute('data-theme'), tag: document.querySelector('#theme-btn .theme-tag').textContent, bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(), saved: localStorage.getItem('label-printer.theme') })").then(JSON.parse);
const t0 = await theme();
check("預設：自動（A），不寫 data-theme，也沒有儲存值", t0.attr === null && t0.tag === "A" && t0.saved === null, JSON.stringify(t0));
await click("theme-btn");
const t1 = await theme();
check("按一下 → 亮：標籤「亮」、data-theme=light、已記住", t1.attr === "light" && t1.tag === "亮" && t1.saved === "light" && t1.bg === "#eceff3", JSON.stringify(t1));
await click("theme-btn");
const t2 = await theme();
check("再按 → 暗：標籤「暗」、data-theme=dark、背景色改變、已記住", t2.attr === "dark" && t2.tag === "暗" && t2.saved === "dark" && t2.bg === "#12161c", JSON.stringify(t2));
await t.shot("3-dark");
await click("theme-btn");
const t3 = await theme();
check("再按 → 回到自動（A）", t3.attr === null && t3.tag === "A" && t3.saved === "auto", JSON.stringify(t3));
check("按鈕的提示文字說明目前狀態與下一步", (await ev("document.getElementById('theme-btn').title")).includes("自動") && (await ev("document.getElementById('theme-btn').title")).includes("亮色"));
// 重新載入後沿用上次的選擇
await click("theme-btn"); await click("theme-btn"); // → 亮 → 暗
await ev("location.reload()");
for (let i = 0; i < 40 && !(await ev("!!window.__lp && !!document.querySelector('#stage canvas')").catch(() => false)); i++) await sleep(250);
const t4 = await theme();
check("重新載入後仍是上次選的「暗」", t4.attr === "dark" && t4.tag === "暗", JSON.stringify(t4));
await t.finish();
