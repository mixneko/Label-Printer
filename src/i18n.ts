/**
 * 多國語系。
 *
 * 做法（類似 gettext）：**原文（繁體中文）就是鍵**。程式裡寫 `t("開啟新檔")`；找不到翻譯就原樣回傳原文，
 * 所以繁體中文永遠是完整的、缺翻譯的語言也不會出現空白或鍵名。
 * 含變數的字串用 `{名稱}` 佔位：`t("已儲存：{path}", { path })`。
 *
 * 靜態的 index.html 不必改：`applyDom()` 會掃描文字節點與 title／placeholder／aria-label，
 * 以「去掉前後空白、連續空白合成一格」後的文字查表替換（原文記在 WeakMap，可重複套用）。
 *
 * 翻譯表放在 `src/locales/<語言>.ts`（鍵 = 繁體中文原文）。`npm run i18n:check` 會列出尚未翻譯的字串。
 */
import { LOCALES, type Lang } from "./locales";

export type { Lang };
const KEY = "label-printer.lang";
export const DEFAULT_LANG: Lang = "zh-TW";

let lang: Lang = DEFAULT_LANG;

export function currentLang(): Lang {
  return lang;
}

export function isLang(v: unknown): v is Lang {
  return typeof v === "string" && v in LOCALES;
}

/** 依系統／瀏覽器語言挑一個支援的語言；都對不上就用英文。 */
export function detectLang(prefs?: readonly string[]): Lang {
  let list: readonly string[] = prefs ?? [];
  if (!prefs) {
    try { list = navigator.languages?.length ? navigator.languages : [navigator.language]; } catch { list = []; }
  }
  for (const raw of list) {
    const s = (raw || "").toLowerCase();
    if (!s) continue;
    if (s.startsWith("zh")) {
      // zh-CN／zh-SG／zh-Hans → 簡體；其餘（zh-TW／zh-HK／zh-MO／zh-Hant／zh）→ 繁體
      return /^zh-(cn|sg)\b|hans/.test(s) ? "zh-CN" : "zh-TW";
    }
    const base = s.split("-")[0];
    if (base === "en" || base === "es" || base === "de" || base === "ja" || base === "ko") return base;
  }
  return "en";
}

/** 已記住的選擇優先；第一次啟動（沒有記錄）才依系統語言。 */
export function loadLang(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (isLang(v)) return v;
  } catch { /* 讀不到就依系統語言 */ }
  return detectLang();
}

export function saveLang(l: Lang): void {
  try { localStorage.setItem(KEY, l); } catch { /* 記不住也沒關係 */ }
}

export function setLang(l: Lang): void {
  lang = l;
  document.documentElement.lang = l;
}

/** 翻譯。`zh-TW` 直接回傳原文（只做佔位替換）。 */
export function t(source: string, params?: Record<string, string | number>): string {
  const table = LOCALES[lang];
  let s = (table && table[source]) || source;
  if (params) s = s.replace(/(?<!\{)\{(\w+)\}(?!\})/g, (m, k: string) => (k in params ? String(params[k]) : m));
  return s;
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
// data-ready／data-hint：CSS 偽元素用 attr() 顯示的文字（偽元素本身無法翻譯）
const ATTRS = ["title", "placeholder", "aria-label", "data-ready", "data-hint"] as const;
const textOrig = new WeakMap<Text, string>();
const attrOrig = new WeakMap<Element, Record<string, string>>();

function translateText(node: Text): void {
  let orig = textOrig.get(node);
  if (orig === undefined) {
    orig = node.data;
    if (!/\S/.test(orig)) return;
    textOrig.set(node, orig);
  }
  const key = norm(orig);
  const out = t(key);
  // 保留前後的空白（排版用），只換中間的文字
  const lead = /^\s*/.exec(orig)![0];
  const trail = /\s*$/.exec(orig)![0];
  node.data = out === key ? orig : lead + out + trail;
}

function translateAttrs(el: Element): void {
  let saved = attrOrig.get(el);
  for (const a of ATTRS) {
    const cur = el.getAttribute(a);
    if (cur === null) continue;
    if (!saved) { saved = {}; attrOrig.set(el, saved); }
    if (saved[a] === undefined) saved[a] = cur;
    el.setAttribute(a, t(norm(saved[a])) === norm(saved[a]) ? saved[a] : t(norm(saved[a])));
  }
}

const htmlOrig = new WeakMap<Element, string>();

/** 含行內標記（<b>、<code>）的整段文字：元素標 `data-i18n-html`，以 innerHTML 為鍵、翻譯也是 HTML（只收自己的翻譯表）。 */
function translateHtml(el: Element): void {
  let orig = htmlOrig.get(el);
  if (orig === undefined) { orig = el.innerHTML; htmlOrig.set(el, orig); }
  const key = norm(orig);
  const out = t(key);
  el.innerHTML = out === key ? orig : out;
}

function walk(node: Node): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const p = (node as Text).parentElement;
    // 授權全文與 <script>／<style> 不翻譯
    if (p && p.id !== "lic-text" && p.tagName !== "SCRIPT" && p.tagName !== "STYLE") translateText(node as Text);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  translateAttrs(el);
  if (el.hasAttribute("data-i18n-html")) { translateHtml(el); return; }
  for (const c of Array.from(el.childNodes)) walk(c);
}

/** 掃描（子）樹，把靜態文字換成目前語言。可重複呼叫。 */
export function applyDom(root: ParentNode = document.body): void {
  walk(root as Node);
  document.title = t(norm(document.title));
}

// 載入時就決定語言，讓其他模組在最上層呼叫 t() 也拿到正確的語言
setLang(loadLang());

/** 只標記「這個字串要翻譯」、不立刻翻（用在模組最上層的常數表；使用時再 `t(...)`）。 */
export const N = (source: string): string => source;
