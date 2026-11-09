import { describe, expect, it } from "vitest";
import { combineCrops, contentBox, detectColumns, extractTable, tableToMarkdown, toBlocks, toLines, type Item } from "./layout";

const it_ = (str: string, x: number, y: number, w = str.length * 5, h = 10): Item => ({ str, x, y, w, h });

describe("reflow layout", () => {
  it("orders a two-column page column by column", () => {
    const items: Item[] = [];
    for (let i = 0; i < 10; i++) {
      items.push(it_(`left line ${i}`, 50, 700 - i * 14, 200));
      items.push(it_(`right line ${i}`, 320, 700 - i * 14, 200));
    }
    const lines = toLines(items);
    expect(lines).toHaveLength(20);
    expect(detectColumns(lines, 600)).toHaveLength(2);
    const blocks = toBlocks(lines, 600);
    const text = blocks.map((b) => b.text).join(" ");
    expect(text.indexOf("left line 9")).toBeLessThan(text.indexOf("right line 0"));
  });

  it("joins hyphenated line breaks and detects headings", () => {
    const items = [it_("Introduction", 50, 720, 120, 16), it_("This is a hyphen-", 50, 700, 170), it_("ated word here.", 50, 688, 150)];
    const blocks = toBlocks(toLines(items), 600);
    expect(blocks[0].kind).toBe("h");
    expect(blocks[1].text).toBe("This is a hyphenated word here.");
  });
});

describe("tables", () => {
  it("extracts rows and columns inside a rect", () => {
    const items = [it_("Name", 50, 500, 40), it_("Score", 200, 500, 40), it_("Ada", 50, 485, 30), it_("98", 200, 485, 15), it_("outside", 50, 300)];
    const rows = extractTable(items, [40, 470, 260, 515]);
    expect(rows).toEqual([["Name", "Score"], ["Ada", "98"]]);
    expect(tableToMarkdown(rows).split("\n")[1]).toBe("| --- | --- |");
  });
});

describe("auto crop", () => {
  it("finds content box and combines conservatively", () => {
    const w = 100, h = 100;
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    for (let y = 20; y < 80; y++) for (let x = 10; x < 90; x++) { const k = (y * w + x) * 4; data[k] = data[k + 1] = data[k + 2] = 0; }
    const b = contentBox(data, w, h)!;
    expect(b.top).toBeCloseTo(0.2);
    expect(b.left).toBeCloseTo(0.1);
    const c = combineCrops([b, { ...b, left: 0.05 }], 0)!;
    expect(c.left).toBeCloseTo(0.05);
  });
});
