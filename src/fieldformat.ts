// 「欄位格式」：在標籤物件（文字 / QR / 條碼）的屬性中，為每個 {{欄位}} 指定日期、數字的顯示格式。
//
// 預設「自動」：照 Excel 儲存格自己的格式顯示（例如 yyyy/mm/dd）。
// 使用者也可以自己指定，寫進內容成為 {{欄位|格式}}，例如 {{出貨日期|yyyy年m月d日}}；
// 實際套用時由後端用 Excel 的格式碼重新格式化該儲存格的原始值（見 main.ts 的 resolveFormats）。

import { PLACEHOLDER, parsePlaceholder, placeholdersOf } from "./template";
import { N, t } from "./i18n";

interface Preset {
  value: string;
  label: string;
}

const GROUPS: { title: string; items: Preset[] }[] = [
  {
    title: N("日期"),
    items: [
      { value: "yyyy/mm/dd", label: "yyyy/mm/dd　2026/11/08" },
      { value: "yyyy/m/d", label: "yyyy/m/d　2026/11/8" },
      { value: "yyyy-mm-dd", label: "yyyy-mm-dd　2026-11-08" },
      { value: "yyyy年m月d日", label: N("yyyy年m月d日　2026年11月8日") },
      { value: "yyyy年mm月dd日", label: N("yyyy年mm月dd日　2026年11月08日") },
      { value: "mm/dd/yyyy", label: "mm/dd/yyyy　11/08/2026" },
      { value: "dd/mm/yyyy", label: "dd/mm/yyyy　08/11/2026" },
      { value: "yyyymmdd", label: "yyyymmdd　20261108" },
      { value: "[$-404]e/m/d", label: N("民國 e/m/d　115/11/8") },
      { value: '[$-404]ggge"年"m"月"d"日"', label: N("民國年月日　民國115年11月8日") },
      { value: "yyyy/mm/dd hh:mm", label: N("日期＋時間　2026/11/08 14:05") },
      { value: "hh:mm", label: N("只顯示時間　14:05") },
    ],
  },
  {
    title: N("數字"),
    items: [
      { value: "0", label: N("0　整數（12.5 → 13）") },
      { value: "0.0", label: N("0.0　一位小數") },
      { value: "0.00", label: N("0.00　兩位小數（30 → 30.00）") },
      { value: "#,##0", label: N("#,##0　千分位（1234567 → 1,234,567）") },
      { value: "#,##0.00", label: N("#,##0.00　千分位＋兩位小數") },
      { value: "0000", label: N("0000　補零到 4 位（12 → 0012）") },
      { value: "00000", label: N("00000　補零到 5 位（12 → 00012）") },
      { value: "0%", label: N("0%　百分比（0.256 → 26%）") },
      { value: "0.0%", label: N("0.0%　百分比一位小數") },
    ],
  },
];

const CUSTOM = "__custom__";
const AUTO_LABEL = N("自動（照 Excel 儲存格的格式）");

/** 格式碼不可含這些字元，否則會破壞 {{欄位|格式}} 的寫法 */
const sanitize = (f: string): string => f.replace(/[|{}]/g, "").trim();

/** 把內容中某個欄位的所有 {{…}} 改成指定格式（空字串 = 自動，即移除格式） */
export function withFormat(content: string, name: string, format: string): string {
  const f = sanitize(format);
  return content.replace(PLACEHOLDER, (whole, inner: string) => {
    const p = parsePlaceholder(inner);
    if (p.name !== name) return whole;
    return f ? `{{${name}|${f}}}` : `{{${name}}}`;
  });
}

let lastSig = "";

/**
 * 依內容中的 {{欄位}} 重建「欄位格式」清單。內容沒有任何欄位時回傳 false（呼叫端可隱藏整個區塊）。
 * @param sigKey 用來判斷是否需要重建的識別（例如選取物件的編號）；內容的欄位與格式沒變就不重建，避免打字時失去焦點
 */
export function renderFormatList(container: HTMLElement, content: string, onChange: (newContent: string) => void, sigKey = "", force = false): boolean {
  const ps = placeholdersOf(content);
  const sig = `${sigKey}\n${ps.map((p) => p.key).join("\n")}`;
  if (!force && sig === lastSig) return ps.length > 0;
  lastSig = sig;

  // 每個欄位只列一次（以第一個出現的格式為準）
  const byName = new Map<string, string>();
  for (const p of ps) if (!byName.has(p.name)) byName.set(p.name, p.format);
  if (byName.size === 0) {
    container.replaceChildren();
    return false;
  }

  const known = new Set(GROUPS.flatMap((g) => g.items.map((i) => i.value)));
  const rows = [...byName].map(([name, format]) => {
    const row = document.createElement("div");
    row.className = "fmt-row";

    const title = document.createElement("code");
    title.textContent = `{{${name}}}`;

    const select = document.createElement("select");
    select.append(new Option(t(AUTO_LABEL), ""));
    for (const g of GROUPS) {
      const og = document.createElement("optgroup");
      og.label = t(g.title);
      og.append(...g.items.map((i) => new Option(t(i.label), i.value)));
      select.append(og);
    }
    select.append(new Option(t("自訂格式…"), CUSTOM));

    const custom = document.createElement("input");
    custom.type = "text";
    custom.className = "fmt-custom";
    custom.placeholder = t("輸入 Excel 格式碼，例如 yyyy/mm/dd");
    custom.spellcheck = false;

    const isCustom = format !== "" && !known.has(format);
    select.value = isCustom ? CUSTOM : format;
    custom.hidden = !isCustom;
    custom.value = isCustom ? format : "";

    select.addEventListener("change", () => {
      if (select.value === CUSTOM) {
        custom.hidden = false;
        custom.focus();
        return;
      }
      custom.hidden = true;
      onChange(withFormat(content, name, select.value));
    });
    custom.addEventListener("change", () => onChange(withFormat(content, name, custom.value)));

    row.append(title, select, custom);
    return row;
  });
  container.replaceChildren(...rows);
  return true;
}
