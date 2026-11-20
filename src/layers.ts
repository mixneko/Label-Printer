// 圖層面板：列出所有物件（最上層在最上面），可選取、顯示 / 隱藏、鎖定、改名、調整前後順序。

import Konva from "konva";
import { kindOf } from "./elements";
import { t as tr } from "./i18n";

export interface LayerApi {
  /** 由下到上的所有物件 */
  elements(): Konva.Shape[];
  selected(): Konva.Shape | null;
  /** 目前選取的全部物件（單選時只有一個；群組會整組一起選） */
  selection(): Konva.Shape[];
  select(n: Konva.Shape | null): void;
  /** 在清單上點選：replace＝只選這個；toggle＝Ctrl 點選加入／移除；set＝直接指定整批（Shift 連選） */
  setSelection(nodes: Konva.Shape[]): void;
  /** 順序、顯示、鎖定等改變後，讓主程式更新選取框 */
  changed(): void;
  /** 在圖層清單的某一列按右鍵：顯示該物件的右鍵選單 */
  contextMenu(n: Konva.Shape, x: number, y: number): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let api: LayerApi;

/** 圖示 id（對應 index.html 內的 SVG sprite） */
const ICON: Record<string, string> = { text: "type", qr: "qr", barcode: "barcode", rect: "square", image: "image" };
const svg = (id: string) => `<svg class="ic"><use href="#i-${id}"/></svg>`; // 只用於固定的圖示 id，不含使用者輸入

/** 圖層顯示名稱：使用者自訂優先，否則依內容自動產生 */
export function displayName(n: Konva.Shape): string {
  const custom = n.getAttr("label") as string | undefined;
  if (custom) return custom;
  const short = (s: unknown) => {
    const t = String(s ?? "").replace(/\s+/g, " ").trim();
    return t.length > 14 ? `${t.slice(0, 14)}…` : t;
  };
  switch (kindOf(n)) {
    case "text": return short((n as Konva.Text).text()) || tr("（空白文字）");
    case "qr": return `QR　${short(n.getAttr("content"))}`;
    case "barcode": return `${tr("條碼")}　${short(n.getAttr("content"))}`;
    case "rect": return n.getAttr("filled") && n.height() * Math.abs(n.scaleY()) <= 8 ? tr("線條") : tr("矩形");
    case "image": return tr("圖片");
    default: return tr("物件");
  }
}

function iconOf(n: Konva.Shape): string {
  if (kindOf(n) === "rect" && displayName(n) === tr("線條")) return "minus";
  return ICON[kindOf(n) ?? ""] ?? "square";
}

export type Move = "top" | "up" | "down" | "bottom";

/** 調整前後順序；只在物件之間交換位置，不會跑到背景底下或選取框上面 */
export function moveElement(n: Konva.Shape, how: Move): void {
  const list = api.elements();
  const i = list.indexOf(n);
  if (i < 0) return;
  const target = how === "top" ? list.length - 1 : how === "bottom" ? 0 : how === "up" ? i + 1 : i - 1;
  if (target < 0 || target >= list.length || target === i) return;
  n.zIndex(list[target].zIndex());
  api.changed();
  refreshLayers();
}

/** 多個物件一起調整順序：保持它們彼此的前後關係；已經在最上／最下時不會互相擠過去 */
export function moveElements(nodes: Konva.Shape[], how: Move): void {
  const set = new Set(nodes);
  const order = api.elements().filter((n) => set.has(n)); // 由下到上
  // 置頂／置底：依原本的前後順序一個個搬（先搬的會被後搬的蓋住，才能保持彼此的前後）；
  // 往上一層：從最上面的先動；往下一層：從最下面的先動（才不會互相擠過去）
  const seq = how === "up" || how === "bottom" ? order.slice().reverse() : order;
  for (const n of seq) {
    const list = api.elements();
    const i = list.indexOf(n);
    if (how === "up" && (i + 1 >= list.length || set.has(list[i + 1]))) continue;
    if (how === "down" && (i - 1 < 0 || set.has(list[i - 1]))) continue;
    moveElement(n, how);
  }
}

/** 顯示 / 隱藏（隱藏的物件不會被列印，也無法在畫布上選取） */
export function toggleVisible(n: Konva.Shape): void {
  n.visible(!n.visible());
  if (!n.visible() && api.selection().includes(n)) api.select(null);
  api.changed();
  refreshLayers();
}

/** 鎖定 / 解鎖（鎖定的物件無法在畫布上選取或拖曳） */
export function toggleLocked(n: Konva.Shape): void {
  const next = !n.getAttr("locked");
  n.setAttr("locked", next);
  n.draggable(!next);
  n.listening(!next);
  if (next && api.selection().includes(n)) api.select(null);
  api.changed();
  refreshLayers();
}

function button(iconHtml: string, title: string, on: () => void, active = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.innerHTML = iconHtml;
  b.title = title;
  if (active) b.classList.add("on");
  b.addEventListener("click", (e) => { e.stopPropagation(); on(); });
  return b;
}

function startRename(span: HTMLElement, n: Konva.Shape): void {
  const input = document.createElement("input");
  input.value = (n.getAttr("label") as string | undefined) ?? "";
  input.placeholder = displayName(n);
  const done = (save: boolean) => {
    if (save && (input.value.trim() || undefined) !== (n.getAttr("label") as string | undefined)) {
      n.setAttr("label", input.value.trim() || undefined);
      api.changed(); // 改名也算變更（標記為未儲存）
    }
    refreshLayers();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") done(true);
    else if (e.key === "Escape") done(false);
    e.stopPropagation();
  });
  input.addEventListener("blur", () => done(true));
  input.addEventListener("click", (e) => e.stopPropagation());
  span.replaceWith(input);
  input.focus();
  input.select();
}

