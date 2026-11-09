import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import "foliate-js/view.js";
import { Overlayer } from "foliate-js/overlayer.js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fileUrl, type Annotation } from "@/lib/api";
import type { EngineHandle, EngineProps, SearchHit, TocItem } from "../types";
import { useTheme } from "@/components/ThemeProvider";
import { ssmlToText } from "../tts";

// foliate-js has no types; keep the surface we use small and explicit.
interface FoliateBook {
  metadata?: { title?: unknown; author?: unknown; language?: unknown; publisher?: unknown; identifier?: unknown; description?: string; published?: string };
  toc?: { label: string; href: string; subitems?: FoliateBook["toc"] }[];
  sections: { createDocument?: () => Promise<Document> }[];
  getCover?: () => Promise<Blob | null>;
  resolveHref?: (href: string) => { index: number } | null;
}
interface FoliateTTS { start(): string | undefined; next(paused?: boolean): string | undefined; from?(range: Range): string | undefined }
interface FoliateView extends HTMLElement {
  tts?: FoliateTTS;
  initTTS(granularity?: string, highlight?: (range: Range) => void): Promise<void>;
  book: FoliateBook;
  renderer: HTMLElement & { setStyles?: (css: string) => void; getContents: () => { doc: Document; index: number }[] };
  open(file: File | Blob | string): Promise<void>;
  init(o: { lastLocation?: string; showTextStart?: boolean }): Promise<void>;
  goTo(t: string | number): Promise<unknown>;
  goToFraction(f: number): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  addAnnotation(a: { value: string; color?: string; kind?: string }, remove?: boolean): Promise<unknown>;
  deleteAnnotation(a: { value: string }): Promise<unknown>;
  getCFI(index: number, range: Range): string;
  search(o: { query: string; matchCase?: boolean; matchDiacritics?: boolean; matchWholeWords?: boolean }): AsyncGenerator<unknown>;
  clearSearch(): void;
  close(): void;
}

const MIME: Record<string, string> = {
  epub: "application/epub+zip", mobi: "application/x-mobipocket-ebook", azw3: "application/vnd.amazon.ebook",
  fb2: "application/x-fictionbook+xml", cbz: "application/vnd.comicbook+zip", txt: "text/plain", md: "text/markdown",
};

/** Plain text / markdown → minimal single-file EPUB-like HTML via a fake FB2 isn't worth it; wrap as a tiny XHTML book. */
async function textAsBook(url: string, name: string, md: boolean): Promise<File> {
  const raw = await (await fetch(url)).text();
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const body = raw
    .split(/\n{2,}/)
    .map((p) => {
      if (md) {
        const h = p.match(/^(#{1,6})\s+(.*)/);
        if (h) return `<h${h[1].length}>${esc(h[2])}</h${h[1].length}>`;
      }
      return `<p>${esc(p).replace(/\n/g, "<br/>")}</p>`;
    })
    .join("\n");
  // FB2 is a single XML file that foliate-js understands natively.
  const fb2 = `<?xml version="1.0" encoding="UTF-8"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><book-title>${esc(name)}</book-title></title-info></description><body><section>${body
    .replace(/<h\d>(.*?)<\/h\d>/g, "<subtitle>$1</subtitle>")
    .replace(/<br\/>/g, "</p><p>")}</section></body></FictionBook>`;
  return new File([fb2], `${name}.fb2`, { type: MIME.fb2 });
}

const str = (v: unknown): string | undefined => {
  if (!v) return undefined;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(", ");
  if (typeof v === "object") { const o = v as Record<string, unknown>; return str(o.name ?? o.value ?? Object.values(o)[0]); }
  return String(v);
};
export const foliateMeta = (m: FoliateBook["metadata"]) => ({
  title: str(m?.title),
  authors: Array.isArray(m?.author) ? (m!.author as unknown[]).map(str).filter(Boolean) as string[] : m?.author ? [str(m.author)!] : [],
  language: str(m?.language),
  publisher: str(m?.publisher),
  identifier: str(m?.identifier),
  description: m?.description,
  year: m?.published ? Number(String(m.published).slice(0, 4)) || undefined : undefined,
});

/** Run foliate's own search so hits for the query are outlined in the current section. */
async function highlightQuery(view: FoliateView, query: string) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of view.search({ query })) { /* drains; annotations drawn as results arrive */ }
  } catch { /* ignore */ }
}

