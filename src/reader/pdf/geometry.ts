import type { PageViewport } from "pdfjs-dist";
import type { CropBox } from "@/lib/api";

export type Rect = [number, number, number, number]; // x1, y1, x2, y2

/** PDF-space rect → viewport rect (normalized so x1<x2, y1<y2). */
export function toViewport(vp: PageViewport, r: Rect): Rect {
  const [a, b] = vp.convertToViewportPoint(r[0], r[1]);
  const [c, d] = vp.convertToViewportPoint(r[2], r[3]);
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

export function toPdf(vp: PageViewport, r: Rect): Rect {
  const [a, b] = vp.convertToPdfPoint(r[0], r[1]);
  const [c, d] = vp.convertToPdfPoint(r[2], r[3]);
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

export const pointToPdf = (vp: PageViewport, x: number, y: number) => vp.convertToPdfPoint(x, y) as [number, number];
export const pointToViewport = (vp: PageViewport, x: number, y: number) => vp.convertToViewportPoint(x, y) as [number, number];

/** Merge selection client rects that sit on the same line into one rect per line. */
export function mergeLineRects(rects: Rect[]): Rect[] {
  const sorted = rects.filter((r) => r[2] - r[0] > 0.5 && r[3] - r[1] > 0.5).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const out: Rect[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    const h = Math.min(r[3] - r[1], last ? last[3] - last[1] : Infinity);
    if (last && Math.abs(r[1] - last[1]) < h * 0.5 && Math.abs(r[3] - last[3]) < h * 0.5 && r[0] <= last[2] + h * 1.5) {
      last[0] = Math.min(last[0], r[0]);
      last[2] = Math.max(last[2], r[2]);
      last[1] = Math.min(last[1], r[1]);
      last[3] = Math.max(last[3], r[3]);
    } else out.push([...r] as Rect);
  }
  return out;
}

export const contains = (r: Rect, x: number, y: number, pad = 0) => x >= r[0] - pad && x <= r[2] + pad && y >= r[1] - pad && y <= r[3] + pad;

export function cropFor(crop: CropBox | null | undefined, page: number) {
  if (!crop) return { top: 0, right: 0, bottom: 0, left: 0 };
  const side = page % 2 === 1 ? crop.odd : crop.even;
  return side ?? { top: crop.top, right: crop.right, bottom: crop.bottom, left: crop.left };
}
