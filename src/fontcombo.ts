// 字型選擇：可直接輸入關鍵字搜尋，也可展開完整清單挑選。
//
// 不使用瀏覽器原生的 <datalist>：它只會列出「符合目前文字」的項目，欄位已經有字型時，
// 清單裡只剩一項；先前為了列出全部而「點進去就清空文字」，使用者會以為字型被刪掉了。
// 這裡自己做下拉：點進去保留原字型（文字全選，直接輸入即取代）並展開完整清單，目前的字型會標示。
import { t } from "./i18n";

export interface FontComboOptions {
  /** 所有已安裝字型 */
  names(): string[];
  /** 目前所選文字的字型（沒有選取文字時為 null） */
  current(): string | null;
  /** 輸入的文字是不是完整、有效的字型名稱 */
  isValid(value: string): boolean;
  /** 使用者選定了某個字型 */
  choose(name: string): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function initFontCombo(o: FontComboOptions): void {
  const input = $<HTMLInputElement>("prop-font");
  const list = $("font-list");
  const toggle = $("font-toggle");
  let shown: string[] = [];
  let active = -1;
  let justFocused = false;

  const isOpen = () => !list.hidden;
  const currentLower = () => o.current()?.toLowerCase() ?? "";

  const close = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    active = -1;
  };

  /**
   * 只捲動清單自己，讓項目可見。不能用 scrollIntoView：它會連外層可捲動的容器（側邊面板）一起捲動，
   * 導致點開清單時整個面板跳動、欄位位置跑掉。
   */
  const scrollListTo = (li: HTMLElement | null, center: boolean) => {
    if (!li) return;
    const top = li.offsetTop;
    const bottom = top + li.offsetHeight;
    if (center) list.scrollTop = top - (list.clientHeight - li.offsetHeight) / 2;
    else if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  };

  const markActive = () => {
    list.querySelectorAll("li").forEach((li, i) => li.classList.toggle("active", i === active));
    scrollListTo(list.querySelector<HTMLElement>("li.active"), false);
  };

  const pick = (name: string) => {
    close();
    o.choose(name);
  };

  /** 展開清單；filter 為空時列出全部，否則只列出名稱含關鍵字的字型（不分大小寫） */
  const open = (filter = "") => {
    const f = filter.trim().toLowerCase();
    const all = o.names();
    shown = f ? all.filter((n) => n.toLowerCase().includes(f)) : all;
    const cur = currentLower();
    if (shown.length === 0) {
      const none = document.createElement("li");
      none.className = "none";
      none.textContent = t("沒有符合的字型");
      list.replaceChildren(none);
    } else {
      list.replaceChildren(
        ...shown.map((n) => {
          const li = document.createElement("li");
          li.textContent = n;
          li.setAttribute("role", "option");
          if (n.toLowerCase() === cur) li.classList.add("sel");
          li.addEventListener("mousedown", (e) => e.preventDefault()); // 點選項目時輸入欄位不要失去焦點
          li.addEventListener("click", () => pick(n));
          return li;
        }),
      );
    }
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    // 沒有篩選時，游標停在目前的字型並捲動到可見位置；有篩選時停在第一個符合的項目
    active = f ? (shown.length ? 0 : -1) : shown.findIndex((n) => n.toLowerCase() === cur);
    markActive();
    if (!f) scrollListTo(list.querySelector<HTMLElement>("li.sel"), true);
  };

  const restore = () => {
    const cur = o.current();
    if (cur !== null && !o.isValid(input.value)) input.value = cur;
  };

  // 點進欄位：保留原字型（全選，直接輸入即取代），並展開完整清單
  input.addEventListener("focus", () => {
    justFocused = true;
    input.select();
    open("");
  });
  // 滑鼠放開時，瀏覽器會取消剛才的全選；剛取得焦點的那一次要擋掉
  input.addEventListener("mouseup", (e) => {
    if (justFocused) { e.preventDefault(); justFocused = false; }
  });
  // 欄位已經有焦點（例如剛選完字型）時再點一下，不會觸發 focus，所以點擊時清單若是收起的就重新展開
  input.addEventListener("click", () => { if (!isOpen()) open(""); });
  input.addEventListener("input", () => open(input.value)); // 輸入關鍵字即時篩選
  input.addEventListener("blur", () => {
    justFocused = false;
    close();
    restore();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!isOpen()) { open(""); return; }
      if (shown.length === 0) return;
      active = e.key === "ArrowDown" ? Math.min(shown.length - 1, active + 1) : Math.max(0, active - 1);
      markActive();
    } else if (e.key === "Enter") {
      if (isOpen() && active >= 0 && shown[active]) { e.preventDefault(); pick(shown[active]); }
      else if (o.isValid(input.value)) { e.preventDefault(); o.choose(input.value.trim()); close(); }
    } else if (e.key === "Escape" && isOpen()) {
      e.preventDefault();
      e.stopPropagation();
      close();
      restore();
    }
  });

  // 右側的 ▾ 按鈕：展開 / 收起完整清單
  toggle.addEventListener("mousedown", (e) => e.preventDefault());
  toggle.addEventListener("click", () => {
    if (isOpen()) { close(); return; }
    input.focus();
    open("");
  });
}
