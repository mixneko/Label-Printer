/**
 * 「說明」選單：檢查新版本、新功能；啟動時自動檢查更新。
 * 安裝版：用 Tauri updater 外掛查 GitHub release 的 latest.json，有新版就跳出「立即更新」，
 * 程式內下載（簽章驗證通過才安裝）→ 靜默安裝 → 自動重開。啟動時自動檢查預設開啟、可在「說明」選單關閉；
 * 這是程式唯一會自己連網的地方（只問 GitHub 有沒有新版，不傳送任何資料）。
 * 免安裝版無法原地更新，維持舊做法：查 GitHub API，以「前往下載頁面」用預設瀏覽器開啟（Rust 端 `open_url` 只放行本專案的網址）。
 * 「新功能」：更新後第一次開啟自動顯示一次（記住上次看過的版本），之後可從「說明 → 新功能」再看。
 */
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { check as checkUpdater, type Update } from "@tauri-apps/plugin-updater";
import { N, t } from "./i18n";

const REPO = "mixneko/Label-Printer";
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const SEEN_KEY = "label-printer.whatsnew-seen";

/** 版本比較（1.2.3 形式；多出的段視為 0）。a>b 回傳正數。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, "").split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/i, "").split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

async function currentVersion(): Promise<string> {
  try { return (await getVersion()) || ""; } catch { return ""; } // 非 Tauri 環境沒有版本資訊
}

const dlg = (id: string) => document.getElementById(id) as HTMLDialogElement;
const open = (id: string) => { const d = dlg(id); if (!d.open) d.showModal(); };

// ---------- 檢查新版本 ----------
let releaseUrl = "";
let pending: Update | null = null;
const AUTO_KEY = "label-printer.autocheck";

export function autoCheckEnabled(): boolean { try { return localStorage.getItem(AUTO_KEY) !== "off"; } catch { return true; } }
export function setAutoCheck(on: boolean): void { try { localStorage.setItem(AUTO_KEY, on ? "on" : "off"); } catch { /* ignore */ } }

const btn = (id: string) => document.getElementById(id) as HTMLButtonElement;

function setUpdateState(msg: string, opts: { download?: boolean; install?: boolean } = {}): void {
  document.getElementById("update-msg")!.textContent = msg;
  btn("update-go").hidden = !opts.download;
  btn("update-install").hidden = !opts.install;
}

/** 是不是安裝版（免安裝版無法原地更新）；非 Tauri 環境當作否 */
async function isInstalled(): Promise<boolean> {
  try { return (await invoke<boolean>("is_installed")) === true; } catch { return false; }
}

/** 用 updater 外掛查詢；有新版回傳 Update，沒有回傳 null；失敗丟出例外 */
async function queryUpdater(): Promise<Update | null> {
  return checkUpdater({ timeout: 10000 });
}

function offerInstall(u: Update, cur: string): void {
  pending = u;
  setUpdateState(t("有新版本 {latest}（目前 {cur}）。要現在更新嗎？", { latest: u.version, cur: cur || "?" }), { install: true });
  open("update-dialog");
}

export async function checkForUpdate(): Promise<void> {
  releaseUrl = "";
  pending = null;
  setUpdateState(t("正在檢查新版本…"));
  open("update-dialog");
  const cur = await currentVersion();
  if (await isInstalled()) {
    try {
      const u = await queryUpdater();
      if (u) offerInstall(u, cur);
      else setUpdateState(t("目前已是最新版本（{v}）", { v: cur }));
      return;
    } catch { /* 查不到 latest.json（例如該版本沒有附）就退回下面的查詢方式 */ }
  }
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    const res = await fetch(API, { headers: { Accept: "application/vnd.github+json" }, signal: ctl.signal });
    clearTimeout(timer);
    if (res.status === 404) { setUpdateState(t("找不到已發布的版本。")); return; }
    if (!res.ok) throw new Error(String(res.status));
    const j = (await res.json()) as { tag_name?: string; html_url?: string };
    const latest = (j.tag_name || "").replace(/^v/i, "");
    if (!latest) throw new Error("no tag");
    if (cur && compareVersions(latest, cur) <= 0) {
      setUpdateState(t("目前已是最新版本（{v}）", { v: cur }));
    } else {
      releaseUrl = j.html_url || `https://github.com/${REPO}/releases/latest`;
      setUpdateState(t("有新版本 {latest}（目前 {cur}）", { latest, cur: cur || "?" }), { download: true });
    }
  } catch {
    setUpdateState(t("無法檢查新版本，請確認網路連線後再試。"));
  }
}

/** 啟動時在背景檢查一次：有新版才跳出視窗，沒有或失敗都不出聲 */
export async function autoCheckOnStartup(): Promise<void> {
  if (!autoCheckEnabled() || !(await isInstalled())) return;
  await new Promise((r) => setTimeout(r, 3000)); // 等畫面與「新功能」先處理完
  if (document.querySelector("dialog[open]")) return; // 使用者正在操作視窗就不打擾
  try {
    const u = await queryUpdater();
    if (u && !document.querySelector("dialog[open]")) { releaseUrl = ""; offerInstall(u, await currentVersion()); }
  } catch { /* 沒網路等情況：安靜略過 */ }
}

