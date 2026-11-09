import { useEffect, useMemo, useState } from "react";
import { Copy, Image as ImageIcon, Layers, NotebookPen, Square, Table2, X } from "lucide-react";
import type { PDFDocumentProxy } from "./pdfjs";
import { pageText } from "./pdfjs";
import type { PageAreaEvent } from "./PdfPage";
import { extractTable, tableToMarkdown, tableToTSV, type Item } from "./layout";
import { HIGHLIGHT_COLORS } from "../types";
import { toast } from "@/components/ui/toast";
import { notebookBus } from "../notebookBus";

/** Popover after an area/table selection (Okular Ctrl+3 / Ctrl+5). */
export function AreaPopover({ doc, ev, mode, onClose, onAnnotate, onOcclusion }: {
  doc: PDFDocumentProxy; ev: PageAreaEvent; mode: "area" | "table"; onClose: () => void; onAnnotate: (color: string, comment?: string) => void;
  onOcclusion?: (png: string, w: number, h: number, page: number) => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    pageText(doc, ev.page).then(({ items }) =>
      setItems(items.map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width, h: i.height || Math.hypot(i.transform[2], i.transform[3]) })))
    );
  }, [doc, ev.page]);

  const rows = useMemo(() => (items.length ? extractTable(items, ev.pdfRect) : []), [items, ev.pdfRect]);
  const text = useMemo(() => rows.map((r) => r.filter(Boolean).join(" ")).join("\n"), [rows]);

  const image = () => {
    const [x1, y1, x2, y2] = ev.vpRect;
    const dpr = ev.canvas.width / ev.vp.width;
    const c = document.createElement("canvas");
    c.width = Math.round((x2 - x1) * dpr);
    c.height = Math.round((y2 - y1) * dpr);
    c.getContext("2d")!.drawImage(ev.canvas, x1 * dpr, y1 * dpr, c.width, c.height, 0, 0, c.width, c.height);
    return c;
  };
  const copyImage = async () => {
    const blob = await new Promise<Blob | null>((r) => image().toBlob(r, "image/png"));
    if (!blob) return;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    toast("Image copied");
    onClose();
  };
  const copy = async (s: string, what: string) => { await navigator.clipboard.writeText(s); toast(`${what} copied`); onClose(); };

  const left = Math.min(window.innerWidth - 340, Math.max(8, ev.clientRect.left));
  const top = Math.min(window.innerHeight - (mode === "table" ? 320 : 60), ev.clientRect.bottom + 8);

  return (
    <div className="fixed z-50 rounded-lg border bg-popover p-1.5 shadow-xl" style={{ left, top, width: mode === "table" ? 330 : undefined }} onMouseDown={(e) => e.stopPropagation()}>
      {mode === "table" ? (
        <div>
          <div className="flex items-center justify-between px-1 pb-1">
            <span className="flex items-center gap-1.5 text-xs font-semibold"><Table2 className="h-3.5 w-3.5" /> {rows.length} rows × {Math.max(0, ...rows.map((r) => r.length))} cols</span>
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer"><X className="h-3.5 w-3.5" /></button>
          </div>
          <div className="max-h-52 overflow-auto rounded border custom-scrollbar">
            <table className="text-[11px]">
              <tbody>{rows.slice(0, 40).map((r, i) => <tr key={i} className="border-b last:border-0">{r.map((c, j) => <td key={j} className="whitespace-nowrap border-r px-1.5 py-0.5 last:border-0">{c}</td>)}</tr>)}</tbody>
            </table>
          </div>
          <div className="mt-1.5 flex gap-1">
            <Btn onClick={() => copy(tableToTSV(rows), "Table (TSV)")}><Copy /> TSV</Btn>
            <Btn onClick={() => copy(tableToMarkdown(rows), "Table (Markdown)")}><Copy /> Markdown</Btn>
            <Btn onClick={() => { notebookBus.emit({ type: "insert", markdown: `\n${tableToMarkdown(rows)}\n` }); toast("Added to notebook"); onClose(); }}><NotebookPen /> Notebook</Btn>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-0.5">
          <Btn onClick={copyImage}><ImageIcon /> Copy image</Btn>
          {onOcclusion && <Btn onClick={() => { const c = image(); onOcclusion(c.toDataURL("image/png"), c.width, c.height, ev.page); onClose(); }}><Layers /> Occlusion cards</Btn>}
          <Btn onClick={() => copy(text, "Text")} disabled={!text}><Copy /> Copy text</Btn>
          <Btn onClick={() => { notebookBus.emit({ type: "insert", markdown: `\n![p. ${ev.page}](${image().toDataURL("image/png")})\n` }); toast("Added to notebook"); onClose(); }}><NotebookPen /> Notebook</Btn>
          <div className="mx-1 h-5 w-px bg-border" />
          <Square className="h-3.5 w-3.5 text-muted-foreground" />
          {HIGHLIGHT_COLORS.slice(0, 5).map((c) => (
            <button key={c.id} title={`Mark area: ${c.label}`} onClick={() => onAnnotate(c.value, text || undefined)} className="h-4 w-4 rounded-full cursor-pointer hover:scale-110" style={{ background: c.value }} />
          ))}
          <button onClick={onClose} className="ml-1 text-muted-foreground hover:text-foreground cursor-pointer"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}
    </div>
  );
}

const Btn = (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button {...p} className="flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-secondary disabled:opacity-40 cursor-pointer [&_svg]:h-3.5 [&_svg]:w-3.5" />
);
