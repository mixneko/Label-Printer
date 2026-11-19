// 「屬性」對話框：以 mm 精確設定物件的位置、大小、旋轉，並可對齊標籤；也可設定名稱、鎖定與隱藏。

import Konva from "konva";
import { ALIGN_LABEL, alignTo, bbox, localSize, moveBBoxTo, type Align } from "./arrange";
import { fitText, isBounded, kindOf, ratioLockOf, refreshCode } from "./elements";
import { displayName } from "./layers";
import { DOTS_PER_MM } from "./settings";
import { t } from "./i18n";

export interface PropsApi {
  layer(): Konva.Layer;
  /** 範本大小（dots） */
  templateSize(): { w: number; h: number };
  /** 物件被修改後：重畫、更新選取框、標記未儲存 */
  changed(): void;
  /** 重繪圖層清單與右側屬性面板 */
  refresh(): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let api: PropsApi;
let node: Konva.Shape | null = null;

const toMm = (dots: number): number => Math.round((dots / DOTS_PER_MM) * 100) / 100;
const toDots = (mm: number): number => mm * DOTS_PER_MM;
const num = (id: string): number => Number($<HTMLInputElement>(id).value);

/** 這種物件的哪些大小欄位可以改 */
function sizeMode(n: Konva.Shape): { w: boolean; h: boolean; hint: string } {
  switch (kindOf(n)) {
    case "text":
      return isBounded(n)
        ? { w: true, h: true, hint: t("這是文字的「最大範圍」。內容太長時，字級會自動縮小到放得進這個範圍（可在右側調整最小字級與對齊）。") }
        : { w: false, h: false, hint: t("文字的大小由「字級」決定，請在右側「選取物件」面板調整字級；想把文字限制在固定範圍內，請勾選「限制在固定範圍內」。") };
    case "barcode": return { w: false, h: true, hint: t("條碼的寬度會依內容（變數）自動調整，不能手動拉寬；這裡可以調整條碼的高度。內容變長時要往哪邊長，請在右側「展開方向」設定。") };
    case "qr": return { w: true, h: true, hint: t("QR Code 一定是正方形，寬高會一起變化。") };
    default: return { w: true, h: true, hint: "" };
  }
}

function fill(): void {
  if (!node) return;
  const n = node;
  const kind = kindOf(n);
  const r = bbox(n, api.layer());
  const { w, h } = localSize(n);
  const sizeLocked = !!n.getAttr("sizeLocked");
  const mode = sizeMode(n);

  $("pp-title").textContent = t("屬性 — {name}", { name: displayName(n) });
  $<HTMLInputElement>("pp-name").value = (n.getAttr("label") as string | undefined) ?? "";
  $<HTMLInputElement>("pp-name").placeholder = displayName(n);
  $<HTMLInputElement>("pp-x").value = String(toMm(r.x));
  $<HTMLInputElement>("pp-y").value = String(toMm(r.y));
  $<HTMLInputElement>("pp-w").value = String(toMm(w));
  $<HTMLInputElement>("pp-h").value = String(toMm(h));
  $<HTMLInputElement>("pp-w").disabled = sizeLocked || !mode.w;
  $<HTMLInputElement>("pp-h").disabled = sizeLocked || !mode.h;
  $<HTMLInputElement>("pp-rot").value = String(Math.round(n.rotation() * 100) / 100);
  $<HTMLInputElement>("pp-ratio").checked = ratioLockOf(n);
  $<HTMLInputElement>("pp-ratio").disabled = kind === "qr" || (kind === "text" && !isBounded(n)) || sizeLocked;
  $<HTMLInputElement>("pp-sizelock").checked = sizeLocked;
  $<HTMLInputElement>("pp-locked").checked = !!n.getAttr("locked");
  $<HTMLInputElement>("pp-hidden").checked = !n.visible();
  $("pp-hint").textContent = mode.hint;
  $("pp-hint").hidden = !mode.hint;
  const dpi = t("（1 點 = {mm} mm）", { mm: (1 / DOTS_PER_MM).toFixed(3) });
  $("pp-grid-hint").textContent = t("位置與大小的單位是 mm {dpi}；實際列印會對齊到 1 點。", { dpi });
}

function applied(): void {
  api.changed();
  api.refresh();
  fill();
}

/** 修改寬或高；鎖定縱橫比時另一邊依比例連動 */
function setSize(which: "w" | "h"): void {
  if (!node || node.getAttr("sizeLocked")) return;
  const n = node;
  const kind = kindOf(n);
  const value = Math.max(1, toDots(num(which === "w" ? "pp-w" : "pp-h")));
  if (!Number.isFinite(value)) return fill();

  if (kind === "qr") {
    n.setAttr("qrSize", Math.round(value));
    refreshCode(n as Konva.Image);
    return applied();
  }

  if (kind === "barcode") {
    if (which === "w") return fill();
    const bar = Number(n.getAttr("barHeight")) || 80;
    const extra = n.height() - bar; // 條碼下方文字佔的高度
    n.setAttr("barHeight", Math.max(10, Math.round(value - extra)));
    refreshCode(n as Konva.Image);
    return applied();
  }

  if (kind === "text" && isBounded(n)) {
    // 最大範圍（文字框）的寬高；字級由內容與範圍決定，所以改完要重新縮放
    const { w, h } = localSize(n);
    const keep = ratioLockOf(n);
    const ratio = w / h || 1;
    let bw = which === "w" ? value : w;
    let bh = which === "h" ? value : h;
    if (keep) { if (which === "w") bh = value / ratio; else bw = value * ratio; }
    n.scale({ x: 1, y: 1 });
    n.setAttrs({ boxW: Math.max(4, Math.round(bw)), boxH: Math.max(4, Math.round(bh)) });
    fitText(n as Konva.Text);
    return applied();
  }

  if (kind === "rect" || kind === "image") {
    // 先把縮放量烘進寬高，之後直接設定寬高
    const { w, h } = localSize(n);
    n.scale({ x: Math.sign(n.scaleX()) || 1, y: Math.sign(n.scaleY()) || 1 });
    n.width(w);
    n.height(h);
    const keep = ratioLockOf(n);
    const ratio = w / h || 1;
    if (which === "w") {
      n.width(value);
      if (keep) n.height(value / ratio);
    } else {
      n.height(value);
      if (keep) n.width(value * ratio);
    }
  }
  applied();
}

function align(how: Align): void {
  if (!node) return;
  const { w, h } = api.templateSize();
  alignTo(node, api.layer(), how, w, h);
  applied();
}

export function openProps(n: Konva.Shape): void {
  if (!api) return;
  node = n;
  fill();
  const dlg = $<HTMLDialogElement>("props-dialog");
  if (!dlg.open) dlg.showModal();
}

export function initProps(a: PropsApi): void {
  api = a;
  const dlg = $<HTMLDialogElement>("props-dialog");
  $("pp-close").addEventListener("click", () => dlg.close());
  $("pp-close-x").addEventListener("click", () => dlg.close());
  // 點對話框外面的遮罩也關閉
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener("close", () => { node = null; });

  $("pp-name").addEventListener("change", () => {
    if (!node) return;
    node.setAttr("label", $<HTMLInputElement>("pp-name").value.trim() || undefined);
    applied();
  });
  const pos = () => {
    if (!node) return;
    const x = num("pp-x"), y = num("pp-y");
    if (Number.isFinite(x) && Number.isFinite(y)) moveBBoxTo(node, api.layer(), toDots(x), toDots(y));
    applied();
  };
  $("pp-x").addEventListener("change", pos);
  $("pp-y").addEventListener("change", pos);
  $("pp-w").addEventListener("change", () => setSize("w"));
  $("pp-h").addEventListener("change", () => setSize("h"));
  $("pp-rot").addEventListener("change", () => {
    if (!node || !Number.isFinite(num("pp-rot"))) return fill();
    node.rotation(num("pp-rot"));
    applied();
  });
  $("pp-ratio").addEventListener("change", () => {
    if (!node) return;
    node.setAttr("ratioLock", $<HTMLInputElement>("pp-ratio").checked);
    applied();
  });
  $("pp-sizelock").addEventListener("change", () => {
    if (!node) return;
    node.setAttr("sizeLocked", $<HTMLInputElement>("pp-sizelock").checked);
    applied();
  });
  $("pp-locked").addEventListener("change", () => {
    if (!node) return;
    const lock = $<HTMLInputElement>("pp-locked").checked;
    node.setAttr("locked", lock);
    node.draggable(!lock);
    node.listening(!lock);
    applied();
  });
  $("pp-hidden").addEventListener("change", () => {
    if (!node) return;
    node.visible(!$<HTMLInputElement>("pp-hidden").checked);
    applied();
  });

  const alignBox = $("pp-align");
  for (const how of Object.keys(ALIGN_LABEL) as Align[]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn sm";
    b.textContent = t(ALIGN_LABEL[how]);
    b.addEventListener("click", () => align(how));
    alignBox.append(b);
  }
}
