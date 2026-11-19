// 產生 src/licenses.txt：執行時期會打包進程式的第三方套件（npm 的 dependencies 與 Rust 的一般相依）授權清單與授權全文。
//   . .\dev-env.ps1; npm run licenses
// 相依套件變動（升級、新增）後要重新執行並提交 src/licenses.txt。
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const root = process.cwd();
const entries = []; // { eco, name, version, license, repo, text }

// ---------- npm：從 dependencies 往下走（只收執行時期相依，不含 devDependencies） ----------
const pkgJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const seen = new Set();
function findPkgDir(name, from) {
  let dir = from;
  while (true) {
    const p = join(dir, "node_modules", name);
    if (existsSync(join(p, "package.json"))) return p;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}
function licenseText(dir) {
  const f = readdirSync(dir).find((n) => /^(licen[sc]e|copying|notice)(\.|$)/i.test(n));
  return f ? readFileSync(join(dir, f), "utf8").trim() : "";
}
function walk(name, from) {
  const dir = findPkgDir(name, from);
  if (!dir || seen.has(dir)) return;
  seen.add(dir);
  const j = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const lic = typeof j.license === "string" ? j.license : j.license?.type ?? (j.licenses ?? []).map((l) => l.type).join(" OR ");
  entries.push({ eco: "npm", name: j.name, version: j.version, license: lic || "UNKNOWN", repo: (typeof j.repository === "string" ? j.repository : j.repository?.url) ?? j.homepage ?? "", text: licenseText(dir) });
  for (const d of Object.keys(j.dependencies ?? {})) walk(d, dir);
}
for (const d of Object.keys(pkgJson.dependencies ?? {})) walk(d, root);

// ---------- Rust：只收一般相依（不含 dev / build 專用） ----------
const meta = JSON.parse(execFileSync("cargo", ["metadata", "--manifest-path", "src-tauri/Cargo.toml", "--format-version", "1", "--filter-platform", "x86_64-pc-windows-msvc"], { maxBuffer: 1 << 28, encoding: "utf8" }));
const byId = new Map(meta.packages.map((p) => [p.id, p]));
const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
const rootId = meta.resolve.root;
const normal = new Set();
(function visit(id) {
  if (normal.has(id)) return;
  normal.add(id);
  for (const d of nodes.get(id).deps) if (d.dep_kinds.some((k) => k.kind === null)) visit(d.pkg);
})(rootId);
normal.delete(rootId);
for (const id of normal) {
  const p = byId.get(id);
  const dir = dirname(p.manifest_path);
  let text = "";
  const files = readdirSync(dir).filter((n) => /^(licen[sc]e|copying|unlicense|notice)/i.test(n)).sort();
  text = files.map((n) => readFileSync(join(dir, n), "utf8").trim()).join("\n\n----\n\n");
  entries.push({ eco: "rust", name: p.name, version: p.version, license: p.license ?? p.license_file ?? "UNKNOWN", repo: p.repository ?? "", text });
}

entries.sort((a, b) => a.eco.localeCompare(b.eco) || a.name.localeCompare(b.name));

// ---------- 輸出：授權全文以雜湊去重（同樣的全文只印一次，各套件指向它） ----------
const texts = new Map(); // hash -> { n, text }
const refOf = (t) => {
  if (!t) return 0;
  const h = createHash("sha1").update(t.replace(/\s+/g, " ")).digest("hex");
  if (!texts.has(h)) texts.set(h, { n: texts.size + 1, text: t });
  return texts.get(h).n;
};
const rows = entries.map((e) => ({ ...e, ref: refOf(e.text) }));

let out = "Label Printer 第三方授權聲明\n";
out += "本程式使用下列開放原始碼套件。各套件的版權屬於其作者，依其授權條款散布。\n";
out += `（共 ${rows.length} 個；由 scripts/gen-licenses.mjs 自動產生，內容為執行時期會打包進程式的套件。）\n\n`;
out += "========== 套件清單 ==========\n\n";
for (const r of rows) {
  out += `${r.name} ${r.version}  [${r.eco === "npm" ? "前端" : "Rust"}]\n  授權：${r.license}\n`;
  if (r.repo) out += `  來源：${r.repo.replace(/^git\+/, "")}\n`;
  out += r.ref ? `  授權全文：見下方 #${r.ref}\n\n` : "  授權全文：套件未附檔，請依上列授權識別碼（SPDX）查閱標準條文\n\n";
}
out += "\n========== 授權全文 ==========\n";
for (const { n, text } of texts.values()) {
  const users = rows.filter((r) => r.ref === n).map((r) => r.name);
  out += `\n---------- #${n}（${users.length > 6 ? users.slice(0, 6).join("、") + ` 等 ${users.length} 個套件` : users.join("、")}）----------\n\n${text}\n`;
}
writeFileSync(join(root, "src", "licenses.txt"), out, "utf8");
const missing = rows.filter((r) => !r.ref).map((r) => `${r.name}(${r.license})`);
console.log(`已產生 src/licenses.txt：${rows.length} 個套件、${texts.size} 份授權全文、${(out.length / 1024).toFixed(0)} KB`);
if (missing.length) console.log(`沒有附授權檔的套件 ${missing.length} 個：${missing.join(", ")}`);
const lic = {};
for (const r of rows) lic[r.license] = (lic[r.license] ?? 0) + 1;
console.log(lic);
