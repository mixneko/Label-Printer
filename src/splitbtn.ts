// 分割按鈕：在既有按鈕右邊加一個「▾」小按鈕，點開是同一類動作的其他選項。
// 原本的按鈕行為完全不變（一鍵就做原本的事），所以熟悉的流程不會多一步；其他選項放在 ▾ 裡。

import { showMenu, type MenuItem } from "./contextmenu";

/** 為 id 對應的按鈕加上 ▾；items 在每次開啟時才呼叫，所以停用狀態永遠是最新的 */
export function addSplit(id: string, items: () => MenuItem[], title: string): void {
  const main = document.getElementById(id) as HTMLButtonElement | null;
  if (!main || document.getElementById(`${id}-more`)) return;
  const more = document.createElement("button");
  more.type = "button";
  more.id = `${id}-more`;
  more.className = `${main.className} split-more`;
  more.title = title;
  more.setAttribute("aria-label", title);
  more.setAttribute("aria-haspopup", "menu");
  more.innerHTML = '<svg class="ic"><use href="#i-chevron" /></svg>';
  main.classList.add("split-main");
  main.after(more);
  // 主按鈕停用時（例如資料表還沒有勾選任何列），▾ 也跟著停用
  const sync = () => { more.disabled = main.disabled; };
  sync();
  new MutationObserver(sync).observe(main, { attributes: true, attributeFilter: ["disabled"] });
  more.addEventListener("click", () => {
    const r = more.getBoundingClientRect();
    showMenu(Math.max(4, r.right - 220), r.bottom + 2, items());
  });
}
