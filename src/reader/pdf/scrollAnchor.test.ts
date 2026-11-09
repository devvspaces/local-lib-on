import { describe, expect, it } from "vitest";
import { anchorAt, anchorTop, type Row } from "./scrollAnchor";

const layout = (heights: number[], gap = 10): Row[] => {
  let top = 0;
  return heights.map((h, i) => { const r = { pages: [i + 1], top, height: h }; top += h + gap; return r; });
};

describe("PDF scroll anchor", () => {
  it("keeps the same page when page heights change under it", () => {
    // First layout guesses every page is as tall as the cover; real sizes are smaller.
    const guessed = layout(new Array(371).fill(1200));
    const real = layout([1200, ...new Array(370).fill(900)]);
    const a = { page: 125, offset: 0.25 };
    const yGuess = anchorTop(guessed, a)!;
    // Old bug: reusing the pixel position on the new layout lands far later in the book.
    const drifted = real.findIndex((r) => r.top + r.height >= yGuess) + 1;
    expect(drifted).toBeGreaterThan(160);
    // Anchored: same page, same offset.
    const y = anchorTop(real, a)!;
    expect(real.findIndex((r) => r.top + r.height >= y) + 1).toBe(125);
    expect(anchorAt(real, y, 125)).toBeCloseTo(0.25);
  });
  it("returns null for pages not laid out and clamps offsets", () => {
    const rows = layout([100, 100]);
    expect(anchorTop(rows, { page: 9, offset: 0 })).toBeNull();
    expect(anchorAt(rows, -50, 1)).toBe(0);
    expect(anchorAt(rows, 10_000, 1)).toBe(1);
  });
});
