// 輕量的右鍵選單：支援分隔線、快捷鍵提示、停用項目與子選單。
// 項目文字一律以 textContent 寫入，不會把內容當成 HTML。

import { iconEl } from "./icons";

export interface MenuItem {
  label?: string;
  /** 項目左邊的圖示（index.html 圖示庫裡的名稱，不含 i- 前綴，例如 "save"） */
  icon?: string;
  /** 右側的快捷鍵提示，例如 "Ctrl+C" */
  hint?: string;
  disabled?: boolean;
  separator?: boolean;
  onClick?: () => void;
  /** 有子項目時，滑過會展開子選單 */
  items?: MenuItem[];
}

let root: HTMLDivElement | null = null;

function ensureRoot(): HTMLDivElement {
  if (root) return root;
  root = document.createElement("div");
  root.id = "ctx-menu";
  root.hidden = true;
  // 在選單上按右鍵不要再跳出瀏覽器預設選單
  root.addEventListener("contextmenu", (e) => e.preventDefault());
  document.body.append(root);

  // 點選單以外的地方、按 Esc、視窗失焦或捲動時關閉
  document.addEventListener("mousedown", (e) => { if (root && !root.hidden && !root.contains(e.target as Node)) hideMenu(); }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideMenu(); }, true);
  window.addEventListener("blur", hideMenu);
  window.addEventListener("resize", hideMenu);
  document.addEventListener("wheel", (e) => { if (root && !root.contains(e.target as Node)) hideMenu(); }, { passive: true, capture: true });
  return root;
}

function build(items: MenuItem[], sub = false): HTMLUListElement {
  const ul = document.createElement("ul");
  ul.className = sub ? "menu sub" : "menu";
  ul.setAttribute("role", "menu");
  // 同一個選單只要有項目有圖示，沒有圖示的項目也留一格空位，文字才會對齊
  const anyIcon = items.some((i) => i.icon);
  for (const it of items) {
    const li = document.createElement("li");
    if (it.separator) {
      li.className = "sep";
      li.setAttribute("role", "separator");
      ul.append(li);
      continue;
    }
    li.setAttribute("role", "menuitem");
    if (it.disabled) li.classList.add("disabled");
    if (anyIcon) {
      const slot = document.createElement("span");
      slot.className = "ic-slot";
      if (it.icon) slot.append(iconEl(it.icon));
      li.append(slot);
    }
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = it.label ?? "";
    li.append(label);
    if (it.hint) {
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = it.hint;
      li.append(hint);
    }
    if (it.items?.length) {
      li.classList.add("has-sub");
      const arrow = document.createElement("span");
      arrow.className = "arrow";
      arrow.textContent = "›";
      const sub = build(it.items, true);
      li.append(arrow, sub);
      // 子選單超出視窗下緣時往上推到放得下為止（太高放不下就在子選單內捲動）
      li.addEventListener("mouseenter", () => fitSub(li, sub));
    } else if (!it.disabled) {
      li.addEventListener("click", () => {
        hideMenu();
        it.onClick?.();
      });
    }
    ul.append(li);
  }
  return ul;
}

function fitSub(li: HTMLElement, sub: HTMLElement): void {
  sub.style.top = "-5px";
  sub.style.maxHeight = "";
  sub.style.overflowY = "";
  const margin = 6;
  const room = window.innerHeight - margin * 2;
  // display:none 時量不到尺寸；hover 規則會讓它顯示，這裡強制先顯示量一次
  const prev = sub.style.display;
  sub.style.display = "block";
  const h = sub.getBoundingClientRect().height;
  if (h > room) { sub.style.maxHeight = `${room}px`; sub.style.overflowY = "auto"; }
  const r = sub.getBoundingClientRect();
  const liTop = li.getBoundingClientRect().top;
  let top = -5;
  const over = r.bottom - (window.innerHeight - margin);
  if (over > 0) top -= over;
  if (liTop + top < margin) top = margin - liTop;
  sub.style.top = `${top}px`;
  sub.style.display = prev;
}

const hiddenListeners: Array<() => void> = [];
/** 選單收起來時通知（功能表列用來取消按鈕的凹陷狀態） */
export function onMenuHidden(cb: () => void): void {
  hiddenListeners.push(cb);
}

export function hideMenu(): void {
  if (!root || root.hidden) return;
  root.hidden = true;
  for (const cb of hiddenListeners) cb();
}

/** 選單目前是否開著（工具列按鈕用來做「再按一次就收起來」） */
export function isMenuOpen(): boolean {
  return !!root && !root.hidden;
}

export function showMenu(x: number, y: number, items: MenuItem[]): void {
  const el = ensureRoot();
  el.replaceChildren(build(items));
  el.hidden = false;
  // 先放在 (x, y) 量尺寸，再避免超出視窗
  el.style.left = "0px";
  el.style.top = "0px";
  const { width, height } = el.getBoundingClientRect();
  const left = Math.max(4, Math.min(x, window.innerWidth - width - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - height - 4));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  // 子選單預設向右展開；右側放不下就改向左
  el.classList.toggle("flip", left + width * 2 > window.innerWidth);
}
