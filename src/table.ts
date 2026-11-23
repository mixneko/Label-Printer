// 資料表面板：選擇資料來源（Excel / CSV），勾選要列印的列（勾幾列就印幾張）。
// 欄位標題即 {{欄位}} 變數名稱。

import { invoke } from "./ipc";
import { open } from "@tauri-apps/plugin-dialog";
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
    names: idx.map((i) => `${path.toLowerCase().endsWith(".csv") ? "" : "Excel "}${t("第 {n} 列", { n: data!.rowNumbers[i] ?? i + 1 })}`),
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

async function load(sheet?: string): Promise<void> {
  const t = await invoke<TableData>("read_table", { path, sheet: sheet ?? null });
  data = t;
  checked.clear();
  picked.clear();
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

/** 上一頁（-1）／下一頁（+1） */
async function turnPage(delta: number): Promise<void> {
  if (!data) return;
  try {
    if (isDb()) {
      const off = Math.max(0, data.page!.offset + delta * PAGE_SIZE);
      if (off !== data.page!.offset) await loadDbPage(off);
    } else {
      const next = Math.max(0, Math.min(Math.floor((data.rows.length - 1) / PAGE_SIZE) * PAGE_SIZE, pageStart + delta * PAGE_SIZE));
      if (next === pageStart) return;
      pageStart = next;
      active = -1;
      render();
      document.querySelector(".data-scroll")?.scrollTo({ top: 0 });
    }
  } catch (e) {
    h.onStatus(String(e), "err");
  }
}

/** 以指定的來源載入（資料庫連線對話框使用）：path 可以是資料庫檔案，或 `odbc:` 開頭的連線字串；sheet 可以是資料表名或 `sql:` 查詢 */
export async function loadSource(p: string, sheet?: string, label = ""): Promise<void> {
  const prev = { path, label: sourceLabel };
  path = p;
  sourceLabel = label;
  try {
    await load(sheet);
  } catch (e) {
    path = prev.path;
    sourceLabel = prev.label;
    throw e;
  }
  h.onStatus(t("已載入資料來源：{n} 筆資料，勾選要列印的列", { n: totalCount() }), "ok");
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
    path = picked;
    sourceLabel = "";
    await load();
    h.onStatus(t("已載入資料來源：{n} 筆資料，勾選要列印的列", { n: totalCount() }), "ok");
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
  // 資料庫的全選／全不選／反選只作用在目前這一頁，滑過去時提醒
  const hint = isDb() ? t("資料庫的資料是一頁一頁讀的，這裡只作用在目前這一頁") : "";
  for (const id of ["data-all", "data-none", "data-invert"]) {
    if (hint) $(id).title = hint;
    else $(id).removeAttribute("title");
  }
}

function render(): void {
  h.onChange?.();
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
    const tr = el("tr", "", [i === active ? "active" : "", blank ? "blank" : ""].join(" ").trim());
    tr.dataset.i = String(i);
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = checked.has(keyOf(i));
    cb.disabled = blank; // 空白列不能勾選
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => {
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
  $("import-table").addEventListener("click", () => void importFile());
  $("data-close").addEventListener("click", () => { data = null; render(); });
  $("data-all").addEventListener("click", selectAll);
  $("data-none").addEventListener("click", selectNone);
  $("data-invert").addEventListener("click", invert);
  $("data-reload").addEventListener("click", () => {
    if (!path) return;
    load(data?.sheet).then(
      () => h.onStatus(t("已重新讀取，共 {n} 筆資料", { n: totalCount() }), "ok"),
      (e) => h.onStatus(t("重新讀取失敗：{err}", { err: String(e) }), "err"),
    );
  });
  $<HTMLSelectElement>("data-sheet").addEventListener("change", (e) => {
    load((e.target as HTMLSelectElement).value).catch((err) => h.onStatus(String(err), "err"));
  });
  $("data-preview").addEventListener("click", () => h.onPrintPreview?.());
  $("data-prev").addEventListener("click", () => void turnPage(-1));
  $("data-next").addEventListener("click", () => void turnPage(1));
  $("data-print").addEventListener("click", async () => {
    const sel = selectedRows();
    if (!sel) return;
    await h.onPrint(sel.rows, sel.raws);
  });
}