export type FoliateHandle = EngineHandle & { cover(): Promise<Blob | null>; metadata(): ReturnType<typeof foliateMeta> };

export const FoliateReader = forwardRef<FoliateHandle, EngineProps>(function FoliateReader(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<FoliateView | null>(null);
  const annsRef = useRef<Map<string, Annotation>>(new Map());
  const [ready, setReady] = useState(false);
  const appliedJump = useRef<number | null>(null);
  const ttsRange = useRef<Range | null>(null);
  /** Capture the range foliate wants highlighted for this chunk; apply it only when the chunk plays. */
  const chunk = (ssml: string) => {
    const range = ttsRange.current;
    return {
      text: ssmlToText(ssml),
      show: () => {
        const v = viewRef.current as unknown as { renderer?: { scrollToAnchor?: (r: Range, select?: boolean) => void } } | null;
        if (range) v?.renderer?.scrollToAnchor?.(range, true);
      },
    };
  };
  const { resolvedTheme } = useTheme();
  const propsRef = useRef(props);
  propsRef.current = props;

  // ── Open book ──
  useEffect(() => {
    let alive = true;
    const view = document.createElement("foliate-view") as FoliateView;
    view.style.cssText = "display:block;width:100%;height:100%";
    host.current!.append(view);
    viewRef.current = view;

    (async () => {
      try {
        const url = fileUrl(props.path);
        const name = props.path.split("/").pop() ?? "book";
        let file: File;
        if (props.format === "txt" || props.format === "md") file = await textAsBook(url, name.replace(/\.\w+$/, ""), props.format === "md");
        else if (props.format === "docx" || props.format === "odt") {
          const { officeToEpubFile } = await import("@/lib/officeToEpub");
          file = (await officeToEpubFile(await (await fetch(url)).arrayBuffer(), name, props.format)).file;
        }
        else {
          const blob = await (await fetch(url)).blob();
          file = new File([blob], name, { type: MIME[props.format] ?? blob.type });
        }
        await view.open(file);
        if (!alive) return;

        view.addEventListener("relocate", (e: Event) => {
          const d = (e as CustomEvent).detail as { fraction: number; cfi: string; tocItem?: { label?: string }; location?: { current: number; total: number } };
          const pct = Math.round((d.fraction ?? 0) * 100);
          propsRef.current.onLocation({
            locator: { cfi: d.cfi },
            percent: d.fraction ?? 0,
            label: `${d.tocItem?.label ? `${d.tocItem.label.trim()} · ` : ""}${pct}%`,
            sectionLabel: d.tocItem?.label,
            page: d.location ? d.location.current + 1 : undefined,
            pageCount: d.location?.total,
          });
        });

        view.addEventListener("load", (e: Event) => {
          const { doc, index } = (e as CustomEvent).detail as { doc: Document; index: number };
          doc.addEventListener("pointerup", () => setTimeout(() => onDocSelection(doc, index), 0));
          doc.addEventListener("keydown", (ev) => host.current?.dispatchEvent(new KeyboardEvent("keydown", ev)));
        });

        view.addEventListener("draw-annotation", (e: Event) => {
          const { draw, annotation } = (e as CustomEvent).detail as { draw: (f: unknown, o: unknown) => void; annotation: { value: string; color?: string } };
          const a = annsRef.current.get(annotation.value);
          const color = annotation.color ?? a?.color ?? "#ffd400";
          const kind = a?.kind ?? "highlight";
          const fn = kind === "underline" ? Overlayer.underline : kind === "strike" ? Overlayer.strikethrough : kind === "squiggly" ? Overlayer.squiggly : Overlayer.highlight;
          draw(fn, { color });
        });
        view.addEventListener("show-annotation", (e: Event) => {
          const { value, range } = (e as CustomEvent).detail as { value: string; range: Range };
          const a = annsRef.current.get(value);
          if (!a) return;
          const frame = range.startContainer.ownerDocument?.defaultView?.frameElement?.getBoundingClientRect();
          const r = range.getBoundingClientRect();
          propsRef.current.onAnnotationClick(a, new DOMRect((frame?.left ?? 0) + r.left, (frame?.top ?? 0) + r.top, r.width, r.height));
        });
        view.addEventListener("external-link", (e: Event) => {
          e.preventDefault();
          const { a } = (e as CustomEvent).detail as { a: HTMLAnchorElement };
          openUrl(a.href);
        });

        const toc = (items: FoliateBook["toc"]): TocItem[] => (items ?? []).map((t) => ({ label: t.label?.trim(), href: t.href, children: t.subitems?.length ? toc(t.subitems) : undefined }));
        props.onToc(toc(view.book.toc));
        const j = props.jump;
        appliedJump.current = j?.nonce ?? null;
        const jumpTarget = j?.cfi ?? (j?.loc?.startsWith("s") ? Number(j.loc.slice(1)) : undefined);
        const loc = props.initial && "cfi" in props.initial ? props.initial.cfi : undefined;
        if (jumpTarget !== undefined) {
          await view.init({ showTextStart: true });
          await view.goTo(jumpTarget as string | number);
          if (j?.query) highlightQuery(view, j.query);
        } else await view.init({ lastLocation: loc, showTextStart: !loc });
        props.onReady?.({ metadata: foliateMeta(view.book.metadata) as unknown as Record<string, unknown> });
        setReady(true);
      } catch (e) {
        props.onError(e);
      }
    })();
    return () => {
      alive = false;
      view.close?.();
      view.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.path]);

  const onDocSelection = (doc: Document, index: number) => {
    const view = viewRef.current!;
    const sel = doc.getSelection();
    if (!sel || sel.isCollapsed) return propsRef.current.onSelection(null);
    const range = sel.getRangeAt(0);
    const text = sel.toString().trim();
    if (!text) return;
    const cfi = view.getCFI(index, range);
    const { tool } = propsRef.current;
    if (tool.type === "annotate" && ["highlight", "underline", "strike", "squiggly"].includes(tool.kind)) {
      propsRef.current.onCreateAnnotation({ kind: tool.kind, color: tool.color, text, anchor: { cfi } });
      sel.removeAllRanges();
      return;
    }
    const frame = doc.defaultView?.frameElement?.getBoundingClientRect();
    const r = range.getBoundingClientRect();
    propsRef.current.onSelection({ text, anchor: { cfi }, rect: new DOMRect((frame?.left ?? 0) + r.left, (frame?.top ?? 0) + r.top, r.width, r.height) });
  };

  // Jumps on an already-open book.
  useEffect(() => {
    const v = viewRef.current;
    const j = props.jump;
    if (!v || !ready || !j || appliedJump.current === j.nonce) return;
    appliedJump.current = j.nonce;
    const t = j.cfi ?? (j.loc?.startsWith("s") ? Number(j.loc.slice(1)) : undefined);
    if (t !== undefined) v.goTo(t as string | number).then(() => { if (j.query) highlightQuery(v, j.query); });
  }, [props.jump?.nonce, ready]);

  // ── Sync annotations into the view ──
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !ready) return;
    const next = new Map(props.annotations.filter((a) => "cfi" in a.anchor).map((a) => [(a.anchor as { cfi: string }).cfi, a]));
    for (const [cfi, old] of annsRef.current) {
      const n = next.get(cfi);
      if (!n || n.color !== old.color || n.kind !== old.kind) view.deleteAnnotation({ value: cfi });
    }
    const prev = annsRef.current;
    annsRef.current = next;
    for (const [cfi, a] of next) {
      const o = prev.get(cfi);
      if (!o || o.color !== a.color || o.kind !== a.kind) view.addAnnotation({ value: cfi, color: a.color ?? "#ffd400" });
    }
  }, [props.annotations, ready]);

  // ── Typography / theme / flow ──
  useEffect(() => {
    const view = viewRef.current;
    if (!view?.renderer || !ready) return;
    const f = props.settings.font ?? {};
    const dark = resolvedTheme === "dark";
    const fg = dark ? "#e8e4dc" : "#1d1c1a";
    const bg = dark ? "#141311" : "#fbfaf7";
    view.renderer.setAttribute("flow", props.settings.flow ?? "paginated");
    view.renderer.setAttribute("gap", `${(f.margin ?? 6) / 100}`);
    view.renderer.setAttribute("max-inline-size", `${f.margin ? 900 - f.margin * 20 : 760}px`);
    view.renderer.setAttribute("max-column-count", "2");
    view.renderer.setStyles?.(`
      html { color-scheme: ${dark ? "dark" : "light"}; color: ${fg}; background: ${bg}; }
      body { ${f.family ? `font-family: ${f.family} !important;` : ""} }
      p, li, blockquote, dd { line-height: ${f.lineHeight ?? 1.6} !important; ${f.justify === false ? "text-align: start !important;" : f.justify ? "text-align: justify !important; hyphens: auto;" : ""} }
      html { font-size: ${f.size ?? 18}px !important; }
      a:link { color: ${dark ? "#f3b08f" : "#b4532a"}; }
      ${dark ? "img { filter: brightness(.9); }" : ""}
    `);
  }, [props.settings.font, props.settings.flow, resolvedTheme, ready]);

  useImperativeHandle(ref, () => ({
    goTo: (t) => {
      const v = viewRef.current;
      if (!v) return;
      if (t.cfi) v.goTo(t.cfi);
      else if (t.href) v.goTo(t.href);
      else if (t.locator && "cfi" in t.locator) v.goTo(t.locator.cfi);
      else if (t.loc?.startsWith("s")) v.goTo(Number(t.loc.slice(1)));
    },
    next: () => viewRef.current?.next(),
    prev: () => viewRef.current?.prev(),
    search: async (query: string) => {
      const v = viewRef.current;
      if (!v || query.trim().length < 2) return [];
      const hits: SearchHit[] = [];
      for await (const r of v.search({ query })) {
        if (r === "done") break;
        const res = r as { label?: string; subitems?: { cfi: string; excerpt: { pre: string; match: string; post: string } }[] };
        for (const s of res.subitems ?? []) {
          hits.push({ id: s.cfi, cfi: s.cfi, label: res.label ?? "", excerpt: `${s.excerpt.pre}${s.excerpt.match}${s.excerpt.post}` });
          if (hits.length >= 500) return hits;
        }
      }
      return hits;
    },
    clearSearch: () => viewRef.current?.clearSearch(),
    sectionOf: (href: string) => {
      try { const r = viewRef.current?.book.resolveHref?.(href); return typeof r?.index === "number" ? r.index : null; } catch { return null; }
    },
    sectionCount: () => viewRef.current?.book.sections.length ?? 0,
    extractText: async () => {
      const v = viewRef.current;
      if (!v) return [];
      const out: { loc: string; text: string }[] = [];
      for (const [i, s] of v.book.sections.entries()) {
        if (!s.createDocument) continue;
        try {
          const d = await s.createDocument();
          out.push({ loc: `s${i}`, text: d.body?.textContent?.replace(/\s+/g, " ") ?? "" });
        } catch { /* skip broken sections */ }
      }
      return out;
    },
    ttsStart: async () => {
      const v = viewRef.current;
      if (!v) return null;
      await v.initTTS("sentence", (range) => { ttsRange.current = range; });
      // Start from the selection if there is one in the visible section.
      const contents = v.renderer.getContents();
      const sel = contents.map((c) => c.doc.getSelection()).find((s) => s && !s.isCollapsed);
      ttsRange.current = null;
      const ssml = sel && v.tts?.from ? v.tts.from(sel.getRangeAt(0)) : v.tts?.start();
      return ssml ? chunk(ssml) : null;
    },
    ttsNext: async () => {
      const v = viewRef.current;
      if (!v?.tts) return null;
      ttsRange.current = null;
      let ssml = v.tts.next();
      for (let tries = 0; !ssml && tries < 3; tries++) {
        // end of section → next section
        await v.next();
        await new Promise((r) => setTimeout(r, 250));
        await v.initTTS("sentence", (range) => { ttsRange.current = range; });
        ssml = v.tts?.start();
      }
      return ssml ? chunk(ssml) : null;
    },
    ttsStop: () => {},
    cover: async () => (await viewRef.current?.book.getCover?.()) ?? null,
    metadata: () => foliateMeta(viewRef.current?.book.metadata),
  }), []);

  return <div ref={host} className="h-full w-full bg-background" tabIndex={-1} />;
});
