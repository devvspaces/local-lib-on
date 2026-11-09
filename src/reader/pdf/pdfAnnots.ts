// Import annotations that already exist inside a PDF (made in Preview, Acrobat, Okular, Zotero…).
import type { Annotation, AnnotationKind } from "@/lib/api";
import type { PDFDocumentProxy } from "./pdfjs";

type Raw = {
  subtype: string; rect: number[]; quadPoints?: ArrayLike<number> | null; color?: ArrayLike<number> | null;
  contentsObj?: { str?: string }; titleObj?: { str?: string }; inkLists?: ArrayLike<number>[]; lineCoordinates?: number[];
  lineEndings?: string[]; id?: string; borderStyle?: { width?: number }; modificationDate?: string; textContent?: string[];
};

const KIND: Record<string, AnnotationKind> = {
  Highlight: "highlight", Underline: "underline", StrikeOut: "strike", Squiggly: "squiggly",
  Text: "note", FreeText: "text", Ink: "ink", Line: "line", Square: "rect", Circle: "ellipse",
};

const toHex = (c?: ArrayLike<number> | null) =>
  c && c.length >= 3 ? "#" + Array.from(c).slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("") : "#ffd400";

export function convertRaw(a: Raw, page: number): (Pick<Annotation, "kind" | "anchor"> & Partial<Annotation>) | null {
  const kind = KIND[a.subtype];
  if (!kind) return null;
  if (a.titleObj?.str === "Local Lib") return null; // our own exported annotations
  const [x1, y1, x2, y2] = a.rect;
  let rects: [number, number, number, number][] = [[Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]];
  if (a.quadPoints && a.quadPoints.length >= 8) {
    const q = Array.from(a.quadPoints);
    rects = [];
    for (let i = 0; i + 7 < q.length; i += 8) {
      const xs = [q[i], q[i + 2], q[i + 4], q[i + 6]], ys = [q[i + 1], q[i + 3], q[i + 5], q[i + 7]];
      rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
    }
  }
  const anchor: Annotation["anchor"] = { page, rects };
  if (kind === "ink" && a.inkLists) {
    anchor.paths = a.inkLists.map((l) => {
      const arr = Array.from(l);
      const pts: [number, number][] = [];
      for (let i = 0; i + 1 < arr.length; i += 2) pts.push([arr[i], arr[i + 1]]);
      return pts;
    });
  }
  let k = kind;
  if (kind === "line" && a.lineCoordinates) {
    const [lx1, ly1, lx2, ly2] = a.lineCoordinates;
    anchor.points = [[lx1, ly1], [lx2, ly2]];
    if (a.lineEndings?.some((e) => /Arrow/.test(e))) k = "arrow";
  }
  const comment = a.contentsObj?.str?.trim() || null;
  return {
    kind: k,
    anchor,
    color: toHex(a.color),
    comment: k === "highlight" || k === "underline" || k === "strike" || k === "squiggly" ? comment : comment,
    text: a.textContent?.join(" ") ?? null,
    tags: ["imported"],
    style: a.borderStyle?.width ? { width: a.borderStyle.width } : null,
    page_label: String(page),
  };
}

export async function readPdfAnnotations(doc: PDFDocumentProxy) {
  const out: ReturnType<typeof convertRaw>[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const anns = (await page.getAnnotations({ intent: "display" })) as Raw[];
    for (const a of anns) { const c = convertRaw(a, p); if (c) out.push(c); }
  }
  return out.filter(Boolean) as NonNullable<ReturnType<typeof convertRaw>>[];
}
