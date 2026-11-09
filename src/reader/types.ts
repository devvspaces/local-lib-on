import type { Annotation, AnnotationKind, Locator, ReaderSettings } from "@/lib/api";

export interface TocItem { label: string; page?: number; href?: string; cfi?: string; children?: TocItem[] }

export interface LocationInfo {
  locator: Locator;
  percent: number;
  /** Human label: "12 / 340", "Chapter 3 · 45%" */
  label: string;
  page?: number;
  pageCount?: number;
  sectionLabel?: string;
}

export interface SearchHit { id: string; label: string; excerpt: string; page?: number; cfi?: string }

/** A text selection that can be turned into an annotation. */
export interface SelectionInfo {
  text: string;
  /** Viewport rect of the selection (for positioning the popover). */
  rect: DOMRect;
  anchor: Annotation["anchor"];
  pageLabel?: string;
}

export type ToolMode =
  | { type: "select" }        // text selection (Okular Ctrl+4)
  | { type: "area" }          // area selection (Ctrl+3)
  | { type: "table" }         // table selection (Ctrl+5)
  | { type: "magnifier" }
  | { type: "hand" }
  | { type: "annotate"; kind: AnnotationKind; color: string; width?: number };

export interface TtsChunk { text: string; show?: () => void }

export interface EngineHandle {
  goTo(target: { page?: number; cfi?: string; href?: string; locator?: Locator; loc?: string }): void;
  next(): void;
  prev(): void;
  search(query: string): Promise<SearchHit[]>;
  clearSearch(): void;
  /** Plain text of whole book in units, for the full-text index. */
  extractText?(): Promise<{ loc: string; text: string }[]>;
  autoCrop?(): Promise<ReaderSettings["crop"]>;
  /** Read-aloud source (see reader/tts.ts). `show()` highlights/scrolls to the chunk when it starts playing. */
  ttsStart?(): Promise<TtsChunk | null>;
  ttsNext?(): Promise<TtsChunk | null>;
  ttsStop?(): void;
  /** Section-based books (EPUB…): section index for a TOC href, and the number of sections. */
  sectionOf?(href: string): number | null;
  sectionCount?(): number;
}

export interface JumpTarget { page?: number; cfi?: string; loc?: string; query?: string; nonce: number }

export interface EngineProps {
  bookId: number;
  /** Navigation request (search hit, notebook back-link). Applied once the document is laid out. */
  jump?: JumpTarget;
  path: string;
  format: string;
  initial: Locator | null;
  settings: ReaderSettings;
  onSettings: (s: Partial<ReaderSettings>) => void;
  annotations: Annotation[];
  tool: ToolMode;
  onLocation: (l: LocationInfo) => void;
  onToc: (toc: TocItem[]) => void;
  onSelection: (s: SelectionInfo | null) => void;
  onCreateAnnotation: (a: Pick<Annotation, "kind" | "anchor"> & Partial<Annotation>) => Promise<Annotation | void>;
  onAnnotationClick: (a: Annotation, rect: DOMRect) => void;
  onReady?: (info: { pageCount?: number; metadata?: Record<string, unknown> }) => void;
  onError: (e: unknown) => void;
}

export const HIGHLIGHT_COLORS = [
  { id: "yellow", value: "#ffd400", label: "Important" },
  { id: "red", value: "#ff6666", label: "Disagree / problem" },
  { id: "green", value: "#5fb236", label: "Agree / evidence" },
  { id: "blue", value: "#2ea8e5", label: "Definition" },
  { id: "purple", value: "#a28ae5", label: "Idea / question" },
  { id: "magenta", value: "#e56eee", label: "Follow up" },
  { id: "orange", value: "#f19837", label: "Quote" },
  { id: "gray", value: "#aaaaaa", label: "Misc" },
];
export const colorLabel = (c: string | null | undefined) => HIGHLIGHT_COLORS.find((x) => x.value === c)?.label;
