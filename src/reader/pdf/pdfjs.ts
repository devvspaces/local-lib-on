import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import type { TocItem } from "../types";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
export { pdfjs };
export type { PDFDocumentProxy, PDFPageProxy, TextItem };

export async function loadPdf(url: string): Promise<PDFDocumentProxy> {
  const base = new URL("/", window.location.href).href;
  return pdfjs.getDocument({
    url,
    cMapUrl: `${base}pdfjs/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}pdfjs/standard_fonts/`,
    wasmUrl: `${base}pdfjs/wasm/`,
    disableAutoFetch: false,
  }).promise;
}

/** Resolve the PDF outline into page numbers (1-based). */
export async function resolveOutline(doc: PDFDocumentProxy): Promise<TocItem[]> {
  const outline = await doc.getOutline();
  if (!outline) return [];
  const resolve = async (dest: unknown): Promise<number | undefined> => {
    try {
      const d = typeof dest === "string" ? await doc.getDestination(dest) : (dest as unknown[]);
      if (!d || !d[0]) return undefined;
      const ref = d[0];
      if (typeof ref === "number") return ref + 1;
      return (await doc.getPageIndex(ref as Parameters<PDFDocumentProxy["getPageIndex"]>[0])) + 1;
    } catch {
      return undefined;
    }
  };
  type O = { title: string; dest: unknown; items: O[] };
  const walk = async (items: O[]): Promise<TocItem[]> =>
    Promise.all(items.map(async (i) => ({ label: i.title, page: await resolve(i.dest), children: i.items?.length ? await walk(i.items) : undefined })));
  return walk(outline as unknown as O[]);
}

export async function resolveDest(doc: PDFDocumentProxy, dest: unknown): Promise<number | undefined> {
  const [first] = await resolveOutlineDest(doc, dest);
  return first;
}
async function resolveOutlineDest(doc: PDFDocumentProxy, dest: unknown): Promise<[number | undefined]> {
  try {
    const d = typeof dest === "string" ? await doc.getDestination(dest) : (dest as unknown[]);
    if (!d) return [undefined];
    const ref = d[0];
    if (typeof ref === "number") return [ref + 1];
    return [(await doc.getPageIndex(ref as Parameters<PDFDocumentProxy["getPageIndex"]>[0])) + 1];
  } catch {
    return [undefined];
  }
}

type OcrWords = [number, number, number, number, string][];
const ocrLayers = new WeakMap<PDFDocumentProxy, Map<number, OcrWords>>();

/** Register OCR words for pages without a text layer; pageText() then returns them as text items. */
export function setOcrPage(doc: PDFDocumentProxy, page: number, words: OcrWords) {
  let m = ocrLayers.get(doc);
  if (!m) ocrLayers.set(doc, (m = new Map()));
  m.set(page, words);
  textCache.get(doc)?.delete(page);
}
export const ocrWords = (doc: PDFDocumentProxy, page: number) => ocrLayers.get(doc)?.get(page);

function ocrItems(words: OcrWords): TextItem[] {
  // Order words into lines (PDF y grows upward) so text reads naturally.
  const sorted = [...words].sort((a, b) => b[3] - a[3] || a[0] - b[0]);
  const items: TextItem[] = [];
  let lastY: number | null = null;
  for (const [x0, y0, x1, y1, str] of sorted) {
    const h = y1 - y0;
    const newLine = lastY !== null && Math.abs(lastY - y0) > h * 0.5;
    if (newLine && items.length) items[items.length - 1].hasEOL = true;
    items.push({ str: str + " ", dir: "ltr", width: x1 - x0, height: h, transform: [h, 0, 0, h, x0, y0], fontName: "ocr", hasEOL: false } as TextItem);
    lastY = y0;
  }
  return items;
}

const textCache = new WeakMap<PDFDocumentProxy, Map<number, Promise<{ items: TextItem[]; text: string }>>>();

/** Cached text content for a page. `text` joins items with line breaks where pdf.js marks EOL. */
export function pageText(doc: PDFDocumentProxy, pageNum: number, nativeOnly = false) {
  if (nativeOnly) {
    return doc.getPage(pageNum).then(async (page) => {
      const items = (await page.getTextContent()).items.filter((i): i is TextItem => "str" in i);
      return { items, text: items.map((i) => i.str + (i.hasEOL ? "\n" : "")).join("") };
    });
  }
  let m = textCache.get(doc);
  if (!m) textCache.set(doc, (m = new Map()));
  let p = m.get(pageNum);
  if (!p) {
    p = doc.getPage(pageNum).then(async (page) => {
      const tc = await page.getTextContent();
      let items = tc.items.filter((i): i is TextItem => "str" in i);
      const ocr = ocrLayers.get(doc)?.get(pageNum);
      if (ocr?.length && items.map((i) => i.str).join("").replace(/\s/g, "").length < 20) items = ocrItems(ocr);
      const text = items.map((i) => i.str + (i.hasEOL ? "\n" : "")).join("");
      return { items, text };
    });
    m.set(pageNum, p);
  }
  return p;
}

/** Normalize text for search: collapse whitespace, de-hyphenate line breaks. */
export const normalizeForSearch = (s: string) => s.replace(/-\n/g, "").replace(/\s+/g, " ").toLowerCase();
