// 資料表面板：選擇資料來源（Excel / CSV），勾選要列印的列（勾幾列就印幾張）。
// 欄位標題即 {{欄位}} 變數名稱。

import { invoke } from "./ipc";
import { ask, message, open } from "@tauri-apps/plugin-dialog";
import { WebError } from "./m365";
import { WEB_PREFIX, addWebRecent, loadInterval, remapRows, saveInterval, syncWeb, type Synced } from "./websync";
import type { Raw, RawRow, Row } from "./template";
import { t } from "./i18n";

/** 儲存格格式（只有 Excel 才有：文字顏色、底色、粗體） */
interface CellStyle {
  color?: string;
  bg?: string;
  bold?: boolean;
}

interface TableData {
  sheets: string[];
  sheet: string;
  headers: string[];
  rows: string[][];
  /** 每列顯示的列號：Excel 為工作表中的實際列號，其他來源為 1、2、3… */
  rowNumbers: number[];
  /** 與 rows 同樣大小的格式；CSV 等沒有格式的來源沒有這個欄位 */
  styles?: (CellStyle | null)[][];
  /** 與 rows 同樣大小的原始值（Excel 的數字／日期儲存格）；CSV 等沒有這個欄位。供「欄位格式」重新格式化用 */
  raw?: (Raw | null)[][];
  /** 來源種類：資料庫為 "db"（「工作表」改稱「資料表」）；Excel、CSV 沒有這個欄位 */
  kind?: "db";
  /** 資料庫是一頁一頁讀的：目前這一頁的位移、每頁筆數、總列數（只有第一頁才有）與有沒有下一頁；Excel／CSV 沒有這個欄位 */
  page?: { offset: number; limit: number; total?: number; more: boolean };
}

/** 畫面每頁最多顯示的列數（資料庫由後端一頁一頁讀；Excel／CSV 整份讀進來，只分頁顯示，以免一次畫出幾萬列而卡住） */
export const PAGE_SIZE = 1000;

export interface TableHandlers {
  /** 點選某一列：預覽該列套用後的標籤（raw 為該列各欄的原始值，供欄位格式使用） */
  onPreview(row: Row, raw: RawRow): void | Promise<void>;
  /** 列印勾選的列 */
  onPrint(rows: Row[], raws: RawRow[]): void | Promise<void>;
  /** 點選欄位標籤：把 {{欄位}} 插入目前選取物件的內容 */
  onInsertVar(name: string): void;
  onStatus(msg: string, kind?: "ok" | "err" | ""): void;
  /** 資料表載入、切換工作表或關閉時通知（欄位清單可能改變） */
  onChange?(): void;
  /** 按下資料表上的「預覽列印」 */
  onPrintPreview?(): void;
}

/** 目前在資料表勾選的列（依表中順序）；沒有載入資料表或沒有勾選時回傳 null。names 是顯示用的列名稱，如「Excel 第 7 列」 */
export function selectedRows(): { rows: Row[]; raws: RawRow[]; names: string[] } | null {
  if (!data || checked.size === 0) return null;
  const idx = [...checked].sort((a, b) => a - b);
  if (isDb()) {
    // 資料庫只在畫面上留著目前這一頁，換頁前勾選的列另外存在 picked
    const got = idx.map((k) => picked.get(k)).filter((x): x is Picked => !!x);
    return { rows: got.map((x) => x.row), raws: got.map((x) => x.raw), names: got.map((x) => t("第 {n} 列", { n: x.num })) };
  }
  return {
    rows: idx.map(rowOf),
    raws: idx.map(rawOf),
    names: idx.map((i) => `${(web?.name || path).toLowerCase().endsWith(".csv") ? "" : "Excel "}${t("第 {n} 列", { n: data!.rowNumbers[i] ?? i + 1 })}`),
  };
}

