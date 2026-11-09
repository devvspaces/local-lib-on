import { BookOpen, FolderOpen, Pencil, Quote, Star, Wand2, X } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { identifyAndApply } from "@/lib/identify";
import { retrieveMetadata } from "@/lib/enricher";
import { useTaskRunning } from "@/lib/tasks";
import { Sparkles } from "lucide-react";
import { api, type Book } from "@/lib/api";
import { useApp } from "@/store/app";
import { useAsync } from "@/hooks/useAsync";
import { formatBytes, cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { BookCover } from "./BookCover";
import { CITATION_STYLES, formatCitation } from "@/lib/citations";
import { toast, toastError } from "@/components/ui/toast";
import { useState } from "react";
import { StylePicker, lastStyle } from "@/components/StylePicker";
import { copyRich, formatBibliography, formatCitation as cslCitation, prettyStyle } from "@/lib/csl";

function CslCite({ book }: { book: Book }) {
  const [style, setStyle] = useState(lastStyle);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const run = async (kind: "bib" | "cite") => {
    try {
      if (kind === "bib") {
        const r = await formatBibliography(style, [book]);
        await copyRich(r.html, r.text);
        setPreview(r.text);
        toast("Reference copied", prettyStyle(style));
      } else {
        const c = await cslCitation(style, [book]);
        await navigator.clipboard.writeText(c);
        setPreview(c);
        toast("In-text citation copied", c);
      }
    } catch (e) { toastError("Citation failed (offline?)", e); }
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1">
        <button onClick={() => setOpen(!open)} className="flex-1 truncate rounded border px-2 py-1 text-left text-xs hover:bg-secondary cursor-pointer">{prettyStyle(style)} ▾</button>
        <button onClick={() => run("bib")} className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground cursor-pointer">Reference</button>
        <button onClick={() => run("cite")} className="rounded border px-2 py-1 text-xs hover:bg-secondary cursor-pointer">In-text</button>
      </div>
      {open && <StylePicker value={style} onChange={(s) => { setStyle(s); setOpen(false); setPreview(null); }} />}
      {preview && <p className="rounded bg-muted p-2 text-xs" data-selectable>{preview}</p>}
    </div>
  );
}

export function BookDetails({ bookId, onClose, onEdit }: { bookId: number; onClose: () => void; onEdit: (b: Book) => void }) {
  const { openBook, libraryVersion, bumpLibrary, setFilter } = useApp();
  const { data: b } = useAsync<Book | null>(() => api.getBook(bookId), [bookId, libraryVersion], null);
  const anns = useAsync(() => api.listAnnotations(bookId), [bookId, libraryVersion], []);
  const identifying = useTaskRunning(`identify:${bookId}`);
  const enriching = useTaskRunning(`enrich:${bookId}`);
  if (!b) return <aside className="w-80 shrink-0 border-l" />;

  const Field = ({ k, v }: { k: string; v?: React.ReactNode }) =>
    v ? (
      <div className="grid grid-cols-[84px_1fr] gap-2 py-1 text-[13px]">
        <span className="text-muted-foreground">{k}</span>
        <span className="min-w-0 whitespace-pre-line break-words" data-selectable>{v}</span>
      </div>
    ) : null;

  return (
    <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-l bg-card custom-scrollbar">
      <div className="flex justify-end p-2"><button onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-secondary cursor-pointer" aria-label="Close details"><X className="h-4 w-4" /></button></div>
      <div className="px-5 pb-5">
        <div className="mx-auto aspect-[2/3] w-36 overflow-hidden rounded-md shadow-md"><BookCover book={b} /></div>
        <h2 className="mt-4 text-center font-serif text-lg font-semibold leading-snug" data-selectable>{b.title}</h2>
        {b.subtitle && <p className="text-center text-sm text-muted-foreground">{b.subtitle}</p>}
        <div className="mt-1 flex flex-wrap justify-center gap-x-1 text-sm">
          {b.authors.map((a, i) => (
            <button key={a} onClick={() => setFilter({ author: a })} className="text-primary hover:underline cursor-pointer">{a}{i < b.authors.length - 1 ? "," : ""}</button>
          ))}
        </div>
        <div className="mt-2 flex justify-center gap-0.5">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} onClick={async () => { await api.updateBook(b.id, { rating: b.rating === n ? 0 : n }); bumpLibrary(); }} className="cursor-pointer" aria-label={`${n} stars`}>
              <Star className={cn("h-4 w-4", (b.rating ?? 0) >= n ? "fill-primary text-primary" : "text-muted-foreground/50")} />
            </button>
          ))}
        </div>
        <div className="mt-4 flex gap-2">
          <Button className="flex-1" size="sm" onClick={() => openBook(b.id, b.title)} disabled={!b.files.length}><BookOpen /> {b.percent > 0 ? `Continue · ${Math.round(b.percent * 100)}%` : "Read"}</Button>
          <Button size="sm" variant="outline" onClick={() => onEdit(b)} aria-label="Edit metadata"><Pencil /></Button>
          <Button size="sm" variant="outline" title="Retrieve metadata again" loading={enriching} onClick={() => { void retrieveMetadata([b]); }} aria-label="Retrieve metadata"><Wand2 /></Button>
          {b.files.length > 0 && <Button size="sm" variant="outline" title="Identify with AI: find the DOI / ISBN and fetch the full record" aria-label="Identify with AI" loading={identifying} onClick={() => { void identifyAndApply(b).then((ok) => ok && useApp.getState().bumpLibrary()); }}><Sparkles /></Button>}
        </div>

        <div className="mt-5 border-t pt-3">
          <Field k="Type" v={<span className="capitalize">{b.item_type}</span>} />
          <Field k="Edition" v={b.edition} />
          <Field k="Year" v={b.year} />
          <Field k="Publisher" v={b.publisher} />
          <Field k="Place" v={b.place} />
          <Field k="Pages" v={b.num_pages} />
          <Field k="Series" v={b.series && `${b.series}${b.series_index ? ` #${b.series_index}` : ""}`} />
          <Field k="Language" v={b.language} />
          <Field k="ISBN" v={[...new Set([b.isbn, ...b.identifiers.filter((i) => i.scheme === "isbn").map((i) => i.value)].filter(Boolean))].join("\n") || undefined} />
          <Field k="DOI" v={b.doi} />
          <Field k="Status" v={<span className="capitalize">{b.status}</span>} />
          <Field k="Added" v={new Date(b.added_at).toLocaleDateString()} />
          <Field k="Source" v={b.metadata_source} />
          <Field k="Annotations" v={anns.data.length || undefined} />
          {b.tags.length > 0 && <Field k="Tags" v={<div className="flex flex-wrap gap-1">{b.tags.map((t) => <span key={t.id} className="flex items-center gap-1 rounded-full border px-1.5 text-xs"><span className="h-1.5 w-1.5 rounded-full" style={{ background: t.color ?? "#8d8d86" }} />{t.name}</span>)}</div>} />}
        </div>

        {b.description && <p className="mt-3 border-t pt-3 text-[13px] leading-relaxed text-muted-foreground line-clamp-[12]" data-selectable>{b.description.replace(/<[^>]+>/g, "")}</p>}

        <div className="mt-3 border-t pt-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Files</p>
          {b.files.length === 0 && <p className="text-xs text-muted-foreground">Reference only — no file attached.</p>}
          {b.files.map((f) => (
            <div key={f.id} className="flex items-center gap-2 py-1 text-xs">
              <span className={cn("rounded px-1 font-mono uppercase", f.missing ? "bg-destructive/15 text-destructive" : "bg-secondary")}>{f.format}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground" title={f.path}>{f.path.split("/").pop()}</span>
              <span className="tabular-nums text-muted-foreground">{formatBytes(f.size)}</span>
              <button onClick={() => revealItemInDir(f.path)} className="text-muted-foreground hover:text-foreground cursor-pointer" aria-label="Show in Finder"><FolderOpen className="h-3.5 w-3.5" /></button>
            </div>
          ))}
        </div>

        <div className="mt-3 border-t pt-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Cite</p>
          <CslCite key={b.id} book={b} />
          <div className="mt-2 flex flex-wrap gap-1">
            {CITATION_STYLES.map((s) => (
              <button key={s.id} onClick={async () => { await navigator.clipboard.writeText(formatCitation(b, s.id)); toast("Citation copied", s.label); }} className="flex items-center gap-1 rounded border px-2 py-0.5 text-xs hover:bg-secondary cursor-pointer">
                <Quote className="h-3 w-3" />{s.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}
