// 標籤上的物件：建立、序列化、條碼 / QR Code 渲染。
// 所有物件都是帶有 name="element" 與 kind 屬性的 Konva 節點。

import Konva from "konva";
import JsBarcode from "jsbarcode";
import QRCode from "qrcode";
import { PLACEHOLDER, substitute, type Row } from "./template";
import { t as tr } from "./i18n";

export type Kind = "text" | "rect" | "qr" | "barcode" | "image";

export interface ElementData {
  kind: Kind;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  content?: string;
  fontFamily?: string;
  fontSize?: number;
  bold?: boolean;
  width?: number;
  height?: number;
  filled?: boolean;
  strokeWidth?: number;
  format?: string;
  showText?: boolean;
  moduleWidth?: number;
  /** 條碼（寬度依內容自動改變）的展開方向：left＝左邊固定、往右長（預設）；right＝右邊固定、往左長 */
  anchor?: "left" | "right";
  /** 條碼／QR：改由印表機原生指令列印（預設不啟用；內容含中文、旋轉時自動改用點陣） */
  native?: boolean;
  /** anchor 為 right 時，右邊緣的 x 座標（存檔用；開啟時以它還原位置，不受設計畫面的測試資料長度影響） */
  rightEdge?: number;
  ecLevel?: string;
  src?: string;
  /** 圖層名稱（使用者自訂；未設定時由內容自動產生） */
  label?: string;
  /** 是否顯示（隱藏的物件不會被列印）；預設 true */
  visible?: boolean;
  /** 是否鎖定（鎖定的物件不能被選取或拖曳）；預設 false */
  locked?: boolean;
  /** 縮放時是否維持縱橫比；預設：文字 / QR / 圖片為 true，矩形 / 條碼為 false */
  ratioLock?: boolean;
  /** 鎖定大小（不顯示縮放控制點，屬性對話框也不能改大小）；預設 false */
  sizeLocked?: boolean;
  /** 群組編號：相同編號的物件屬於同一個群組（點其中一個就選到整組，一起移動／縮放）；沒有群組時不存 */
  groupId?: string;
  /** 文字的「最大範圍」：限制在固定大小的文字框內，內容太長時依 overflow 處理 */
  bounded?: boolean;
  /** 最大範圍（文字框）的寬、高，單位 dots */
  boxW?: number;
  boxH?: number;
  /** 超出範圍時：shrink = 自動縮小字級（預設）；none = 不處理 */
  overflow?: Overflow;
  /** 自動縮小時的最小字級（dots）；預設 8 */
  minSize?: number;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
}

export type Overflow = "shrink" | "none";

const DEFAULT_RATIO_LOCK: Record<string, boolean> = { text: true, qr: true, image: true, rect: false, barcode: false };

/** 這個物件縮放時是否維持縱橫比（QR 永遠維持，因為必須是正方形；有最大範圍的文字預設不維持，框的寬高可獨立調整） */
export function ratioLockOf(n: { getAttr(k: string): unknown } | null | undefined): boolean {
  if (!n) return true;
  const kind = String(n.getAttr("kind"));
  if (kind === "qr") return true;
  const v = n.getAttr("ratioLock");
  if (typeof v === "boolean") return v;
  return kind === "text" && n.getAttr("bounded") ? false : DEFAULT_RATIO_LOCK[kind] ?? false;
}

// ---------- 文字的「最大範圍」（超出時自動縮小）----------

/** 這個文字是否啟用了「最大範圍」 */
/**
 * 設計畫面上的文字顯示：把 `{{欄位|格式}}` 簡化成 `{{欄位}}`，避免格式碼讓畫面又長又亂（格式在屬性面板設定）。
 * 真正的內容（含格式）存在節點的 `raw` 屬性，存檔、屬性面板與列印都讀 `contentOf()`。
 */
export const designText = (raw: string): string => raw.replace(/\{\{\s*([^{}|]+?)\s*\|[^{}]*\}\}/g, "{{$1}}");
export const contentOf = (t: Konva.Text): string => (t.getAttr("raw") as string | undefined) ?? t.text();
export function setContent(t: Konva.Text, raw: string): void {
  t.setAttr("raw", raw);
  t.text(designText(raw));
}

export const isBounded =(n: { getAttr(k: string): unknown }): boolean => !!n.getAttr("bounded");