/** 目前載入的資料表欄位標題（沒有載入則為空） */
export function tableHeaders(): string[] {
  return data?.headers ?? [];
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let path = "";
/** 畫面上顯示的來源名稱（資料庫連線不顯示整串連線字串，也不能出現密碼）；空字串＝用檔名 */
let sourceLabel = "";
let data: TableData | null = null;

/** 目前的資料來自網頁版 Excel 時的狀態；其他來源為 null */
interface Web {
  url: string;
  /** 最近一次下載到的暫存檔（讀取與切換工作表用） */
  file: string;
  name: string;
  /** 這份資料是什麼時候取得的 */
  at: Date;
  /** 只能靠使用者自己按「下載複本」取得，無法自動更新 */
  manual: boolean;
  /** 暫停自動更新（登入過期且使用者沒有重新登入，或已登出） */
  paused: boolean;
  /** 更新時有勾選的列變動或移位，使用者還沒處理的列數 */
  pending: number;
}
let web: Web | null = null;
/** 更新後內容與上一版不同的列（標示用） */
let changedRows = new Set<number>();
/** 實際要讀的檔案 */
const readPath = (): string => (web ? web.file : path);
/**
 * 勾選的列，以「列的編號」記錄：Excel／CSV 是資料列的索引；資料庫是整份資料中的第幾列（0 起算，換頁後仍指同一列）。
 */
const checked = new Set<number>();
/** 資料庫換頁後原本那一頁不在記憶體裡，所以勾選時就把該列的資料另外存起來，列印時才拿得到 */
interface Picked { row: Row; raw: RawRow; num: number }
const picked = new Map<number, Picked>();
let active = -1;
let h: TableHandlers;
/** Excel／CSV：目前顯示的第一列（每頁 PAGE_SIZE 列） */
let pageStart = 0;
/** 資料庫的總列數（第一頁時由後端算出；算不出來為 null） */
let dbTotal: number | null = null;

/** 目前是不是「一頁一頁向資料庫讀」的來源 */
const isDb = (): boolean => !!data && data.kind === "db" && !!data.page;
/** data.rows[k] 的「列編號」 */
const keyOf = (k: number): number => (isDb() ? (data!.rowNumbers[k] ?? k + 1) - 1 : k);
/** 目前畫面上顯示的是 data.rows 的哪幾列 */
function visibleRows(): number[] {
  if (!data) return [];
  const end = isDb() ? data.rows.length : Math.min(data.rows.length, pageStart + PAGE_SIZE);
  const start = isDb() ? 0 : pageStart;
  return Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i);
}
/** 「全選／全不選／反選」作用的範圍：Excel／CSV 是全部資料列；資料庫只有目前這一頁（其他頁沒有載入） */
function scopeKeys(): number[] {
  if (!data) return [];
  const ks = isDb() ? visibleRows() : data.rows.map((_, k) => k);
  return ks.filter((k) => !isBlank(k)).map(keyOf);
}
/** 總列數（不含空白列）；資料庫沒有總數時以「已讀到的位置」代替 */
function totalCount(): number {
  if (!data) return 0;
  if (isDb()) return dbTotal ?? data.page!.offset + data.rows.length;
  return printableCount();
}

const rowOf = (i: number): Row =>
  Object.fromEntries(data!.headers.map((name, c) => [name, data!.rows[i][c] ?? ""]));

/** 該列各欄的原始值（沒有原始值的來源或文字儲存格為 null） */
const rawOf = (i: number): RawRow =>
  Object.fromEntries(data!.headers.map((name, c) => [name, data!.raw?.[i]?.[c] ?? null]));

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", cls = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text) e.textContent = text; // 一律用 textContent，儲存格內容不會被當成 HTML
  if (cls) e.className = cls;
  return e;
}

/** 空白列（Excel 資料列之間的空行）：顯示出來以對應 Excel，但不能勾選、不能列印 */
const isBlank = (i: number): boolean => !!data && data.rows[i].every((c) => c.trim() === "");
const printableCount = (): number => (data ? data.rows.filter((_, i) => !isBlank(i)).length : 0);

/** 套用 Excel 的文字顏色 / 底色 / 粗體；顏色值先驗證格式再寫入 */
function applyCellStyle(td: HTMLElement, s: CellStyle | null | undefined): void {
  if (!s) return;
  const ok = (c?: string) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c : "");
  if (ok(s.color)) td.style.color = s.color!;
  if (ok(s.bg)) td.style.backgroundColor = s.bg!;
  if (s.bold) td.style.fontWeight = "700";
}

