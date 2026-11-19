// UI 測試腳本共用：取得一個可用的 Vite 開發伺服器，並在結束時關閉。
//
// 設計重點（避免「背景 Vite 沒關乾淨」「依連接埠找行程強制停止」這類問題）：
// - 沒有指定 VITE_URL 時，由腳本自己啟動 Vite（挑一個空的連接埠），並且只關閉「自己啟動的那一個行程」。
// - 指定了 VITE_URL（例如由 scripts/ui-test.mjs 統一啟動一個給多支測試共用）時，直接使用，不啟動也不關閉。
// - 不使用背景工作，也不需要在外面另外開 `npx vite`。
// - 即使腳本中途出錯，結束時（process exit）也會關掉自己啟動的 Vite。
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 向作業系統要一個目前沒人使用的連接埠 */
export function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

export async function devServer() {
  if (process.env.VITE_URL) return { url: process.env.VITE_URL, stop: async () => {} };

  const port = await freePort();
  // 直接用 node 執行 vite 的進入點（不經過 npx / cmd 包裝），這樣只有一個行程，關閉時不會留下孤兒
  const child = spawn(process.execPath, [resolve("node_modules/vite/bin/vite.js"), "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const alive = () => child.exitCode === null && !child.killed;
  const stop = async () => {
    if (!alive()) return;
    const exited = new Promise((r) => child.once("exit", r));
    child.kill();
    await Promise.race([exited, sleep(5000)]);
  };
  process.once("exit", () => { try { if (alive()) child.kill(); } catch { /* 已經結束 */ } });

  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    if (!alive()) throw new Error("Vite 啟動失敗（行程已結束）");
    try { if ((await fetch(url)).ok) return { url, stop }; } catch { /* 還沒好，繼續等 */ }
    await sleep(500);
  }
  await stop();
  throw new Error("Vite 沒有在 30 秒內啟動");
}
