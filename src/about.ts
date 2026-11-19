/** 「說明」選單的兩個對話框：關於、第三方授權聲明（授權文字由 scripts/gen-licenses.mjs 產生，打包進程式）。 */
import { getVersion } from "@tauri-apps/api/app";
import licenseText from "./licenses.txt?raw";
import { t } from "./i18n";

function open(id: string): void {
  const dlg = document.getElementById(id) as HTMLDialogElement;
  if (!dlg.open) dlg.showModal();
}

export async function showAbout(): Promise<void> {
  let v = "";
  try { v = await getVersion(); } catch { /* 非 Tauri 環境（瀏覽器測試）沒有版本資訊 */ }
  document.getElementById("about-ver")!.textContent = v ? t("版本 {v}", { v }) : "";
  open("about-dialog");
}

export function showLicenses(): void {
  const pre = document.getElementById("lic-text") as HTMLElement;
  if (!pre.textContent) pre.textContent = licenseText; // 約 1 MB，第一次開啟才放進畫面
  open("lic-dialog");
  (document.getElementById("lic-body") as HTMLElement).scrollTop = 0;
}

for (const [dlg, btn] of [["about-dialog", "about-close"], ["lic-dialog", "lic-close"]]) {
  document.getElementById(btn)!.addEventListener("click", () => (document.getElementById(dlg) as HTMLDialogElement).close());
}
document.getElementById("about-licenses")!.addEventListener("click", () => {
  (document.getElementById("about-dialog") as HTMLDialogElement).close();
  showLicenses();
});
