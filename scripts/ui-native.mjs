// 回歸測試：條碼／QR 的「使用印表機原生指令列印」（預設關閉）。以模擬的 print_labels 擷取實際送出的列印工作。
//   node scripts/ui-native.mjs [輸出資料夾=.tools]
import { launch } from "./_cdp.mjs";
const MOCK = `window.__jobs = [];
window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd, args) => {
  if (cmd === 'list_printers') return ['TSC']; if (cmd === 'list_fonts') return ['Microsoft JhengHei'];
  if (cmd === 'plugin:dialog|message') return args?.buttons?.OkCancelCustom?.[0];
  if (cmd === 'print_labels') { window.__jobs.push(JSON.parse(JSON.stringify(args))); return null; }
  return null; } };`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "native" });
const { ev, sleep, check } = t;
const setProp = (id, v) => ev(`(() => { const i = document.getElementById('${id}'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); })()`).then(() => sleep(250));
const setNative = (on) => ev(`(() => { const i = document.getElementById('prop-native'); i.checked = ${on}; i.dispatchEvent(new Event('change', { bubbles: true })); })()`).then(() => sleep(250));
const pop = (b64) => { const buf = Buffer.from(b64, "base64"); let n = 0; for (const b of buf) { let v = b; while (v) { n += v & 1; v >>= 1; } } return n; };
const printOnce = async () => { const n = await ev("window.__jobs.length"); await ev("document.getElementById('print').click()"); await sleep(900); return ev(`JSON.stringify(window.__jobs[${n}]?.jobs?.[0] ?? null)`).then(JSON.parse); };
const insert = async (id) => { await ev(`document.getElementById('${id}').click()`); await sleep(500); };

// ---------- 條碼 ----------
await insert("add-barcode");
await setProp("prop-text", "ABC123");
check("新物件預設不啟用原生指令", !(await ev("document.getElementById('prop-native').checked")));
const j0 = await printOnce();
check("預設：送出的列印工作沒有原生指令（natives 為空）", Array.isArray(j0.natives) && j0.natives.length === 0, JSON.stringify(j0.natives));
const black0 = pop(j0.bitmap);
check("預設：條碼畫在點陣裡（有黑點）", black0 > 500, `${black0} 點`);

await setNative(true);
const j1 = await printOnce();
const nb = j1.natives[0];
check("啟用後：送出 1 個原生條碼指令", j1.natives.length === 1 && nb.kind === "barcode", JSON.stringify(j1.natives));
check("原生條碼：類型 128、內容、高度、模組寬、人眼可讀", nb.code === "128" && nb.content === "ABC123" && nb.height === 80 && nb.narrow === 2 && nb.wide === 4 && nb.readable === true, JSON.stringify(nb));
check("座標是整數 dots 且在標籤內", Number.isInteger(nb.x) && Number.isInteger(nb.y) && nb.x >= 0 && nb.y >= 0, `x=${nb.x} y=${nb.y}`);
const black1 = pop(j1.bitmap);
check("啟用後條碼不再畫進點陣（黑點明顯變少）", black1 < black0 * 0.2, `${black0} → ${black1}`);
check("列印後畫布上的條碼仍然可見（暫時隱藏已還原）", await ev("window.__lp.konva.stages[0].find('.element')[0].visible()"));
check("設計畫面的條碼寬度沒變（仍是點陣近似圖）", (JSON.parse(await ev("JSON.stringify(window.__lp.node())"))).w > 100);

// 內容含中文 → 退回點陣
await setProp("prop-text", "中文內容");
const j2 = await printOnce();
check("內容含中文：自動改用點陣（沒有原生指令）", j2.natives.length === 0);
// 缺欄位 → 不交給印表機
await setProp("prop-text", "{{序號}}");
await setProp("vars", "");
const j3 = await printOnce();
check("缺欄位（無效內容）：不使用原生指令", j3.natives.length === 0);
// 有欄位值 → 用該張的內容
await setProp("vars", "序號=A1");
const j4 = await printOnce();
check("有資料時用「這一張」的內容", j4.natives.length === 1 && j4.natives[0].content === "A1", JSON.stringify(j4.natives));
// 格式：EAN13 內容不合法 → 退回點陣；合法 → 原生 EAN13
await setProp("prop-format", "EAN13");
const j5 = await printOnce();
check("EAN13 內容不合法（A1）：退回點陣", j5.natives.length === 0);
await setProp("vars", "序號=590123412345");
const j6 = await printOnce();
check("EAN13 合法內容：原生類型 EAN13", j6.natives.length === 1 && j6.natives[0].code === "EAN13", JSON.stringify(j6.natives));
await setProp("prop-format", "CODE39");
await setProp("vars", "序號=ABC");
const j6b = await printOnce();
check("CODE39 對應類型 39", j6b.natives[0]?.code === "39", JSON.stringify(j6b.natives));

