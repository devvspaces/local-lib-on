import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Check, ClipboardList, Search, Trash2, X } from "lucide-react";
import { api, type Book } from "@/lib/api";
import { copyRich, formatBibliography, formatCitation, prettyStyle } from "@/lib/csl";
import { lastStyle, StylePicker } from "@/components/StylePicker";
import { tracker } from "@/lib/tracker";
import { cn } from "@/lib/utils";

/**
 * Cite-while-you-write palette (global hotkey, default ⌥⌘C): search → pick → the in-text citation is
 * copied (and optionally pasted into the app you were writing in). Every cite goes into a bibliography basket.
 */
export function CitePalette() {
  const [q, setQ] = useState("");
  const [books, setBooks] = useState<Book[]>([]);
  const [sel, setSel] = useState<number[]>([]);
  const [cursor, setCursor] = useState(0);
  const [page, setPage] = useState("");
  const [style, setStyle] = useState(lastStyle);
  const [picking, setPicking] = useState(false);
  const [basket, setBasket] = useState<number[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [autoPaste, setAutoPaste] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    tracker.getKv("cite_basket").then((v) => v && setBasket(JSON.parse(v)));
    invoke<{ auto_paste: boolean }>("get_connector_config").then((c) => setAutoPaste(c.auto_paste));
    let un: (() => void) | undefined, dead = false;
    listen("cite_open", () => { setQ(""); setSel([]); setPage(""); setStatus(null); input.current?.focus(); }).then((f) => (dead ? f() : (un = f)));
    input.current?.focus();
    return () => { dead = true; un?.(); };
  }, []);
  useEffect(() => {
    const t = setTimeout(() => api.listBooks({ text: q || undefined, sort: q ? "title" : "opened" }).then((b) => { setBooks(b.slice(0, 50)); setCursor(0); }), 120);
    return () => clearTimeout(t);
  }, [q]);

  const saveBasket = (b: number[]) => { setBasket(b); tracker.setKv("cite_basket", JSON.stringify(b)); };
  const toggle = (id: number) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const cite = async () => {
    const ids = sel.length ? sel : books[cursor] ? [books[cursor].id] : [];
    if (!ids.length) return;
    try {
      const chosen = await Promise.all(ids.map((i) => api.getBook(i)));
      const text = await formatCitation(style, chosen, page || undefined);
      await navigator.clipboard.writeText(text);
      saveBasket([...new Set([...basket, ...ids])]);
      setStatus(`Copied ${text}`);
      await invoke("cite_done", { paste: autoPaste });
    } catch (e) {
      setStatus(`Failed: ${e}`);
    }
  };

  const copyBibliography = async () => {
    try {
      const chosen = await Promise.all(basket.map((i) => api.getBook(i)));
      const r = await formatBibliography(style, chosen);
      await copyRich(r.html, r.text);
      setStatus(`Bibliography (${chosen.length}) copied as rich text`);
    } catch (e) {
      setStatus(`Failed: ${e}`);
    }
  };

  return (
    <div
      className="flex h-screen flex-col bg-background text-foreground"
      onKeyDown={(e) => {
        if (e.key === "Escape") invoke("cite_done", { paste: false });
        else if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(books.length - 1, c + 1)); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
        else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (books[cursor]) toggle(books[cursor].id); }
        else if (e.key === "Enter") { e.preventDefault(); cite(); }
      }}
    >
      <div className="flex items-center gap-2 border-b px-3 py-2" data-tauri-drag-region>
        <Search className="h-4 w-4 text-muted-foreground" />
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cite a book…  (↵ cite · ⌘↵ add another · Esc close)" className="h-8 flex-1 bg-transparent text-[14px] outline-none" />
        <input value={page} onChange={(e) => setPage(e.target.value)} placeholder="page" className="h-7 w-16 rounded border bg-card px-2 text-xs" aria-label="Page" />
        <button onClick={() => setPicking(!picking)} className="max-w-36 truncate rounded border px-2 py-1 text-xs hover:bg-secondary cursor-pointer" title="Citation style">{prettyStyle(style)}</button>
      </div>
      {picking && <div className="border-b p-2"><StylePicker value={style} onChange={(s) => { setStyle(s); setPicking(false); }} /></div>}
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {books.map((b, i) => (
          <button
            key={b.id}
            onMouseEnter={() => setCursor(i)}
            onClick={() => toggle(b.id)}
            onDoubleClick={cite}
            className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] cursor-pointer", i === cursor && "bg-secondary")}
          >
            <span className={cn("flex h-4 w-4 items-center justify-center rounded border", sel.includes(b.id) && "border-primary bg-primary text-primary-foreground")}>{sel.includes(b.id) && <Check className="h-3 w-3" />}</span>
            <span className="min-w-0 flex-1 truncate">{b.title}</span>
            <span className="truncate text-xs text-muted-foreground">{b.authors[0] ?? ""} {b.year ?? ""}</span>
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t px-3 py-2 text-xs">
        <ClipboardList className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">Bibliography basket: {basket.length}</span>
        <button disabled={!basket.length} onClick={copyBibliography} className="rounded border px-2 py-0.5 hover:bg-secondary disabled:opacity-40 cursor-pointer">Copy bibliography</button>
        <button disabled={!basket.length} onClick={() => saveBasket([])} className="text-muted-foreground hover:text-destructive disabled:opacity-40 cursor-pointer" aria-label="Clear basket"><Trash2 className="h-3.5 w-3.5" /></button>
        <span className="ml-auto truncate text-muted-foreground">{status}</span>
        <button onClick={() => invoke("cite_done", { paste: false })} className="text-muted-foreground hover:text-foreground cursor-pointer" aria-label="Close"><X className="h-3.5 w-3.5" /></button>
      </div>
    </div>
  );
}
