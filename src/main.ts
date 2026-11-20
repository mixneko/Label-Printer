import "./style.css";
import Konva from "konva";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { askClose } from "./closedialog";
import { showAbout, showLicenses } from "./about";
import { initTheme } from "./theme";
import "./tooltip";
import { autoCheckEnabled, autoCheckOnStartup, checkForUpdate, maybeShowWhatsNew, setAutoCheck, showWhatsNew } from "./update";
import { N, applyDom, currentLang, detectLang, saveLang, setLang, t as tr } from "./i18n";
import { LANG_NAMES, LOCALES, type Lang } from "./locales";
import { attachGuides, guidesEnabled, setGuidesEnabled } from "./guides";
import { calibrationElements } from "./calibration";
import { canvasToMono, monoToCanvas, toBase64, type PackedBitmap } from "./bitmap";
import { initTable, selectedRows, tableHeaders } from "./table";
import { initPreview, openPreview } from "./printpreview";
import { initLayers, moveElements, refreshLayers, toggleLocked, toggleVisible } from "./layers";
import { ALIGN_LABEL, alignTo, bbox, type Align } from "./arrange";
import { hideMenu, isMenuOpen, onMenuHidden, showMenu, type MenuItem } from "./contextmenu";
import { baseName, clearRecent, loadRecent, pushRecent, removeRecent, shortDir } from "./recent";
import { initProps, openProps } from "./props";
import {
  BARCODE_FORMATS, DEFAULT_FONT, nativeCodeFor, setDesignRow, type NativeCode, applyRectStyle, baseSizeOf, contentOf, createElement, defaults, fitText, setContent, isBounded, kindOf, ratioLockOf, refreshCode,
  naturalTextSize, serialize, setBounded, setTextSize, snapQrSize,
  type ElementData, type Kind,
} from "./elements";
import { DOTS_PER_MM, loadSettings, mmToDots, saveSettings, thresholdOf, type Settings } from "./settings";
import { placeholdersOf, substitute, type Placeholder, type Raw, type RawRow, type Row } from "./template";
import { renderFormatList } from "./fieldformat";
import { initFontCombo } from "./fontcombo";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const settings: Settings = loadSettings();
/** 畫面放大倍率（內部座標仍以 dots 為單位）；會依可用空間自動調整，見 fitZoom() */
let zoom = 2;

// ---------- 畫布 ----------
let stage: Konva.Stage;
let layer: Konva.Layer;
let transformer: Konva.Transformer;
let selected: Konva.Shape | null = null; // 剛好選了一個物件時才有值（屬性面板只編輯這一個）
let selection: Konva.Shape[] = []; // 目前選取的全部物件（多選、群組整組）

function updateStageCaption(): void {
  $("stage-caption").textContent = tr("標籤 {tw} × {th} mm（紙張 {pw} × {ph} mm）", { tw: settings.tplWmm, th: settings.tplHmm, pw: settings.paperWmm, ph: settings.paperHmm });
}

function buildStage(): void {
  stage?.destroy();
  const w = mmToDots(settings.tplWmm);
  const h = mmToDots(settings.tplHmm);
  stage = new Konva.Stage({ container: "stage", width: w * zoom, height: h * zoom, scaleX: zoom, scaleY: zoom });
  layer = new Konva.Layer({ imageSmoothingEnabled: false });
  stage.add(layer);
  layer.add(new Konva.Rect({ x: 0, y: 0, width: w, height: h, fill: "white", listening: false }));
  updateStageCaption();
  transformer = new Konva.Transformer({ rotateEnabled: true, keepRatio: true });
  layer.add(transformer);

  // 用 mousedown（而非 click）選取，這樣「直接拖曳尚未選取的物件」也會一併選取它
  stage.on("mousedown tap", (e) => {
    if (e.target.getParent() instanceof Konva.Transformer) return; // 點到縮放控制點
    const el = e.target.hasName("element") ? (e.target as Konva.Shape) : null;
    const ev = e.evt as MouseEvent;
    const add = !!(ev.ctrlKey || ev.metaKey || ev.shiftKey); // Ctrl／Shift：加入或移除，不取代
    dragMoved = false;
    downOn = null;
    if (el) {
      if (add) {
        const members = groupMembers(el);
        const all = members.every((m) => selection.includes(m));
        setSelection(all ? selection.filter((x) => !members.includes(x)) : [...selection, ...members]);
      } else if (!selection.includes(el)) select(el);
      else if (selection.length > 1 && !el.getAttr("groupId")) downOn = el; // 沒拖曳就放開：只留這一個
    } else {
      if (!add) select(null);
      startMarquee(add ? selection.slice() : []);
    }
  });
  stage.on("mouseup touchend", () => {
    if (downOn && !dragMoved && selection.length > 1) select(downOn);
    downOn = null;
  });
  // QR / 條碼在 transformend 時會重新產生影像，之後需更新選取框
  // Konva 的 Transformer 通知物件 transformend 時「不會往上冒泡到圖層」，所以要直接掛在 transformer 上。
  // QR / 條碼在物件自己的 transformend 才把縮放量烘進尺寸，順序不保證，因此更新動作延後到全部處理完。
  transformer.on("transformend", () => {
    setTimeout(() => { transformer.forceUpdate(); updateQrInfo(); }, 0);
    markDirty();
  });
  layer.on("dragend", markDirty);
  attachGuides(layer, () => ({ w: mmToDots(settings.tplWmm), h: mmToDots(settings.tplHmm) }), () => zoom, () => selection);
  // 多選時拖曳其中一個，其餘一起移動（對齊線吸附後的位移同樣套用到全部）
  layer.on("dragstart.multi", (e) => {
    dragMoved = true;
    dragStart = selection.length > 1 && selection.includes(e.target as Konva.Shape)
      ? new Map(selection.map((n) => [n, { x: n.x(), y: n.y() }]))
      : null;
  });
  layer.on("dragmove.multi", (e) => {
    const lead = e.target as Konva.Shape;
    const s0 = dragStart?.get(lead);
    if (!dragStart || !s0) return;
    const dx = lead.x() - s0.x, dy = lead.y() - s0.y;
    for (const [n, p0] of dragStart) if (n !== lead) n.position({ x: p0.x + dx, y: p0.y + dy });
  });
  layer.on("dragend.multi", () => { dragStart = null; });
  stage.on("mousemove touchmove", () => updateMarquee());
  // 右鍵：選取該物件並顯示自訂選單（取代瀏覽器預設的「另存影像／複製影像」）
  stage.on("contextmenu", (e) => {
    e.evt.preventDefault();
    const n = e.target.hasName("element") ? (e.target as Konva.Shape) : null;
    if (!(n && selection.length > 1 && selection.includes(n))) select(n); // 在多選的物件上按右鍵：保留多選
    if (n && selection.length > 1) showMultiMenu(e.evt.clientX, e.evt.clientY);
    else showElementMenu(n, e.evt.clientX, e.evt.clientY);
  });
  select(null);
}

/** 依工作區可用空間調整畫面倍率（0.5～3 倍），讓整張標籤都看得到；只影響顯示，不影響列印 */
function fitZoom(): void {
  if (!stage) return;
  const wrap = document.querySelector<HTMLElement>(".canvas-wrap");
  if (!wrap) return;
  const w = mmToDots(settings.tplWmm);
  const h = mmToDots(settings.tplHmm);
  const availW = wrap.clientWidth - 72;
  const availH = wrap.clientHeight - 72 - 28; // 扣掉邊距與下方的尺寸標示
  const next = Math.max(0.5, Math.min(3, availW / w, availH / h));
  if (Math.abs(next - zoom) < 0.01) return;
  zoom = next;
  stage.size({ width: w * zoom, height: h * zoom });
  stage.scale({ x: zoom, y: zoom });
}

let dragMoved = false; // 這次按下是否拖曳過（沒拖曳才把多選縮回單選）
let downOn: Konva.Shape | null = null;
let dragStart: Map<Konva.Shape, { x: number; y: number }> | null = null;

/** 同一群組的全部成員（沒有群組就是自己） */
function groupMembers(n: Konva.Shape): Konva.Shape[] {
  const g = n.getAttr("groupId") as string | undefined;
  return g ? elements().filter((e) => e.getAttr("groupId") === g) : [n];
}

// ---- 框選：在空白處拖曳畫出選取框，碰到的物件都選起來（按住 Ctrl／Shift 則加入目前的選取）----
let marquee: Konva.Rect | null = null;
let marqueeFrom: { x: number; y: number } | null = null;
let marqueeBase: Konva.Shape[] = [];
function startMarquee(base: Konva.Shape[]): void {
  const p = layer.getRelativePointerPosition();
  if (!p) return;
  marqueeFrom = { x: p.x, y: p.y };
  marqueeBase = base;
  const end = (): void => {
    window.removeEventListener("mouseup", end);
    marquee?.destroy();
    marquee = null;
    marqueeFrom = null;
    layer?.batchDraw();
  };
  window.addEventListener("mouseup", end);
}
function updateMarquee(): void {
  if (!marqueeFrom) return;
  const p = layer.getRelativePointerPosition();
  if (!p) return;
  const x = Math.min(marqueeFrom.x, p.x), y = Math.min(marqueeFrom.y, p.y);
  const w = Math.abs(p.x - marqueeFrom.x), h = Math.abs(p.y - marqueeFrom.y);
  if (!marquee) {
    if (w < 3 && h < 3) return; // 只是點一下，不算框選
    marquee = new Konva.Rect({ stroke: "#2f81f7", strokeWidth: 1 / zoom, dash: [4 / zoom, 3 / zoom], fill: "rgba(47,129,247,0.08)", listening: false, name: "marquee" });
    layer.add(marquee);
  }
  marquee.setAttrs({ x, y, width: w, height: h });
  const hit = elements().filter((n) => {
    if (!n.visible() || n.getAttr("locked")) return false;
    const r = bbox(n, layer);
    return r.x < x + w && r.x + r.width > x && r.y < y + h && r.y + r.height > y;
  });
  setSelection([...marqueeBase, ...hit]);
}

function elements(): Konva.Shape[] {
  return Array.from(layer.find<Konva.Shape>(".element"));
}

