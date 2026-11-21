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
}

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
const checked = new Set<number>();
let active = -1;
let h: TableHandlers;

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
  active = -1;
  render();
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
  h.onStatus(t("已載入資料來源：{n} 筆資料，勾選要列印的列", { n: printableCount() }), "ok");
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
    h.onStatus(t("已載入資料來源：{n} 筆資料，勾選要列印的列", { n: printableCount() }), "ok");
  } catch (e) {
    h.onStatus(t("載入資料來源失敗：{err}", { err: String(e) }), "err");
  }
}

function updateCount(): void {
  const total = printableCount();
  $("data-count").textContent = t("已選 {n} / {total} 列", { n: checked.size, total });
  $<HTMLButtonElement>("data-print").disabled = checked.size === 0;
  $<HTMLButtonElement>("data-preview").disabled = checked.size === 0;
  const all = $<HTMLInputElement>("data-check-all");
  all.checked = total > 0 && checked.size === total;
  all.indeterminate = checked.size > 0 && !all.checked;
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

  const body = data.rows.map((r, i) => {
    const blank = isBlank(i);
    const tr = el("tr", "", [i === active ? "active" : "", blank ? "blank" : ""].join(" ").trim());
    tr.dataset.i = String(i);
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = checked.has(i);
    cb.disabled = blank; // 空白列不能勾選
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => {
      cb.checked ? checked.add(i) : checked.delete(i);
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
}

function setAll(on: boolean): void {
  checked.clear();
  if (on) data?.rows.forEach((_, i) => { if (!isBlank(i)) checked.add(i); }); // 空白列不納入
  document.querySelectorAll<HTMLInputElement>("#data-table td input").forEach((cb) => { cb.checked = on && !cb.disabled; });
  updateCount();
}
const selectAll = () => setAll(true);
const selectNone = () => setAll(false);

function invert(): void {
  if (!data) return;
  const next = new Set<number>();
  data.rows.forEach((_, i) => { if (!checked.has(i) && !isBlank(i)) next.add(i); });
  checked.clear();
  next.forEach((i) => checked.add(i));
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
      () => h.onStatus(t("已重新讀取，共 {n} 筆資料", { n: printableCount() }), "ok"),
      (e) => h.onStatus(t("重新讀取失敗：{err}", { err: String(e) }), "err"),
    );
  });
  $<HTMLSelectElement>("data-sheet").addEventListener("change", (e) => {
    load((e.target as HTMLSelectElement).value).catch((err) => h.onStatus(String(err), "err"));
  });
  $("data-preview").addEventListener("click", () => h.onPrintPreview?.());
  $("data-print").addEventListener("click", async () => {
    if (!data || checked.size === 0) return;
    const idx = [...checked].sort((a, b) => a - b);
    await h.onPrint(idx.map(rowOf), idx.map(rawOf));
  });
}
