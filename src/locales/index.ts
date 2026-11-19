import { en } from "./en";
import { zhCN } from "./zh-CN";
import { es } from "./es";
import { de } from "./de";
import { ja } from "./ja";
import { ko } from "./ko";

/** 各語言的翻譯表：鍵 = 繁體中文原文（見 ../i18n.ts）。zh-TW 是原文本身，不需要表。 */
export type Lang = "zh-TW" | "zh-CN" | "en" | "es" | "de" | "ja" | "ko";

export const LANG_NAMES: Record<Lang, string> = {
  "zh-TW": "繁體中文",
  "zh-CN": "简体中文",
  en: "English",
  es: "Español",
  de: "Deutsch",
  ja: "日本語",
  ko: "한국어",
};

export type Table = Record<string, string>;

// 缺的字串會退回繁體中文原文（新增語言時可先放空表）。
export const LOCALES: Record<Lang, Table> = {
  "zh-TW": {},
  "zh-CN": zhCN,
  en,
  es,
  de,
  ja,
  ko,
};
