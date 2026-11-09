import { useEffect, useState } from "react";
import { NotebookPen, Trash2, X, Copy, Layers } from "lucide-react";
import { cardFromAnnotation, cardsApi, makeCloze } from "@/lib/cards";
import type { Annotation } from "@/lib/api";
import { HIGHLIGHT_COLORS } from "./types";
import { toast } from "@/components/ui/toast";

/** Popup note editor for an annotation (Okular "popup note"): comment, color-code, tags. */
export function AnnotationEditor({ ann, rect, onSave, onDelete, onClose, onNotebook, bookTitle }: {
  bookTitle?: string;
  ann: Annotation; rect: DOMRect; onSave: (a: Annotation) => void; onDelete: () => void; onClose: () => void; onNotebook: () => void;
}) {
  const [comment, setComment] = useState(ann.comment ?? "");
  const [tags, setTags] = useState(ann.tags.join(", "));
  useEffect(() => { setComment(ann.comment ?? ""); setTags(ann.tags.join(", ")); }, [ann.id]);
  const commit = (patch: Partial<Annotation> = {}) =>
    onSave({ ...ann, comment: comment || null, tags: tags.split(",").map((t) => t.trim().replace(/^#/, "")).filter(Boolean), ...patch });

  const left = Math.max(8, Math.min(window.innerWidth - 330, rect.left));
  const top = Math.min(window.innerHeight - 260, rect.bottom + 8);
  return (
    <div className="fixed z-50 w-80 rounded-lg border bg-popover p-3 shadow-xl animate-in fade-in-0" style={{ left, top }} onMouseDown={(e) => e.stopPropagation()}>
      <div className="mb-2 flex items-center gap-1">
        {HIGHLIGHT_COLORS.map((c) => (
          <button key={c.id} title={c.label} onClick={() => commit({ color: c.value })} className="h-4 w-4 rounded-full cursor-pointer ring-offset-1 ring-offset-popover" style={{ background: c.value, boxShadow: ann.color === c.value ? `0 0 0 2px var(--ring)` : undefined }} />
        ))}
        <span className="ml-auto text-[11px] capitalize text-muted-foreground">{ann.kind}{ann.page_label ? ` · p. ${ann.page_label}` : ""}</span>
        <button onClick={() => { commit(); onClose(); }} className="ml-1 text-muted-foreground hover:text-foreground cursor-pointer" aria-label="Close"><X className="h-3.5 w-3.5" /></button>
      </div>
      {ann.text && <p className="mb-2 max-h-24 overflow-y-auto border-l-2 pl-2 font-serif text-[13px] leading-snug text-muted-foreground custom-scrollbar" style={{ borderColor: ann.color ?? undefined }} data-selectable>{ann.text}</p>}
      <textarea
        autoFocus
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { commit(); onClose(); } if (e.key === "Escape") { commit(); onClose(); } }}
        placeholder="Add a note… (⌘↵ to save)"
        rows={4}
        className="w-full resize-none rounded-md border bg-background p-2 text-[13px] outline-none focus:ring-2 focus:ring-ring"
      />
      <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tags, comma separated" className="mt-1.5 h-7 w-full rounded-md border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring" />
      <div className="mt-2 flex items-center gap-1">
        <button onClick={onDelete} className="flex items-center gap-1 rounded px-2 py-1 text-xs text-destructive hover:bg-destructive/10 cursor-pointer"><Trash2 className="h-3.5 w-3.5" /> Delete</button>
        <button onClick={async () => { await navigator.clipboard.writeText(ann.text ?? ann.comment ?? ""); toast("Copied"); }} className="flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-secondary cursor-pointer"><Copy className="h-3.5 w-3.5" /></button>
        <button onClick={onNotebook} className="flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-secondary cursor-pointer"><NotebookPen className="h-3.5 w-3.5" /> Notebook</button>
        <button
          title="Make a flashcard. Select a phrase inside the quote above first to hide it as a cloze."
          onClick={async () => {
            const sel = window.getSelection()?.toString().trim();
            const text = (ann.text ?? "").replace(/\s+/g, " ").trim();
            const src = `${bookTitle ?? ""}${ann.page_label ? `, p. ${ann.page_label}` : ""}`;
            const manual = sel && text ? makeCloze(text, sel) : null;
            const card = manual ? { front: manual, back: [comment, src].filter(Boolean).join("\n\n— ") } : cardFromAnnotation({ ...ann, comment: comment || null }, bookTitle);
            if (!card) { toast("Nothing to make a card from"); return; }
            try { await cardsApi.upsert({ ...card, book_id: ann.book_id, annotation_id: ann.id }); toast("Flashcard created", "Review it in the Review tab"); }
            catch (e) { toast("Card already exists for this annotation", String(e)); }
          }}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-secondary cursor-pointer"
        ><Layers className="h-3.5 w-3.5" /> Card</button>
        <button onClick={() => { commit(); onClose(); }} className="ml-auto rounded bg-primary px-3 py-1 text-xs text-primary-foreground cursor-pointer">Save</button>
      </div>
    </div>
  );
}
