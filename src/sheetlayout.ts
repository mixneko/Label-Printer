// 貼紙紙／A4 排版：版面計算、裁切標記、整頁繪製與 PDF 輸出（純函式為主，方便測試）。
// 單位一律 mm；原點在紙張左上角。

import { t } from "./i18n";

export type PaperKind = "a4" | "letter" | "custom";
export type CutMode = "none" | "marks" | "lines";

export interface SheetConfig {
  paper: PaperKind;
  /** 自訂紙張尺寸（paper = custom 時使用；直式的寬、高） */
  paperW: number;
  paperH: number;
  landscape: boolean;
  /** die＝有模切的貼紙紙（預設不印裁切線）；plain＝沒有裁切線的普通紙（預設印輔助裁切標記） */
  kind: "die" | "plain";
  labelW: number;
  labelH: number;
  cols: number;
  rows: number;
  marginL: number;
  marginT: number;
  gapX: number;
  gapY: number;
  /** 安全邊界：印表機通常印不到紙邊，這一圈內不要放任何東西 */
  safe: number;
  cut: CutMode;
  /** 第一頁從第幾格開始（1 起算），用來接續用過一半的貼紙紙 */
  start: number;
  /** 輸出解析度（dpi） */
  dpi: number;
}

export const PAPERS: Record<Exclude<PaperKind, "custom">, { w: number; h: number }> = {
  a4: { w: 210, h: 297 },
  letter: { w: 215.9, h: 279.4 },
};

export const DEFAULT_SHEET: SheetConfig = {
  paper: "a4", paperW: 210, paperH: 297, landscape: false, kind: "plain",
  labelW: 60, labelH: 30, cols: 3, rows: 8, marginL: 15, marginT: 20, gapX: 0, gapY: 0,
  safe: 5, cut: "marks", start: 1, dpi: 300,
};

/** 裁切標記離格線區的距離與長度（mm） */
export const MARK_OFFSET = 1.5;
export const MARK_LEN = 4;

const KEY = "label-printer.sheet";

const num = (v: unknown, min: number, max: number, fb: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fb;
};

/** 檢查並補齊設定（來自 localStorage 或輸入欄位），數值限制在合理範圍 */
export function sanitize(c: Partial<SheetConfig>): SheetConfig {
  const d = DEFAULT_SHEET;
  const paper: PaperKind = c.paper === "letter" || c.paper === "custom" ? c.paper : "a4";
  return {
    paper,
    paperW: num(c.paperW, 20, 1000, d.paperW),
    paperH: num(c.paperH, 20, 1000, d.paperH),
    landscape: !!c.landscape,
    kind: c.kind === "die" ? "die" : "plain",
    labelW: num(c.labelW, 1, 1000, d.labelW),
    labelH: num(c.labelH, 1, 1000, d.labelH),
    cols: Math.round(num(c.cols, 1, 50, d.cols)),
    rows: Math.round(num(c.rows, 1, 100, d.rows)),
    marginL: num(c.marginL, 0, 500, d.marginL),
    marginT: num(c.marginT, 0, 500, d.marginT),
    gapX: num(c.gapX, 0, 200, d.gapX),
    gapY: num(c.gapY, 0, 200, d.gapY),
    safe: num(c.safe, 0, 30, d.safe),
    cut: c.cut === "none" || c.cut === "lines" ? c.cut : "marks",
    start: Math.round(num(c.start, 1, 5000, 1)),
    dpi: [300, 406].includes(Number(c.dpi)) ? Number(c.dpi) : 300,
  };
}

export function loadSheet(): SheetConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return sanitize(JSON.parse(raw));
  } catch { /* 沒有儲存的設定就用預設 */ }
  return { ...DEFAULT_SHEET };
}

export function saveSheet(c: SheetConfig): void {
  try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* ignore */ }
}

/** 實際紙張尺寸（含橫式） */
export function pageSize(c: SheetConfig): { w: number; h: number } {
  const base = c.paper === "custom" ? { w: c.paperW, h: c.paperH } : PAPERS[c.paper];
  return c.landscape ? { w: base.h, h: base.w } : { ...base };
}

export interface Cell { col: number; row: number; x: number; y: number; w: number; h: number; outside: boolean }
export interface Seg { x1: number; y1: number; x2: number; y2: number; dashed?: boolean }
export interface Layout {
  page: { w: number; h: number };
  cells: Cell[];
  grid: { x: number; y: number; w: number; h: number };
  cutX: number[];
  cutY: number[];
  marks: Seg[];
  warnings: string[];
}

