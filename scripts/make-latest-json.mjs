// 產生自動更新用的 latest.json（Tauri updater 讀取）。由 GitHub Actions 在建置完成後呼叫：
//   node scripts/make-latest-json.mjs <版本> <標籤> <說明檔> <輸出資料夾>
// 需要 <輸出資料夾> 內已有 `Label Printer_<版本>_x64-setup.exe` 與對應的 `.sig`（建置時以更新金鑰簽出）。
// 注意：GitHub 會把上傳檔名裡的空白換成「.」，所以網址用 `Label.Printer_...`（發布後由 workflow 再核對一次）。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [ver, tag, notesFile, dir] = process.argv.slice(2);
if (!ver || !tag || !notesFile || !dir) { console.error("用法：make-latest-json.mjs <版本> <標籤> <說明檔> <輸出資料夾>"); process.exit(2); }
const name = `Label Printer_${ver}_x64-setup.exe`;
const signature = readFileSync(join(dir, `${name}.sig`), "utf8").trim();
if (!signature) { console.error("簽章檔是空的"); process.exit(1); }
const repo = process.env.GITHUB_REPOSITORY || "mixneko/Label-Printer";
const json = {
  version: ver,
  notes: readFileSync(notesFile, "utf8").trim(),
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: `https://github.com/${repo}/releases/download/${tag}/${name.replaceAll(" ", ".")}`,
    },
  },
};
writeFileSync(join(dir, "latest.json"), JSON.stringify(json, null, 2) + "\n");
console.log("已產生 latest.json →", json.platforms["windows-x86_64"].url);
