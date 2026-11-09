import { useState } from "react";
import { BookMarked, BookOpen, CheckCircle2, ChevronRight, Folder, FolderPlus, Heart, Library, Plus, Sparkles, Tag as TagIcon, Trash2, Pencil, AlertTriangle, User } from "lucide-react";
import { api, type Collection, type LibraryFilter, type SavedSearch, type TagWithCount } from "@/lib/api";
import { useApp } from "@/store/app";
import { useAsync } from "@/hooks/useAsync";
import { cn } from "@/lib/utils";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/menu";
import { toastError } from "@/components/ui/toast";
import { askConfirm, askText } from "@/components/ui/prompt";

export const TAG_COLORS = ["#e5484d", "#f76b15", "#ffc53d", "#46a758", "#12a594", "#0090ff", "#8e4ec6", "#d6409f", "#8d8d86"];

function Row({ active, icon: Icon, label, count, onClick, depth = 0, color, children, onDrop }: {
  active?: boolean; icon?: typeof Library; label: string; count?: number; onClick: () => void; depth?: number; color?: string | null; children?: React.ReactNode;
  onDrop?: (bookIds: number[]) => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <button
      onClick={onClick}
      onDragOver={onDrop ? (e) => { if (e.dataTransfer.types.includes("application/x-book-ids")) { e.preventDefault(); setOver(true); } } : undefined}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop ? (e) => { setOver(false); const ids = JSON.parse(e.dataTransfer.getData("application/x-book-ids") || "[]"); if (ids.length) onDrop(ids); } : undefined}
      className={cn(
        "group flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-[13px] cursor-pointer transition-colors",
        active ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : "text-sidebar-foreground hover:bg-secondary",
        over && "ring-2 ring-primary"
      )}
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      {children}
      {color ? <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} /> : Icon && <Icon className={cn("h-4 w-4 shrink-0", active ? "text-primary" : "text-muted-foreground")} />}
      <span className="flex-1 truncate text-left">{label}</span>
      {count !== undefined && <span className="text-[11px] tabular-nums text-muted-foreground">{count}</span>}
    </button>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <div className="mb-1 flex items-center justify-between px-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">{title}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

function sameFilter(a: LibraryFilter, b: LibraryFilter) {
  const strip = ({ sort, desc, text, ...r }: LibraryFilter) => JSON.stringify(r);
  return strip(a) === strip(b);
}