const LAST_SHEET_KEY = "label-printer.lastsheet";
const LAST_SHEET_MAX = 50;

/** 記憶用的來源識別：檔案用路徑；連線字串與伺服器來源拿掉密碼，只留能辨認是哪一個的部分 */
export function sourceKey(p: string): string {
  if (p.startsWith("net:")) {
    try {
      const o = JSON.parse(p.slice(4)) as Record<string, unknown>;
      return `net:${o.kind}|${o.host}|${o.port ?? ""}|${o.database ?? ""}`;
    } catch { return "net:"; }
  }
  if (p.startsWith("odbc:")) return p.replace(/(^|;)\s*(pwd|password)\s*=[^;]*/gi, "$1");
  return p;
}

function readLast(): [string, string][] {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_SHEET_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((e) => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string") : [];
  } catch { return []; }
}

/** 上次在這個來源選的工作表／資料表（沒有記錄回傳 undefined） */
export function recallSheet(p: string): string | undefined {
  const k = sourceKey(p);
  return readLast().find((e) => e[0] === k)?.[1];
}

/** 記下這個來源目前選的工作表／資料表；只有多個選項才有意義（自訂查詢由連線對話框自己記） */
export function rememberSheet(p: string, sheet: string, sheets: string[]): void {
  if (sheets.length <= 1 || sheet.startsWith("sql:")) return;
  const k = sourceKey(p);
  const list = readLast().filter((e) => e[0] !== k);
  list.push([k, sheet]);
  try { localStorage.setItem(LAST_SHEET_KEY, JSON.stringify(list.slice(-LAST_SHEET_MAX))); } catch { /* 無法儲存就算了 */ }
}

async function load(sheet?: string): Promise<void> {
  let t: TableData | undefined;
  const last = sheet === undefined ? recallSheet(path) : undefined;
  if (last !== undefined) {
    try { t = await invoke<TableData>("read_table", { path: readPath(), sheet: last }); } catch { t = undefined; } // 記的名稱不在了就用預設的
  }
  t ??= await invoke<TableData>("read_table", { path: readPath(), sheet: sheet ?? null });
  rememberSheet(path, t.sheet, t.sheets);
  data = t;
  checked.clear();
  picked.clear();
  changedRows = new Set();
  if (web) web.pending = 0;
  pageStart = 0;
  dbTotal = t.page?.total ?? null;
  active = -1;
  render();
}

/** 資料庫換到另一頁（從後端只讀那一頁）；勾選的列不受影響 */
async function loadDbPage(offset: number): Promise<void> {
  if (!data) return;
  const t = await invoke<TableData>("read_table", { path, sheet: data.sheet, offset, limit: PAGE_SIZE });
  data = t;
  if (t.page?.total != null) dbTotal = t.page.total;
  active = -1;
  render();
  document.querySelector(".data-scroll")?.scrollTo({ top: 0 });
}

/** 目前是第幾頁（1 起算） */
function currentPage(): number {
  if (!data) return 1;
  return Math.floor((isDb() ? data.page!.offset : pageStart) / PAGE_SIZE) + 1;
}

/** 總頁數；資料庫沒有總列數（Access／ODBC）時未知，回傳 null */
function pageCount(): number | null {
  if (!data) return null;
  if (isDb()) return dbTotal != null ? Math.max(1, Math.ceil(dbTotal / PAGE_SIZE)) : null;
  return Math.max(1, Math.ceil(data.rows.length / PAGE_SIZE));
}

/** 跳到第 no 頁（1 起算）；超出範圍時夾在第一頁～最後一頁之間 */
async function gotoPage(no: number): Promise<void> {
  if (!data || !Number.isFinite(no)) return;
  const n = pageCount();
  const target = Math.max(1, n == null ? Math.floor(no) : Math.min(n, Math.floor(no)));
  if (target === currentPage()) {
    updatePager(); // 輸入框要還原成目前頁碼
    return;
  }
  try {
    if (isDb()) {
      await loadDbPage((target - 1) * PAGE_SIZE);
    } else {
      pageStart = (target - 1) * PAGE_SIZE;
      active = -1;
      render();
      document.querySelector(".data-scroll")?.scrollTo({ top: 0 });
    }
  } catch (e) {
    h.onStatus(String(e), "err");
    updatePager();
  }
}