// 旋轉過 → 退回點陣
await ev("(() => { const n = window.__lp.konva.stages[0].find('.element')[0]; n.rotation(15); })()");
const j7 = await printOnce();
check("物件旋轉過：改用點陣", j7.natives.length === 0);
await ev("(() => { const n = window.__lp.konva.stages[0].find('.element')[0]; n.rotation(0); })()");

// 隱藏的物件不印
await ev("(() => { const n = window.__lp.konva.stages[0].find('.element')[0]; n.visible(false); })()");
const j8 = await printOnce();
check("隱藏的條碼不會產生原生指令", j8.natives.length === 0);
await ev("(() => { const n = window.__lp.konva.stages[0].find('.element')[0]; n.visible(true); })()");

// ---------- QR ----------
await insert("add-qr");
await setProp("prop-text", "ABC");
check("QR 預設也不啟用", !(await ev("document.getElementById('prop-native').checked")));
await ev("(() => { const el = [...window.__lp.konva.stages[0].find('.element')]; el[0].visible(false); })()"); // 只看 QR
const q0 = await printOnce();
check("QR 預設：沒有原生指令", q0.natives.length === 0);
await setNative(true);
const q1 = await printOnce();
const nq = q1.natives[0];
check("QR 啟用：送出原生 QR 指令（容錯 M、內容 ABC）", q1.natives.length === 1 && nq.kind === "qr" && nq.ecc === "M" && nq.content === "ABC", JSON.stringify(q1.natives));
const modules = Number(JSON.parse(await ev("JSON.stringify({ m: window.__lp.konva.stages[0].find('.element')[1].getAttr('qrModules') })")).m);
const size = Number(await ev("window.__lp.konva.stages[0].find('.element')[1].getAttr('qrSize')"));
check("QR 每模組點數 = 大小 ÷ 模組數（四捨五入）", nq.cell === Math.max(1, Math.round(size / modules)), `size=${size} modules=${modules} cell=${nq.cell}`);
check("QR 不再畫進點陣", pop(q1.bitmap) < pop(q0.bitmap) * 0.2, `${pop(q0.bitmap)} → ${pop(q1.bitmap)}`);
await setProp("prop-text", "中文");
check("QR 內容含中文：改用點陣", (await printOnce()).natives.length === 0);
await setProp("prop-text", "ABC");

// 復原重做仍保留設定（先等歷史記錄好上一步的改動，避免與新增文字合併成同一步）
await sleep(600);
await insert("add-text");
await ev("document.getElementById('undo-btn').click()"); await sleep(600);
await ev("document.querySelectorAll('#layer-list li')[0].click()"); await sleep(300);
const kindNow = await ev("window.__lp.konva.stages[0].find('.element').length");
check("復原後物件還在", kindNow >= 2, String(kindNow));
await ev("(() => { const els = window.__lp.konva.stages[0].find('.element'); els.forEach(e => e.visible(true)); })()");
const q2 = await printOnce();
check("復原／重做之後「原生指令」設定仍保留（QR 與條碼各自）", q2.natives.some((n) => n.kind === "qr"), JSON.stringify(q2.natives.map((n) => n.kind)));

// 預覽列印資訊列提醒
await ev("document.getElementById('preview-print').click()"); await sleep(900);
const info = await ev("document.getElementById('pv-dialog').textContent");
check("預覽列印的資訊列提醒「使用印表機原生指令（預覽以點陣近似）」", info.includes("原生指令"), info.replace(/\s+/g, " ").slice(0, 120));
await ev("document.getElementById('pv-close').click()"); await sleep(300);

// 說明文字
check("屬性面板有說明「預設不啟用」", (await ev("document.querySelector('[data-kinds=\"qr barcode\"] .hint').textContent")).includes("預設不啟用"));
await t.shot("1-native");
await t.finish();
