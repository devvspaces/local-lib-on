import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { anchorAt, anchorTop } from "./scrollAnchor";
import type { PageViewport } from "pdfjs-dist";
import { fileUrl, type Annotation } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { EngineHandle, EngineProps, SearchHit } from "../types";
import { loadPdf, normalizeForSearch, pageText, resolveDest, resolveOutline, setOcrPage, type PDFDocumentProxy } from "./pdfjs";
import { ocrApi, ocrBook, scannedRatio, cancelOcr, useOcrJob } from "@/lib/ocr";
import { ScanText, X as XIcon } from "lucide-react";
import { readPdfAnnotations } from "./pdfAnnots";
import { PdfPage, type PageAreaEvent } from "./PdfPage";
import { cropFor, mergeLineRects, toPdf, type Rect } from "./geometry";
import { combineCrops, contentBox } from "./layout";
import { ReflowView } from "./ReflowView";
import { AreaPopover } from "./AreaPopover";
import { useOcclusion } from "@/views/review/OcclusionEditor";
import { PresentationView } from "./PresentationView";
import { splitSentences } from "../tts";

/** Highlight `sentence` inside the rendered text layer of `page` using the CSS Custom Highlight API. */
function highlightSentence(root: HTMLElement | null, page: number, sentence: string) {
  const H = (globalThis as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
  const HighlightCtor = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!H || !HighlightCtor) return;
  H.delete("tts");
  const layer = root?.querySelector(`[data-page="${page}"] .textLayer`);
  if (!layer) return;
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  const nodes: { node: Text; start: number }[] = [];
  let full = "";
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    nodes.push({ node: n, start: full.length });
    full += n.data + " ";
  }
  const norm = (x: string) => x.replace(/\s+/g, " ").toLowerCase();
  const hay = norm(full);
  const needle = norm(sentence).slice(0, 60);
  // Map normalized index back roughly: whitespace collapse keeps order, so search on raw lowercase too.
  const at = full.toLowerCase().replace(/\s+/g, " ").indexOf(needle);
  if (at < 0 || !hay) return;
  const end = at + norm(sentence).length;
  const locate = (pos: number) => {
    // walk raw text counting collapsed chars
    let collapsed = 0;
    for (const { node, start } of nodes) {
      const raw = node.data + " ";
      for (let i = 0; i < raw.length; i++) {
        const prevSpace = i > 0 ? /\s/.test(raw[i - 1]) : start > 0 && /\s/.test(full[start - 1]);
        if (/\s/.test(raw[i]) && prevSpace) continue;
        if (collapsed === pos) return { node, offset: Math.min(i, node.data.length) };
        collapsed++;
      }
    }
    const last = nodes[nodes.length - 1];
    return { node: last.node, offset: last.node.data.length };
  };
  const a = locate(at), b = locate(Math.min(end, hay.length - 1));
  const r = document.createRange();
  try { r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset); } catch { return; }
  H.set("tts", new HighlightCtor(r));
  const rect = r.getBoundingClientRect();
  const box = root!.getBoundingClientRect();
  if (rect.top < box.top + 40 || rect.bottom > box.bottom - 40) root!.scrollBy({ top: rect.top - box.top - box.height / 3, behavior: "smooth" });
}

const GAP = 14;
const PAD = 24;

export interface PdfEngineHandle extends EngineHandle {
  importAnnotations(): Promise<Parameters<EngineProps["onCreateAnnotation"]>[0][]>;
  /** Filled form copy (null when no field was changed). */
  saveFilled(): Promise<Uint8Array | null>;
  sourceBytes(): Promise<ArrayBuffer>;
  thumbnail(page: number, width: number): Promise<string>;
  pageCount(): number;
  pageLabel(page: number): string;
}

