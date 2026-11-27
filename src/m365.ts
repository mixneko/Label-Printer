// 網頁版 Excel 的連線視窗：貼網址或點最近用過的檔案 →（需要時跳出登入視窗）→ 資料出現在下方資料表。

import { t } from "./i18n";
import { logoutWeb, removeWebRecent, webRecents } from "./websync";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface M365DialogApi {
  /** 載入網頁版試算表（table.ts 的 loadWeb）；失敗時丟出可直接顯示的訊息，report 附回報用資訊 */
  load(url: string): Promise<void>;
  /** 登出後：目前如果正在用網頁版資料，停止自動更新 */
  loggedOut(): void;
}

/** 載入失敗：訊息之外附上回報用資訊 */
export class WebError extends Error {
  constructor(message: string, readonly report: string[] = []) {
    super(message);
  }
}

let api: M365DialogApi;
let busy = false;

function say(message: string, error = false): void {
  const el = $("m365-msg");
  el.textContent = message;
  el.classList.toggle("err", error);
}

function setBusy(on: boolean): void {
  busy = on;
  for (const el of document.querySelectorAll<HTMLButtonElement>("#dlg-m365 .dlg-body button, #m365-logout")) el.disabled = on;
}

function renderRecent(): void {
  const list = webRecents();
  $("m365-recent-box").hidden = list.length === 0;
  $("m365-recent").replaceChildren(...list.map((r) => {
    const li = document.createElement("li");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "btn sm m365-open";
    open.textContent = r.name || r.url;
    open.title = r.url;
    open.addEventListener("click", () => void connect(r.url));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn sm";
    del.textContent = "✕";
    del.title = t("從清單移除");
    del.addEventListener("click", () => { removeWebRecent(r.url); renderRecent(); });
    li.append(open, del);
    return li;
  }));
}

async function connect(url: string): Promise<void> {
  if (busy) return;
  setBusy(true);
  $("m365-report-box").hidden = true;
  say(t("連線中…需要登入時會跳出視窗，登入完就會自動收起來。"));
  try {
    await api.load(url.trim());
    say("");
    $<HTMLDialogElement>("dlg-m365").close();
  } catch (e) {
    say(e instanceof Error ? e.message : String(e), true);
    const report = e instanceof WebError ? e.report : [];
    $("m365-report").textContent = report.join("\n");
    $("m365-report-box").hidden = report.length === 0;
  } finally {
    setBusy(false);
  }
}

/** 開啟對話框；帶網址（從最近清單點選）時直接連線 */
export function openM365Dialog(url?: string): void {
  const dlg = $<HTMLDialogElement>("dlg-m365");
  say("");
  $("m365-report-box").hidden = true;
  renderRecent();
  if (!dlg.open) dlg.showModal();
  if (url) {
    $<HTMLInputElement>("m365-url").value = url;
    void connect(url);
  }
}

export function initM365Dialog(a: M365DialogApi): void {
  api = a;
  $("m365-connect").addEventListener("click", () => void connect($<HTMLInputElement>("m365-url").value));
  $("m365-url").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    void connect($<HTMLInputElement>("m365-url").value);
  });
  $("m365-logout").addEventListener("click", async () => {
    if (busy) return;
    setBusy(true);
    try {
      await logoutWeb();
      api.loggedOut();
      say(t("已登出，這台電腦上的登入資料已清除。"));
    } catch (e) {
      say(String(e), true);
    } finally {
      setBusy(false);
    }
  });
  $("m365-copy").addEventListener("click", () => void navigator.clipboard.writeText($("m365-report").textContent ?? "").catch(() => {}));
}
