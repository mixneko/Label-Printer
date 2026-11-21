// 「連線到資料庫」對話框：SQLite／Access 檔案、SQL Server／MySQL／PostgreSQL（程式內建的用戶端直接連線，不需要驅動程式），
// 或其他 ODBC 連線字串，可選填一個 SELECT 查詢。密碼只留在記憶體：畫面上顯示的來源名稱不含帳號與密碼，也不寫入 localStorage。

import { invoke } from "./ipc";
import { open } from "@tauri-apps/plugin-dialog";
import { t } from "./i18n";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface DbDialogApi {
  /** 載入資料來源（table.ts 的 loadSource） */
  load(path: string, sheet: string | undefined, label: string): Promise<void>;
}

let api: DbDialogApi;

/** 把連線字串裡的帳號與密碼拿掉（顯示用）；只留下驅動程式、主機、資料庫這類資訊 */
export function stripCredentials(cs: string): string {
  return cs.replace(/\b(pwd|password|uid|user id|user)\s*=\s*[^;]*;?/gi, "");
}

/** 畫面上顯示的來源名稱：ODBC 顯示去掉帳號密碼的連線字串（太長就截短）；檔案由 table.ts 用檔名 */
export function sourceLabelOf(cs: string): string {
  const m = stripCredentials(cs.trim().replace(/\s+/g, " "));
  return `ODBC · ${m.length > 80 ? m.slice(0, 77) + "…" : m}`;
}

type Kind = "file" | "sqlserver" | "mysql" | "postgres" | "odbc";
const kindNow = (): Kind => $<HTMLSelectElement>("db-kind").value as Kind;
const SERVER_KINDS: Kind[] = ["sqlserver", "mysql", "postgres"];

function applyKind(): void {
  const k = kindNow();
  $("db-file-fields").hidden = k !== "file";
  $("db-server-fields").hidden = !SERVER_KINDS.includes(k);
  $("db-odbc-fields").hidden = k !== "odbc";
  $("db-winauth-row").hidden = k !== "sqlserver";
  syncCred();
}

function syncCred(): void {
  $("db-cred").hidden = kindNow() === "sqlserver" && $<HTMLInputElement>("db-winauth").checked;
}

// ---- 伺服器型資料庫：SQL Server、MySQL／MariaDB、PostgreSQL 由程式內建的用戶端直接連線，不需要 ODBC 驅動程式 ----
const KIND_NAME: Record<string, string> = { sqlserver: "SQL Server", mysql: "MySQL", postgres: "PostgreSQL" };
const NET_KIND: Record<string, string> = { sqlserver: "mssql", mysql: "mysql", postgres: "postgres" };

/** 後端 `net:` 來源字串（JSON）。密碼只在這個字串裡，只存在記憶體 */
export function buildNetSource(kind: Kind, f: { host: string; port: string; name: string; user: string; pass: string; winauth: boolean; security: string }): string {
  const port = Number(f.port.trim());
  return "net:" + JSON.stringify({
    kind: NET_KIND[kind], host: f.host.trim(), port: Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined,
    database: f.name.trim(), user: f.user, password: f.pass, winauth: kind === "sqlserver" && f.winauth, security: f.security,
  });
}

/** 畫面上顯示的來源名稱：不含帳號與密碼 */
export function netLabel(kind: Kind, host: string, name: string): string {
  return `${KIND_NAME[kind]} · ${host.trim()} / ${name.trim()}`;
}

const REMEMBER = "label-printer.db-last";
function loadLast(): void {
  try {
    const v = JSON.parse(localStorage.getItem(REMEMBER) ?? "null");
    if (!v) return;
    $<HTMLSelectElement>("db-kind").value = v.kind ?? "file";
    for (const [id, k] of [["db-host", "host"], ["db-port", "port"], ["db-name", "name"], ["db-user", "user"]] as const) $<HTMLInputElement>(id).value = v[k] ?? "";
    $<HTMLInputElement>("db-winauth").checked = !!v.winauth;
    $<HTMLSelectElement>("db-security").value = ["verify", "trust", "off"].includes(v.security) ? v.security : "verify";
  } catch { /* 沒有記錄就用預設 */ }
}
function saveLast(): void {
  try {
    localStorage.setItem(REMEMBER, JSON.stringify({
      kind: kindNow(), host: $<HTMLInputElement>("db-host").value, port: $<HTMLInputElement>("db-port").value,
      name: $<HTMLInputElement>("db-name").value, user: $<HTMLInputElement>("db-user").value, winauth: $<HTMLInputElement>("db-winauth").checked, security: $<HTMLSelectElement>("db-security").value, // 密碼不記
    }));
  } catch { /* 記不住也沒關係 */ }
}

