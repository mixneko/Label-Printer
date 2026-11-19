// 預覽列印：用「與實際列印完全相同」的流程把每一張標籤渲染成要送給印表機的黑白點陣，
// 畫在整張紙上（含標籤範圍與標籤間隙），可逐張檢查，確認後直接列印。

import { monoToCanvas, type PackedBitmap } from "./bitmap";
import type { RawRow, Row } from "./template";

export interface PreviewSource {
  rows: Row[];
  raws: RawRow[];
  /** 每一張的名稱，例如「Excel 第 7 列」 */
  names: string[];
  /** 來源說明，例如「勾選的資料列」或「變數測試資料」 */
  from: string;
}

export interface PreviewApi {
  /** 要預覽 / 列印的資料：資料表有勾選的列就用那些；否則是「變數測試資料」的單張 */
  source(): PreviewSource;
  /** 渲染一張（含欄位格式、最大範圍縮小），並回傳點陣與它在紙上的位置（dots） */
  render(row: Row, raw?: RawRow): Promise<{ bmp: PackedBitmap; offsetX: number; offsetY: number }>;
  /** 紙張與設定摘要 */
  info(): { paperW: number; paperH: number; tplWmm: number; tplHmm: number; paperWmm: number; paperHmm: number; gapMm: number; gapDots: number; copies: number; summary: string };
  /** 以預覽中的這些資料列列印 */
  print(rows: Row[], raws: RawRow[]): Promise<void>;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let api: PreviewApi;
let src: PreviewSource;
let page = 0;
let token = 0; // 快速翻頁時，只採用最後一次要求的結果
const cache = new Map<number, { bmp: PackedBitmap; offsetX: number; offsetY: number }>();

/** 縮放選項：auto = 符合視窗寬度；數字 = 每個點放大幾倍 */
const zoomValue = (): "auto" | number => {
  const v = $<HTMLSelectElement>("pv-zoom").value;
  return v === "auto" ? "auto" : Number(v);
};

function layoutPaper(): void {
  const inf = api.info();
  const paper = $("pv-paper");
  const z = zoomValue();
  paper.style.width = z === "auto" ? "100%" : `${inf.paperW * z}px`;
  const gap = $("pv-gap");
  gap.style.aspectRatio = `${inf.paperW} / ${Math.max(1, inf.gapDots)}`;
  gap.style.minHeight = "22px";
  $("pv-gap-text").textContent = `間隙 ${inf.gapMm} mm（標籤與標籤之間的空白）`;
  $("pv-gap").hidden = inf.gapDots <= 0;
}

async function showPage(i: number): Promise<void> {
  page = Math.max(0, Math.min(src.rows.length - 1, i));
  const my = ++token;
  const inf = api.info();
  const total = src.rows.length;

  $("pv-page").textContent = total > 1 ? `第 ${page + 1} / ${total} 張（${src.names[page]}）` : src.from;
  $<HTMLButtonElement>("pv-prev").disabled = page <= 0;
  $<HTMLButtonElement>("pv-next").disabled = page >= total - 1;
  $("pv-nav").hidden = total <= 1;

  let r = cache.get(page);
  if (!r) {
    try {
      r = await api.render(src.rows[page], src.raws[page]);
    } catch (e) {
      if (my === token) $("pv-info").textContent = `渲染失敗：${String(e)}`;
      return;
    }
    cache.set(page, r);
  }
  if (my !== token) return; // 已經翻到別頁了

  // 組合整張紙：白底，點陣放在它實際會被印出的位置
  const canvas = $<HTMLCanvasElement>("pv-canvas");
  canvas.width = inf.paperW;
  canvas.height = inf.paperH;
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  const tmp = document.createElement("canvas");
  monoToCanvas(r.bmp, tmp);
  g.drawImage(tmp, r.offsetX, r.offsetY);

  // 標籤範圍的虛線框（用 CSS 疊在上面，不會改到點陣本身）
  const area = $("pv-area");
  area.style.left = `${(r.offsetX / inf.paperW) * 100}%`;
  area.style.top = `${(r.offsetY / inf.paperH) * 100}%`;
  area.style.width = `${(r.bmp.width / inf.paperW) * 100}%`;
  area.style.height = `${(r.bmp.height / inf.paperH) * 100}%`;
  area.hidden = !$<HTMLInputElement>("pv-area-toggle").checked;
}

function fillInfo(): void {
  const inf = api.info();
  const total = src.rows.length;
  $("pv-info").textContent =
    `紙張 ${inf.paperWmm} × ${inf.paperHmm} mm（${inf.paperW} × ${inf.paperH} 點）　標籤 ${inf.tplWmm} × ${inf.tplHmm} mm　${inf.summary}`;
  const sheets = total * inf.copies;
  $("pv-total").textContent = `${total} 筆資料 × 每筆 ${inf.copies} 張 = ${sheets} 張`;
  $("pv-print").textContent = `列印 ${sheets} 張`;
}

export async function openPreview(): Promise<void> {
  if (!api) return;
  src = api.source();
  cache.clear();
  page = 0;
  layoutPaper();
  fillInfo();
  const dlg = $<HTMLDialogElement>("pv-dialog");
  if (!dlg.open) dlg.showModal();
  await showPage(0);
}

export function initPreview(a: PreviewApi): void {
  api = a;
  const dlg = $<HTMLDialogElement>("pv-dialog");
  $("pv-close").addEventListener("click", () => dlg.close());
  $("pv-close-x").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  $("pv-prev").addEventListener("click", () => void showPage(page - 1));
  $("pv-next").addEventListener("click", () => void showPage(page + 1));
  $("pv-zoom").addEventListener("change", () => layoutPaper());
  $("pv-area-toggle").addEventListener("change", () => { $("pv-area").hidden = !$<HTMLInputElement>("pv-area-toggle").checked; });
  // 方向鍵翻頁（在輸入欄位內不攔截）
  dlg.addEventListener("keydown", (e) => {
    if (["INPUT", "SELECT", "TEXTAREA"].includes((e.target as HTMLElement).tagName)) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); void showPage(page - 1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); void showPage(page + 1); }
    else if (e.key === "Home") { e.preventDefault(); void showPage(0); }
    else if (e.key === "End") { e.preventDefault(); void showPage(src.rows.length - 1); }
  });
  $("pv-print").addEventListener("click", async () => {
    const btn = $<HTMLButtonElement>("pv-print");
    btn.disabled = true;
    try {
      await api.print(src.rows, src.raws);
      dlg.close();
    } finally {
      btn.disabled = false;
    }
  });
}
