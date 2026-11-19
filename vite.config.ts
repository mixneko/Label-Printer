import { defineConfig } from "vite";

// Tauri 開發伺服器設定：固定 port，並避免清除終端機訊息
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Rust 編譯時會不斷寫入 src-tauri/target，監看它會造成 EBUSY 錯誤
    watch: { ignored: ["**/src-tauri/**", "**/.tools/**"] },
  },
});
