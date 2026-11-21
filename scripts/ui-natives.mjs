// 回歸測試：各印表機語言的「使用印表機原生指令列印」（TSPL 以外都是實驗性質）。
// 以模擬的 print_labels 擷取實際送出的列印工作：哪些物件改用原生指令、哪些退回點陣，以及「實驗中」標示（燒瓶圖示）。
//   node scripts/ui-natives.mjs [輸出資料夾=.tools]
import { launch } from "./_cdp.mjs";
const MOCK = `window.__jobs = [];
window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd, args) => {
  if (cmd === 'list_printers') return ['TSC']; if (cmd === 'list_fonts') return ['Arial'];
  if (cmd === 'print_labels') { window.__jobs.push(JSON.parse(JSON.stringify(args))); return null; }
  return null; } };`;
const t = await launch({ outDir: process.argv[2], mock: MOCK, prefix: "natives" });
const { ev, sleep, check } = t;
const setProp = (id, v) => ev(`(() => { const i = document.getElementById('${id}'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); })()`).then(() => sleep(250));
const setCheck = (id, on) => ev(`(() => { const i = document.getElementById('${id}'); i.checked = ${on}; i.dispatchEvent(new Event('change', { bubbles: true })); })()`).then(() => sleep(250));
const setLang = async (lang) => { await ev("document.getElementById('dlg-printer').showModal()"); await setProp("printer-lang", lang); await ev("document.getElementById('dlg-printer').close()"); await sleep(200); };
const printOnce = async () => { const n = await ev("window.__jobs.length"); await ev("document.getElementById('print').click()"); await sleep(900); return ev(`JSON.stringify(window.__jobs[${n}]?.jobs?.[0] ?? null)`).then(JSON.parse); };
const note = () => ev("(() => { const e = document.getElementById('native-exp'); return e.hidden ? '' : e.textContent; })()");
const kinds = (j) => j.natives.map((n) => n.kind + ":" + (n.code ?? n.ecc)).join(",");

// 準備：一個條碼（CODE128，顯示文字）+ 一個 QR；兩個都勾「使用原生指令」
await ev("document.getElementById('add-barcode').click()"); await sleep(400);
await setProp("prop-text", "ABC123"); await setCheck("prop-native", true);
await ev("document.getElementById('add-qr').click()"); await sleep(400);
await setProp("prop-text", "https://example.com/a"); await setCheck("prop-native", true);
// 兩個物件放在不同位置，避免重疊
await ev("(() => { const n = window.__lp.konva.stages[0].find('.element'); n[0].x(10); n[0].y(10); n[1].x(300); n[1].y(10); })()");

// ---- TSPL：維持原樣、沒有實驗標示 ----
await setLang("tspl");
let j = await printOnce();
check("TSPL：條碼與 QR 都用原生指令", kinds(j) === "barcode:128,qr:M", kinds(j));
check("TSPL：不顯示「實驗中」", (await note()) === "");

// ---- ZPL：條碼與 QR 都能用，顯示「實驗中」 ----
await setLang("zpl");
j = await printOnce();
check("ZPL：條碼與 QR 都用原生指令", kinds(j) === "barcode:128,qr:M", kinds(j));
check("原生項目帶有符號的整體高度 h（DPL 要用）", j.natives.every((n) => Number.isInteger(n.h) && n.h > 0), JSON.stringify(j.natives.map((n) => n.h)));
check("勾選原生指令時顯示「實驗中」（不再用表情符號）", (await note()).startsWith("實驗中") && !/[❗⚠]/.test(await note()), await note());
check("「實驗中」標示前面是 Lucide 燒瓶圖示", (await ev("document.querySelector('#native-exp svg use')?.getAttribute('href')")) === "#i-flask");
await t.shot("zpl-note");

// ---- EPL2：沒有 QR 指令 → QR 退回點陣、條碼用原生；選到 QR 時說明 ----
await setLang("epl");
j = await printOnce();
check("EPL2：只有條碼用原生指令，QR 退回點陣", kinds(j) === "barcode:128", kinds(j));
await ev("window.__lp.selectIdx([1])"); await sleep(300);
check("EPL2 選到 QR：說明沒有原生指令、仍以點陣列印（不是「實驗中」警示色）", (await note()).includes("仍以點陣列印") && !(await ev("document.getElementById('native-exp').classList.contains('warn')")), await note());

// ---- CPCL、DPL：條碼與 QR 都能用 ----
for (const l of ["cpcl", "dpl"]) {
  await setLang(l);
  j = await printOnce();
  check(`${l.toUpperCase()}：條碼與 QR 都用原生指令`, kinds(j) === "barcode:128,qr:M", kinds(j));
}

// ---- SBPL：沒有 QR；Code128 要可讀文字 → 退回點陣；不要可讀文字 → 原生；EAN13 要可讀文字 → 原生 ----
await setLang("sbpl");
j = await printOnce();
check("SBPL：QR 退回點陣；Code128 有人眼可讀文字也退回點陣（手冊沒有這個指令）", j.natives.length === 0, kinds(j));
await ev("window.__lp.selectIdx([0])"); await sleep(300);
await setCheck("prop-showtext", false);
j = await printOnce();
check("SBPL：Code128 不顯示文字 → 用原生指令", kinds(j) === "barcode:128", kinds(j));
await setProp("prop-format", "EAN13"); await setProp("prop-text", "590123412345"); await setCheck("prop-showtext", true);
j = await printOnce();
check("SBPL：EAN13 要人眼可讀文字 → 用原生指令（說明字體）", kinds(j) === "barcode:EAN13" && j.natives[0].readable === true, kinds(j));

// ---- 一般印表機不會走這條路；回到 TSPL 一切如常 ----
await setLang("tspl");
await setProp("prop-format", "CODE128"); await setProp("prop-text", "ABC123");
j = await printOnce();
check("換回 TSPL：又都是原生指令，且「實驗中」消失", kinds(j) === "barcode:128,qr:M" && (await note()) === "", kinds(j));
await t.finish();
