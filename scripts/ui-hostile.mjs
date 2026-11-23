// 安全回歸測試：開啟「惡意構造的標籤檔」時，不能執行腳本、不能對外連線、不能卡死。
//   node scripts/ui-hostile.mjs [輸出資料夾=.tools]
// 只在隔離的 Edge 裡跑（模擬 Tauri），不會寫入或讀取你電腦上的任何真實檔案；信標伺服器只綁 127.0.0.1。
import http from "node:http";
import { launch } from "./_cdp.mjs";

// 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
const hits = [];
const beacon = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, { "Content-Type": "image/png", "Access-Control-Allow-Origin": "*" }); res.end(PNG); });
await new Promise((r) => beacon.listen(0, "127.0.0.1", r));
const port = beacon.address().port;

const XSS = '<img src=x onerror="window.__pwn=(window.__pwn||0)+1"><script>window.__pwn=99</script>';
const label = {
  version: 1,
  tplWmm: 20000, // 荒謬的標籤寬度（會不會把畫布撐爆）
  tplHmm: 30,
  elements: [
    { kind: "text", x: 10, y: 10, content: XSS + "{{" + XSS + "}}", fontFamily: XSS, fontSize: 24, label: XSS },
    { kind: "text", x: 10, y: 60, content: "big", fontFamily: "Arial", fontSize: 4000 },
    { kind: "qr", x: 10, y: 10, content: "A".repeat(20000), label: XSS },
    { kind: "barcode", x: 10, y: 10, content: "X".repeat(5000), format: "CODE128", label: XSS },
    { kind: "image", x: 0, y: 0, src: `http://127.0.0.1:${port}/beacon.png` },
  ],
};

const MOCK = `(() => {
  window.__files = { 'C:\\\\evil.lpxl': ${JSON.stringify(JSON.stringify(label))} };
  window.__writes = [];
  window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd, args) => {
    if (cmd === 'startup_file') return 'C:\\\\evil.lpxl';
    if (cmd === 'read_text_file') return window.__files[args.path];
    if (cmd === 'write_text_file' || cmd === 'write_binary_file') { window.__writes.push([cmd, args.path]); return null; }
    if (cmd === 'list_printers') return ['TSC']; if (cmd === 'list_fonts') return ['Arial'];
    return null; } };
  localStorage.setItem('lp.start', '0');
})();`;

const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "hostile" });
const { ev, sleep, check } = t;
await sleep(2500);

const t0 = Date.now();
const alive = await ev("1+1");
check("畫面沒有被卡死（2 秒內可回應）", alive === 2 && Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
check("惡意 HTML／script 沒有被執行（window.__pwn 未定義）", (await ev("typeof window.__pwn")) === "undefined", await ev("String(window.__pwn)"));
check("頁面上沒有被注入的 <img src=x>／<script>", (await ev("document.querySelectorAll('img[src=x], body script:not([type=module])').length")) === 0);
console.log("  開啟結果狀態列：", await ev("document.getElementById('status')?.textContent ?? ''"));
const status = await ev("document.getElementById('status')?.textContent ?? ''");
check("含遠端圖片網址的標籤檔被拒絕開啟，並說明原因", /外部的圖片網址/.test(status), status);
check("信標伺服器沒有收到任何請求（開啟標籤檔不會對外連線）", hits.length === 0, JSON.stringify(hits));
const savedW = await ev("JSON.parse(localStorage.getItem('label-printer.settings') || '{}').tplWmm");
check("標籤尺寸 20000 mm 被夾到上限 1000 mm，不會存進設定", savedW === 1000, String(savedW));
check("沒有任何寫檔命令被觸發（開啟檔案不該寫東西）", (await ev("window.__writes.length")) === 0);

// ---- 內容安全政策（CSP）：就算有人設法在頁面裡注入東西，也跑不起來、連不出去 ----
const blockedInline = await ev(`(async () => {
  window.__csp = 0;
  const s = document.createElement('script'); s.textContent = 'window.__csp = 1'; document.body.appendChild(s);
  await new Promise(r => setTimeout(r, 100));
  return window.__csp;
})()`);
check("CSP：頁面內動態插入的行內 <script> 不會執行", blockedInline === 0, String(blockedInline));
const fetchRes = await ev(`fetch('http://127.0.0.1:${port}/csp-fetch').then(() => 'allowed').catch(() => 'blocked')`);
check("CSP：頁面不能對任意位址發出 fetch", fetchRes === "blocked", fetchRes);
await ev(`(() => { const i = new Image(); i.src = 'http://127.0.0.1:${port}/csp-img'; })()`);
await sleep(500);
check("CSP：頁面不能載入遠端圖片", !hits.some((h) => h.includes("csp-img")), JSON.stringify(hits));
await t.finish();
beacon.close();
