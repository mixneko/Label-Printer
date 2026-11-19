// 將 Canvas 轉成 1-bit 點陣資料（每列打包成 byte，高位元在前，1 = 黑點）。
// 與 Rust 端 tspl.rs 約定：bitmap 長度 = ceil(width/8) * height。

export interface PackedBitmap {
  width: number;
  height: number;
  data: Uint8Array;
}

/** 轉成 base64 字串傳給後端（比 JSON 數字陣列小很多） */
export function toBase64(data: Uint8Array): string {
  let s = "";
  for (let i = 0; i < data.length; i += 0x8000) {
    s += String.fromCharCode(...data.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** 把 1-bit 點陣畫回 canvas（1 = 黑點），用於預覽實際送給印表機的內容 */
export function monoToCanvas(bmp: PackedBitmap, target: HTMLCanvasElement): void {
  target.width = bmp.width;
  target.height = bmp.height;
  const ctx = target.getContext("2d");
  if (!ctx) throw new Error("無法取得 canvas context");
  const img = ctx.createImageData(bmp.width, bmp.height);
  const widthBytes = Math.ceil(bmp.width / 8);
  for (let y = 0; y < bmp.height; y++) {
    for (let x = 0; x < bmp.width; x++) {
      const black = (bmp.data[y * widthBytes + (x >> 3)] & (0x80 >> (x & 7))) !== 0;
      const i = (y * bmp.width + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = black ? 0 : 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

export function canvasToMono(canvas: HTMLCanvasElement, threshold = 128): PackedBitmap {
  const { width, height } = canvas;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("無法取得 canvas context");
  const px = ctx.getImageData(0, 0, width, height).data;
  const widthBytes = Math.ceil(width / 8);
  const data = new Uint8Array(widthBytes * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = px[i + 3] / 255;
      // 與白底合成後取亮度；透明視為白色
      const lum = 0.299 * px[i] * a + 0.587 * px[i + 1] * a + 0.114 * px[i + 2] * a + 255 * (1 - a);
      if (lum < threshold) data[y * widthBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { width, height, data };
}
