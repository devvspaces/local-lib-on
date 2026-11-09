import { useEffect, useRef, useState } from "react";
import { Eye, PencilLine, Columns2 } from "lucide-react";
import { api, type Note } from "@/lib/api";
import { annotationToMarkdown } from "@/lib/annotationMarkdown";
import { renderMarkdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import { ToolButton } from "@/components/ui/tooltip-button";
import { useApp } from "@/store/app";
import { notebookBus } from "@/reader/notebookBus";

/** Markdown note editor with live preview. Accepts dropped annotations; listens to the notebook bus when `listen`. */
export function NoteEditor({ note, onChange, listen = false, bookTitle }: { note: Note; onChange: (n: Note) => void; listen?: boolean; bookTitle?: string }) {
  const [mode, setMode] = useState<"edit" | "split" | "preview">("split");
  const [body, setBody] = useState(note.body);
  const [title, setTitle] = useState(note.title);
  const ta = useRef<HTMLTextAreaElement>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const latest = useRef({ ...note });
  const openBook = useApp((s) => s.openBook);

  useEffect(() => { setBody(note.body); setTitle(note.title); latest.current = { ...note }; }, [note.id]);

  const persist = (patch: Partial<Note>) => {
    latest.current = { ...latest.current, ...patch };
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      const saved = await api.upsertNote(latest.current);
      latest.current = saved;
      onChange(saved);
    }, 500);
  };
  useEffect(() => () => {
    window.clearTimeout(saveTimer.current);
    if (latest.current.body !== note.body || latest.current.title !== note.title) api.upsertNote(latest.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const insert = (text: string) => {
    const el = ta.current;
    const at = el ? el.selectionStart : body.length;
    const next = body.slice(0, at) + (at && !body.slice(0, at).endsWith("\n") ? "\n\n" : "") + text + body.slice(at);
    setBody(next);
    persist({ body: next });
    requestAnimationFrame(() => { if (el) { el.focus(); el.selectionStart = el.selectionEnd = at + text.length + 2; } });
  };
  const insertRef = useRef(insert);
  insertRef.current = insert;
  useEffect(() => (listen ? notebookBus.on((e) => e.type === "insert" && insertRef.current(e.markdown)) : undefined), [listen]);

  const onPreviewClick = async (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("ann://")) {
      const id = href.slice(6);
      const all = await api.listAnnotations();
      const ann = all.find((x) => x.id === id);
      if (!ann) return;
      const b = await api.getBook(ann.book_id);
      openBook(b.id, b.title, "page" in ann.anchor ? { page: ann.anchor.page } : { cfi: ann.anchor.cfi });
    } else if (/^https?:/.test(href)) {
      (await import("@tauri-apps/plugin-opener")).openUrl(href);
    }
  };

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => e.dataTransfer.types.includes("application/x-annotation") && e.preventDefault()}
      onDrop={(e) => {
        const raw = e.dataTransfer.getData("application/x-annotation");
        if (raw) { e.preventDefault(); insert(annotationToMarkdown(JSON.parse(raw), bookTitle)); }
      }}
    >
      <div className="flex items-center gap-1 border-b px-2 py-1">
        <input
          value={title}
          onChange={(e) => { setTitle(e.target.value); persist({ title: e.target.value }); }}
          placeholder="Untitled note"
          className="min-w-0 flex-1 bg-transparent px-1 text-sm font-semibold outline-none"
        />
        <ToolButton label="Edit" active={mode === "edit"} onClick={() => setMode("edit")}><PencilLine /></ToolButton>
        <ToolButton label="Split" active={mode === "split"} onClick={() => setMode("split")}><Columns2 /></ToolButton>
        <ToolButton label="Preview" active={mode === "preview"} onClick={() => setMode("preview")}><Eye /></ToolButton>
      </div>
      <div className={cn("grid min-h-0 flex-1", mode === "split" ? "grid-rows-2" : "grid-rows-1")}>
        {mode !== "preview" && (
          <textarea
            ref={ta}
            value={body}
            onChange={(e) => { setBody(e.target.value); persist({ body: e.target.value }); }}
            placeholder={"Write in Markdown.\nDrag annotations here, or use “Add to notebook” from a selection."}
            className="min-h-0 w-full resize-none bg-background p-3 font-mono text-[13px] leading-relaxed outline-none custom-scrollbar"
          />
        )}
        {mode !== "edit" && (
          <div onClick={onPreviewClick} className={cn("md-preview min-h-0 overflow-y-auto p-3 custom-scrollbar", mode === "split" && "border-t")} dangerouslySetInnerHTML={{ __html: renderMarkdown(body || "*Nothing yet.*") }} />
        )}
      </div>
    </div>
  );
}
