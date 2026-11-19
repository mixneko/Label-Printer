// 排版用的幾何運算：取得物件在標籤上的範圍、移動到指定位置、對齊標籤邊緣或中心。
// 座標單位一律是 dots（8 dots = 1 mm）。

import Konva from "konva";
import { N } from "./i18n";

export type Align = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

export const ALIGN_LABEL: Record<Align, string> = {
  left: N("靠左"),
  hcenter: N("水平置中"),
  right: N("靠右"),
  top: N("靠上"),
  vcenter: N("垂直置中"),
  bottom: N("靠下"),
};

/** 物件在標籤座標系中的外框（已考慮旋轉；不含線條粗細，與畫面上看到的內容範圍一致） */
export function bbox(n: Konva.Shape, layer: Konva.Layer): { x: number; y: number; width: number; height: number } {
  return n.getClientRect({ relativeTo: layer, skipStroke: true, skipShadow: true });
}

/** 把物件外框的左上角移到 (x, y)；省略的軸不變 */
export function moveBBoxTo(n: Konva.Shape, layer: Konva.Layer, x?: number, y?: number): void {
  const r = bbox(n, layer);
  if (x !== undefined) n.x(n.x() + x - r.x);
  if (y !== undefined) n.y(n.y() + y - r.y);
}

/** 對齊標籤（寬 w、高 h，dots）的邊緣或中心 */
export function alignTo(n: Konva.Shape, layer: Konva.Layer, how: Align, w: number, h: number): void {
  const r = bbox(n, layer);
  switch (how) {
    case "left": moveBBoxTo(n, layer, 0); break;
    case "hcenter": moveBBoxTo(n, layer, (w - r.width) / 2); break;
    case "right": moveBBoxTo(n, layer, w - r.width); break;
    case "top": moveBBoxTo(n, layer, undefined, 0); break;
    case "vcenter": moveBBoxTo(n, layer, undefined, (h - r.height) / 2); break;
    case "bottom": moveBBoxTo(n, layer, undefined, h - r.height); break;
  }
}

/**
 * 物件本身（未旋轉）的寬高，已乘上縮放。
 * 有「最大範圍」的文字回報設定的範圍（boxW × boxH），而不是因文字放不進而撐大的實際寬高。
 */
export function localSize(n: Konva.Shape): { w: number; h: number } {
  const sx = Math.abs(n.scaleX());
  const sy = Math.abs(n.scaleY());
  if (n.getAttr("kind") === "text" && n.getAttr("bounded")) {
    return { w: Number(n.getAttr("boxW")) * sx, h: Number(n.getAttr("boxH")) * sy };
  }
  return { w: n.width() * sx, h: n.height() * sy };
}