export const PdfReader = forwardRef<PdfEngineHandle, EngineProps & { selectedAnnotation: string | null }>(function PdfReader(props, ref) {
  const { settings, onSettings, annotations, tool } = props;
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([]);
  const [labels, setLabels] = useState<string[] | null>(null);
  const [container, setContainer] = useState({ w: 800, h: 600 });
  const [reveal, setReveal] = useState(0);
  const [visible, setVisible] = useState<[number, number]>([1, 3]);
  const [query, setQuery] = useState("");
  const [area, setArea] = useState<{ ev: PageAreaEvent; mode: "area" | "table" } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentPage = useRef(1);
  const restored = useRef(false);
  const viewports = useRef(new Map<number, PageViewport>());
  const thumbs = useRef(new Map<string, Promise<string>>());
  const [ocrVersion, setOcrVersion] = useState(0);
  const [scanned, setScanned] = useState<number | null>(null); // ratio of image-only pages
  const [bannerHidden, setBannerHidden] = useState(false);
  const ocrJob = useOcrJob();

  const rotation = settings.rotation ?? 0;
  const viewMode = settings.viewMode ?? "continuous";
  const facing = viewMode === "facing";

  // ── Load document ──
  useEffect(() => {
    let alive = true;
    let loaded: PDFDocumentProxy | null = null;
    (async () => {
      try {
        const d = await loadPdf(fileUrl(props.path));
        loaded = d;
        if (!alive) return void d.loadingTask.destroy();
        const first = await d.getPage(1);
        const v = first.getViewport({ scale: 1 });
        setSizes(new Array(d.numPages).fill({ w: v.width, h: v.height }));
        // Previously OCR'd pages → text for search/selection.
        const ocrPages = await ocrApi.pages(props.bookId).catch(() => []);
        for (const p of ocrPages) setOcrPage(d, p.page, p.words);
        setDoc(d);
        scannedRatio(d, pageText).then((r) => alive && setScanned(r)).catch(() => {});
        d.getPageLabels().then((l) => alive && setLabels(l)).catch(() => {});
        resolveOutline(d).then((toc) => alive && props.onToc(toc)).catch(() => props.onToc([]));
        const meta = await d.getMetadata().catch(() => null);
        props.onReady?.({ pageCount: d.numPages, metadata: (meta?.info as Record<string, unknown>) ?? {} });
        // Real per-page sizes (mixed page sizes are common in scanned books / papers with landscape tables).
        const all: { w: number; h: number }[] = [];
        for (let i = 1; i <= d.numPages && alive; i++) {
          const pg = await d.getPage(i);
          const vp = pg.getViewport({ scale: 1 });
          all.push({ w: vp.width, h: vp.height });
          if (i % 50 === 0 || i === d.numPages) alive && setSizes((s) => [...all, ...s.slice(all.length)]);
        }
      } catch (e) {
        props.onError(e);
      }
    })();
    return () => {
      alive = false;
      loaded?.loadingTask.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.path]);

  // ── Container size ──
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // A hidden tab (display:none) measures 0×0 — ignore it, or the layout collapses and the page anchor is lost.
    let hidden = false;
    const ro = new ResizeObserver(() => {
      if (!el.clientWidth || !el.clientHeight) { hidden = true; return; }
      if (hidden) { hidden = false; setReveal((n) => n + 1); }
      setContainer((c) => (c.w === el.clientWidth && c.h === el.clientHeight ? c : { w: el.clientWidth, h: el.clientHeight }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [settings.reflow]);

  const rotated = useCallback((i: number) => {
    const s = sizes[i] ?? sizes[0] ?? { w: 612, h: 792 };
    return rotation % 180 ? { w: s.h, h: s.w } : s;
  }, [sizes, rotation]);

  // ── Scale ──
  const scale = useMemo(() => {
    if (!sizes.length) return 1;
    const z = settings.zoom ?? "fit-width";
    if (typeof z === "number") return z;
    const c = cropFor(settings.crop, 1);
    const ref0 = rotated(Math.min(1, sizes.length - 1));
    const pw = ref0.w * (1 - c.left - c.right) * (facing ? 2 : 1) + (facing ? GAP : 0);
    const ph = ref0.h * (1 - c.top - c.bottom);
    const sw = (container.w - PAD * 2) / pw;
    const sh = (container.h - PAD) / ph;
    return Math.max(0.2, z === "fit-page" ? Math.min(sw, sh) : sw);
  }, [settings.zoom, settings.crop, sizes, container, facing, rotated]);

  // ── Rows (1 or 2 pages each) with cumulative offsets ──
  const rows = useMemo(() => {
    const out: { pages: number[]; top: number; height: number }[] = [];
    let top = PAD / 2;
    const n = sizes.length;
    for (let p = 1; p <= n; ) {
      const pages = facing ? (p === 1 ? [1] : [p, p + 1].filter((x) => x <= n)) : [p];
      const height = Math.max(...pages.map((q) => { const c = cropFor(settings.crop, q); return rotated(q - 1).h * (1 - c.top - c.bottom) * scale; }));
      out.push({ pages, top, height });
      top += height + GAP;
      p += pages.length;
    }
    return { list: out, total: top + PAD / 2 };
  }, [sizes, facing, scale, settings.crop, rotated]);

  const rowOfPage = useCallback((page: number) => rows.list.findIndex((r) => r.pages.includes(page)), [rows]);

  // The page the reader is "on" ({page, offset within it}). Layout changes (page sizes streaming in, zoom,
  // crop, a hidden tab coming back) re-scroll to this anchor, so the position never drifts.
  const anchor = useRef<{ page: number; offset: number } | null>(null);
  const scrollToPage = useCallback((page: number, offset = 0, smooth = false) => {
    const el = scrollRef.current;
    const p = Math.max(1, Math.min(page, sizes.length));
    anchor.current = { page: p, offset };
    const top = anchorTop(rows.list, anchor.current);
    if (!el || top === null) return;
    el.scrollTo({ top: Math.max(0, top - 8), behavior: smooth ? "smooth" : "auto" });
  }, [rows, sizes.length]);

  // ── Restore position once layout is known ──
  const jumpPage = (j?: EngineProps["jump"]) => j?.page ?? (j?.loc?.startsWith("p") ? Number(j.loc.slice(1)) : undefined);
  const appliedJump = useRef<number | null>(null);
  useEffect(() => {
    if (!doc || restored.current || !rows.list.length || settings.reflow) return;
    restored.current = true;
    const jp = jumpPage(props.jump);
    if (jp) {
      appliedJump.current = props.jump!.nonce;
      if (props.jump!.query) setQuery(props.jump!.query);
      requestAnimationFrame(() => scrollToPage(jp, 0));
      return;
    }
    const loc = currentPage.current > 1 ? { page: currentPage.current, offset: 0 } : props.initial;
    if (loc && "page" in loc) requestAnimationFrame(() => scrollToPage(loc.page, loc.offset ?? 0));
  }, [doc, rows, props.initial, scrollToPage, settings.reflow]);

  // Later jumps (tab already open): apply as soon as layout exists.
  useEffect(() => {
    const j = props.jump;
    if (!j || appliedJump.current === j.nonce || !restored.current || !rows.list.length) return;
    appliedJump.current = j.nonce;
    const jp = jumpPage(j);
    if (j.query) setQuery(j.query);
    if (jp) {
      if (settings.reflow) reflowJump.current?.(jp);
      else requestAnimationFrame(() => scrollToPage(jp, 0));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.jump?.nonce, rows, doc]);

  // Keep the current page anchored whenever the layout changes — before paint, so onScroll never sees a stale mix
  // of old scrollTop and new row heights.
  useLayoutEffect(() => {
    if (anchor.current && restored.current) scrollToPage(anchor.current.page, anchor.current.offset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, reveal]);

  // ── Scroll tracking → visible window + location ──
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !rows.list.length || !el.clientHeight) return; // hidden tab: nothing is visible, keep the anchor
    const top = el.scrollTop, bottom = top + el.clientHeight;
    let first = rows.list.findIndex((r) => r.top + r.height >= top);
    if (first < 0) first = rows.list.length - 1;
    let last = first;
    while (last + 1 < rows.list.length && rows.list[last + 1].top <= bottom) last++;
    const firstPage = rows.list[Math.max(0, first - 1)].pages[0];
    const lastPage = rows.list[Math.min(rows.list.length - 1, last + 1)].pages.slice(-1)[0];
    setVisible((v) => (v[0] === firstPage && v[1] === lastPage ? v : [firstPage, lastPage]));

    const page = rows.list[Math.max(0, rows.list.findIndex((r) => r.top + r.height >= top + el.clientHeight * 0.3))].pages[0];
    const offset = anchorAt(rows.list, top + 8, page);
    currentPage.current = page;
    anchor.current = { page, offset };
    const n = sizes.length;
    const label = labels?.[page - 1];
    props.onLocation({
      locator: { page, offset: Math.round(offset * 1000) / 1000 },
      percent: n > 1 ? Math.min(1, (page - 1 + offset) / (n - 1)) : 1,
      label: `${label && label !== String(page) ? `${label} · ` : ""}${page} / ${n}`,
      page,
      pageCount: n,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sizes.length, labels]);
  useEffect(onScroll, [onScroll]);

  // Single-page mode: wheel/keys page through instead of free scroll.
  const single = viewMode === "single";

  // ── Ctrl/⌘ + wheel / pinch zoom ──
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const next = Math.min(6, Math.max(0.25, scale * Math.exp(-e.deltaY * 0.01)));
      onSettings({ zoom: Math.round(next * 100) / 100 });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [scale, onSettings]);

  // ── Text selection → annotation / popover ──
  const pageVp = (page: number) => viewports.current.get(page);
  const selectionToAnchor = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !scrollRef.current?.contains(sel.anchorNode)) return null;
    const text = sel.toString().replace(/\s+\n/g, "\n").trim();
    if (!text) return null;
    const range = sel.getRangeAt(0);
    const byPage = new Map<number, Rect[]>();
    for (const cr of Array.from(range.getClientRects())) {
      if (cr.width < 1 || cr.height < 1) continue;
      const pageEl = document.elementsFromPoint(cr.left + cr.width / 2, cr.top + cr.height / 2).find((e) => (e as HTMLElement).dataset?.page) as HTMLElement | undefined;
      const pageNum = Number(pageEl?.dataset.page);
      const vp = pageVp(pageNum);
      if (!pageEl || !vp) continue;
      const inner = pageEl.firstElementChild!.getBoundingClientRect();
      const r: Rect = [cr.left - inner.left, cr.top - inner.top, cr.right - inner.left, cr.bottom - inner.top];
      if (!byPage.has(pageNum)) byPage.set(pageNum, []);
      byPage.get(pageNum)!.push(r);
    }
    if (!byPage.size) return null;
    // Annotations are per page; multi-page selections anchor to the first page and keep the rest as siblings.
    const parts = [...byPage.entries()].sort((a, b) => a[0] - b[0]).map(([page, rects]) => ({
      page,
      rects: mergeLineRects(rects).map((r) => toPdf(pageVp(page)!, r)),
    }));
    return { text, parts, rect: range.getBoundingClientRect() };
  }, []);

  useEffect(() => {
    const up = () => {
      setTimeout(async () => {
        const s = selectionToAnchor();
        if (!s) { props.onSelection(null); return; }
        const label = (p: number) => labels?.[p - 1] ?? String(p);
        if (tool.type === "annotate" && ["highlight", "underline", "strike", "squiggly"].includes(tool.kind)) {
          for (const part of s.parts) {
            await props.onCreateAnnotation({ kind: tool.kind, color: tool.color, text: s.parts.length > 1 ? s.text : s.text, anchor: { page: part.page, rects: part.rects }, page_label: label(part.page) });
          }
          window.getSelection()?.removeAllRanges();
          props.onSelection(null);
          return;
        }
        const first = s.parts[0];
        props.onSelection({ text: s.text, rect: s.rect, anchor: { page: first.page, rects: s.parts.flatMap((p) => (p.page === first.page ? p.rects : [])) }, pageLabel: label(first.page) });
      }, 0);
    };
    const el = scrollRef.current;
    el?.addEventListener("mouseup", up);
    return () => el?.removeEventListener("mouseup", up);
  }, [selectionToAnchor, tool, labels, props.onCreateAnnotation, props.onSelection]);

  // ── Imperative API ──
  const goPage = (p: number) => {
    if (settings.reflow) { reflowJump.current?.(p); return; }
    scrollToPage(p, 0, false);
  };
  const reflowJump = useRef<((page: number) => void) | null>(null);
  const tts = useRef<{ page: number; sentences: string[]; i: number } | null>(null);
  const ttsLoad = async (page: number, fromText?: string) => {
    if (!doc || page > doc.numPages) return null;
    const { text } = await pageText(doc, page);
    let sentences = splitSentences(text);
    if (fromText) {
      const k = sentences.findIndex((x) => x.toLowerCase().includes(fromText.toLowerCase().slice(0, 40)));
      if (k > 0) sentences = sentences.slice(k);
    }
    tts.current = { page, sentences, i: -1 };
    return tts.current;
  };
  const ttsAdvance = async (): Promise<{ text: string; show: () => void } | null> => {
    let t = tts.current;
    while (t) {
      t.i++;
      if (t.i < t.sentences.length) {
        const s = t.sentences[t.i];
        const page = t.page;
        return {
          text: s,
          show: () => {
            if (currentPage.current !== page) scrollToPage(page);
            requestAnimationFrame(() => requestAnimationFrame(() => highlightSentence(scrollRef.current, page, s)));
          },
        };
      }
      t = await ttsLoad(t.page + 1);
    }
    return null;
  };
  useImperativeHandle(ref, () => ({
    ttsStart: async () => {
      const sel = window.getSelection()?.toString().trim();
      await ttsLoad(currentPage.current, sel || undefined);
      return ttsAdvance();
    },
    ttsNext: ttsAdvance,
    ttsStop: () => { tts.current = null; (globalThis as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights?.delete("tts"); },
    goTo: (t) => {
      const page = t.page ?? (t.locator && "page" in t.locator ? t.locator.page : undefined) ?? (t.loc?.startsWith("p") ? Number(t.loc.slice(1)) : undefined);
      if (page) goPage(page);
    },
    next: () => {
      const r = rowOfPage(currentPage.current);
      const nxt = rows.list[Math.min(rows.list.length - 1, r + 1)];
      if (nxt) goPage(nxt.pages[0]);
    },
    prev: () => {
      const r = rowOfPage(currentPage.current);
      const el = scrollRef.current;
      // If we're scrolled into a page, first go to its top.
      if (el && rows.list[r] && el.scrollTop > rows.list[r].top + 20) return goPage(rows.list[r].pages[0]);
      const prv = rows.list[Math.max(0, r - 1)];
      if (prv) goPage(prv.pages[0]);
    },
    search: async (q: string) => {
      setQuery(q);
      if (!doc || q.trim().length < 2) return [];
      const needle = normalizeForSearch(q);
      const hits: SearchHit[] = [];
      for (let i = 1; i <= doc.numPages && hits.length < 500; i++) {
        const { text } = await pageText(doc, i);
        const hay = normalizeForSearch(text);
        for (let at = hay.indexOf(needle); at !== -1 && hits.length < 500; at = hay.indexOf(needle, at + needle.length)) {
          hits.push({ id: `${i}:${at}`, page: i, label: labels?.[i - 1] ?? String(i), excerpt: hay.slice(Math.max(0, at - 50), at + needle.length + 70) });
        }
      }
      return hits;
    },
    clearSearch: () => setQuery(""),
    extractText: async () => {
      if (!doc) return [];
      const out: { loc: string; text: string }[] = [];
      for (let i = 1; i <= doc.numPages; i++) out.push({ loc: `p${i}`, text: (await pageText(doc, i)).text });
      return out;
    },
    autoCrop: async () => {
      if (!doc) return null;
      const n = doc.numPages;
      const sample = [...new Set([2, 3, 5, 8, Math.floor(n / 3), Math.floor(n / 2), Math.floor((2 * n) / 3), n - 2].filter((p) => p >= 1 && p <= n))];
      const boxes = [];
      for (const p of sample) {
        const page = await doc.getPage(p);
        const vp = page.getViewport({ scale: 0.6, rotation });
        const c = document.createElement("canvas");
        c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        await page.render({ canvas: c, viewport: vp }).promise;
        const ctx = c.getContext("2d", { willReadFrequently: true })!;
        const b = contentBox(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
        if (b) boxes.push(b);
      }
      return combineCrops(boxes);
    },
    thumbnail: (page: number, width: number) => {
      const key = `${page}@${width}`;
      if (!thumbs.current.has(key)) {
        thumbs.current.set(key, (async () => {
          const pg = await doc!.getPage(page);
          const v1 = pg.getViewport({ scale: 1, rotation });
          const vp = pg.getViewport({ scale: (width * 2) / v1.width, rotation });
          const c = document.createElement("canvas");
          c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
          await pg.render({ canvas: c, viewport: vp }).promise;
          return c.toDataURL("image/jpeg", 0.7);
        })());
      }
      return thumbs.current.get(key)!;
    },
    pageCount: () => doc?.numPages ?? 0,
    importAnnotations: async () => (doc ? readPdfAnnotations(doc) : []),
    saveFilled: async () => (doc && doc.annotationStorage.size > 0 ? await doc.saveDocument() : null),
    sourceBytes: async () => new Uint8Array(await doc!.getData()).buffer as ArrayBuffer,
    pageLabel: (p: number) => labels?.[p - 1] ?? String(p),
  }), [doc, rows, rowOfPage, labels, rotation, settings.reflow, scrollToPage]);

  const onLink = useCallback(async (dest: unknown) => {
    if (!doc) return;
    const p = await resolveDest(doc, dest);
    if (p) scrollToPage(p);
  }, [doc, scrollToPage]);
  const onViewport = useCallback((p: number, vp: PageViewport) => { viewports.current.set(p, vp); }, []);
  const byPage = useMemo(() => {
    const m = new Map<number, Annotation[]>();
    for (const a of annotations) if ("page" in a.anchor) { const k = a.anchor.page; if (!m.has(k)) m.set(k, []); m.get(k)!.push(a); }
    return m;
  }, [annotations]);
  const onCreate = useCallback((a: Parameters<EngineProps["onCreateAnnotation"]>[0]) => {
    const page = "page" in a.anchor ? a.anchor.page : 1;
    props.onCreateAnnotation({ ...a, page_label: labels?.[page - 1] ?? String(page) });
  }, [props.onCreateAnnotation, labels]);
  const onArea = useCallback((ev: PageAreaEvent, mode: "area" | "table") => setArea({ ev, mode }), []);

  const runOcr = async (pages?: number[]) => {
    if (!doc) return;
    try {
      await ocrBook(props.bookId, doc, (p) => { setOcrPage(doc, p.page, p.words); setOcrVersion((v) => v + 1); }, { pages });
      setScanned(await scannedRatio(doc, pageText));
    } catch (e) {
      props.onError(e);
    }
  };
  const ocrActive = ocrJob.running && ocrJob.bookId === props.bookId;
  const banner = doc && (ocrActive || (!bannerHidden && scanned !== null && scanned >= 0.5)) ? (
    <div className="sticky top-0 z-20 h-0"><div className="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border bg-popover px-3 py-1.5 text-xs shadow-lg">
      <ScanText className="h-3.5 w-3.5 text-primary" />
      {ocrActive ? (
        <>
          <span>Recognizing text… {ocrJob.done}/{ocrJob.total} pages</span>
          <div className="h-1 w-24 overflow-hidden rounded-full bg-secondary"><div className="h-full bg-primary" style={{ width: `${(ocrJob.done / Math.max(1, ocrJob.total)) * 100}%` }} /></div>
          <button onClick={cancelOcr} className="text-muted-foreground hover:text-foreground cursor-pointer">Pause</button>
        </>
      ) : (
        <>
          <span>This looks like a scanned book with no selectable text.</span>
          <button onClick={() => runOcr([currentPage.current, currentPage.current + 1].filter((x) => x <= doc.numPages))} className="rounded px-1.5 py-0.5 hover:bg-secondary cursor-pointer">OCR this page</button>
          <button onClick={() => runOcr()} className="rounded bg-primary px-2 py-0.5 text-primary-foreground cursor-pointer">Make searchable</button>
          <button onClick={() => setBannerHidden(true)} className="text-muted-foreground hover:text-foreground cursor-pointer" aria-label="Dismiss"><XIcon className="h-3.5 w-3.5" /></button>
        </>
      )}
    </div></div>
  ) : null;

  if (viewMode === "presentation" && doc) {
    return (
      <PresentationView
        doc={doc}
        startPage={currentPage.current}
        annotations={annotations}
        onPage={(page) => { currentPage.current = page; const n = doc.numPages; props.onLocation({ locator: { page }, percent: n > 1 ? (page - 1) / (n - 1) : 1, label: `${page} / ${n}`, page, pageCount: n }); }}
        onExit={async () => {
          onSettings({ viewMode: "continuous" });
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          getCurrentWindow().setFullscreen(false);
          restored.current = false; // re-anchor to the presented page when the page view mounts
        }}
      />
    );
  }

  if (settings.reflow && doc) {
    return (
      <ReflowView
        doc={doc}
        initialPage={currentPage.current > 1 ? currentPage.current : props.initial && "page" in props.initial ? props.initial.page : 1}
        font={settings.font}
        onPage={(page) => {
          currentPage.current = page;
          const n = doc.numPages;
          props.onLocation({ locator: { page }, percent: n > 1 ? (page - 1) / (n - 1) : 1, label: `${page} / ${n} · reflow`, page, pageCount: n });
        }}
        registerJump={(fn) => (reflowJump.current = fn)}
        onSelection={props.onSelection}
        query={query}
      />
    );
  }

  const theme = settings.pdfTheme ?? "normal";
  const toolClass = tool.type === "hand" ? "pdf-tool-hand" : tool.type === "area" || tool.type === "table" ? "pdf-tool-area" : tool.type === "annotate" && !["highlight", "underline", "strike", "squiggly"].includes(tool.kind) ? "pdf-tool-draw" : "";

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      tabIndex={-1}
      className={cn("relative h-full w-full overflow-auto bg-reader-canvas outline-none custom-scrollbar", `pdf-theme-${theme}`, toolClass, single && "snap-y snap-mandatory")}
      onPointerDown={tool.type === "hand" ? (e) => {
        const el = scrollRef.current!; const sx = e.clientX, sy = e.clientY, st = el.scrollTop, sl = el.scrollLeft;
        const move = (m: PointerEvent) => { el.scrollTop = st - (m.clientY - sy); el.scrollLeft = sl - (m.clientX - sx); };
        const upFn = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", upFn); };
        window.addEventListener("pointermove", move); window.addEventListener("pointerup", upFn);
      } : undefined}
    >
      {banner}
      <div style={{ height: rows.total, position: "relative", minWidth: "100%" }}>
        {doc && rows.list.map((r, ri) => {
          const near = r.pages.some((p) => p >= visible[0] - 1 && p <= visible[1] + 1);
          return (
            <div key={ri} className={cn("absolute left-0 right-0 flex justify-center", single && "snap-start")} style={{ top: r.top, height: r.height, gap: GAP }}>
              {r.pages.map((p) => {
                const c = cropFor(settings.crop, p);
                return (
                  <PdfPage
                    key={p}
                    doc={doc}
                    pageNum={p}
                    scale={scale}
                    rotation={rotation}
                    crop={c}
                    baseSize={rotated(p - 1)}
                    render={near}
                    annotations={byPage.get(p) ?? EMPTY}
                    selectedId={props.selectedAnnotation}
                    tool={tool}
                    query={query}
                    onCreate={onCreate}
                    onAnnotationClick={props.onAnnotationClick}
                    onArea={onArea}
                    onLink={onLink}
                    onViewport={onViewport}
                    ocrVersion={ocrVersion}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
      {!doc && <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">Opening…</div>}
      {area && doc && (
        <AreaPopover
          doc={doc}
          ev={area.ev}
          mode={area.mode}
          onClose={() => setArea(null)}
          onAnnotate={(color, comment) => {
            onCreate({ kind: "area", color, comment, anchor: { page: area.ev.page, rects: [area.ev.pdfRect] } });
            setArea(null);
          }}
          onOcclusion={(png, w, h, page) => useOcclusion.setState({ req: { png, w, h, page, bookId: props.bookId, title: "" } })}
        />
      )}
    </div>
  );
});

const EMPTY: Annotation[] = [];
