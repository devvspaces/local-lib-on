// Metadata + cover enrichment, run in the background for every book (no need to open it first).
// 1. Embedded metadata (PDF Info/XMP, EPUB OPF via foliate)  2. identifiers & copyright facts from the
// first/last pages  3. online lookup (Crossref / Open Library / Google Books) when a confident match exists.
import { api, fileUrl, primaryFile, type Book, type BookPatch } from "@/lib/api";
import { isJunkAuthor, lookupMetadata, sniffIdentifiers, titleSimilarity, type LookupResult } from "@/lib/metadataLookup";

export async function toJpegBase64(src: Blob | string | HTMLCanvasElement, maxW = 360): Promise<string> {
  let source: CanvasImageSource;
  let w: number, h: number;
  let revoke: string | null = null;
  if (src instanceof HTMLCanvasElement) { source = src; w = src.width; h = src.height; }
  else {
    const url = typeof src === "string" ? src : (revoke = URL.createObjectURL(src));
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = url;
    await img.decode();
    source = img; w = img.naturalWidth; h = img.naturalHeight;
  }
  try {
    const scale = Math.min(1, maxW / w);
    const c = document.createElement("canvas");
    c.width = Math.round(w * scale);
    c.height = Math.round(h * scale);
    c.getContext("2d")!.drawImage(source, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.85);
  } finally {
    if (revoke) URL.revokeObjectURL(revoke);
  }
}

const str = (v: unknown) => (typeof v === "string" ? v.replace(/\0/g, "").trim() : undefined);
const plausibleTitle = (t?: string) => !!t && t.length > 2 && !/^(untitled|microsoft word|document\d*|title|\S+\.(docx?|pdf|tex|dvi|indd|qxd))/i.test(t);
const splitAuthors = (s: string) => s.split(/\s*(?:;|\band\b|&|,(?=\s*[A-Z][\p{L}.-]+\s+[A-Z]))\s*/u).map((x) => x.trim()).filter((x) => x && !isJunkAuthor(x));

interface Extracted {
  patch: BookPatch;
  cover?: HTMLCanvasElement | Blob;
  coverIsBlank?: boolean;
  text: string;
}

async function extractPdf(path: string): Promise<Extracted> {
  const { loadPdf, pageText } = await import("@/reader/pdf/pdfjs");
  const { contentBox } = await import("@/reader/pdf/layout");
  const doc = await loadPdf(fileUrl(path));
  try {
    const patch: BookPatch = { num_pages: doc.numPages };
    const meta = await doc.getMetadata().catch(() => null);
    const info = (meta?.info ?? {}) as Record<string, unknown>;
    const xmp = meta?.metadata;
    const title = str(xmp?.get("dc:title")) ?? str(info.Title);
    if (plausibleTitle(title)) patch.title = title;
    const author = str(xmp?.get("dc:creator")) ?? str(info.Author);
    const authors = author ? splitAuthors(author) : [];
    if (authors.length) patch.authors = authors;
    const xdoi = str(xmp?.get("prism:doi")) ?? str(xmp?.get("dc:identifier"))?.match(/10\.\d{4,9}\/\S+/)?.[0];
    if (xdoi) patch.doi = xdoi;

    const n = doc.numPages;
    const pages = [...new Set([1, 2, 3, 4, 5, 6, n - 1, n].filter((p) => p >= 1 && p <= n))];
    const text = (await Promise.all(pages.map((p) => pageText(doc, p).then((t) => t.text).catch(() => "")))).join("\n");

    // Cover: page 1 rendered.
    const page = await doc.getPage(1);
    const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 400 / v1.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    await page.render({ canvas, viewport: vp }).promise;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const box = contentBox(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
    // "Blank-ish" first page: little ink area → prefer an online cover if we find one.
    const inkArea = box ? (1 - box.left - box.right) * (1 - box.top - box.bottom) : 0;
    return { patch, cover: canvas, coverIsBlank: inkArea < 0.12, text };
  } finally {
    doc.loadingTask.destroy();
  }
}

async function extractFoliate(path: string): Promise<Extracted> {
  const { makeBook } = await import("foliate-js/view.js");
  const { foliateMeta } = await import("@/reader/foliate/FoliateReader");
  const name = path.split("/").pop() ?? "book";
  const ext = name.split(".").pop()?.toLowerCase();
  let input: File;
  if (ext === "docx" || ext === "odt") {
    const { officeToEpubFile } = await import("@/lib/officeToEpub");
    input = (await officeToEpubFile(await (await fetch(fileUrl(path))).arrayBuffer(), name, ext)).file;
  } else input = new File([await (await fetch(fileUrl(path))).blob()], name);
  const book = await makeBook(input);
  const m = foliateMeta(book.metadata);
  const patch: BookPatch = {
    title: m.title, authors: m.authors?.filter((a) => !isJunkAuthor(a)), language: m.language, publisher: m.publisher, description: m.description, year: m.year,
  };
  const isbn = m.identifier?.match(/(97[89]\d{10}|\d{9}[\dX])/)?.[1];
  if (isbn) patch.isbn = isbn;
  let text = "";
  for (const s of (book.sections as { createDocument?: () => Promise<Document> }[]).slice(0, 4)) {
    try { text += (await s.createDocument?.())?.body?.textContent ?? ""; } catch { /* ignore */ }
  }
  const cover = (await book.getCover?.().catch(() => null)) ?? undefined;
  return { patch, cover: cover ?? undefined, coverIsBlank: !cover, text };
}

async function extractDjvuMeta(path: string): Promise<Extracted> {
  const { openDjvu, pageCanvas } = await import("@/reader/djvu/djvu");
  const doc = await openDjvu(path);
  const n = doc.getPagesQuantity();
  const { canvas } = await pageCanvas(doc, 1);
  let text = "";
  for (const p of [1, 2, 3, 4, n].filter((x, i, a) => x >= 1 && x <= n && a.indexOf(x) === i)) { try { text += (await doc.getPage(p)).getText() + "\n"; } catch { /* ignore */ } }
  return { patch: { num_pages: n }, cover: canvas, coverIsBlank: false, text };
}

export function applyOnline(patch: BookPatch, online: LookupResult) {
  // Online data is authoritative for bibliographic fields; embedded/file data fills the rest.
  for (const k of ["title", "subtitle", "authors", "year", "publisher", "place", "edition", "language", "num_pages", "description", "doi", "isbn", "isbns", "item_type", "metadata_source"] as const) {
    const v = online[k];
    if (v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length)) (patch as Record<string, unknown>)[k] = v;
  }
}

