import { memo, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { PageViewport } from "pdfjs-dist";
import type { Annotation, CropBox } from "@/lib/api";
import type { ToolMode } from "../types";
import { ocrWords, pdfjs, type PDFDocumentProxy, type PDFPageProxy } from "./pdfjs";
import { AnnotationLayer, strokePath } from "./AnnotationLayer";
import { contains, pointToPdf, toPdf, toViewport, type Rect } from "./geometry";
import { askText } from "@/components/ui/prompt";

export interface PageAreaEvent { page: number; pdfRect: Rect; clientRect: DOMRect; canvas: HTMLCanvasElement; vpRect: Rect; vp: PageViewport }

interface Props {
  doc: PDFDocumentProxy;
  pageNum: number;
  scale: number;
  rotation: number;
  crop: Omit<CropBox, "odd" | "even">;
  baseSize: { w: number; h: number }; // unscaled page size in points (rotation applied)
  render: boolean; // false → lightweight placeholder
  ocrVersion?: number; // bump to re-render the text layer after OCR
  annotations: Annotation[];
  selectedId: string | null;
  tool: ToolMode;
  query: string;
  onCreate: (a: Pick<Annotation, "kind" | "anchor"> & Partial<Annotation>) => void;
  onAnnotationClick: (a: Annotation, rect: DOMRect) => void;
  onArea: (e: PageAreaEvent, mode: "area" | "table") => void;
  onLink: (dest: unknown) => void;
  onViewport?: (page: number, vp: PageViewport) => void;
}

type Draft = { kind: string; start: [number, number]; pts: [number, number][] } | null;

function PdfPageImpl(p: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [vp, setVp] = useState<PageViewport | null>(null);
  const [links, setLinks] = useState<{ rect: Rect; url?: string; dest?: unknown }[]>([]);
  const formRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft>(null);
  const [lens, setLens] = useState<{ x: number; y: number } | null>(null);
  const lensImg = useRef<string | null>(null);

  // Load page proxy only when it should render.
  useEffect(() => {
    if (!p.render) return;
    let alive = true;
    p.doc.getPage(p.pageNum).then((pg) => alive && setPage(pg));
    return () => { alive = false; };
  }, [p.doc, p.pageNum, p.render]);

  // Render canvas + text layer.
  useEffect(() => {
    if (!page || !p.render) return;
    const viewport = page.getViewport({ scale: p.scale, rotation: p.rotation });
    setVp(viewport);
    p.onViewport?.(p.pageNum, viewport);
    const canvas = canvasRef.current!;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    lensImg.current = null;
    const task = page.render({ canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
    task.promise.catch(() => {});

    const tl = textRef.current!;
    tl.replaceChildren();
    tl.style.setProperty("--scale-factor", String(p.scale));
    tl.style.setProperty("--total-scale-factor", String(p.scale));
    tl.style.setProperty("--user-unit", "1");
    const textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent({ includeMarkedContent: true }), container: tl, viewport });
    let alive = true;
    textLayer.render().then(() => {
      if (!alive) return;
      // Scanned page with OCR results → invisible, selectable word spans positioned over the image.
      const words = ocrWords(p.doc, p.pageNum);
      if (words?.length && (tl.textContent ?? "").replace(/\s/g, "").length < 20) {
        for (const [x0, y0, x1, y1, w] of [...words].sort((a, b) => b[3] - a[3] || a[0] - b[0])) {
          const [vx0, vy0] = viewport.convertToViewportPoint(x0, y1);
          const [vx1, vy1] = viewport.convertToViewportPoint(x1, y0);
          const span = document.createElement("span");
          span.textContent = w + " ";
          const hgt = Math.abs(vy1 - vy0);
          span.style.cssText = `left:${Math.min(vx0, vx1)}px;top:${Math.min(vy0, vy1)}px;font-size:${hgt * 0.9}px;line-height:${hgt}px;font-family:sans-serif;`;
          span.dataset.ocr = "1";
          tl.append(span);
          // stretch to the word's width
          const natural = span.getBoundingClientRect().width || 1;
          span.style.transform = `scaleX(${Math.abs(vx1 - vx0) / natural})`;
        }
      }
      markQuery(tl, p.query);
    }).catch(() => {});

    page.getAnnotations({ intent: "display" }).then(async (anns) => {
      if (!alive) return;
      // Fillable form fields → pdf.js annotation layer (values live in doc.annotationStorage).
      const widgets = anns.filter((a) => a.subtype === "Widget");
      const fdiv = formRef.current;
      if (fdiv) {
        fdiv.replaceChildren();
        if (widgets.length) {
          fdiv.style.setProperty("--scale-factor", String(p.scale));
          fdiv.style.setProperty("--total-scale-factor", String(p.scale));
          const layer = new pdfjs.AnnotationLayer({ div: fdiv, accessibilityManager: null, annotationCanvasMap: null, annotationEditorUIManager: null, page, viewport: viewport.clone({ dontFlip: true }), structTreeLayer: null, commentManager: null, linkService: STUB_LINKS, annotationStorage: p.doc.annotationStorage });
          await layer.render({ annotations: widgets, viewport: viewport.clone({ dontFlip: true }), div: fdiv, page, linkService: STUB_LINKS as never, annotationStorage: p.doc.annotationStorage, renderForms: true, imageResourcesPath: "/pdfjs/images/" } as Parameters<typeof layer.render>[0]).catch((e) => console.warn("[forms]", e));
        }
      }
      setLinks(
        anns
          .filter((a) => a.subtype === "Link" && (a.url || a.dest))
          .map((a) => ({ rect: toViewport(viewport, a.rect as Rect), url: a.url, dest: a.dest }))
      );
    });
    return () => {
      alive = false;
      task.cancel();
      textLayer.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, p.scale, p.rotation, p.render, p.ocrVersion]);

  useEffect(() => {
    if (textRef.current) markQuery(textRef.current, p.query);
  }, [p.query]);

  const w = p.baseSize.w * p.scale;
  const h = p.baseSize.h * p.scale;
  const c = p.crop;
  const outerW = w * (1 - c.left - c.right);
  const outerH = h * (1 - c.top - c.bottom);

  const local = (e: React.PointerEvent | React.MouseEvent): [number, number] => {
    const r = innerRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const drawing = p.tool.type === "annotate" && ["ink", "line", "arrow", "rect", "ellipse", "text"].includes(p.tool.kind);
  const dragSelect = p.tool.type === "area" || p.tool.type === "table";
  const interactive = drawing || dragSelect || (p.tool.type === "annotate" && ["note", "stamp"].includes(p.tool.kind));

  const onPointerDown = (e: React.PointerEvent) => {
    if (!vp || e.button !== 0) return;
    if (!(drawing || dragSelect)) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    const pt = local(e);
    setDraft({ kind: p.tool.type === "annotate" ? p.tool.kind : p.tool.type, start: pt, pts: [pt] });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (p.tool.type === "magnifier") {
      const [x, y] = local(e);
      if (!lensImg.current && canvasRef.current) lensImg.current = canvasRef.current.toDataURL("image/jpeg", 0.85);
      setLens({ x, y });
      return;
    }
    if (!draft) return;
    const pt = local(e);
    setDraft((d) => (d ? { ...d, pts: d.kind === "ink" ? [...d.pts, pt] : [d.start, pt] } : d));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!draft || !vp) return;
    const d = draft;
    setDraft(null);
    const end = d.pts[d.pts.length - 1];
    const box: Rect = [Math.min(d.start[0], end[0]), Math.min(d.start[1], end[1]), Math.max(d.start[0], end[0]), Math.max(d.start[1], end[1])];
    const color = p.tool.type === "annotate" ? p.tool.color : "#2ea8e5";
    const width = p.tool.type === "annotate" ? p.tool.width ?? 2 : 2;
    if (d.kind === "area" || d.kind === "table") {
      if (box[2] - box[0] < 6 || box[3] - box[1] < 6) return;
      const ir = innerRef.current!.getBoundingClientRect();
      p.onArea({ page: p.pageNum, pdfRect: toPdf(vp, box), vpRect: box, vp, canvas: canvasRef.current!, clientRect: new DOMRect(ir.left + box[0], ir.top + box[1], box[2] - box[0], box[3] - box[1]) }, d.kind);
      return;
    }
    if (d.kind === "ink") {
      if (d.pts.length < 2) return;
      const pts = d.pts.map(([x, y]) => pointToPdf(vp, x, y));
      const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
      p.onCreate({ kind: "ink", color, anchor: { page: p.pageNum, rects: [[Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]], paths: [pts] }, style: { width } });
      return;
    }
    if (d.kind === "line" || d.kind === "arrow") {
      if (Math.hypot(end[0] - d.start[0], end[1] - d.start[1]) < 5) return;
      const a = pointToPdf(vp, ...d.start), b = pointToPdf(vp, ...end);
      p.onCreate({ kind: d.kind, color, anchor: { page: p.pageNum, rects: [toPdf(vp, box)], points: [a, b] }, style: { width } });
      return;
    }
    if (box[2] - box[0] < 5 || box[3] - box[1] < 5) return;
    if (d.kind === "text") {
      const rect = toPdf(vp, box), page = p.pageNum;
      askText({ title: "Text box", multiline: true, okLabel: "Add" }).then((text) => { if (text) p.onCreate({ kind: "text", color, comment: text, anchor: { page, rects: [rect] } }); });
      return;
    }
    p.onCreate({ kind: d.kind as "rect" | "ellipse", color, anchor: { page: p.pageNum, rects: [toPdf(vp, box)] }, style: { width } });
    void e;
  };

  const onClick = (e: React.MouseEvent) => {
    if (!vp) return;
    const [x, y] = local(e);
    if (p.tool.type === "annotate" && (p.tool.kind === "note" || p.tool.kind === "stamp")) {
      const [px, py] = pointToPdf(vp, x, y);
      if (p.tool.kind === "note") {
        p.onCreate({ kind: "note", color: p.tool.color, anchor: { page: p.pageNum, rects: [[px, py - 16, px + 16, py]] }, comment: "" });
      } else {
        const color = p.tool.color, page = p.pageNum;
        askText({ title: "Stamp", initial: "★ Important", okLabel: "Add" }).then((stamp) => { if (stamp) p.onCreate({ kind: "stamp", color, style: { stamp }, anchor: { page, rects: [[px - 50, py - 14, px + 50, py + 14]] } }); });
      }
      return;
    }
    if (p.tool.type !== "select" && p.tool.type !== "annotate") return;
    if (window.getSelection()?.toString()) return;
    // Hit-test stored annotations (top-most last).
    for (const a of [...p.annotations].reverse()) {
      if (!("page" in a.anchor)) continue;
      const rects = (a.anchor.rects ?? []).map((r) => toViewport(vp, r as Rect));
      if (rects.some((r) => contains(r, x, y, a.kind === "note" ? 4 : 2))) {
        const ir = innerRef.current!.getBoundingClientRect();
        const r = rects[0];
        p.onAnnotationClick(a, new DOMRect(ir.left + r[0], ir.top + r[1], r[2] - r[0], r[3] - r[1]));
        e.stopPropagation();
        return;
      }
    }
  };

  const draftNode = draft && vp && (() => {
    const color = p.tool.type === "annotate" ? p.tool.color : "#2ea8e5";
    const width = (p.tool.type === "annotate" ? p.tool.width ?? 2 : 2) * p.scale;
    const [s, e] = [draft.start, draft.pts[draft.pts.length - 1]];
    const box = { x: Math.min(s[0], e[0]), y: Math.min(s[1], e[1]), width: Math.abs(e[0] - s[0]), height: Math.abs(e[1] - s[1]) };
    switch (draft.kind) {
      case "ink": return <path d={strokePath(draft.pts, width * 1.6)} fill={color} />;
      case "line": case "arrow": return <line x1={s[0]} y1={s[1]} x2={e[0]} y2={e[1]} stroke={color} strokeWidth={width} />;
      case "ellipse": return <ellipse cx={box.x + box.width / 2} cy={box.y + box.height / 2} rx={box.width / 2} ry={box.height / 2} stroke={color} strokeWidth={width} fill="none" />;
      case "table": return <rect {...box} fill="#2ea8e5" fillOpacity={0.1} stroke="#2ea8e5" strokeDasharray="4 3" />;
      default: return <rect {...box} fill={draft.kind === "area" ? "#2ea8e5" : "none"} fillOpacity={0.1} stroke={color} strokeWidth={draft.kind === "area" ? 1.5 : width} strokeDasharray={draft.kind === "area" ? "5 3" : undefined} />;
    }
  })();

  return (
    <div className="pdf-page shrink-0" style={{ width: outerW, height: outerH }} data-page={p.pageNum}>
      <div
        ref={innerRef}
        className="absolute"
        style={{ width: w, height: h, left: -c.left * w, top: -c.top * h }}
        onClick={onClick}
        onPointerLeave={() => setLens(null)}
        onPointerMove={p.tool.type === "magnifier" || draft ? onPointerMove : undefined}
      >
        {p.render ? (
          <>
            <canvas ref={canvasRef} />
            <div ref={textRef} className="textLayer" />
            <div ref={formRef} className="annotationLayer" style={{ position: "absolute", inset: 0, zIndex: 4 }} />
            {vp && <AnnotationLayer vp={vp} annotations={p.annotations} selectedId={p.selectedId} draft={draftNode} />}
            {vp && links.map((l, i) => (
              <a
                key={i}
                className="absolute z-[4] cursor-pointer hover:bg-blue-500/10"
                style={{ left: l.rect[0], top: l.rect[1], width: l.rect[2] - l.rect[0], height: l.rect[3] - l.rect[1], pointerEvents: interactive ? "none" : "auto" }}
                title={l.url}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (l.url) openUrl(l.url); else p.onLink(l.dest); }}
              />
            ))}
            {(drawing || dragSelect) && (
              <div className="absolute inset-0 z-[5]" style={{ touchAction: "none" }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
            )}
            {lens && lensImg.current && (
              <div
                className="pointer-events-none absolute z-[6] rounded-full border-2 border-white shadow-2xl"
                style={{
                  width: 220, height: 220, left: lens.x - 110, top: lens.y - 110,
                  backgroundImage: `url(${lensImg.current})`, backgroundRepeat: "no-repeat",
                  backgroundSize: `${w * 2.5}px ${h * 2.5}px`,
                  backgroundPosition: `${-lens.x * 2.5 + 110}px ${-lens.y * 2.5 + 110}px`,
                }}
              />
            )}
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-neutral-400">{p.pageNum}</div>
        )}
      </div>
    </div>
  );
}

// Minimal link service for the forms layer (links themselves are handled by our own overlay).
const STUB_LINKS = {
  pagesCount: 0, page: 1, rotation: 0, isInPresentationMode: false, externalLinkEnabled: true,
  goToDestination: async () => {}, goToPage: () => {}, addLinkAttributes: () => {}, getDestinationHash: () => "#",
  getAnchorUrl: () => "#", setHash: () => {}, executeNamedAction: () => {}, executeSetOCGState: () => {},
  cachePageRef: () => {}, isPageVisible: () => true, isPageCached: () => true,
};

/** Wrap occurrences of `query` inside text-layer spans with <span class="highlight">. */
function markQuery(container: HTMLElement, query: string) {
  container.querySelectorAll("span.highlight").forEach((m) => {
    const parent = m.parentNode!;
    parent.replaceChild(document.createTextNode(m.textContent ?? ""), m);
    parent.normalize();
  });
  const q = query.trim().toLowerCase();
  if (q.length < 2) return;
  const spans = container.querySelectorAll<HTMLSpanElement>("span:not(.markedContent):not(.highlight)");
  spans.forEach((span) => {
    const t = span.textContent ?? "";
    const lower = t.toLowerCase();
    if (!lower.includes(q) || span.children.length) return;
    const frag = document.createDocumentFragment();
    let i = 0;
    for (let at = lower.indexOf(q); at !== -1; at = lower.indexOf(q, i)) {
      frag.append(t.slice(i, at));
      const m = document.createElement("span");
      m.className = "highlight";
      m.textContent = t.slice(at, at + q.length);
      frag.append(m);
      i = at + q.length;
    }
    frag.append(t.slice(i));
    span.replaceChildren(frag);
  });
}

export const PdfPage = memo(PdfPageImpl);
