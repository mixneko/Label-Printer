// 後端（Rust）回傳的錯誤訊息是繁體中文。這裡把 invoke 包起來，錯誤依目前語言翻譯後再往外丟，
// 這樣各處顯示 `String(e)` 時，英文／日文…的使用者看到的是自己的語言。
// 做法：每則訊息是一個 N() 鍵（可含 {名稱} 佔位），自動轉成正規式比對；擷取到的片段如果本身也是訊息（例如「第 2 張：…」）會遞迴翻譯，
// 系統回傳的原文（作業系統錯誤、SQLite 訊息等）則維持原樣。
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { N, t } from "./i18n";

const MESSAGES = [
  N("SQL 查詢是空的"),
  N("只能執行單一查詢（不可包含分號）"),
  N("只允許 SELECT 查詢（資料來源是唯讀的）"),
  N("找不到檔案：{path}"),
  N("資料庫裡沒有任何資料表"),
  N("無法開啟資料庫：{e}"),
  N("這不是有效的 SQLite 資料庫：{e}"),
  N("查詢失敗：{e}"),
  N("讀取資料失敗：{e}"),
  N("資料超過 {n} 列，請改用 SQL 查詢縮小範圍"),
  N("無法連線到資料庫：{e}"),
  N("連線逾時：{addr} 沒有回應"),
  N("資料庫連線設定不正確：{e}"),
  N("不支援的資料庫類型：{type}"),
  N("伺服器位址格式不正確"),
  N("資料庫名稱格式不正確"),
  N("查詢沒有回傳結果"),
  N("原生條碼內容只能是半形英數與符號：{content}"),
  N("不支援的 QR 容錯等級：{ecc}"),
  N("{lang} 不支援的原生條碼類型：{type}"),
  N("EPL2 沒有 QR Code 的原生指令"),
  N("SBPL 原生條碼的人眼可讀文字只支援 EAN／UPC"),
  N("SBPL（Basic Command）沒有 QR Code 的原生指令"),
  N("不允許的網址"),
  N("此平台不支援"),
  N("讀取檔案失敗：{e}"),
  N("寫入檔案失敗：{e}"),
  N("資料格式錯誤：{e}"),
  N("尚未選擇印表機"),
  N("無法解析印表機位址 {addr}：{e}"),
  N("找不到印表機位址 {addr}"),
  N("連線印表機失敗 {addr}：{e}"),
  N("傳送資料失敗：{e}"),
  N("無法開啟活頁簿：{e}"),
  N("活頁簿沒有任何工作表"),
  N("讀取工作表「{name}」失敗：{e}"),
  N("CSV 格式錯誤：{e}"),
  N("這個工作表是空的"),
  N("開啟印表機「{name}」失敗：{e}"),
  N("{api} 失敗：{e}"),
  N("只寫入 {done}/{total} bytes"),
  N("讀取印表機資訊失敗：{e}"),
  N("列舉印表機失敗：{e}"),
  N("原生條碼內容不可為空"),
  N("不支援的原生條碼類型：{type}"),
  N("點陣大小不符：預期 {expected} bytes，實際 {actual} bytes"),
  N("份數必須至少為 1"),
  N("不支援的印表機語言：{lang}"),
  N("沒有要列印的標籤"),
  N("第 {n} 張：{e}"),
];

const esc = (s: string): string => s.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
// 具體的訊息排在前面（固定文字越長越優先），含佔位的通用型（如「{api} 失敗」）放最後
const PATTERNS = MESSAGES.map((key) => ({
  key,
  re: new RegExp("^" + esc(key).replace(/\{(\w+)\}/g, "(?<$1>.+?)") + "$", "s"),
  fixed: key.replace(/\{\w+\}/g, "").length,
})).sort((a, b) => b.fixed - a.fixed);

/** 把後端的錯誤文字翻成目前語言；認不得的原樣回傳 */
export function localizeError(msg: string): string {
  for (const { key, re } of PATTERNS) {
    const m = re.exec(msg);
    if (!m) continue;
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.groups ?? {})) params[k] = localizeError(v);
    return t(key, params);
  }
  return msg;
}

/** 和 Tauri 的 invoke 相同，但失敗時的錯誤訊息已依目前語言翻譯 */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (e) {
    throw typeof e === "string" ? localizeError(e) : e;
  }
}
