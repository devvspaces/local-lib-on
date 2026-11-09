// Scroll anchoring for the virtualized PDF view: a position is stored as {page, offset within that page's row}
// rather than pixels, so it survives row heights changing (page sizes loading, zoom, crop, hidden tabs).
export interface Row { pages: number[]; top: number; height: number }
export interface Anchor { page: number; offset: number }

/** Pixel top of an anchor in the current layout, or null if the page isn't laid out. */
export function anchorTop(rows: Row[], a: Anchor): number | null {
  const r = rows.find((x) => x.pages.includes(a.page));
  return r ? r.top + Math.max(0, Math.min(1, a.offset)) * r.height : null;
}

/** Offset (0..1) of pixel y within the row holding `page`. */
export function anchorAt(rows: Row[], y: number, page: number): number {
  const r = rows.find((x) => x.pages.includes(page));
  if (!r || r.height <= 0) return 0;
  return Math.max(0, Math.min(1, (y - r.top) / r.height));
}
