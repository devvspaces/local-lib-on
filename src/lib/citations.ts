// Citation formatting and bibliographic export (BibTeX, RIS, CSL-JSON).
// Common styles are hand-written so they work offline. CSL-JSON is the hand-off to Zotero/Mendeley/citeproc.
import type { Book } from "@/lib/api";

export type CitationStyle = "apa" | "mla" | "chicago" | "harvard" | "ieee";
export const CITATION_STYLES: { id: CitationStyle; label: string }[] = [
  { id: "apa", label: "APA 7" },
  { id: "mla", label: "MLA 9" },
  { id: "chicago", label: "Chicago (author-date)" },
  { id: "harvard", label: "Harvard" },
  { id: "ieee", label: "IEEE" },
];

interface Name { given: string; family: string }

export function splitName(full: string): Name {
  const s = full.trim();
  if (s.includes(",")) {
    const [family, given] = s.split(",", 2).map((x) => x.trim());
    return { family, given };
  }
  const parts = s.split(/\s+/);
  if (parts.length === 1) return { family: s, given: "" };
  const family = parts.pop()!;
  return { family, given: parts.join(" ") };
}

const initials = (given: string, withSpace = true) =>
  given.split(/[\s-]+/).filter(Boolean).map((g) => g[0].toUpperCase() + ".").join(withSpace ? " " : "");

function joinList(items: string[], last: string) {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} ${last} ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, ${last} ${items[items.length - 1]}`;
}

const titleWithSub = (b: Book) => (b.subtitle ? `${b.title}: ${b.subtitle}` : b.title);
const doiUrl = (b: Book) => (b.doi ? `https://doi.org/${b.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, "")}` : "");

export function formatCitation(b: Book, style: CitationStyle): string {
  const names = b.authors.map(splitName);
  const year = b.year ? String(b.year) : "n.d.";
  const title = titleWithSub(b);
  const pub = b.publisher ? `${b.place && style === "chicago" ? `${b.place}: ` : ""}${b.publisher}.` : "";
  const ed = b.edition ? ` (${b.edition.replace(/\s*edition/i, " ed.")})` : "";
  const doi = doiUrl(b);
  switch (style) {
    case "apa": {
      const a = names.map((n) => (n.given ? `${n.family}, ${initials(n.given)}` : n.family));
      const authors = a.length > 20 ? [...a.slice(0, 19), "…", a[a.length - 1]].join(", ") : joinList(a, "&");
      return [authors && `${authors}`, `(${year}).`, `${title}${ed}.`, pub, doi].filter(Boolean).join(" ").replace(/\.\./g, ".");
    }
    case "mla": {
      let authors = "";
      if (names.length === 1) authors = `${names[0].family}${names[0].given ? ", " + names[0].given : ""}.`;
      else if (names.length === 2) authors = `${names[0].family}, ${names[0].given}, and ${names[1].given} ${names[1].family}.`;
      else if (names.length > 2) authors = `${names[0].family}, ${names[0].given}, et al.`;
      return [authors, `${title}.`, b.publisher ? `${b.publisher},` : "", b.year ? `${b.year}.` : ""].filter(Boolean).join(" ").replace(/,$/, ".");
    }
    case "chicago": {
      const a = names.map((n, i) => (i === 0 ? `${n.family}${n.given ? ", " + n.given : ""}` : `${n.given} ${n.family}`.trim()));
      return [a.length ? `${joinList(a, "and")}.` : "", `${year}.`, `${title}.`, pub, doi].filter(Boolean).join(" ");
    }
    case "harvard": {
      const a = names.map((n) => (n.given ? `${n.family}, ${initials(n.given, false)}` : n.family));
      return [a.length ? joinList(a, "and") : "", `(${year})`, `${title}.`, pub, doi ? `Available at: ${doi}.` : ""].filter(Boolean).join(" ");
    }
    case "ieee": {
      const a = names.map((n) => `${n.given ? initials(n.given) + " " : ""}${n.family}`);
      const authors = a.length > 6 ? `${a[0]} et al.` : joinList(a, "and");
      return [authors && `${authors},`, `${title}.`, b.publisher ? `${b.publisher},` : "", `${year}.`, doi ? `doi: ${b.doi}.` : ""].filter(Boolean).join(" ");
    }
  }
}

