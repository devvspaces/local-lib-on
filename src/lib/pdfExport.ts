// Write our annotations into a COPY of the PDF as standard PDF annotation objects
// (Highlight/Underline/StrikeOut/Squiggly/Text/FreeText/Ink/Line/Square/Circle), so Preview,
// Acrobat, Okular and Zotero show them. Anchors are already stored in PDF user space.
import { PDFArray, PDFDocument, PDFName, PDFNumber, PDFString, PDFHexString, type PDFDict, type PDFPage } from "pdf-lib";
import type { Annotation } from "@/lib/api";

const hex = (c: string | null) => {
  const m = (c ?? "#ffd400").replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m ? [1, 2, 3].map((i) => parseInt(m[i], 16) / 255) : [1, 0.83, 0];
};

const SUBTYPE: Partial<Record<Annotation["kind"], string>> = {
  highlight: "Highlight", underline: "Underline", strike: "StrikeOut", squiggly: "Squiggly",
  note: "Text", text: "FreeText", stamp: "FreeText", ink: "Ink", line: "Line", arrow: "Line", rect: "Square", ellipse: "Circle", area: "Square",
};

const pdfDate = (iso: string) => {
  const d = new Date(iso || Date.now());
  const p = (n: number) => String(n).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
};

function addAnnotation(doc: PDFDocument, page: PDFPage, a: Annotation, author: string) {
  if (!("page" in a.anchor)) return false;
  const subtype = SUBTYPE[a.kind];
  if (!subtype) return false;
  const rects = a.anchor.rects ?? [];
  const pts = a.anchor.points ?? [];
  const paths = a.anchor.paths ?? [];
  const all = [...rects.flatMap((r) => [[r[0], r[1]], [r[2], r[3]]]), ...pts, ...paths.flat()];
  if (!all.length) return false;
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
  const pad = 2;
  const ctx = doc.context;
  const dict: Record<string, unknown> = {
    Type: "Annot",
    Subtype: subtype,
    Rect: [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad],
    C: hex(a.color),
    T: PDFHexString.fromText(author),
    M: PDFString.of(pdfDate(a.updated_at)),
    NM: PDFString.of(a.id),
    F: 4, // print
    CA: a.style?.opacity ?? 1,
  };
  const contents = [a.comment, a.kind === "stamp" ? a.style?.stamp : null].filter(Boolean).join("\n");
  if (contents) dict.Contents = PDFHexString.fromText(contents);
  if (["Highlight", "Underline", "StrikeOut", "Squiggly"].includes(subtype)) {
    // QuadPoints order per spec (as readers expect): x1,y2  x2,y2  x1,y1  x2,y1 for each line rect.
    dict.QuadPoints = rects.flatMap(([x1, y1, x2, y2]) => [x1, y2, x2, y2, x1, y1, x2, y1]);
    if (a.text && !contents) dict.Contents = PDFHexString.fromText(a.text);
  } else if (subtype === "Ink") {
    dict.InkList = paths.map((p) => p.flat());
    dict.BS = { W: a.style?.width ?? 2 };
  } else if (subtype === "Line" && pts.length >= 2) {
    dict.L = [pts[0][0], pts[0][1], pts[1][0], pts[1][1]];
    dict.BS = { W: a.style?.width ?? 2 };
    if (a.kind === "arrow") dict.LE = ["None", "OpenArrow"];
  } else if (subtype === "Square" || subtype === "Circle") {
    dict.BS = { W: a.style?.width ?? 2, ...(a.kind === "area" ? { S: "D", D: [4, 3] } : {}) };
  } else if (subtype === "FreeText") {
    const [r, g, b] = hex(a.color);
    dict.DA = PDFString.of(`/Helv 11 Tf ${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
    if (!contents) dict.Contents = PDFHexString.fromText(a.comment ?? "");
  } else if (subtype === "Text") {
    dict.Name = "Comment";
    dict.Open = false;
  }
  const ref = ctx.register(ctx.obj(dict as Parameters<typeof ctx.obj>[0]));
  let annots = page.node.lookup(PDFName.of("Annots")) as PDFArray | undefined;
  if (!(annots instanceof PDFArray)) {
    annots = ctx.obj([]) as PDFArray;
    page.node.set(PDFName.of("Annots"), annots);
  }
  annots.push(ref);
  return true;
}

/** Returns the bytes of a new PDF with the annotations added (the source bytes are never modified). */
export async function exportAnnotatedPdf(source: ArrayBuffer, annotations: Annotation[], author = "Local Lib") {
  const doc = await PDFDocument.load(source, { ignoreEncryption: true, updateMetadata: false });
  const pages = doc.getPages();
  let written = 0;
  for (const a of annotations) {
    if (!("page" in a.anchor)) continue;
    const page = pages[a.anchor.page - 1];
    if (page && addAnnotation(doc, page, a, author)) written++;
  }
  // Ask viewers to regenerate appearance streams for annotations without one.
  const acro = doc.catalog.lookup(PDFName.of("AcroForm")) as PDFDict | undefined;
  if (acro) acro.set(PDFName.of("NeedAppearances"), doc.context.obj(true));
  void PDFNumber;
  return { bytes: await doc.save({ useObjectStreams: false }), written };
}
