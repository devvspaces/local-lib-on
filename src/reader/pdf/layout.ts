// Pure layout analysis over pdf.js text items: column detection for reflow, table extraction,
// content bounding boxes for auto-crop. Kept DOM-free so it can be unit tested.

export interface Item { str: string; x: number; y: number; w: number; h: number; font?: string; eol?: boolean }

export interface Line { x: number; y: number; x2: number; h: number; text: string; size: number }
export interface Block { kind: "p" | "h"; text: string; size: number; column: number; y: number }

/** Group items into lines (PDF space: y grows upward). */
export function toLines(items: Item[]): Line[] {
  const sorted = items.filter((i) => i.str.trim() || i.str === " ").sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: { items: Item[]; y: number; h: number }[] = [];
  for (const it of sorted) {
    const l = lines.find((L) => Math.abs(L.y - it.y) < Math.max(L.h, it.h) * 0.45 && overlapsX(L.items, it));
    if (l) l.items.push(it);
    else lines.push({ items: [it], y: it.y, h: it.h });
  }
  return lines
    .map((L) => {
      const its = L.items.sort((a, b) => a.x - b.x);
      let text = "";
      let lastEnd = -Infinity;
      for (const i of its) {
        if (text && i.x - lastEnd > i.h * 0.18 && !text.endsWith(" ") && !i.str.startsWith(" ")) text += " ";
        text += i.str;
        lastEnd = i.x + i.w;
      }
      const size = median(its.map((i) => i.h));
      return { x: its[0].x, x2: Math.max(...its.map((i) => i.x + i.w)), y: L.y, h: L.h, text: text.replace(/\s+/g, " ").trim(), size };
    })
    .filter((l) => l.text)
    .sort((a, b) => b.y - a.y || a.x - b.x);
}