const uniq = (v: number[]): number[] => {
  const s = [...v].sort((a, b) => a - b);
  return s.filter((x, i) => i === 0 || Math.abs(x - s[i - 1]) > 0.005);
};

export function computeLayout(c: SheetConfig): Layout {
  const page = pageSize(c);
  const gridW = c.cols * c.labelW + (c.cols - 1) * c.gapX;
  const gridH = c.rows * c.labelH + (c.rows - 1) * c.gapY;
  const grid = { x: c.marginL, y: c.marginT, w: gridW, h: gridH };
  const warnings: string[] = [];

  const cells: Cell[] = [];
  let outside = 0;
  for (let r = 0; r < c.rows; r++) {
    for (let k = 0; k < c.cols; k++) {
      const x = c.marginL + k * (c.labelW + c.gapX);
      const y = c.marginT + r * (c.labelH + c.gapY);
      const out = x < c.safe - 1e-6 || y < c.safe - 1e-6 || x + c.labelW > page.w - c.safe + 1e-6 || y + c.labelH > page.h - c.safe + 1e-6;
      if (out) outside++;
      cells.push({ col: k, row: r, x, y, w: c.labelW, h: c.labelH, outside: out });
    }
  }
  if (grid.x < 0 || grid.y < 0 || grid.x + gridW > page.w + 1e-6 || grid.y + gridH > page.h + 1e-6) {
    warnings.push(t("格子超出了紙張範圍，請減少欄數或列數，或縮小邊界與間距。"));
  } else if (outside > 0) {
    warnings.push(t("有 {n} 格超出安全邊界（{safe} mm），印表機可能印不到邊緣，內容會被切掉。", { n: outside, safe: c.safe }));
  }

  const cutX = uniq(Array.from({ length: c.cols }, (_, k) => c.marginL + k * (c.labelW + c.gapX)).flatMap((x) => [x, x + c.labelW]));
  const cutY = uniq(Array.from({ length: c.rows }, (_, r) => c.marginT + r * (c.labelH + c.gapY)).flatMap((y) => [y, y + c.labelH]));

  const marks: Seg[] = [];
  if (c.cut !== "none") {
    const top = grid.y, bottom = grid.y + gridH, left = grid.x, right = grid.x + gridW;
    // 每一側可用的長度：從格線區往紙邊，扣掉安全邊界與離格線區的距離
    const room = {
      top: top - c.safe - MARK_OFFSET, bottom: page.h - c.safe - bottom - MARK_OFFSET,
      left: left - c.safe - MARK_OFFSET, right: page.w - c.safe - right - MARK_OFFSET,
    };
    const len = (r: number) => Math.min(MARK_LEN, r);
    if (c.cut === "marks") {
      let tooTight = false;
      const side = (r: number) => { if (r < 1) tooTight = true; return len(r); };
      const lt = side(room.top), lb = side(room.bottom), ll = side(room.left), lr = side(room.right);
      for (const x of cutX) {
        if (lt >= 1) marks.push({ x1: x, y1: top - MARK_OFFSET - lt, x2: x, y2: top - MARK_OFFSET });
        if (lb >= 1) marks.push({ x1: x, y1: bottom + MARK_OFFSET, x2: x, y2: bottom + MARK_OFFSET + lb });
      }
      for (const y of cutY) {
        if (ll >= 1) marks.push({ x1: left - MARK_OFFSET - ll, y1: y, x2: left - MARK_OFFSET, y2: y });
        if (lr >= 1) marks.push({ x1: right + MARK_OFFSET, y1: y, x2: right + MARK_OFFSET + lr, y2: y });
      }
      if (tooTight) warnings.push(t("邊界不夠放裁切標記（至少需要安全邊界再加 2.5 mm），部分標記被省略或縮短；請加大邊界。"));
    } else {
      // 虛線格線：沿著每條裁切位置，從格線區往兩端各多畫一小段
      const ext = (r: number) => Math.max(0, Math.min(MARK_LEN, r));
      const ex = { t: ext(room.top), b: ext(room.bottom), l: ext(room.left), r: ext(room.right) };
      for (const x of cutX) marks.push({ x1: x, y1: top - ex.t, x2: x, y2: bottom + ex.b, dashed: true });
      for (const y of cutY) marks.push({ x1: left - ex.l, y1: y, x2: right + ex.r, y2: y, dashed: true });
    }
  }
  return { page, cells, grid, cutX, cutY, marks, warnings };
}

