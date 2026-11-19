// 檢查翻譯：列出程式與 index.html 中所有「要翻譯的字串」（鍵 = 繁體中文原文），
// 並回報各語言缺少的翻譯、多餘的鍵、以及 {佔位} 與原文不一致的項目。
//   node scripts/i18n-check.mjs          檢查（缺翻譯只警告；佔位不一致或有多餘鍵才算失敗）
//   node scripts/i18n-check.mjs --list   印出全部鍵
//   node scripts/i18n-check.mjs --strict 缺翻譯也算失敗
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const HAN = /[\u3000-\u303f\u4e00-\u9fff]/; // 含 CJK 標點（例如「、」）
const norm = (s) => s.replace(/&#10;/g, " ").replace(/\s+/g, " ").trim();
const keys = new Map(); // key → 來源

function add(key, where) {
  if (!HAN.test(key)) return; // 沒有中文就不需要翻（例如純英文縮寫、格式碼）
  if (!keys.has(key)) keys.set(key, where);
}

// 1) TypeScript：t("…")、tr("…")、N("…")，字串可用 " 或 ` （含 ${ } 者視為違規，請改用 {佔位}）
const CALL = new RegExp(
  "(?<![\\w.$])(?:t|tr|N)\\(\\s*(\"(?:[^\"\\\\\\n]|\\\\.)*\"|`(?:[^`\\\\]|\\\\.)*`)", "g");
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "locales" ? [] : walk(join(dir, e.name))) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []);
}
const problems = [];
for (const f of walk(join(root, "src"))) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(CALL)) {
    let lit = m[1];
    if (lit[0] === "`" && lit.includes("${")) { problems.push(`${f}: 模板字串含 \${} 無法翻譯：${lit.slice(0, 60)}`); continue; }
    const v = lit[0] === '"' ? JSON.parse(lit) : lit.slice(1, -1);
    add(v, f.slice(root.length));
  }
}

// 2) index.html：文字節點與 title／placeholder／aria-label（i18n.ts 的 applyDom 以同樣的正規化查表）
const html = readFileSync(join(root, "index.html"), "utf8")
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/<script[\s\S]*?<\/script>/g, "")
  .replace(/<style[\s\S]*?<\/style>/g, "");
// 含行內標記的整段（data-i18n-html）：以 innerHTML 為鍵，不再逐個文字節點抽取
const blocks = [...html.matchAll(/<(\w+)\b[^>]*\bdata-i18n-html\b[^>]*>([\s\S]*?)<\/\1>/g)];
for (const m of blocks) add(norm(m[2]), "index.html (html)");
const rest = blocks.reduce((h, m) => h.replace(m[0], ""), html);
for (const m of rest.matchAll(/>([^<>]+)</g)) add(norm(m[1]), "index.html");
for (const m of rest.matchAll(/\s(?:title|placeholder|aria-label|data-ready|data-hint)="([^"]*)"/g)) add(norm(m[1]), "index.html");

if (process.argv.includes("--list")) {
  for (const [k, w] of keys) console.log(`${w}\t${k}`);
  process.exit(0);
}

// 3) 對照各語言翻譯表
const { LOCALES } = await import(pathToFileURL(join(root, "src/locales/index.ts")).href).catch(async () => {
  // Node 不能直接讀 .ts：以 esbuild（vite 內建）轉成暫存 .mjs
  const { buildSync } = await import("esbuild");
  const out = join(root, "node_modules/.cache-i18n.mjs");
  buildSync({ entryPoints: [join(root, "src/locales/index.ts")], bundle: true, format: "esm", outfile: out, logLevel: "silent" });
  return import(pathToFileURL(out).href);
});
const ph = (s) => [...s.replace(/\{\{.*?\}\}/g, "").matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
let fail = problems.length > 0;
problems.forEach((p) => console.log("✗ " + p));
console.log(`字串總數：${keys.size}`);
for (const [lang, table] of Object.entries(LOCALES)) {
  if (lang === "zh-TW") continue;
  const missing = [...keys.keys()].filter((k) => !table[k]);
  const extra = Object.keys(table).filter((k) => !keys.has(k));
  const badPh = Object.entries(table).filter(([k, v]) => keys.has(k) && ph(k) !== ph(v));
  console.log(`${lang}：已翻 ${keys.size - missing.length} / ${keys.size}，缺 ${missing.length}，多餘 ${extra.length}，佔位不一致 ${badPh.length}`);
  extra.slice(0, 10).forEach((k) => console.log(`   多餘：${k}`));
  badPh.slice(0, 10).forEach(([k, v]) => console.log(`   佔位不一致：${k}  →  ${v}`));
  if (extra.length || badPh.length) fail = true;
  if (process.argv.includes("--strict") && missing.length) fail = true;
}
process.exit(fail ? 1 : 0);
