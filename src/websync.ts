// 網頁版 Excel 的共用部分：呼叫後端下載、自動更新間隔、最近連過的檔案，以及資料改變後勾選列怎麼對回去。

import { invoke } from "./ipc";
import { t } from "./i18n";

export const WEB_PREFIX = "m365:";

export interface Synced {
  status: "ok" | "manual" | "login" | "cancelled" | "failed" | "busy";
  file: string;
  name: string;
  report: string[];
}

export const syncWeb = (url: string, interactive: boolean): Promise<Synced> =>
  invoke<Synced>("m365_sync", { url, interactive, title: t("網頁版 Excel 登入") });

export const logoutWeb = (): Promise<void> => invoke("m365_logout", { title: t("網頁版 Excel 登入") });

// ---- 自動更新間隔（秒；0＝關閉） ----
const INTERVAL_KEY = "label-printer.m365-interval";
export const INTERVALS = [15, 30, 60, 300, 0];
export const DEFAULT_INTERVAL = 30;

export function loadInterval(): number {
  try {
    const raw = localStorage.getItem(INTERVAL_KEY);
    const v = raw === null ? DEFAULT_INTERVAL : Number(raw);
    return INTERVALS.includes(v) ? v : DEFAULT_INTERVAL;
  } catch { return DEFAULT_INTERVAL; }
}

export function saveInterval(v: number): void {
  try { localStorage.setItem(INTERVAL_KEY, String(v)); } catch { /* 記不住就用預設 */ }
}

// ---- 最近連過的檔案（只記網址與檔名，不記任何登入資料） ----
const RECENT_KEY = "label-printer.m365-recent";
const RECENT_MAX = 8;
export interface WebRecent { url: string; name: string }

export function webRecents(): WebRecent[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((e) => e && typeof e.url === "string" && typeof e.name === "string") : [];
  } catch { return []; }
}

export function addWebRecent(url: string, name: string): void {
  const list = [{ url, name }, ...webRecents().filter((e) => e.url !== url)].slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* 記不住就算了 */ }
}

export function removeWebRecent(url: string): void {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(webRecents().filter((e) => e.url !== url))); } catch { /* 算了 */ }
}

// ---- 資料改變後，勾選的列對回哪裡 ----
export interface Remap {
  /** 新資料中應該保持勾選的列索引 */
  checked: number[];
  /** 內容沒變但移到別列的勾選列數 */
  moved: number;
  /** 內容改了或被刪掉、因此取消勾選的列數 */
  lost: number;
  /** 新資料中「舊資料沒有的內容」所在的列索引（標示用） */
  fresh: number[];
}

/**
 * 以整列內容比對：原位置內容相同就保留；移到別處就跟著內容走；找不到相同內容就取消勾選（寧可請使用者重勾，也不要印錯）。
 * 重複的相同內容會一列配一列，優先用原位置，其次最近的。
 */
export function remapRows(oldRows: string[][], newRows: string[][], checked: Iterable<number>): Remap {
  const key = (r: string[]): string => JSON.stringify(r);
  const keys = newRows.map(key);
  const used = new Set<number>();
  const out: Remap = { checked: [], moved: 0, lost: 0, fresh: [] };
  const picked = [...checked].sort((a, b) => a - b);
  const wanted = picked.map((i) => (oldRows[i] ? key(oldRows[i]) : ""));
  // 先配原位置沒變的
  const rest: number[] = [];
  picked.forEach((i, n) => {
    if (keys[i] === wanted[n]) { used.add(i); out.checked.push(i); } else rest.push(n);
  });
  for (const n of rest) {
    const from = picked[n];
    let best = -1;
    keys.forEach((k, j) => {
      if (k === wanted[n] && !used.has(j) && (best < 0 || Math.abs(j - from) < Math.abs(best - from))) best = j;
    });
    if (best < 0) out.lost++;
    else { used.add(best); out.checked.push(best); out.moved++; }
  }
  const had = new Map<string, number>();
  for (const r of oldRows) had.set(key(r), (had.get(key(r)) ?? 0) + 1);
  keys.forEach((k, j) => {
    const left = had.get(k) ?? 0;
    if (left > 0) had.set(k, left - 1);
    else out.fresh.push(j);
  });
  out.checked.sort((a, b) => a - b);
  return out;
}
