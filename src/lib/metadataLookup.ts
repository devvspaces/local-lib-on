// Online metadata lookup (Zotero-style "Retrieve Metadata"):
//   DOI → Crossref · ISBN → Open Library, then Google Books · otherwise title(+author) search,
// accepted only when the title is a close match. All APIs are free and keyless.
import type { BookPatch } from "@/lib/api";

export interface LookupInput { isbn?: string; isbns?: string[]; doi?: string; title?: string; author?: string }
export type LookupResult = BookPatch & { coverUrl?: string; subjects?: string[] };

const clean = (s?: string | null) => (s ?? "").trim();

async function getJson(url: string) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

/** Token-set Jaccard similarity on normalized titles (main title before ":"). */
export function titleSimilarity(a: string, b: string) {
  const norm = (s: string) => new Set(s.toLowerCase().split(/[:(\[]/)[0].replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 1 && !["the", "a", "an", "of", "and"].includes(w)));
  const A = norm(a), B = norm(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((w) => B.has(w) && inter++);
  return inter / (A.size + B.size - inter);
}

export async function lookupDOI(doi: string): Promise<LookupResult | null> {
  const id = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, "").trim();
  const j = await getJson(`https://api.crossref.org/works/${encodeURIComponent(id)}`);
  const m = j.message;
  if (!m) return null;
  const type = String(m.type ?? "");
  return {
    title: m.title?.[0],
    subtitle: m.subtitle?.[0],
    authors: (m.author ?? []).map((a: { given?: string; family?: string; name?: string }) => a.name ?? `${a.given ?? ""} ${a.family ?? ""}`.trim()),
    year: m.issued?.["date-parts"]?.[0]?.[0] ?? undefined,
    publisher: m.publisher,
    place: m["publisher-location"],
    doi: id,
    isbn: m.ISBN?.[0],
    isbns: m.ISBN,
    num_pages: undefined,
    description: m.abstract ? m.abstract.replace(/<[^>]+>/g, "") : undefined,
    language: m.language,
    item_type: type.includes("journal") || type.includes("proceedings") || type === "posted-content" ? "article" : type.includes("chapter") ? "chapter" : type === "dissertation" ? "thesis" : type === "report" ? "report" : "book",
    metadata_source: "Crossref",
  };
}

async function openLibraryISBN(id: string): Promise<LookupResult | null> {
  const j = await getJson(`https://openlibrary.org/api/books?bibkeys=ISBN:${id}&format=json&jscmd=data`);
  const m = j[`ISBN:${id}`];
  if (!m) return null;
  const ids = m.identifiers ?? {};
  return {
    title: m.title,
    subtitle: m.subtitle,
    authors: (m.authors ?? []).map((a: { name: string }) => a.name),
    year: m.publish_date ? Number(String(m.publish_date).match(/\d{4}/)?.[0]) || undefined : undefined,
    publisher: m.publishers?.[0]?.name,
    place: m.publish_places?.[0]?.name,
    num_pages: m.number_of_pages,
    isbn: id,
    isbns: [...(ids.isbn_13 ?? []), ...(ids.isbn_10 ?? [])],
    coverUrl: m.cover?.large ?? m.cover?.medium,
    subjects: (m.subjects ?? []).slice(0, 8).map((s: { name: string }) => s.name),
    metadata_source: "Open Library",
  };
}

async function googleBooks(q: string): Promise<LookupResult | null> {
  const j = await getJson(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=3&printType=books`);
  const v = j.items?.[0]?.volumeInfo;
  if (!v) return null;
  const isbns = (v.industryIdentifiers ?? []).filter((x: { type: string }) => x.type.startsWith("ISBN")).map((x: { identifier: string }) => x.identifier);
  const edition = String(v.subtitle ?? v.title ?? "").match(/(\d+(?:st|nd|rd|th)|second|third|fourth|fifth|2nd|3rd)\s+edition/i)?.[0];
  return {
    title: v.title,
    subtitle: v.subtitle,
    authors: v.authors,
    year: v.publishedDate ? Number(String(v.publishedDate).slice(0, 4)) || undefined : undefined,
    publisher: v.publisher,
    num_pages: v.pageCount,
    language: v.language,
    description: v.description,
    isbn: isbns.find((x: string) => x.length === 13) ?? isbns[0],
    isbns,
    edition,
    coverUrl: v.imageLinks?.thumbnail?.replace("http://", "https://").replace("&edge=curl", ""),
    subjects: v.categories,
    metadata_source: "Google Books",
  };
}

/** Merge: earlier sources win, later ones fill gaps. */
function merge(...rs: (LookupResult | null)[]): LookupResult | null {
  const xs = rs.filter(Boolean) as LookupResult[];
  if (!xs.length) return null;
  const out: LookupResult = {};
  for (const r of xs) {
    for (const [k, v] of Object.entries(r) as [keyof LookupResult, unknown][]) {
      const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
      if (!empty && (out[k] === undefined || (Array.isArray(out[k]) && !(out[k] as unknown[]).length))) (out as Record<string, unknown>)[k] = v;
    }
  }
  out.isbns = [...new Set(xs.flatMap((r) => r.isbns ?? (r.isbn ? [r.isbn] : [])).map((i) => i.replace(/[^0-9X]/gi, "")))];
  out.metadata_source = xs.map((r) => r.metadata_source).filter(Boolean).join(" + ");
  return out;
}

/** Crossref bibliographic search for papers/articles; returns the full record of a close title match. */
export async function lookupCrossrefTitle(title: string, author?: string): Promise<LookupResult | null> {
  if (!clean(title)) return null;
  const q = encodeURIComponent(`${title} ${author ?? ""}`.trim());
  const j = await getJson(`https://api.crossref.org/works?query.bibliographic=${q}&rows=5&select=DOI,title`);
  const hit = (j.message?.items ?? []).find((it: { title?: string[] }) => titleSimilarity(it.title?.[0] ?? "", title) >= 0.85);
  return hit ? lookupDOI(hit.DOI) : null;
}

export async function lookupISBN(isbn: string): Promise<LookupResult | null> {
  const id = isbn.replace(/[^0-9Xx]/g, "");
  const [ol, gb] = await Promise.all([openLibraryISBN(id).catch(() => null), googleBooks(`isbn:${id}`).catch(() => null)]);
  return merge(ol, gb);
}

export async function lookupTitle(title: string, author?: string): Promise<LookupResult | null> {
  const q = new URLSearchParams({ title, limit: "3", fields: "title,subtitle,author_name,first_publish_year,publisher,publish_place,isbn,language,cover_i,number_of_pages_median" });
  if (author) q.set("author", author);
  const [olj, gb] = await Promise.all([
    getJson(`https://openlibrary.org/search.json?${q}`).catch(() => null),
    googleBooks(`intitle:${title}${author ? ` inauthor:${author}` : ""}`).catch(() => null),
  ]);
  const d = olj?.docs?.find((x: { title: string }) => titleSimilarity(x.title, title) >= 0.85);
  const ol: LookupResult | null = d ? {
    title: d.title, subtitle: d.subtitle, authors: d.author_name, year: d.first_publish_year, publisher: d.publisher?.[0], place: d.publish_place?.[0],
    isbn: d.isbn?.find((x: string) => x.length === 13) ?? d.isbn?.[0], language: d.language?.[0], num_pages: d.number_of_pages_median,
    coverUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : undefined, metadata_source: "Open Library",
  } : null;
  const g = gb && titleSimilarity(gb.title ?? "", title) >= 0.85 ? gb : null;
  return merge(g, ol);
}

export async function lookupMetadata(i: LookupInput): Promise<LookupResult | null> {
  if (clean(i.doi)) { const r = await lookupDOI(i.doi!).catch(() => null); if (r?.title) return r; }
  for (const isbn of [i.isbn, ...(i.isbns ?? [])].filter(Boolean) as string[]) {
    const r = await lookupISBN(isbn).catch(() => null);
    if (r?.title) return r;
  }
  if (clean(i.title)) return lookupTitle(i.title!, i.author);
  return null;
}

function isbnValid(s: string) {
  const d = s.replace(/[^0-9X]/gi, "").toUpperCase();
  if (d.length === 13) {
    const sum = [...d].reduce((a, c, i) => a + Number(c) * (i % 2 ? 3 : 1), 0);
    return sum % 10 === 0;
  }
  if (d.length === 10) {
    const sum = [...d].reduce((a, c, i) => a + (c === "X" ? 10 : Number(c)) * (10 - i), 0);
    return sum % 11 === 0;
  }
  return false;
}

export interface Sniffed { doi?: string; isbn?: string; isbns: string[]; arxiv?: string; edition?: string; publisher?: string; place?: string; year?: number }

const PUBLISHERS = ["O'Reilly", "Manning", "Packt", "Apress", "Addison-Wesley", "Pearson", "Wiley", "No Starch Press", "Pragmatic Bookshelf", "MIT Press", "Cambridge University Press", "Oxford University Press", "Springer", "McGraw-Hill", "Prentice Hall", "CRC Press", "Elsevier", "Morgan Kaufmann", "Microsoft Press", "Princeton University Press", "Penguin", "HarperCollins", "Random House", "Routledge", "SAGE", "Wiley-Blackwell"];

/** Detect identifiers and copyright-page facts in the first/last pages of a book. */
export function sniffIdentifiers(text: string): Sniffed {
  const doi = text.match(/\b(10\.\d{4,9}\/[-._;()/:A-Z0-9]+[A-Z0-9])\b/i)?.[1];
  const isbns: string[] = [];
  for (const m of text.matchAll(/ISBN(?:-1[03])?[:\s]*((?:97[89][-\s]?)?\d{1,5}[-\s]?\d{1,7}[-\s]?\d{1,7}[-\s]?[\dX])\b/gi)) {
    const v = m[1].replace(/[-\s]/g, "").toUpperCase();
    if (isbnValid(v) && !isbns.includes(v)) isbns.push(v);
  }
  // Bare 13-digit ISBNs (978-1-0981-7551-1) on copyright pages without the "ISBN" label.
  for (const m of text.matchAll(/\b(97[89][-\s]\d{1,5}[-\s]\d{1,7}[-\s]\d{1,7}[-\s]\d)\b/g)) {
    const v = m[1].replace(/[-\s]/g, "");
    if (isbnValid(v) && !isbns.includes(v)) isbns.push(v);
  }
  const arxiv = text.match(/arXiv:\s?(\d{4}\.\d{4,5})(v\d+)?/i)?.[1];
  const edition = text.match(/\b(First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|\d+(?:st|nd|rd|th))\s+Edition\b/i)?.[0];
  const publisher = PUBLISHERS.find((p) => new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("'", "['’]")}`, "i").test(text));
  const place = text.match(/Published by [^,\n]+,\s*[^,\n]*?,?\s*([A-Z][a-z]+(?: [A-Z][a-z]+)?),\s*(?:CA|NY|MA|NJ|UK|[A-Z]{2})\b/)?.[1]
    ?? (publisher === "O'Reilly" && /Sebastopol/.test(text) ? "Sebastopol" : undefined);
  const year = Number(text.match(/(?:Copyright|©)\s*(?:©\s*)?((?:19|20)\d{2})/i)?.[1]) || undefined;
  return { doi, isbn: isbns.find((i) => i.length === 13) ?? isbns[0], isbns, arxiv, edition, publisher, place, year };
}

/** PDF producers stamp these into the Author field; they are never real authors. */
export function isJunkAuthor(a: string) {
  const s = a.trim().toLowerCase();
  return !s || s.length < 2 || s.length > 120 || /@/.test(s) || /^(windows user|user|admin(istrator)?|owner|unknown|anonymous|author|default|pc|test|calibre|scanner|epson|canon|hp|ricoh|xerox)\b/.test(s)
    || /^(microsoft|adobe|acrobat|pdf|latex|tex|word|libreoffice|openoffice|google|apple|quartz|ghostscript|itext|nitro)/.test(s);
}
