// Full CSL formatting with citeproc-js. Styles/locales come from the official CSL repos via Rust (cached).
import { invoke } from "@tauri-apps/api/core";
// @ts-expect-error citeproc ships CommonJS without types
import CSL from "citeproc";
import type { Book } from "@/lib/api";
import { toCSLJSON } from "@/lib/citations";

export const cslApi = {
  styles: () => invoke<{ id: string }[]>("csl_list_styles"),
  get: (kind: "style" | "locale", id: string) => invoke<string>("csl_get", { kind, id }),
};

const POPULAR = ["apa", "modern-language-association", "chicago-author-date", "chicago-fullnote-bibliography", "harvard-cite-them-right", "ieee", "vancouver", "nature", "american-medical-association", "american-chemical-society", "springer-basic-author-date", "elsevier-harvard", "turabian-fullnote-bibliography", "association-for-computing-machinery"];
export const popularStyles = () => POPULAR;

export const prettyStyle = (id: string) => id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bApa\b/, "APA").replace(/\bIeee\b/, "IEEE");

const locales = new Map<string, string>();

/** Build a citeproc engine for `styleId` over `books`. */
async function engine(styleId: string, books: Book[], lang = "en-US") {
  const style = await cslApi.get("style", styleId);
  if (!locales.has(lang)) locales.set(lang, await cslApi.get("locale", lang));
  const items = new Map(toCSLJSON(books).map((it, i) => [String(books[i].id), { ...it, id: String(books[i].id) }]));
  const sys = {
    retrieveLocale: (l: string) => locales.get(l) ?? locales.get(lang)!,
    retrieveItem: (id: string) => items.get(id),
  };
  const e = new CSL.Engine(sys, style, lang, true);
  e.updateItems([...items.keys()]);
  return e;
}

export interface FormattedBibliography { html: string; text: string; entries: string[] }

export async function formatBibliography(styleId: string, books: Book[], format: "html" | "text" = "html"): Promise<FormattedBibliography> {
  const e = await engine(styleId, books);
  e.setOutputFormat("html");
  const [, html] = e.makeBibliography() ?? [null, []];
  e.setOutputFormat("text");
  const [, text] = e.makeBibliography() ?? [null, []];
  void format;
  return { html: (html as string[]).join(""), text: (text as string[]).join("").trim(), entries: (text as string[]).map((s) => s.trim()) };
}

/** In-text citation for one or more books, optionally with a page locator. */
export async function formatCitation(styleId: string, books: Book[], page?: string) {
  const e = await engine(styleId, books);
  e.setOutputFormat("text");
  const cluster = { citationItems: books.map((b) => ({ id: String(b.id), ...(page ? { locator: page, label: "page" } : {}) })), properties: { noteIndex: 0 } };
  const out = e.previewCitationCluster(cluster, [], [], "text");
  return String(out);
}

/** Put both rich HTML and plain text on the clipboard (Word/Docs keep italics). */
export async function copyRich(html: string, text: string) {
  try {
    await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })]);
  } catch {
    await navigator.clipboard.writeText(text);
  }
}
