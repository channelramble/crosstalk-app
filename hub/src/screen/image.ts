// Pictures of the screen for an agent: the framebuffer (R, G, B, spare per pixel) scaled down and written as a PNG.
// Written by hand (a PNG is a few headers around zlib) so the hub stays one binary with no native image library.

import { deflateSync } from "node:zlib";

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(...parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC[(c ^ p[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  const name = new TextEncoder().encode(type);
  out.set(name, 4);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(name, data));
  return out;
}

/** A PNG of `rgb` (three bytes a pixel, rows top to bottom). */
export function encodePng(rgb: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 3;
  // Each row starts with its filter: none (0). Screens are mostly flat colour, which deflate handles well as it is.
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const head = new Uint8Array(13);
  const v = new DataView(head.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  head[8] = 8; // bits per channel
  head[9] = 2; // truecolour
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 6 }))), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * The framebuffer (four bytes a pixel) as RGB at `outW` × `outH`, each output pixel the average of the screen pixels
 * under it, so small text stays readable when a 1920-wide screen is shown 1280 wide. `crop` takes a part of the screen.
 */
export function scaleRgb(pixels: Uint8Array, width: number, height: number, outW: number, outH: number, crop?: { x: number; y: number; w: number; h: number }): Uint8Array {
  const cx = crop?.x ?? 0, cy = crop?.y ?? 0, cw = crop?.w ?? width, ch = crop?.h ?? height;
  const out = new Uint8Array(outW * outH * 3);
  const sx = cw / outW, sy = ch / outH;
  for (let y = 0; y < outH; y++) {
    const y0 = Math.floor(cy + y * sy), y1 = Math.max(y0 + 1, Math.min(height, Math.ceil(cy + (y + 1) * sy)));
    for (let x = 0; x < outW; x++) {
      const x0 = Math.floor(cx + x * sx), x1 = Math.max(x0 + 1, Math.min(width, Math.ceil(cx + (x + 1) * sx)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let at = (yy * width + x0) * 4;
        for (let xx = x0; xx < x1; xx++) {
          r += pixels[at]!;
          g += pixels[at + 1]!;
          b += pixels[at + 2]!;
          at += 4;
          n++;
        }
      }
      const o = (y * outW + x) * 3;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
    }
  }
  return out;
}
