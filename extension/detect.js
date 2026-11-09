// Runs inside the page (injected on click). Pure function of `document` + `location` so it's testable.
// Reads Highwire/Google Scholar citation_* tags, Dublin Core, Open Graph, JSON-LD, and URL patterns.
function detectCitation(doc, loc) {
  const meta = (name) => {
    const el = doc.querySelector(`meta[name="${name}" i], meta[property="${name}" i]`);
    return el ? (el.getAttribute("content") || "").trim() : "";
  };
  const metas = (name) => [...doc.querySelectorAll(`meta[name="${name}" i]`)].map((m) => (m.getAttribute("content") || "").trim()).filter(Boolean);
  const href = String(loc.href);
  let doi = meta("citation_doi") || meta("dc.identifier") || meta("prism.doi") || "";
  doi = (doi.match(/10\.\d{4,9}\/\S+/) || href.match(/doi\.org\/(10\.\d{4,9}\/[^?#\s]+)/) || [])[0] || "";
  doi = doi.replace(/^doi:/i, "").replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
  const arxiv = (href.match(/arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})/) || [])[1] || (meta("citation_arxiv_id") || "").replace(/v\d+$/, "");
  const isbn = (meta("citation_isbn") || meta("books:isbn") || "").replace(/[^0-9Xx]/g, "");
  let title = meta("citation_title") || meta("dc.title") || meta("og:title") || doc.title || "";
  let authors = metas("citation_author");
  if (!authors.length) authors = metas("dc.creator");
  let year = (meta("citation_publication_date") || meta("citation_date") || meta("dc.date") || "").match(/(1[5-9]|20)\d{2}/);
  year = year ? Number(year[0]) : null;
  let pdf = meta("citation_pdf_url") || "";
  if (!pdf && arxiv) pdf = `https://arxiv.org/pdf/${arxiv}`;
  if (!pdf && /\.pdf($|\?)/i.test(href)) pdf = href;
  // JSON-LD (ScholarlyArticle / Book)
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const j = JSON.parse(s.textContent || "{}");
      const items = Array.isArray(j) ? j : j["@graph"] || [j];
      for (const it of items) {
        if (!/Article|Book|Chapter|Thesis/i.test(String(it["@type"]))) continue;
        title = title || it.headline || it.name || "";
        if (!authors.length && it.author) authors = [].concat(it.author).map((a) => (typeof a === "string" ? a : a.name)).filter(Boolean);
        if (!year && it.datePublished) year = Number(String(it.datePublished).slice(0, 4)) || null;
      }
    } catch { /* ignore */ }
  }
  // "Last, First" → "First Last"
  authors = authors.map((a) => (a.includes(",") ? a.split(",").map((x) => x.trim()).reverse().join(" ") : a));
  return {
    url: href, title: title.replace(/\s+/g, " ").trim() || null, authors, doi: doi || null, arxiv: arxiv || null, isbn: isbn || null,
    pdf_url: pdf || null, year, publisher: meta("citation_publisher") || meta("dc.publisher") || meta("citation_journal_title") || null,
    abstract_text: meta("citation_abstract") || meta("dc.description") || meta("description") || null,
  };
}
if (typeof module !== "undefined") module.exports = { detectCitation };
