import { describe, expect, it } from "vitest";
import { convertRaw } from "./pdfAnnots";

describe("convertRaw", () => {
  it("maps highlight quads and colors", () => {
    const c = convertRaw({ subtype: "Highlight", rect: [70, 690, 310, 715], quadPoints: [72, 712, 300, 712, 72, 700, 300, 700], color: [255, 212, 0], contentsObj: { str: "why?" } }, 3)!;
    expect(c.kind).toBe("highlight");
    expect(c.anchor).toEqual({ page: 3, rects: [[72, 700, 300, 712]] });
    expect(c.color).toBe("#ffd400");
    expect(c.comment).toBe("why?");
  });
  it("detects arrows and skips our own exports and widgets", () => {
    expect(convertRaw({ subtype: "Line", rect: [0, 0, 10, 10], lineCoordinates: [0, 0, 10, 10], lineEndings: ["None", "OpenArrow"] }, 1)!.kind).toBe("arrow");
    expect(convertRaw({ subtype: "Highlight", rect: [0, 0, 1, 1], titleObj: { str: "Local Lib" } }, 1)).toBeNull();
    expect(convertRaw({ subtype: "Widget", rect: [0, 0, 1, 1] }, 1)).toBeNull();
  });
});
