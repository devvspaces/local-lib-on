import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Loader2, RefreshCcw, Search, TextSearch } from "lucide-react";
import DOMPurify from "dompurify";
import { providers, downloadBest, type AuthorPage, type FulltextHit, type ProviderMeta, type Query, type RemoteBook, type SyncResult } from "@/lib/providers";
import { useApp } from "@/store/app";
import { useProviders } from "@/hooks/useProviders";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { toast, toastError } from "@/components/ui/toast";
import { RemoteCard, RemoteCover } from "./RemoteCard";
import { RemoteDetails } from "./RemoteDetails";
import { askText } from "@/components/ui/prompt";

type Mode = "books" | "fulltext";

export function DiscoverView() {
  const list = useProviders();
  const [provider, setProvider] = useState("openlibrary");
  const [mode, setMode] = useState<Mode>("books");
  const [q, setQ] = useState<Query>({ text: "" });
  const [adv, setAdv] = useState(false);
  const [results, setResults] = useState<RemoteBook[]>([]);
  const [hits, setHits] = useState<FulltextHit[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<SyncResult | null>(null);
  const [selected, setSelected] = useState<RemoteBook | null>(null);
  const [author, setAuthor] = useState<AuthorPage | null>(null);
  const [downloading, setDownloading] = useState<Set<string>>(new Set());
  const version = useApp((s) => s.libraryVersion);

  useEffect(() => { if (list.length && !list.some((p) => p.id === provider)) setProvider("openlibrary"); }, [list, provider]);
  const meta = list.find((p) => p.id === provider);

  const shown = author ? author.books : results;
  useEffect(() => {
    if (!shown.length) { setMatches(null); return; }
    providers.match(shown).then(setMatches).catch(() => {});
  }, [shown, version]);
  const localOf = useMemo(() => {
    const m = new Map<string, number | null>();
    matches?.items.forEach((i) => i.status === "in_library" && m.set(`${i.book.provider}:${i.book.id}`, i.local_book_id));
    return m;
  }, [matches]);

  const run = async (p = 1) => {
    setBusy(true); setError(null); setAuthor(null);
    try {
      if (mode === "fulltext") {
        const h = await providers.fulltext(provider, q.text ?? "", p);
        setHits(p === 1 ? h : [...hits, ...h]);
        setHasMore(h.length >= 20);
      } else {
        const r = await providers.search(provider, { ...q, page: p });
        setResults(p === 1 ? r.items : [...results, ...r.items]);
        setHasMore(r.has_more);
        setTotal(r.total);
      }
      setPage(p);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const openAuthor = async (prov: string, id: string, name: string) => {
    setBusy(true); setSelected(null);
    try { setAuthor(await providers.author(prov, id)); } catch (e) { toastError(`Could not load ${name}`, e); } finally { setBusy(false); }
  };

  const dl = async (b: RemoteBook) => {
    setDownloading((s) => new Set(s).add(b.id));
    try { await downloadBest(b); toast("Download queued", b.title); } catch (e) { toastError("Download failed", e); }
    finally { setDownloading((s) => { const n = new Set(s); n.delete(b.id); return n; }); }
  };

  const saveAsSync = async () => {
    const name = await askText({ title: "Save as sync", description: "A sync compares this search with your library and shows what you're missing. Find it in the Sync tab.", label: "Name", placeholder: "e.g. Everything by Le Guin", initial: author?.name ?? q.author ?? q.text ?? "", okLabel: "Save sync" });
    if (!name) return;
    const query: Query = author ? { author: author.name, downloadable: q.downloadable } : q;
    await providers.saveSyncQuery(name, provider, query);
    toast("Sync saved", "Open Sync to check what you're missing.");
  };

  return (
    <div className="flex h-full">
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 border-b px-5 py-3">
          <form onSubmit={(e) => { e.preventDefault(); run(1); }} className="flex items-center gap-2">
            <select value={provider} onChange={(e) => { setProvider(e.target.value); setResults([]); setHits([]); setAuthor(null); if (!list.find((p) => p.id === e.target.value)?.fulltext) setMode("books"); }} className="h-9 rounded-md border bg-card px-2 text-[13px]" aria-label="Provider">
              {list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input value={q.text ?? ""} onChange={(e) => setQ({ ...q, text: e.target.value })} placeholder={mode === "fulltext" ? "Search inside books — a phrase you remember…" : "Title, author, subject, ISBN…"} className="h-9 w-full rounded-md border bg-card pl-8 pr-2 text-[13px] outline-none focus:ring-2 focus:ring-ring" />
            </div>
            {meta?.fulltext && (
              <div className="flex rounded-md border p-0.5">
                <button type="button" onClick={() => setMode("books")} className={cn("rounded px-2 py-1 text-xs cursor-pointer", mode === "books" && "bg-accent text-accent-foreground")}>Books</button>
                <button type="button" onClick={() => setMode("fulltext")} className={cn("flex items-center gap-1 rounded px-2 py-1 text-xs cursor-pointer", mode === "fulltext" && "bg-accent text-accent-foreground")}><TextSearch className="h-3.5 w-3.5" /> Inside books</button>
              </div>
            )}
            <Button type="submit" size="sm" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : "Search"}</Button>
          </form>
          {mode === "books" && (
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!q.downloadable} onChange={(e) => setQ({ ...q, downloadable: e.target.checked })} /> Free downloads only</label>
              <button onClick={() => setAdv(!adv)} className="text-muted-foreground hover:text-foreground cursor-pointer">{adv ? "Hide" : "Advanced"} fields</button>
              {adv && (["title", "author", "subject", "language"] as const).map((k) => (
                <input key={k} value={q[k] ?? ""} onChange={(e) => setQ({ ...q, [k]: e.target.value || undefined })} placeholder={k} className="h-7 w-32 rounded border bg-card px-2 capitalize outline-none focus:ring-2 focus:ring-ring" />
              ))}
              {(results.length > 0 || author) && <button onClick={saveAsSync} className="ml-auto flex items-center gap-1 text-primary hover:underline cursor-pointer"><RefreshCcw className="h-3 w-3" /> Save as sync</button>}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar">
          {error && <p className="m-5 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" data-selectable>{error}</p>}
          {author && (
            <div className="flex gap-4 border-b px-5 py-4">
              <button onClick={() => setAuthor(null)} className="self-start rounded p-1 hover:bg-secondary cursor-pointer" aria-label="Back"><ArrowLeft className="h-4 w-4" /></button>
              {author.photo_url && <img src={author.photo_url} alt="" className="h-24 w-20 rounded object-cover" />}
              <div className="min-w-0 flex-1">
                <h2 className="font-serif text-xl font-semibold">{author.name}</h2>
                <p className="text-xs text-muted-foreground">{[author.birth_date, author.death_date].filter(Boolean).join(" – ")} · {author.books.length} works{matches ? ` · ${matches.in_library} in your library` : ""}</p>
                {author.bio && <p className="mt-2 line-clamp-4 text-[13px] text-muted-foreground" data-selectable>{author.bio}</p>}
              </div>
            </div>
          )}
          {!busy && !error && !shown.length && !hits.length && (
            <div className="mx-auto max-w-md p-10 text-center text-sm text-muted-foreground">
              <p className="font-medium text-foreground">{meta?.name}</p>
              <p className="mt-1">{meta?.description}</p>
              <p className="mt-4 text-xs">Add more sources (any OPDS catalog, e.g. your Calibre server) in Settings → Sources.</p>
            </div>
          )}
          {mode === "books" || author ? (
            <>
              {total !== null && !author && shown.length > 0 && <p className="px-5 pt-3 text-xs text-muted-foreground">{total.toLocaleString()} results</p>}
              <div className="grid gap-x-4 gap-y-5 p-5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(128px, 1fr))" }}>
                {shown.map((b) => (
                  <RemoteCard key={`${b.provider}:${b.id}`} b={b} inLibrary={localOf.has(`${b.provider}:${b.id}`)} busy={downloading.has(b.id)} onOpen={() => setSelected(b)} onDownload={() => dl(b)} />
                ))}
              </div>
            </>
          ) : (
            <div className="mx-auto max-w-3xl space-y-2 p-5">
              {hits.map((h, i) => (
                <div key={i} onClick={() => setSelected(h.book)} className="flex cursor-pointer gap-3 rounded-lg border bg-card p-3 hover:border-primary/40">
                  <div className="h-20 w-14 shrink-0 overflow-hidden rounded"><RemoteCover b={h.book} /></div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold">{h.book.title} <span className="font-normal text-muted-foreground">{h.book.authors.map((a) => a.name).join(", ")} {h.book.year}</span></p>
                    {h.snippets.slice(0, 2).map((s, j) => <p key={j} className="mt-1 line-clamp-3 font-serif text-[13px] text-muted-foreground" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(s.replace(/\n/g, " "), { ALLOWED_TAGS: ["mark"] }) }} />)}
                  </div>
                </div>
              ))}
            </div>
          )}
          {hasMore && !author && <div className="flex justify-center pb-8"><Button variant="outline" size="sm" onClick={() => run(page + 1)} disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : "Load more"}</Button></div>}
        </div>
      </section>
      {selected && <RemoteDetails book={selected} localId={localOf.get(`${selected.provider}:${selected.id}`)} onClose={() => setSelected(null)} onAuthor={openAuthor} />}
    </div>
  );
}
