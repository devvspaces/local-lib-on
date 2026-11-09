import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ArrowDownUp, Download, FilePlus2, FolderPlus, LayoutGrid, List, Loader2, RefreshCw, Search, Sparkles, X, Heart } from "lucide-react";
import { api, type Book, type Collection, type TagWithCount } from "@/lib/api";
import { useApp } from "@/store/app";
import { useAsync } from "@/hooks/useAsync";
import { cn, formatBytes } from "@/lib/utils";
import { ToolButton } from "@/components/ui/tooltip-button";
import { Menu, MenuCheck, MenuContent, MenuTrigger, MenuSeparator } from "@/components/ui/menu";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/menu";
import { toast, toastError } from "@/components/ui/toast";
import { LibrarySidebar } from "./LibrarySidebar";
import { BookCover } from "./BookCover";
import { BookMenuContent } from "./BookMenu";
import { MetadataDialog } from "./MetadataDialog";
import { BookDetails } from "./BookDetails";
import { ImportIdentifierDialog } from "./ImportIdentifierDialog";
import { ExportDialog } from "@/views/export/ExportDialog";
import { askText } from "@/components/ui/prompt";
import { TodayPlanCard } from "@/views/stats/StudyPlan";

const SORTS = [
  ["added", "Date added"], ["opened", "Last opened"], ["title", "Title"], ["author", "Author"], ["year", "Year"], ["progress", "Progress"],
] as const;

