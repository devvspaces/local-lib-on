import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { api, type Annotation, type Book, type Note } from "@/lib/api";
import { useApp } from "@/store/app";
import { NoteEditor } from "@/components/notes/NoteEditor";
import { AnnotationsPanel } from "../panels/Panels";
import { LookupPane } from "./LookupPane";
import { AssistantPane } from "./AssistantPane";
import { BookCover } from "@/views/library/BookCover";
import { BookReader } from "../BookReader";

export function SidePane({ pane, book, annotations, onGoAnnotation, onEditAnnotation, onDeleteAnnotation, currentLoc }: {
  currentLoc?: string | null;
  pane: NonNullable<ReturnType<typeof useApp.getState>["sidePane"]>; book: Book; annotations: Annotation[];
  onGoAnnotation: (a: Annotation) => void; onEditAnnotation: (a: Annotation, r: DOMRect) => void; onDeleteAnnotation: (a: Annotation) => void;
}) {
  if (pane.kind === "lookup") return <LookupPane initial={pane.lookup} />;
  if (pane.kind === "assistant") return <AssistantPane key={book.id} book={book} currentLoc={currentLoc} request={pane.ask} />;
  if (pane.kind === "annotations") return <div className="h-full pt-2"><AnnotationsPanel annotations={annotations} onGo={onGoAnnotation} onEdit={onEditAnnotation} onDelete={onDeleteAnnotation} /></div>;
  if (pane.kind === "book") {
    if (pane.refBookId) return <BookReader key={pane.refBookId} tab={{ key: `side-${pane.refBookId}`, bookId: pane.refBookId, title: "" }} active compact />;
    return <ReferencePicker currentId={book.id} />;
  }
  return <BookNotebook book={book} />;
}

/** Per-book notebook beside the text. Multiple notes per book; the most recent opens by default. */
function BookNotebook({ book }: { book: Book }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [current, setCurrent] = useState<Note | null>(null);
  useEffect(() => {
    api.listNotes(book.id).then(async (n) => {
      if (n.length) { setNotes(n); setCurrent(n[0]); return; }
      const created = await api.upsertNote({ book_id: book.id, title: `Notes — ${book.title}` });
      setNotes([created]); setCurrent(created);
    });
  }, [book.id, book.title]);
  if (!current) return null;
  return (
    <div className="flex h-full flex-col">
      {notes.length > 0 && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1 custom-scrollbar">
          {notes.map((n) => (
            <button key={n.id} onClick={() => setCurrent(n)} className={`max-w-40 shrink-0 truncate rounded px-2 py-0.5 text-xs cursor-pointer ${n.id === current.id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-secondary"}`}>{n.title || "Untitled"}</button>
          ))}
          <button onClick={async () => { const n = await api.upsertNote({ book_id: book.id, title: "New note" }); setNotes([n, ...notes]); setCurrent(n); }} className="rounded p-1 text-muted-foreground hover:bg-secondary cursor-pointer" aria-label="New note"><Plus className="h-3.5 w-3.5" /></button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <NoteEditor key={current.id} note={current} listen bookTitle={book.title} onChange={(n) => setNotes((l) => l.map((x) => (x.id === n.id ? n : x)))} />
      </div>
    </div>
  );
}

/** Pick the second book to read side-by-side with the current one. */
function ReferencePicker({ currentId }: { currentId: number }) {
  const [books, setBooks] = useState<Book[]>([]);
  const [q, setQ] = useState("");
  const { sidePane, setSidePane } = useApp();
  useEffect(() => { api.listBooks({ text: q || undefined, sort: "opened" }).then(setBooks); }, [q]);
  return (
    <div className="flex h-full flex-col">
      <p className="px-3 pt-2 text-xs text-muted-foreground">Choose a book to open beside this one: a translation, another edition, a reference or your lecture notes.</p>
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search library…" className="m-2 h-8 rounded-md border bg-background px-2 text-[13px] outline-none focus:ring-2 focus:ring-ring" />
      <div className="flex-1 overflow-y-auto px-2 pb-4 custom-scrollbar">
        {books.filter((b) => b.id !== currentId && b.files.length).map((b) => (
          <button key={b.id} onClick={() => setSidePane({ ...(sidePane ?? { kind: "book" }), kind: "book", refBookId: b.id })} className="flex w-full items-center gap-2 rounded-md p-1.5 text-left hover:bg-secondary cursor-pointer">
            <div className="h-12 w-8 shrink-0 overflow-hidden rounded-sm"><BookCover book={b} /></div>
            <div className="min-w-0 flex-1"><p className="truncate text-[13px] font-medium">{b.title}</p><p className="truncate text-xs text-muted-foreground">{b.authors.join(", ")}</p></div>
          </button>
        ))}
      </div>
    </div>
  );
}