export function citeKey(b: Book) {
  const fam = b.authors[0] ? splitName(b.authors[0]).family : "anon";
  const word = b.title.split(/\s+/).find((w) => w.length > 3) ?? b.title.split(/\s+/)[0] ?? "untitled";
  return `${fam}${b.year ?? ""}${word}`.normalize("NFKD").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

const bibEscape = (s: string) => s.replace(/([{}&%$#_])/g, "\\$1");

export function toBibTeX(books: Book[]): string {
  const seen = new Map<string, number>();
  return books
    .map((b) => {
      let key = citeKey(b);
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      if (n) key += String.fromCharCode(97 + n);
      const isArticle = !!b.doi && !b.isbn;
      const fields: [string, string | null | undefined][] = [
        ["title", titleWithSub(b)],
        ["author", b.authors.map((a) => { const x = splitName(a); return x.given ? `${x.family}, ${x.given}` : x.family; }).join(" and ")],
        ["year", b.year?.toString()],
        ["publisher", b.publisher],
        ["address", b.place],
        ["edition", b.edition],
        ["pagetotal", b.num_pages?.toString()],
        ["isbn", b.isbn],
        ["doi", b.doi],
        ["series", b.series],
        ["language", b.language],
        ["abstract", b.description],
        ["file", b.files[0]?.path],
      ];
      const body = fields.filter(([, v]) => v).map(([k, v]) => `  ${k} = {${bibEscape(String(v))}}`).join(",\n");
      return `@${isArticle ? "article" : "book"}{${key},\n${body}\n}`;
    })
    .join("\n\n");
}

export function toRIS(books: Book[]): string {
  return books
    .map((b) => {
      const lines = [`TY  - ${b.doi && !b.isbn ? "JOUR" : "BOOK"}`, `TI  - ${titleWithSub(b)}`];
      b.authors.forEach((a) => { const n = splitName(a); lines.push(`AU  - ${n.given ? `${n.family}, ${n.given}` : n.family}`); });
      if (b.year) lines.push(`PY  - ${b.year}`);
      if (b.publisher) lines.push(`PB  - ${b.publisher}`);
      if (b.isbn) lines.push(`SN  - ${b.isbn}`);
      if (b.doi) lines.push(`DO  - ${b.doi}`);
      if (b.language) lines.push(`LA  - ${b.language}`);
      if (b.description) lines.push(`AB  - ${b.description.replace(/\n+/g, " ")}`);
      b.tags.forEach((t) => lines.push(`KW  - ${t.name}`));
      lines.push("ER  - ");
      return lines.join("\r\n");
    })
    .join("\r\n\r\n");
}

export function toCSLJSON(books: Book[]) {
  return books.map((b) => ({
    id: citeKey(b),
    type: b.item_type === "article" || (b.doi && !b.isbn) ? "article-journal" : b.item_type === "chapter" ? "chapter" : b.item_type === "thesis" ? "thesis" : b.item_type === "report" ? "report" : "book",
    title: titleWithSub(b),
    author: b.authors.map(splitName),
    issued: b.year ? { "date-parts": [[b.year]] } : undefined,
    publisher: b.publisher ?? undefined,
    "publisher-place": b.place ?? undefined,
    edition: b.edition ? (b.edition.match(/\d+/)?.[0] ?? ({ first: "1", second: "2", third: "3", fourth: "4", fifth: "5", sixth: "6" } as Record<string, string>)[b.edition.split(/\s/)[0].toLowerCase()] ?? b.edition) : undefined,
    "number-of-pages": b.num_pages ?? undefined,
    ISBN: b.isbn ?? undefined,
    DOI: b.doi ?? undefined,
    language: b.language ?? undefined,
    abstract: b.description ?? undefined,
    "collection-title": b.series ?? undefined,
  }));
}