/** 上一頁（-1）／下一頁（+1） */
const turnPage = (delta: number): Promise<void> => gotoPage(currentPage() + delta);

/** 換成另一個來源並載入；失敗時還原成原本的來源 */
async function switchSource(p: string, label: string, next: Web | null, sheet?: string): Promise<void> {
  const prev = { path, label: sourceLabel, web };
  path = p;
  sourceLabel = label;
  web = next;
  try {
    await load(sheet);
  } catch (e) {
    path = prev.path;
    sourceLabel = prev.label;
    web = prev.web;
    throw e;
  }
}

const loadedMessage = (): string => t("已載入資料來源：{n} 筆資料，勾選要列印的列", { n: totalCount() });

/** 以指定的來源載入（資料庫連線對話框使用）：path 可以是資料庫檔案，或 `odbc:` 開頭的連線字串；sheet 可以是資料表名或 `sql:` 查詢 */
export async function loadSource(p: string, sheet?: string, label = ""): Promise<void> {
  await switchSource(p, label, null, sheet);
  h.onStatus(loadedMessage(), "ok");
}

// ---- 網頁版 Excel ----
const clock = (d: Date): string => d.toLocaleTimeString();
let lastTry = 0;

/** 連線到網頁版試算表（需要時會跳出登入視窗）；失敗時丟出 WebError */
export async function loadWeb(url: string): Promise<void> {
  const r = await syncWeb(url, true);
  if (r.status === "busy") throw new WebError(t("正在取得資料，請稍候再試。"));
  if (r.status === "cancelled") throw new WebError(t("已取消"), r.report);
  if (r.status !== "ok" && r.status !== "manual") throw new WebError(t("抓不到這個檔案，請確認網址與帳號權限。也可以在瀏覽器打開檔案後，改貼網址列的網址。"), r.report);
  const next: Web = { url, file: r.file, name: r.name, at: new Date(), manual: r.status === "manual", paused: false, pending: 0 };
  try {
    await switchSource(WEB_PREFIX + url, t("網頁版 · {name}", { name: r.name }), next);
  } catch (e) {
    throw new WebError(String(e), r.report);
  }
  lastTry = Date.now();
  addWebRecent(url, r.name);
  h.onStatus(next.manual ? t("已載入。這個檔案無法自動更新，要更新時請按「重新讀取」。") : loadedMessage(), "ok");
}

/** 登出後：停止自動更新（畫面上的資料保留） */
export function stopWeb(): void {
  if (web) web.paused = true;
}

type Fresh = { ok: true; affected: number } | { ok: false; login: boolean };
let inflight: Promise<Fresh> | null = null;

/** 向雲端取得目前的內容；同時間只做一次，後到的呼叫共用結果 */
function refreshWeb(interactive: boolean): Promise<Fresh> {
  inflight ??= doRefresh(interactive).finally(() => { inflight = null; });
  return inflight;
}

async function doRefresh(interactive: boolean): Promise<Fresh> {
  const w = web;
  if (!w || !data) return { ok: false, login: false };
  lastTry = Date.now();
  let r: Synced;
  let next: TableData;
  try {
    r = await syncWeb(w.url, interactive);
    if (r.status !== "ok" && r.status !== "manual") return { ok: false, login: r.status === "login" };
    try {
      next = await invoke<TableData>("read_table", { path: r.file, sheet: data.sheet });
    } catch {
      next = await invoke<TableData>("read_table", { path: r.file, sheet: null }); // 原本的工作表不見了
    }
  } catch {
    return { ok: false, login: false };
  }
  if (web !== w || !data) return { ok: false, login: false }; // 等待期間換了來源
  w.file = r.file;
  w.at = new Date();
  w.manual = r.status === "manual";
  w.paused = false;
  const affected = applyFresh(next);
  w.pending += affected;
  updateWebBar();
  return { ok: true, affected };
}