/** 使用者設定的字級。啟用最大範圍時，實際字級可能因為縮小而比它小，所以另外記在 baseSize */
export function baseSizeOf(t: Konva.Text): number {
  return isBounded(t) ? Number(t.getAttr("baseSize")) || t.fontSize() : t.fontSize();
}

/** 設定字級：啟用最大範圍時它是「最大字級」，之後依內容縮小 */
export function setTextSize(t: Konva.Text, size: number): void {
  if (isBounded(t)) {
    t.setAttr("baseSize", size);
    fitText(t);
  } else {
    t.fontSize(size);
  }
}

/**
 * 依最大範圍調整字級：內容放不進文字框時，縮小到「剛好放得進去的最大字級」（不小於最小字級）；
 * 放得進去時恢復為設定的字級。每次內容、字型、範圍改變時都要重新呼叫。
 */
export function fitText(t: Konva.Text): void {
  if (!isBounded(t)) return;
  const w = Number(t.getAttr("boxW")) || 1;
  const h = Number(t.getAttr("boxH")) || 1;
  t.wrap("none"); // 不要自動換行，寬度不夠就縮小字級
  t.align(String(t.getAttr("align") ?? "left"));
  t.verticalAlign(String(t.getAttr("valign") ?? "middle"));
  const base = baseSizeOf(t);
  t.fontSize(base);

  const fits = () => {
    const n = naturalTextSize(t);
    return n.w <= w + 0.01 && n.h <= h + 0.01;
  };
  if (t.getAttr("overflow") !== "none" && !fits()) {
    // 在 [最小字級, 設定字級 - 1] 中用二分搜尋找出放得進去的最大字級；連最小字級都放不進就用最小字級
    const min = Math.min(base, Math.max(1, Number(t.getAttr("minSize")) || 8));
    let lo = min;
    let hi = base - 1;
    let best = min;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      t.fontSize(mid);
      if (fits()) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    t.fontSize(best);
  }

  // Konva 在「固定寬高」下會把放不進的字直接截掉（序號會悄悄少印字！），所以放不進時
  // （選了「不處理」，或縮到最小字級仍放不進）把文字框撐大到剛好放得下，讓文字完整印出。
  const n = naturalTextSize(t);
  t.width(n.w > w + 0.01 ? n.w : w); // 小數點以下的極小誤差不算放不進
  t.height(n.h > h + 0.01 ? n.h : h);
}

/**
 * 文字在目前字型、字級下「不受寬度限制」的自然大小。
 * 不能用 Konva 的 getTextWidth()：文字框有固定寬度時，它回報的是「被截斷之後」的寬度。
 */
export function naturalTextSize(t: Konva.Text): { w: number; h: number } {
  const lines = t.text().split("\n");
  const w = Math.max(0, ...lines.map((l) => t.measureSize(l).width));
  return { w, h: lines.length * t.lineHeight() * t.fontSize() };
}

/** 啟用或取消文字的「最大範圍」。啟用時，範圍預設為目前文字的大小。 */
export function setBounded(t: Konva.Text, on: boolean): void {
  if (on === isBounded(t)) return;
  if (on) {
    // 先把目前的縮放烘進字級與範圍，再固定下來
    const sx = Math.abs(t.scaleX());
    const sy = Math.abs(t.scaleY());
    const size = Math.max(1, Math.round(t.fontSize() * sy));
    const nat = naturalTextSize(t);
    const w = Math.max(10, Math.ceil(nat.w * sx - 0.01)); // 無條件進位，範圍才不會比文字小
    const h = Math.max(6, Math.ceil(nat.h * sy - 0.01));
    t.scale({ x: 1, y: 1 });
    t.setAttrs({ bounded: true, baseSize: size, boxW: w, boxH: h, overflow: "shrink", minSize: 8, align: "left", valign: "middle", ratioLock: false });
    fitText(t);
  } else {
    const size = baseSizeOf(t);
    t.setAttrs({ bounded: false, ratioLock: undefined });
    t.wrap("word");
    t.setAttr("width", "auto"); // 型別定義只允許數字，但 Konva 本身接受 "auto"（寬高由文字內容決定）
    t.setAttr("height", "auto");
    t.align("left");
    t.verticalAlign("top");
    t.fontSize(size);
  }
}

export const BARCODE_FORMATS = ["CODE128", "CODE39", "EAN13", "EAN8", "UPC", "ITF14", "codabar"];
export const DEFAULT_FONT = "Microsoft JhengHei";

/** 未填滿的矩形需要一個幾乎透明的填色，點擊矩形內部才選得到 */
const HIT_FILL = "rgba(255,255,255,0.01)";

