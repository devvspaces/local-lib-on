// Export notes + annotations: Markdown (Obsidian-friendly), Word (.docx), plain text, and bibliographies.
import { Document, HeadingLevel, Packer, Paragraph, TextRun, ShadingType, ImageRun } from "docx";
import type { Annotation, Book, Note } from "@/lib/api";
import { formatCitation, toBibTeX, toCSLJSON, toRIS, type CitationStyle } from "@/lib/citations";
import { colorLabel } from "@/reader/types";

export interface ExportOptions {
  style: CitationStyle;
  groupBy: "page" | "color" | "tag";
  includeNotes: boolean;
  includeInk: boolean;
}

const where = (a: Annotation) => (a.page_label ? `p. ${a.page_label}` : "");

function groups(anns: Annotation[], by: ExportOptions["groupBy"]): [string, Annotation[]][] {
  if (by === "page") return [["", anns]];
  const m = new Map<string, Annotation[]>();
  for (const a of anns) {
    const keys = by === "color" ? [colorLabel(a.color) ?? a.color ?? "Other"] : a.tags.length ? a.tags : ["Untagged"];
    for (const k of keys) { if (!m.has(k)) m.set(k, []); m.get(k)!.push(a); }
  }
  return [...m.entries()];
}

export function toMarkdown(book: Book, anns: Annotation[], notes: Note[], o: ExportOptions): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`title: "${book.title.replace(/"/g, '\\"')}"`);
  if (book.authors.length) lines.push(`authors: [${book.authors.map((a) => `"${a}"`).join(", ")}]`);
  if (book.year) lines.push(`year: ${book.year}`);
  if (book.isbn) lines.push(`isbn: ${book.isbn}`);
  if (book.doi) lines.push(`doi: ${book.doi}`);
  lines.push(`tags: [${book.tags.map((t) => t.name).join(", ")}]`);
  lines.push(`exported: ${new Date().toISOString()}`);
  lines.push("---", "", `# ${book.title}`, "", `*${formatCitation(book, o.style)}*`, "");
  if (o.includeNotes && notes.length) {
    lines.push("## Notes", "");
    for (const n of notes) lines.push(`### ${n.title || "Note"}`, "", n.body.replace(/\(ann:\/\/[^)]+\)/g, ""), "");
  }
  lines.push("## Annotations", "");
  for (const [g, list] of groups(anns, o.groupBy)) {
    if (g) lines.push(`### ${g}`, "");
    for (const a of list) {
      if (a.kind === "ink" && !o.includeInk) continue;
      const meta = [a.kind !== "highlight" ? a.kind : null, colorLabel(a.color), where(a)].filter(Boolean).join(" · ");
      if (a.text) lines.push(...a.text.split("\n").map((l) => `> ${l}`));
      else if (a.kind === "ink" || a.kind === "rect" || a.kind === "ellipse" || a.kind === "arrow" || a.kind === "line") lines.push(`> *[${a.kind} drawing]*`);
      lines.push(`> — ${meta}`);
      if (a.comment) lines.push("", a.comment);
      if (a.tags.length) lines.push("", a.tags.map((t) => `#${t.replace(/\s+/g, "-")}`).join(" "));
      lines.push("");
    }
  }
  return lines.join("\n");
}

export function toPlainText(book: Book, anns: Annotation[], notes: Note[], o: ExportOptions): string {
  return toMarkdown(book, anns, notes, o).replace(/^---[\s\S]*?---\n/, "").replace(/^#+\s/gm, "").replace(/^> /gm, "  ").replace(/\*/g, "");
}

const HEX = (c: string | null) => (c ?? "#ffd400").replace("#", "").toUpperCase();

export async function toDocx(book: Book, anns: Annotation[], notes: Note[], o: ExportOptions): Promise<Blob> {
  const children: Paragraph[] = [
    new Paragraph({ text: book.title, heading: HeadingLevel.TITLE }),
    new Paragraph({ children: [new TextRun({ text: formatCitation(book, o.style), italics: true })] }),
  ];
  if (o.includeNotes && notes.length) {
    children.push(new Paragraph({ text: "Notes", heading: HeadingLevel.HEADING_1 }));
    for (const n of notes) {
      children.push(new Paragraph({ text: n.title || "Note", heading: HeadingLevel.HEADING_2 }));
      for (const para of n.body.replace(/\(ann:\/\/[^)]+\)/g, "").split(/\n{2,}/)) {
        const isQuote = para.startsWith(">");
        children.push(new Paragraph({ children: [new TextRun({ text: para.replace(/^>\s?/gm, ""), italics: isQuote })], indent: isQuote ? { left: 480 } : undefined }));
      }
    }
  }
  children.push(new Paragraph({ text: "Annotations", heading: HeadingLevel.HEADING_1 }));
  for (const [g, list] of groups(anns, o.groupBy)) {
    if (g) children.push(new Paragraph({ text: g, heading: HeadingLevel.HEADING_2 }));
    for (const a of list) {
      if (a.kind === "ink" && !o.includeInk) continue;
      if (a.text) {
        children.push(new Paragraph({
          children: [new TextRun({ text: a.text, shading: a.kind === "highlight" ? { type: ShadingType.CLEAR, fill: HEX(a.color), color: "auto" } : undefined, underline: a.kind === "underline" ? {} : undefined, strike: a.kind === "strike" })],
          indent: { left: 360 },
        }));
      }
      if (a.style?.image) {
        const data = Uint8Array.from(atob(a.style.image.split(",")[1]), (c) => c.charCodeAt(0));
        children.push(new Paragraph({ children: [new ImageRun({ type: "png", data, transformation: { width: 360, height: 240 } })] }));
      }
      children.push(new Paragraph({ children: [new TextRun({ text: [a.kind, colorLabel(a.color), where(a)].filter(Boolean).join(" · "), size: 18, color: "777777" })], indent: { left: 360 } }));
      if (a.comment) children.push(new Paragraph({ children: [new TextRun({ text: a.comment })], indent: { left: 360 } }));
      if (a.tags.length) children.push(new Paragraph({ children: [new TextRun({ text: a.tags.map((t) => `#${t}`).join(" "), color: "B4532A", size: 18 })], indent: { left: 360 } }));
      children.push(new Paragraph({ text: "" }));
    }
  }
  const doc = new Document({ creator: "Local Lib", title: book.title, sections: [{ children }] });
  return Packer.toBlob(doc);
}

export const bibliography = {
  bibtex: (books: Book[]) => toBibTeX(books),
  ris: (books: Book[]) => toRIS(books),
  csljson: (books: Book[]) => JSON.stringify(toCSLJSON(books), null, 2),
};
