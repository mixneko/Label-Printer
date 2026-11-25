// 側邊面板（圖層、選取物件）的寬度：拖曳中間的分隔線調整，雙擊還原，會記住
const KEY = "label-printer.panelWidth";
export const DEFAULT_PANEL_WIDTH = 320;
const MIN = 240;
const MAX = 560;

export function initPanelResizer(): void {
  const panel = document.querySelector<HTMLElement>("aside.panel");
  const grip = document.getElementById("panel-resizer");
  if (!panel || !grip) return;
  // 視窗很窄時，面板最多佔 60%，避免把畫布擠沒
  const clamp = (v: number) => Math.max(MIN, Math.min(MAX, Math.round(window.innerWidth * 0.6), Math.round(v)));
  const apply = (v: number, persist: boolean) => {
    const w = clamp(v);
    panel.style.width = `${w}px`;
    grip.setAttribute("aria-valuenow", String(w));
    if (persist) {
      try { localStorage.setItem(KEY, String(w)); } catch { /* 無法儲存就算了 */ }
    }
  };
  try {
    const saved = Number(localStorage.getItem(KEY));
    if (saved > 0) apply(saved, false);
  } catch { /* 無法讀取則使用預設寬度 */ }

  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = panel.getBoundingClientRect().width;
    const move = (ev: PointerEvent) => apply(startW + (startX - ev.clientX), false); // 往左拖 = 變寬
    const up = (ev: PointerEvent) => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      apply(startW + (startX - ev.clientX), true);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
  grip.addEventListener("dblclick", () => apply(DEFAULT_PANEL_WIDTH, true));
  grip.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    apply(panel.getBoundingClientRect().width + (e.key === "ArrowLeft" ? 24 : -24), true);
  });
  // 視窗縮小時，寬度不能超過上限
  window.addEventListener("resize", () => { if (!panel.hidden) apply(panel.getBoundingClientRect().width, false); });
}