/** 群組編號轉成固定的色相（清單上以顏色標示同一組） */
function groupHue(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
let anchor: Konva.Shape | null = null; // Shift 連選的起點

export function refreshLayers(): void {
  if (!api) return;
  const list = $("layer-list");
  const selList = api.selection();
  const selSet = new Set(selList);
  const items = api.elements().slice().reverse(); // 最上層排最前面

  list.replaceChildren(
    ...items.map((n) => {
      const li = document.createElement("li");
      const locked = !!n.getAttr("locked");
      const gid = n.getAttr("groupId") as string | undefined;
      li.className = [selSet.has(n) ? "sel" : "", locked ? "locked" : "", n.visible() ? "" : "hidden", gid ? "grouped" : ""].join(" ").trim();
      if (gid) {
        li.style.setProperty("--g", `hsl(${groupHue(gid)} 70% 55%)`);
        li.title = tr("群組：點一下會選取整個群組");
      }

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = displayName(n);
      name.title = tr("雙擊可改名");
      name.addEventListener("dblclick", (e) => { e.stopPropagation(); startRename(name, n); });

      const icon = document.createElement("span");
      icon.className = "icon";
      icon.innerHTML = svg(iconOf(n));

      li.append(
        button(svg(n.visible() ? "eye" : "eye-off"), n.visible() ? tr("點一下隱藏（隱藏的物件不會被列印）") : tr("點一下顯示"), () => toggleVisible(n), !n.visible()),
        button(svg(locked ? "lock" : "unlock"), locked ? tr("已鎖定（無法選取或拖曳），點一下解鎖") : tr("點一下鎖定，避免誤拖"), () => toggleLocked(n), locked),
        icon,
        name,
      );
      li.addEventListener("click", (e) => {
        if (locked || !n.visible()) return;
        if (e.shiftKey && anchor && anchor !== n) {
          // Shift：從上次點的那一列連選到這一列（略過鎖定與隱藏的）
          const all = api.elements().slice().reverse();
          const a = all.indexOf(anchor), b = all.indexOf(n);
          if (a >= 0 && b >= 0) { api.setSelection(all.slice(Math.min(a, b), Math.max(a, b) + 1)); return; }
        }
        if (e.ctrlKey || e.metaKey) {
          const cur = api.selection();
          api.setSelection(cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n]);
        } else api.select(n);
        anchor = n;
      });
      li.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        api.contextMenu(n, e.clientX, e.clientY);
      });
      return li;
    }),
  );
  if (items.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = tr("尚無物件，請用上方按鈕新增");
    list.append(li);
  }

  const has = selList.length > 0;
  document.querySelectorAll<HTMLButtonElement>("#layer-tools button").forEach((b) => { b.disabled = !has; });
  // 對齊標籤：鎖定的物件不能動（選取集合裡不會有鎖定的物件）
  const canAlign = has;
  // 群組：至少選了兩個、且不是剛好同一個群組時才能「群組」；選取裡有群組才能「取消群組」
  const gids = new Set(selList.map((n) => (n.getAttr("groupId") as string | undefined) ?? ""));
  ($("group-btn") as HTMLButtonElement).disabled = !(selList.length >= 2 && !(gids.size === 1 && !gids.has("")));
  ($("ungroup-btn") as HTMLButtonElement).disabled = !selList.some((n) => n.getAttr("groupId"));
  document.querySelectorAll<HTMLButtonElement>("#align-tools button").forEach((b) => { b.disabled = !canAlign; });
}

export function initLayers(a: LayerApi): void {
  api = a;
  const act = (how: Move) => () => { const s = api.selection(); if (s.length) moveElements(s, how); };
  $("layer-top").addEventListener("click", act("top"));
  $("layer-up").addEventListener("click", act("up"));
  $("layer-down").addEventListener("click", act("down"));
  $("layer-bottom").addEventListener("click", act("bottom"));
  refreshLayers();
}