function overlapsX(items: Item[], it: Item) {
  // Items on the same baseline but far apart horizontally (two columns) must not merge.
  const minX = Math.min(...items.map((i) => i.x));
  const maxX = Math.max(...items.map((i) => i.x + i.w));
  return it.x <= maxX + it.h * 3 && it.x + it.w >= minX - it.h * 3;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * Detect columns by finding vertical gutters: x-ranges no line crosses.
 * Returns column x-boundaries (left edges) sorted left→right.
 */
export function detectColumns(lines: Line[], pageWidth: number): number[] {
  if (lines.length < 6) return [0];
  const bins = 200;
  const cover = new Array(bins).fill(0);
  const body = lines.filter((l) => l.x2 - l.x < pageWidth * 0.6); // ignore full-width headers/titles
  if (body.length < lines.length * 0.4) return [0];
  for (const l of body) {
    const a = Math.max(0, Math.floor((l.x / pageWidth) * bins));
    const b = Math.min(bins - 1, Math.ceil((l.x2 / pageWidth) * bins));
    for (let i = a; i <= b; i++) cover[i]++;
  }
  const minX = Math.min(...body.map((l) => l.x)), maxX = Math.max(...body.map((l) => l.x2));
  const lo = Math.floor((minX / pageWidth) * bins) + 3, hi = Math.ceil((maxX / pageWidth) * bins) - 3;
  const gutters: number[] = [];
  for (let i = lo; i < hi; i++) {
    if (cover[i] === 0) {
      let j = i;
      while (j < hi && cover[j] === 0) j++;
      if (j - i >= 1) gutters.push(((i + j) / 2 / bins) * pageWidth);
      i = j;
    }
  }
  return [0, ...gutters];
}

/** Lines → reading-order paragraphs/headings for reflow. */
export function toBlocks(lines: Line[], pageWidth: number): Block[] {
  const cols = detectColumns(lines, pageWidth);
  const colOf = (l: Line) => {
    if (l.x2 - l.x > pageWidth * 0.6) return -1; // spanning line
    let c = 0;
    cols.forEach((x, i) => { if (l.x >= x - 2) c = i; });
    return c;
  };
  const body = median(lines.map((l) => l.size)) || 10;
  // Order: spanning lines above the columns first, then column by column top→bottom.
  const tagged = lines.map((l) => ({ l, c: colOf(l) }));
  const firstColY = Math.max(...tagged.filter((t) => t.c >= 0).map((t) => t.l.y), -Infinity);
  const ordered = [
    ...tagged.filter((t) => t.c === -1 && t.l.y > firstColY),
    ...cols.flatMap((_, ci) => tagged.filter((t) => t.c === ci)),
    ...tagged.filter((t) => t.c === -1 && t.l.y <= firstColY),
  ];

  const blocks: Block[] = [];
  let prev: { l: Line; c: number } | null = null;
  for (const t of ordered) {
    const isHeading = t.l.size > body * 1.18 && t.l.text.length < 140;
    const last = blocks[blocks.length - 1];
    const gap = prev ? prev.l.y - t.l.y : 0;
    const newPara =
      !last || isHeading || last.kind === "h" || t.c !== prev?.c || gap > t.l.h * 1.7 || gap < 0 ||
      /[.!?:"”]$/.test(last.text) && t.l.x - (prev?.l.x ?? 0) > t.l.size * 0.8; // indented first line
    if (newPara) blocks.push({ kind: isHeading ? "h" : "p", text: t.l.text, size: t.l.size, column: t.c, y: t.l.y });
    else last.text = last.text.endsWith("-") && /^[a-z]/.test(t.l.text) ? last.text.slice(0, -1) + t.l.text : `${last.text} ${t.l.text}`;
    prev = t;
  }
  return blocks;
}

/** Extract a table from items inside a PDF-space rect → rows of cells. */
export function extractTable(items: Item[], rect: [number, number, number, number]): string[][] {
  const inside = items.filter((i) => i.str.trim() && i.x >= rect[0] - 1 && i.x + i.w <= rect[2] + 1 && i.y >= rect[1] - 1 && i.y + i.h <= rect[3] + 1);
  if (!inside.length) return [];
  const lines = toLinesKeep(inside);
  // Column boundaries: x positions where no item in any row overlaps.
  const all = lines.flat();
  const minX = Math.min(...all.map((i) => i.x)), maxX = Math.max(...all.map((i) => i.x + i.w));
  const N = 400;
  const cover = new Array(N + 1).fill(0);
  for (const i of all) {
    const a = Math.floor(((i.x - minX) / (maxX - minX || 1)) * N), b = Math.ceil(((i.x + i.w - minX) / (maxX - minX || 1)) * N);
    for (let k = a; k <= b; k++) cover[k]++;
  }
  const cuts: number[] = [];
  for (let k = 1; k < N; k++) if (cover[k] === 0 && cover[k - 1] > 0) cuts.push(minX + (k / N) * (maxX - minX));
  const colIndex = (x: number) => cuts.filter((c) => x > c).length;
  return lines.map((row) => {
    const cells: string[] = new Array(cuts.length + 1).fill("");
    for (const i of row.sort((a, b) => a.x - b.x)) {
      const c = colIndex(i.x + i.w / 2);
      cells[c] = (cells[c] ? cells[c] + " " : "") + i.str.trim();
    }
    return cells;
  });
}

function toLinesKeep(items: Item[]): Item[][] {
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const rows: { y: number; h: number; items: Item[] }[] = [];
  for (const it of sorted) {
    const r = rows.find((R) => Math.abs(R.y - it.y) < Math.max(R.h, it.h) * 0.5);
    if (r) r.items.push(it);
    else rows.push({ y: it.y, h: it.h, items: [it] });
  }
  return rows.map((r) => r.items);
}

export const tableToTSV = (rows: string[][]) => rows.map((r) => r.join("\t")).join("\n");
export const tableToMarkdown = (rows: string[][]) => {
  if (!rows.length) return "";
  const w = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...new Array(w - r.length).fill("")];
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  return [
    `| ${pad(rows[0]).map(esc).join(" | ")} |`,
    `| ${new Array(w).fill("---").join(" | ")} |`,
    ...rows.slice(1).map((r) => `| ${pad(r).map(esc).join(" | ")} |`),
  ].join("\n");
};

/**
 * Content bounding box from rendered pixels (RGBA). Returns margins as fractions.
 * A pixel counts as ink if it is noticeably darker than paper.
 */
export function contentBox(data: Uint8ClampedArray, width: number, height: number, threshold = 236) {
  let top = height, bottom = -1, left = width, right = -1;
  const rowInk = new Array(height).fill(0);
  const colInk = new Array(width).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = (y * width + x) * 4;
      const v = (data[k] + data[k + 1] + data[k + 2]) / 3;
      if (v < threshold && data[k + 3] > 0) { rowInk[y]++; colInk[x]++; }
    }
  }
  // Ignore isolated specks (scan noise): require a few ink pixels per row/col.
  const minInk = 2;
  for (let y = 0; y < height; y++) if (rowInk[y] >= minInk) { top = Math.min(top, y); bottom = y; }
  for (let x = 0; x < width; x++) if (colInk[x] >= minInk) { left = Math.min(left, x); right = x; }
  if (bottom < 0 || right < 0) return null;
  return { top: top / height, left: left / width, bottom: 1 - (bottom + 1) / height, right: 1 - (right + 1) / width };
}

/** Combine per-page boxes into one safe crop (smallest margin on each side), with padding. */
export function combineCrops(boxes: { top: number; left: number; bottom: number; right: number }[], pad = 0.012) {
  if (!boxes.length) return null;
  const side = (k: "top" | "left" | "bottom" | "right") => Math.max(0, Math.min(...boxes.map((b) => b[k])) - pad);
  const c = { top: side("top"), right: side("right"), bottom: side("bottom"), left: side("left") };
  // Never crop more than 40% of a dimension.
  if (c.left + c.right > 0.4 || c.top + c.bottom > 0.4) return null;
  return c;
}
