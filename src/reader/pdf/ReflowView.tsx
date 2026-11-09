import { useEffect, useRef, useState } from "react";
import type { ReaderSettings } from "@/lib/api";
import type { SelectionInfo } from "../types";
import { pageText, type PDFDocumentProxy } from "./pdfjs";
import { toBlocks, toLines, type Block } from "./layout";

/**
 * PDF reflow: rebuild reading-order text (columns detected, hyphenation joined, headings detected)
 * and render as a single readable column. Pages load progressively around the current one.
 */
export function ReflowView({ doc, initialPage, font, onPage, registerJump, onSelection, query }: {
  doc: PDFDocumentProxy; initialPage: number; font?: ReaderSettings["font"]; onPage: (p: number) => void;
  registerJump: (fn: (page: number) => void) => void; onSelection: (s: SelectionInfo | null) => void; query: string;
}) {
  const [pages, setPages] = useState<Map<number, Block[]>>(new Map());
  const [range, setRange] = useState<[number, number]>([Math.max(1, initialPage - 1), Math.min(doc.numPages, initialPage + 3)]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const jumped = useRef(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      for (let p = range[0]; p <= range[1]; p++) {
        if (pages.has(p)) continue;
        const pg = await doc.getPage(p);
        const { items } = await pageText(doc, p);
        const width = pg.getViewport({ scale: 1 }).width;
        const blocks = toBlocks(toLines(items.map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width, h: i.height || Math.abs(i.transform[3]) }))), width);
        if (!alive) return;
        setPages((m) => new Map(m).set(p, blocks));
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, doc]);

  const jump = (page: number) => {
    if (!pages.has(page)) setRange([Math.max(1, page - 1), Math.min(doc.numPages, page + 3)]);
    requestAnimationFrame(() => scrollRef.current?.querySelector(`[data-rpage="${page}"]`)?.scrollIntoView());
  };
  useEffect(() => registerJump(jump));
  useEffect(() => {
    if (!jumped.current && pages.has(initialPage)) {
      jumped.current = true;
      requestAnimationFrame(() => scrollRef.current?.querySelector(`[data-rpage="${initialPage}"]`)?.scrollIntoView());
    }
  }, [pages, initialPage]);

  const onScroll = () => {
    const el = scrollRef.current!;
    const markers = [...el.querySelectorAll<HTMLElement>("[data-rpage]")];
    const top = el.getBoundingClientRect().top + 80;
    let cur = markers[0];
    for (const m of markers) if (m.getBoundingClientRect().top <= top) cur = m;
    if (cur) onPage(Number(cur.dataset.rpage));
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 800 && range[1] < doc.numPages) setRange(([a, b]) => [a, Math.min(doc.numPages, b + 4)]);
    if (el.scrollTop < 400 && range[0] > 1) {
      const h = el.scrollHeight;
      setRange(([a, b]) => [Math.max(1, a - 3), b]);
      requestAnimationFrame(() => (el.scrollTop += el.scrollHeight - h));
    }
  };

  const mark = (t: string) => {
    const q = query.trim();
    if (q.length < 2) return t;
    const parts = t.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"));
    return parts.map((s, i) => (i % 2 ? <mark key={i}>{s}</mark> : s));
  };

  const style = {
    fontSize: font?.size ?? 18,
    lineHeight: font?.lineHeight ?? 1.65,
    fontFamily: font?.family || undefined,
    textAlign: font?.justify ? ("justify" as const) : undefined,
    maxWidth: `${font?.margin ? 46 - font.margin : 40}em`,
  };

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      onMouseUp={() => {
        const sel = window.getSelection();
        const text = sel?.toString().trim();
        if (!sel || !text) return onSelection(null);
        const pageEl = (sel.anchorNode?.parentElement?.closest("[data-rsection]") as HTMLElement | null);
        const page = Number(pageEl?.dataset.rsection ?? 1);
        // Reflowed text has no PDF geometry: store as a page-level note anchor with the quote.
        onSelection({ text, rect: sel.getRangeAt(0).getBoundingClientRect(), anchor: { page, rects: [] }, pageLabel: String(page) });
      }}
      className="h-full overflow-y-auto bg-background custom-scrollbar"
    >
      <article className="reflow-content mx-auto px-8 py-10" style={style}>
        {Array.from({ length: range[1] - range[0] + 1 }, (_, i) => range[0] + i).map((p) => (
          <section key={p} data-rsection={p}>
            <span className="page-marker" data-rpage={p}>Page {p}</span>
            {(pages.get(p) ?? []).map((b, i) => (b.kind === "h" ? <h3 key={i}>{mark(b.text)}</h3> : <p key={i}>{mark(b.text)}</p>))}
            {pages.has(p) && !pages.get(p)!.length && <p className="text-sm italic text-muted-foreground">No text on this page (scanned image?). Turn off reflow to see it.</p>}
          </section>
        ))}
      </article>
    </div>
  );
}