/** 套用新內容：勾選與目前預覽的列跟著內容走；回傳有幾個勾選的列變動或移位 */
function applyFresh(next: TableData): number {
  const old = data!;
  const view = (d: TableData) => JSON.stringify([d.sheets, d.sheet, d.headers, d.rows, d.rowNumbers, d.styles ?? [], d.raw ?? []]);
  if (view(old) === view(next)) return 0;
  const before = [...checked];
  checked.clear();
  changedRows = new Set();
  let affected = before.length;
  if (old.sheet === next.sheet && JSON.stringify(old.headers) === JSON.stringify(next.headers)) {
    const r = remapRows(old.rows, next.rows, before);
    for (const i of r.checked) checked.add(i);
    changedRows = new Set(r.fresh);
    affected = r.moved + r.lost;
    active = active >= 0 ? (remapRows(old.rows, next.rows, [active]).checked[0] ?? -1) : -1;
  } else {
    active = -1;
  }
  data = next;
  if (pageStart >= next.rows.length) pageStart = 0;
  const scroll = document.querySelector(".data-scroll");
  const top = scroll?.scrollTop ?? 0;
  render();
  if (scroll) scroll.scrollTop = top;
  if (affected) h.onStatus(t("資料已更新：有 {n} 個勾選的列變動或移位，請確認後再列印。", { n: affected }), "err");
  else h.onStatus(t("資料已更新（{time}）", { time: clock(new Date()) }), "ok");
  return affected;
}

function updateWebBar(): void {
  $("data-web").hidden = !web || !data;
  if (!web) return;
  $("data-web-at").textContent = t("取得於 {time}", { time: clock(web.at) });
  const sel = $<HTMLSelectElement>("data-interval");
  sel.value = String(loadInterval());
  sel.disabled = web.manual;
}

/** 背景定時更新；登入過期時跳一次登入視窗，沒有登入就暫停 */
async function pollWeb(): Promise<void> {
  const w = web!;
  let r = await refreshWeb(false);
  if (!r.ok && r.login && web === w) {
    r = await refreshWeb(true);
    if (!r.ok && web === w) {
      w.paused = true;
      h.onStatus(t("登入已過期，目前是 {time} 取得的資料。按「重新讀取」可重新登入。", { time: clock(w.at) }), "err");
      return;
    }
  }
  if (!r.ok && web === w) h.onStatus(t("抓不到最新資料，目前是 {time} 取得的資料。", { time: clock(w.at) }), "err");
}

function pollTick(): void {
  const seconds = loadInterval();
  if (!web || !data || !seconds || web.manual || web.paused || inflight) return;
  // 有對話框開著（預覽列印、設定…）時不換資料，免得看到的和印出的不一樣
  if (Date.now() - lastTry < seconds * 1000 || document.querySelector("dialog[open]")) return;
  void pollWeb();
}

/**
 * 列印或預覽前確認資料是最新的。回傳 false＝先不要繼續。
 * 勾選的列內容沒變就直接繼續；有變動或移位先停下讓使用者看；抓不到最新資料時由使用者決定。
 */
export async function ensureFresh(): Promise<boolean> {
  const w = web;
  if (!w || !data || checked.size === 0 && !w.pending) return true;
  const useOld = (text: string): Promise<boolean> =>
    ask(text, { title: t("網頁版 Excel"), kind: "warning", okLabel: t("照這份繼續"), cancelLabel: t("取消") });
  if (w.manual) return useOld(t("這個檔案無法自動更新。目前是 {time} 取得的資料，要照這份繼續嗎？", { time: clock(w.at) }));
  if (!w.pending) {
    h.onStatus(t("正在取得最新資料…"));
    let r = await refreshWeb(false);
    if (!r.ok && r.login) r = await refreshWeb(true);
    if (web !== w) return false;
    if (!r.ok) return useOld(t("抓不到最新資料。目前是 {time} 取得的資料，要照這份繼續嗎？", { time: clock(w.at) }));
    if (!w.pending) h.onStatus(t("資料已是最新（{time}）", { time: clock(w.at) }), "ok");
  }
  if (w.pending) {
    w.pending = 0;
    await message(t("勾選的資料有變動或移位。請看過下方資料表，確認勾選正確後再按一次。"), { title: t("網頁版 Excel"), kind: "warning" });
    return false;
  }
  return true;
}

