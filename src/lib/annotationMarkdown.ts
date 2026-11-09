import type { Annotation } from "@/lib/api";

export function annotationToMarkdown(a: Annotation, bookTitle?: string) {
  const where = [bookTitle, a.page_label ? `p. ${a.page_label}` : null].filter(Boolean).join(", ");
  const quote = a.text ? a.text.split("\n").map((l) => `> ${l}`).join("\n") : "";
  const link = `[${where || "source"}](ann://${a.id})`;
  return `${quote}${quote ? "\n> — " : ""}${link}${a.comment ? `\n\n${a.comment}` : ""}${a.tags.length ? `\n\n${a.tags.map((t) => `#${t}`).join(" ")}` : ""}\n`;
}

