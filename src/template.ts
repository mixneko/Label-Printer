// 標籤中的 {{欄位}} 變數替換。Excel 載入後，每一列資料會當作 row 傳入。
//
// 寫法：
//   {{出貨日期}}               → 取該欄位的值（日期、數字依 Excel 儲存格自己的格式顯示）
//   {{出貨日期|yyyy/mm/dd}}    → 使用者指定「欄位格式」：用 Excel 的格式碼重新格式化（需要原始值，由 main.ts 先算好放進 row）
// 格式碼不可含 | 與 } 。

export type Row = Record<string, string>;

/** Excel 儲存格的原始值：n = 數字；d = 日期時間 [年, 月, 日, 時, 分, 秒, 毫秒]（與後端 `Raw` 相同） */
export type Raw = { n: number } | { d: number[] };
/** 與 Row 對應的原始值（只有 Excel 的數字／日期儲存格有） */
export type RawRow = Record<string, Raw | null>;

export const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;

export interface Placeholder {
  /** 大括號內去除前後空白的完整文字，例如 "出貨日期|yyyy/mm/dd"（也是 resolve 後放進 row 的鍵） */
  key: string;
  name: string;
  /** 使用者指定的格式碼；沒有指定為空字串 */
  format: string;
}

export function parsePlaceholder(inner: string): Placeholder {
  const key = inner.trim();
  const i = key.indexOf("|");
  return i < 0 ? { key, name: key, format: "" } : { key, name: key.slice(0, i).trim(), format: key.slice(i + 1).trim() };
}

/** 文字中所有的 {{…}}（依出現順序，可能重複） */
export function placeholdersOf(text: string): Placeholder[] {
  return Array.from(text.matchAll(PLACEHOLDER), (m) => parsePlaceholder(m[1]));
}

/**
 * 將 `{{欄位}}` 替換為 row 中對應的值；找不到的欄位保持原樣，方便使用者發現錯誤。
 * `{{欄位|格式}}` 優先取 row 中以完整文字為鍵的值（已依格式算好）；沒有就退回該欄位原本的值（「自動」）。
 */
export function substitute(text: string, row: Row): string {
  return text.replace(PLACEHOLDER, (whole, inner: string) => {
    const p = parsePlaceholder(inner);
    if (p.key in row) return row[p.key];
    return p.name in row ? row[p.name] : whole;
  });
}
