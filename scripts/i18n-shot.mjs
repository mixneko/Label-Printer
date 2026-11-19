import { launch } from "./_cdp.mjs";
const lang = process.argv[2] || "en";
const MOCK = `localStorage.setItem('label-printer.lang','${lang}'); window.__TAURI_INTERNALS__ = { transformCallback: () => 0, invoke: async (cmd) => {
  if (cmd === 'list_printers') return ['TSC']; if (cmd === 'list_fonts') return ['Arial'];
  return null; } };`;
const t = await launch({ outDir: ".tools", mock: MOCK, prefix: "shot", width: 1280, height: 800 });
await t.ev("document.querySelector('#add-text').click()"); await t.sleep(400);
await t.shot("lang-" + lang);
await t.ev("document.getElementById('menu-tools').click()"); await t.sleep(300);
await t.shot("lang-" + lang + "-menu");
await t.finish();
