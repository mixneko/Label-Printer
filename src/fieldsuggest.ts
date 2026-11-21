// 在內容欄位輸入 `{{` 時，列出可用的資料欄位讓使用者選（不必記欄位名稱、也不必自己打右括號）。
// 選取後把 `{{輸入到一半的字` 換成 `{{欄位}}`，游標停在後面。↑↓ 移動、Enter／Tab 選取、Esc 關閉、滑鼠點選。

export function attachFieldSuggest(ta: HTMLTextAreaElement, names: () => string[], onPick: () => void): void {
  const list = document.createElement("ul");
  list.className = "combo-list field-suggest";
  list.hidden = true;
  list.setAttribute("role", "listbox");
  document.body.append(list);
  let items: string[] = [];
  let active = 0;

  /** 游標前面是否正在輸入 `{{xxx`：回傳 xxx 的起點與內容 */
  const partial = (): { start: number; text: string } | null => {
    const before = ta.value.slice(0, ta.selectionStart);
    const m = /\{\{([^{}|]*)$/.exec(before);
    return m ? { start: before.length - m[1].length, text: m[1] } : null;
  };

  const hide = () => { list.hidden = true; };
  const render = () => {
    list.replaceChildren(...items.map((n, i) => {
      const li = document.createElement("li");
      li.textContent = n;
      li.setAttribute("role", "option");
      if (i === active) li.className = "active";
      // mousedown：在 textarea 失去焦點（blur 會先關閉清單）之前就選取
      li.addEventListener("mousedown", (e) => { e.preventDefault(); pick(n); });
      return li;
    }));
    list.querySelector(".active")?.scrollIntoView?.({ block: "nearest" });
  };

  const pick = (name: string) => {
    const p = partial();
    if (!p) return hide();
    const after = ta.value.slice(ta.selectionStart);
    const close = after.startsWith("}}") ? "" : "}}"; // 後面已經有 }} 就不重複補
    const insert = name + close;
    ta.setRangeText(insert, p.start, ta.selectionStart, "end");
    hide();
    onPick();
  };

  const refresh = () => {
    const p = partial();
    if (!p) return hide();
    const q = p.text.toLowerCase();
    items = names().filter((n) => n.toLowerCase().includes(q));
    if (!items.length) return hide();
    active = 0;
    const r = ta.getBoundingClientRect();
    list.style.position = "fixed";
    list.style.left = `${r.left}px`;
    list.style.width = `${r.width}px`;
    list.style.right = "auto";
    list.style.top = `${r.bottom + 3}px`;
    list.hidden = false;
    render();
  };

  ta.addEventListener("input", refresh);
  ta.addEventListener("blur", hide);
  ta.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % items.length; render(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + items.length) % items.length; render(); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(items[active]); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); hide(); }
  });
}