const FILE_EXTS = {
  tables: ["xlsx", "xlsm", "xls", "csv"],
  databases: ["db", "sqlite", "sqlite3", "db3", "mdb", "accdb"],
};

async function importFile(): Promise<void> {
  try {
    const picked = await open({
      multiple: false,
      filters: [
        { name: t("資料來源（Excel、CSV、資料庫）"), extensions: [...FILE_EXTS.tables, ...FILE_EXTS.databases] },
        { name: "Excel / CSV", extensions: FILE_EXTS.tables },
        { name: t("資料庫"), extensions: FILE_EXTS.databases },
      ],
    });
    if (typeof picked !== "string") return;
    await switchSource(picked, "", null);
    h.onStatus(loadedMessage(), "ok");
  } catch (e) {
    h.onStatus(t("載入資料來源失敗：{err}", { err: String(e) }), "err");
  }
}

function updateCount(): void {
  $("data-count").textContent = t("已選 {n} / {total} 列", { n: checked.size, total: totalCount() });
  $<HTMLButtonElement>("data-print").disabled = checked.size === 0;
  $<HTMLButtonElement>("data-preview").disabled = checked.size === 0;
  const all = $<HTMLInputElement>("data-check-all");
  const scope = scopeKeys();
  all.checked = scope.length > 0 && scope.every((k) => checked.has(k));
  all.indeterminate = scope.some((k) => checked.has(k)) && !all.checked;
}

/** 分頁列：Excel／CSV 超過一頁、或資料庫不只一頁時才出現 */
function updatePager(): void {
  const pager = $("data-pager");
  if (!data) {
    pager.hidden = true;
    return;
  }
  let label = "";
  let prev = false;
  let next = false;
  if (isDb()) {
    const p = data.page!;
    prev = p.offset > 0;
    next = p.more;
    const no = Math.floor(p.offset / PAGE_SIZE) + 1;
    label = dbTotal != null ? t("第 {p} / {n} 頁（共 {total} 列）", { p: no, n: Math.max(1, Math.ceil(dbTotal / PAGE_SIZE)), total: dbTotal }) : t("第 {p} 頁", { p: no });
  } else {
    const pages = Math.max(1, Math.ceil(data.rows.length / PAGE_SIZE));
    const no = Math.floor(pageStart / PAGE_SIZE) + 1;
    prev = no > 1;
    next = no < pages;
    label = t("第 {p} / {n} 頁（共 {total} 列）", { p: no, n: pages, total: data.rows.length });
  }
  pager.hidden = !(prev || next);
  $("data-page").textContent = label;
  $<HTMLButtonElement>("data-prev").disabled = !prev;
  $<HTMLButtonElement>("data-next").disabled = !next;
  // 第一頁／最後一頁／跳頁：最後一頁與跳頁需要知道總頁數（Access／ODBC 沒有總列數，只能一頁一頁往後）
  const pages = pageCount();
  $<HTMLButtonElement>("data-first").disabled = !prev;
  $<HTMLButtonElement>("data-last").disabled = !next || pages == null;
  const go = $<HTMLInputElement>("data-goto");
  go.disabled = pages == null;
  go.max = pages == null ? "" : String(pages);
  go.value = "";
  // 資料庫的全選／全不選／反選只作用在目前這一頁，滑過去時提醒
  const hint = isDb() ? t("資料庫的資料是一頁一頁讀的，這裡只作用在目前這一頁") : "";
  for (const id of ["data-all", "data-none", "data-invert"]) {
    if (hint) $(id).title = hint;
    else $(id).removeAttribute("title");
  }
}

