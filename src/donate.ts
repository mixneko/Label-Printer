/** 「請作者喝杯啤酒」：關於視窗的按鈕，以及一次列印很多張之後出現的小視窗。網址要與 Rust 端 `url_allowed` 一致。 */
import { invoke } from "./ipc";
import { t } from "./i18n";

export const DONATE_URL = "https://ko-fi.com/mixneko";
/** 一次送出的總張數達到這個數字就顯示小視窗 */
export const BEER_MIN_LABELS = 15;

const dialog = (): HTMLDialogElement => document.getElementById("beer-dialog") as HTMLDialogElement;
const openPage = (): void => void invoke("open_url", { url: DONATE_URL }).catch(() => { /* 開不了就算了 */ });

/** 小視窗一天最多出現一次：記下最後一次顯示的日期（本機時間） */
const SHOWN_KEY = "label-printer.beer-day";
const today = (): string => new Date().toDateString();

/** 這次的張數是否該顯示小視窗 */
export function beerDue(total: number): boolean {
  if (total < BEER_MIN_LABELS) return false;
  try { return localStorage.getItem(SHOWN_KEY) !== today(); } catch { return true; }
}

export function maybeAskBeer(total: number): void {
  if (!beerDue(total)) return;
  try { localStorage.setItem(SHOWN_KEY, today()); } catch { /* 記不住就下次再顯示 */ }
  document.getElementById("beer-msg")!.textContent = t("剛剛送出了 {total} 張標籤。", { total });
  const dlg = dialog();
  if (!dlg.open) dlg.showModal();
}

document.getElementById("about-beer")!.addEventListener("click", openPage);
document.getElementById("beer-go")!.addEventListener("click", () => { openPage(); dialog().close(); });
for (const id of ["beer-close", "beer-x"]) document.getElementById(id)!.addEventListener("click", () => dialog().close());