/** 依選取物件的設定（鎖定縱橫比 / 鎖定大小）調整縮放控制點；物件的設定改變時也要呼叫 */
function applyTransformerState(): void {
  const multi = selection.length > 1;
  const keep = multi || ratioLockOf(selected);
  transformer.keepRatio(keep);
  transformer.rotateEnabled(!multi); // 多選／群組只能移動與等比例縮放，不能一起旋轉
  // 鎖定縱橫比時只開放四個角的控制點，避免拉邊緣時比例被破壞
  transformer.enabledAnchors(
    keep
      ? ["top-left", "top-right", "bottom-left", "bottom-right"]
      : ["top-left", "top-center", "top-right", "middle-left", "middle-right", "bottom-left", "bottom-center", "bottom-right"],
  );
  // 「鎖定大小」：不顯示縮放控制點（仍可移動、旋轉）
  transformer.resizeEnabled(!selection.some((n) => n.getAttr("sizeLocked")));
}

/** 指定選取的物件（群組整組一起選；鎖定與隱藏的不會被選到） */
function setSelection(nodes: Konva.Shape[]): void {
  const set = new Set<Konva.Shape>();
  for (const n of nodes) for (const m of groupMembers(n)) if (m.visible() && !m.getAttr("locked") && m.getStage()) set.add(m);
  selection = elements().filter((n) => set.has(n)); // 依前後順序排列
  selected = selection.length === 1 ? selection[0] : null;
  transformer.nodes(selection);
  applyTransformerState();
  syncPanel();
  refreshLayers();
  refreshVarSelect();
}

function select(node: Konva.Shape | null): void {
  setSelection(node ? [node] : []);
}

async function addElements(ds: ElementData[]): Promise<void> {
  const nodes: Konva.Shape[] = [];
  for (const d of ds) {
    const node = await createElement(d);
    layer.add(node);
    nodes.push(node);
  }
  transformer.moveToTop();
  setSelection(nodes);
  markDirty();
}
const addElement = (d: ElementData): Promise<void> => addElements([d]);

function removeNode(n: Konva.Shape): void {
  removeNodes([n]);
}

function removeNodes(nodes: Konva.Shape[]): void {
  if (!nodes.length) return;
  const hadSel = nodes.some((n) => selection.includes(n));
  for (const n of nodes) n.destroy();
  if (hadSel) setSelection(selection.filter((n) => !nodes.includes(n)));
  else refreshLayers();
  markDirty();
}

function removeSelected(): void {
  removeNodes(selection.filter((n) => !n.getAttr("locked")));
}

// ---------- 剪貼簿與右鍵選單 ----------
/** 程式內部的剪貼簿（存的是序列化後的物件資料，可複製後貼到另一個範本）；多選時存全部，群組關係一併保留 */
let clip: ElementData[] = [];
let pasteCount = 0;

function copyNodes(nodes: Konva.Shape[]): void {
  clip = nodes.map((n) => serialize(n));
  pasteCount = 0;
  setStatus(nodes.length > 1 ? tr("已複製 {n} 個物件，按 Ctrl+V 貼上", { n: nodes.length }) : tr("已複製，按 Ctrl+V 貼上"), "ok");
}
const copyNode = (n: Konva.Shape): void => copyNodes([n]);

function cutNodes(nodes: Konva.Shape[]): void {
  copyNodes(nodes);
  removeNodes(nodes);
}
const cutNode = (n: Konva.Shape): void => cutNodes([n]);

let groupSeq = 0;
const newGroupId = (): string => `g${Date.now().toString(36)}${(groupSeq++).toString(36)}`;

/** 把一批資料複製成新物件（位移 off；群組換成新編號，貼上後仍是一組，但不與原本的群組相連） */
function cloneData(ds: ElementData[], off: number): ElementData[] {
  const map = new Map<string, string>();
  return ds.map((d) => {
    let groupId = d.groupId;
    if (groupId) { if (!map.has(groupId)) map.set(groupId, newGroupId()); groupId = map.get(groupId); }
    return { ...d, x: d.x + off, y: d.y + off, locked: false, groupId };
  });
}

async function pasteClip(): Promise<void> {
  if (!clip.length) return;
  pasteCount++;
  await addElements(cloneData(clip, 8 * pasteCount)); // 每次貼上位移 1 mm，避免疊在一起看不出來
}

async function duplicateNodes(nodes: Konva.Shape[]): Promise<void> {
  await addElements(cloneData(nodes.map((n) => serialize(n)), 8));
}
const duplicateNode = (n: Konva.Shape): Promise<void> => duplicateNodes([n]);

/** 群組：把選取的物件綁在一起（點其中一個就選到整組，一起移動與縮放）；再按一次「取消群組」拆開 */
function groupSelection(): void {
  if (selection.length < 2) return;
  const id = newGroupId();
  for (const n of selection) n.setAttr("groupId", id);
  setStatus(tr("已建立群組（{n} 個物件）", { n: selection.length }), "ok");
  refreshLayers();
  markDirty();
}

function ungroupSelection(): void {
  const grouped = selection.filter((n) => n.getAttr("groupId"));
  if (!grouped.length) return;
  for (const n of grouped) n.setAttr("groupId", undefined);
  setStatus(tr("已取消群組"), "ok");
  refreshLayers();
  markDirty();
}

function alignNode(n: Konva.Shape, how: Align): void {
  alignSelection([n], how);
}

/** 對齊標籤；選了多個時把它們當成一整塊，整塊對齊（彼此的相對位置不變） */
function alignSelection(nodes: Konva.Shape[], how: Align): void {
  const w = mmToDots(settings.tplWmm), h = mmToDots(settings.tplHmm);
  if (nodes.length === 1) alignTo(nodes[0], layer, how, w, h);
  else if (nodes.length > 1) {
    const rs = nodes.map((n) => bbox(n, layer));
    const x0 = Math.min(...rs.map((r) => r.x)), x1 = Math.max(...rs.map((r) => r.x + r.width));
    const y0 = Math.min(...rs.map((r) => r.y)), y1 = Math.max(...rs.map((r) => r.y + r.height));
    let dx = 0, dy = 0;
    if (how === "left") dx = -x0;
    else if (how === "hcenter") dx = w / 2 - (x0 + x1) / 2;
    else if (how === "right") dx = w - x1;
    else if (how === "top") dy = -y0;
    else if (how === "vcenter") dy = h / 2 - (y0 + y1) / 2;
    else if (how === "bottom") dy = h - y1;
    for (const n of nodes) n.move({ x: dx, y: dy });
  }
  transformer.forceUpdate();
  layer.batchDraw();
  markDirty();
}

function showElementMenu(n: Konva.Shape | null, x: number, y: number): void {
  if (!n) {
    showMenu(x, y, [{ label: tr("貼上"), hint: "Ctrl+V", disabled: !clip.length, onClick: () => void pasteClip() }]);
    return;
  }
  const locked = !!n.getAttr("locked");
  const props: MenuItem = { label: tr("屬性…"), hint: "Alt+Enter", onClick: () => openProps(n) };

  if (locked) {
    showMenu(x, y, [
      { label: tr("複製"), hint: "Ctrl+C", onClick: () => copyNode(n) },
      { label: tr("貼上"), hint: "Ctrl+V", disabled: !clip.length, onClick: () => void pasteClip() },
      { separator: true },
      { label: tr("解除鎖定"), onClick: () => toggleLocked(n) },
      { separator: true },
      props,
    ]);
    return;
  }

  const aligns = (["left", "hcenter", "right", "top", "vcenter", "bottom"] as Align[]).map((how): MenuItem => ({
    label: tr("對齊標籤：{how}", { how: tr(ALIGN_LABEL[how]) }),
    onClick: () => alignNode(n, how),
  }));
  showMenu(x, y, [
    { label: tr("剪下"), hint: "Ctrl+X", onClick: () => cutNode(n) },
    { label: tr("複製"), hint: "Ctrl+C", onClick: () => copyNode(n) },
    { label: tr("貼上"), hint: "Ctrl+V", disabled: !clip.length, onClick: () => void pasteClip() },
    { label: tr("重複"), hint: "Ctrl+D", onClick: () => void duplicateNode(n) },
    { separator: true },
    {
      label: tr("排列"),
      items: [
        { label: tr("置頂"), onClick: () => moveElements([n], "top") },
        { label: tr("上移一層"), onClick: () => moveElements([n], "up") },
        { label: tr("下移一層"), onClick: () => moveElements([n], "down") },
        { label: tr("置底"), onClick: () => moveElements([n], "bottom") },
        { separator: true },
        ...aligns.slice(0, 3),
        { separator: true },
        ...aligns.slice(3),
      ],
    },
    { label: tr("鎖定"), onClick: () => toggleLocked(n) },
    { label: n.visible() ? tr("隱藏") : tr("顯示"), onClick: () => toggleVisible(n) },
    { separator: true },
    { label: tr("刪除"), hint: "Delete", onClick: () => removeNode(n) },
    { separator: true },
    props,
  ]);
}

/** 多選（或群組）時的右鍵選單：對整批物件操作 */
function showMultiMenu(x: number, y: number): void {
  const sel = selection.slice();
  const aligns = (["left", "hcenter", "right", "top", "vcenter", "bottom"] as Align[]).map((how): MenuItem => ({
    label: tr("對齊標籤：{how}", { how: tr(ALIGN_LABEL[how]) }),
    onClick: () => alignSelection(sel, how),
  }));
  const gids = new Set(sel.map((n) => (n.getAttr("groupId") as string | undefined) ?? ""));
  const canGroup = sel.length >= 2 && !(gids.size === 1 && !gids.has(""));
  showMenu(x, y, [
    { label: tr("剪下"), hint: "Ctrl+X", onClick: () => cutNodes(sel) },
    { label: tr("複製"), hint: "Ctrl+C", onClick: () => copyNodes(sel) },
    { label: tr("貼上"), hint: "Ctrl+V", disabled: !clip.length, onClick: () => void pasteClip() },
    { label: tr("重複"), hint: "Ctrl+D", onClick: () => void duplicateNodes(sel) },
    { separator: true },
    { label: tr("群組"), hint: "Ctrl+G", disabled: !canGroup, onClick: groupSelection },
    { label: tr("取消群組"), hint: "Ctrl+Shift+G", disabled: !sel.some((n) => n.getAttr("groupId")), onClick: ungroupSelection },
    { separator: true },
    {
      label: tr("排列"),
      items: [
        { label: tr("置頂"), onClick: () => moveElements(sel, "top") },
        { label: tr("上移一層"), onClick: () => moveElements(sel, "up") },
        { label: tr("下移一層"), onClick: () => moveElements(sel, "down") },
        { label: tr("置底"), onClick: () => moveElements(sel, "bottom") },
        { separator: true },
        ...aligns.slice(0, 3),
        { separator: true },
        ...aligns.slice(3),
      ],
    },
    { label: tr("鎖定"), onClick: () => { for (const n of sel) toggleLocked(n); } },
    { label: tr("隱藏"), onClick: () => { for (const n of sel) toggleVisible(n); } },
    { separator: true },
    { label: tr("刪除"), hint: "Delete", onClick: () => removeNodes(sel) },
  ]);
}