export const kindOf = (n: Konva.Node | null | undefined): Kind | null =>
  (n?.getAttr("kind") as Kind | undefined) ?? null;

export function defaults(kind: Kind | "line"): ElementData {
  const base = { x: 20, y: 20, rotation: 0, scaleX: 1, scaleY: 1 };
  switch (kind) {
    case "text":
      return { ...base, kind: "text", content: tr("文字 {{欄位}}"), fontFamily: DEFAULT_FONT, fontSize: 32, bold: false };
    case "rect":
      return { ...base, kind: "rect", width: 200, height: 100, filled: false, strokeWidth: 3 };
    case "line":
      return { ...base, kind: "rect", width: 300, height: 3, filled: true, strokeWidth: 1 };
    case "qr":
      return { ...base, kind: "qr", content: "{{欄位}}", width: 105, ecLevel: "M" }; // 21 個模組 × 5 點
    case "barcode":
      return { ...base, kind: "barcode", content: "123456789", format: "CODE128", showText: true, moduleWidth: 2, height: 80 };
    case "image":
      return { ...base, kind: "image", width: 120, height: 120 };
  }
}

// ---------- 條碼 / QR 點陣 ----------

function errorCanvas(msg: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 220;
  c.height = 48;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = "#000";
  g.setLineDash([6, 4]);
  g.strokeRect(1, 1, c.width - 2, c.height - 2);
  g.fillStyle = "#000";
  g.font = "18px 'Microsoft JhengHei', sans-serif";
  g.textBaseline = "middle";
  g.fillText(msg, 8, c.height / 2);
  return c;
}

type EcLevel = "L" | "M" | "Q" | "H";

/** 內容編碼後的 QR 邊長（模組數）；無法編碼時回傳 0 */
export function qrModuleCount(text: string, ecLevel: string): number {
  try {
    return QRCode.create(text || " ", { errorCorrectionLevel: ecLevel as EcLevel }).modules.size;
  } catch {
    return 0;
  }
}

/** 最接近 size 的「模組數整數倍」大小（每個模組恰為整數點，列印最清晰） */
export function snapQrSize(size: number, modules: number): number {
  return modules * Math.max(1, Math.round(size / modules));
}

/**
 * 同步產生 QR Code 點陣，邊長恰為 size（dots），可以自由縮放。
 * 模組邊界四捨五入到像素：size 剛好是模組數的整數倍時每個模組寬度一致（最清晰）；
 * 否則相鄰模組的寬度會相差 1 點，仍可掃描，但邊緣較不整齊。
 */
export function qrCanvas(text: string, size: number, ecLevel: string): HTMLCanvasElement {
  try {
    const qr = QRCode.create(text || " ", { errorCorrectionLevel: ecLevel as EcLevel });
    const n = qr.modules.size;
    const px = Math.max(n, Math.round(size)); // 至少每個模組 1 點
    const c = document.createElement("canvas");
    c.width = c.height = px;
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, px, px);
    g.fillStyle = "#000";
    const edge = (i: number) => Math.round((i * px) / n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (qr.modules.get(y, x)) g.fillRect(edge(x), edge(y), edge(x + 1) - edge(x), edge(y + 1) - edge(y));
      }
    }
    return c;
  } catch {
    return errorCanvas(tr("QR 內容無法編碼"));
  }
}

export function barcodeCanvas(
  text: string,
  o: { format: string; showText: boolean; moduleWidth: number; height: number },
): HTMLCanvasElement {
  const c = document.createElement("canvas");
  try {
    JsBarcode(c, text || " ", {
      format: o.format,
      displayValue: o.showText,
      width: o.moduleWidth,
      height: o.height,
      margin: 0,
      fontSize: 20,
      textMargin: 2,
      background: "#ffffff",
      lineColor: "#000000",
    });
    return c;
  } catch {
    return errorCanvas(tr("條碼內容無效"));
  }
}

/** 設計畫面用的「變數測試資料」提供者（由 main.ts 設定）；條碼在畫布上會用它的值，這樣寬度才接近實際列印的樣子 */
let designRow: () => Row = () => ({});
export function setDesignRow(f: () => Row): void {
  designRow = f;
}

/** 各條碼格式在「還沒有資料」時畫布上顯示的範例內容（必須是該格式合法的內容） */
const SAMPLE: Record<string, string> = {
  CODE128: "ABC1234567", CODE39: "ABC1234567", EAN13: "590123412345", EAN8: "9638507",
  UPC: "03600029145", ITF14: "1234567890123", codabar: "A0000000A",
};