async function installPending(): Promise<void> {
  const u = pending;
  if (!u) return;
  btn("update-install").hidden = true;
  btn("update-close").disabled = true;
  let total = 0, got = 0;
  setUpdateState(t("正在下載更新…"));
  try {
    await u.downloadAndInstall((e) => {
      if (e.event === "Started") total = e.data.contentLength ?? 0;
      else if (e.event === "Progress") {
        got += e.data.chunkLength;
        if (total > 0) setUpdateState(t("正在下載更新… {pct}%", { pct: Math.min(100, Math.round((got / total) * 100)) }));
      } else if (e.event === "Finished") setUpdateState(t("下載完成，正在安裝。程式會自動關閉並重新開啟…"));
    });
    // Windows 安裝程式會接手並重新開啟程式；走到這裡表示還沒被關閉，訊息維持原樣
  } catch (err) {
    releaseUrl = `https://github.com/${REPO}/releases/latest`;
    setUpdateState(t("更新失敗：{err}", { err: String(err) }), { download: true });
    btn("update-close").disabled = false;
  }
}

btn("update-install").addEventListener("click", () => void installPending());
document.getElementById("update-go")!.addEventListener("click", () => {
  if (releaseUrl) void invoke("open_url", { url: releaseUrl }).catch(() => { /* 開不了就算了 */ });
});
document.getElementById("update-close")!.addEventListener("click", () => dlg("update-dialog").close());

// ---------- 新功能 ----------
/** 由新到舊。每個版本一組說明；文字用 N 標記進翻譯表，顯示時才 t()。 */
const NOTES: Array<{ version: string; items: string[] }> = [
  { version: "0.9.8", items: [
    N("新增自動更新：啟動時自動檢查新版（可在「說明」選單關閉），安裝版有新版時可直接在程式內下載並更新"),
  ] },
  { version: "0.9.7", items: [
    N("校正標籤的說明文字改為固定在標籤範圍內、太長時自動縮小字級，各語言都不會再被切掉或蓋到刻度"),
  ] },
  { version: "0.9.6", items: [
    N("支援多選：按住 Ctrl 或 Shift 點選、在空白處拖曳框選、Ctrl+A 全選，可一起移動、縮放、對齊、複製、刪除"),
    N("新增「群組」與「取消群組」（Ctrl+G／Ctrl+Shift+G），群組會存進標籤檔"),
    N("按鈕的說明改成自製提示，滑鼠停在上面不久就會顯示"),
  ] },
  { version: "0.9.5", items: [
    N("圖層面板版面整理：對齊按鈕在清單上方，置頂／上移／下移／置底移到清單下方，按鈕固定單列不再亂換行"),
  ] },
  { version: "0.9.4", items: [
    N("圖層面板新增「靠左對齊／置中對齊／靠右對齊」按鈕，一鍵對齊標籤"),
    N("右鍵選單的子選單靠近視窗下緣時不再被切掉"),
  ] },
  { version: "0.9.3", items: [
    N("「說明」選單新增「檢查新版本」，可查詢是否有新版本並前往下載頁面"),
    N("更新後第一次開啟會顯示「新功能」，之後也能從「說明 → 新功能」查看"),
  ] },
  { version: "0.9.2", items: [N("語言選單移到功能表列右側的地球按鈕，一鍵切換")] },
  { version: "0.9.1", items: [N("系統語言不在支援清單時，預設使用英文"), N("安裝程式可選擇七種語言")] },
  { version: "0.9.0", items: [
    N("介面支援繁體中文、简体中文、English、Español、Deutsch、日本語、한국어"),
    N("第一次啟動時依系統語言自動選擇語言"),
  ] },
];

/** `since` 之後（不含）到 `upTo`（含）的說明；since 為空＝全部 */
export function notesBetween(since: string, upTo: string): typeof NOTES {
  return NOTES.filter((n) => (!upTo || compareVersions(n.version, upTo) <= 0) && (!since || compareVersions(n.version, since) > 0));
}

function renderNotes(list: typeof NOTES): void {
  const box = document.getElementById("whatsnew-body")!;
  box.replaceChildren();
  for (const n of list) {
    const h = document.createElement("h3");
    h.textContent = t("版本 {v}", { v: n.version });
    const ul = document.createElement("ul");
    for (const it of n.items) { const li = document.createElement("li"); li.textContent = t(it); ul.append(li); }
    box.append(h, ul);
  }
}

export async function showWhatsNew(): Promise<void> {
  const cur = await currentVersion();
  const list = notesBetween("", cur);
  renderNotes(list.length ? list : NOTES);
  open("whatsnew-dialog");
}

/**
 * 程式一載入（還沒寫入任何設定前）就先記下「這台電腦以前用過本程式」：舊版（0.8.7 以前）沒有「看過的版本」記錄，
 * 但一定留有設定；這種人更新後要看到完整的新功能，不能當成全新安裝而什麼都不顯示。
 */
const HAD_SETTINGS = (() => { try { return localStorage.getItem("label-printer.settings") !== null; } catch { return false; } })();
/** 沒有記錄的老使用者視為從這個版本升上來（GitHub 最早的公開版本） */
const BASELINE = "0.8.7";

function lastSeen(): string { try { return localStorage.getItem(SEEN_KEY) || ""; } catch { return ""; } }
function markSeen(v: string): void { try { localStorage.setItem(SEEN_KEY, v); } catch { /* ignore */ } }

/** 啟動時呼叫：版本比上次看過的新就顯示新功能；第一次安裝（沒有記錄）只記錄、不打擾。 */
export async function maybeShowWhatsNew(): Promise<void> {
  const cur = await currentVersion();
  if (!cur) return;
  const seen = lastSeen() || (HAD_SETTINGS ? BASELINE : "");
  markSeen(cur);
  if (!seen || compareVersions(cur, seen) <= 0) return;
  if (!notesBetween(seen, cur).length) return; // 這次沒有新的說明就不打擾
  // 顯示完整歷史（由新到舊堆疊），跳版升級的人才看得到中間每一版改了什麼
  renderNotes(notesBetween("", cur));
  open("whatsnew-dialog");
}

document.getElementById("whatsnew-close")!.addEventListener("click", () => dlg("whatsnew-dialog").close());
