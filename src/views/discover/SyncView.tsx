import { useEffect, useState } from "react";
import { BookOpen, Download, EyeOff, Loader2, Plus, RefreshCcw, Trash2, Eye } from "lucide-react";
import { providers, downloadBest, type ProviderMeta, type SavedQuery, type SyncItem, type SyncResult } from "@/lib/providers";
import { useApp } from "@/store/app";
import { useProviders } from "@/hooks/useProviders";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { toast, toastError } from "@/components/ui/toast";
import { RemoteCover, AccessBadge } from "./RemoteCard";
import { askConfirm, askForm } from "@/components/ui/prompt";

/** Saved provider queries → "what's out there that I don't have yet" (like coursera-dl-gui's sync). */
export function SyncView() {
  const [queries, setQueries] = useState<SavedQuery[]>([]);
  const list = useProviders();
  const [current, setCurrent] = useState<SavedQuery | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [running, setRunning] = useState(false);
  const [filter, setFilter] = useState<"missing" | "all" | "in_library" | "ignored">("missing");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const openBook = useApp((s) => s.openBook);

  const load = () => providers.syncQueries().then((q) => { setQueries(q); return q; });
  useEffect(() => { load().then((q) => { if (q[0]) pick(q[0]); }); }, []);

  const pick = (q: SavedQuery) => { setCurrent(q); setResult(q.last_result); setSelected(new Set()); };
  const run = async (q: SavedQuery) => {
    setRunning(true);
    try {
      const r = await providers.runSync(q.id);
      setResult(r);
      toast("Sync complete", `${r.missing} missing · ${r.in_library} already in library`);
      load();
    } catch (e) { toastError("Sync failed", e); } finally { setRunning(false); }
  };

  const create = async () => {
    const f = await askForm({
      title: "New sync",
      description: "Follow an author or a topic. Sync shows which matching books you don't have yet.",
      okLabel: "Create",
      fields: [
        { key: "provider", label: "Source", type: "select", options: list.map((p) => ({ value: p.id, label: p.name })) },
        { key: "author", label: "Author to follow", placeholder: "e.g. Ursula K. Le Guin" },
        { key: "text", label: "…or keywords / subject", placeholder: "e.g. distributed systems" },
        { key: "downloadable", label: "Only items with free downloads", type: "checkbox", initial: true },
      ],
    });
    if (!f) return;
    const author = String(f.author).trim() || undefined;
    const text = author ? undefined : String(f.text).trim() || undefined;
    if (!author && !text) { toastError("Nothing to follow", "Enter an author or some keywords."); return; }
    const id = await providers.saveSyncQuery(author ?? text!, String(f.provider), { author, text, downloadable: !!f.downloadable });
    const qs = await load();
    const q = qs.find((x) => x.id === id);
    if (q) { pick(q); run(q); }
  };

  const items = (result?.items ?? []).filter((i) => filter === "all" || i.status === filter);
  const key = (i: SyncItem) => `${i.book.provider}:${i.book.id}`;
  const downloadMany = async (list: SyncItem[]) => {
    let ok = 0;
    for (const i of list) { try { await downloadBest(i.book); ok++; } catch { /* skip non-downloadable */ } }
    toast("Downloads queued", `${ok} of ${list.length}${ok < list.length ? " (others have no free file)" : ""}`);
  };

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r bg-sidebar p-2">
        <div className="mb-2 flex items-center justify-between px-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Saved syncs</span>
          <button onClick={create} className="rounded p-0.5 text-muted-foreground hover:bg-secondary cursor-pointer" aria-label="New sync"><Plus className="h-4 w-4" /></button>
        </div>
        {!queries.length && <p className="px-2 text-xs text-muted-foreground">Search in Discover and choose “Save as sync”, or follow an author with +.</p>}
        {queries.map((q) => (
          <button key={q.id} onClick={() => pick(q)} className={cn("group flex w-full flex-col rounded-md px-2 py-1.5 text-left cursor-pointer", current?.id === q.id ? "bg-sidebar-accent" : "hover:bg-secondary")}>
            <span className="flex w-full items-center gap-1 text-[13px] font-medium">
              <span className="flex-1 truncate">{q.name}</span>
              {q.last_result && q.last_result.missing > 0 && <span className="rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">{q.last_result.missing}</span>}
            </span>
            <span className="text-[11px] text-muted-foreground">{list.find((p) => p.id === q.provider)?.name ?? q.provider} · {q.last_run ? new Date(q.last_run).toLocaleDateString() : "never run"}</span>
          </button>
        ))}
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        {current ? (
          <>
            <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
              <h1 className="truncate text-[15px] font-semibold">{current.name}</h1>
              <span className="text-xs text-muted-foreground">{[current.query.author && `author: ${current.query.author}`, current.query.text, current.query.subject && `subject: ${current.query.subject}`, current.query.downloadable && "free only"].filter(Boolean).join(" · ")}</span>
              <div className="ml-auto flex items-center gap-1">
                <div className="flex rounded-md border p-0.5 text-xs">
                  {(["missing", "in_library", "ignored", "all"] as const).map((f) => (
                    <button key={f} onClick={() => setFilter(f)} className={cn("rounded px-2 py-0.5 capitalize cursor-pointer", filter === f && "bg-accent text-accent-foreground")}>
                      {f.replace("_", " ")} {result && f !== "all" ? `(${result.items.filter((i) => i.status === f).length})` : ""}
                    </button>
                  ))}
                </div>
                <Button size="sm" variant="outline" onClick={() => run(current)} disabled={running}>{running ? <Loader2 className="animate-spin" /> : <RefreshCcw />} Check now</Button>
                {filter === "missing" && items.length > 0 && (
                  <Button size="sm" onClick={() => downloadMany(selected.size ? items.filter((i) => selected.has(key(i))) : items)}><Download /> {selected.size ? `Download ${selected.size}` : "Download all missing"}</Button>
                )}
                <button onClick={async () => { if (await askConfirm({ title: `Delete sync "${current.name}"?`, okLabel: "Delete", destructive: true })) { await providers.deleteSyncQuery(current.id); setCurrent(null); setResult(null); load(); } }} className="rounded p-1.5 text-muted-foreground hover:bg-secondary hover:text-destructive cursor-pointer" aria-label="Delete sync"><Trash2 className="h-4 w-4" /></button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar">
              {!result && <p className="p-8 text-center text-sm text-muted-foreground">Not run yet — click “Check now”.</p>}
              {result && !items.length && <p className="p-8 text-center text-sm text-muted-foreground">{filter === "missing" ? "You have everything this query finds. 🎉" : "Nothing here."}</p>}
              <div className="divide-y">
                {items.map((i) => (
                  <div key={key(i)} className="flex items-center gap-3 px-4 py-2 hover:bg-secondary/50">
                    {i.status === "missing" && <input type="checkbox" checked={selected.has(key(i))} onChange={(e) => { const s = new Set(selected); e.target.checked ? s.add(key(i)) : s.delete(key(i)); setSelected(s); }} aria-label="Select" />}
                    <div className="h-14 w-10 shrink-0 overflow-hidden rounded-sm"><RemoteCover b={i.book} /></div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">{i.book.title}</p>
                      <p className="truncate text-xs text-muted-foreground">{i.book.authors.map((a) => a.name).join(", ")} {i.book.year ?? ""}</p>
                    </div>
                    <AccessBadge b={i.book} />
                    {i.matched_by && <span className="text-[11px] text-muted-foreground">matched by {i.matched_by}</span>}
                    {i.status === "in_library" && i.local_book_id && <Button size="xs" variant="ghost" onClick={() => openBook(i.local_book_id!, i.book.title)}><BookOpen /> Open</Button>}
                    {i.status === "missing" && i.book.access === "public" && <Button size="xs" variant="outline" onClick={() => downloadMany([i])}><Download /></Button>}
                    {i.status !== "in_library" && (
                      <Button size="xs" variant="ghost" title={i.status === "ignored" ? "Un-ignore" : "Ignore (don't show as missing)"} onClick={async () => {
                        await providers.setIgnored(i.book.provider, i.book.id, i.status !== "ignored");
                        setResult((r) => r && { ...r, items: r.items.map((x) => (key(x) === key(i) ? { ...x, status: i.status === "ignored" ? "missing" : "ignored" } : x)) });
                      }}>{i.status === "ignored" ? <Eye /> : <EyeOff />}</Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Create a sync to track an author, series or topic across a provider.</div>
        )}
      </section>
    </div>
  );
}