/**
 * 設計畫面上的條碼內容：先套用「變數測試資料」；仍然沒有值的 {{欄位}} 以範例內容代替，
 * 而不是顯示「條碼內容無效」（變數本身不是合法的條碼內容）。實際列印不走這裡，缺欄位時照舊視為無效，避免印出假資料。
 */
export function barcodeDesignContent(raw: string, format: string): string {
  const c = substitute(raw, designRow());
  if (!new RegExp(PLACEHOLDER.source).test(c)) return c;
  const sample = SAMPLE[format] ?? SAMPLE.CODE128;
  // CODE128 / CODE39 可以含任意長度的文字：每個欄位換成範例；其他格式有固定長度與檢查碼，整個換成範例
  return format === "CODE128" || format === "CODE39" ? c.replace(PLACEHOLDER, sample) : sample;
}

/** 依目前屬性（及可選的資料列）重新產生 QR / 條碼影像。沒有給資料列＝設計畫面；給了＝實際列印／預覽。 */
/** 條碼格式 → TSPL BARCODE 的 code type */
const NATIVE_BARCODE: Record<string, string> = { CODE128: "128", CODE39: "39", EAN13: "EAN13", EAN8: "EAN8", UPC: "UPCA", ITF14: "ITF14", codabar: "CODA" };

/** 傳給後端的原生指令項目（座標為標籤內 dots；後端會加上標籤在紙上的位移） */
export type NativeCode =
  | { kind: "barcode"; x: number; y: number; code: string; height: number; readable: boolean; narrow: number; wide: number; content: string; h: number }
  | { kind: "qr"; x: number; y: number; ecc: string; cell: number; content: string; h: number };

/**
 * 各印表機語言的原生指令能做哪些物件；不能的退回點陣。
 * EPL2 手冊沒有 QR 指令；SBPL（Basic Command）沒有 QR 指令，也沒有 Code128／Code39／ITF／Codabar 的人眼可讀文字指令（只有 EAN／UPC 的說明字體）。
 * TSPL 以外的語言都沒有在實機驗證過（介面上會標「實驗中」）。
 */
export function nativeSupported(lang: string, kind: "barcode" | "qr", format = "", showText = false): boolean {
  switch (lang) {
    case "tspl": case "zpl": case "cpcl": case "dpl": return true;
    case "epl": return kind === "barcode";
    case "sbpl": return kind === "barcode" && (!showText || ["EAN13", "EAN8", "UPC"].includes(format));
    default: return false;
  }
}

/** 這個內容能不能用該格式編成條碼（用 JsBarcode 試編，與畫布上的條碼採同一套規則） */
export function barcodeValid(text: string, format: string): boolean {
  try {
    JsBarcode(document.createElement("canvas"), text, { format });
    return true;
  } catch {
    return false;
  }
}

/**
 * 這個物件在「這一張」標籤上要不要、以及怎麼用原生指令列印；不適用就回傳 null（照舊用點陣）。
 * 不適用：沒有啟用、旋轉過、內容不是半形可列印字元（中文等）、內容缺欄位／不合法（點陣會印出「無效」框，不要交給印表機亂印）。
 * 必須在 refreshCode(node, row) 之後呼叫（條碼寬度依內容而變，x 已依展開方向調整）。
 */
export function nativeCodeFor(node: Konva.Image, row: Row, lang = "tspl"): NativeCode | null {
  if (!node.getAttr("native") || node.rotation() !== 0) return null;
  const kind = kindOf(node);
  const content = substitute(String(node.getAttr("content") ?? ""), row);
  if (!/^[\x20-\x7E]+$/.test(content) || new RegExp(PLACEHOLDER.source).test(content)) return null;
  const x = Math.round(node.x()), y = Math.round(node.y());
  if (kind === "barcode") {
    const format = String(node.getAttr("format") ?? "CODE128");
    const code = NATIVE_BARCODE[format];
    if (!code || !barcodeValid(content, format) || !nativeSupported(lang, "barcode", format, !!node.getAttr("showText"))) return null;
    const narrow = Math.max(1, Number(node.getAttr("moduleWidth")) || 2);
    return { kind: "barcode", x, y, code, height: Math.max(10, Number(node.getAttr("barHeight")) || 80), readable: !!node.getAttr("showText"), narrow, wide: narrow * 2, content, h: Math.round(node.height()) };
  }
  if (kind === "qr") {
    if (!nativeSupported(lang, "qr")) return null;
    const ec = String(node.getAttr("ecLevel") ?? "M");
    const modules = qrModuleCount(content, ec);
    if (!modules) return null;
    const cell = Math.max(1, Math.round((Number(node.getAttr("qrSize")) || modules) / modules));
    return { kind: "qr", x, y, ecc: ec, cell, content, h: Math.round(node.height()) };
  }
  return null;
}

