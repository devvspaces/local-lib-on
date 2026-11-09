// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// detect.js is a classic script injected into pages; evaluate it the same way.
const code = readFileSync(resolve(__dirname, "../../extension/detect.js"), "utf8");
const detectCitation = new Function(`${code}; return detectCitation;`)() as (d: Document, l: { href: string }) => Record<string, unknown>;

describe("extension detectCitation", () => {
  it("reads Highwire citation tags", () => {
    document.head.innerHTML = `
      <meta name="citation_title" content="Designing Data-Intensive Applications">
      <meta name="citation_author" content="Kleppmann, Martin">
      <meta name="citation_doi" content="10.5555/3175818">
      <meta name="citation_publication_date" content="2017/03/16">
      <meta name="citation_pdf_url" content="https://example.org/ddia.pdf">`;
    const r = detectCitation(document, { href: "https://example.org/book" });
    expect(r).toMatchObject({ title: "Designing Data-Intensive Applications", authors: ["Martin Kleppmann"], doi: "10.5555/3175818", year: 2017, pdf_url: "https://example.org/ddia.pdf" });
  });
  it("derives arXiv ids and PDF links from the URL", () => {
    document.head.innerHTML = `<title>Attention</title>`;
    const r = detectCitation(document, { href: "https://arxiv.org/abs/1706.03762v7" });
    expect(r.arxiv).toBe("1706.03762");
    expect(r.pdf_url).toBe("https://arxiv.org/pdf/1706.03762");
  });
});
