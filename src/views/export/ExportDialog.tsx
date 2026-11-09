import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Copy, Download } from "lucide-react";
import { api, type Book } from "@/lib/api";
import { CITATION_STYLES, type CitationStyle } from "@/lib/citations";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast, toastError } from "@/components/ui/toast";
import { bibliography, toDocx, toMarkdown, toPlainText, type ExportOptions } from "./exporters";
import { StylePicker, lastStyle } from "@/components/StylePicker";
import { copyRich, formatBibliography, prettyStyle } from "@/lib/csl";

type Fmt = "md" | "docx" | "txt" | "bibtex" | "ris" | "csljson" | "cslbib";
const FORMATS: { id: Fmt; label: string; ext: string; hint: string }[] = [
  { id: "md", label: "Markdown", ext: "md", hint: "Obsidian / Logseq friendly, with YAML front matter" },
  { id: "docx", label: "Word (.docx)", ext: "docx", hint: "Highlights keep their colors" },
  { id: "txt", label: "Plain text", ext: "txt", hint: "" },
  { id: "bibtex", label: "BibTeX", ext: "bib", hint: "LaTeX, Zotero, JabRef" },
  { id: "ris", label: "RIS", ext: "ris", hint: "Zotero, Mendeley, EndNote" },
  { id: "csljson", label: "CSL-JSON", ext: "json", hint: "Zotero / citeproc" },
  { id: "cslbib", label: "Formatted bibliography", ext: "html", hint: "Any of 2,800+ CSL styles; paste into Word/Docs" },
];

const toB64 = async (blob: Blob) => {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
};

export function ExportDialog({ open, onClose, books }: { open: boolean; onClose: () => void; books: Book[] }) {
  const [fmt, setFmt] = useState<Fmt>("md");
  const [o, setO] = useState<ExportOptions>({ style: "apa", groupBy: "page", includeNotes: true, includeInk: true });
  const [busy, setBusy] = useState(false);
  const single = books.length === 1 ? books[0] : null;
  const isBib = fmt === "bibtex" || fmt === "ris" || fmt === "csljson" || fmt === "cslbib";
  const [cslStyle, setCslStyle] = useState(lastStyle);

  const build = async (): Promise<string | Blob> => {
    if (fmt === "cslbib") {
      const r = await formatBibliography(cslStyle, books);
      return `<!doctype html><meta charset="utf-8"><title>Bibliography</title>${r.html}`;
    }
    if (isBib) return bibliography[fmt as "bibtex" | "ris" | "csljson"](books);
    const parts: (string | Blob)[] = [];
    for (const b of books) {
      const [anns, notes] = await Promise.all([api.listAnnotations(b.id), o.includeNotes ? api.listNotes(b.id) : Promise.resolve([])]);
      if (fmt === "docx") return toDocx(b, anns, notes, o);
      parts.push(fmt === "md" ? toMarkdown(b, anns, notes, o) : toPlainText(b, anns, notes, o));
    }
    return parts.join("\n\n");
  };

  const doSave = async () => {
    setBusy(true);
    try {
      const f = FORMATS.find((x) => x.id === fmt)!;
      const name = (single?.title ?? "library-export").replace(/[\\/:*?"<>|]/g, "").slice(0, 80);
      const path = await save({ defaultPath: `${name}.${f.ext}`, filters: [{ name: f.label, extensions: [f.ext] }] });
      if (!path) return;
      const out = await build();
      if (out instanceof Blob) await api.writeBinaryFile(path, await toB64(out));
      else await api.writeTextFile(path, out);
      toast("Exported", path, "success");
      onClose();
    } catch (e) {
      toastError("Export failed", e);
    } finally {
      setBusy(false);
    }
  };
  const doCopy = async () => {
    if (fmt === "cslbib") {
      const r = await formatBibliography(cslStyle, books);
      await copyRich(r.html, r.text);
      toast("Bibliography copied", "Rich text — paste into Word or Google Docs");
      return;
    }
    const out = await build();
    if (typeof out !== "string") return;
    await navigator.clipboard.writeText(out);
    toast("Copied to clipboard");
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent title="Export notes & annotations" description={single ? single.title : `${books.length} books`}>
        <div className="grid grid-cols-2 gap-1.5">
          {FORMATS.map((f) => (
            <button key={f.id} onClick={() => setFmt(f.id)} className={`rounded-md border p-2 text-left cursor-pointer ${fmt === f.id ? "border-primary bg-accent" : "hover:bg-secondary"}`}>
              <p className="text-[13px] font-medium">{f.label}</p>
              {f.hint && <p className="text-[11px] text-muted-foreground">{f.hint}</p>}
            </button>
          ))}
        </div>
        {fmt === "cslbib" && <div className="mt-4"><p className="mb-1 text-xs text-muted-foreground">Style: {prettyStyle(cslStyle)}</p><StylePicker value={cslStyle} onChange={setCslStyle} /></div>}
        {!isBib && (
          <div className="mt-4 grid grid-cols-2 gap-3 text-[13px]">
            <label className="block"><span className="mb-1 block text-xs text-muted-foreground">Citation style</span>
              <select value={o.style} onChange={(e) => setO({ ...o, style: e.target.value as CitationStyle })} className="h-8 w-full rounded-md border bg-background px-2">{CITATION_STYLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
            </label>
            <label className="block"><span className="mb-1 block text-xs text-muted-foreground">Group annotations by</span>
              <select value={o.groupBy} onChange={(e) => setO({ ...o, groupBy: e.target.value as ExportOptions["groupBy"] })} className="h-8 w-full rounded-md border bg-background px-2"><option value="page">Page order</option><option value="color">Color (meaning)</option><option value="tag">Tag</option></select>
            </label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={o.includeNotes} onChange={(e) => setO({ ...o, includeNotes: e.target.checked })} /> Include notebook notes</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={o.includeInk} onChange={(e) => setO({ ...o, includeInk: e.target.checked })} /> Include drawings</label>
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          {fmt !== "docx" && <Button variant="outline" size="sm" onClick={doCopy}><Copy /> Copy</Button>}
          <Button size="sm" onClick={doSave} disabled={busy}><Download /> Save file…</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