function render(): void {
  h.onChange?.();
  updateWebBar();
  const panel = $("data-panel");
  if (!data) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  $("data-file").textContent = sourceLabel || (path.split(/[\\/]/).pop() ?? path);
  $("data-sheet-label").textContent = data.kind === "db" ? t("資料表") : t("工作表");

  const sel = $<HTMLSelectElement>("data-sheet");
  sel.replaceChildren(...data.sheets.map((s) => new Option(s, s)));
  sel.value = data.sheet;
  sel.disabled = data.sheets.length <= 1;

  $("data-chips").replaceChildren(
    ...data.headers.map((name) => {
      const b = el("button", `{{${name}}}`, "chip");
      b.type = "button";
      b.title = t("插入到選取的物件內容");
      b.addEventListener("click", () => h.onInsertVar(name));
      return b;
    }),
  );

  const table = $<HTMLTableElement>("data-table");
  const head = el("tr");
  const allTh = el("th");
  const all = el("input");
  all.type = "checkbox";
  all.id = "data-check-all";
  all.title = t("全選 / 全不選");
  all.addEventListener("change", () => (all.checked ? selectAll() : selectNone()));
  allTh.append(all);
  head.append(allTh, el("th", "#"), ...data.headers.map((n) => el("th", n)));

  const body = visibleRows().map((i) => {
    const r = data!.rows[i];
    const blank = isBlank(i);
    const tr = el("tr", "", [i === active ? "active" : "", blank ? "blank" : "", changedRows.has(i) ? "changed" : ""].join(" ").trim());
    tr.dataset.i = String(i);
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = checked.has(keyOf(i));
    cb.disabled = blank; // 空白列不能勾選
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => {
      if (web) web.pending = 0; // 自己動過勾選，代表看過了
      setChecked(i, cb.checked);
      updateCount();
    });
    const td = el("td");
    td.append(cb);
    const cells = r.map((c, j) => {
      const cell = el("td", c);
      applyCellStyle(cell, data!.styles?.[i]?.[j]);
      return cell;
    });
    tr.append(td, el("td", String(data!.rowNumbers[i] ?? i + 1), "num"), ...cells);
    if (!blank) {
      tr.addEventListener("click", () => {
        active = i;
        table.querySelectorAll("tr.active").forEach((x) => x.classList.remove("active"));
        tr.classList.add("active");
        void h.onPreview(rowOf(i), rawOf(i));
      });
    }
    return tr;
  });
  table.replaceChildren(head, ...body);
  updateCount();
  updatePager();
}

/** 勾選或取消勾選 data.rows[k]；資料庫要把該列的資料一併存起來（換頁後才印得出來） */
function setChecked(k: number, on: boolean): void {
  const key = keyOf(k);
  if (!on) {
    checked.delete(key);
    picked.delete(key);
    return;
  }
  checked.add(key);
  if (isDb()) picked.set(key, { row: rowOf(k), raw: rawOf(k), num: key + 1 });
}

function setAll(on: boolean): void {
  if (!data) return;
  if (web) web.pending = 0;
  // 空白列不納入；Excel／CSV 作用在全部資料列，資料庫只有目前這一頁
  const ks = isDb() ? visibleRows() : data.rows.map((_, k) => k);
  for (const k of ks) if (!isBlank(k)) setChecked(k, on);
  document.querySelectorAll<HTMLInputElement>("#data-table td input").forEach((cb) => {
    const k = Number(cb.closest("tr")?.dataset.i);
    cb.checked = checked.has(keyOf(k)) && !cb.disabled;
  });
  updateCount();
}
const selectAll = () => setAll(true);
const selectNone = () => setAll(false);

function invert(): void {
  if (!data) return;
  if (web) web.pending = 0;
  const ks = isDb() ? visibleRows() : data.rows.map((_, k) => k);
  for (const k of ks) if (!isBlank(k)) setChecked(k, !checked.has(keyOf(k)));
  render();
}

const HEIGHT_KEY = "label-printer.dataPanelHeight";
const DEFAULT_HEIGHT = 250;

