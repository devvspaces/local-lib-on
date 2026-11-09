import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { runTask, useTasks } from "@/lib/tasks";
import { Group, Panel, Separator } from "react-resizable-panels";
import { BookOpenText, Bookmark as BookmarkIcon, Highlighter, ImageIcon, List, Search, X } from "lucide-react";
import { api, primaryFile, type Annotation, type Book, type Bookmark, type Progress, type ReaderSettings } from "@/lib/api";
import { useApp, type ReaderTab } from "@/store/app";
import { cn } from "@/lib/utils";
import { toast, toastAction, toastError } from "@/components/ui/toast";
import { invoke } from "@tauri-apps/api/core";
import { PdfReader, type PdfEngineHandle } from "./pdf/PdfReader";
import { FoliateReader, type FoliateHandle } from "./foliate/FoliateReader";
import { DjvuReader } from "./djvu/DjvuReader";
import { ReaderToolbar } from "./ReaderToolbar";
import { AnnotationsPanel, BookmarksPanel, ContentsPanel, SearchPanel, ThumbnailsPanel } from "./panels/Panels";
import { SelectionPopover } from "./SelectionPopover";
import { AnnotationEditor } from "./AnnotationEditor";
import { SidePane } from "./panes/SidePane";
import { ExportDialog } from "@/views/export/ExportDialog";
import { DocInfoDialog } from "./DocInfoDialog";
import { notebookBus } from "./notebookBus";
import { linkBus } from "./linkBus";
import * as ttsCtl from "./tts";
import { annotationToMarkdown } from "@/lib/annotationMarkdown";
import { enrichFromReader } from "@/lib/enrich";
import { tracker } from "@/lib/tracker";
import { cardFromAnnotation, cardsApi } from "@/lib/cards";
import type { EngineHandle, LocationInfo, SearchHit, SelectionInfo, TocItem, ToolMode } from "./types";
import { askText } from "@/components/ui/prompt";
import { chapterRanges, rangeFor, type ChapterRange } from "./chapters";
import { AudiobookDialog } from "./AudiobookDialog";
import { finishVoiceAsk, startVoiceAsk, useVoiceAsk } from "./voiceAsk";
import { VoiceAnswerCard } from "./VoiceAnswerCard";

type LeftTab = "contents" | "thumbs" | "annotations" | "bookmarks" | "search";