for (const [id, how] of [["align-left", "left"], ["align-center", "hcenter"], ["align-right", "right"]] as const) {
  $(id).addEventListener("click", () => { if (selection.length) alignSelection(selection, how); });
}
$("group-btn").addEventListener("click", groupSelection);
$("ungroup-btn").addEventListener("click", ungroupSelection);

// ---------- 屬性面板 ----------
const kindEls = () => document.querySelectorAll<HTMLElement>("[data-kinds]");

function syncPanel(): void {
  const k = kindOf(selected);
  kindEls().forEach((el) => { el.hidden = !(k && el.dataset.kinds!.split(" ").includes(k)); });
  $("no-selection").hidden = selection.length > 0;
  const multiInfo = $("multi-info");
  multiInfo.hidden = selection.length < 2;
  if (selection.length > 1) {
    const gids = new Set(selection.map((n) => n.getAttr("groupId") as string | undefined));
    multiInfo.textContent = gids.size === 1 && !gids.has(undefined)
      ? tr("已選取一個群組（{n} 個物件）：可一起移動、縮放、對齊；要編輯單一物件請先「取消群組」", { n: selection.length })
      : tr("已選取 {n} 個物件：可一起移動、縮放、對齊、複製或刪除；按 Ctrl+G 可組成群組", { n: selection.length });
  }
  if (!selected || !k) return;

  const text = $<HTMLTextAreaElement>("prop-text");
  if (k === "text") {
    const t = selected as Konva.Text;
    text.value = contentOf(t);
    ensureFontOption(t.fontFamily());
    $<HTMLInputElement>("prop-font").value = t.fontFamily();
    $<HTMLInputElement>("prop-size").value = String(baseSizeOf(t)); // 有最大範圍時是「最大字級」，不是縮小後的字級
    $<HTMLInputElement>("prop-bold").checked = t.fontStyle().includes("bold");
    $<HTMLInputElement>("prop-bounded").checked = isBounded(t);
    $<HTMLSelectElement>("prop-overflow").value = String(t.getAttr("overflow") ?? "shrink");
    $<HTMLInputElement>("prop-minsize").value = String(t.getAttr("minSize") ?? 8);
    $<HTMLSelectElement>("prop-align").value = String(t.getAttr("align") ?? "left");
    $<HTMLSelectElement>("prop-valign").value = String(t.getAttr("valign") ?? "middle");
    syncBoundedUi();
  } else if (k === "qr") {
    text.value = String(selected.getAttr("content") ?? "");
    $<HTMLSelectElement>("prop-ec").value = String(selected.getAttr("ecLevel") ?? "M");
    $<HTMLInputElement>("prop-native").checked = !!selected.getAttr("native");
    updateQrInfo();
  } else if (k === "barcode") {
    text.value = String(selected.getAttr("content") ?? "");
    $<HTMLSelectElement>("prop-format").value = String(selected.getAttr("format"));
    $<HTMLInputElement>("prop-modw").value = String(selected.getAttr("moduleWidth"));
    $<HTMLInputElement>("prop-showtext").checked = !!selected.getAttr("showText");
    $<HTMLSelectElement>("prop-anchor").value = selected.getAttr("anchor") === "right" ? "right" : "left";
    $<HTMLInputElement>("prop-native").checked = !!selected.getAttr("native");
  } else if (k === "rect") {
    $<HTMLInputElement>("prop-filled").checked = !!selected.getAttr("filled");
    $<HTMLInputElement>("prop-stroke").value = String((selected as Konva.Rect).strokeWidth());
  }
  refreshFormatList(true);
}

function applyPanel(): void {
  if (!selected) return;
  const k: Kind | null = kindOf(selected);
  const content = $<HTMLTextAreaElement>("prop-text").value;

  if (k === "text") {
    const t = selected as Konva.Text;
    setContent(t, content);
    // 只接受已安裝的字型；輸入到一半（還不是完整字型名稱）時維持原字型
    t.fontFamily(fontIndex.get($<HTMLInputElement>("prop-font").value.trim().toLowerCase()) ?? t.fontFamily());
    t.fontStyle($<HTMLInputElement>("prop-bold").checked ? "bold" : "normal");
    // 最大範圍：勾選／取消會固定或釋放文字框；其餘選項只在啟用時有意義
    const wantBounded = $<HTMLInputElement>("prop-bounded").checked;
    if (wantBounded !== isBounded(t)) setBounded(t, wantBounded);
    if (isBounded(t)) {
      t.setAttrs({
        overflow: $<HTMLSelectElement>("prop-overflow").value,
        minSize: Math.max(1, Number($<HTMLInputElement>("prop-minsize").value) || 8),
        align: $<HTMLSelectElement>("prop-align").value,
        valign: $<HTMLSelectElement>("prop-valign").value,
      });
    }
    setTextSize(t, Math.max(1, Number($<HTMLInputElement>("prop-size").value) || 32)); // 有最大範圍時會順便依內容縮放
    if (isBounded(t)) fitText(t); // 內容、字型、粗體、對齊等改變後都要重新檢查是否放得進去
    syncBoundedUi();
    applyTransformerState(); // 最大範圍開關會改變縮放控制點（維持比例 / 自由調整）
  } else if (k === "qr") {
    selected.setAttr("content", content);
    selected.setAttr("ecLevel", $<HTMLSelectElement>("prop-ec").value);
    selected.setAttr("native", $<HTMLInputElement>("prop-native").checked ? true : undefined);
    const size = Number($<HTMLInputElement>("prop-qrsize").value);
    if (size >= 1) selected.setAttr("qrSize", Math.round(size));
    refreshCode(selected as Konva.Image);
    updateQrInfo();
  } else if (k === "barcode") {
    selected.setAttr("content", content);
    selected.setAttr("format", $<HTMLSelectElement>("prop-format").value);
    selected.setAttr("moduleWidth", Math.max(1, Number($<HTMLInputElement>("prop-modw").value) || 2));
    selected.setAttr("showText", $<HTMLInputElement>("prop-showtext").checked);
    selected.setAttr("native", $<HTMLInputElement>("prop-native").checked ? true : undefined);
    // 展開方向：切換時位置不動（右邊緣由目前位置算出），之後內容變長／變短才往指定方向長
    if ($<HTMLSelectElement>("prop-anchor").value === "right") selected.setAttr("anchor", "right");
    else selected.setAttr("anchor", undefined);
    refreshCode(selected as Konva.Image);
  } else if (k === "rect") {
    const r = selected as Konva.Rect;
    r.setAttr("filled", $<HTMLInputElement>("prop-filled").checked);
    r.strokeWidth(Math.max(1, Number($<HTMLInputElement>("prop-stroke").value) || 1));
    applyRectStyle(r);
  }
  transformer.forceUpdate();
  refreshLayers(); // 圖層名稱會跟著內容變動
  refreshFormatList(); // 內容中的欄位或格式有變動時才重建，打字時不會失去焦點
  markDirty();
}

/** 文字的「最大範圍」選項：只有勾選時才顯示細項 */
function syncBoundedUi(): void {
  const on = $<HTMLInputElement>("prop-bounded").checked;
  $("bounded-opts").hidden = !on;
  // 沒有勾選時，字級就是文字實際的字級；勾選後它是「最大字級」
  $("prop-size-label").textContent = on ? tr("最大字級 (dots)") : tr("字級 (dots)");
}

/** QR 屬性：大小欄位與「每個模組幾點」的說明 */
function updateQrInfo(): void {
  if (!selected || kindOf(selected) !== "qr") return;
  const size = Math.round(selected.width() * Math.abs(selected.scaleX()));
  const n = Number(selected.getAttr("qrModules")) || 0;
  $<HTMLInputElement>("prop-qrsize").value = String(size);
  const info = $("qr-info");
  const snap = $<HTMLButtonElement>("qr-snap");
  if (!n) {
    info.textContent = tr("內容無法編碼成 QR Code");
    snap.disabled = true;
    return;
  }
  const per = size / n;
  const mm = (size / DOTS_PER_MM).toFixed(1);
  const integer = Number.isInteger(per);
  info.textContent = tr("{n} × {n} 個模組，每個約 {per} 點，全寬 {mm} mm。", { n, per: per.toFixed(2), mm }) +
    (integer ? tr("✓ 每個模組是整數點，列印最清晰。") : per < 2.5 ? tr("⚠ 模組太小且不是整數點，建議放大或按「對齊整數模組」。") : tr("模組寬度會有 ±1 點的差異；要最清晰請按「對齊整數模組」。"));
  info.classList.toggle("warn", !integer && per < 2.5);
  snap.disabled = integer;
}

// ---------- 變數輔助 ----------
/** 所有會帶入資料的物件內容（文字、QR、條碼） */
function elementContents(): string[] {
  return elements().flatMap((n) => {
    const k = kindOf(n);
    return k === "text" ? [contentOf(n as Konva.Text)] : k === "qr" || k === "barcode" ? [String(n.getAttr("content") ?? "")] : [];
  });
}

/** 掃描所有物件內容中用到的欄位名稱（依出現順序、不重複；{{欄位|格式}} 只取欄位名稱） */
function usedVariables(): string[] {
  return [...new Set(elementContents().flatMap((t) => placeholdersOf(t).map((p) => p.name)))];
}