export function refreshCode(node: Konva.Image, row?: Row): void {
  const isQr = kindOf(node) === "qr";
  const raw = String(node.getAttr("content") ?? "");
  const content = !isQr && row === undefined ? barcodeDesignContent(raw, String(node.getAttr("format") ?? "CODE128")) : substitute(raw, row ?? {});
  // 條碼寬度依內容而變：「向左展開」時右邊緣固定，只改 x
  const keepRight = !isQr && node.getAttr("anchor") === "right" && node.rotation() === 0 ? node.x() + node.width() : null;
  if (isQr) node.setAttr("qrModules", qrModuleCount(content, String(node.getAttr("ecLevel") ?? "M"))); // 供屬性面板顯示
  const canvas =
    isQr
      ? qrCanvas(content, Number(node.getAttr("qrSize")) || 105, String(node.getAttr("ecLevel") ?? "M"))
      : barcodeCanvas(content, {
          format: String(node.getAttr("format") ?? "CODE128"),
          showText: !!node.getAttr("showText"),
          moduleWidth: Number(node.getAttr("moduleWidth")) || 2,
          height: Number(node.getAttr("barHeight")) || 80,
        });
  node.image(canvas);
  node.size({ width: canvas.width, height: canvas.height });
  if (keepRight !== null) node.x(keepRight - canvas.width);
}

export function applyRectStyle(r: Konva.Rect): void {
  const filled = !!r.getAttr("filled");
  r.fill(filled ? "black" : HIT_FILL);
}

// ---------- 建立 / 序列化 ----------

export async function createElement(d: ElementData): Promise<Konva.Shape> {
  const common = {
    x: d.x, y: d.y, rotation: d.rotation, scaleX: d.scaleX, scaleY: d.scaleY,
    draggable: !d.locked, listening: !d.locked, visible: d.visible !== false,
    name: "element", kind: d.kind, label: d.label, locked: !!d.locked,
    ratioLock: d.ratioLock ?? DEFAULT_RATIO_LOCK[d.kind], sizeLocked: !!d.sizeLocked,
    groupId: d.groupId,
  };

  switch (d.kind) {
    case "text": {
      const t = new Konva.Text({
        ...common, text: designText(d.content ?? ""), raw: d.content ?? "", fontFamily: d.fontFamily ?? DEFAULT_FONT,
        fontSize: d.fontSize ?? 32, fontStyle: d.bold ? "bold" : "normal", fill: "black",
      });
      if (d.bounded) {
        t.setAttrs({
          bounded: true, baseSize: d.fontSize ?? 32, boxW: d.boxW ?? 200, boxH: d.boxH ?? 50,
          overflow: d.overflow ?? "shrink", minSize: d.minSize ?? 8, align: d.align ?? "left", valign: d.valign ?? "middle",
        });
        fitText(t);
      }
      // 有最大範圍的文字：縮放控制點改變的是「範圍」的大小，字級不跟著縮放（字級由內容與範圍決定）
      t.on("transformend", () => {
        if (!isBounded(t)) return;
        // 用設定的範圍（而不是可能因「放不進而撐大」的實際寬高）乘上縮放量
        const w = Number(t.getAttr("boxW")) * Math.abs(t.scaleX());
        const h = Number(t.getAttr("boxH")) * Math.abs(t.scaleY());
        t.scale({ x: 1, y: 1 });
        t.setAttrs({ boxW: Math.max(4, Math.round(w)), boxH: Math.max(4, Math.round(h)) });
        fitText(t);
      });
      return t;
    }

    case "rect": {
      const r = new Konva.Rect({
        ...common, width: d.width ?? 200, height: d.height ?? 100,
        stroke: "black", strokeWidth: d.strokeWidth ?? 3, filled: !!d.filled,
      });
      applyRectStyle(r);
      return r;
    }

    case "qr": {
      const node = new Konva.Image({ ...common, image: undefined, content: d.content ?? "", qrSize: d.width ?? 105, ecLevel: d.ecLevel ?? "M", ...(d.native ? { native: true } : {}) });
      refreshCode(node);
      // 縮放結束後把縮放量烘進尺寸並重新產生；大小完全跟著拖曳的比例走（不再強制貼齊整數模組）
      node.on("transformend", () => {
        const s = Math.round(node.width() * Math.abs((node.scaleX() + node.scaleY()) / 2));
        node.scale({ x: 1, y: 1 });
        node.setAttr("qrSize", Math.max(1, s));
        refreshCode(node);
      });
      return node;
    }

    case "barcode": {
      const node = new Konva.Image({
        ...common, image: undefined, content: d.content ?? "", format: d.format ?? "CODE128",
        showText: d.showText ?? true, moduleWidth: d.moduleWidth ?? 2, barHeight: d.height ?? 80, ...(d.native ? { native: true } : {}),
      });
      refreshCode(node);
      if (d.anchor === "right") {
        // 先以左邊緣建立，量出設計畫面上的寬度之後才切到「向左展開」，並依存檔的右邊緣還原位置
        node.setAttr("anchor", "right");
        node.x((d.rightEdge ?? d.x + node.width()) - node.width());
      }
      node.on("transformend", () => {
        const h = Math.round(Number(node.getAttr("barHeight")) * Math.abs(node.scaleY()));
        node.scale({ x: 1, y: 1 });
        node.setAttr("barHeight", Math.max(10, h));
        refreshCode(node);
      });
      return node;
    }

    case "image": {
      const img = new Image();
      img.src = d.src ?? "";
      await img.decode();
      return new Konva.Image({ ...common, image: img, src: d.src, width: d.width ?? img.naturalWidth, height: d.height ?? img.naturalHeight });
    }
  }
}

