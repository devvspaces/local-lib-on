import { BookOpen, CheckCircle2, Folder, FolderOpen, Heart, Info, Pencil, Plus, Tag as TagIcon, Trash2, BookMarked, Quote, Wand2 } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, type Book, type Collection, type TagWithCount } from "@/lib/api";
import { useApp } from "@/store/app";
import {
  ContextMenuCheck, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger,
} from "@/components/ui/menu";
import { toast, toastError } from "@/components/ui/toast";
import { formatCitation } from "@/lib/citations";
import { askConfirm, askText } from "@/components/ui/prompt";
import { identifyAndApply } from "@/lib/identify";
import { retrieveMetadata } from "@/lib/enricher";
import { Sparkles, Circle } from "lucide-react";

export function BookMenuContent({ books, collections, tags, onEdit, onInfo }: {
  books: Book[]; collections: Collection[]; tags: TagWithCount[]; onEdit: (b: Book) => void; onInfo: (b: Book) => void;
}) {
  const { openBook, bumpLibrary } = useApp();
  const ids = books.map((b) => b.id);
  const one = books.length === 1 ? books[0] : null;
  const patchAll = async (patch: Parameters<typeof api.updateBook>[1]) => {
    await Promise.all(ids.map((id) => api.updateBook(id, patch))).catch((e) => toastError("Update failed", e));
    bumpLibrary();
  };

  return (
    <ContextMenuContent className="w-56">
      {one && <ContextMenuItem onSelect={() => openBook(one.id, one.title)}><BookOpen /> Open</ContextMenuItem>}
      {one && <ContextMenuItem onSelect={() => onInfo(one)}><Info /> Details</ContextMenuItem>}
      {one && <ContextMenuItem onSelect={() => onEdit(one)}><Pencil /> Edit metadata…</ContextMenuItem>}
      {one && (
        <ContextMenuItem onSelect={async () => { await navigator.clipboard.writeText(formatCitation(one, "apa")); toast("Citation copied", "APA format"); }}>
          <Quote /> Copy citation
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => { void retrieveMetadata(books); }}><Wand2 /> Retrieve metadata &amp; cover</ContextMenuItem>
      {one && <ContextMenuItem onSelect={() => identifyAndApply(one).then((ok) => ok && bumpLibrary())}><Sparkles /> Identify with AI…</ContextMenuItem>}
      <ContextMenuSeparator />
      <ContextMenuSub>
        <ContextMenuSubTrigger><BookMarked /> Status</ContextMenuSubTrigger>
        <ContextMenuSubContent>
          {(["unread", "reading", "finished"] as const).map((s) => (
            <ContextMenuCheck key={s} checked={books.every((b) => b.status === s)} onSelect={() => patchAll({ status: s })} className="capitalize">{s}</ContextMenuCheck>
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuItem onSelect={() => patchAll({ favorite: !books.every((b) => b.favorite) })}>
        <Heart /> {books.every((b) => b.favorite) ? "Remove from favorites" : "Add to favorites"}
      </ContextMenuItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger><Folder /> Collections</ContextMenuSubTrigger>
        <ContextMenuSubContent className="max-h-80 overflow-y-auto">
          {collections.length > 0 && <p className="px-2 pb-1 pt-0.5 text-[11px] text-muted-foreground">Tick to add · untick to remove</p>}
          {collections.map((c) => {
            const all = books.every((b) => b.collection_ids.includes(c.id));
            return (
              <ContextMenuCheck key={c.id} checked={all} onSelect={async (e) => { e.preventDefault(); await api.setBookCollection(ids, c.id, !all); bumpLibrary(); }}>
                {c.name}
              </ContextMenuCheck>
            );
          })}
          {collections.length > 0 && <ContextMenuSeparator />}
          <ContextMenuItem onSelect={async () => {
            const n = await askText({ title: "New collection", label: "Name", okLabel: "Create" });
            if (!n?.trim()) return;
            const id = await api.createCollection(n.trim());
            await api.setBookCollection(ids, id, true);
            bumpLibrary();
          }}><Plus /> New collection…</ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSub>
        <ContextMenuSubTrigger><TagIcon /> Tags</ContextMenuSubTrigger>
        <ContextMenuSubContent className="max-h-80 overflow-y-auto">
          {tags.map((t) => {
            const all = books.every((b) => b.tags.some((x) => x.id === t.id));
            return (
              <ContextMenuCheck key={t.id} checked={all} onSelect={async (e) => { e.preventDefault(); await api.setBookTag(ids, t.id, !all); bumpLibrary(); }}>
                <span className="h-2 w-2 rounded-full" style={{ background: t.color ?? "#8d8d86" }} /> {t.name}
              </ContextMenuCheck>
            );
          })}
          {tags.length > 0 && <ContextMenuSeparator />}
          <ContextMenuItem onSelect={async () => {
            const n = await askText({ title: "New tag", label: "Name", okLabel: "Create" });
            if (!n?.trim()) return;
            const id = await api.upsertTag(n.trim());
            await api.setBookTag(ids, id, true);
            bumpLibrary();
          }}><Plus /> New tag…</ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator />
      {one?.files[0] && <ContextMenuItem onSelect={() => revealItemInDir(one.files[0].path)}><FolderOpen /> Show in Finder</ContextMenuItem>}
      {books.every((b) => b.status === "finished")
        ? <ContextMenuItem onSelect={() => patchAll({ status: "unread" })}><Circle /> Mark as unread</ContextMenuItem>
        : <ContextMenuItem onSelect={() => patchAll({ status: "finished" })}><CheckCircle2 /> Mark as finished</ContextMenuItem>}
      <ContextMenuSeparator />
      <ContextMenuItem
        className="text-destructive"
        onSelect={async () => {
          const label = one ? `"${one.title}"` : `${books.length} books`;
          if (!(await askConfirm({ title: `Remove ${label} from the library?`, description: "Files stay on disk. Notes and annotations for it are deleted.", okLabel: "Remove", destructive: true }))) return;
          for (const id of ids) await api.deleteBook(id, false);
          bumpLibrary();
        }}
      ><Trash2 /> Remove from library</ContextMenuItem>
    </ContextMenuContent>
  );
}