export async function enrichBook(book: Book): Promise<boolean> {
  const f = primaryFile(book);
  if (!f || f.missing) return false;
  const ex = f.format === "pdf" ? await extractPdf(f.path) : f.format === "djvu" ? await extractDjvuMeta(f.path) : await extractFoliate(f.path);
  const patch: BookPatch = { ...ex.patch, only_missing: true };
  const sn = sniffIdentifiers(ex.text);
  patch.doi ??= sn.doi;
  patch.isbn ??= sn.isbn;
  if (sn.isbns.length) patch.isbns = sn.isbns;
  patch.edition ??= sn.edition;
  patch.publisher ??= sn.publisher;
  patch.place ??= sn.place;
  patch.year ??= sn.year ?? undefined;
  if (book.year && patch.year && patch.year < 1900) delete patch.year;

  const titleGuess = patch.title ?? book.title;
  let online: LookupResult | null = null;
  try {
    online = await lookupMetadata({ doi: patch.doi ?? undefined, isbn: patch.isbn ?? undefined, isbns: sn.isbns, title: titleGuess, author: patch.authors?.[0] ?? book.authors[0] });
    // Identifier hits are trusted; title hits must still look like the same book.
    if (online && !patch.doi && !patch.isbn && titleSimilarity(online.title ?? "", titleGuess) < 0.85) online = null;
  } catch { online = null; }
  // A confident online match replaces filename guesses — unless the user edited metadata by hand.
  if (online) {
    applyOnline(patch, online);
    if (book.metadata_source !== "manual") patch.only_missing = false;
  }
  if (!patch.authors?.length) delete patch.authors;
  if (patch.item_type === undefined && (patch.doi && !patch.isbn)) patch.item_type = "article";
  await api.updateBook(book.id, patch);
  await api.updateBook(book.id, { only_missing: true }); // marks the book as enriched

  if (!book.cover_path) {
    try {
      let b64: string | null = null;
      if (online?.coverUrl && ex.coverIsBlank) b64 = await toJpegBase64(online.coverUrl).catch(() => null);
      if (!b64 && ex.cover) b64 = await toJpegBase64(ex.cover);
      if (!b64 && online?.coverUrl) b64 = await toJpegBase64(online.coverUrl).catch(() => null);
      if (b64) await api.saveCover(book.id, b64);
    } catch (e) {
      console.warn("[enrich] cover failed", e);
    }
  }
  return true;
}

/** Embedded metadata + text of the first/last pages (used by Identify). */
export async function extractForIdentify(book: Book): Promise<{ patch: BookPatch; text: string } | null> {
  const f = primaryFile(book);
  if (!f || f.missing) return null;
  const ex = f.format === "pdf" ? await extractPdf(f.path) : f.format === "djvu" ? await extractDjvuMeta(f.path) : await extractFoliate(f.path);
  return { patch: ex.patch, text: ex.text };
}

/** Called when a book is opened in the reader and hasn't been enriched yet. */
export async function enrichFromReader(book: Book, _engine: unknown, _info: unknown) {
  return enrichBook(book);
}
