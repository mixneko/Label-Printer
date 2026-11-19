/** 外觀：自動（跟隨系統，預設）／亮／暗。選擇會記在 localStorage，下次開啟沿用。 */
export type Theme = "auto" | "light" | "dark";
const KEY = "label-printer.theme";
const ORDER: Theme[] = ["auto", "light", "dark"];
const TAG: Record<Theme, string> = { auto: "A", light: "亮", dark: "暗" };
const NAME: Record<Theme, string> = { auto: "自動（跟隨系統）", light: "亮色", dark: "暗色" };

export function loadTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "auto") return v;
  } catch { /* 讀不到就用預設 */ }
  return "auto";
}

export function applyTheme(t: Theme): void {
  const root = document.documentElement;
  if (t === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t);
}

/** 綁定燈泡按鈕：每按一次依序切換 自動 → 亮 → 暗 → 自動 */
export function initTheme(btn: HTMLElement): void {
  let cur = loadTheme();
  const show = (): void => {
    applyTheme(cur);
    btn.dataset.theme = cur;
    btn.querySelector(".theme-tag")!.textContent = TAG[cur];
    const next = ORDER[(ORDER.indexOf(cur) + 1) % ORDER.length];
    btn.title = `外觀：${NAME[cur]}（按一下改為「${NAME[next]}」）`;
    btn.setAttribute("aria-label", btn.title);
  };
  btn.addEventListener("click", () => {
    cur = ORDER[(ORDER.indexOf(cur) + 1) % ORDER.length];
    try { localStorage.setItem(KEY, cur); } catch { /* 記不住也沒關係 */ }
    show();
  });
  show();
}
