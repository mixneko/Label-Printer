// 校正標籤：外框、四邊每 1 mm 的刻度、中心十字與說明文字。
// 印出後從外框與刻度就能看出位置偏了幾 mm，再到「列印品質與出紙」調整「位置左右／上下」。
import { DOTS_PER_MM, mmToDots } from "./settings";
import type { ElementData } from "./elements";
import { t as tr } from "./i18n";

export function calibrationElements(wmm: number, hmm: number): ElementData[] {
  const w = mmToDots(wmm), h = mmToDots(hmm), D = DOTS_PER_MM;
  const base = { rotation: 0, scaleX: 1, scaleY: 1 };
  const els: ElementData[] = [];
  const bar = (x: number, y: number, bw: number, bh: number, label: string) =>
    els.push({ kind: "rect", x, y, ...base, width: bw, height: bh, filled: true, strokeWidth: 1, label });
  const text = (x: number, y: number, content: string, size: number, label: string, bold = false) =>
    // 限制在固定寬度內、太長就自動縮小字級（英文、德文等譯文比中文長很多，不能讓它蓋到右邊的刻度）
    els.push({
      kind: "text", x, y, ...base, content, fontSize: size, bold, label,
      bounded: true, boxW: Math.max(40, w - x - 32), boxH: Math.round(size * 1.3), overflow: "shrink", minSize: 7, align: "left", valign: "middle",
    });

  // 外框：四邊都要完整出現。哪一邊被切掉或離紙邊很遠，就是往那個方向偏了
  els.push({ kind: "rect", x: 1, y: 1, ...base, width: w - 2, height: h - 2, filled: false, strokeWidth: 2, label: tr("外框") });

  // 刻度：每 1 mm 一格，每 5 mm 較長，每 10 mm 最長；四邊都有
  const tick = (mm: number) => (mm % 10 === 0 ? 20 : mm % 5 === 0 ? 12 : 6);
  for (let mm = 0; mm <= wmm; mm++) {
    const x = Math.min(w - 2, Math.max(0, Math.round(mm * D) - 1)), t = tick(mm);
    bar(x, 0, 2, t, tr("上刻度 {mm}", { mm }));
    bar(x, h - t, 2, t, tr("下刻度 {mm}", { mm }));
  }
  for (let mm = 0; mm <= hmm; mm++) {
    const y = Math.min(h - 2, Math.max(0, Math.round(mm * D) - 1)), t = tick(mm);
    bar(0, y, t, 2, tr("左刻度 {mm}", { mm }));
    bar(w - t, y, t, 2, tr("右刻度 {mm}", { mm }));
  }
  const num = (x: number, y: number, mm: number, label: string) =>
    els.push({ kind: "text", x, y, ...base, content: String(mm), fontSize: 16, bold: false, label });
  for (let mm = 10; mm < wmm; mm += 10) num(mm * D - 9, 22, mm, tr("上數字 {mm}", { mm }));
  for (let mm = 10; mm < hmm; mm += 10) num(24, mm * D - 9, mm, tr("左數字 {mm}", { mm }));

  // 中心十字
  bar(w / 2 - 12, h / 2 - 1, 24, 2, tr("十字橫"));
  bar(w / 2 - 1, h / 2 - 12, 2, 24, tr("十字直"));

  // 說明文字（尺寸太小放不下時略過，只留外框與刻度）
  if (w >= 360 && h >= 200) {
    const cx = 56;
    text(cx, 42, tr("校正標籤 {wmm}×{hmm} mm", { wmm, hmm }), 24, tr("標題"), true);
    text(cx, 70, tr("① 四邊外框都要完整、粗細一致"), 16, tr("說明1"));
    text(cx, 88, tr("② 刻度 0 ＝紙邊；用尺量偏移量"), 16, tr("說明2"));
    text(cx, 146, tr("偏左→「位置左右」填正數（往右移）"), 16, tr("說明4"));
    text(cx, 168, tr("偏上→「位置上下」填正數（往下移）"), 16, tr("說明5"));
  }
  return els;
}