/** 讀取這台電腦的 ODBC 驅動程式與資料來源名稱放進下拉；失敗（例如沒有任何驅動程式）就只留提示 */
async function fillSources(): Promise<void> {
  const sel = $<HTMLSelectElement>("db-src");
  sel.replaceChildren(new Option(t("（選擇後帶入連線字串範本）"), ""));
  try {
    const r = await invoke<{ drivers: string[]; dsns: string[] }>("list_odbc_sources");
    if (r.drivers.length) {
      const g = document.createElement("optgroup");
      g.label = t("驅動程式");
      g.append(...r.drivers.map((d) => new Option(d, `drv:${d}`)));
      sel.append(g);
    }
    if (r.dsns.length) {
      const g = document.createElement("optgroup");
      g.label = t("資料來源名稱（DSN）");
      g.append(...r.dsns.map((d) => new Option(d, `dsn:${d}`)));
      sel.append(g);
    }
  } catch {
    /* 取不到清單時，仍可手動輸入連線字串 */
  }
}

function showErr(el: HTMLElement, text: string): void { el.className = "hint err"; el.textContent = text; }

async function connect(): Promise<void> {
  const msg = $("db-msg");
  const kind = kindNow();
  const sql = $<HTMLTextAreaElement>("db-sql").value.trim();
  const sheet = sql ? `sql:${sql}` : undefined;
  let path = "";
  let label = "";
  if (kind === "file") {
    path = $<HTMLInputElement>("db-path").value.trim().replace(/^"(.*)"$/, "$1");
  } else if (kind === "odbc") {
    const cs = $<HTMLTextAreaElement>("db-cs").value.trim();
    if (cs) { path = `odbc:${cs}`; label = sourceLabelOf(cs); }
  } else {
    const v = (id: string) => $<HTMLInputElement>(id).value;
    if (!v("db-host").trim() || !v("db-name").trim()) { showErr(msg, t("請輸入伺服器與資料庫名稱")); return; }
    path = buildNetSource(kind, {
      host: v("db-host"), port: v("db-port"), name: v("db-name"), user: v("db-user"), pass: v("db-pass"),
      winauth: $<HTMLInputElement>("db-winauth").checked, security: $<HTMLSelectElement>("db-security").value,
    });
    label = netLabel(kind, v("db-host"), v("db-name"));
  }
  if (!path) {
    showErr(msg, t("請輸入檔案路徑或連線字串"));
    return;
  }
  const go = $<HTMLButtonElement>("db-go");
  go.disabled = true;
  msg.className = "hint";
  msg.textContent = t("連線中…");
  try {
    await api.load(path, sheet, label);
    saveLast();
    $<HTMLDialogElement>("dlg-db").close();
    msg.textContent = "";
  } catch (e) {
    msg.className = "hint err"; // 失敗原因用醒目的紅色顯示
    msg.textContent = String(e) + (SERVER_KINDS.includes(kind) ? "\n" + t("如果是憑證或加密的問題，可以調整「連線安全性」。") : "");
    msg.scrollIntoView?.({ block: "nearest" });
  } finally {
    go.disabled = false;
  }
}

export function openDbDialog(): void {
  const dlg = $<HTMLDialogElement>("dlg-db");
  if (dlg.open) return;
  $("db-msg").textContent = "";
  $("db-msg").className = "hint";
  loadLast();
  applyKind();
  $<HTMLInputElement>("db-pass").value = "";
  void fillSources();
  dlg.showModal();
}

export function initDbDialog(a: DbDialogApi): void {
  api = a;
  $("db-kind").addEventListener("change", applyKind);
  $("db-winauth").addEventListener("change", syncCred);
  $("db-browse").addEventListener("click", async () => {
    const picked = await open({
      multiple: false,
      filters: [{ name: t("資料庫"), extensions: ["db", "sqlite", "sqlite3", "db3", "mdb", "accdb"] }],
    });
    if (typeof picked === "string") $<HTMLInputElement>("db-path").value = picked;
  });
  $("db-src").addEventListener("change", () => {
    const v = $<HTMLSelectElement>("db-src").value;
    const cs = $<HTMLTextAreaElement>("db-cs");
    if (v.startsWith("drv:")) cs.value = `Driver={${v.slice(4)}};`;
    else if (v.startsWith("dsn:")) cs.value = `DSN=${v.slice(4)};`;
  });
  $("db-go").addEventListener("click", () => void connect());
  $("dlg-db").addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter" && (ke.ctrlKey || (ke.target as HTMLElement).tagName === "INPUT")) { ke.preventDefault(); void connect(); }
  });
}
