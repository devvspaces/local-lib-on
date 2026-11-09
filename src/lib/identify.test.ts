import { describe, expect, it, vi } from "vitest";
import { identify, parseGuess, weakTitle, type IdentifyDeps } from "./identify";

const GFS = { title: "The Google File System", authors: ["Sanjay Ghemawat", "Howard Gobioff", "Shun-Tak Leung"], year: 2003, doi: "10.1145/945445.945450", metadata_source: "Crossref" };
const deps = (over: Partial<IdentifyDeps> = {}): IdentifyDeps => ({
  lookupDOI: vi.fn(async (d: string) => (d === GFS.doi ? GFS : null)),
  lookupCrossrefTitle: vi.fn(async (t: string) => (/google file system/i.test(t) ? GFS : null)),
  lookupMetadata: vi.fn(async () => null),
  ...over,
});

describe("identify", () => {
  it("uses a DOI printed in the document without calling the model", async () => {
    const ask = vi.fn(async () => "{}");
    const d = deps({ ask });
    const r = await identify({ text: `SOSP'03 ... doi:${GFS.doi} ...`, fileName: "gfs-sosp2003.pdf", embedded: {} }, d);
    expect(r?.patch.title).toBe("The Google File System");
    expect(r?.via).toContain("DOI");
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks the model when no identifier is printed, then resolves the paper via Crossref title search", async () => {
    const ask = vi.fn(async () => 'Sure!\n```json\n{"type":"article","title":"The Google File System","authors":["Sanjay Ghemawat"],"year":2003,"venue":"SOSP"}\n```');
    const d = deps({ ask });
    const r = await identify({ text: "The Google File System\nSanjay Ghemawat, Howard Gobioff, and Shun-Tak Leung\nGoogle", fileName: "gfs-sosp2003.pdf", embedded: { title: "gfs-sosp2003" } }, d);
    expect(ask).toHaveBeenCalledOnce();
    expect(d.lookupCrossrefTitle).toHaveBeenCalledWith("The Google File System", "Sanjay Ghemawat");
    expect(r?.patch.doi).toBe(GFS.doi);
  });

  it("rejects a model-supplied DOI whose record has a different title", async () => {
    const ask = vi.fn(async () => '{"type":"book","title":"Some Other Book","doi":"10.1145/945445.945450"}');
    const r = await identify({ text: "Some Other Book", fileName: "x.pdf", embedded: {} }, deps({ ask }));
    expect(r?.patch.doi).toBeUndefined();
    expect(r?.patch.metadata_source).toBe("AI"); // falls back to the model's reading
    expect(r?.patch.title).toBe("Some Other Book");
  });

  it("returns null with no identifiers, no model and no title", async () => {
    expect(await identify({ text: "", fileName: "scan.pdf", embedded: {} }, deps())).toBeNull();
  });

  it("parses guesses defensively", () => {
    expect(parseGuess("no json here")).toBeNull();
    const g = parseGuess('{"title":" X ","year":"1999","doi":"https://doi.org/10.1000/abc","isbn":"978-0-13-110362-7","authors":["A"]}');
    expect(g).toMatchObject({ title: "X", year: 1999, doi: "10.1000/abc", isbn: "9780131103627" });
    expect(parseGuess('{"year": 12, "doi": "not-a-doi"}')).toMatchObject({ year: undefined, doi: undefined });
  });

  it("spots weak titles from browser saves", () => {
    expect(weakTitle("https://research.google/pubs/pub51.pdf")).toBe(true);
    expect(weakTitle("gfs-sosp2003.pdf")).toBe(true);
    expect(weakTitle("gfs-sosp2003")).toBe(true);
    expect(weakTitle("The Google File System")).toBe(false);
  });
});
