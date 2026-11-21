// 應用設定（紙張、標籤、印表機、列印品質）。目前存在 localStorage，之後可改為檔案。

/** TTP-244 Pro 為 203 dpi，約 8 dots/mm */
export const DOTS_PER_MM = 8;

/** 支援的印表機語言（代碼對應後端 langs.rs）。TSPL 以外都是實驗性質：只送點陣，沒有實機驗證 */
export const PRINT_LANGS = [
  { id: "tspl", name: "TSPL（TSC）" },
  { id: "zpl", name: "ZPL II（Zebra）" },
  { id: "epl", name: "EPL2（Zebra／Eltron）" },
  { id: "cpcl", name: "CPCL（Zebra 行動式等）" },
  { id: "dpl", name: "DPL（Datamax-O'Neil）" },
  { id: "sbpl", name: "SBPL（SATO）" },
] as const;

export interface Settings {
  /** 設定格式版本，用於升級舊設定 */
  schema: number;
  paperWmm: number;
  paperHmm: number;
  tplWmm: number;
  tplHmm: number;
  /** 標籤之間的間隙高度（mm）。TSC 驅動的「間隙高度」即是這個值 */
  gapMm: number;
  /** windows = 使用 Windows 已安裝的印表機（預設）；tcp = 直連 Raw TCP */
  printerMode: "windows" | "tcp";
  printerName: string;
  host: string;
  port: number;
  /** 印表機語言：auto＝依 Windows 驅動程式名稱偵測（只在 Windows 模式有意義；直連 TCP 沒有驅動可看，必須自己選）；其餘為 PRINT_LANGS 的 id */
  printerLang: string;
  /** 首次設定（選擇列印用的印表機與語言）是否完成。新安裝為 false，會跳出設定對話框；從舊版升級（設定已存在）視為已完成 */
  setupDone: boolean;
  /** 列印濃度 0～15（數字越大越黑） */
  density: number;
  /** 列印速度 1～6（慢一點通常比較黑） */
  speed: number;
  /** 字體加粗 0～4：提高黑白轉換的門檻，讓文字邊緣的淡灰色也印成黑點，筆畫變粗 */
  boldness: number;
  /** 列印後把標籤送到撕紙位置（對應驅動的「列印後動作：撕開」） */
  tear: boolean;
  /** 列印後額外多送（正）或回收（負）的紙長，mm（對應驅動的「送紙位移」） */
  feedOffsetMm: number;
  /** 位置微調（mm）：整個標籤在紙上往右（正）／往左（負）移，用來校正印出位置偏移 */
  shiftXmm: number;
  /** 位置微調（mm）：往下移（0～5）；標籤與紙同高，往上移會切掉內容，所以不提供 */
  shiftYmm: number;
}

const SCHEMA = 2;

export const DEFAULT_SETTINGS: Settings = {
  schema: SCHEMA,
  paperWmm: 62.5,
  paperHmm: 30,
  tplWmm: 60,
  tplHmm: 30,
  gapMm: 2,
  printerMode: "windows",
  printerName: "",
  host: "192.168.1.100",
  port: 9103,
  printerLang: "auto",
  setupDone: false,
  density: 10,
  speed: 4,
  boldness: 0,
  tear: true,
  feedOffsetMm: 0,
  shiftXmm: 0,
  shiftYmm: 0,
};

const KEY = "label-printer.settings";

const clamp = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** 黑白轉換的門檻（0～255）：亮度低於它的點印成黑。加粗等級越高，門檻越高，筆畫越粗 */
export const thresholdOf = (s: Pick<Settings, "boldness">): number => 128 + clamp(s.boldness, 0, 4, 0) * 20;

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const stored = JSON.parse(raw) as Partial<Settings>;
      const s: Settings = { ...DEFAULT_SETTINGS, ...stored };
      // 舊版（schema 1）預設間隙是 3 mm，但實際驅動設定為 2.0 mm；升級時套用新預設一次
      if ((stored.schema ?? 1) < SCHEMA) s.gapMm = DEFAULT_SETTINGS.gapMm;
      s.schema = SCHEMA;
      // 已有設定檔、但沒有這個欄位：是舊版使用者，印表機早就選過了，不再詢問
      s.setupDone = stored.setupDone ?? true;
      // 舊版（還沒有「印表機語言」）一直都是以 TSPL 列印：升級後明確記成 TSPL，不要變成「自動偵測」而在偵測不到時被擋下
      if (stored.printerLang === undefined) s.printerLang = "tspl";
      // auto＝依驅動偵測；office＝一般印表機（不是標籤機，列印與預覽改用 A4／貼紙紙排版）；其餘為標籤機語言
      if (s.printerLang !== "auto" && s.printerLang !== "office" && !PRINT_LANGS.some((l) => l.id === s.printerLang)) s.printerLang = "auto";
      s.density = Math.round(clamp(s.density, 0, 15, DEFAULT_SETTINGS.density));
      s.speed = Math.round(clamp(s.speed, 1, 6, DEFAULT_SETTINGS.speed));
      s.boldness = Math.round(clamp(s.boldness, 0, 4, 0));
      s.feedOffsetMm = clamp(s.feedOffsetMm, -20, 20, 0);
      s.shiftXmm = clamp(s.shiftXmm, -5, 5, 0);
      s.shiftYmm = clamp(s.shiftYmm, 0, 5, 0);
      return s;
    }
  } catch {
    /* localStorage 不可用時使用預設值 */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export const mmToDots = (mm: number): number => Math.round(mm * DOTS_PER_MM);
