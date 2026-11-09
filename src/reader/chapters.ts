// Chapter ranges for any format, from the table of contents:
//   PDF / DjVu → page ranges ("p"), EPUB / MOBI / DOCX / ODT → section ranges ("s", matching the full-text units s{n}).
// Used by chapter summaries, the book overview and audiobook export.
import type { EngineHandle, TocItem } from "./types";

export interface ChapterRange { label: string; depth: number; kind: "p" | "s"; from: number; to: number }

/** Pure core: sorted, de-duplicated starts → contiguous [from, to] ranges ending before the next start. */
export function rangesFromStarts(starts: { label: string; depth: number; start: number }[], total: number, kind: "p" | "s"): ChapterRange[] {
  const first = kind === "p" ? 1 : 0;
  const last = kind === "p" ? total : total - 1;
  const sorted = starts.filter((s) => s.start >= first && s.start <= last).sort((a, b) => a.start - b.start || a.depth - b.depth);
  const uniq: typeof sorted = [];
  for (const s of sorted) if (!uniq.length || uniq[uniq.length - 1].start !== s.start) uniq.push(s);
  return uniq.map((s, i) => ({ label: s.label, depth: s.depth, kind, from: s.start, to: i + 1 < uniq.length ? uniq[i + 1].start - 1 : last }));
}

/** Fixed-size blocks for books without a usable TOC. */
export function blockRanges(total: number, kind: "p" | "s", size = kind === "p" ? 20 : 1): ChapterRange[] {
  const out: ChapterRange[] = [];
  const first = kind === "p" ? 1 : 0, last = kind === "p" ? total : total - 1;
  for (let a = first, n = 1; a <= last; a += size, n++) out.push({ label: kind === "p" ? `Pages ${a}–${Math.min(last, a + size - 1)}` : `Part ${n}`, depth: 0, kind, from: a, to: Math.min(last, a + size - 1) });
  return out;
}

export function flattenToc(toc: TocItem[], maxDepth = Infinity) {
  const out: { item: TocItem; depth: number }[] = [];
  const walk = (items: TocItem[], d: number) => items.forEach((x) => { out.push({ item: x, depth: d }); if (x.children && d + 1 <= maxDepth) walk(x.children, d + 1); });
  walk(toc, 0);
  return out;
}

/**
 * Chapter ranges for the open book. `maxDepth` 0 = top-level chapters only.
 * Page-based books need `pageCount`; section-based books are resolved through the engine.
 */
export function chapterRanges(toc: TocItem[], engine: EngineHandle | null, opts: { isPaged: boolean; pageCount?: number; maxDepth?: number }): ChapterRange[] {
  const flat = flattenToc(toc, opts.maxDepth ?? Infinity);
  if (opts.isPaged) {
    const total = opts.pageCount ?? 0;
    const r = rangesFromStarts(flat.filter((f) => f.item.page).map((f) => ({ label: f.item.label, depth: f.depth, start: f.item.page! })), total, "p");
    return r.length ? r : blockRanges(total, "p");
  }
  const total = engine?.sectionCount?.() ?? 0;
  const starts = flat.flatMap((f) => {
    const i = f.item.href ? engine?.sectionOf?.(f.item.href) : null;
    return i === null || i === undefined ? [] : [{ label: f.item.label, depth: f.depth, start: i }];
  });
  const r = rangesFromStarts(starts, total, "s");
  return r.length ? r : blockRanges(total, "s");
}

/** The range that contains a TOC entry (for "summarize this chapter"). */
export function rangeFor(ranges: ChapterRange[], label: string, start?: number) {
  return ranges.find((r) => r.label === label && (start === undefined || r.from === start)) ?? ranges.find((r) => r.label === label);
}
