import { useEffect, useMemo, useState } from "react";
import { BookOpen, FileText, Layers, Plus, Search, Trash2 } from "lucide-react";
import { cardsApi, cardsFromMarkdown } from "@/lib/cards";
import { toast } from "@/components/ui/toast";
import { api, type Book, type Note } from "@/lib/api";
import { NoteEditor } from "@/components/notes/NoteEditor";
import { summaryApi, type Summary } from "@/lib/assistant";
import { renderMarkdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { askConfirm } from "@/components/ui/prompt";

/** All notes across the library + a global notebook (notes not tied to a book). */
export function NotebookView() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [books, setBooks] = useState<Map<number, Book>>(new Map());
  const [current, setCurrent] = useState<Note | null>(null);
  const [q, setQ] = useState("");
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const openBook = useApp((s) => s.openBook);

  useEffect(() => { summaryApi.list().then(setSummaries).catch(() => {}); }, []);
  useEffect(() => {
    Promise.all([api.listNotes(null, true), api.listBooks({})]).then(([n, b]) => {
      setNotes(n);
      setBooks(new Map(b.map((x) => [x.id, x])));
      setCurrent((c) => c ?? n[0] ?? null);
    });
  }, []);

  const filtered = useMemo(() => notes.filter((n) => !q || `${n.title} ${n.body}`.toLowerCase().includes(q.toLowerCase())), [notes, q]);
  const create = async () => {
    const n = await api.upsertNote({ title: "Untitled", book_id: null });
    setNotes([n, ...notes]);
    setCurrent(n);
  };

  return (
    <div className="flex h-full">
      <aside className="flex w-72 shrink-0 flex-col border-r bg-sidebar">
        <div className="flex items-center gap-2 p-2">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search notes" className="h-8 w-full rounded-md border bg-background pl-7 pr-2 text-[13px] outline-none focus:ring-2 focus:ring-ring" />
          </div>
          <button onClick={create} className="rounded-md bg-primary p-1.5 text-primary-foreground cursor-pointer" aria-label="New note"><Plus className="h-4 w-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-1 pb-4 custom-scrollbar">
          {!notes.length && <p className="p-3 text-xs text-muted-foreground">No notes yet. Open a book and use the split view (Notebook) to take notes beside the text.</p>}
          {summaries.length > 0 && (
            <div className="mb-2">
              <p className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Summaries</p>
              {summaries.filter((x) => !q || `${x.title} ${x.text}`.toLowerCase().includes(q.toLowerCase())).map((x) => (
                <button key={`${x.book_id}:${x.scope}`} onClick={() => { setSummary(x); setCurrent(null); }} className={cn("block w-full rounded-md px-2.5 py-1.5 text-left cursor-pointer", summary === x ? "bg-sidebar-accent" : "hover:bg-secondary")}>
                  <p className="truncate text-[13px] font-medium">✨ {x.title}</p>
                  <p className="truncate text-[10px] text-muted-foreground">{books.get(x.book_id)?.title ?? ""}</p>
                </button>
              ))}
              <p className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Notes</p>
            </div>
          )}
          {filtered.map((n) => {
            const b = n.book_id ? books.get(n.book_id) : null;
            return (
              <button key={n.id} onClick={() => { setCurrent(n); setSummary(null); }} className={cn("block w-full rounded-md px-2.5 py-2 text-left cursor-pointer", current?.id === n.id ? "bg-sidebar-accent" : "hover:bg-secondary")}>
                <p className="flex items-center gap-1.5 truncate text-[13px] font-medium">{b ? <BookOpen className="h-3 w-3 shrink-0 text-muted-foreground" /> : <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />}{n.title || "Untitled"}</p>
                <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.body.replace(/[#>*_`\[\]]|\(ann:\/\/[^)]+\)/g, "").slice(0, 140) || "Empty"}</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">{b ? `${b.title} · ` : ""}{new Date(n.updated_at).toLocaleDateString()}</p>
              </button>
            );
          })}
        </div>
      </aside>
      <section className="min-w-0 flex-1">
        {summary ? (
          <div className="h-full overflow-y-auto p-6 custom-scrollbar">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <p>{books.get(summary.book_id)?.title} · AI summary{summary.model ? ` · ${summary.model}` : ""} · {new Date(summary.created_at).toLocaleDateString()}</p>
              <button onClick={async () => {
                if (!(await askConfirm({ title: "Delete this summary?", description: summary.title, okLabel: "Delete", destructive: true }))) return;
                await summaryApi.remove(summary.book_id, summary.scope);
                setSummaries((all) => all.filter((x) => !(x.book_id === summary.book_id && x.scope === summary.scope)));
                setSummary(null);
              }} className="ml-auto flex items-center gap-1 hover:text-destructive cursor-pointer"><Trash2 className="h-3.5 w-3.5" /> Delete</button>
            </div>
            <h1 className="mb-3 mt-1 text-xl font-semibold">{summary.title}</h1>
            <div className="md-preview max-w-3xl" dangerouslySetInnerHTML={{ __html: renderMarkdown(summary.text) }} />
          </div>
        ) : current ? (
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
              {current.book_id && books.get(current.book_id) && (
                <button onClick={() => { const b = books.get(current.book_id!)!; openBook(b.id, b.title); }} className="flex items-center gap-1 text-primary hover:underline cursor-pointer"><BookOpen className="h-3.5 w-3.5" /> {books.get(current.book_id)!.title}</button>
              )}
              <button onClick={async () => {
                const qa = cardsFromMarkdown(current.body);
                if (!qa.length) { toast("No Q:/A: blocks in this note", "Write lines like “Q: …” followed by “A: …”."); return; }
                for (const c of qa) await cardsApi.upsert({ ...c, book_id: current.book_id });
                toast(`Created ${qa.length} flashcards`);
              }} className="flex items-center gap-1 hover:text-foreground cursor-pointer"><Layers className="h-3.5 w-3.5" /> Cards from Q/A</button>
              <button onClick={async () => { if (!(await askConfirm({ title: "Delete this note?", description: current.title || undefined, okLabel: "Delete", destructive: true }))) return; await api.deleteNote(current.id); const rest = notes.filter((x) => x.id !== current.id); setNotes(rest); setCurrent(rest[0] ?? null); }} className="ml-auto flex items-center gap-1 hover:text-destructive cursor-pointer"><Trash2 className="h-3.5 w-3.5" /> Delete</button>
            </div>
            <div className="min-h-0 flex-1">
              <NoteEditor key={current.id} note={current} listen bookTitle={current.book_id ? books.get(current.book_id)?.title : undefined} onChange={(n) => setNotes((l) => l.map((x) => (x.id === n.id ? n : x)))} />
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Select or create a note.</div>
        )}
      </section>
    </div>
  );
}