export function BookReader({ tab, active, compact = false }: { tab: ReaderTab; active: boolean; compact?: boolean }) {
  const [book, setBook] = useState<Book | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [settings, setSettings] = useState<ReaderSettings>({});
  const [toc, setToc] = useState<TocItem[]>([]);
  const [loc, setLoc] = useState<LocationInfo | null>(null);
  const [tool, setTool] = useState<ToolMode>({ type: "select" });
  const [color, setColor] = useState("#ffd400");
  const [annoBar, setAnnoBar] = useState(false);
  const [leftOpen, setLeftOpen] = useState(!compact);
  const [leftTab, setLeftTab] = useState<LeftTab>("contents");
  const [searchSeed, setSearchSeed] = useState<string | undefined>();
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [editing, setEditing] = useState<{ ann: Annotation; rect: DOMRect } | null>(null);
  const [selectedAnn, setSelectedAnn] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [audioChapters, setAudioChapters] = useState<ChapterRange[] | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [docMeta, setDocMeta] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const engine = useRef<EngineHandle | null>(null);
  const { sidePane: globalPane, setSidePane, bumpLibrary, focusedReader, setFocusedReader } = useApp();
  const sidePane = compact ? null : globalPane; // the side reader never nests another pane
  const myKey = compact ? "side" : tab.key;
  const hasFocus = focusedReader === myKey || (!compact && focusedReader !== "side");
  const lastPage = useRef<number | null>(null);
  const ttsState = ttsCtl.useTts();
  const ttsStatus = ttsState.owner === myKey + tab.bookId ? ttsState.status : "idle";
  const onTts = async (a: "play" | "pause" | "resume" | "stop" | "skip") => {
    const e = engine.current;
    if (a === "play") {
      if (!e?.ttsStart || !e.ttsNext) return;
      const ok = await ttsCtl.play({ ttsStart: e.ttsStart, ttsNext: e.ttsNext, ttsStop: () => e.ttsStop?.() }, myKey + tab.bookId);
      if (!ok) toast("Nothing to read here", isPdf ? "This page has no text layer — scanned pages need OCR first." : undefined);
    } else if (a === "pause") ttsCtl.pause();
    else if (a === "resume") ttsCtl.resume();
    else if (a === "skip") ttsCtl.skip();
    else ttsCtl.stop();
  };
  useEffect(() => () => { if (ttsCtl.useTts.getState().owner === myKey + tab.bookId) ttsCtl.stop(); }, []);
  const session = useReaderSessionLazy(tab.bookId, active);

  // ── Load book state ──
  useEffect(() => {
    let alive = true;
    Promise.all([api.getBook(tab.bookId), api.getProgress(tab.bookId), api.listAnnotations(tab.bookId), api.listBookmarks(tab.bookId)])
      .then(([b, p, a, bm]) => {
        if (!alive) return;
        setBook(b); setProgress(p); setAnnotations(a); setBookmarks(bm); setSettings(p.settings ?? {});
        api.markOpened(b.id).then(bumpLibrary);
      })
      .catch((e) => setError(String(e)));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.bookId]);

  const file = book ? primaryFile(book) : undefined;
  const isPdf = file?.format === "pdf";

  const updateSettings = useCallback((s: Partial<ReaderSettings>) => {
    setSettings((cur) => {
      const next = { ...cur, ...s };
      session.saveSettings(next);
      return next;
    });
  }, [session]);

  // Jump requests (search hits, notebook links) are handed to the engine, which applies them after layout.
  useEffect(() => {
    if (tab.jump?.query) { setSearchSeed(tab.jump.query); }
  }, [tab.jump?.nonce]);

  // ── Annotations ──
  const createAnnotation = useCallback(async (a: Pick<Annotation, "kind" | "anchor"> & Partial<Annotation>) => {
    if (!book) return;
    try {
      const saved = await api.upsertAnnotation({ ...a, book_id: book.id });
      setAnnotations((list) => [...list, saved]);
      if (a.kind === "note" || a.kind === "text" && !a.comment) setEditing({ ann: saved, rect: selection?.rect ?? new DOMRect(window.innerWidth / 2, 200, 0, 0) });
      return saved;
    } catch (e) {
      toastError("Could not save annotation", e);
    }
  }, [book, selection]);

  const saveAnnotation = async (a: Annotation) => {
    const saved = await api.upsertAnnotation(a).catch((e) => (toastError("Save failed", e), null));
    if (saved) setAnnotations((list) => list.map((x) => (x.id === saved.id ? saved : x)));
  };
  const deleteAnnotation = async (a: Annotation) => {
    await api.deleteAnnotation(a.id);
    setAnnotations((list) => list.filter((x) => x.id !== a.id));
    setEditing(null);
  };
  const goAnnotation = (a: Annotation) => {
    setSelectedAnn(a.id);
    if ("page" in a.anchor) engine.current?.goTo({ page: a.anchor.page });
    else engine.current?.goTo({ cfi: a.anchor.cfi });
  };
  const toNotebook = (md: string) => {
    if (sidePane?.kind !== "notebook") setSidePane({ kind: "notebook", bookId: book?.id });
    setTimeout(() => notebookBus.emit({ type: "insert", markdown: md }), sidePane?.kind === "notebook" ? 0 : 400);
  };

  // ── Bookmarks ──
  const currentBookmark = useMemo(() => {
    if (!loc) return undefined;
    return bookmarks.find((b) => ("page" in b.locator && "page" in loc.locator ? b.locator.page === loc.locator.page : "cfi" in b.locator && "cfi" in loc.locator && loc.sectionLabel && b.label === loc.sectionLabel));
  }, [bookmarks, loc]);
  const toggleBookmark = async () => {
    if (!book || !loc) return;
    if (currentBookmark) {
      await api.deleteBookmark(currentBookmark.id);
      setBookmarks((b) => b.filter((x) => x.id !== currentBookmark.id));
    } else {
      const label = loc.sectionLabel ?? `Page ${loc.page ?? ""}`;
      const id = await api.upsertBookmark({ book_id: book.id, locator: loc.locator, label });
      setBookmarks((b) => [...b, { id, book_id: book.id, locator: loc.locator, label, created_at: new Date().toISOString() }]);
      toast("Bookmarked", label);
    }
  };

  // ── Keyboard shortcuts (active tab only) ──
  useEffect(() => {
    if (!active || !hasFocus) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === "f") { e.preventDefault(); setLeftOpen(true); setLeftTab("search"); return; }
      if (mod && k === "d") { e.preventDefault(); toggleBookmark(); return; }
      if (mod && e.shiftKey && k === "a") { e.preventDefault(); setAnnoBar((v) => !v); return; }
      if (mod && e.shiftKey && k === "s") { e.preventDefault(); setLeftOpen((v) => !v); return; }
      if (mod && k === "4") { e.preventDefault(); setTool({ type: "select" }); return; }
      if (mod && k === "3" && isPdf) { e.preventDefault(); setTool({ type: "area" }); return; }
      if (mod && k === "5" && isPdf) { e.preventDefault(); setTool({ type: "table" }); return; }
      if (mod && k === "6" && isPdf) { e.preventDefault(); setTool({ type: "magnifier" }); return; }
      if (mod && (k === "=" || k === "+")) { e.preventDefault(); const z = settings.zoom; updateSettings(isPdf ? { zoom: Math.min(6, (typeof z === "number" ? z : 1.2) + 0.1) } : { font: { ...settings.font, size: (settings.font?.size ?? 18) + 1 } }); return; }
      if (mod && k === "-") { e.preventDefault(); const z = settings.zoom; updateSettings(isPdf ? { zoom: Math.max(0.25, (typeof z === "number" ? z : 1.2) - 0.1) } : { font: { ...settings.font, size: (settings.font?.size ?? 18) - 1 } }); return; }
      if (mod && k === "0") { e.preventDefault(); updateSettings({ zoom: "fit-width" }); return; }
      if (e.altKey && ["1", "2", "3"].includes(e.code.replace("Digit", ""))) {
        const kind = ({ "1": "highlight", "2": "underline", "3": "ink" } as const)[e.code.replace("Digit", "") as "1" | "2" | "3"];
        setAnnoBar(true);
        setTool({ type: "annotate", kind, color, width: 2 });
        return;
      }
      if (e.altKey && e.shiftKey && e.code === "Space") { e.preventDefault(); if (!e.repeat && book) startVoiceAsk(book, currentUnit()); return; }
      if (e.altKey && e.code === "Space") { e.preventDefault(); onTts(ttsStatus === "idle" ? "play" : ttsStatus === "playing" ? "pause" : "resume"); return; }
      if (k === "escape") { setTool({ type: "select" }); setSelection(null); setEditing(null); return; }
      if (mod) return;
      if (["arrowright", "pagedown", " "].includes(k) && !(k === " " && isPdf && settings.viewMode !== "single")) { if (!isPdf || k !== " ") { e.preventDefault(); engine.current?.next(); } }
      if (["arrowleft", "pageup"].includes(k)) { e.preventDefault(); engine.current?.prev(); }
    };
    // Hold-to-talk: releasing Space (or ⌥) after ⌥⇧Space stops listening and sends the question.
    const onUp = (e: KeyboardEvent) => { if ((e.code === "Space" || e.key === "Alt") && useVoiceAsk.getState().phase === "listening") finishVoiceAsk(); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onUp);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("keyup", onUp); };
  });
  /** Current unit for context: "p12" for page-based books, "s3" for section-based. */
  const currentUnit = () => (loc?.page ? `p${loc.page}` : null);

  const importPdfAnnotations = useCallback(async (force = false) => {
    const pdfEngine = engine.current as PdfEngineHandle | null;
    if (!book || !pdfEngine?.importAnnotations) return 0;
    const key = `pdfannots:${book.id}`;
    if (!force && (await tracker.getKv(key))) return 0;
    const found = await pdfEngine.importAnnotations().catch(() => []);
    const existing = await api.listAnnotations(book.id);
    const sig = (a: { anchor: unknown; kind: string }) => `${a.kind}:${JSON.stringify(a.anchor)}`;
    const have = new Set(existing.map(sig));
    const fresh = found.filter((a) => !have.has(sig(a)));
    for (const a of fresh) await api.upsertAnnotation({ ...a, book_id: book.id });
    await tracker.setKv(key, "1");
    if (fresh.length) {
      setAnnotations(await api.listAnnotations(book.id));
      toast(`Imported ${fresh.length} annotation${fresh.length > 1 ? "s" : ""} from the PDF`, "Tagged #imported");
    }
    return fresh.length;
  }, [book]);

  /** Chapter ranges for this book (pages for PDF/DjVu, sections for EPUB and friends). */
  const chapters = (maxDepth?: number) => chapterRanges(toc, engine.current, { isPaged: isPdf || file?.format === "djvu", pageCount: loc?.pageCount, maxDepth });

  // Cache top-level chapters so study plans can be built without opening the book.
  useEffect(() => {
    if (!book || !toc.length) return;
    const t = setTimeout(() => {
      const ch = chapters(0);
      if (ch.length) tracker.setKv(`chapters:${book.id}`, JSON.stringify(ch.map((c) => ({ label: c.label, unit: c.kind, from: c.from, to: c.to })))).catch(() => {});
    }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book?.id, toc, loc?.pageCount]);

  /** Summarize a TOC chapter (up to the next entry) and drop it into the notebook. */
  const summarizeChapter = async (t: TocItem) => {
    if (!book) return;
    const all = chapters();
    const start = t.page ?? (t.href ? engine.current?.sectionOf?.(t.href) ?? undefined : undefined);
    const r = rangeFor(all, t.label, start);
    if (!r) { toastError("Can't find that chapter", "The table of contents entry doesn't point into the book."); return; }
    const where = r.kind === "p" ? `pp. ${r.from}–${r.to}` : `sections ${r.from + 1}–${r.to + 1}`;
    const text = await runTask(`summary:${book.id}:${t.label}`, `Summarizing “${t.label}”`, async (update) => {
      update({ detail: `Reading ${where}…` });
      const { summarizeRange, chapterScope } = await import("@/lib/assistant");
      update({ detail: `Writing the summary of ${where}…` });
      return summarizeRange(book, r.from, r.to, t.label, chapterScope(r));
    }, { doneText: () => "Added to your notebook and saved under Summaries", errorTitle: "Summary failed" });
    if (text) toNotebook(`\n## Summary — ${t.label} (${where})\n\n${text}\n`);
  };

  const runningTasks = useTasks((s) => s.tasks.filter((t) => t.status === "running").map((t) => t.id).join("\n"));

  /** Whole-book overview from the top-level chapters (cached chapter summaries are reused). */
  const [overviewStage, setOverviewStage] = useState<string | null>(null);
  const makeOverview = async () => {
    if (!book || overviewStage) return;
    setOverviewStage("Starting…");
    try {
      // Mirrored in a task toast so progress stays visible when the Contents panel is closed.
      const text = await runTask(`overview:${book.id}`, `Book overview · ${book.title}`, async (update) => {
        const { bookOverview } = await import("@/lib/assistant");
        return bookOverview(book, chapters(0), (st) => { setOverviewStage(st); update({ detail: st }); });
      }, { doneText: () => "Added to your notebook and saved under Summaries", errorTitle: "Overview failed" });
      if (text) toNotebook(`\n# Overview — ${book.title}\n\n${text}\n`);
    } finally { setOverviewStage(null); }
  };

  const saveBytes = async (bytes: Uint8Array, suffix: string) => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const base = (file?.path.split("/").pop() ?? "book.pdf").replace(/\.pdf$/i, "");
    const path = await save({ defaultPath: `${base} (${suffix}).pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!path) return;
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    await api.writeBinaryFile(path, btoa(bin));
    toast("Saved", path, "success");
  };
  const onPdfAction = async (a: "annotated" | "filled" | "present" | "reimport") => {
    const pdfEngine = engine.current as PdfEngineHandle | null;
    if (!pdfEngine) return;
    try {
      if (a === "annotated") {
        const { exportAnnotatedPdf } = await import("@/lib/pdfExport");
        const { bytes, written } = await exportAnnotatedPdf(await pdfEngine.sourceBytes(), annotations);
        if (!written) { toast("No PDF annotations to export"); return; }
        await saveBytes(bytes, "annotated");
      } else if (a === "filled") {
        const bytes = await pdfEngine.saveFilled();
        if (!bytes) { toast("No form fields filled yet", "Type into the fields on the page, then save."); return; }
        await saveBytes(bytes, "filled");
      } else if (a === "present") {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().setFullscreen(true);
        updateSettings({ viewMode: "presentation" });
      } else {
        const n = await importPdfAnnotations(true);
        if (!n) toast("No new annotations found in the PDF");
      }
    } catch (e) {
      toastError("PDF action failed", e);
    }
  };

  // KOReader: offer to continue where the e-reader left off; push our progress while reading.
  const koPushed = useRef(0);
  useEffect(() => {
    if (!book || compact) return;
    invoke<{ percentage: number; progress: string; device: string; timestamp: number } | null>("koreader_pull", { bookId: book.id }).then((r) => {
      if (!r || !progress) return;
      const newer = r.timestamp * 1000 > new Date(progress.updated_at ?? 0).getTime();
      if (newer && Math.abs(r.percentage - (progress.percent ?? 0)) > 0.01) {
        toastAction(`Continue from ${r.device || "KOReader"}?`, `It's at ${Math.round(r.percentage * 100)}%${/^\d+$/.test(r.progress) ? ` (p. ${r.progress})` : ""}.`, {
          label: "Jump there",
          onClick: () => { const page = /^\d+$/.test(r.progress) ? Number(r.progress) : Math.max(1, Math.round(r.percentage * (loc?.pageCount ?? 0))); if (page) engine.current?.goTo({ page }); },
        });
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book?.id, progress?.updated_at]);
  useEffect(() => {
    if (!book || !loc || compact || Date.now() - koPushed.current < 120000) return;
    koPushed.current = Date.now();
    invoke("koreader_push", { bookId: book.id, percentage: loc.percent, progress: String(loc.page ?? "") }).catch(() => {});
  }, [loc?.page, book, compact]);

  const onReady = useCallback((info: { pageCount?: number; metadata?: Record<string, unknown> }) => {
    setDocMeta(info.metadata ?? {});
    setTimeout(() => importPdfAnnotations(), 500);
    if (book && !book.enriched) enrichFromReader(book, engine.current, info).then((changed) => changed && bumpLibrary()).catch(console.error);
  }, [book, bumpLibrary, importPdfAnnotations]);

  const onLocation = useCallback((l: LocationInfo) => {
    setLoc(l);
    session.onLocation(l);
    if (!compact && l.page) {
      if (lastPage.current !== null && lastPage.current !== l.page) linkBus.emit({ source: tab.key, page: l.page, delta: l.page - lastPage.current });
      lastPage.current = l.page;
    }
  }, [session, compact, tab.key]);

  // Side reader follows the main reader when linked.
  const linked = useApp((s) => s.sidePane?.linked);
  useEffect(() => {
    if (!compact || !linked) return;
    return linkBus.on((e) => {
      if (e.delta === 0) return;
      if (e.delta === 1) engine.current?.next();
      else if (e.delta === -1) engine.current?.prev();
      else if (loc?.page) engine.current?.goTo({ page: Math.max(1, loc.page + e.delta) });
    });
  }, [compact, linked, loc?.page]);
  const onAnnotationClick = useCallback((a: Annotation, rect: DOMRect) => { setSelectedAnn(a.id); setEditing({ ann: a, rect }); }, []);
  const onError = useCallback((e: unknown) => setError(String(e)), []);

  if (error) return <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center"><p className="font-medium">Could not open this book</p><p className="max-w-lg text-sm text-muted-foreground" data-selectable>{error}</p></div>;
  if (!book || !progress) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  if (!file) return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="font-medium">No file yet</p>
      <p className="max-w-sm text-sm text-muted-foreground">“{book.title}” is saved as a reference: its details and your notes are kept, but there's no file to read. Download it from Discover and it attaches to this entry, or drop a file onto the library.</p>
      <button onClick={() => useApp.getState().setView("discover")} className="mt-2 rounded-md border px-3 py-1.5 text-sm hover:bg-secondary cursor-pointer">Open Discover</button>
    </div>
  );
  if (file.missing) return <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center"><p className="font-medium">File not found</p><p className="text-sm text-muted-foreground" data-selectable>{file.path}</p><p className="text-xs text-muted-foreground">It was moved or deleted. Sync the library, or drop the file onto the library to reconnect it.</p></div>;

  const pdf = engine.current as PdfEngineHandle | null;
  const annotatedPages = new Set(annotations.flatMap((a) => ("page" in a.anchor ? [a.anchor.page] : [])));
  const bookmarkedPages = new Set(bookmarks.flatMap((b) => ("page" in b.locator ? [b.locator.page] : [])));
  const engineProps = {
    bookId: book.id, jump: tab.jump, path: file.path, format: file.format, initial: progress.locator, settings, onSettings: updateSettings,
    annotations, tool, onLocation, onToc: setToc, onSelection: setSelection, onCreateAnnotation: createAnnotation,
    onAnnotationClick, onReady, onError,
  };

  const LEFT_TABS: { id: LeftTab; label: string; icon: typeof List; pdf?: boolean }[] = [
    { id: "contents", label: "Contents", icon: List },
    { id: "thumbs", label: "Thumbnails", icon: ImageIcon, pdf: true },
    { id: "annotations", label: "Annotations", icon: Highlighter },
    { id: "bookmarks", label: "Bookmarks", icon: BookmarkIcon },
    { id: "search", label: "Find", icon: Search },
  ];

  return (
    <div className="relative flex h-full flex-col" onPointerDownCapture={() => focusedReader !== myKey && setFocusedReader(myKey)}>
      <ReaderToolbar
        compact={compact}
        onTts={onTts}
        ttsStatus={ttsStatus}
        onVoiceAsk={() => (useVoiceAsk.getState().phase === "listening" ? finishVoiceAsk() : startVoiceAsk(book, currentUnit()))}
        isPdf={isPdf} settings={settings} onSettings={updateSettings} tool={tool} setTool={setTool} annoBar={annoBar} setAnnoBar={setAnnoBar}
        leftOpen={leftOpen} toggleLeft={() => setLeftOpen(!leftOpen)}
        pane={sidePane?.kind ?? null} setPane={(k) => setSidePane(k ? { ...(globalPane ?? {}), kind: k, bookId: book.id } : null)}
        label={loc?.label ?? ""} page={loc?.page} pageCount={loc?.pageCount}
        onPage={(p) => engine.current?.goTo({ page: p })} onPrev={() => engine.current?.prev()} onNext={() => engine.current?.next()}
        onFind={() => { setLeftOpen(true); setLeftTab("search"); }}
        bookmarked={!!currentBookmark} onBookmark={toggleBookmark}
        onAutoCrop={async () => {
          const c = await engine.current?.autoCrop?.();
          if (c) { updateSettings({ crop: c }); toast("Margins cropped", `T ${Math.round(c.top * 100)}% · B ${Math.round(c.bottom * 100)}% · L ${Math.round(c.left * 100)}% · R ${Math.round(c.right * 100)}%`); }
          else toast("Nothing to crop", "Margins already look tight.");
        }}
        onInfo={() => setInfoOpen(true)} onExport={() => setExportOpen(true)} onAudiobook={() => setAudioChapters(chapters(1))} onPdfAction={onPdfAction}
        color={color} setColor={setColor}
      />
      <div className="relative min-h-0 flex-1">
        <Group orientation="horizontal" id={`reader-${tab.key}`}>
          {leftOpen && (
            <>
              <Panel id="left" defaultSize="22%" minSize="14%" maxSize="40%">
                <aside className="flex h-full flex-col border-r bg-sidebar">
                  <div className="flex shrink-0 gap-0.5 p-1.5">
                    {LEFT_TABS.filter((t) => isPdf || !t.pdf).map((t) => (
                      <button key={t.id} onClick={() => setLeftTab(t.id)} title={t.label} aria-label={t.label} className={cn("flex flex-1 items-center justify-center rounded-md py-1.5 cursor-pointer", leftTab === t.id ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-secondary")}>
                        <t.icon className="h-4 w-4" />
                      </button>
                    ))}
                  </div>
                  <p className="px-3 pb-1.5 text-center text-sm font-semibold">{LEFT_TABS.find((t) => t.id === leftTab)?.label}</p>
                  <div className="min-h-0 flex-1">
                    {leftTab === "contents" && <ContentsPanel toc={toc} current={loc?.sectionLabel} onSummarize={summarizeChapter} summarizing={(l) => runningTasks.split("\n").includes(`summary:${book?.id}:${l}`)} onOverview={makeOverview} overviewStage={overviewStage} pageLabel={isPdf ? (p) => pdf?.pageLabel(p) ?? String(p) : undefined} onGo={(t) => engine.current?.goTo({ page: t.page, href: t.href, cfi: t.cfi })} />}
                    {leftTab === "thumbs" && isPdf && pdf && (
                      <ThumbnailsPanel count={loc?.pageCount ?? pdf.pageCount()} current={loc?.page ?? 1} thumbnail={pdf.thumbnail} onGo={(p) => engine.current?.goTo({ page: p })} label={(p) => pdf.pageLabel(p)} annotatedPages={annotatedPages} bookmarkedPages={bookmarkedPages} />
                    )}
                    {leftTab === "annotations" && <AnnotationsPanel annotations={annotations} selectedId={selectedAnn} onGo={goAnnotation} onEdit={(a, r) => setEditing({ ann: a, rect: r })} onDelete={deleteAnnotation} onMakeCards={async () => {
                      const existing = new Set((await cardsApi.list(book.id)).map((c) => c.annotation_id));
                      let n = 0;
                      for (const a of annotations) {
                        if (existing.has(a.id)) continue;
                        const c = cardFromAnnotation(a, book.title);
                        if (c) { await cardsApi.upsert({ ...c, book_id: book.id, annotation_id: a.id }).then(() => n++).catch(() => {}); }
                      }
                      toast(n ? `Created ${n} flashcards` : "No new cards", n ? "Open the Review tab to study them" : "Every highlight already has a card");
                    }} />}
                    {leftTab === "bookmarks" && (
                      <BookmarksPanel
                        bookmarks={bookmarks}
                        label={(b) => ("page" in b.locator ? `p. ${pdf?.pageLabel?.(b.locator.page) ?? b.locator.page}` : "")}
                        onGo={(b) => engine.current?.goTo({ locator: b.locator })}
                        onRename={async (b) => { const l = await askText({ title: "Rename bookmark", initial: b.label ?? "", okLabel: "Rename" }); if (l !== null) { await api.upsertBookmark({ ...b, label: l }); setBookmarks((x) => x.map((y) => (y.id === b.id ? { ...y, label: l } : y))); } }}
                        onDelete={async (b) => { await api.deleteBookmark(b.id); setBookmarks((x) => x.filter((y) => y.id !== b.id)); }}
                      />
                    )}
                    {leftTab === "search" && (
                      <SearchPanel initial={searchSeed} search={(q) => engine.current?.search(q) ?? Promise.resolve([])} onClear={() => engine.current?.clearSearch()} onGo={(h: SearchHit) => engine.current?.goTo({ page: h.page, cfi: h.cfi })} />
                    )}
                  </div>
                </aside>
              </Panel>
              <Separator className="w-1 bg-transparent hover:bg-primary/30 data-[separator=active]:bg-primary/50" />
            </>
          )}
          <Panel id="main" minSize="30%">
            <div className="relative h-full" onMouseDown={() => { setSelectedAnn(null); }}>
              {isPdf
                ? <PdfReader ref={engine as React.Ref<PdfEngineHandle>} {...engineProps} selectedAnnotation={selectedAnn} />
                : file.format === "djvu"
                  ? <DjvuReader ref={engine} {...engineProps} selectedAnnotation={selectedAnn} />
                  : <FoliateReader ref={engine as React.Ref<FoliateHandle>} {...engineProps} />}
              {loc && (
                <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-0.5 bg-transparent">
                  <div className="h-full bg-primary/60" style={{ width: `${loc.percent * 100}%` }} />
                </div>
              )}
            </div>
          </Panel>
          {sidePane && (
            <>
              <Separator className="w-1 bg-transparent hover:bg-primary/30 data-[separator=active]:bg-primary/50" />
              <Panel id="side" defaultSize="34%" minSize="20%" maxSize="65%">
                <div className="flex h-full flex-col border-l bg-card">
                  <div className="flex h-8 shrink-0 items-center gap-1 border-b px-2 text-xs font-medium text-muted-foreground">
                    <BookOpenText className="h-3.5 w-3.5" />
                    <span className="capitalize">{sidePane.kind === "book" ? "Side-by-side" : sidePane.kind}</span>
                    {sidePane.kind === "book" && sidePane.refBookId && (
                      <>
                        <label className="ml-2 flex items-center gap-1 font-normal" title="Page the side book together with this one">
                          <input type="checkbox" checked={!!sidePane.linked} onChange={(e) => setSidePane({ ...sidePane, linked: e.target.checked })} /> Link pages
                        </label>
                        <button onClick={() => setSidePane({ ...sidePane, refBookId: undefined, linked: false })} className="ml-2 rounded px-1.5 py-0.5 font-normal hover:bg-secondary cursor-pointer">Change book</button>
                      </>
                    )}
                    <button onClick={() => setSidePane(null)} className="ml-auto rounded p-0.5 hover:bg-secondary cursor-pointer" aria-label="Close split view"><X className="h-3.5 w-3.5" /></button>
                  </div>
                  <div className="min-h-0 flex-1">
                    <SidePane pane={sidePane} book={book} currentLoc={loc?.page ? `p${loc.page}` : null} annotations={annotations} onGoAnnotation={goAnnotation} onEditAnnotation={(a, r) => setEditing({ ann: a, rect: r })} onDeleteAnnotation={deleteAnnotation} />
                  </div>
                </div>
              </Panel>
            </>
          )}
        </Group>
      </div>

      {selection && (
        <SelectionPopover
          sel={selection}
          book={book}
          onClose={() => { setSelection(null); window.getSelection()?.removeAllRanges(); }}
          onAnnotate={async (kind, c, withNote) => {
            const saved = await createAnnotation({ kind, color: c, text: selection.text, anchor: selection.anchor, page_label: selection.pageLabel ?? null });
            setSelection(null);
            window.getSelection()?.removeAllRanges();
            document.querySelectorAll("iframe").forEach((f) => f.contentWindow?.getSelection()?.removeAllRanges());
            if (withNote && saved) setEditing({ ann: saved, rect: selection.rect });
          }}
          onReadAloud={() => { onTts("play"); setSelection(null); }}
          onAsk={(prompt) => { setSidePane({ ...(globalPane ?? {}), kind: "assistant", bookId: book.id, ask: { prompt, selection: selection.text, nonce: Date.now() } }); setSelection(null); }}
          onLookup={(w) => { setSidePane({ ...(globalPane ?? {}), kind: "lookup", lookup: w }); setSelection(null); }}
          onSearch={(q) => { setSearchSeed(q); setLeftOpen(true); setLeftTab("search"); setSelection(null); }}
          onNotebook={() => {
            const md = `> ${selection.text.replace(/\n/g, "\n> ")}\n> — *${book.title}*${selection.pageLabel ? `, p. ${selection.pageLabel}` : ""}\n`;
            toNotebook(md);
            setSelection(null);
          }}
        />
      )}
      {editing && (
        <AnnotationEditor
          ann={editing.ann}
          rect={editing.rect}
          onSave={saveAnnotation}
          onDelete={() => deleteAnnotation(editing.ann)}
          onClose={() => setEditing(null)}
          onNotebook={() => { toNotebook(annotationToMarkdown(editing.ann, book.title)); setEditing(null); }}
          bookTitle={book.title}
        />
      )}
      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} books={[book]} />
      {active && <VoiceAnswerCard book={book} onContinue={(q) => setSidePane({ ...(globalPane ?? {}), kind: "assistant", bookId: book.id, ask: { prompt: q, nonce: Date.now() } })} />}
      {audioChapters && <AudiobookDialog open onClose={() => setAudioChapters(null)} book={book} chapters={audioChapters} current={loc?.sectionLabel} />}
      <DocInfoDialog open={infoOpen} onClose={() => setInfoOpen(false)} book={book} meta={docMeta} pageCount={loc?.pageCount} />
    </div>
  );
}

// Stable wrapper so the session hook's callbacks don't change identity across renders.
import { useReaderSession } from "./useReaderSession";
function useReaderSessionLazy(bookId: number, active: boolean) {
  const s = useReaderSession(bookId, active);
  const ref = useRef(s);
  ref.current = s;
  return useMemo(() => ({
    onLocation: (l: LocationInfo) => ref.current.onLocation(l),
    saveSettings: (x: ReaderSettings) => ref.current.saveSettings(x),
  }), []);
}
