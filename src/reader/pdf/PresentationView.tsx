import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "./pdfjs";
import { PdfPage } from "./PdfPage";
import type { Annotation } from "@/lib/api";

/** Full-screen presentation: one page fit to screen, click/arrows to advance, L = laser pointer, B = blackout. */
export function PresentationView({ doc, startPage, annotations, onPage, onExit }: {
  doc: PDFDocumentProxy; startPage: number; annotations: Annotation[]; onPage: (p: number) => void; onExit: () => void;
}) {
  const [page, setPage] = useState(startPage);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [laser, setLaser] = useState(false);
  const [black, setBlack] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [uiVisible, setUiVisible] = useState(true);
  const hideTimer = useRef<number | undefined>(undefined);

  useEffect(() => { doc.getPage(page).then((p) => { const v = p.getViewport({ scale: 1 }); setSize({ w: v.width, h: v.height }); }); onPage(page); }, [doc, page, onPage]);
  useEffect(() => {
    const r = () => setView({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", r);
    return () => window.removeEventListener("resize", r);
  }, []);
  useEffect(() => {
    const go = (d: number) => setPage((p) => Math.max(1, Math.min(doc.numPages, p + d)));
    const key = (e: KeyboardEvent) => {
      if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(e.key)) { e.preventDefault(); go(1); }
      else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(e.key)) { e.preventDefault(); go(-1); }
      else if (e.key === "Home") setPage(1);
      else if (e.key === "End") setPage(doc.numPages);
      else if (e.key.toLowerCase() === "l") setLaser((v) => !v);
      else if (e.key.toLowerCase() === "b" || e.key === ".") setBlack((v) => !v);
      else if (e.key === "Escape") onExit();
      else return;
      e.stopPropagation();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [doc, onExit]);

  const scale = size ? Math.min(view.w / size.w, view.h / size.h) : 1;
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black"
      style={{ cursor: laser ? "none" : uiVisible ? "default" : "none" }}
      onMouseMove={(e) => {
        setCursor({ x: e.clientX, y: e.clientY });
        setUiVisible(true);
        window.clearTimeout(hideTimer.current);
        hideTimer.current = window.setTimeout(() => setUiVisible(false), 1800);
      }}
      onClick={(e) => { if (!laser) setPage((p) => Math.min(doc.numPages, p + (e.clientX < window.innerWidth / 4 ? -1 : 1))); }}
      onContextMenu={(e) => { e.preventDefault(); setPage((p) => Math.max(1, p - 1)); }}
    >
      {size && !black && (
        <PdfPage
          key={page}
          doc={doc}
          pageNum={page}
          scale={scale}
          rotation={0}
          crop={{ top: 0, right: 0, bottom: 0, left: 0 }}
          baseSize={size}
          render
          annotations={annotations.filter((a) => "page" in a.anchor && a.anchor.page === page)}
          selectedId={null}
          tool={{ type: "hand" }}
          query=""
          onCreate={() => {}}
          onAnnotationClick={() => {}}
          onArea={() => {}}
          onLink={() => {}}
        />
      )}
      {laser && cursor && (
        <div className="pointer-events-none fixed z-[90] h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-red-500" style={{ left: cursor.x, top: cursor.y, boxShadow: "0 0 12px 4px rgba(255,40,40,.75)" }} />
      )}
      <div className={`pointer-events-none fixed bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-3 py-1 text-xs text-white/80 transition-opacity ${uiVisible ? "opacity-100" : "opacity-0"}`}>
        {page} / {doc.numPages} · ← → navigate · L laser · B blackout · Esc exit
      </div>
    </div>
  );
}
