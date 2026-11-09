import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search } from "lucide-react";
import DOMPurify from "dompurify";
import { api, type Book, type FtsHit } from "@/lib/api";
import { useApp } from "@/store/app";
import { embedApi } from "@/lib/assistant";
import { BookCover } from "@/views/library/BookCover";

/** Survives leaving the Search tab (e.g. to open a hit) so coming back shows the same results and scroll. */
const cache = { q: "", meaning: false, hits: [] as FtsHit[], meta: [] as Book[], key: "", scroll: 0 };

/** Library-wide full-text search (SQLite FTS5) — inside every indexed book, plus titles/authors/notes. */
export function SearchView() {
  const [q, setQ] = useState(cache.q);
  const [hits, setHits] = useState<FtsHit[]>(cache.hits);
  const [meta, setMeta] = useState<Book[]>(cache.meta);
  const [busy, setBusy] = useState(false);
  const [meaning, setMeaning] = useState(cache.meaning);
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (scroller.current) scroller.current.scrollTop = cache.scroll; }, []);
  useEffect(() => { cache.q = q; cache.meaning = meaning; }, [q, meaning]);
  const [books, setBooks] = useState<Map<number, Book>>(new Map());
  const openBook = useApp((s) => s.openBook);
  const version = useApp((s) => s.libraryVersion);

  useEffect(() => { api.listBooks({}).then((b) => setBooks(new Map(b.map((x) => [x.id, x])))); }, [version]);

  useEffect(() => {
    const key = `${meaning}:${q}`;
    if (key === cache.key) return; // results for this exact query are already showing
    const t = setTimeout(async () => {
      if (q.trim().length < 2) { setHits([]); setMeta([]); cache.key = ""; cache.hits = []; cache.meta = []; return; }
      setBusy(true);
      const [h, m] = await Promise.all([
        meaning
          ? embedApi.search(q, null, 40).then((ps) => ps.map((p) => ({ book_id: p.book_id, title: p.title, loc: p.loc, snippet: p.text.slice(0, 280) + (p.text.length > 280 ? "…" : "") }))).catch(() => [])
          : api.searchFulltext(q, undefined, 300).catch(() => []),
        api.listBooks({ text: q }),
      ]);
      setHits(h);
      setMeta(m.slice(0, 12));
      Object.assign(cache, { key, hits: h, meta: m.slice(0, 12), scroll: 0 });
      setBusy(false);
    }, meaning ? 450 : 220);
    return () => clearTimeout(t);
  }, [q, meaning]);

  const grouped = useMemo(() => {
    const m = new Map<number, FtsHit[]>();
    for (const h of hits) { if (!m.has(h.book_id)) m.set(h.book_id, []); m.get(h.book_id)!.push(h); }
    return [...m.entries()];
  }, [hits]);

  const go = (h: FtsHit) => {
    const page = h.loc.startsWith("p") ? Number(h.loc.slice(1)) : undefined;
    openBook(h.book_id, h.title, { page, loc: h.loc, query: q.replace(/["*]/g, "") });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-6 py-4">
        <div className="relative mx-auto max-w-3xl">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder='Search inside all your books…  (use "exact phrase", AND, OR, NEAR(a b, 5))' className="h-11 w-full rounded-lg border bg-card pl-10 pr-10 text-[15px] outline-none focus:ring-2 focus:ring-ring" />
          {busy && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />}
        </div>
        <div className="mx-auto mt-2 flex max-w-3xl gap-1 text-xs">
          <button onClick={() => setMeaning(false)} className={`rounded px-2 py-0.5 cursor-pointer ${!meaning ? "bg-accent text-accent-foreground" : "text-muted-foreground"}`}>Exact words</button>
          <button onClick={() => setMeaning(true)} title="Finds passages about the same idea even without matching words (needs embeddings in Settings → AI)" className={`rounded px-2 py-0.5 cursor-pointer ${meaning ? "bg-accent text-accent-foreground" : "text-muted-foreground"}`}>Meaning</button>
        </div>
      </div>
      <div ref={scroller} onScroll={(e) => { cache.scroll = e.currentTarget.scrollTop; }} className="flex-1 overflow-y-auto custom-scrollbar">
        <div className="mx-auto max-w-3xl px-6 py-5">
          {meta.length > 0 && (
            <div className="mb-6">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Books</h2>
              <div className="flex gap-3 overflow-x-auto pb-2 custom-scrollbar">
                {meta.map((b) => (
                  <button key={b.id} onClick={() => openBook(b.id, b.title)} className="w-24 shrink-0 text-left cursor-pointer">
                    <div className="aspect-[2/3] overflow-hidden rounded shadow-sm"><BookCover book={b} /></div>
                    <p className="mt-1 line-clamp-2 text-xs font-medium">{b.title}</p>
                  </button>
                ))}
              </div>
            </div>
          )}
          {q.trim().length >= 2 && !busy && (
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{hits.length ? `${hits.length} passages in ${grouped.length} books` : "No passages found"}</h2>
          )}
          {grouped.map(([id, list]) => {
            const b = books.get(id);
            return (
              <div key={id} className="mb-5">
                <p className="mb-1 text-[13px] font-semibold">{b?.title ?? list[0].title} <span className="font-normal text-muted-foreground">{b?.authors.join(", ")}</span></p>
                <div className="space-y-1">
                  {list.slice(0, 8).map((h, i) => (
                    <button key={i} onClick={() => go(h)} className="block w-full rounded-md border bg-card px-3 py-2 text-left text-[13px] leading-relaxed hover:border-primary/40 cursor-pointer">
                      <span className="mr-2 text-[11px] font-medium text-muted-foreground">{h.loc.startsWith("p") ? `p. ${h.loc.slice(1)}` : `§${h.loc.slice(1)}`}</span>
                      <span dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(h.snippet, { ALLOWED_TAGS: ["mark"] }) }} data-selectable />
                    </button>
                  ))}
                  {list.length > 8 && <p className="px-1 text-xs text-muted-foreground">+{list.length - 8} more in this book</p>}
                </div>
              </div>
            );
          })}
          {!q && <p className="text-center text-sm text-muted-foreground">Books are indexed in the background after you add them. Scanned PDFs become searchable after OCR (open the book → Make searchable).</p>}
        </div>
      </div>
    </div>
  );
}
