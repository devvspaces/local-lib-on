// Flashcards: FSRS scheduling (ts-fsrs) + cloze helpers. Storage lives in Rust (src-tauri/src/cards.rs).
import { invoke } from "@tauri-apps/api/core";
import { createEmptyCard, fsrs, Rating, type Card as FsrsCard, type Grade } from "ts-fsrs";
import type { Annotation } from "@/lib/api";

export interface StoredCard {
  id: string; book_id: number | null; annotation_id: string | null; front: string; back: string;
  fsrs: FsrsCard; due: string; is_new: boolean; suspended: boolean; book_title?: string | null; page_label?: string | null;
  kind?: "basic" | "occlusion"; media?: OcclusionMedia | null;
}
/** Image occlusion: masks are [x, y, w, h] fractions of the image; `target` is the mask this card asks about. */
export interface OcclusionMedia { image: string; w: number; h: number; masks: [number, number, number, number][]; target: number; mode: "one" | "all"; page?: number }
export interface CardCounts { due: number; new: number; total: number; reviewed_today: number }

const scheduler = fsrs({ enable_fuzz: true, request_retention: 0.9 });
export const NEW_PER_DAY = () => { try { return Number(localStorage.getItem("local-lib-new-cards") ?? 20) || 20; } catch { return 20; } };

const revive = (c: FsrsCard): FsrsCard => ({ ...c, due: new Date(c.due), last_review: c.last_review ? new Date(c.last_review) : undefined });

export const cardsApi = {
  upsert: (card: Partial<StoredCard> & Pick<StoredCard, "front">) => {
    const f = card.fsrs ?? createEmptyCard(new Date());
    return invoke<string>("card_upsert", { card: { id: "", book_id: null, annotation_id: null, back: "", is_new: true, suspended: false, kind: "basic", media: null, ...card, fsrs: f, due: (card.due ?? new Date(f.due).toISOString()) } });
  },
  due: (bookId?: number | null) => invoke<StoredCard[]>("cards_due", { now: new Date().toISOString(), bookId: bookId ?? null, newLimit: NEW_PER_DAY() }),
  list: (bookId?: number | null) => invoke<StoredCard[]>("cards_list", { bookId: bookId ?? null }),
  counts: () => invoke<CardCounts>("cards_counts", { now: new Date().toISOString(), newLimit: NEW_PER_DAY() }),
  remove: (id: string) => invoke<void>("card_delete", { id }),
  async review(card: StoredCard, grade: Grade, seconds?: number) {
    const { card: next } = scheduler.next(revive(card.fsrs), new Date(), grade);
    await invoke("card_review", { id: card.id, rating: grade, fsrs: next, due: new Date(next.due).toISOString(), seconds: seconds ?? null });
    return next;
  },
  /** Human intervals for the four buttons ("10m", "3d"…). */
  preview(card: StoredCard) {
    const p = scheduler.repeat(revive(card.fsrs), new Date());
    const fmt = (d: Date) => {
      const m = Math.max(1, Math.round((d.getTime() - Date.now()) / 60000));
      return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : m < 43200 ? `${Math.round(m / 1440)}d` : m < 525600 ? `${Math.round(m / 43200)}mo` : `${(m / 525600).toFixed(1)}y`;
    };
    return { [Rating.Again]: fmt(p[Rating.Again].card.due), [Rating.Hard]: fmt(p[Rating.Hard].card.due), [Rating.Good]: fmt(p[Rating.Good].card.due), [Rating.Easy]: fmt(p[Rating.Easy].card.due) } as Record<Grade, string>;
  },
};
export { Rating };
export type { Grade };

// ── Cloze ──────────────────────────────────────────────────

/** "{{c1::phrase}}" syntax (Anki-compatible). */
export const CLOZE = /\{\{c\d+::(.+?)(?:::[^}]*)?\}\}/g;
export const isCloze = (s: string) => /\{\{c\d+::/.test(s);
export const clozeFront = (s: string) => s.replace(CLOZE, "[…]");
export const clozeBack = (s: string) => s.replace(CLOZE, "**$1**");

/** Make a cloze from a highlight by hiding `phrase` (first occurrence). */
export function makeCloze(text: string, phrase: string) {
  const i = text.toLowerCase().indexOf(phrase.toLowerCase());
  if (!phrase.trim() || i < 0) return null;
  return `${text.slice(0, i)}{{c1::${text.slice(i, i + phrase.length)}}}${text.slice(i + phrase.length)}`;
}

/** Auto-pick a cloze target: the longest capitalized term or number-heavy phrase, else the longest word. */
export function autoCloze(text: string) {
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  const STOP = new Set(["which", "their", "there", "these", "those", "about", "would", "could", "should", "where", "while", "because"]);
  const candidates = words.filter((w) => w.length > 4 && !STOP.has(w.toLowerCase()));
  const proper = candidates.filter((w) => /^\p{Lu}/u.test(w) && text.indexOf(w) > 0);
  const pick = (proper.length ? proper : candidates).sort((a, b) => b.length - a.length)[0];
  return pick ? makeCloze(text, pick) : null;
}

/** Card from an annotation: comment as the question if present, else a cloze over the highlight. */
export function cardFromAnnotation(a: Annotation, bookTitle?: string) {
  const text = (a.text ?? "").replace(/\s+/g, " ").trim();
  const src = `${bookTitle ?? ""}${a.page_label ? `, p. ${a.page_label}` : ""}`.replace(/^, /, "");
  if (a.comment?.trim().endsWith("?")) return { front: a.comment.trim(), back: text ? `${text}\n\n— ${src}` : src };
  if (!text) return a.comment ? { front: a.comment, back: src } : null;
  const cz = autoCloze(text);
  return cz ? { front: cz, back: [a.comment, src].filter(Boolean).join("\n\n— ") } : { front: `What does this passage say? (${src})`, back: text };
}

/** "Q: … / A: …" blocks from a markdown note. */
export function cardsFromMarkdown(md: string) {
  const out: { front: string; back: string }[] = [];
  const re = /^\s*Q:\s*(.+?)\s*\n\s*A:\s*([\s\S]+?)(?=\n\s*\n|\n\s*Q:|$)/gim;
  for (const m of md.matchAll(re)) out.push({ front: m[1].trim(), back: m[2].trim() });
  return out;
}

export function toAnkiTSV(cards: StoredCard[]) {
  const esc = (s: string) => s.replace(/\t/g, " ").replace(/\n/g, "<br>");
  return ["#separator:tab", "#html:true", ...cards.map((c) => `${esc(c.front)}\t${esc(c.back)}\t${esc(c.book_title ?? "")}`)].join("\n");
}

// ── Image occlusion ──
export const saveCardImage = (pngDataUrl: string) => invoke<string>("card_media_save", { pngBase64: pngDataUrl });

/** One card per mask. "one": only the target is hidden; "all": every mask is hidden, the target is asked. */
export function occlusionCards(base: Omit<OcclusionMedia, "target">, label: string) {
  return base.masks.map((_, i) => ({
    front: `${label} · label ${i + 1} of ${base.masks.length}`,
    media: { ...base, target: i } as OcclusionMedia,
  }));
}

/** Which masks to draw for a card: before reveal, hidden ones; after reveal, the others stay per mode. */
export function visibleMasks(m: OcclusionMedia, revealed: boolean) {
  return m.masks.map((r, i) => ({ r, i, target: i === m.target, hidden: i === m.target ? !revealed : m.mode === "all" })).filter((x) => x.hidden || x.target);
}