export function serialize(n: Konva.Node): ElementData {
  const kind = kindOf(n)!;
  const label = n.getAttr("label") as string | undefined;
  const base = {
    kind, x: n.x(), y: n.y(), rotation: n.rotation(), scaleX: n.scaleX(), scaleY: n.scaleY(),
    // 只在偏離預設值時寫入，維持範本檔精簡
    ...(label ? { label } : {}),
    ...(n.visible() ? {} : { visible: false }),
    ...(n.getAttr("locked") ? { locked: true } : {}),
    ...(ratioLockOf(n) !== DEFAULT_RATIO_LOCK[kind] ? { ratioLock: ratioLockOf(n) } : {}),
    ...(n.getAttr("sizeLocked") ? { sizeLocked: true } : {}),
    ...(n.getAttr("groupId") ? { groupId: n.getAttr("groupId") as string } : {}),
  };
  switch (kind) {
    case "text": {
      const t = n as Konva.Text;
      return {
        ...base, content: contentOf(t), fontFamily: t.fontFamily(), fontSize: baseSizeOf(t), bold: t.fontStyle().includes("bold"),
        // 有最大範圍時，存的是「設定的字級」（不是縮小後的字級）與範圍設定
        ...(isBounded(t)
          ? {
              bounded: true, boxW: Number(t.getAttr("boxW")), boxH: Number(t.getAttr("boxH")),
              overflow: (t.getAttr("overflow") ?? "shrink") as Overflow, minSize: Number(t.getAttr("minSize")) || 8,
              align: (t.getAttr("align") ?? "left") as "left" | "center" | "right", valign: (t.getAttr("valign") ?? "middle") as "top" | "middle" | "bottom",
            }
          : {}),
      };
    }
    case "rect": {
      const r = n as Konva.Rect;
      return { ...base, width: r.width(), height: r.height(), filled: !!r.getAttr("filled"), strokeWidth: r.strokeWidth() };
    }
    case "qr":
      return { ...base, content: n.getAttr("content"), width: n.getAttr("qrSize"), ecLevel: n.getAttr("ecLevel"), ...(n.getAttr("native") ? { native: true } : {}) };
    case "barcode":
      return {
        ...base, content: n.getAttr("content"), format: n.getAttr("format"), showText: !!n.getAttr("showText"),
        moduleWidth: n.getAttr("moduleWidth"), height: n.getAttr("barHeight"),
        ...(n.getAttr("native") ? { native: true } : {}),
        ...(n.getAttr("anchor") === "right" ? { anchor: "right" as const, rightEdge: n.x() + (n as Konva.Image).width() } : {}),
      };
    case "image":
      return { ...base, src: n.getAttr("src"), width: (n as Konva.Image).width(), height: (n as Konva.Image).height() };
  }
}
