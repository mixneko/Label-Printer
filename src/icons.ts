// 圖示小工具：index.html 內有 Lucide 圖示的 SVG sprite（<symbol id="i-…">），這裡產生引用它的 <svg>。
// 圖示庫：Lucide（https://lucide.dev ，ISC 授權）；清單與產生方式見 scripts/gen-icons.mjs。

const NS = "http://www.w3.org/2000/svg";

/** 建立 `<svg class="ic"><use href="#i-名稱"/></svg>` */
export function iconEl(id: string, cls = "ic"): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(NS, "use");
  use.setAttribute("href", `#i-${id}`);
  svg.append(use);
  return svg;
}

/** 把元素內容換成「圖示 + 文字」（icon 為 null 時只有文字）。文字一律用 textContent，不會被當成 HTML */
export function setIconText(el: HTMLElement, icon: string | null, text: string): void {
  el.replaceChildren(...(icon ? [iconEl(icon), document.createTextNode(text)] : [document.createTextNode(text)]));
}