/** 屬性面板的「欄位格式」清單：列出所選物件內容中的每個欄位，可各自指定日期／數字格式 */
function refreshFormatList(force = false): void {
  const box = $("fmt-box");
  const k = kindOf(selected);
  if (!selected || !(k === "text" || k === "qr" || k === "barcode")) {
    box.hidden = true;
    return;
  }
  const content = $<HTMLTextAreaElement>("prop-text").value;
  const has = renderFormatList(
    $("fmt-list"),
    content,
    (next) => { $<HTMLTextAreaElement>("prop-text").value = next; applyPanel(); },
    String(selected._id),
    force,
  );
  box.hidden = !has;
}

/** 把範本用到的欄位補進「變數測試資料」（已填的值保留） */
function scanVariables(): void {
  const names = usedVariables();
  if (names.length === 0) {
    setStatus(tr("這個標籤還沒有使用任何 {{欄位}}"), "err");
    return;
  }
  const ta = $<HTMLTextAreaElement>("vars");
  const have = parseVars(ta.value);
  const lines = ta.value.trim() ? ta.value.replace(/\s+$/, "").split(/\r?\n/) : [];
  for (const name of names) if (!(name in have)) lines.push(`${name}=`);
  ta.value = lines.join("\n");
  ta.dispatchEvent(new Event("input"));
  setStatus(tr("已列出 {n} 個欄位：{names}。請在「＝」後面填入測試值", { n: names.length, names: names.join(tr("、")) }), "ok");
}

/** 「插入變數」下拉選單：優先列出 Excel 的欄位，其次是範本用過與測試資料中的欄位 */
function refreshVarSelect(): void {
  const sel = $<HTMLSelectElement>("var-insert");
  const names = [...new Set([...tableHeaders(), ...usedVariables(), ...Object.keys(parseVars($<HTMLTextAreaElement>("vars").value))])];
  sel.replaceChildren(new Option(names.length ? tr("插入變數…") : tr("（尚無可用欄位）"), ""), ...names.map((n) => new Option(`{{${n}}}`, n)));
  sel.value = "";
  sel.disabled = names.length === 0;
}

/** 已安裝字型（小寫 → 正式名稱）：驗證使用者輸入的字型名稱，並取得正確的大小寫 */
const fontIndex = new Map<string, string>();

function ensureFontOption(name: string): void {
  const key = name.toLowerCase();
  if (!fontIndex.has(key)) fontIndex.set(key, name);
}

async function loadFonts(): Promise<void> {
  let names: string[];
  try {
    names = await invoke<string[]>("list_fonts");
  } catch {
    names = [DEFAULT_FONT, "Arial", "Consolas", "Microsoft YaHei"];
  }
  fontIndex.clear();
  names.forEach(ensureFontOption);
  syncPanel();
}

/** 字型欄位：點進去保留原字型並展開完整清單；輸入關鍵字即篩選；離開時若不是有效字型就還原（見 fontcombo.ts） */
function bindFontInput(): void {
  initFontCombo({
    names: () => [...fontIndex.values()],
    current: () => (selected && kindOf(selected) === "text" ? (selected as Konva.Text).fontFamily() : null),
    isValid: (v) => fontIndex.has(v.trim().toLowerCase()),
    choose: (name) => {
      $<HTMLInputElement>("prop-font").value = name;
      applyPanel();
    },
  });
}

// ---------- 儲存狀態 ----------
let currentPath: string | null = null;
let dirty = false;

function updateTplLabel(): void {
  const name = currentPath ? (currentPath.split(/[\\/]/).pop() ?? currentPath) : tr("未命名標籤");
  const el = $("tpl-name");
  el.textContent = dirty ? `${name} ●` : name;
  el.title = (currentPath ?? tr("尚未儲存")) + (dirty ? tr("（有未儲存的變更）") : "");
  el.classList.toggle("dirty", dirty);
}

function markDirty(): void {
  dirty = true;
  updateTplLabel();
  scheduleRecord();
}

// ---------- 復原 / 重做（Ctrl+Z / Ctrl+Y） ----------
// 以「所有物件的序列化快照」記錄：每次變更後（短暫合併連續動作，如打字）比對快照，不同就推入堆疊。
const HISTORY_MAX = 100;
let undoStack: string[] = [];
let redoStack: string[] = [];
let lastSnap = "[]";
let recordTimer: number | undefined;
let restoring = false;

const snapshot = (): string => JSON.stringify(elements().map(serialize));

/** 開啟／新增標籤之後呼叫：以目前內容作為歷史的起點 */
function resetHistory(): void {
  clearTimeout(recordTimer);
  recordTimer = undefined;
  undoStack = [];
  redoStack = [];
  lastSnap = snapshot();
  syncHistoryButtons();
}

/** 是否有可復原／可重做的動作（還沒記錄進堆疊的最近變更也算，因為 undo() 會先把它記下來） */
const canUndo = (): boolean => undoStack.length > 0 || recordTimer !== undefined;
const canRedo = (): boolean => redoStack.length > 0;
function syncHistoryButtons(): void {
  $<HTMLButtonElement>("undo-btn").disabled = !canUndo();
  $<HTMLButtonElement>("redo-btn").disabled = !canRedo();
}

function scheduleRecord(): void {
  if (restoring) return;
  clearTimeout(recordTimer);
  recordTimer = window.setTimeout(recordNow, 300);
  syncHistoryButtons();
}

function recordNow(): void {
  clearTimeout(recordTimer);
  recordTimer = undefined;
  if (restoring) return;
  const s = snapshot();
  if (s !== lastSnap) {
    undoStack.push(lastSnap);
    if (undoStack.length > HISTORY_MAX) undoStack.shift();
    redoStack = [];
    lastSnap = s;
  }
  syncHistoryButtons();
}

async function restoreSnapshot(s: string): Promise<void> {
  restoring = true;
  try {
    const idxs = selection.map((n) => elements().indexOf(n)).filter((i) => i >= 0);
    for (const n of elements()) n.destroy();
    for (const d of JSON.parse(s) as ElementData[]) layer.add(await createElement(d));
    transformer.moveToTop();
    const els = elements();
    setSelection(idxs.filter((i) => i < els.length).map((i) => els[i]));
    lastSnap = snapshot();
    dirty = true;
    updateTplLabel();
  } finally {
    restoring = false;
    syncHistoryButtons();
  }
}

async function undo(): Promise<void> {
  if (restoring) return;
  recordNow(); // 先把尚未記錄的最後一個動作也算進去
  const prev = undoStack.pop();
  if (prev === undefined) { setStatus(tr("沒有可以復原的動作"), "ok"); return; }
  redoStack.push(lastSnap);
  await restoreSnapshot(prev);
  setStatus(tr("已復原（Ctrl+Y 重做）"), "ok");
}

async function redo(): Promise<void> {
  if (restoring) return;
  recordNow();
  const next = redoStack.pop();
  if (next === undefined) { setStatus(tr("沒有可以重做的動作"), "ok"); return; }
  undoStack.push(lastSnap);
  await restoreSnapshot(next);
  setStatus(tr("已重做"), "ok");
}

// ---------- 範本存取 ----------
/** 標籤檔的副檔名（內容是 JSON）。舊版存的 .json 仍然可以開啟。 */
const LABEL_EXT = "lpxl";
const OPEN_FILTER = [{ name: tr("標籤檔（.lpxl、.json）"), extensions: [LABEL_EXT, "json"] }];
const SAVE_FILTER = [{ name: tr("標籤檔（.lpxl）"), extensions: [LABEL_EXT] }];
/** 另存新檔的預設檔名：沿用目前的檔名但換成 .lpxl（舊的 .json 另存時就升級為新副檔名） */
const defaultSavePath = (cur: string | null): string => (cur ? cur.replace(/\.[^.\\/]+$/, "") : "label") + `.${LABEL_EXT}`;

const isLabelExt = (p: string): boolean => p.toLowerCase().endsWith(`.${LABEL_EXT}`);

/**
 * 儲存標籤：已有檔案就直接覆蓋；尚未存過（或 asNew = true，即「另存新檔」）才跳出選擇檔案的對話框。
 * 從舊的 .json 開啟的標籤，儲存時一律改存成同名的 .lpxl（原本的 .json 不動），最近開啟的記錄也跟著換成新檔。
 */
async function saveTemplate(asNew = false): Promise<boolean> {
  try {
    let path = currentPath;
    let migratedFrom: string | null = null;
    if (path && !asNew && !isLabelExt(path)) {
      const target = defaultSavePath(path);
      // 已經有同名的 .lpxl（例如先前升級過）：先確認，不要默默蓋掉
      if (await invoke<boolean>("path_exists", { path: target })) {
        const ok = await ask(tr("已經有「{name}」，要用目前的內容覆蓋它嗎？", { name: baseName(target) }), { title: tr("儲存標籤"), kind: "warning", okLabel: tr("覆蓋"), cancelLabel: tr("取消") });
        if (!ok) return false;
      }
      migratedFrom = path;
      path = target;
    }
    if (!path || asNew) {
      path = await save({ filters: SAVE_FILTER, defaultPath: defaultSavePath(currentPath) });
      if (!path) return false; // 使用者取消了選擇檔案
    }
    const data = { version: 1, tplWmm: settings.tplWmm, tplHmm: settings.tplHmm, elements: elements().map(serialize) };
    await invoke("write_text_file", { path, content: JSON.stringify(data, null, 2) });
    currentPath = path;
    dirty = false;
    if (migratedFrom) removeRecent(migratedFrom); // 最近開啟的記錄跟著換成新檔
    pushRecent(path);
    updateTplLabel();
    setStatus(migratedFrom ? tr("已儲存為新格式：{path}（原本的 {old} 沒有更動）", { path, old: baseName(migratedFrom) }) : tr("已儲存：{path}", { path }), "ok");
    return true;
  } catch (e) {
    setStatus(String(e), "err");
    return false;
  }
}

/** 目前的標籤有未儲存的變更時，詢問是否放棄；沒有變更就直接放行 */
async function confirmDiscard(what: string): Promise<boolean> {
  if (!dirty) return true;
  return ask(tr("目前的標籤有尚未儲存的變更，要放棄並{what}嗎？", { what: tr(what) }), { title: tr("未儲存的變更"), kind: "warning", okLabel: tr("放棄並{what}", { what: tr(what) }), cancelLabel: tr("取消") });
}

