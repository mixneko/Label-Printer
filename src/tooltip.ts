/**
 * 滑鼠停在按鈕等元件上時顯示說明（讀元件的 title 屬性）。
 *
 * 為什麼不用瀏覽器原生的 title 提示：原生提示要等很久、按下去之後不再出現、在對話框與不同系統上外觀和行為都不一致，
 * 使用者常常看不到。這裡改成自己畫：停留約 0.35 秒就出現、樣式跟著深淺色外觀、顯示在對話框之上。
 * 程式其他地方仍照舊只要寫 `title`（翻譯機制也不變）；停留期間暫時把 title 搬到 data-tip 以避免原生提示重複出現，
 * 離開、按下或捲動時立刻還原。
 */
const DELAY_MS = 350;
let tip: HTMLElement | null = null;
let timer: number | undefined;
let current: HTMLElement | null = null;

function ensureTip(): HTMLElement {
  if (tip) return tip;
  tip = document.createElement("div");
  tip.id = "tooltip";
  tip.setAttribute("role", "tooltip");
  tip.setAttribute("popover", "manual"); // 放進最上層，這樣在 <dialog> 之上也看得到
  document.body.append(tip);
  return tip;
}

function restore(): void {
  window.clearTimeout(timer);
  timer = undefined;
  if (current) {
    const t = current.getAttribute("data-tip");
    if (t !== null && !current.hasAttribute("title")) current.setAttribute("title", t);
    current.removeAttribute("data-tip");
    current = null;
  }
  if (tip) {
    try { tip.hidePopover(); } catch { /* 沒開著 */ }
  }
}

function show(el: HTMLElement, text: string): void {
  const t = ensureTip();
  t.textContent = text;
  try { t.showPopover(); } catch { /* 已開著 */ }
  t.style.left = "0px";
  t.style.top = "0px";
  const r = el.getBoundingClientRect();
  const w = t.offsetWidth, h = t.offsetHeight;
  const gap = 8;
  let top = r.bottom + gap;
  if (top + h > window.innerHeight - 4) top = Math.max(4, r.top - h - gap); // 下面放不下就放上面
  const left = Math.max(4, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 4));
  t.style.left = `${left}px`;
  t.style.top = `${top}px`;
}

document.addEventListener("mouseover", (e) => {
  const el = (e.target as HTMLElement | null)?.closest?.<HTMLElement>("[title]");
  if (!el || el === current) return;
  restore();
  const text = (el.getAttribute("title") || "").trim();
  if (!text) return;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    // 計時到了才把 title 收起來（避免原生提示同時出現）並顯示自己的提示
    if (!el.isConnected || !el.matches(":hover")) return;
    el.setAttribute("data-tip", text);
    el.removeAttribute("title");
    current = el;
    show(el, text);
  }, DELAY_MS);
}, true);

document.addEventListener("mouseout", (e) => {
  const to = e.relatedTarget as Node | null;
  if (current && to && current.contains(to)) return; // 只是移到元件內部
  restore();
}, true);
for (const type of ["mousedown", "keydown", "wheel", "contextmenu", "dragstart"]) document.addEventListener(type, restore, true);
window.addEventListener("blur", restore);
