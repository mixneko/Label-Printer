// 回歸測試：自動更新（Tauri updater 外掛）。以模擬的 plugin:updater|check / download_and_install 驗證：
// 手動檢查、立即更新（下載進度、完成、失敗）、免安裝版退回開下載頁、啟動時自動檢查與開關。
//   node scripts/ui-update.mjs [輸出資料夾=.tools]
import { launch } from "./_cdp.mjs";
const MOCK = `(() => {
  let n = 0; const cbs = {}; window.__cbs = cbs; window.__log = [];
  const ls = (k, d) => { try { const v = localStorage.getItem('t.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } };
  window.__TAURI_INTERNALS__ = { transformCallback: (cb) => { const id = ++n; cbs[id] = cb; return id; }, invoke: async (cmd, args) => {
    if (cmd === 'plugin:app|version') return '0.9.8';
    if (cmd === 'is_installed') return ls('installed', true);
    if (cmd === 'open_url') { window.__log.push(['open_url', args.url]); return null; }
    if (cmd === 'plugin:updater|check') { if (ls('checkErr', false)) throw 'offline'; return ls('upd', null); }
    if (cmd === 'plugin:updater|download_and_install') {
      window.__log.push(['install', args.rid]);
      const ch = cbs[args.onEvent.id]; let i = 0; const emit = (event, data) => ch({ message: { event, data }, index: i++ });
      emit('Started', { contentLength: 100 }); emit('Progress', { chunkLength: 50 });
      await new Promise((r) => { window.__finish = r; });
      if (ls('dlFail', false)) throw 'boom';
      emit('Finished', {}); return null;
    }
    if (cmd === 'list_printers') return ['TSC']; if (cmd === 'list_fonts') return ['Microsoft JhengHei'];
    return null; } };
})();`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "update" });
const { ev, sleep, check } = t;
const UPD = { rid: 7, currentVersion: "0.9.8", version: "0.9.9", date: "", body: "", rawJson: {} };
const setT = (k, v) => ev(`localStorage.setItem('t.${k}', ${JSON.stringify(JSON.stringify(v))})`);
const msg = () => ev("document.getElementById('update-msg').textContent");
const hid = (id) => ev(`document.getElementById('${id}').hidden`);
const menu = async (label) => { await ev("document.getElementById('help-menu').click()"); await sleep(250);
  await ev(`[...document.querySelectorAll('#ctx-menu [role=menuitem]')].find(e => e.textContent.trim().startsWith(${JSON.stringify(label)}))?.click()`); await sleep(600); };
const close = async () => { await ev("document.getElementById('update-close').click()"); await sleep(150); };

// ---- 手動檢查：有新版 → 立即更新 ----
await setT("upd", UPD);
await menu("檢查新版本");
check("安裝版有新版：提示並出現「立即更新」", (await msg()) === "有新版本 0.9.9（目前 0.9.8）。要現在更新嗎？" && !(await hid("update-install")) && (await hid("update-go")), await msg());
await ev("document.getElementById('update-install').click()"); await sleep(500);
check("下載中：顯示進度 50%、立即更新鈕收起、關閉鈕停用", (await msg()) === "正在下載更新… 50%" && (await hid("update-install")) && (await ev("document.getElementById('update-close').disabled")), await msg());
check("呼叫了 download_and_install（rid 7）", JSON.stringify(await ev("window.__log.filter(x => x[0] === 'install')")) === JSON.stringify([["install", 7]]));
await ev("window.__finish()"); await sleep(400);
check("下載完成：顯示正在安裝", (await msg()).startsWith("下載完成，正在安裝"), await msg());
await ev("document.getElementById('update-close').disabled = false"); await close();

// ---- 下載失敗：顯示原因並提供前往下載頁面 ----
await setT("dlFail", true);
await menu("檢查新版本");
await ev("document.getElementById('update-install').click()"); await sleep(400);
await ev("window.__finish()"); await sleep(400);
check("下載失敗：顯示失敗原因、可前往下載頁面、可關閉", (await msg()) === "更新失敗：boom" && !(await hid("update-go")) && !(await ev("document.getElementById('update-close').disabled")), await msg());
await close(); await setT("dlFail", false);

// ---- 已是最新 / 查詢失敗 / 免安裝版 ----
await setT("upd", null);
await menu("檢查新版本");
check("安裝版沒有新版：已是最新版本", (await msg()) === "目前已是最新版本（0.9.8）" && (await hid("update-install")), await msg());
await close();
await setT("checkErr", true);
await ev("window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ tag_name: 'v0.9.9', html_url: 'https://github.com/mixneko/Label-Printer/releases/tag/v0.9.9' }) })");
await menu("檢查新版本");
check("updater 查不到（沒有 latest.json）：退回 GitHub API，提供前往下載頁面", (await msg()) === "有新版本 0.9.9（目前 0.9.8）" && !(await hid("update-go")) && (await hid("update-install")), await msg());
await close(); await setT("checkErr", false);
await setT("installed", false); await setT("upd", UPD);
await menu("檢查新版本");
check("免安裝版：不用 updater，只提供前往下載頁面", !(await hid("update-go")) && (await hid("update-install")), await msg());
await close();

// ---- 啟動時自動檢查 ----
await setT("installed", true);
await ev("location.reload()"); await sleep(5000);
check("啟動時自動檢查（預設開）：有新版就跳出更新視窗", (await ev("document.getElementById('update-dialog').open")) && !(await hid("update-install")), await msg());
await ev("document.getElementById('update-close').click()"); await sleep(150);

await ev("document.getElementById('help-menu').click()"); await sleep(250);
const items = JSON.parse(await ev("JSON.stringify([...document.querySelectorAll('#ctx-menu [role=menuitem]')].map(e => e.textContent.trim()))"));
check("「說明」選單有「啟動時自動檢查更新」且預設打勾", items.some((s) => s.startsWith("啟動時自動檢查更新") && s.includes("✓")), JSON.stringify(items));
await menu("啟動時自動檢查更新");
check("按下後關閉自動檢查（記住）", (await ev("localStorage.getItem('label-printer.autocheck')")) === "off");
await ev("location.reload()"); await sleep(5000);
check("關閉後：啟動時不再檢查、不跳視窗", !(await ev("document.getElementById('update-dialog').open")));
await menu("啟動時自動檢查更新");
check("再按一次重新開啟", (await ev("localStorage.getItem('label-printer.autocheck')")) === "on");

// ---- 免安裝版啟動時不自動檢查 ----
await setT("installed", false);
await ev("location.reload()"); await sleep(5000);
check("免安裝版啟動時不自動檢查", !(await ev("document.getElementById('update-dialog').open")));
await t.finish();
