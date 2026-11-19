/**
 * 對齊線：拖曳物件時，靠近標籤邊緣／中心線，或其他物件的邊緣／中心線時，自動吸附並畫出粉紅色的輔助線。
 * 按住 Alt 拖曳可暫時不吸附；「檢視 → 對齊線」可整個關閉（設定會記住）。
 * 輔助線是圖層上名稱為 "guide" 的暫時物件（不是 "element"），拖曳結束就移除，不會存檔或列印。
 */
import Konva from "konva";
import { bbox } from "./arrange";

const KEY = "label-printer.guides";
const THRESHOLD_PX = 6; // 距離（畫面像素）在這個範圍內才吸附
const COLOR = "#ff2d95";

let enabled = (() => {
  try { return localStorage.getItem(KEY) !== "off"; } catch { return true; }
})();

export const guidesEnabled = (): boolean => enabled;
export function setGuidesEnabled(v: boolean): void {
  enabled = v;
  try { localStorage.setItem(KEY, v ? "on" : "off"); } catch { /* 記不住也沒關係 */ }
}

interface Cand { v: number; from: number; to: number } // 一條線：位置 v、延伸範圍 from~to

export function clearGuides(layer: Konva.Layer): void {
  layer.find(".guide").forEach((g) => g.destroy());
}

/** 掛上拖曳時的對齊線；layer 重建時要重新呼叫 */
export function attachGuides(layer: Konva.Layer, labelSize: () => { w: number; h: number }, zoom: () => number): void {
  layer.on("dragmove.guides", (e) => {
    const n = e.target;
    if (!(n instanceof Konva.Shape) || !n.hasName("element")) return;
    clearGuides(layer);
    if (!enabled || (e.evt as MouseEvent | undefined)?.altKey) return;

    const { w, h } = labelSize();
    const tol = THRESHOLD_PX / zoom();
    const xs: Cand[] = [0, w / 2, w].map((v) => ({ v, from: 0, to: h }));
    const ys: Cand[] = [0, h / 2, h].map((v) => ({ v, from: 0, to: w }));
    for (const o of layer.find<Konva.Shape>(".element")) {
      if (o === n || !o.visible()) continue;
      const r = bbox(o, layer);
      for (const v of [r.x, r.x + r.width / 2, r.x + r.width]) xs.push({ v, from: r.y, to: r.y + r.height });
      for (const v of [r.y, r.y + r.height / 2, r.y + r.height]) ys.push({ v, from: r.x, to: r.x + r.width });
    }

    const nearest = (mine: number[], cands: Cand[]): number => {
      let best = Infinity;
      for (const m of mine) for (const c of cands) if (Math.abs(c.v - m) < Math.abs(best)) best = c.v - m;
      return Math.abs(best) <= tol ? best : 0;
    };
    const edges = (r: { x: number; y: number; width: number; height: number }) => ({
      mx: [r.x, r.x + r.width / 2, r.x + r.width], my: [r.y, r.y + r.height / 2, r.y + r.height],
    });
    let r = bbox(n, layer);
    let m = edges(r);
    const dx = nearest(m.mx, xs), dy = nearest(m.my, ys);
    if (dx) n.x(n.x() + dx);
    if (dy) n.y(n.y() + dy);
    if (!dx && !dy) return;
    r = bbox(n, layer);
    m = edges(r);

    const z = zoom();
    const draw = (pts: number[]): void => {
      layer.add(new Konva.Line({ points: pts, stroke: COLOR, strokeWidth: 1 / z, dash: [4 / z, 3 / z], listening: false, name: "guide" }));
    };
    const eps = 0.01;
    if (dx) {
      for (const c of xs) {
        if (m.mx.some((v) => Math.abs(v - c.v) < eps)) draw([c.v, Math.min(c.from, r.y), c.v, Math.max(c.to, r.y + r.height)]);
      }
    }
    if (dy) {
      for (const c of ys) {
        if (m.my.some((v) => Math.abs(v - c.v) < eps)) draw([Math.min(c.from, r.x), c.v, Math.max(c.to, r.x + r.width), c.v]);
      }
    }
    layer.batchDraw();
  });
  layer.on("dragend.guides", () => { clearGuides(layer); layer.batchDraw(); });
}
