import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Annotation } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { EngineHandle, EngineProps, SearchHit } from "../types";
import { splitSentences } from "../tts";
import { djvuToc, openDjvu, pageCanvas, zonesTopLeft, type DjvuDoc } from "./djvu";

const GAP = 14;
const PAD = 24;
type Rect = [number, number, number, number];

/**
 * DjVu engine: continuous scroll, fit-width/zoom, rotation-free; hidden text layer from DjVu text zones
 * (selection, highlights, find, read-aloud, full-text index). Annotation anchors are page pixels (top-left).
 */
export const DjvuReader = forwardRef<EngineHandle, EngineProps & { selectedAnnotation: string | null }>(function DjvuReader(props, ref) {
  const { settings, annotations, onSettings } = props;
  const [doc, setDoc] = useState<DjvuDoc | null>(null);
  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([]);
  const [container, setContainer] = useState({ w: 800, h: 600 });
  const [reveal, setReveal] = useState(0);
  const [visible, setVisible] = useState<[number, number]>([1, 3]);
  const [query, setQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const current = useRef(1);
  const restored = useRef(false);
  const textCache = useRef(new Map<number, string>());

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await openDjvu(props.path);
        if (!alive) return;
        const n = d.getPagesQuantity();
        const first = await d.getPage(1);
        // DjVu pages carry their own dpi; normalize to 72-dpi "points" so zoom behaves like PDFs.
        const norm = (p: { getWidth(): number; getHeight(): number; getDpi(): number }) => { const k = 72 / (p.getDpi() || 300); return { w: p.getWidth() * k, h: p.getHeight() * k }; };
        setSizes(new Array(n).fill(norm(first)));
        setDoc(d);
        props.onToc(djvuToc(d));
        props.onReady?.({ pageCount: n, metadata: { Format: "DjVu" } });
        const all: { w: number; h: number }[] = [norm(first)];
        for (let i = 2; i <= n && alive; i++) {
          try { all.push(norm(await d.getPage(i))); } catch { all.push(all[0]); }
          if (i % 40 === 0 || i === n) setSizes((s) => [...all, ...s.slice(all.length)]);
        }
      } catch (e) { props.onError(e); }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.path]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let hidden = false; // hidden tab measures 0×0 — ignore it so the layout and position survive
    const ro = new ResizeObserver(() => {
      if (!el.clientWidth || !el.clientHeight) { hidden = true; return; }
      if (hidden) { hidden = false; setReveal((n) => n + 1); }
      setContainer((c) => (c.w === el.clientWidth && c.h === el.clientHeight ? c : { w: el.clientWidth, h: el.clientHeight }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scale = useMemo(() => {
    const z = settings.zoom ?? "fit-width";
    if (typeof z === "number") return z;
    const s0 = sizes[0] ?? { w: 612, h: 792 };
    const sw = (container.w - PAD * 2) / s0.w;
    return Math.max(0.2, z === "fit-page" ? Math.min(sw, (container.h - PAD) / s0.h) : sw);
  }, [settings.zoom, sizes, container]);

  const rows = useMemo(() => {
    let top = PAD / 2;
    const list = sizes.map((s) => { const r = { top, height: s.h * scale }; top += r.height + GAP; return r; });
    return { list, total: top + PAD / 2 };
  }, [sizes, scale]);

  const anchor = useRef<{ page: number; offset: number } | null>(null);
  const scrollToPage = useCallback((p: number, offset = 0) => {
    const i = Math.max(0, Math.min(rows.list.length - 1, p - 1));
    const r = rows.list[i];
    if (!r) return;
    anchor.current = { page: i + 1, offset };
    scrollRef.current?.scrollTo({ top: Math.max(0, r.top + offset * r.height - 8) });
  }, [rows]);
  // Re-apply the anchor whenever the layout changes (zoom, resize, a hidden tab shown again).
  useLayoutEffect(() => {
    if (anchor.current && restored.current) scrollToPage(anchor.current.page, anchor.current.offset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, reveal]);

  useEffect(() => {
    if (!doc || restored.current || !rows.list.length) return;
    restored.current = true;
    const jp = props.jump?.page ?? (props.jump?.loc?.startsWith("p") ? Number(props.jump.loc.slice(1)) : undefined);
    if (props.jump?.query) setQuery(props.jump.query);
    const loc = props.initial;
    requestAnimationFrame(() => (jp ? scrollToPage(jp) : loc && "page" in loc ? scrollToPage(loc.page, loc.offset ?? 0) : undefined));
  }, [doc, rows, props.initial, props.jump, scrollToPage]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !rows.list.length || !el.clientHeight) return;
    const top = el.scrollTop;
    let first = rows.list.findIndex((r) => r.top + r.height >= top);
    if (first < 0) first = rows.list.length - 1;
    let last = first;
    while (last + 1 < rows.list.length && rows.list[last + 1].top <= top + el.clientHeight) last++;
    setVisible([first, last + 2]);
    const probe = top + el.clientHeight * 0.3;
    const pi = Math.max(0, rows.list.findIndex((r) => r.top + r.height >= probe));
    const r = rows.list[pi];
    const offset = Math.max(0, Math.min(1, (top + 8 - r.top) / r.height));
    current.current = pi + 1;
    anchor.current = { page: pi + 1, offset };
    const n = rows.list.length;
    props.onLocation({ locator: { page: pi + 1, offset: Math.round(offset * 1000) / 1000 }, percent: n > 1 ? (pi + offset) / (n - 1) : 1, label: `${pi + 1} / ${n}`, page: pi + 1, pageCount: n });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);
  useEffect(onScroll, [onScroll]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => { if (!(e.ctrlKey || e.metaKey)) return; e.preventDefault(); onSettings({ zoom: Math.min(6, Math.max(0.25, Math.round(scale * Math.exp(-e.deltaY * 0.01) * 100) / 100)) }); };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [scale, onSettings]);

  const pageText = useCallback(async (p: number) => {
    if (!doc) return "";
    if (!textCache.current.has(p)) { try { textCache.current.set(p, (await doc.getPage(p)).getText() ?? ""); } catch { textCache.current.set(p, ""); } }
    return textCache.current.get(p)!;
  }, [doc]);

  // Selection → annotation (rects in page pixels, top-left origin, stored unscaled).
  useEffect(() => {
    const el = scrollRef.current;
    const up = () => setTimeout(async () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !el?.contains(sel.anchorNode)) return props.onSelection(null);
      const text = sel.toString().trim();
      if (!text) return;
      const range = sel.getRangeAt(0);
      const pageEl = (range.startContainer.parentElement?.closest("[data-djvu-page]") as HTMLElement | null);
      const page = Number(pageEl?.dataset.djvuPage);
      if (!pageEl || !page) return;
      const box = pageEl.getBoundingClientRect();
      const rects: Rect[] = Array.from(range.getClientRects()).filter((r) => r.width > 1).map((r) => [(r.left - box.left) / scale, (r.top - box.top) / scale, (r.right - box.left) / scale, (r.bottom - box.top) / scale]);
      const tool = props.tool;
      if (tool.type === "annotate" && ["highlight", "underline", "strike", "squiggly"].includes(tool.kind)) {
        await props.onCreateAnnotation({ kind: tool.kind, color: tool.color, text, anchor: { page, rects }, page_label: String(page) });
        sel.removeAllRanges();
        return props.onSelection(null);
      }
      props.onSelection({ text, rect: range.getBoundingClientRect(), anchor: { page, rects }, pageLabel: String(page) });
    }, 0);
    el?.addEventListener("mouseup", up);
    return () => el?.removeEventListener("mouseup", up);
  }, [scale, props.tool, props.onCreateAnnotation, props.onSelection]);

  const tts = useRef<{ page: number; s: string[]; i: number } | null>(null);
  const ttsNext = async (): Promise<{ text: string; show: () => void } | null> => {
    let t = tts.current;
    while (t) {
      t.i++;
      if (t.i < t.s.length) { const page = t.page, text = t.s[t.i]; return { text, show: () => { if (current.current !== page) scrollToPage(page); } }; }
      if (!doc || t.page >= doc.getPagesQuantity()) return null;
      t = tts.current = { page: t.page + 1, s: splitSentences(await pageText(t.page + 1)), i: -1 };
    }
    return null;
  };

  useImperativeHandle(ref, () => ({
    goTo: (t) => { const p = t.page ?? (t.locator && "page" in t.locator ? t.locator.page : undefined) ?? (t.loc?.startsWith("p") ? Number(t.loc.slice(1)) : undefined); if (p) scrollToPage(p); },
    next: () => scrollToPage(current.current + 1),
    prev: () => scrollToPage(current.current - 1),
    search: async (q: string) => {
      setQuery(q);
      if (!doc || q.trim().length < 2) return [];
      const needle = q.toLowerCase();
      const hits: SearchHit[] = [];
      for (let p = 1; p <= doc.getPagesQuantity() && hits.length < 300; p++) {
        const t = (await pageText(p)).replace(/\s+/g, " ");
        const lower = t.toLowerCase();
        for (let at = lower.indexOf(needle); at !== -1 && hits.length < 300; at = lower.indexOf(needle, at + needle.length)) hits.push({ id: `${p}:${at}`, page: p, label: String(p), excerpt: t.slice(Math.max(0, at - 50), at + needle.length + 70) });
      }
      return hits;
    },
    clearSearch: () => setQuery(""),
    extractText: async () => {
      if (!doc) return [];
      const out = [];
      for (let p = 1; p <= doc.getPagesQuantity(); p++) out.push({ loc: `p${p}`, text: await pageText(p) });
      return out;
    },
    ttsStart: async () => { tts.current = { page: current.current, s: splitSentences(await pageText(current.current)), i: -1 }; return ttsNext(); },
    ttsNext,
    ttsStop: () => { tts.current = null; },
  }), [doc, scrollToPage, pageText]);

  const byPage = useMemo(() => {
    const m = new Map<number, Annotation[]>();
    for (const a of annotations) if ("page" in a.anchor) { if (!m.has(a.anchor.page)) m.set(a.anchor.page, []); m.get(a.anchor.page)!.push(a); }
    return m;
  }, [annotations]);

  const theme = settings.pdfTheme ?? "normal";
  return (
    <div ref={scrollRef} onScroll={onScroll} className={cn("relative h-full w-full overflow-auto bg-reader-canvas custom-scrollbar", `pdf-theme-${theme}`)}>
      <div style={{ height: rows.total, position: "relative", minWidth: "100%" }}>
        {doc && rows.list.map((r, i) => (
          <div key={i} className="absolute left-0 right-0 flex justify-center" style={{ top: r.top, height: r.height }}>
            <DjvuPageView doc={doc} n={i + 1} w={sizes[i].w * scale} h={r.height} render={i >= visible[0] - 1 && i <= visible[1]} annotations={byPage.get(i + 1) ?? EMPTY} scale={scale} query={query}
              onAnnotationClick={props.onAnnotationClick} />
          </div>
        ))}
      </div>
      {!doc && <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">Opening DjVu…</div>}
    </div>
  );
});

const EMPTY: Annotation[] = [];

const DjvuPageView = memo(function DjvuPageView({ doc, n, w, h, render, annotations, scale, query, onAnnotationClick }: {
  doc: DjvuDoc; n: number; w: number; h: number; render: boolean; annotations: Annotation[]; scale: number; query: string; onAnnotationClick: EngineProps["onAnnotationClick"];
}) {
  const [img, setImg] = useState<string | null>(null);
  const [zones, setZones] = useState<{ x: number; y: number; w: number; h: number; text: string }[]>([]);
  const [px, setPx] = useState<{ w: number; h: number; k: number } | null>(null); // page pixel size + px→pt factor
  useEffect(() => {
    if (!render || img) return;
    let alive = true;
    pageCanvas(doc, n).then(({ canvas, page }) => {
      if (!alive) return;
      const k = 72 / (page.getDpi() || 300);
      setPx({ w: canvas.width, h: canvas.height, k });
      setZones(zonesTopLeft(page.getNormalizedTextZones() ?? [], page.getHeight()));
      // Scans are often 300–600 dpi: keep only what the screen needs (display size × devicePixelRatio).
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const tw = Math.min(canvas.width, Math.ceil(w * dpr * 1.25));
      const out = document.createElement("canvas");
      out.width = tw;
      out.height = Math.round(canvas.height * (tw / canvas.width));
      out.getContext("2d")!.drawImage(canvas, 0, 0, out.width, out.height);
      canvas.width = canvas.height = 0;
      out.toBlob((b) => alive && b && setImg(URL.createObjectURL(b)), "image/jpeg", 0.9);
    }).catch(() => {});
    return () => { alive = false; };
  }, [render, doc, n, img]);
  useEffect(() => () => { if (img) URL.revokeObjectURL(img); }, [img]);

  // Page-pixel annotation coordinates → on-screen (zones are in page pixels; display is points × scale).
  const f = px ? px.k * scale : scale;
  const q = query.trim().toLowerCase();
  return (
    <div className="pdf-page relative shrink-0" style={{ width: w, height: h }} data-djvu-page={n}>
      {render && img ? <img src={img} alt="" draggable={false} className="absolute inset-0 h-full w-full select-none" /> : <div className="flex h-full items-center justify-center text-xs text-neutral-400">{n}</div>}
      <div className="absolute inset-0 z-[2]" style={{ userSelect: "text" }}>
        {zones.map((z, i) => (
          <span key={i} style={{ position: "absolute", left: z.x * f, top: z.y * f, width: z.w * f, height: z.h * f, fontSize: z.h * f * 0.85, lineHeight: `${z.h * f}px`, color: "transparent", whiteSpace: "pre", overflow: "hidden", background: q.length > 1 && z.text.toLowerCase().includes(q) ? "rgba(255,196,0,.45)" : undefined }}>
            {z.text}{" "}
          </span>
        ))}
      </div>
      <svg className="pointer-events-none absolute inset-0 z-[3]" width={w} height={h}>
        {annotations.map((a) => "page" in a.anchor && (a.anchor.rects ?? []).map((r, i) => {
          const [x1, y1, x2, y2] = (r as Rect).map((v) => v * scale);
          const c = a.color ?? "#ffd400";
          return a.kind === "underline" ? <line key={a.id + i} x1={x1} x2={x2} y1={y2} y2={y2} stroke={c} strokeWidth={1.5} />
            : a.kind === "strike" ? <line key={a.id + i} x1={x1} x2={x2} y1={(y1 + y2) / 2} y2={(y1 + y2) / 2} stroke={c} strokeWidth={1.5} />
            : <rect key={a.id + i} x={x1} y={y1} width={x2 - x1} height={y2 - y1} fill={c} fillOpacity={0.4} style={{ mixBlendMode: "multiply", pointerEvents: "auto", cursor: "pointer" }} onClick={(e) => onAnnotationClick(a, (e.target as Element).getBoundingClientRect())} />;
        }))}
      </svg>
    </div>
  );
});