export function LibraryView() {
  const { filter, patchFilter, libraryVersion, bumpLibrary, openBook, libraryLayout, setLibraryLayout } = useApp();
  const [text, setText] = useState(filter.text ?? "");
  useEffect(() => {
    const t = setTimeout(() => patchFilter({ text: text || undefined }), 180);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const books = useAsync<Book[]>(() => api.listBooks(filter), [JSON.stringify(filter), libraryVersion], []);
  const cols = useAsync<Collection[]>(api.listCollections, [libraryVersion], []);
  const tags = useAsync<TagWithCount[]>(api.listTags, [libraryVersion], []);
  const continueReading = useAsync<Book[]>(() => api.listBooks({ status: "reading", sort: "opened" }), [libraryVersion], []);

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<Book | null>(null);
  const [details, setDetails] = useState<Book | null>(null);
  const [scanning, setScanning] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [idDialog, setIdDialog] = useState(false);
  const [exporting, setExporting] = useState(false);
  const lastClicked = useRef<number | null>(null);

  // Drag & drop files / folders from Finder.
  useEffect(() => {
    let un: (() => void) | undefined, dead = false;
    getCurrentWebview()
      .onDragDropEvent(async (e) => {
        if (e.payload.type === "over" || e.payload.type === "enter") setDropping(true);
        else if (e.payload.type === "leave") setDropping(false);
        else if (e.payload.type === "drop") {
          setDropping(false);
          if (useApp.getState().view !== "library") return;
          try {
            const ids = await api.importFiles(e.payload.paths);
            toast(`Imported ${new Set(ids).size} book(s)`);
          } catch (err) {
            toastError("Import failed", err);
          }
        }
      })
      .then((f) => (dead ? f() : (un = f)));
    return () => { dead = true; un?.(); };
  }, []);

  const addFolder = async () => {
    const dir = await openDialog({ directory: true, multiple: false, title: "Choose a folder with books" });
    if (typeof dir !== "string") return;
    setScanning(true);
    try {
      const r = await api.addWatchFolder(dir);
      toast("Folder added", `${r.scanned} files scanned, ${r.added} new${r.errors.length ? `, ${r.errors.length} errors` : ""}. It will be watched for changes.`);
    } catch (e) {
      toastError("Could not add folder", e);
    } finally {
      setScanning(false);
    }
  };

  const addFiles = async () => {
    const files = await openDialog({ multiple: true, title: "Import books", filters: [{ name: "Books", extensions: ["pdf", "epub", "mobi", "azw", "azw3", "fb2", "cbz", "txt", "md", "docx", "odt", "djvu", "djv"] }] });
    if (!files) return;
    const ids = await api.importFiles(Array.isArray(files) ? files : [files]).catch((e) => (toastError("Import failed", e), []));
    if (ids.length) toast(`Imported ${new Set(ids).size} book(s)`);
  };

  const rescan = async () => {
    setScanning(true);
    try {
      const r = await api.rescan();
      toast("Library synced", `${r.scanned} files · ${r.added} new · ${r.moved} moved · ${r.missing} missing`);
    } catch (e) {
      toastError("Rescan failed", e);
    } finally {
      setScanning(false);
    }
  };

  const click = (b: Book, e: React.MouseEvent) => {
    const s = new Set(e.metaKey || e.ctrlKey ? selected : []);
    if (e.shiftKey && lastClicked.current !== null) {
      const ids = books.data.map((x) => x.id);
      const [a, z] = [ids.indexOf(lastClicked.current), ids.indexOf(b.id)].sort((x, y) => x - y);
      ids.slice(a, z + 1).forEach((id) => s.add(id));
    } else if ((e.metaKey || e.ctrlKey) && selected.has(b.id)) s.delete(b.id);
    else s.add(b.id);
    lastClicked.current = b.id;
    setSelected(s);
    setDetails(b);
  };

  const menuBooks = (b: Book) => (selected.has(b.id) ? books.data.filter((x) => selected.has(x.id)) : [b]);
  const title = useMemo(() => {
    if (filter.collection_id) return cols.data.find((c) => c.id === filter.collection_id)?.name ?? "Collection";
    if (filter.author) return filter.author;
    if (filter.favorite) return "Favorites";
    if (filter.missing) return "Missing files";
    if (filter.status) return filter.status[0].toUpperCase() + filter.status.slice(1);
    if (filter.tag_ids?.length) return "Tagged";
    return "All books";
  }, [filter, cols.data]);
  const isHome = !filter.collection_id && !filter.author && !filter.status && !filter.favorite && !filter.missing && !filter.tag_ids?.length && !filter.text;

  const dragStart = (b: Book) => (e: React.DragEvent) => {
    const ids = selected.has(b.id) ? [...selected] : [b.id];
    e.dataTransfer.setData("application/x-book-ids", JSON.stringify(ids));
    e.dataTransfer.effectAllowed = "copy";
  };

  return (
    <div className="flex h-full">
      <LibrarySidebar />
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <h1 className="mr-2 truncate text-[15px] font-semibold">{title}</h1>
          <span className="text-xs text-muted-foreground">{books.data.length}</span>
          <div className="relative ml-auto w-72">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Filter by title, author, ISBN, path…"
              className="h-8 w-full rounded-md border bg-card pl-8 pr-7 text-[13px] outline-none focus:ring-2 focus:ring-ring"
            />
            {text && <button onClick={() => setText("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground cursor-pointer"><X className="h-3.5 w-3.5" /></button>}
          </div>
          {!isHome && (
            <ToolButton label="Save as smart collection" onClick={async () => { const n = await askText({ title: "Save as smart collection", label: "Name", initial: title, okLabel: "Save" }); if (n?.trim()) { await api.saveSearch(n.trim(), filter); bumpLibrary(); } }}>
              <Sparkles />
            </ToolButton>
          )}
          <Menu>
            <MenuTrigger asChild><ToolButton label="Sort"><ArrowDownUp /></ToolButton></MenuTrigger>
            <MenuContent align="end">
              {SORTS.map(([id, label]) => (
                <MenuCheck key={id} checked={(filter.sort ?? "added") === id} onSelect={() => patchFilter({ sort: id, desc: undefined })}>{label}</MenuCheck>
              ))}
              <MenuSeparator />
              <MenuCheck checked={!!filter.desc} onSelect={() => patchFilter({ desc: !filter.desc })}>Descending</MenuCheck>
            </MenuContent>
          </Menu>
          <div className="flex rounded-md border p-0.5">
            <ToolButton label="Grid" active={libraryLayout === "grid"} onClick={() => setLibraryLayout("grid")}><LayoutGrid /></ToolButton>
            <ToolButton label="List" active={libraryLayout === "list"} onClick={() => setLibraryLayout("list")}><List /></ToolButton>
          </div>
          <ToolButton label="Rescan library folders" onClick={rescan} disabled={scanning}>{scanning ? <Loader2 className="animate-spin" /> : <RefreshCw />}</ToolButton>
          <ToolButton label="Add by ISBN / DOI / arXiv" onClick={() => setIdDialog(true)}><span className="text-[11px] font-semibold">ID</span></ToolButton>
          <ToolButton label={selected.size ? `Export ${selected.size} selected` : "Export notes / bibliography for this view"} onClick={() => setExporting(true)}><Download /></ToolButton>
          <ToolButton label="Import files" onClick={addFiles}><FilePlus2 /></ToolButton>
          <ToolButton label="Add & watch folder" onClick={addFolder}><FolderPlus /></ToolButton>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="relative min-w-0 flex-1 overflow-y-auto custom-scrollbar" onClick={(e) => e.target === e.currentTarget && setSelected(new Set())}>
            {dropping && (
              <div className="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-accent/60 text-sm font-medium text-accent-foreground">
                Drop files or folders to import
              </div>
            )}

            {isHome && <TodayPlanCard compact />}
            {isHome && continueReading.data.length > 0 && (
              <div className="px-5 pt-4">
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Continue reading</h2>
                <div className="flex gap-3 overflow-x-auto pb-2 custom-scrollbar">
                  {continueReading.data.slice(0, 12).map((b) => (
                    <button key={b.id} onClick={() => openBook(b.id, b.title)} className="group flex w-64 shrink-0 gap-3 rounded-lg border bg-card p-2 text-left hover:border-primary/50 cursor-pointer">
                      <div className="h-20 w-14 shrink-0 overflow-hidden rounded shadow-sm"><BookCover book={b} /></div>
                      <div className="min-w-0 flex-1 py-0.5">
                        <p className="line-clamp-2 text-[13px] font-semibold leading-tight">{b.title}</p>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">{b.authors.join(", ")}</p>
                        <div className="mt-2 h-1 rounded-full bg-secondary"><div className="h-1 rounded-full bg-primary" style={{ width: `${Math.round(b.percent * 100)}%` }} /></div>
                        <p className="mt-1 text-[11px] text-muted-foreground">{Math.round(b.percent * 100)}%</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {!books.loading && books.data.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
                <p className="text-sm font-medium">{isHome ? "Your library is empty" : "No books match"}</p>
                {isHome && (
                  <>
                    <p className="max-w-sm text-sm text-muted-foreground">Add the folders where you keep PDFs and ebooks. Files stay where they are; the folders are watched for new books.</p>
                    <div className="flex gap-2">
                      <button onClick={addFolder} className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground cursor-pointer">Add a folder</button>
                      <button onClick={addFiles} className="rounded-md border px-3 py-1.5 text-sm cursor-pointer">Import files</button>
                    </div>
                  </>
                )}
              </div>
            )}

            {libraryLayout === "grid" ? (
              <div className="grid gap-x-4 gap-y-5 p-5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(132px, 1fr))" }}>
                {books.data.map((b) => (
                  <ContextMenu key={b.id} onOpenChange={(o) => o && !selected.has(b.id) && setSelected(new Set([b.id]))}>
                    <ContextMenuTrigger asChild>
                      <div
                        draggable
                        onDragStart={dragStart(b)}
                        onClick={(e) => click(b, e)}
                        onDoubleClick={() => openBook(b.id, b.title)}
                        className="group cursor-pointer"
                      >
                        <div className={cn("relative aspect-[2/3] overflow-hidden rounded-md bg-secondary shadow-sm ring-offset-2 ring-offset-background transition-shadow group-hover:shadow-md", selected.has(b.id) && "ring-2 ring-primary")}>
                          <BookCover book={b} />
                          {b.percent > 0 && <div className="absolute inset-x-0 bottom-0 h-1 bg-black/30"><div className="h-1 bg-primary" style={{ width: `${b.percent * 100}%` }} /></div>}
                          {b.favorite && <Heart className="absolute right-1.5 top-1.5 h-3.5 w-3.5 fill-primary text-primary drop-shadow" />}
                          {b.files.length === 0
                            ? <span title="Saved as a reference, with no file. Download it from Discover to read it." className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1 text-[10px] text-white">reference</span>
                            : b.files.every((f) => f.missing) && <span title="The file was moved or deleted" className="absolute left-1.5 top-1.5 rounded bg-destructive px-1 text-[10px] text-white">missing</span>}
                        </div>
                        <p className="mt-2 line-clamp-2 text-[13px] font-medium leading-tight">{b.title}</p>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">{b.authors.join(", ") || " "}</p>
                        {b.tags.length > 0 && (
                          <div className="mt-1 flex gap-1">{b.tags.slice(0, 5).map((t) => <span key={t.id} title={t.name} className="h-1.5 w-1.5 rounded-full" style={{ background: t.color ?? "#8d8d86" }} />)}</div>
                        )}
                      </div>
                    </ContextMenuTrigger>
                    <BookMenuContent books={menuBooks(b)} collections={cols.data} tags={tags.data} onEdit={setEditing} onInfo={setDetails} />
                  </ContextMenu>
                ))}
              </div>
            ) : (
              <table className="w-full text-[13px]">
                <thead className="sticky top-0 z-[1] bg-background text-left text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className="px-4 py-2 font-medium">Title</th><th className="px-2 py-2 font-medium">Author</th><th className="px-2 py-2 font-medium">Year</th>
                    <th className="px-2 py-2 font-medium">Format</th><th className="px-2 py-2 font-medium">Size</th><th className="px-2 py-2 font-medium">Progress</th><th className="px-2 py-2 font-medium">Tags</th>
                  </tr>
                </thead>
                <tbody>
                  {books.data.map((b) => (
                    <ContextMenu key={b.id} onOpenChange={(o) => o && !selected.has(b.id) && setSelected(new Set([b.id]))}>
                      <ContextMenuTrigger asChild>
                        <tr draggable onDragStart={dragStart(b)} onClick={(e) => click(b, e)} onDoubleClick={() => openBook(b.id, b.title)} className={cn("cursor-pointer border-b border-border/50 hover:bg-secondary/60", selected.has(b.id) && "bg-accent hover:bg-accent")}>
                          <td className="max-w-0 truncate px-4 py-1.5 font-medium" style={{ width: "40%" }}>{b.favorite && "♥ "}{b.title}</td>
                          <td className="max-w-0 truncate px-2 py-1.5 text-muted-foreground" style={{ width: "22%" }}>{b.authors.join(", ")}</td>
                          <td className="px-2 py-1.5 tabular-nums text-muted-foreground">{b.year ?? ""}</td>
                          <td className="px-2 py-1.5 uppercase text-muted-foreground">{[...new Set(b.files.map((f) => f.format))].join(", ")}</td>
                          <td className="px-2 py-1.5 tabular-nums text-muted-foreground">{formatBytes(b.files[0]?.size)}</td>
                          <td className="px-2 py-1.5 tabular-nums text-muted-foreground">{b.percent ? `${Math.round(b.percent * 100)}%` : ""}</td>
                          <td className="px-2 py-1.5">{b.tags.map((t) => <span key={t.id} className="mr-1 inline-block h-2 w-2 rounded-full" title={t.name} style={{ background: t.color ?? "#8d8d86" }} />)}</td>
                        </tr>
                      </ContextMenuTrigger>
                      <BookMenuContent books={menuBooks(b)} collections={cols.data} tags={tags.data} onEdit={setEditing} onInfo={setDetails} />
                    </ContextMenu>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {details && (
            <BookDetails
              bookId={details.id}
              onClose={() => setDetails(null)}
              onEdit={setEditing}
            />
          )}
        </div>
      </section>
      <MetadataDialog book={editing} onClose={() => setEditing(null)} />
      <ImportIdentifierDialog open={idDialog} onClose={() => setIdDialog(false)} />
      <ExportDialog open={exporting} onClose={() => setExporting(false)} books={selected.size ? books.data.filter((b) => selected.has(b.id)) : books.data} />
    </div>
  );
}
