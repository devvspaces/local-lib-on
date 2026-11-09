// DOCX / ODT → in-memory EPUB 3, so office documents open in the reflowable reader with CFI annotations,
// TTS, search and full-text indexing. DOCX via mammoth (keeps headings, lists, tables, images);
// ODT via a small content.xml mapper.
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface OfficeMeta { title?: string; creator?: string; language?: string; date?: string; description?: string }

export async function docxToHtml(buf: ArrayBuffer): Promise<{ html: string; meta: OfficeMeta }> {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.convertToHtml({ arrayBuffer: buf }, { convertImage: mammoth.images.dataUri });
  const files = unzipSync(new Uint8Array(buf), { filter: (f) => f.name === "docProps/core.xml" });
  const core = files["docProps/core.xml"] ? strFromU8(files["docProps/core.xml"]) : "";
  const tag = (t: string) => core.match(new RegExp(`<${t}[^>]*>([^<]*)</${t}>`))?.[1]?.trim() || undefined;
  return { html: value, meta: { title: tag("dc:title"), creator: tag("dc:creator"), language: tag("dc:language"), date: tag("dcterms:created"), description: tag("dc:description") } };
}

/** Minimal ODF text → HTML: headings, paragraphs, lists, tables, spans, line breaks, embedded images. */
export function odtToHtml(buf: ArrayBuffer): { html: string; meta: OfficeMeta } {
  const files = unzipSync(new Uint8Array(buf));
  const content = new DOMParser().parseFromString(strFromU8(files["content.xml"]), "application/xml");
  const metaDoc = files["meta.xml"] ? new DOMParser().parseFromString(strFromU8(files["meta.xml"]), "application/xml") : null;
  const mt = (name: string) => metaDoc?.getElementsByTagName(name)[0]?.textContent?.trim() || undefined;
  const img = (href: string) => {
    const data = files[href];
    if (!data) return "";
    const ext = href.split(".").pop()?.toLowerCase() ?? "png";
    let bin = "";
    for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
    return `<img src="data:image/${ext === "jpg" ? "jpeg" : ext};base64,${btoa(bin)}" alt=""/>`;
  };
  const walk = (n: Node): string => {
    if (n.nodeType === Node.TEXT_NODE) return esc(n.textContent ?? "");
    if (n.nodeType !== Node.ELEMENT_NODE) return "";
    const el = n as Element;
    const kids = () => Array.from(el.childNodes).map(walk).join("");
    switch (el.localName) {
      case "h": { const l = Math.min(6, Number(el.getAttribute("text:outline-level")) || 1); return `<h${l}>${kids()}</h${l}>`; }
      case "p": return `<p>${kids() || "&#160;"}</p>`;
      case "span": return kids();
      case "s": return " ".repeat(Number(el.getAttribute("text:c")) || 1);
      case "tab": return "\t";
      case "line-break": return "<br/>";
      case "list": return `<ul>${kids()}</ul>`;
      case "list-item": return `<li>${kids()}</li>`;
      case "table": return `<table>${kids()}</table>`;
      case "table-row": return `<tr>${kids()}</tr>`;
      case "table-cell": return `<td>${kids()}</td>`;
      case "a": return `<a href="${esc(el.getAttribute("xlink:href") ?? "#")}">${kids()}</a>`;
      case "image": return img(el.getAttribute("xlink:href") ?? "");
      case "note": return ""; // footnotes omitted from the flow
      default: return kids();
    }
  };
  const body = content.getElementsByTagName("office:text")[0];
  return { html: body ? walk(body) : "", meta: { title: mt("dc:title"), creator: mt("dc:creator") ?? mt("meta:initial-creator"), language: mt("dc:language"), date: mt("dc:date"), description: mt("dc:description") } };
}

/** Split HTML into chapters at h1/h2 so the EPUB has a usable table of contents. */
export function splitChapters(html: string): { title: string; html: string }[] {
  const parts = html.split(/(?=<h[12][\s>])/i).filter((p) => p.replace(/<[^>]+>/g, "").trim());
  if (!parts.length) return [{ title: "Document", html: html || "<p></p>" }];
  return parts.map((p, i) => ({ title: (p.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/i)?.[1] ?? "").replace(/<[^>]+>/g, "").trim() || (i === 0 ? "Start" : `Part ${i + 1}`), html: p }));
}

/** Well-formed XHTML for EPUB (closes void tags, escapes stray ampersands). */
const xhtml = (s: string) => s.replace(/<(br|hr|img|col|input|meta|link)([^>]*?)\s*\/?>/gi, "<$1$2/>").replace(/&(?!(?:[a-z]+|#\d+|#x[0-9a-f]+);)/gi, "&amp;");

export function buildEpub(title: string, meta: OfficeMeta, chapters: { title: string; html: string }[]): Uint8Array {
  const id = `urn:uuid:${crypto.randomUUID()}`;
  const page = (c: { title: string; html: string }) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><meta charset="utf-8"/><title>${esc(c.title)}</title>
<style>table{border-collapse:collapse}td,th{border:1px solid #9994;padding:.2em .4em}img{max-width:100%}</style></head><body>${xhtml(c.html)}</body></html>`;
  const files: Zippable = {
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
    "OEBPS/content.opf": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">${id}</dc:identifier><dc:title>${esc(meta.title || title)}</dc:title><dc:language>${esc(meta.language || "en")}</dc:language>
${meta.creator ? `<dc:creator>${esc(meta.creator)}</dc:creator>` : ""}${meta.date ? `<dc:date>${esc(meta.date)}</dc:date>` : ""}${meta.description ? `<dc:description>${esc(meta.description)}</dc:description>` : ""}
<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</meta></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chapters.map((_, i) => `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`).join("")}</manifest>
<spine>${chapters.map((_, i) => `<itemref idref="c${i}"/>`).join("")}</spine></package>`),
    "OEBPS/nav.xhtml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${chapters.map((c, i) => `<li><a href="c${i}.xhtml">${esc(c.title)}</a></li>`).join("")}</ol></nav></body></html>`),
  };
  chapters.forEach((c, i) => { files[`OEBPS/c${i}.xhtml`] = strToU8(page(c)); });
  return zipSync(files);
}

/** Office file → EPUB File for foliate-js. */
export async function officeToEpubFile(buf: ArrayBuffer, name: string, format: "docx" | "odt") {
  const { html, meta } = format === "docx" ? await docxToHtml(buf) : odtToHtml(buf);
  const title = meta.title || name.replace(/\.\w+$/, "");
  const bytes = buildEpub(title, meta, splitChapters(html));
  return { file: new File([bytes], `${title}.epub`, { type: "application/epub+zip" }), meta };
}
