import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Bookmark as BookmarkIcon, ChevronRight, Loader2, MessageSquare, Pencil, Sparkles, Trash2 } from "lucide-react";
import type { Annotation, Bookmark } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { SearchHit, TocItem } from "../types";
import { HIGHLIGHT_COLORS, colorLabel } from "../types";

export function FilterInput({ value, onChange, placeholder = "Search…", autoFocus }: { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean }) {
  return (
    <input
      autoFocus={autoFocus}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="mx-2 mb-2 h-7 w-[calc(100%-1rem)] rounded-md border bg-background px-2 text-[13px] outline-none focus:ring-2 focus:ring-ring"
    />
  );
}

// ── Contents ───────────────────────────────────────────────

export function ContentsPanel({ toc, current, onGo, pageLabel, onSummarize, onOverview, overviewStage, summarizing }: { summarizing?: (label: string) => boolean; toc: TocItem[]; current?: string; onGo: (t: TocItem) => void; pageLabel?: (p: number) => string; onSummarize?: (t: TocItem) => void; onOverview?: () => void; overviewStage?: string | null }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const match = (t: TocItem): boolean => t.label?.toLowerCase().includes(q.toLowerCase()) || !!t.children?.some(match);
  const render = (items: TocItem[], depth: number, path: string): React.ReactNode =>
    items.filter((t) => !q || match(t)).map((t, i) => {
      const key = `${path}.${i}`;
      const isOpen = q ? true : open[key] ?? depth < 1;
      const active = current && t.label?.trim() === current.trim();
      return (
        <div key={key}>
          <div className={cn("group flex items-center rounded-md pr-2 text-[13px] hover:bg-secondary", active && "bg-accent text-accent-foreground")} style={{ paddingLeft: 4 + depth * 12 }}>
            <button onClick={() => setOpen({ ...open, [key]: !isOpen })} className={cn("p-1 text-muted-foreground cursor-pointer", !t.children && "invisible")}>
              <ChevronRight className={cn("h-3 w-3 transition-transform", isOpen && "rotate-90")} />
            </button>
            <button onClick={() => onGo(t)} className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left cursor-pointer">
              <span className="flex-1 truncate" title={t.label}>{t.label}</span>
              {t.page && <span className="text-[11px] tabular-nums text-muted-foreground">{pageLabel?.(t.page) ?? t.page}</span>}
            </button>
            {onSummarize && (t.page || t.href) && summarizing?.(t.label) && <Loader2 className="ml-1 h-3 w-3 shrink-0 animate-spin text-primary" aria-label="Summarizing" />}
            {onSummarize && (t.page || t.href) && !summarizing?.(t.label) && (
              <button onClick={() => onSummarize(t)} title="Summarize this chapter with AI" className="ml-1 hidden rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground group-hover:block cursor-pointer" aria-label="Summarize chapter"><Sparkles className="h-3 w-3" /></button>
            )}
          </div>
          {isOpen && t.children && render(t.children, depth + 1, key)}
        </div>
      );
    });
  return (
    <div className="flex h-full flex-col">
      <FilterInput value={q} onChange={setQ} />
      {onOverview && toc.length > 0 && (
        <button onClick={onOverview} disabled={!!overviewStage} title="Summarize every chapter (reusing ones already done) and write an overview of the whole book"
          className="mx-2 mb-1.5 flex items-center gap-1.5 rounded-md border px-2 py-1 text-left text-xs text-muted-foreground hover:bg-secondary hover:text-foreground disabled:cursor-wait cursor-pointer">
          {overviewStage ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" /> : <Sparkles className="h-3 w-3 shrink-0" />}
          <span className="truncate">{overviewStage ?? "Book overview"}</span>
        </button>
      )}
      <div className="flex-1 overflow-y-auto px-1 pb-4 custom-scrollbar">
        {toc.length ? render(toc, 0, "r") : <p className="px-3 text-xs text-muted-foreground">This document has no table of contents.</p>}
      </div>
    </div>
  );
}

// ── Thumbnails (PDF) ───────────────────────────────────────

export function ThumbnailsPanel({ count, current, thumbnail, onGo, label, annotatedPages, bookmarkedPages }: {
  count: number; current: number; thumbnail: (p: number, w: number) => Promise<string>; onGo: (p: number) => void; label: (p: number) => string;
  annotatedPages: Set<number>; bookmarkedPages: Set<number>;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<"all" | "annotated" | "bookmarked">("all");
  const [q, setQ] = useState("");
  const pages = useMemo(() => {
    let ps = Array.from({ length: count }, (_, i) => i + 1);
    if (filter === "annotated") ps = ps.filter((p) => annotatedPages.has(p));
    if (filter === "bookmarked") ps = ps.filter((p) => bookmarkedPages.has(p));
    if (q.trim()) ps = ps.filter((p) => label(p).toLowerCase().includes(q.trim().toLowerCase()) || String(p) === q.trim());
    return ps;
  }, [count, filter, annotatedPages, bookmarkedPages, q, label]);
  const v = useVirtualizer({ count: pages.length, getScrollElement: () => parent.current, estimateSize: () => 210, overscan: 4 });
  useEffect(() => {
    const i = pages.indexOf(current);
    if (i >= 0) v.scrollToIndex(i, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 pr-2">
        <div className="flex-1"><FilterInput value={q} onChange={setQ} placeholder="Page number or label" /></div>
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} className="mb-2 h-7 rounded-md border bg-background px-1 text-xs" aria-label="Filter thumbnails">
          <option value="all">All</option><option value="annotated">Annotated</option><option value="bookmarked">Bookmarked</option>
        </select>
      </div>
      <div ref={parent} className="flex-1 overflow-y-auto custom-scrollbar">
        <div style={{ height: v.getTotalSize(), position: "relative" }}>
          {v.getVirtualItems().map((vi) => {
            const p = pages[vi.index];
            return (
              <div key={vi.key} data-index={vi.index} ref={v.measureElement} className="absolute left-0 right-0 flex justify-center py-2" style={{ transform: `translateY(${vi.start}px)` }}>
                <Thumb page={p} active={p === current} thumbnail={thumbnail} onClick={() => onGo(p)} label={label(p)} marked={annotatedPages.has(p)} bookmarked={bookmarkedPages.has(p)} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Thumb({ page, active, thumbnail, onClick, label, marked, bookmarked }: { page: number; active: boolean; thumbnail: (p: number, w: number) => Promise<string>; onClick: () => void; label: string; marked: boolean; bookmarked: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    thumbnail(page, 130).then((s) => alive && setSrc(s)).catch(() => {});
    return () => { alive = false; };
  }, [page, thumbnail]);
  return (
    <button onClick={onClick} className={cn("relative flex w-[150px] flex-col items-center gap-1 rounded-md p-1.5 cursor-pointer", active ? "bg-primary/15 ring-2 ring-primary" : "hover:bg-secondary")}>
      {src ? <img src={src} alt="" className="w-[130px] bg-white shadow-sm" /> : <div className="flex h-[170px] w-[130px] items-center justify-center bg-white/60 shadow-sm"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>}
      <span className={cn("text-[11px] tabular-nums", active ? "font-semibold text-primary" : "text-muted-foreground")}>{label}</span>
      {bookmarked && <BookmarkIcon className="absolute right-2 top-1 h-4 w-4 fill-primary text-primary" />}
      {marked && <span className="absolute left-2.5 top-2.5 h-2 w-2 rounded-full bg-yellow-400 ring-1 ring-white" />}
    </button>
  );
}

// ── Annotations ────────────────────────────────────────────

export function AnnotationsPanel({ annotations, onGo, onEdit, onDelete, selectedId, onMakeCards }: {
  onMakeCards?: () => void;
  annotations: Annotation[]; onGo: (a: Annotation) => void; onEdit: (a: Annotation, rect: DOMRect) => void; onDelete: (a: Annotation) => void; selectedId?: string | null;
}) {
  const [q, setQ] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [kind, setKind] = useState<string>("");
  const [tag, setTag] = useState<string>("");
  const tags = useMemo(() => [...new Set(annotations.flatMap((a) => a.tags))].sort(), [annotations]);
  const kinds = useMemo(() => [...new Set(annotations.map((a) => a.kind))].sort(), [annotations]);
  const list = annotations.filter((a) =>
    (!color || a.color === color) && (!kind || a.kind === kind) && (!tag || a.tags.includes(tag)) &&
    (!q || `${a.text ?? ""} ${a.comment ?? ""} ${a.tags.join(" ")}`.toLowerCase().includes(q.toLowerCase()))
  );
  return (
    <div className="flex h-full flex-col">
      <FilterInput value={q} onChange={setQ} placeholder="Filter annotations…" />
      <div className="mb-2 flex flex-wrap items-center gap-1 px-2">
        {HIGHLIGHT_COLORS.filter((c) => annotations.some((a) => a.color === c.value)).map((c) => (
          <button key={c.id} title={c.label} onClick={() => setColor(color === c.value ? null : c.value)} className={cn("h-4 w-4 rounded-full cursor-pointer", color === c.value && "ring-2 ring-ring ring-offset-1 ring-offset-background")} style={{ background: c.value }} />
        ))}
        {kinds.length > 1 && (
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="h-6 rounded border bg-background px-1 text-[11px]" aria-label="Annotation type">
            <option value="">All types</option>{kinds.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        )}
        {tags.length > 0 && (
          <select value={tag} onChange={(e) => setTag(e.target.value)} className="h-6 rounded border bg-background px-1 text-[11px]" aria-label="Tag">
            <option value="">All tags</option>{tags.map((t) => <option key={t} value={t}>#{t}</option>)}
          </select>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground">{list.length}</span>
        {onMakeCards && annotations.length > 0 && <button onClick={onMakeCards} title="Make flashcards from all highlights" className="rounded border px-1.5 text-[11px] hover:bg-secondary cursor-pointer">+ Cards</button>}
      </div>
      <div className="flex-1 space-y-1.5 overflow-y-auto px-2 pb-4 custom-scrollbar">
        {!annotations.length && <p className="px-1 text-xs text-muted-foreground">Select text to highlight, or pick a tool from the annotation bar (⌘⇧A).</p>}
        {list.map((a) => (
          <div
            key={a.id}
            draggable
            onDragStart={(e) => e.dataTransfer.setData("application/x-annotation", JSON.stringify(a))}
            onClick={() => onGo(a)}
            className={cn("group cursor-pointer rounded-md border bg-card p-2 text-[13px] hover:border-primary/40", selectedId === a.id && "border-primary")}
            style={{ borderLeft: `3px solid ${a.color ?? "#ffd400"}` }}
          >
            <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="capitalize">{a.kind}</span>
              {a.page_label && <span>· p. {a.page_label}</span>}
              {colorLabel(a.color) && <span>· {colorLabel(a.color)}</span>}
              <div className="ml-auto flex gap-0.5 opacity-0 group-hover:opacity-100">
                <button onClick={(e) => { e.stopPropagation(); onEdit(a, (e.currentTarget as HTMLElement).getBoundingClientRect()); }} className="rounded p-0.5 hover:bg-secondary cursor-pointer" aria-label="Edit"><Pencil className="h-3 w-3" /></button>
                <button onClick={(e) => { e.stopPropagation(); onDelete(a); }} className="rounded p-0.5 hover:bg-secondary hover:text-destructive cursor-pointer" aria-label="Delete"><Trash2 className="h-3 w-3" /></button>
              </div>
            </div>
            {a.text && <p className="line-clamp-4 font-serif leading-snug" data-selectable>{a.text}</p>}
            {a.comment && <p className="mt-1 flex gap-1 text-xs text-muted-foreground"><MessageSquare className="mt-0.5 h-3 w-3 shrink-0" /><span className="line-clamp-3">{a.comment}</span></p>}
            {a.tags.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{a.tags.map((t) => <span key={t} className="rounded bg-secondary px-1 text-[10px]">#{t}</span>)}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Bookmarks ──────────────────────────────────────────────

export function BookmarksPanel({ bookmarks, onGo, onRename, onDelete, label }: {
  bookmarks: Bookmark[]; onGo: (b: Bookmark) => void; onRename: (b: Bookmark) => void; onDelete: (b: Bookmark) => void; label: (b: Bookmark) => string;
}) {
  const [q, setQ] = useState("");
  const list = bookmarks.filter((b) => !q || `${b.label ?? ""} ${label(b)}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="flex h-full flex-col">
      <FilterInput value={q} onChange={setQ} placeholder="Filter bookmarks…" />
      <div className="flex-1 overflow-y-auto px-1 pb-4 custom-scrollbar">
        {!bookmarks.length && <p className="px-2 text-xs text-muted-foreground">No bookmarks yet. Press ⌘D to bookmark the current page.</p>}
        {list.map((b) => (
          <div key={b.id} onClick={() => onGo(b)} className="group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-secondary">
            <BookmarkIcon className="h-3.5 w-3.5 shrink-0 fill-primary text-primary" />
            <span className="flex-1 truncate">{b.label || label(b)}</span>
            <span className="text-[11px] text-muted-foreground">{label(b)}</span>
            <button onClick={(e) => { e.stopPropagation(); onRename(b); }} className="opacity-0 group-hover:opacity-100 cursor-pointer" aria-label="Rename"><Pencil className="h-3 w-3" /></button>
            <button onClick={(e) => { e.stopPropagation(); onDelete(b); }} className="opacity-0 group-hover:opacity-100 hover:text-destructive cursor-pointer" aria-label="Delete"><Trash2 className="h-3 w-3" /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── In-document search ─────────────────────────────────────

export function SearchPanel({ search, onGo, onClear, initial }: { search: (q: string) => Promise<SearchHit[]>; onGo: (h: SearchHit) => void; onClear: () => void; initial?: string }) {
  const [q, setQ] = useState(initial ?? "");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const seq = useRef(0);
  const run = async (query: string, navigate = true) => {
    const id = ++seq.current;
    if (query.trim().length < 2) { setHits(null); onClear(); return; }
    setBusy(true);
    const r = await search(query).catch(() => []);
    if (id !== seq.current) return;
    setHits(r);
    setActive(0);
    setBusy(false);
    if (r[0] && navigate) onGo(r[0]);
  };
  useEffect(() => { if (initial) { setQ(initial); run(initial, false); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [initial]);
  const step = (d: number) => {
    if (!hits?.length) return;
    const i = (active + d + hits.length) % hits.length;
    setActive(i);
    onGo(hits[i]);
  };
  const hl = (s: string) => {
    const t = q.trim();
    const i = s.toLowerCase().indexOf(t.toLowerCase());
    return i < 0 ? s : <>{s.slice(0, i)}<mark>{s.slice(i, i + t.length)}</mark>{s.slice(i + t.length)}</>;
  };
  return (
    <div className="flex h-full flex-col">
      <form onSubmit={(e) => { e.preventDefault(); hits?.length ? step(1) : run(q); }}>
        <FilterInput autoFocus value={q} onChange={(v) => { setQ(v); }} placeholder="Find in document (Enter)" />
      </form>
      <div className="mb-1 flex items-center justify-between px-3 text-[11px] text-muted-foreground">
        <span>{busy ? "Searching…" : hits ? `${hits.length}${hits.length >= 500 ? "+" : ""} results` : ""}</span>
        {hits && hits.length > 0 && (
          <span className="flex gap-1">
            <button onClick={() => step(-1)} className="rounded border px-1.5 cursor-pointer">↑</button>
            <button onClick={() => step(1)} className="rounded border px-1.5 cursor-pointer">↓</button>
            <button onClick={() => { setHits(null); setQ(""); onClear(); }} className="rounded border px-1.5 cursor-pointer">Clear</button>
          </span>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-1 pb-4 custom-scrollbar">
        {hits?.map((h, i) => (
          <button key={h.id} onClick={() => { setActive(i); onGo(h); }} className={cn("block w-full rounded-md px-2 py-1.5 text-left text-xs cursor-pointer hover:bg-secondary", i === active && "bg-accent")}>
            <span className="mb-0.5 block text-[11px] font-medium text-muted-foreground">{h.page ? `Page ${h.label}` : h.label}</span>
            <span className="line-clamp-3">{hl(h.excerpt)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
