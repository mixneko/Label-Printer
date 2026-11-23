// 「新增標籤」尺寸視窗與直接開程式時的歡迎視窗（從 main.ts 拆出）。需要主程式的功能由 initStartDialogs 注入。
import { N, t as tr } from "./i18n";
import { baseName, loadRecent, shortDir } from "./recent";
import { MAX_GAP_MM, MAX_SIZE_MM, type Settings } from "./settings";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface StartDeps {
  settings: Settings;
  saveSettings: (s: Settings) => void;
  /** 把設定值重新填回「屬性」視窗的欄位 */
  syncSettingsInputs: () => void;
  setStatus: (msg: string, kind?: "ok" | "err" | "") => void;
  newLabel: () => Promise<void>;
  openTemplate: () => Promise<void>;
  openRecent: (path: string) => Promise<void>;
}
let deps: StartDeps;
export const initStartDialogs = (d: StartDeps): void => { deps = d; };

/** 紙張與標籤尺寸欄位（紙寬、紙高、標籤寬、標籤高、間隙）。「屬性」視窗（id 不加前綴）與「新增標籤」視窗（前綴 new-）共用，文字維持繁中原文，由 applyDom 翻譯 */
export type SizeKey = "paperWmm" | "paperHmm" | "tplWmm" | "tplHmm" | "gapMm";
export const SIZE_FIELDS: Array<{ id: string; key: SizeKey; label: string; min: number; title?: string }> = [
  { id: "paper-w", key: "paperWmm", label: N("紙寬"), min: 1 }, { id: "paper-h", key: "paperHmm", label: N("紙高"), min: 1 },
  { id: "tpl-w", key: "tplWmm", label: N("標籤寬"), min: 1 }, { id: "tpl-h", key: "tplHmm", label: N("標籤高"), min: 1 },
  { id: "gap", key: "gapMm", label: N("間隙高度"), min: 0, title: N("標籤與標籤之間的空白高度。TSC 驅動「標籤樣式」裡的「間隙高度」") },
];
export function buildSizeFields(): void {
  for (const host of document.querySelectorAll<HTMLElement>("[data-size-fields]")) {
    const prefix = host.dataset.sizeFields ?? "";
    for (const f of SIZE_FIELDS) {
      const label = document.createElement("label");
      if (f.title) label.title = f.title;
      const input = document.createElement("input");
      input.id = prefix + f.id;
      input.type = "number";
      input.step = "0.1";
      if (prefix) input.min = String(f.min);
      label.append(f.label + " ", input);
      host.append(label);
    }
  }
}

/** 新增標籤時詢問紙張與標籤尺寸（像繪圖軟體的「新增文件」）；回傳 false 表示取消 */
const NEW_FIELDS: Array<[string, SizeKey]> = SIZE_FIELDS.map((f) => ["new-" + f.id, f.key]);
export function askNewSize(): Promise<boolean> {
  const dlg = $<HTMLDialogElement>("dlg-new");
  for (const [id, key] of NEW_FIELDS) $<HTMLInputElement>(id).value = String(deps.settings[key]);
  return new Promise((resolve) => {
    let ok = false;
    const done = () => { dlg.removeEventListener("close", done); resolve(ok); };
    dlg.addEventListener("close", done);
    $("new-cancel").onclick = () => dlg.close();
    $("new-ok").onclick = () => {
      const vals = NEW_FIELDS.map(([id]) => Number($<HTMLInputElement>(id).value));
      if (vals.some((v, i) => !Number.isFinite(v) || v < SIZE_FIELDS[i].min || v > (SIZE_FIELDS[i].key === "gapMm" ? MAX_GAP_MM : MAX_SIZE_MM))) { deps.setStatus(tr("請輸入有效的尺寸"), "err"); return; }
      NEW_FIELDS.forEach(([, key], i) => { deps.settings[key] = Math.round(vals[i] * 10) / 10; });
      deps.saveSettings(deps.settings);
      deps.syncSettingsInputs();
      ok = true;
      dlg.close();
    };
    dlg.showModal();
    $<HTMLInputElement>("new-tpl-w").select();
  });
}

// ---------- 歡迎視窗（直接開程式時：建立新標籤／開啟舊標籤／最近使用）----------
const START_KEY = "label-printer.nostart";
export const startDisabled = (): boolean => { try { return localStorage.getItem(START_KEY) === "1"; } catch { return false; } };
export function setStartDisabled(v: boolean): void { try { if (v) localStorage.setItem(START_KEY, "1"); else localStorage.removeItem(START_KEY); } catch { /* 略過 */ } }

export function showStart(): void {
  const dlg = $<HTMLDialogElement>("dlg-start");
  const never = $<HTMLInputElement>("start-never");
  never.checked = startDisabled();
  const list = $("start-recent");
  list.replaceChildren();
  const recent = loadRecent();
  if (!recent.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = tr("（沒有最近使用的標籤）");
    list.append(li);
  }
  for (const p of recent) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.title = p;
    const name = document.createElement("b");
    name.textContent = baseName(p);
    const dir = document.createElement("small");
    dir.textContent = shortDir(p, 48);
    b.append(name, dir);
    b.onclick = () => { dlg.close(); void deps.openRecent(p); };
    li.append(b);
    list.append(li);
  }
  $("start-new").onclick = () => { dlg.close(); void deps.newLabel(); };
  $("start-open").onclick = () => { dlg.close(); void deps.openTemplate(); };
  $("start-cancel").onclick = () => dlg.close();
  dlg.onclose = () => setStartDisabled(never.checked); // 按取消、Esc、選了項目都會記下「不要再顯示」
  dlg.showModal();
}

