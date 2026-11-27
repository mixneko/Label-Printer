// 打包 exe 與安裝檔：依版本號自動選模式。
//   npm run dist
// 測試版（版本號帶 -a、-b…）用 Cargo 的 fast 設定檔（不做整體最佳化、只重編改過的部分），快很多，
// 輸出在 src-tauri/target/fast/；正式版維持 release，輸出在 src-tauri/target/release/。
// 多出來的參數會原樣交給 tauri build。
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const test = version.includes("-");
const args = [resolve("node_modules/@tauri-apps/cli/tauri.js"), "build", ...process.argv.slice(2)];
if (test) args.push("--", "--profile", "fast");
console.log(`版本 ${version}：${test ? "測試版（快速模式，輸出在 target/fast）" : "正式版（完整最佳化，輸出在 target/release）"}`);
const r = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(r.status ?? 1);