/** 讀取並載入指定路徑的標籤檔（開啟舊檔、最近開啟的檔案共用） */
async function loadLabelFile(path: string): Promise<void> {
  let text: string;
  try {
    text = await invoke<string>("read_text_file", { path });
  } catch (e) {
    removeRecent(path); // 檔案不見了或無法讀取：從最近記錄移除，避免一直點到壞掉的項目
    setStatus(tr("無法開啟「{name}」：{err}（已從最近開啟記錄移除）", { name: baseName(path), err: String(e) }), "err");
    return;
  }
  try {
    const data = JSON.parse(text);
    if (data.version !== 1 || !Array.isArray(data.elements)) throw new Error(tr("不是有效的標籤檔"));
    settings.tplWmm = Number(data.tplWmm) || settings.tplWmm;
    settings.tplHmm = Number(data.tplHmm) || settings.tplHmm;
    saveSettings(settings);
    syncSettingsInputs();
    buildStage();
    for (const d of data.elements as ElementData[]) layer.add(await createElement(d));
    transformer.moveToTop();
    refreshLayers();
    resetHistory();
    currentPath = path;
    dirty = false;
    pushRecent(path);
    updateTplLabel();
    setStatus(tr("已開啟標籤：{path}", { path }), "ok");
  } catch (e) {
    setStatus(tr("開啟標籤失敗：{err}", { err: String(e) }), "err");
  }
}

/** 開啟舊檔：選擇檔案 */
async function openTemplate(): Promise<void> {
  try {
    if (!(await confirmDiscard(N("開啟其他標籤")))) return;
    const path = await open({ filters: OPEN_FILTER, multiple: false });
    if (typeof path !== "string") return;
    await loadLabelFile(path);
  } catch (e) {
    setStatus(tr("開啟標籤失敗：{err}", { err: String(e) }), "err");
  }
}

/** 開啟新檔：清空畫布，建立一份空白標籤（尺寸沿用目前設定） */
async function newLabel(): Promise<void> {
  try {
    if (!(await confirmDiscard(N("建立新標籤")))) return;
    buildStage();
    refreshLayers();
    resetHistory();
    currentPath = null;
    dirty = false;
    updateTplLabel();
    setStatus(tr("已開啟新檔"), "ok");
  } catch (e) {
    setStatus(String(e), "err");
  }
}

/** 產生校正標籤（依目前的標籤尺寸）：外框與 mm 刻度，印出來即可判斷位置偏移 */
async function openCalibration(): Promise<void> {
  try {
    if (!(await confirmDiscard(N("改為校正標籤")))) return;
    buildStage();
    for (const d of calibrationElements(settings.tplWmm, settings.tplHmm)) layer.add(await createElement(d));
    transformer.moveToTop();
    refreshLayers();
    resetHistory();
    currentPath = null;
    dirty = false; // 校正標籤是暫時用的，關閉程式時不必詢問是否儲存
    updateTplLabel();
    setStatus(tr("已產生校正標籤：請列印一張，從外框與刻度判斷偏移量（見「位置左右／上下」）"), "ok");
  } catch (e) {
    setStatus(String(e), "err");
  }
}

/** 最近開啟的檔案：直接開啟，不需要再選檔案 */
async function openRecent(path: string): Promise<void> {
  try {
    if (!(await confirmDiscard(N("開啟其他標籤")))) return;
    await loadLabelFile(path);
  } catch (e) {
    setStatus(tr("開啟標籤失敗：{err}", { err: String(e) }), "err");
  }
}


/** 工具列「檔案」選單：開啟新檔、開啟舊檔、儲存、另存新檔，以及最近開啟的檔案 */
function fileMenuItems(): MenuItem[] {
  const recent = loadRecent();
  const recentItems: MenuItem[] = recent.length
    ? recent.slice(0, 9).map((p, i) => ({ label: `${i + 1}　${baseName(p)}`, hint: shortDir(p), onClick: () => void openRecent(p) }))
    : [{ label: tr("（沒有最近開啟的檔案）"), disabled: true }];
  return [
    { label: tr("開啟新檔"), hint: "Ctrl+N", onClick: () => void newLabel() },
    { label: tr("開啟舊檔…"), hint: "Ctrl+O", onClick: () => void openTemplate() },
    { separator: true },
    { label: tr("儲存"), hint: "Ctrl+S", onClick: () => void saveTemplate() },
    { label: tr("另存新檔…"), hint: "Ctrl+Shift+S", onClick: () => void saveTemplate(true) },
    { separator: true },
    ...recentItems,
    ...(recent.length ? [{ separator: true } as MenuItem, { label: tr("清除最近開啟記錄"), onClick: () => { clearRecent(); setStatus(tr("已清除最近開啟記錄"), "ok"); } }] : []),
  ];
}

const insertMenuItems = (): MenuItem[] => [
  { label: tr("文字"), onClick: () => $("add-text").click() },
  { label: "QR Code", onClick: () => $("add-qr").click() },
  { label: tr("條碼"), onClick: () => $("add-barcode").click() },
  { separator: true },
  { label: tr("矩形"), onClick: () => $("add-rect").click() },
  { label: tr("線條"), onClick: () => $("add-line").click() },
  { label: tr("圖片…"), onClick: () => $("add-image").click() },
];

function editMenuItems(): MenuItem[] {
  const sel = selection.slice();
  const n = selected;
  const none = sel.length === 0;
  const gids = new Set(sel.map((x) => (x.getAttr("groupId") as string | undefined) ?? ""));
  return [
    { label: tr("復原"), hint: "Ctrl+Z", disabled: !canUndo(), onClick: () => void undo() },
    { label: tr("重做"), hint: "Ctrl+Y", disabled: !canRedo(), onClick: () => void redo() },
    { separator: true },
    { label: tr("剪下"), hint: "Ctrl+X", disabled: none, onClick: () => cutNodes(sel) },
    { label: tr("複製"), hint: "Ctrl+C", disabled: none, onClick: () => copyNodes(sel) },
    { label: tr("貼上"), hint: "Ctrl+V", disabled: !clip.length, onClick: () => void pasteClip() },
    { label: tr("重複"), hint: "Ctrl+D", disabled: none, onClick: () => void duplicateNodes(sel) },
    { separator: true },
    { label: tr("全選"), hint: "Ctrl+A", onClick: selectAll },
    { label: tr("群組"), hint: "Ctrl+G", disabled: !(sel.length >= 2 && !(gids.size === 1 && !gids.has(""))), onClick: groupSelection },
    { label: tr("取消群組"), hint: "Ctrl+Shift+G", disabled: !sel.some((x) => x.getAttr("groupId")), onClick: ungroupSelection },
    { separator: true },
    { label: tr("刪除"), hint: "Delete", disabled: none, onClick: () => removeSelected() },
    { separator: true },
    { label: tr("屬性…"), hint: "Alt+Enter", disabled: !n, onClick: () => n && openProps(n) },
  ];
}

function selectAll(): void {
  setSelection(elements());
}

const sidePanel = (): HTMLElement => document.querySelector<HTMLElement>("aside.panel")!;
// 語言名稱一律用該語言自己的寫法，選錯了也找得到回來的路
const langMenuItems = (): MenuItem[] =>
  (Object.keys(LANG_NAMES) as Lang[]).map((l) => ({ label: LANG_NAMES[l], hint: l === currentLang() ? "✓" : "", onClick: () => changeLang(l) }));
const LANG_TAG: Record<Lang, string> = { "zh-TW": "繁", "zh-CN": "简", en: "EN", es: "ES", de: "DE", ja: "日", ko: "한" };
const updateLangTag = (): void => { const el = document.querySelector("#lang-btn .lang-tag"); if (el) el.textContent = LANG_TAG[currentLang()]; };

const viewMenuItems = (): MenuItem[] => [
  { label: tr("預覽列印"), hint: "Ctrl+P", onClick: () => void openPreview() },
  { separator: true },
  { label: tr("對齊線（拖曳時吸附）"), hint: guidesEnabled() ? "✓" : "", onClick: () => { setGuidesEnabled(!guidesEnabled()); setStatus(guidesEnabled() ? tr("對齊線：開（拖曳時靠近邊緣或其他物件會吸附；按住 Alt 可暫時不吸附）") : tr("對齊線：關"), "ok"); } },
  { label: tr("側邊面板"), hint: sidePanel().hidden ? "" : "✓", onClick: () => { sidePanel().hidden = !sidePanel().hidden; window.dispatchEvent(new Event("resize")); } },
];

/** 切換介面語言：立即套用到靜態文字，並重畫目前看得到的動態文字；選擇會記住 */
function changeLang(l: Lang): void {
  if (l === currentLang()) return;
  setLang(l);
  saveLang(l);
  updateLangTag();
  applyDom();
  updateStageCaption();
  updateTplLabel();
  refreshLayers();
  refreshVarSelect();
  syncPanel();
  syncHistoryButtons();
  window.dispatchEvent(new Event("langchange")); // 外觀按鈕等自己監聽
}

/** 工具選單裡的設定視窗（內容原本是側邊欄的卡片，欄位 id 與事件都沒變） */
function openSettings(id: string): void {
  const dlg = $<HTMLDialogElement>(id);
  if (!dlg.open) dlg.showModal();
}
for (const b of document.querySelectorAll<HTMLElement>("[data-dlg-close]")) {
  b.addEventListener("click", () => b.closest("dialog")?.close());
}

function toolsMenuItems(): MenuItem[] {
  return [
    { label: tr("變數測試資料…"), onClick: () => openSettings("dlg-vars") },
    { label: tr("紙張與標籤尺寸…"), onClick: () => openSettings("dlg-paper") },
    { label: tr("列印品質與出紙…"), onClick: () => openSettings("dlg-quality") },
    { label: tr("印表機…"), onClick: () => openSettings("dlg-printer") },
    { separator: true },
    { label: tr("產生校正標籤"), onClick: () => void openCalibration() },
    { label: tr("重新讀取資料來源"), disabled: $("data-panel").hidden, onClick: () => $("data-reload").click() },
  ];
}

