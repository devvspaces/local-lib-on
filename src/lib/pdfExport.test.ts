import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { exportAnnotatedPdf } from "./pdfExport";
import type { Annotation } from "./api";

const ann = (over: Partial<Annotation>): Annotation => ({
  id: "a1", book_id: 1, kind: "highlight", color: "#ffd400", anchor: { page: 1, rects: [[72, 700, 300, 712]] }, page_label: "1",
  text: "hello", comment: "my note", tags: [], style: null, created_at: "", updated_at: "2026-11-07T10:00:00Z", ...over,
});

describe("exportAnnotatedPdf", () => {
  it("writes standard annotations that parse back", async () => {
    const src = await PDFDocument.create();
    src.addPage([612, 792]);
    const bytes = await src.save();
    const { bytes: out, written } = await exportAnnotatedPdf(bytes.buffer as ArrayBuffer, [
      ann({}),
      ann({ id: "a2", kind: "ink", anchor: { page: 1, rects: [[10, 10, 50, 50]], paths: [[[10, 10], [30, 40], [50, 50]]] } }),
      ann({ id: "a3", kind: "arrow", anchor: { page: 1, rects: [[0, 0, 1, 1]], points: [[100, 100], [200, 150]] } }),
      ann({ id: "a4", kind: "highlight", anchor: { cfi: "epubcfi(/6/2)" } }),
    ]);
    expect(written).toBe(3);
    const back = await PDFDocument.load(out);
    const annots = back.getPage(0).node.Annots();
    expect(annots?.size()).toBe(3);
    const first = back.context.lookup(annots!.get(0))!.toString();
    expect(first).toContain("/Subtype /Highlight");
    expect(first).toContain("/QuadPoints");
    const third = back.context.lookup(annots!.get(2))!.toString();
    expect(third).toContain("/OpenArrow");
  });
});
