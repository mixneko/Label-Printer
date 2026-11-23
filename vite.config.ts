import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

// 開發伺服器也送出和正式版同一份內容安全政策（tauri.conf.json 的 devCsp），
// 所以所有 UI 測試都是在 CSP 底下跑的：哪裡違反（行內腳本、外部連線、eval…）會直接壞掉，不會等到正式版才發現。
const conf = JSON.parse(readFileSync(new URL("./src-tauri/tauri.conf.json", import.meta.url), "utf8")) as { app: { security: { devCsp: string } } };

// Tauri 開發伺服器設定：固定 port，並避免清除終端機訊息
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    headers: { "Content-Security-Policy": conf.app.security.devCsp },
    // Rust 編譯時會不斷寫入 src-tauri/target，監看它會造成 EBUSY 錯誤
    watch: { ignored: ["**/src-tauri/**", "**/.tools/**"] },
  },
});