const helpMenuItems = (): MenuItem[] => [
  { label: tr("關於 Label Printer"), onClick: () => void showAbout() },
  { label: tr("第三方授權聲明"), onClick: () => showLicenses() },
  { separator: true },
  { label: tr("檢查新版本"), onClick: () => void checkForUpdate() },
  { label: tr("新功能"), onClick: () => void showWhatsNew() },
  { separator: true },
  { label: tr("啟動時自動檢查更新"), hint: autoCheckEnabled() ? "✓" : "", onClick: () => { setAutoCheck(!autoCheckEnabled()); setStatus(autoCheckEnabled() ? tr("已開啟：啟動時自動檢查更新") : tr("已關閉：啟動時不再自動檢查更新"), "ok"); } },
];

// ---------- 渲染 & 列印 ----------
/** 最近一次渲染時各文字實際使用的字級（套用最大範圍縮小之後；只供開發模式的自動化測試讀取） */
let lastRenderSizes: number[] = [];

/** 以指定資料列渲染成 1-bit 點陣（暫時替換變數，渲染完還原） */
function renderBitmap(row: Row, natives?: NativeCode[]) {
  const original = new Map<Konva.Text, string>();
  const hiddenNative: Konva.Shape[] = [];
  const nodes = elements();
  try {
    for (const n of nodes) {
      const k = kindOf(n);
      if (k === "text") {
        const t = n as Konva.Text;
        original.set(t, t.text());
        t.text(substitute(contentOf(t), row));
        fitText(t); // 最大範圍：依「這一張」標籤的實際內容各自縮小（內容短的維持原字級）
      } else if (k === "qr" || k === "barcode") {
        refreshCode(n as Konva.Image, row);
        // 實際列印時，啟用「原生指令」的條碼／QR 不畫進點陣，改由印表機指令列印（預覽沒有傳 natives，仍以點陣近似顯示）
        if (natives && n.visible()) {
          const c = nativeCodeFor(n as Konva.Image, row);
          if (c) { natives.push(c); n.visible(false); hiddenNative.push(n); }
        }
      }
    }
    lastRenderSizes = nodes.filter((n) => kindOf(n) === "text").map((n) => (n as Konva.Text).fontSize());
    transformer.hide();
    // 輸出時暫時把畫面還原為 1:1，確保點陣尺寸永遠剛好等於範本的 dots，不受畫面縮放影響
    const w = mmToDots(settings.tplWmm);
    const h = mmToDots(settings.tplHmm);
    const view = { size: stage.size(), scale: stage.scale() };
    stage.size({ width: w, height: h });
    stage.scale({ x: 1, y: 1 });
    const canvas = stage.toCanvas({ pixelRatio: 1 });
    stage.size(view.size);
    stage.scale(view.scale);
    transformer.show();
    return canvasToMono(canvas, thresholdOf(settings)); // 「字體加粗」會提高門檻，讓筆畫更粗更黑
  } finally {
    for (const n of hiddenNative) n.visible(true);
    original.forEach((v, t) => { t.text(v); fitText(t); }); // 還原設計畫面的內容，並依原內容重新套用最大範圍
    for (const n of nodes) {
      const k = kindOf(n);
      if (k === "qr" || k === "barcode") refreshCode(n as Konva.Image);
    }
    transformer.show();
  }
}

/** 預覽列印資訊列：有物件啟用原生指令時提醒「預覽是點陣近似」 */
function nativeNote(): string {
  const n = elements().filter((e) => (kindOf(e) === "qr" || kindOf(e) === "barcode") && e.getAttr("native")).length;
  return n ? tr("有 {n} 個條碼／QR 使用印表機原生指令（預覽以點陣近似顯示）　", { n }) : "";
}

function setStatus(msg: string, kind: "ok" | "err" | "" = ""): void {
  const el = $("status");
  el.textContent = msg;
  el.className = `status ${kind}`;
}

// ---------- 變數測試資料 ----------
const VARS_KEY = "label-printer.vars";

/** 解析「欄位=值」逐行文字；以第一個 = 分隔，空行與沒有 = 的行忽略 */
function parseVars(text: string): Row {
  const row: Row = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    row[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return row;
}

function currentRow(): Row {
  return parseVars($<HTMLTextAreaElement>("vars").value);
}

/** 最近一次套用「欄位格式」後的資料列（只供開發模式的自動化測試讀取） */
let lastResolved: Row[] = [];

/**
 * 「欄位格式」：標籤上的 {{欄位|格式}} 需要 Excel 儲存格的原始值才能重新格式化。
 * 這裡一次向後端算好所有需要的格式化結果，以 {{…}} 內文為鍵放進各列的 row；
 * 沒有原始值（文字、CSV、手動填的測試資料），或格式碼無法套用時，不放進去，substitute 會退回該欄位原本的值。
 */
async function resolveFormats(rows: Row[], raws: RawRow[] = []): Promise<Row[]> {
  const wanted = new Map<string, Placeholder>();
  for (const text of elementContents()) for (const p of placeholdersOf(text)) if (p.format) wanted.set(p.key, p);

  type Req = { row: number; key: string; raw: Raw; code: string };
  const reqs: Req[] = [];
  if (wanted.size > 0) {
    rows.forEach((_, i) => {
      const raw = raws[i];
      if (!raw) return;
      for (const p of wanted.values()) {
        const r = raw[p.name];
        if (r) reqs.push({ row: i, key: p.key, raw: r, code: p.format });
      }
    });
  }
  let next = rows;
  if (reqs.length > 0) {
    const out = await invoke<(string | null)[]>("format_values", { items: reqs.map((r) => ({ raw: r.raw, code: r.code })) });
    next = rows.map((r) => ({ ...r }));
    reqs.forEach((r, k) => { if (out[k] != null) next[r.row][r.key] = out[k]!; });
  }
  lastResolved = next;
  return next;
}

/** 預覽指定資料列（未指定時使用「變數測試資料」）套用後、實際送給印表機的黑白點陣 */
async function previewBitmap(row: Row = currentRow(), raw?: RawRow): Promise<void> {
  try {
    const [resolved] = await resolveFormats([row], raw ? [raw] : []);
    monoToCanvas(renderBitmap(resolved), $<HTMLCanvasElement>("preview"));
    $<HTMLCanvasElement>("preview").hidden = false;
    const n = Object.keys(row).length;
    setStatus(n ? tr("預覽已套用 {n} 個變數", { n }) : tr("預覽（目前沒有變數資料，{{欄位}} 會原樣顯示）"), "ok");
  } catch (e) {
    setStatus(String(e), "err");
  }
}

/** 點陣在紙上的位置（標籤置中於紙張）。實際列印與「預覽列印」共用這一個計算，確保所見即所印 */
function placement(bmp: PackedBitmap): { offsetX: number; offsetY: number } {
  const paperW = mmToDots(settings.paperWmm);
  return {
    offsetX: Math.max(0, Math.floor((paperW - bmp.width) / 2) + mmToDots(settings.shiftXmm)),
    offsetY: Math.max(0, mmToDots(settings.shiftYmm)),
  };
}

/** 把一筆資料列渲染成送給後端的列印工作 */
function makeJob(row: Row) {
  const natives: NativeCode[] = [];
  const bmp = renderBitmap(row, natives);
  const place = placement(bmp);
  return {
    natives,
    paperWmm: settings.paperWmm,
    paperHmm: settings.paperHmm,
    gapMm: settings.gapMm,
    offsetXDots: place.offsetX,
    offsetYDots: place.offsetY,
    widthPx: bmp.width,
    heightPx: bmp.height,
    bitmap: toBase64(bmp.data),
    copies: Math.max(1, Number($<HTMLInputElement>("copies").value) || 1),
    density: settings.density,
    speed: settings.speed,
    tear: settings.tear,
    offsetMm: settings.feedOffsetMm,
  };
}

/** 每一列資料印一組（每筆張數見工具列），全部合成同一個列印工作送出 */
async function printRows(rows: Row[], raws: RawRow[] = []): Promise<void> {
  try {
    const target =
      settings.printerMode === "windows"
        ? { kind: "windows", name: settings.printerName }
        : { kind: "tcp", host: settings.host, port: settings.port };
    const jobs = (await resolveFormats(rows, raws)).map(makeJob);
    await invoke("print_labels", { target, jobs });
    const per = jobs[0]?.copies ?? 1;
    setStatus(tr("已送出列印：{rows} 筆資料 × {per} 張 = {total} 張", { rows: rows.length, per, total: rows.length * per }), "ok");
  } catch (e) {
    setStatus(String(e), "err");
  }
}

const print = () => printRows([currentRow()]);

/** 把 {{欄位}} 插入目前選取物件的內容（文字 / QR / 條碼） */
function insertVariable(name: string): void {
  const k = kindOf(selected);
  if (!selected || !(k === "text" || k === "qr" || k === "barcode")) {
    setStatus(tr("請先選取畫布上的文字、QR Code 或條碼物件，再點欄位名稱"), "err");
    return;
  }
  const ta = $<HTMLTextAreaElement>("prop-text");
  ta.setRangeText(`{{${name}}}`, ta.selectionStart, ta.selectionEnd, "end");
  applyPanel();
}

// ---------- 設定欄位綁定 ----------
const numFields: Array<[string, keyof Settings]> = [
  ["paper-w", "paperWmm"], ["paper-h", "paperHmm"], ["tpl-w", "tplWmm"], ["tpl-h", "tplHmm"], ["gap", "gapMm"], ["port", "port"],
];

function syncSettingsInputs(): void {
  for (const [id, key] of numFields) $<HTMLInputElement>(id).value = String(settings[key]);
  $<HTMLInputElement>("host").value = settings.host;
}

/** 「列印品質與出紙」：濃度、速度、字體加粗、撕紙位置、額外送紙 */
function bindQuality(): void {
  const dens = $<HTMLInputElement>("q-density");
  const speed = $<HTMLSelectElement>("q-speed");
  const bold = $<HTMLInputElement>("q-bold");
  const tear = $<HTMLInputElement>("q-tear");
  const off = $<HTMLInputElement>("q-offset");
  const sx = $<HTMLInputElement>("q-shiftx");
  const sy = $<HTMLInputElement>("q-shifty");
  const show = () => {
    dens.value = String(settings.density);
    $("q-density-val").textContent = String(settings.density);
    speed.value = String(settings.speed);
    bold.value = String(settings.boldness);
    $("q-bold-val").textContent = settings.boldness === 0 ? tr("標準") : `+${settings.boldness}`;
    tear.checked = settings.tear;
    off.value = String(settings.feedOffsetMm);
    sx.value = String(settings.shiftXmm);
    sy.value = String(settings.shiftYmm);
  };
  const commit = () => { saveSettings(settings); show(); };
  dens.addEventListener("input", () => { settings.density = Number(dens.value); commit(); });
  speed.addEventListener("change", () => { settings.speed = Number(speed.value); commit(); });
  bold.addEventListener("input", () => {
    settings.boldness = Number(bold.value);
    commit();
    if (!$<HTMLCanvasElement>("preview").hidden) void previewBitmap(); // 預覽已開著就即時更新，看得到加粗效果
  });
  tear.addEventListener("change", () => { settings.tear = tear.checked; commit(); });
  off.addEventListener("change", () => {
    const v = Number(off.value);
    settings.feedOffsetMm = Number.isFinite(v) ? Math.max(-20, Math.min(20, v)) : 0;
    commit();
  });
  const shift = (el: HTMLInputElement, key: "shiftXmm" | "shiftYmm", min: number, max: number) =>
    el.addEventListener("change", () => {
      const v = Number(el.value);
      settings[key] = Number.isFinite(v) ? Math.round(Math.max(min, Math.min(max, v)) * 10) / 10 : 0;
      commit();
    });
  $("make-calibration").addEventListener("click", () => { $<HTMLDialogElement>("dlg-quality").close(); void openCalibration(); });
  shift(sx, "shiftXmm", -5, 5);
  shift(sy, "shiftYmm", 0, 5);
  show();
}

function bindSettings(): void {
  syncSettingsInputs();
  bindQuality();
  for (const [id, key] of numFields) {
    $<HTMLInputElement>(id).addEventListener("change", (e) => {
      (settings[key] as number) = Number((e.target as HTMLInputElement).value);
      saveSettings(settings);
      if (key === "tplWmm" || key === "tplHmm") {
        // 變更範本尺寸時保留現有物件
        const keep = elements().map(serialize);
        markDirty();
        buildStage();
        void Promise.all(keep.map(createElement)).then((nodes) => { nodes.forEach((n) => layer.add(n)); transformer.moveToTop(); refreshLayers(); });
      }
    });
  }
  const host = $<HTMLInputElement>("host");
  host.addEventListener("change", () => { settings.host = host.value.trim(); saveSettings(settings); });

  const mode = $<HTMLSelectElement>("printer-mode");
  const applyMode = () => {
    $("windows-fields").hidden = settings.printerMode !== "windows";
    $("tcp-fields").hidden = settings.printerMode !== "tcp";
  };
  mode.value = settings.printerMode;
  mode.addEventListener("change", () => {
    settings.printerMode = mode.value as Settings["printerMode"];
    saveSettings(settings);
    applyMode();
  });
  applyMode();

  const name = $<HTMLSelectElement>("printer-name");
  name.addEventListener("change", () => { settings.printerName = name.value; saveSettings(settings); });
  $("refresh-printers").addEventListener("click", () => void loadPrinters());
  void loadPrinters();
}

/** 向後端取得 Windows 已安裝的印表機清單，並保留先前的選擇 */
async function loadPrinters(): Promise<void> {
  const select = $<HTMLSelectElement>("printer-name");
  try {
    const names = await invoke<string[]>("list_printers");
    select.replaceChildren(...names.map((n) => new Option(n, n)));
    if (names.includes(settings.printerName)) {
      select.value = settings.printerName;
    } else {
      // 優先挑名稱含 TSC/TTP 的印表機，否則取第一台
      settings.printerName = names.find((n) => /tsc|ttp/i.test(n)) ?? names[0] ?? "";
      select.value = settings.printerName;
      saveSettings(settings);
    }
  } catch (e) {
    setStatus(tr("無法取得印表機清單：{err}", { err: String(e) }), "err");
  }
}

// ---------- 啟動 ----------
bindSettings();
buildStage();
fitZoom();
new ResizeObserver(fitZoom).observe(document.querySelector(".canvas-wrap")!);
initLayers({
  elements,
  selected: () => selected,
  selection: () => selection,
  select,
  setSelection,
  changed: () => { transformer.moveToTop(); transformer.forceUpdate(); layer.batchDraw(); markDirty(); },
  contextMenu: (n, x, y) => {
    if (n.visible() && !n.getAttr("locked") && !selection.includes(n)) select(n);
    if (selection.length > 1 && selection.includes(n)) showMultiMenu(x, y);
    else showElementMenu(n, x, y);
  },
});
initProps({
  layer: () => layer,
  templateSize: () => ({ w: mmToDots(settings.tplWmm), h: mmToDots(settings.tplHmm) }),
  changed: () => { applyTransformerState(); transformer.forceUpdate(); layer.batchDraw(); markDirty(); },
  refresh: () => { refreshLayers(); syncPanel(); },
});
// 工作區內一律不顯示瀏覽器預設的右鍵選單（輸入欄位內仍保留，方便複製貼上文字）
document.querySelector(".workspace")?.addEventListener("contextmenu", (e) => e.preventDefault());
void loadFonts();
$<HTMLSelectElement>("prop-format").replaceChildren(...BARCODE_FORMATS.map((f) => new Option(f, f)));

$("add-text").addEventListener("click", () => void addElement(defaults("text")));
$("add-qr").addEventListener("click", () => void addElement(defaults("qr")));
$("add-barcode").addEventListener("click", () => void addElement(defaults("barcode")));
$("add-rect").addEventListener("click", () => void addElement(defaults("rect")));
$("add-line").addEventListener("click", () => void addElement(defaults("line")));
$("add-image").addEventListener("click", () => $<HTMLInputElement>("image-file").click());
$<HTMLInputElement>("image-file").addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    const src = String(reader.result);
    const probe = new Image();
    probe.src = src;
    await probe.decode();
    const fit = Math.min(1, 240 / Math.max(probe.naturalWidth, probe.naturalHeight));
    await addElement({ ...defaults("image"), src, width: Math.round(probe.naturalWidth * fit), height: Math.round(probe.naturalHeight * fit) });
  };
  reader.readAsDataURL(file);
});

