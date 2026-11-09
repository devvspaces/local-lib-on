import { Volume2, Sparkles, ListCollapse, Languages, BookA, Copy, Highlighter, MessageSquarePlus, NotebookPen, Quote, Search, Strikethrough, Underline, X } from "lucide-react";
import type { Book } from "@/lib/api";
import { formatCitation } from "@/lib/citations";
import { toast } from "@/components/ui/toast";
import { HIGHLIGHT_COLORS, type SelectionInfo } from "./types";

export function SelectionPopover({ sel, book, onAnnotate, onLookup, onSearch, onNotebook, onClose, onReadAloud, onAsk }: {
  onReadAloud: () => void;
  onAsk: (prompt: string) => void;
  sel: SelectionInfo; book: Book;
  onAnnotate: (kind: "highlight" | "underline" | "strike" | "squiggly", color: string, withNote?: boolean) => void;
  onLookup: (word: string) => void; onSearch: (q: string) => void; onNotebook: () => void; onClose: () => void;
}) {
  const top = sel.rect.top > 70 ? sel.rect.top - 48 : sel.rect.bottom + 8;
  const left = Math.max(8, Math.min(window.innerWidth - 470, sel.rect.left + sel.rect.width / 2 - 230));
  const word = sel.text.split(/\s+/).length <= 3;
  const B = ({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) => (
    <button title={label} aria-label={label} onClick={onClick} className="rounded p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground cursor-pointer [&_svg]:h-4 [&_svg]:w-4">{children}</button>
  );
  return (
    <div className="fixed z-50 flex items-center gap-0.5 rounded-lg border bg-popover p-1 shadow-xl animate-in fade-in-0 zoom-in-95" style={{ top, left }} onMouseDown={(e) => e.preventDefault()}>
      {HIGHLIGHT_COLORS.slice(0, 6).map((c) => (
        <button key={c.id} title={`Highlight · ${c.label}`} onClick={() => onAnnotate("highlight", c.value)} className="mx-0.5 h-5 w-5 rounded-full border border-black/10 cursor-pointer hover:scale-110 transition-transform" style={{ background: c.value }} />
      ))}
      <div className="mx-1 h-5 w-px bg-border" />
      <B label="Underline" onClick={() => onAnnotate("underline", "#2ea8e5")}><Underline /></B>
      <B label="Strike through" onClick={() => onAnnotate("strike", "#ff6666")}><Strikethrough /></B>
      <B label="Squiggly" onClick={() => onAnnotate("squiggly", "#5fb236")}><span className="text-sm font-semibold underline decoration-wavy">S</span></B>
      <B label="Highlight with note" onClick={() => onAnnotate("highlight", "#ffd400", true)}><MessageSquarePlus /></B>
      <div className="mx-1 h-5 w-px bg-border" />
      <B label="Copy" onClick={async () => { await navigator.clipboard.writeText(sel.text); toast("Copied"); onClose(); }}><Copy /></B>
      <B label="Copy as quote with citation" onClick={async () => {
        await navigator.clipboard.writeText(`“${sel.text}” (${formatCitation(book, "apa").replace(/\.$/, "")}${sel.pageLabel ? `, p. ${sel.pageLabel}` : ""})`);
        toast("Quote copied", "With APA citation");
        onClose();
      }}><Quote /></B>
      <B label="Add to notebook" onClick={onNotebook}><NotebookPen /></B>
      {word && <B label="Look up (dictionary / Wikipedia)" onClick={() => onLookup(sel.text)}><BookA /></B>}
      <B label="Find in document" onClick={() => onSearch(sel.text)}><Search /></B>
      <B label="Read aloud from here" onClick={onReadAloud}><Volume2 /></B>
      <div className="mx-1 h-5 w-px bg-border" />
      <B label="Explain with AI" onClick={() => onAsk("Explain this passage clearly, with any background I need.")}><Sparkles /></B>
      <B label="Summarize with AI" onClick={() => onAsk("Summarize the selected text in a few bullet points.")}><ListCollapse /></B>
      <B label="Translate with AI" onClick={() => onAsk("Translate the selected text into English (or, if it is English, into simple plain English), preserving meaning.")}><Languages /></B>
      <B label="Dismiss" onClick={onClose}><X /></B>
      <Highlighter className="hidden" />
    </div>
  );
}