/** 依標籤與間距，在安全邊界內（印裁切標記時再多留 2.5 mm）盡量排滿，並置中 */
export function autoFit(c: SheetConfig): SheetConfig {
  const page = pageSize(c);
  const extra = c.cut === "none" ? 0 : MARK_OFFSET + 1;
  const usableW = page.w - 2 * (c.safe + extra);
  const usableH = page.h - 2 * (c.safe + extra);
  const cols = Math.max(1, Math.floor((usableW + c.gapX) / (c.labelW + c.gapX) + 1e-9));
  const rows = Math.max(1, Math.floor((usableH + c.gapY) / (c.labelH + c.gapY) + 1e-9));
  const gw = cols * c.labelW + (cols - 1) * c.gapX;
  const gh = rows * c.labelH + (rows - 1) * c.gapY;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return { ...c, cols, rows, marginL: r1((page.w - gw) / 2), marginT: r1((page.h - gh) / 2) };
}

/** 把 n 筆資料依序分到各頁各格。第一頁從第 start 格開始，之後每頁從第 1 格開始 */
export function planPages(c: SheetConfig, n: number): { cell: number; rec: number }[][] {
  const per = c.cols * c.rows;
  const pages: { cell: number; rec: number }[][] = [];
  let cell = Math.min(Math.max(1, c.start), per) - 1;
  let cur: { cell: number; rec: number }[] = [];
  for (let rec = 0; rec < n; rec++) {
    if (cell >= per) { pages.push(cur); cur = []; cell = 0; }
    cur.push({ cell, rec });
    cell++;
  }
  if (cur.length || n === 0) pages.push(cur);
  return pages;
}

/** 在 ctx 上畫一頁：標籤（置中、不放大、太大才縮小）加裁切標記。ppm = 每 mm 幾個像素 */
export function drawPage(
  ctx: CanvasRenderingContext2D, lay: Layout, ppm: number,
  items: { cell: number; img: CanvasImageSource; w: number; h: number }[],
): void {
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, lay.page.w * ppm, lay.page.h * ppm);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  for (const it of items) {
    const cell = lay.cells[it.cell];
    if (!cell) continue;
    const s = Math.min(1, cell.w / it.w, cell.h / it.h);
    const w = it.w * s, h = it.h * s;
    ctx.drawImage(it.img, (cell.x + (cell.w - w) / 2) * ppm, (cell.y + (cell.h - h) / 2) * ppm, w * ppm, h * ppm);
  }
  drawMarks(ctx, lay.marks, ppm, Math.max(1, Math.round(0.2 * ppm)));
}

export function drawMarks(ctx: CanvasRenderingContext2D, marks: Seg[], ppm: number, lineWidth: number): void {
  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.lineWidth = lineWidth;
  for (const s of marks) {
    ctx.setLineDash(s.dashed ? [Math.round(2 * ppm), Math.round(1.2 * ppm)] : []);
    ctx.beginPath();
    ctx.moveTo(s.x1 * ppm, s.y1 * ppm);
    ctx.lineTo(s.x2 * ppm, s.y2 * ppm);
    ctx.stroke();
  }
  ctx.restore();
}

// ---------- PDF ----------

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 把一頁畫布轉成 RGB（PDF 的影像資料不含透明度），再以 zlib 壓縮 */
export async function canvasToFlateRgb(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const { width, height } = canvas;
  const rgba = canvas.getContext("2d")!.getImageData(0, 0, width, height).data;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2];
  }
  return deflate(rgb);
}

export interface PdfPage { width: number; height: number; data: Uint8Array }

/** 組成 PDF：每頁一張整頁影像，頁面大小就是紙張的 mm（以 pt 表示） */
export function buildPdf(pages: PdfPage[], pageWmm: number, pageHmm: number): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let len = 0;
  const push = (b: Uint8Array | string) => { const u = typeof b === "string" ? enc.encode(b) : b; chunks.push(u); len += u.length; };
  const pt = (mm: number) => Math.round((mm * 72 / 25.4) * 100) / 100;
  const W = pt(pageWmm), H = pt(pageHmm);
  const kids = pages.map((_, i) => `${3 + 3 * i} 0 R`).join(" ");

  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  offsets[1] = len; push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  offsets[2] = len; push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);
  pages.forEach((p, i) => {
    const po = 3 + 3 * i, co = po + 1, io = po + 2;
    offsets[po] = len;
    push(`${po} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${io} 0 R >> >> /Contents ${co} 0 R >>\nendobj\n`);
    const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q\n`;
    offsets[co] = len;
    push(`${co} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);
    offsets[io] = len;
    push(`${io} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${p.data.length} >>\nstream\n`);
    push(p.data);
    push("\nendstream\nendobj\n");
  });
  const count = 3 + 3 * pages.length;
  const xref = len;
  let x = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) x += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  push(x + `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(len);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