export function LibrarySidebar() {
  const { filter, setFilter, libraryVersion, bumpLibrary } = useApp();
  const cols = useAsync<Collection[]>(api.listCollections, [libraryVersion], []);
  const tags = useAsync<TagWithCount[]>(api.listTags, [libraryVersion], []);
  const saved = useAsync<SavedSearch[]>(api.listSavedSearches, [libraryVersion], []);
  const authors = useAsync(api.listAuthors, [libraryVersion], []);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [showAuthors, setShowAuthors] = useState(false);

  const go = (f: LibraryFilter) => setFilter({ sort: filter.sort, desc: filter.desc, ...f });
  const is = (f: LibraryFilter) => sameFilter(filter, f);

  const newCollection = async (parentId: number | null) => {
    const name = await askText({ title: parentId ? "New sub-collection" : "New collection", label: "Name", okLabel: "Create" });
    if (!name?.trim()) return;
    await api.createCollection(name.trim(), parentId).catch((e) => toastError("Could not create collection", e));
    if (parentId) setOpen((o) => ({ ...o, [parentId]: true }));
    bumpLibrary();
  };

  const renderTree = (parent: number | null, depth: number): React.ReactNode =>
    cols.data
      .filter((c) => c.parent_id === parent)
      .map((c) => {
        const kids = cols.data.some((k) => k.parent_id === c.id);
        return (
          <div key={c.id}>
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div>
                  <Row
                    depth={depth}
                    icon={Folder}
                    label={c.name}
                    count={c.count}
                    active={is({ collection_id: c.id })}
                    onClick={() => go({ collection_id: c.id })}
                    onDrop={async (ids) => { await api.setBookCollection(ids, c.id, true); bumpLibrary(); }}
                  >
                    <span
                      onClick={(e) => { e.stopPropagation(); setOpen((o) => ({ ...o, [c.id]: !o[c.id] })); }}
                      className={cn("-ml-1 rounded p-0.5 hover:bg-background", !kids && "invisible")}
                    >
                      <ChevronRight className={cn("h-3 w-3 transition-transform", open[c.id] && "rotate-90")} />
                    </span>
                  </Row>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => newCollection(c.id)}><FolderPlus /> New sub-collection</ContextMenuItem>
                <ContextMenuItem onSelect={async () => { const n = await askText({ title: "Rename collection", initial: c.name, okLabel: "Rename" }); if (n?.trim()) { await api.renameCollection(c.id, n.trim()); bumpLibrary(); } }}><Pencil /> Rename</ContextMenuItem>
                {c.parent_id !== null && <ContextMenuItem onSelect={async () => { await api.moveCollection(c.id, null); bumpLibrary(); }}><Folder /> Move to top level</ContextMenuItem>}
                <ContextMenuSeparator />
                <ContextMenuItem className="text-destructive" onSelect={async () => { if (await askConfirm({ title: `Delete collection "${c.name}"?`, description: "Books stay in your library.", okLabel: "Delete", destructive: true })) { await api.deleteCollection(c.id); if (filter.collection_id === c.id) go({}); bumpLibrary(); } }}><Trash2 /> Delete collection</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            {open[c.id] && renderTree(c.id, depth + 1)}
          </div>
        );
      });

  return (
    <aside className="flex w-60 shrink-0 flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar p-2 custom-scrollbar">
      <Row icon={Library} label="All books" active={is({})} onClick={() => go({})} />
      <Row icon={BookOpen} label="Reading" active={is({ status: "reading" })} onClick={() => go({ status: "reading", sort: "opened" })} />
      <Row icon={BookMarked} label="Unread" active={is({ status: "unread" })} onClick={() => go({ status: "unread" })} />
      <Row icon={CheckCircle2} label="Finished" active={is({ status: "finished" })} onClick={() => go({ status: "finished" })} />
      <Row icon={Heart} label="Favorites" active={is({ favorite: true })} onClick={() => go({ favorite: true })} />
      <Row icon={AlertTriangle} label="Missing files" active={is({ missing: true })} onClick={() => go({ missing: true })} />

      <Section title="Collections" action={<button onClick={() => newCollection(null)} className="rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground cursor-pointer" aria-label="New collection"><Plus className="h-3.5 w-3.5" /></button>}>
        {cols.data.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">Create collections to organize books. Drag books onto them.</p>}
        {renderTree(null, 0)}
      </Section>

      {saved.data.length > 0 && (
        <Section title="Smart collections">
          {saved.data.map((s) => (
            <ContextMenu key={s.id}>
              <ContextMenuTrigger asChild>
                <div><Row icon={Sparkles} label={s.name} active={is(s.filter)} onClick={() => setFilter(s.filter)} /></div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={async () => { await api.saveSearch(s.name, filter, s.id); saved.reload(); }}><Pencil /> Update with current filter</ContextMenuItem>
                <ContextMenuItem className="text-destructive" onSelect={async () => { if (!(await askConfirm({ title: `Delete smart collection "${s.name}"?`, description: "Books stay in your library.", okLabel: "Delete", destructive: true }))) return; await api.deleteSavedSearch(s.id); saved.reload(); }}><Trash2 /> Delete</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
        </Section>
      )}

      <Section title="Tags">
        {tags.data.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">Right-click a book to tag it.</p>}
        <div className="flex flex-wrap gap-1 px-1">
          {tags.data.map((t) => {
            const on = filter.tag_ids?.includes(t.id);
            return (
              <ContextMenu key={t.id}>
                <ContextMenuTrigger asChild>
                  <button
                    onClick={() => setFilter({ ...filter, tag_ids: on ? filter.tag_ids!.filter((x) => x !== t.id) : [...(filter.tag_ids ?? []), t.id] })}
                    onDragOver={(e) => e.dataTransfer.types.includes("application/x-book-ids") && e.preventDefault()}
                    onDrop={async (e) => { const ids = JSON.parse(e.dataTransfer.getData("application/x-book-ids") || "[]"); await api.setBookTag(ids, t.id, true); bumpLibrary(); }}
                    className={cn("flex items-center gap-1 rounded-full border px-2 py-0.5 text-[12px] cursor-pointer", on ? "border-primary bg-accent text-accent-foreground" : "hover:bg-secondary")}
                  >
                    <span className="h-2 w-2 rounded-full" style={{ background: t.color ?? "#8d8d86" }} />
                    {t.name}
                    <span className="text-muted-foreground">{t.count}</span>
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <div className="flex gap-1 p-2">
                    {TAG_COLORS.map((c) => (
                      <button key={c} onClick={async () => { await api.updateTag(t.id, t.name, c); tags.reload(); bumpLibrary(); }} className="h-4 w-4 rounded-full cursor-pointer ring-offset-1 hover:ring-2 ring-ring" style={{ background: c }} aria-label={`color ${c}`} />
                    ))}
                  </div>
                  <ContextMenuItem onSelect={async () => { const n = await askText({ title: "Rename tag", initial: t.name, okLabel: "Rename" }); if (n?.trim()) { await api.updateTag(t.id, n.trim(), t.color); bumpLibrary(); } }}><Pencil /> Rename</ContextMenuItem>
                  <ContextMenuItem className="text-destructive" onSelect={async () => { if (!(await askConfirm({ title: `Delete tag "${t.name}"?`, description: "It is removed from every book. Books stay in your library.", okLabel: "Delete", destructive: true }))) return; await api.deleteTag(t.id); bumpLibrary(); }}><Trash2 /> Delete tag</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>
      </Section>

      <Section title="Authors" action={<button onClick={() => setShowAuthors(!showAuthors)} className="text-[11px] text-muted-foreground hover:text-foreground cursor-pointer">{showAuthors ? "Hide" : `Show ${authors.data.length}`}</button>}>
        {showAuthors && authors.data.map((a) => (
          <Row key={a.name} icon={User} label={a.name} count={a.count} active={filter.author === a.name} onClick={() => go({ author: a.name })} />
        ))}
      </Section>
      <div className="h-4" />
      {tags.data.length === 0 && <TagIcon className="hidden" />}
    </aside>
  );
}