$("delete").addEventListener("click", removeSelected);
$("print").addEventListener("click", print);
$("preview-btn").addEventListener("click", () => void previewBitmap());
initTable({
  onPreview: previewBitmap, onPrint: printRows, onInsertVar: insertVariable, onStatus: setStatus, onChange: refreshVarSelect,
  onPrintPreview: () => void openPreview(),
});
// 預覽列印：勾選了資料列就逐張預覽那些列，否則預覽「變數測試資料」的單張
initPreview({
  source: () => {
    const sel = selectedRows();
    return sel
      ? { ...sel, from: tr("勾選的資料列") }
      : { rows: [currentRow()], raws: [], names: [tr("變數測試資料")], from: tr("使用「變數測試資料」（單張）") };
  },
  render: async (row, raw) => {
    const [resolved] = await resolveFormats([row], raw ? [raw] : []);
    const bmp = renderBitmap(resolved);
    return { bmp, ...placement(bmp) };
  },
  info: () => {
    const printer = settings.printerMode === "windows" ? settings.printerName || tr("（尚未選擇印表機）") : `${settings.host}:${settings.port}`;
    const bold = settings.boldness === 0 ? tr("標準") : `+${settings.boldness}`;
    const feed = settings.feedOffsetMm ? tr("　額外送紙 {mm} mm", { mm: settings.feedOffsetMm }) : "";
    return {
      paperW: mmToDots(settings.paperWmm), paperH: mmToDots(settings.paperHmm),
      paperWmm: settings.paperWmm, paperHmm: settings.paperHmm, tplWmm: settings.tplWmm, tplHmm: settings.tplHmm,
      gapMm: settings.gapMm, gapDots: mmToDots(settings.gapMm),
      copies: Math.max(1, Number($<HTMLInputElement>("copies").value) || 1),
      summary: `${nativeNote()}${tr("印表機：{printer}　濃度 {density}　速度 {speed}　字體加粗 {bold}　撕紙位置 {tear}", { printer, density: settings.density, speed: settings.speed, bold, tear: settings.tear ? tr("開") : tr("關") })}${feed}`,
    };
  },
  print: (rows, raws) => printRows(rows, raws),
});
$("preview-print").addEventListener("click", () => void openPreview());
try { $<HTMLTextAreaElement>("vars").value = localStorage.getItem(VARS_KEY) ?? ""; } catch { /* 無法讀取則留空 */ }
/** 條碼在畫布上顯示「變數測試資料」的內容；測試資料改了，畫布上的條碼（寬度）要跟著更新 */
function refreshDesignBarcodes(): void {
  let changed = false;
  for (const n of elements()) if (kindOf(n) === "barcode") { refreshCode(n as Konva.Image); changed = true; }
  if (changed) { transformer.forceUpdate(); layer.batchDraw(); }
}
setDesignRow(currentRow);
refreshDesignBarcodes();
$("vars").addEventListener("input", () => {
  try { localStorage.setItem(VARS_KEY, $<HTMLTextAreaElement>("vars").value); } catch { /* ignore */ }
  refreshVarSelect();
  refreshDesignBarcodes();
});
$("vars-scan").addEventListener("click", scanVariables);
// QR 大小：輸入完成（Enter 或離開欄位）才套用，避免打字打到一半就把 QR 縮成很小
$("prop-qrsize").addEventListener("change", applyPanel);
$("qr-snap").addEventListener("click", () => {
  if (!selected || kindOf(selected) !== "qr") return;
  const n = Number(selected.getAttr("qrModules")) || 0;
  if (!n) return;
  selected.setAttr("qrSize", snapQrSize(Number(selected.getAttr("qrSize")) || n, n));
  refreshCode(selected as Konva.Image);
  updateQrInfo();
  transformer.forceUpdate();
  markDirty();
});
$<HTMLSelectElement>("var-insert").addEventListener("change", (e) => {
  const name = (e.target as HTMLSelectElement).value;
  if (name) insertVariable(name);
  refreshVarSelect();
});
refreshVarSelect();
// 「檔案」選單：選單開著時再按一次按鈕要收起來。
// 選單自己有「點在選單外就關閉」的捕獲階段監聽，會比按鈕的 mousedown 先執行，所以「原本是否開著」要在更早（捕獲階段、
// 且早於選單登記監聽）記下來。
const BAR: Array<{ id: string; key: string; items: () => MenuItem[] }> = [
  { id: "file-menu", key: "f", items: fileMenuItems },
  { id: "menu-insert", key: "i", items: insertMenuItems },
  { id: "menu-edit", key: "e", items: editMenuItems },
  { id: "menu-view", key: "v", items: viewMenuItems },
  { id: "menu-tools", key: "t", items: toolsMenuItems },
  { id: "help-menu", key: "h", items: helpMenuItems },
  { id: "lang-btn", key: "", items: langMenuItems },
];
let barOpen: string | null = null;
const clearBar = (): void => { barOpen = null; document.querySelectorAll(".mb.on").forEach((b) => b.classList.remove("on")); };
onMenuHidden(clearBar);
function openBar(id: string): void {
  const def = BAR.find((b) => b.id === id)!;
  clearBar();
  const el = $(id);
  el.classList.add("on");
  barOpen = id;
  const r = el.getBoundingClientRect();
  showMenu(r.left, r.bottom + 2, def.items());
}
// 按下時記下「這個功能表原本是否開著」，click 時才能做到再按一次就收起來（選單自己的「點選單外就關閉」捕獲監聽會先執行）
let barWasOpen: string | null = null;
document.addEventListener("mousedown", (e) => {
  const b = (e.target as HTMLElement).closest?.(".mb");
  barWasOpen = b && isMenuOpen() ? barOpen : null;
}, true);
for (const def of BAR) {
  const el = $(def.id);
  el.addEventListener("click", () => {
    if (barWasOpen === def.id) { barWasOpen = null; hideMenu(); } else openBar(def.id);
  });
  // 已經有功能表開著時，滑到隔壁的功能表就直接切換
  el.addEventListener("mouseenter", () => { if (barOpen && barOpen !== def.id && isMenuOpen()) openBar(def.id); });
}
// Alt+字母開啟功能表（Alt+F／I／E／V／T／H）
window.addEventListener("keydown", (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey || document.querySelector("dialog[open]")) return;
  const def = BAR.find((b) => b.key && b.key === e.key.toLowerCase());
  if (!def) return;
  e.preventDefault();
  openBar(def.id);
});
initTheme($("theme-btn"));
updateLangTag();
void maybeShowWhatsNew();
void autoCheckOnStartup();
applyDom(); // 靜態的 index.html 文字換成目前語言（繁體中文時不會有任何變動）
$("undo-btn").addEventListener("click", () => void undo());
$("redo-btn").addEventListener("click", () => void redo());
syncHistoryButtons();
bindFontInput();
updateTplLabel();

