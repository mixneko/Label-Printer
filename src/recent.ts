// 「最近開啟的檔案」清單：記住最近開啟或儲存過的標籤檔路徑，存在 localStorage。

const KEY = "label-printer.recent";
export const MAX_RECENT = 10;

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase(); // Windows 路徑不分大小寫

export function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === "string" && p !== "").slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

function save(list: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
  } catch {
    /* 無法儲存就算了 */
  }
}

/** 把路徑放到清單最前面（已存在則移到最前面，不重複） */
export function pushRecent(path: string): void {
  save([path, ...loadRecent().filter((p) => !same(p, path))]);
}

/** 檔案已不存在或無法開啟時，從清單移除 */
export function removeRecent(path: string): void {
  save(loadRecent().filter((p) => !same(p, path)));
}

export function clearRecent(): void {
  save([]);
}

/** 完整路徑中的檔名 */
export const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/** 完整路徑中的資料夾（太長時只保留結尾，前面以 … 取代），用於選單右側的提示 */
export function shortDir(path: string, max = 30): string {
  const dir = path.slice(0, Math.max(0, path.length - baseName(path).length)).replace(/[\\/]+$/, "");
  return dir.length > max ? `…${dir.slice(dir.length - max + 1)}` : dir;
}
