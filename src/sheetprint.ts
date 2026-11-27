// 貼紙紙／A4 排版列印的對話框：設定版面、預覽整頁、匯出 PDF、經 Windows 列印對話框直接列印。
// 實驗性質：沒有在真實的 A4 印表機與貼紙紙上驗證過。

import { beerDue, maybeAskBeer } from "./donate";
import { invoke } from "./ipc";
import {
  autoFit, buildPdf, canvasToFlateRgb, computeLayout, drawPage, loadSheet, pageSize, planPages, sanitize, saveSheet,
  type PdfPage, type SheetConfig,
} from "./sheetlayout";
import type { Row } from "./template";
import { t } from "./i18n";

export interface SheetApi {
  /** 開啟與列印前確認資料是最新的（網頁版 Excel）；回傳 false 就停下 */
  before?(): Promise<boolean>;
  /** 要排版的資料：資料表勾選的列；沒有勾選就是「變數測試資料」的單筆 */
  source(): { rows: Row[]; raws: import("./template").RawRow[] };
  /** 每筆資料的張數（工具列的「每筆張數」） */
  copies(): number;
  /** 目前標籤的實際尺寸（mm） */
  labelMm(): { w: number; h: number };
  /** 套用 Excel 欄位格式後的資料列 */
  resolve(rows: Row[], raws: import("./template").RawRow[]): Promise<Row[]>;
  /** 以每 dot 幾個像素的倍率渲染一張標籤（彩色、不二值化） */
  render(row: Row, pixelRatio: number): HTMLCanvasElement;
  /** 讓使用者選存檔位置並寫入 PDF；取消時回傳 null */
  savePdf(bytes: Uint8Array): Promise<string | null>;
  status(msg: string, kind?: "ok" | "err" | ""): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const DOTS_PER_MM = 8;
const PREVIEW_PPM = 4; // 預覽：每 mm 4 像素
const SAVED_KEY = "label-printer.sheet";

let api: SheetApi;
let cfg: SheetConfig;
let recs: Row[] = []; // 展開後的每一格內容（每筆資料 × 每筆張數）
let page = 0;
let busy = false;
const previewCache = new Map<Row, HTMLCanvasElement>();

function readForm(): SheetConfig {
  const v = (id: string) => $<HTMLInputElement>(id).value;
  return sanitize({
    kind: $<HTMLSelectElement>("sh-kind").value as SheetConfig["kind"],
    paper: $<HTMLSelectElement>("sh-paper").value as SheetConfig["paper"],
    landscape: $<HTMLSelectElement>("sh-orient").value === "l",
    paperW: Number(v("sh-pw")), paperH: Number(v("sh-ph")),
    labelW: Number(v("sh-lw")), labelH: Number(v("sh-lh")),
    cols: Number(v("sh-cols")), rows: Number(v("sh-rows")),
    marginL: Number(v("sh-ml")), marginT: Number(v("sh-mt")),
    gapX: Number(v("sh-gx")), gapY: Number(v("sh-gy")),
    safe: Number(v("sh-safe")), start: Number(v("sh-start")),
    cut: $<HTMLSelectElement>("sh-cut").value as SheetConfig["cut"],
    dpi: Number($<HTMLSelectElement>("sh-dpi").value),
  });
}

function writeForm(c: SheetConfig): void {
  const set = (id: string, val: string | number) => { $<HTMLInputElement>(id).value = String(val); };
  $<HTMLSelectElement>("sh-kind").value = c.kind;
  $<HTMLSelectElement>("sh-paper").value = c.paper;
  $<HTMLSelectElement>("sh-orient").value = c.landscape ? "l" : "p";
  set("sh-pw", c.paperW); set("sh-ph", c.paperH);
  set("sh-lw", c.labelW); set("sh-lh", c.labelH);
  set("sh-cols", c.cols); set("sh-rows", c.rows);
  set("sh-ml", c.marginL); set("sh-mt", c.marginT);
  set("sh-gx", c.gapX); set("sh-gy", c.gapY);
  set("sh-safe", c.safe); set("sh-start", c.start);
  $<HTMLSelectElement>("sh-cut").value = c.cut;
  $<HTMLSelectElement>("sh-dpi").value = String(c.dpi);
  $("sh-custom").hidden = c.paper !== "custom";
}

/** 同一筆資料（同一個 row 物件）的標籤只渲染一次 */
function labelCanvas(row: Row, ppm: number, cache: Map<Row, HTMLCanvasElement>): HTMLCanvasElement {
  let c = cache.get(row);
  if (!c) {
    if (cache.size >= 48) cache.clear(); // 輸出大量標籤時避免佔用太多記憶體
    c = api.render(row, ppm / DOTS_PER_MM);
    cache.set(row, c);
  }
  return c;
}

function labelItems(pageIdx: number, ppm: number, cache: Map<Row, HTMLCanvasElement>) {
  const plan = planPages(cfg, recs.length)[pageIdx] ?? [];
  const { w, h } = api.labelMm();
  return plan.map((p) => ({ cell: p.cell, img: labelCanvas(recs[p.rec], ppm, cache), w, h }));
}

async function refresh(): Promise<void> {
  cfg = readForm();
  saveSheet(cfg);
  $("sh-custom").hidden = cfg.paper !== "custom";
  const lay = computeLayout(cfg);
  const pages = planPages(cfg, recs.length);
  page = Math.max(0, Math.min(pages.length - 1, page));
  const per = cfg.cols * cfg.rows;

  // 整頁預覽
  const canvas = $<HTMLCanvasElement>("sh-canvas");
  canvas.width = Math.round(lay.page.w * PREVIEW_PPM);
  canvas.height = Math.round(lay.page.h * PREVIEW_PPM);
  const g = canvas.getContext("2d")!;
  drawPage(g, lay, PREVIEW_PPM, labelItems(page, PREVIEW_PPM, previewCache));
  const used = new Set((pages[page] ?? []).map((p) => p.cell));
  g.save();
  for (const [i, c] of lay.cells.entries()) {
    const x = c.x * PREVIEW_PPM, y = c.y * PREVIEW_PPM, w = c.w * PREVIEW_PPM, h = c.h * PREVIEW_PPM;
    if (c.outside) { g.fillStyle = "rgba(220,38,38,.18)"; g.fillRect(x, y, w, h); }
    g.strokeStyle = used.has(i) ? "rgba(37,99,235,.55)" : "rgba(120,120,120,.45)";
    g.lineWidth = 1;
    g.setLineDash(used.has(i) ? [] : [3, 3]);
    g.strokeRect(x + .5, y + .5, w - 1, h - 1);
  }
  // 安全邊界（印表機印不到的外圈）
  g.setLineDash([5, 4]);
  g.strokeStyle = "rgba(220,38,38,.7)";
  g.strokeRect(cfg.safe * PREVIEW_PPM, cfg.safe * PREVIEW_PPM, (lay.page.w - 2 * cfg.safe) * PREVIEW_PPM, (lay.page.h - 2 * cfg.safe) * PREVIEW_PPM);
  g.restore();

  const warns = [...lay.warnings];
  const lm = api.labelMm();
  if (lm.w > cfg.labelW + 0.01 || lm.h > cfg.labelH + 0.01) {
    warns.push(t("標籤（{w} × {h} mm）比格子大，輸出時會縮小以放進格子。", { w: lm.w, h: lm.h }));
  }
  const warn = $("sh-warn");
  warn.hidden = warns.length === 0;
  warn.textContent = warns.join(" ");

  $("sh-page").textContent = t("第 {n} / {total} 頁", { n: page + 1, total: pages.length });
  $<HTMLButtonElement>("sh-prev").disabled = page <= 0;
  $<HTMLButtonElement>("sh-next").disabled = page >= pages.length - 1;
  $("sh-nav").hidden = pages.length <= 1;
  $("sh-info").textContent = t("{labels} 張標籤，共 {pages} 頁（每頁 {per} 格）　解析度 {dpi} dpi", { labels: recs.length, pages: pages.length, per, dpi: cfg.dpi });
  for (const id of ["sh-pdf", "sh-print"]) $<HTMLButtonElement>(id).disabled = busy || recs.length === 0;
}

/** 依目前設定逐頁畫出整頁畫布（最終解析度）。逐頁處理，避免同時佔用大量記憶體 */
async function eachPage(fn: (canvas: HTMLCanvasElement, i: number, total: number) => Promise<void>): Promise<void> {
  const lay = computeLayout(cfg);
  const pages = planPages(cfg, recs.length);
  const ppm = cfg.dpi / 25.4;
  const cache = new Map<Row, HTMLCanvasElement>();
  for (let i = 0; i < pages.length; i++) {
    api.status(t("正在排版第 {n} / {total} 頁…", { n: i + 1, total: pages.length }));
    await new Promise((r) => setTimeout(r, 0)); // 讓畫面有機會更新狀態文字
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(lay.page.w * ppm);
    canvas.height = Math.round(lay.page.h * ppm);
    drawPage(canvas.getContext("2d")!, lay, ppm, labelItems(i, ppm, cache));
    await fn(canvas, i, pages.length);
    canvas.width = canvas.height = 0; // 釋放記憶體
  }
}

async function exportPdf(): Promise<void> {
  if (busy) return;
  busy = true; await refresh();
  try {
    const out: PdfPage[] = [];
    await eachPage(async (canvas) => {
      out.push({ width: canvas.width, height: canvas.height, data: await canvasToFlateRgb(canvas) });
    });
    const ps = pageSize(cfg);
    const bytes = buildPdf(out, ps.w, ps.h);
    const path = await api.savePdf(bytes);
    api.status(path ? t("PDF 已儲存：{path}", { path }) : t("已取消"), path ? "ok" : "");
  } catch (e) {
    api.status(t("排版失敗：{err}", { err: String(e) }), "err");
  } finally {
    busy = false; void refresh();
  }
}

async function printSheets(): Promise<void> {
  if (busy) return;
  busy = true; await refresh();
  if (api.before && !(await api.before())) {
    $<HTMLDialogElement>("dlg-sheet").close();
    busy = false; void refresh();
    return;
  }
  const urls: string[] = [];
  try {
    const host = $("sheet-print");
    host.replaceChildren();
    const ps = pageSize(cfg);
    await eachPage(async (canvas) => {
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
      if (!blob) throw new Error("toBlob");
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const img = new Image();
      img.src = url;
      img.style.width = `${ps.w}mm`;
      img.style.height = `${ps.h}mm`;
      await img.decode();
      host.append(img);
    });
    // 紙張大小與零邊界：整頁影像剛好鋪滿整張紙
    let style = document.getElementById("sheet-page-style");
    if (!style) { style = document.createElement("style"); style.id = "sheet-page-style"; document.head.append(style); }
    style.textContent = `@page { size: ${ps.w}mm ${ps.h}mm; margin: 0; }`;
    const count = recs.length;
    // 列印視窗不會回報按了「列印」還是「取消」，改看列印佇列有沒有新工作；監看不了就不顯示
    const watching = beerDue(count) && (await invoke<boolean>("watch_print_jobs").catch(() => false));
    const done = () => {
      window.removeEventListener("afterprint", done);
      document.body.classList.remove("printing-sheet");
      host.replaceChildren();
      for (const u of urls) URL.revokeObjectURL(u);
      if (watching) void invoke<boolean>("print_job_added").then((added) => { if (added) maybeAskBeer(count); }).catch(() => { /* 查不到就不顯示 */ });
    };
    window.addEventListener("afterprint", done);
    document.body.classList.add("printing-sheet");
    api.status(t("已送到列印對話框（{pages} 頁）。請在 Windows 的列印視窗選擇印表機，縮放選「100%／實際大小」，邊界選「無」。", { pages: urls.length }), "ok");
    window.print();
  } catch (e) {
    api.status(t("排版失敗：{err}", { err: String(e) }), "err");
    document.body.classList.remove("printing-sheet");
    for (const u of urls) URL.revokeObjectURL(u);
  } finally {
    busy = false; void refresh();
  }
}

export async function openSheet(): Promise<void> {
  if (!api) return;
  if (api.before && !(await api.before())) return;
  const hasSaved = (() => { try { return localStorage.getItem(SAVED_KEY) !== null; } catch { return false; } })();
  cfg = loadSheet();
  const lm = api.labelMm();
  if (!hasSaved) {
    // 第一次使用：以目前標籤尺寸，在 A4 安全邊界內自動排滿
    cfg = autoFit({ ...cfg, labelW: lm.w, labelH: lm.h });
  }
  writeForm(cfg);
  const src = api.source();
  const resolved = await api.resolve(src.rows, src.raws);
  const copies = Math.max(1, api.copies());
  recs = resolved.flatMap((r) => Array.from({ length: copies }, () => r));
  previewCache.clear();
  page = 0;
  const dlg = $<HTMLDialogElement>("dlg-sheet");
  if (!dlg.open) dlg.showModal();
  await refresh();
}

export function initSheet(a: SheetApi): void {
  api = a;
  const dlg = $<HTMLDialogElement>("dlg-sheet");
  for (const id of ["sh-close", "sh-close-x"]) $(id).addEventListener("click", () => dlg.close());
  const redraw = () => requestAnimationFrame(() => void refresh());
  for (const id of ["sh-paper", "sh-orient", "sh-pw", "sh-ph", "sh-lw", "sh-lh", "sh-cols", "sh-rows", "sh-ml", "sh-mt", "sh-gx", "sh-gy", "sh-safe", "sh-start", "sh-cut", "sh-dpi"]) {
    $(id).addEventListener("input", redraw);
    $(id).addEventListener("change", redraw);
  }
  // 換用途時帶入合理的裁切線預設：貼紙紙不印，普通紙印角落標記
  $("sh-kind").addEventListener("change", () => {
    $<HTMLSelectElement>("sh-cut").value = $<HTMLSelectElement>("sh-kind").value === "die" ? "none" : "marks";
    redraw();
  });
  $("sh-use-label").addEventListener("click", () => {
    const lm = api.labelMm();
    $<HTMLInputElement>("sh-lw").value = String(lm.w);
    $<HTMLInputElement>("sh-lh").value = String(lm.h);
    redraw();
  });
  $("sh-fit").addEventListener("click", () => { writeForm(autoFit(readForm())); redraw(); });
  $("sh-prev").addEventListener("click", () => { page--; void refresh(); });
  $("sh-next").addEventListener("click", () => { page++; void refresh(); });
  $("sh-pdf").addEventListener("click", () => void exportPdf());
  $("sh-print").addEventListener("click", () => void printSheets());
}
