import { describe, expect, it } from "vitest";
import { blockRanges, chapterRanges, rangesFromStarts } from "./chapters";

describe("chapter ranges", () => {
  it("turns page starts into contiguous ranges", () => {
    const r = rangesFromStarts([{ label: "Ch 2", depth: 0, start: 30 }, { label: "Ch 1", depth: 0, start: 5 }, { label: "1.1", depth: 1, start: 5 }, { label: "Ch 3", depth: 0, start: 80 }], 120, "p");
    expect(r.map((x) => [x.label, x.from, x.to])).toEqual([["Ch 1", 5, 29], ["Ch 2", 30, 79], ["Ch 3", 80, 120]]);
  });
  it("resolves EPUB TOC hrefs to section ranges through the engine", () => {
    const engine = { sectionOf: (h: string) => ({ "a.xhtml": 2, "b.xhtml#x": 5, "c.xhtml": 9 } as Record<string, number>)[h] ?? null, sectionCount: () => 12 };
    const r = chapterRanges([{ label: "A", href: "a.xhtml" }, { label: "B", href: "b.xhtml#x" }, { label: "C", href: "c.xhtml" }, { label: "Broken", href: "zzz" }], engine as never, { isPaged: false });
    expect(r.map((x) => [x.label, x.kind, x.from, x.to])).toEqual([["A", "s", 2, 4], ["B", "s", 5, 8], ["C", "s", 9, 11]]);
  });
  it("respects maxDepth and falls back to blocks without a TOC", () => {
    const toc = [{ label: "Part I", page: 1, children: [{ label: "Ch 1", page: 3 }] }, { label: "Part II", page: 50 }];
    expect(chapterRanges(toc, null, { isPaged: true, pageCount: 60, maxDepth: 0 }).map((x) => x.label)).toEqual(["Part I", "Part II"]);
    expect(chapterRanges([], null, { isPaged: true, pageCount: 45 })).toEqual(blockRanges(45, "p"));
    expect(blockRanges(45, "p").map((x) => [x.from, x.to])).toEqual([[1, 20], [21, 40], [41, 45]]);
  });
});