for (const id of ["prop-text", "prop-font", "prop-size", "prop-bold", "prop-bounded", "prop-overflow", "prop-minsize", "prop-align", "prop-valign", "prop-format", "prop-modw", "prop-showtext", "prop-anchor", "prop-native", "prop-ec", "prop-filled", "prop-stroke"]) {
  $(id).addEventListener("input", applyPanel);
  $(id).addEventListener("change", applyPanel);
}

// 快捷鍵：Ctrl+S 儲存、Ctrl+Shift+S 另存新檔、Ctrl+O 開啟（在輸入框內也有效）
window.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === "s") { e.preventDefault(); void saveTemplate(e.shiftKey); }
  else if (k === "o") { e.preventDefault(); void openTemplate(); }
  else if (k === "n") { e.preventDefault(); void newLabel(); }
  else if (k === "p") { e.preventDefault(); void openPreview(); } // 攔下瀏覽器預設的列印對話框，改為「預覽列印」
});

// 快捷鍵：Ctrl+C 複製、Ctrl+X 剪下、Ctrl+V 貼上、Ctrl+D 重複、Alt+Enter 屬性。
// 在輸入欄位內不攔截，才能正常複製貼上文字。
window.addEventListener("keydown", (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(tag) || document.querySelector("dialog[open]")) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "z" && !e.shiftKey) { e.preventDefault(); void undo(); }
  else if ((e.ctrlKey || e.metaKey) && (k === "y" || (k === "z" && e.shiftKey))) { e.preventDefault(); void redo(); }
  else if ((e.ctrlKey || e.metaKey) && k === "c" && selection.length) { e.preventDefault(); copyNodes(selection.slice()); }
  else if ((e.ctrlKey || e.metaKey) && k === "x" && selection.length) { e.preventDefault(); cutNodes(selection.slice()); }
  else if ((e.ctrlKey || e.metaKey) && k === "v") { e.preventDefault(); void pasteClip(); }
  else if ((e.ctrlKey || e.metaKey) && k === "d" && selection.length) { e.preventDefault(); void duplicateNodes(selection.slice()); }
  else if ((e.ctrlKey || e.metaKey) && k === "a") { e.preventDefault(); selectAll(); }
  else if ((e.ctrlKey || e.metaKey) && k === "g" && !e.shiftKey) { e.preventDefault(); groupSelection(); }
  else if ((e.ctrlKey || e.metaKey) && k === "g" && e.shiftKey) { e.preventDefault(); ungroupSelection(); }
  else if (e.altKey && e.key === "Enter" && selected) { e.preventDefault(); hideMenu(); openProps(selected); }
});

// 鍵盤：Delete 刪除、方向鍵微調（Shift 加大步距）
window.addEventListener("keydown", (e) => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement).tagName) || !selection.length || document.querySelector("dialog[open]")) return;
  const step = e.shiftKey ? 8 : 1;
  const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (e.key === "Delete") removeSelected();
  else if (moves[e.key]) { for (const n of selection) n.move({ x: moves[e.key][0], y: moves[e.key][1] }); transformer.forceUpdate(); markDirty(); }
  else return;
  e.preventDefault();
});

// 僅開發模式：提供自動化測試（scripts/ui-shot.mjs 之類）讀取縮放控制點與物件狀態。打包後的程式不含這段。
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__lp = {
    i18n: { LOCALES, setLang, applyDom, t: tr, changeLang, detectLang },
    selCount: () => selection.length,
    groupIds: () => elements().map((n) => n.getAttr("groupId") ?? null),
    selectIdx: (idxs: number[]) => { const els = elements(); setSelection(idxs.map((i) => els[i])); },
    bboxOf: (i: number) => { const r = bbox(elements()[i], layer); return { x: r.x, y: r.y, w: r.width, h: r.height }; },
    anchor: (name: string) => transformer.findOne(`.${name}`)?.getAbsolutePosition(),
    node: () =>
      selected
        ? {
            x: selected.x(), y: selected.y(), w: selected.width(), h: selected.height(), sx: selected.scaleX(), sy: selected.scaleY(),
            qrSize: selected.getAttr("qrSize"), rotation: selected.rotation(), bbox: bbox(selected, layer),
            ratio: ratioLockOf(selected), sizeLocked: !!selected.getAttr("sizeLocked"), resizeEnabled: transformer.resizeEnabled(),
            locked: !!selected.getAttr("locked"), visible: selected.visible(), label: selected.getAttr("label"), anchor: selected.getAttr("anchor") ?? "left",
          }
        : null,
    count: () => elements().length,
    /** 以指定資料列重新產生所選條碼（像列印時一樣），回傳位置與寬度後還原成設計畫面 */
    barcodeWith: (row: Row) => {
      if (!selected || kindOf(selected) !== "barcode") return null;
      refreshCode(selected as Konva.Image, row);
      const r = { x: selected.x(), w: selected.width(), h: selected.height() };
      refreshCode(selected as Konva.Image);
      return r;
    },
    undoDepth: () => undoStack.length,
    askClose,
    resolved: () => lastResolved,
    renderedSizes: () => lastRenderSizes,
    konva: Konva,
    /** 所選文字的字級與最大範圍狀態 */
    text: () =>
      selected && kindOf(selected) === "text"
        ? (() => {
            const t = selected as Konva.Text;
            const nat = naturalTextSize(t);
            return {
              fontFamily: t.fontFamily(), fontSize: t.fontSize(), baseSize: baseSizeOf(t), bounded: isBounded(t), textWidth: nat.w, textHeight: nat.h,
              boxW: t.getAttr("boxW"), boxH: t.getAttr("boxH"), overflow: t.getAttr("overflow"), minSize: t.getAttr("minSize"),
              align: t.align(), valign: t.verticalAlign(), width: t.width(), height: t.height(), scaleX: t.scaleX(), scaleY: t.scaleY(),
            };
          })()
        : null,
    /** 第 i 個物件中心的舞台座標（需再加上 #stage 容器的位置才是視窗座標） */
    pt: (i: number) => { const r = elements()[i].getClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; },
  };
}

console.info(`Label Printer ready (${DOTS_PER_MM} dots/mm)`);

// 在檔案總管雙擊標籤檔（.lpxl）開啟程式時，Windows 會把檔案路徑當成命令列參數傳進來，這裡直接載入它
void (async () => {
  try {
    const p = await invoke<string | null>("startup_file");
    if (p) await loadLabelFile(p);
  } catch { /* 沒有 Tauri（瀏覽器開發／自動化測試）或沒有帶檔案：照常開空白標籤 */ }
})();

// ---------- 關閉視窗前確認 ----------
// 有未儲存的變更時，按視窗的 X 要先詢問，不能直接關閉。
// 非 Tauri 環境（瀏覽器開發／自動化測試的模擬）沒有視窗 API，略過即可。
let closing = false;
try {
  const win = getCurrentWindow();
  void win.onCloseRequested(async (event) => {
    if (!dirty) return;
    event.preventDefault();
    if (closing) return; // 已有一個詢問視窗開著
    closing = true;
    try {
      const c = await askClose(tr("目前的標籤有尚未儲存的變更，關閉前要先儲存嗎？"));
      if (c === "discard") await win.destroy();
      else if (c === "save" && (await saveTemplate())) await win.destroy(); // 儲存失敗或取消選檔時留在程式裡
    } finally {
      closing = false;
    }
  });
} catch { /* 沒有視窗 API */ }
