import { describe, expect, it } from "vitest";
import { buildContext, linkCitations, numberSources } from "./assistant";

describe("assistant context", () => {
  it("numbers and de-duplicates sources, current page first", () => {
    const cur = { book_id: 1, title: "DDIA", loc: "p12", text: "current" };
    const s = numberSources([{ book_id: 1, title: "DDIA", loc: "p12", text: "dup" }, { book_id: 2, title: "SRE", loc: "p3", text: "x" }], cur);
    expect(s.map((x) => [x.n, x.loc])).toEqual([[1, "p12"], [2, "p3"]]);
    const ctx = buildContext({ question: "Why?", sources: s, selection: "quorum" });
    expect(ctx).toContain("[2] SRE, p. 3");
    expect(ctx.endsWith("REQUEST:\nWhy?")).toBe(true);
  });
  it("links citations only for known sources", () => {
    const s = numberSources([{ book_id: 2, title: "SRE", loc: "p3", text: "x" }]);
    const h = linkCitations("<p>Yes [1] and [7], also [1, 7]</p>", s);
    expect(h).toContain('href="cite://1"');
    expect(h).toContain("[7]");
  });
});
