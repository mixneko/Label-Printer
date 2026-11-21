// 回歸測試：多國語系機制（語言切換、靜態 HTML 與動態文字、含標記的整段、還原、缺翻譯退回原文）。
//   node scripts/ui-i18n.mjs [輸出資料夾=.tools]
import { launch } from "./_cdp.mjs";
const MOCK = `window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd) => {
  if (cmd === 'list_printers') return ['TSC']; if (cmd === 'list_fonts') return ['Microsoft JhengHei'];
  return null; } };`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "i18n" });
const { ev, sleep, check } = t;
const txt = (id) => ev(`document.getElementById('${id}').textContent.trim()`);
const attr = (id, a) => ev(`document.getElementById('${id}').getAttribute('${a}')`);
const lang = (l) => ev(`window.__lp.i18n.changeLang('${l}')`);
const menuLabels = (id) => ev(`(async () => { document.getElementById('${id}').click(); await new Promise(r => setTimeout(r, 250));
  const r = [...document.querySelectorAll('#ctx-menu [role=menuitem]')].map(e => e.textContent.trim()); document.body.click(); return r; })()`);

check("預設語言是繁體中文，畫面文字維持原文", (await txt("file-menu")) === "檔案(F)" && (await txt("tpl-name")) === "未命名標籤");
check("<html lang> 是 zh-TW", (await ev("document.documentElement.lang")) === "zh-TW");
const langs = await menuLabels("lang-btn");
check("功能表列右側的地球按鈕直接列出七種語言（自己的文字），目前語言打勾", langs.length === 7 && langs.find((l) => l.startsWith("繁體中文")).includes("✓") && langs.includes("한국어"), JSON.stringify(langs));
check("語言順序與安裝程式一致：Deutsch、English、Español、简体中文、繁體中文、日本語、한국어", JSON.stringify(langs.map((l) => l.replace(/\s*✓/, ""))) === JSON.stringify(["Deutsch", "English", "Español", "简体中文", "繁體中文", "日本語", "한국어"]), JSON.stringify(langs));
check("地球按鈕顯示目前語言簡稱，切換後更新", (await ev("document.querySelector('#lang-btn .lang-tag').textContent")) === "繁");

await lang("en");
check("en：選單按鈕換成 File，(F) 保留", (await txt("file-menu")) === "File(F)", await txt("file-menu"));
check("en：一般文字（未命名標籤）", (await txt("tpl-name")) === "Untitled label", await txt("tpl-name"));
check("en：按鈕裡的文字", (await txt("import-table")) === "Choose data source");
check("en：title 屬性", (await attr("add-text", "title")) === "Add text");
check("en：placeholder 屬性", (await attr("prop-font", "placeholder")) === "Enter a font name…");
check("en：含 <b>／<code> 的整段說明整句翻譯並保留標記", await ev(`(() => { const p = document.querySelector('#dlg-vars details.help p');
  return p.textContent.startsWith('A variable is a spot') && p.querySelector('b') && p.querySelector('code').textContent === '{{SerialNo}}'; })()`));
check("en：textarea 的 placeholder 保留換行", (await attr("vars", "placeholder")) === "SerialNo=SN-0001\nModel=MODEL-A");
check("en：<html lang> 跟著變成 en", (await ev("document.documentElement.lang")) === "en");
check("en：選擇記在 localStorage", (await ev("localStorage.getItem('label-printer.lang')")) === "en");
check("en：t() 取代 {佔位}", (await ev("window.__lp.i18n.t('已儲存：{path}', { path: 'a.lpxl' })")) === "Saved: a.lpxl");
check("en：動態建立的選單（編輯）用翻譯", (await menuLabels("menu-edit")).some((s) => s.startsWith("Paste")));
check("en：外觀按鈕提示換語言", (await attr("theme-btn", "title")).startsWith("Appearance:"), await attr("theme-btn", "title"));
await lang("en");
check("en：地球按鈕簡稱 EN", (await ev("document.querySelector('#lang-btn .lang-tag').textContent")) === "EN");
check("重複切換同一語言結果不變", (await txt("file-menu")) === "File(F)");

await lang("zh-CN");
check("zh-CN：選單、按鈕、整段說明", (await txt("file-menu")) === "文件(F)" && (await txt("import-table")) === "选择数据源"
  && (await ev("document.querySelector('#dlg-vars details.help p code').textContent")) === "{{序号}}");
check("zh-CN：<html lang> = zh-CN", (await ev("document.documentElement.lang")) === "zh-CN");

// 尚無翻譯表的語言：全部退回繁體中文原文（不會空白、不會出現鍵名以外的東西）
await lang("es");
check("es：選單與按鈕", (await txt("file-menu")) === "Archivo(F)" && (await txt("import-table")) === "Elegir origen de datos");
check("de：選單與按鈕", (await (async () => { await lang("de"); return (await txt("file-menu")) === "Datei(F)" && (await txt("import-table")) === "Datenquelle wählen"; })()));
check("ja：選單與按鈕", (await (async () => { await lang("ja"); return (await txt("file-menu")) === "ファイル(F)" && (await txt("import-table")) === "データソースを選択"; })()));
check("ko：選單與按鈕", (await (async () => { await lang("ko"); return (await txt("file-menu")) === "파일(F)" && (await txt("import-table")) === "데이터 원본 선택"; })()));
check("ko：<html lang> = ko", (await ev("document.documentElement.lang")) === "ko");

// 缺翻譯的字串（這裡暫時刪掉 en 的兩個鍵）：退回繁體中文原文，其他照常翻譯
await ev(`(() => { const { LOCALES } = window.__lp.i18n; delete LOCALES.en["檔案"]; delete LOCALES.en["新增文字"]; })()`);
await lang("en");
check("缺翻譯的字串退回原文，其他仍是英文", (await txt("file-menu")) === "檔案(F)" && (await attr("add-text", "title")) === "新增文字" && (await txt("import-table")) === "Choose data source");

await lang("zh-TW");
check("切回 zh-TW：文字、title、整段說明都還原", (await txt("file-menu")) === "檔案(F)" && (await txt("import-table")) === "選擇資料來源"
  && (await attr("import-table", "title")).startsWith("選擇資料來源：載入") && (await ev("document.querySelector('#dlg-vars details.help p').textContent.startsWith('變數就是')")));
check("t() 缺翻譯時仍會替換佔位", (await ev("window.__lp.i18n.t('已載入資料來源：{n} 筆資料，勾選要列印的列', { n: 3 })")) === "已載入資料來源：3 筆資料，勾選要列印的列");
const det = (a) => ev(`window.__lp.i18n.detectLang(${JSON.stringify(a)})`);
const cases = [[["zh-TW"], "zh-TW"], [["zh-HK"], "zh-TW"], [["zh-CN"], "zh-CN"], [["zh-Hans-CN"], "zh-CN"], [["zh"], "zh-TW"],
  [["en-US"], "en"], [["es-MX"], "es"], [["de-AT"], "de"], [["ja"], "ja"], [["ko-KR"], "ko"], [["fr-FR", "de-DE"], "de"], [["fr-FR"], "en"], [[], "en"]];
let ok = true; const bad = [];
for (const [a, exp] of cases) { const got = await det(a); if (got !== exp) { ok = false; bad.push(`${a}→${got}`); } }
check("依系統語言挑選：簡繁中文、英西德日韓、第二偏好、不支援時退回英文", ok, bad.join(", "));
await t.finish();