/** 資料表面板的上緣可拖拉調整高度（雙擊還原；也可用鍵盤上下鍵），高度會記住 */
function initResizer(): void {
  const panel = $("data-panel");
  const grip = $("data-resizer");
  const clamp = (v: number) => Math.max(140, Math.min(Math.round(window.innerHeight * 0.75), Math.round(v)));
  const apply = (v: number, persist: boolean) => {
    panel.style.height = `${clamp(v)}px`;
    if (persist) {
      try { localStorage.setItem(HEIGHT_KEY, String(clamp(v))); } catch { /* 無法儲存就算了 */ }
    }
  };
  try {
    const saved = Number(localStorage.getItem(HEIGHT_KEY));
    if (saved > 0) apply(saved, false);
  } catch { /* 無法讀取則使用預設高度 */ }

  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = panel.getBoundingClientRect().height;
    const move = (ev: PointerEvent) => apply(startH + (startY - ev.clientY), false); // 往上拖 = 變高
    const up = (ev: PointerEvent) => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      apply(startH + (startY - ev.clientY), true);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
  grip.addEventListener("dblclick", () => apply(DEFAULT_HEIGHT, true));
  grip.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    apply(panel.getBoundingClientRect().height + (e.key === "ArrowUp" ? 24 : -24), true);
  });
  // 視窗縮小時，高度不能超過視窗的 75%
  window.addEventListener("resize", () => { if (!panel.hidden) apply(panel.getBoundingClientRect().height, false); });
}

export function initTable(handlers: TableHandlers): void {
  h = handlers;
  initResizer();
  $("import-file").addEventListener("click", () => void importFile());
  $("data-close").addEventListener("click", () => { data = null; web = null; render(); });
  $<HTMLSelectElement>("data-interval").addEventListener("change", (e) => {
    saveInterval(Number((e.target as HTMLSelectElement).value));
    lastTry = Date.now();
  });
  window.setInterval(pollTick, 1000);
  $("data-all").addEventListener("click", selectAll);
  $("data-none").addEventListener("click", selectNone);
  $("data-invert").addEventListener("click", invert);
  $("data-reload").addEventListener("click", () => {
    if (!path) return;
    if (web) {
      const w = web;
      w.paused = false;
      h.onStatus(t("正在取得最新資料…"));
      void refreshWeb(true).then((r) => {
        if (web !== w) return;
        if (!r.ok) h.onStatus(t("抓不到最新資料，目前是 {time} 取得的資料。", { time: clock(w.at) }), "err");
        else if (!r.affected) h.onStatus(t("資料已是最新（{time}）", { time: clock(w.at) }), "ok");
      });
      return;
    }
    load(data?.sheet).then(
      () => h.onStatus(t("已重新讀取，共 {n} 筆資料", { n: totalCount() }), "ok"),
      (e) => h.onStatus(t("重新讀取失敗：{err}", { err: String(e) }), "err"),
    );
  });
  $<HTMLSelectElement>("data-sheet").addEventListener("change", (e) => {
    load((e.target as HTMLSelectElement).value).catch((err) => h.onStatus(String(err), "err"));
  });
  $("data-preview-direct").addEventListener("click", () => h.onPrintPreview?.());
  $("data-prev").addEventListener("click", () => void turnPage(-1));
  $("data-next").addEventListener("click", () => void turnPage(1));
  $("data-first").addEventListener("click", () => void gotoPage(1));
  $("data-last").addEventListener("click", () => { const n = pageCount(); if (n != null) void gotoPage(n); });
  const goto = $<HTMLInputElement>("data-goto");
  goto.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const v = goto.valueAsNumber;
    if (Number.isFinite(v)) void gotoPage(v);
    else updatePager();
  });
  goto.addEventListener("blur", () => { goto.value = ""; }); // 沒按 Enter 就離開：不跳頁，清掉輸入
  $("data-print").addEventListener("click", async () => {
    const btn = $<HTMLButtonElement>("data-print");
    btn.disabled = true; // 確認最新資料時不要重複觸發
    const go = await ensureFresh().finally(() => updateCount());
    if (!go) return;
    const sel = selectedRows();
    if (!sel) return;
    await h.onPrint(sel.rows, sel.raws);
  });
}
