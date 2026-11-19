/**
 * 「說明」選單：檢查新版本、新功能。
 * 檢查新版本只在使用者按下時才連線（不會在背景自動連網）；查詢 GitHub 的最新 release，
 * 以「前往下載頁面」用預設瀏覽器開啟（Rust 端 `open_url` 只放行本專案的網址）。
 * 「新功能」：更新後第一次開啟自動顯示一次（記住上次看過的版本），之後可從「說明 → 新功能」再看。
 */
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
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

function setUpdateState(msg: string, canDownload: boolean): void {
  document.getElementById("update-msg")!.textContent = msg;
  (document.getElementById("update-go") as HTMLButtonElement).hidden = !canDownload;
}

export async function checkForUpdate(): Promise<void> {
  releaseUrl = "";
  setUpdateState(t("正在檢查新版本…"), false);
  open("update-dialog");
  const cur = await currentVersion();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    const res = await fetch(API, { headers: { Accept: "application/vnd.github+json" }, signal: ctl.signal });
    clearTimeout(timer);
    if (res.status === 404) { setUpdateState(t("找不到已發布的版本。"), false); return; }
    if (!res.ok) throw new Error(String(res.status));
    const j = (await res.json()) as { tag_name?: string; html_url?: string };
    const latest = (j.tag_name || "").replace(/^v/i, "");
    if (!latest) throw new Error("no tag");
    if (cur && compareVersions(latest, cur) <= 0) {
      setUpdateState(t("目前已是最新版本（{v}）", { v: cur }), false);
    } else {
      releaseUrl = j.html_url || `https://github.com/${REPO}/releases/latest`;
      setUpdateState(t("有新版本 {latest}（目前 {cur}）", { latest, cur: cur || "?" }), true);
    }
  } catch {
    setUpdateState(t("無法檢查新版本，請確認網路連線後再試。"), false);
  }
}

document.getElementById("update-go")!.addEventListener("click", () => {
  if (releaseUrl) void invoke("open_url", { url: releaseUrl }).catch(() => { /* 開不了就算了 */ });
});
document.getElementById("update-close")!.addEventListener("click", () => dlg("update-dialog").close());

// ---------- 新功能 ----------
/** 由新到舊。每個版本一組說明；文字用 N 標記進翻譯表，顯示時才 t()。 */
const NOTES: Array<{ version: string; items: string[] }> = [
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

function lastSeen(): string { try { return localStorage.getItem(SEEN_KEY) || ""; } catch { return ""; } }
function markSeen(v: string): void { try { localStorage.setItem(SEEN_KEY, v); } catch { /* ignore */ } }

/** 啟動時呼叫：版本比上次看過的新就顯示新功能；第一次安裝（沒有記錄）只記錄、不打擾。 */
export async function maybeShowWhatsNew(): Promise<void> {
  const cur = await currentVersion();
  if (!cur) return;
  const seen = lastSeen();
  markSeen(cur);
  if (!seen || compareVersions(cur, seen) <= 0) return;
  const list = notesBetween(seen, cur);
  if (!list.length) return;
  renderNotes(list);
  open("whatsnew-dialog");
}

document.getElementById("whatsnew-close")!.addEventListener("click", () => dlg("whatsnew-dialog").close());
