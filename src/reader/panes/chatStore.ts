// Persisting assistant chats per book (in the app database kv), so closing the pane or restarting keeps them.
import { tracker } from "@/lib/tracker";

const MAX_TURNS = 20;
const MAX_BYTES = 1_500_000;
export const chatKey = (bookId: number) => `assistant_chat:${bookId}`;

type Msg = { role?: string; content?: unknown };
const isUserText = (m: Msg) => m.role === "user" && (typeof m.content === "string" || (Array.isArray(m.content) && m.content.some((b: { type?: string; text?: string }) => b?.type === "text" || typeof b?.text === "string")));

/** Drop thinking blocks from completed turns (they're bulky and only needed for the in-progress turn). */
export function compactHistory(history: unknown[]): unknown[] {
  const msgs = history as Msg[];
  const cut = msgs.map(isUserText).lastIndexOf(true);
  return msgs.map((m, i) => {
    if (i >= cut || m.role !== "assistant" || !Array.isArray(m.content)) return m;
    const kept = (m.content as { type?: string }[]).filter((b) => b?.type !== "thinking" && b?.type !== "redacted_thinking");
    return { ...m, content: kept.length ? kept : [{ type: "text", text: "(no text)" }] };
  });
}

export interface SavedChat<T> { v: 1; turns: T[]; history: { provider: string; messages: unknown[] }; scope: string; mode: string }

export function serializeChat<T extends { streaming?: boolean }>(turns: T[], history: { provider: string; messages: unknown[] }, scope: string, mode: string): string {
  const kept = turns.slice(-MAX_TURNS).map((t) => ({ ...t, streaming: false }));
  // Dropping display turns doesn't change the provider history — trim it only by size, at a user turn boundary.
  let messages = compactHistory(history.messages);
  let out = JSON.stringify({ v: 1, turns: kept, history: { provider: history.provider, messages }, scope, mode });
  while (out.length > MAX_BYTES && messages.length) {
    const next = (messages as Msg[]).findIndex((m, i) => i > 0 && isUserText(m));
    messages = next > 0 ? messages.slice(next) : [];
    out = JSON.stringify({ v: 1, turns: kept, history: { provider: history.provider, messages }, scope, mode });
  }
  return out;
}

export function parseChat<T>(raw: string | null): SavedChat<T> | null {
  if (!raw) return null;
  try { const c = JSON.parse(raw); return c?.v === 1 && Array.isArray(c.turns) ? c : null; } catch { return null; }
}

export const chatStore = {
  load: async <T,>(bookId: number) => parseChat<T>(await tracker.getKv(chatKey(bookId)).catch(() => null)),
  save: (bookId: number, json: string) => tracker.setKv(chatKey(bookId), json).catch(() => {}),
  clear: (bookId: number) => tracker.setKv(chatKey(bookId), "").catch(() => {}),
};
