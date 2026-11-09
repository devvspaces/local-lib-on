import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

/** Markdown → sanitized HTML. `ann://<id>` links are kept for back-links into the reader. */
export function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(html, { ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|ann|book|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i });
}
