// LLM assistant: retrieval (FTS5 BM25 over your indexed books) + prompt building + streaming chat.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface LlmConfig { provider: "anthropic" | "openai" | "gemini"; model: string; base_url?: string | null; effort?: string | null; fallbacks: boolean; has_key: boolean }
export interface ChatMessage { role: "user" | "assistant"; content: string }
export interface Passage { book_id: number; title: string; loc: string; text: string }
export interface Source extends Passage { n: number }

export const llm = {
  getConfig: () => invoke<LlmConfig>("llm_get_config"),
  saveConfig: (config: LlmConfig, apiKey?: string) => invoke<void>("llm_save_config", { config, apiKey: apiKey ?? null }),
  clearKey: (provider: string) => invoke<void>("llm_clear_key", { provider }),
  listModels: () => invoke<{ id: string; label: string }[]>("llm_list_models"),
  retrieve: (question: string, bookId?: number | null, k = 8) => invoke<Passage[]>("retrieve_passages", { question, bookId: bookId ?? null, k }),
  unitText: (bookId: number, loc: string) => invoke<string | null>("unit_text", { bookId, loc }),
  cancel: (requestId: string) => invoke<void>("llm_cancel", { requestId }),
};

export const ANTHROPIC_MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (default)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (faster, cheaper)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fastest)" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1 (most capable)" },
];

export const SYSTEM_PROMPT = `You are a reading and research assistant inside a personal library app. The reader is studying their own books.
Ground your answers in the numbered SOURCES provided (excerpts from the reader's books). When you use a source, cite it inline as [n] using its number. If the sources don't contain the answer, say so plainly and then answer from general knowledge, clearly marked as such.
Be concise and concrete. Use Markdown (short paragraphs, lists, **bold** for key terms). Quote sparingly: short phrases only, never long passages.`;

export const locLabel = (loc: string) => (loc.startsWith("p") ? `p. ${loc.slice(1)}` : `§${loc.slice(1)}`);

/** Build the user turn: sources (numbered), the current page, the selection, then the request. */
export function buildContext(opts: { question: string; sources: Source[]; currentPage?: { title: string; loc: string; text: string } | null; selection?: string | null }) {
  const parts: string[] = [];
  if (opts.sources.length) {
    parts.push("SOURCES:");
    for (const s of opts.sources) parts.push(`[${s.n}] ${s.title}, ${locLabel(s.loc)}\n${s.text.replace(/\s+/g, " ").trim()}`);
  }
  if (opts.currentPage) parts.push(`CURRENTLY OPEN: ${opts.currentPage.title}, ${locLabel(opts.currentPage.loc)}\n${opts.currentPage.text.replace(/\s+/g, " ").slice(0, 4000)}`);
  if (opts.selection) parts.push(`SELECTED TEXT:\n"${opts.selection.slice(0, 3000)}"`);
  parts.push(`REQUEST:\n${opts.question}`);
  return parts.join("\n\n");
}

/** Number passages, merging duplicates, current page first. */
export function numberSources(passages: Passage[], first?: Passage | null): Source[] {
  const all = first ? [first, ...passages] : passages;
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const p of all) {
    const k = `${p.book_id}:${p.loc}`;
    if (seen.has(k) || !p.text.trim()) continue;
    seen.add(k);
    out.push({ ...p, n: out.length + 1 });
  }
  return out;
}

/** Turn [n] / [n, m] citations in rendered HTML into clickable chips. */
export function linkCitations(html: string, sources: Source[]) {
  return html.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (m, nums: string) => {
    const chips = nums.split(",").map((x) => Number(x.trim())).filter((n) => sources.some((s) => s.n === n));
    if (!chips.length) return m;
    return chips.map((n) => {
      const s = sources.find((x) => x.n === n)!;
      return `<a href="cite://${n}" class="cite-chip" title="${s.title.replace(/"/g, "&quot;")} — ${locLabel(s.loc)}">${n}</a>`;
    }).join("");
  });
}

let seq = 0;
/** Stream a chat completion. Returns a cancel function. */
export async function streamChat(messages: ChatMessage[], onText: (t: string) => void, onDone: (r: { stop_reason: string | null; model: string | null; error: string | null }) => void, system = SYSTEM_PROMPT) {
  const id = `chat-${Date.now()}-${++seq}`;
  const unDelta = await listen<{ id: string; text: string }>("llm_delta", (e) => e.payload.id === id && onText(e.payload.text));
  const unDone = await listen<{ id: string; stop_reason: string | null; model: string | null; error: string | null }>("llm_done", (e) => {
    if (e.payload.id !== id) return;
    unDelta(); unDone();
    onDone(e.payload);
  });
  await invoke("llm_chat", { requestId: id, system, messages }).catch((err) => { unDelta(); unDone(); onDone({ stop_reason: null, model: null, error: String(err) }); });
  return () => { llm.cancel(id); };
}

export const providerName = (c: Pick<LlmConfig, "provider" | "base_url">) =>
  c.provider === "anthropic" ? "Anthropic" : c.provider === "gemini" ? "Google Gemini" : c.base_url ?? "the provider";

// ── Agent mode (tool use) ──────────────────────────────────

/** Fixed system prompt for the research agent. It must not change between turns: Claude's thinking blocks are bound
 *  to the system prompt they were produced under, so per-turn context goes in the user message (agentContext). */
export const AGENT_SYSTEM = `You are a reading and research assistant inside the user's personal library app. You can use tools to search their books, read pages, look at their highlights, open a page in their reader, and propose notes or flashcards (the user confirms before anything is saved).

How to work:
- Ground answers in the user's books. Search, then read the relevant pages before making specific claims. Prefer a few targeted reads over many.
- Cite every specific claim inline as [book_id:p.N] for PDF pages or [book_id:s.N] for ebook sections, e.g. [12:p.40]. The app turns these into links.
- When the user asks where something is, open that page with open_page.
- If the books don't cover it, say so plainly, then answer from general knowledge clearly marked as such.
- Quote sparingly: short phrases only, never long passages.
- Be concise. Use Markdown.
- Each user message may start with a <context> block saying which book is open, where, and any selected text. It reflects the moment of that message.`;

/** Per-turn reader context, prepended to the user's message. */
export function agentContext(ctx: { bookId?: number; title?: string; page?: string | null; selection?: string | null; library?: boolean }) {
  const lines: string[] = [];
  if (ctx.bookId) lines.push(`Open book: "${ctx.title}" (book_id ${ctx.bookId})${ctx.page ? `, at ${ctx.page}` : ""}.`);
  if (ctx.selection) lines.push(`Selected text: "${ctx.selection.slice(0, 1500)}"`);
  if (ctx.library) lines.push("Scope: search across the whole library, not just the open book.");
  return lines.length ? `<context>\n${lines.join("\n")}\n</context>\n\n` : "";
}

export interface ToolRow { call_id: string; name: string; summary?: string; ok?: boolean }
export interface Proposal { kind: "note" | "cards"; payload: { book_id: number; title?: string; markdown?: string; cards?: { front: string; back: string }[] } }
export interface AgentDone { id: string; stop_reason: string | null; model: string | null; error: string | null; history: unknown[]; provider: string }

/** Run one agent turn. Returns a cancel function. */
export async function streamAgent(
  opts: { system: string; history: unknown[]; user: string },
  on: { text: (t: string) => void; tool: (r: ToolRow) => void; toolResult: (r: ToolRow) => void; proposal: (p: Proposal) => void; done: (d: AgentDone) => void },
) {
  const id = `agent-${Date.now()}-${++seq}`;
  const uns = await Promise.all([
    listen<{ id: string; text: string }>("llm_delta", (e) => e.payload.id === id && on.text(e.payload.text)),
    listen<{ id: string; call_id: string; name: string }>("llm_tool", (e) => e.payload.id === id && on.tool({ call_id: e.payload.call_id, name: e.payload.name })),
    listen<{ id: string; call_id: string; name: string; ok: boolean; summary: string }>("llm_tool_result", (e) => e.payload.id === id && on.toolResult(e.payload)),
    listen<{ id: string } & Proposal>("assistant_proposal", (e) => e.payload.id === id && on.proposal({ kind: e.payload.kind, payload: e.payload.payload })),
  ]);
  const unDone = await listen<AgentDone>("llm_agent_done", (e) => {
    if (e.payload.id !== id) return;
    uns.forEach((u) => u()); unDone();
    on.done(e.payload);
  });
  await invoke("llm_agent", { requestId: id, system: opts.system, history: opts.history, user: opts.user }).catch((err) => {
    uns.forEach((u) => u()); unDone();
    on.done({ id, stop_reason: null, model: null, error: String(err), history: opts.history, provider: "" });
  });
  return () => { llm.cancel(id); };
}

/** [12:p.40] / [12:s.3] → clickable chips. */
export function linkAgentCitations(html: string, titleOf: (id: number) => string | undefined) {
  return html.replace(/\[(\d+):([ps])\.?\s?(\d+)\]/g, (_m, b: string, kind: string, n: string) => {
    const t = titleOf(Number(b)) ?? "book";
    return `<a href="open://${b}/${kind}${n}" class="cite-chip" title="${t.replace(/"/g, "&quot;")}, ${kind === "p" ? "p." : "§"} ${n}">${kind === "p" ? "p." : "§"}${n}</a>`;
  });
}

// ── Embeddings & summaries ─────────────────────────────────

export interface EmbedConfig { enabled: boolean; provider: "gemini" | "openai"; model: string; base_url?: string | null }
export interface Summary { book_id: number; scope: string; title: string; text: string; model: string | null; created_at: string }

export interface EmbedStatus { books_done: number; books_total: number; chunks: number; current_book: string | null; last_error: string | null }

export const embedApi = {
  get: () => invoke<EmbedConfig>("get_embed_config"),
  save: (config: EmbedConfig) => invoke<void>("save_embed_config", { config }),
  status: () => invoke<EmbedStatus>("embed_status"),
  test: () => invoke<number>("embed_test"),
  search: (query: string, bookId?: number | null, k = 30) => invoke<Passage[]>("semantic_search", { query, bookId: bookId ?? null, k }),
};

export const summaryApi = {
  list: (bookId?: number | null) => invoke<Summary[]>("list_summaries", { bookId: bookId ?? null }),
  save: (s: Omit<Summary, "created_at">) => invoke<void>("save_summary", { summary: { ...s, created_at: "" } }),
  remove: (bookId: number, scope: string) => invoke<void>("delete_summary", { bookId, scope }),
  rangeText: (bookId: number, from: number, to: number) => invoke<[string, string][]>("range_text", { bookId, from, to }),
};

const collect = (messages: ChatMessage[], system: string) =>
  new Promise<{ text: string; model: string | null }>((resolve, reject) => {
    let text = "";
    streamChat(messages, (t) => (text += t), (r) => (r.error ? reject(new Error(r.error)) : resolve({ text, model: r.model })), system);
  });

const SUMMARY_SYSTEM = "You summarize sections of the reader's own books for their study notes. Write in your own words: short paragraphs and bullet points covering the key ideas, arguments, definitions and examples. Do not reproduce long passages; quote at most a short phrase. Use Markdown.";

/** Map-reduce summary of a page range; cached in the database. */
export async function summarizeRange(book: { id: number; title: string }, from: number, to: number, title: string, scope: string, onStage?: (s: string) => void) {
  const units = await summaryApi.rangeText(book.id, from, to);
  if (!units.length) throw new Error("No indexed text in that range yet (the book may still be indexing, or need OCR).");
  const parts: string[] = [];
  let cur = "";
  for (const [, t] of units) { if (cur.length + t.length > 14000 && cur) { parts.push(cur); cur = ""; } cur += t + "\n\n"; }
  if (cur.trim()) parts.push(cur);
  let model: string | null = null;
  const partials: string[] = [];
  for (const [i, p] of parts.entries()) {
    onStage?.(parts.length > 1 ? `Reading part ${i + 1} of ${parts.length}…` : "Summarizing…");
    const r = await collect([{ role: "user", content: `From "${book.title}", ${title}. Summarize this part:\n\n${p}` }], SUMMARY_SYSTEM);
    partials.push(r.text);
    model = r.model;
  }
  let text = partials[0];
  if (partials.length > 1) {
    onStage?.("Combining…");
    text = (await collect([{ role: "user", content: `Combine these partial summaries of "${title}" from "${book.title}" into one coherent summary (key ideas first, then details):\n\n${partials.join("\n\n---\n\n")}` }], SUMMARY_SYSTEM)).text;
  }
  await summaryApi.save({ book_id: book.id, scope, title, text, model });
  return text;
}

/** Summary scope key for a chapter range (page ranges keep the original "chapter:<page>" form). */
export const chapterScope = (r: { kind: "p" | "s"; from: number }) => (r.kind === "p" ? `chapter:${r.from}` : `chapter:s${r.from}`);
const rangeLabel = (r: { kind: "p" | "s"; from: number; to: number }) => (r.kind === "p" ? `pp. ${r.from}–${r.to}` : `sections ${r.from + 1}–${r.to + 1}`);

const OVERVIEW_SYSTEM = "You write a study overview of a whole book from its chapter summaries, for the reader's own notes. Use Markdown with these sections: **In one paragraph** (the book's thesis), **Key ideas** (5–9 bullets), **Chapter by chapter** (one line per chapter, keep the given chapter titles), **Questions to think about** (3–5). Write in your own words; do not invent chapters that aren't listed.";

/**
 * Whole-book overview: reuse cached chapter summaries, generate only the missing ones, then combine.
 * Saved under scope "book".
 */
export async function bookOverview(
  book: { id: number; title: string },
  chapters: { label: string; kind: "p" | "s"; from: number; to: number }[],
  onStage?: (s: string) => void,
) {
  if (!chapters.length) throw new Error("This book has no table of contents to work from.");
  const cached = new Map((await summaryApi.list(book.id)).map((s) => [s.scope, s.text]));
  const parts: string[] = [];
  for (const [i, c] of chapters.entries()) {
    const scope = chapterScope(c);
    let text = cached.get(scope);
    if (!text) {
      onStage?.(`Chapter ${i + 1} of ${chapters.length}: ${c.label}`);
      try { text = await summarizeRange(book, c.from, c.to, c.label, scope); } catch { text = undefined; } // e.g. an image-only chapter
    }
    if (text) parts.push(`## ${c.label} (${rangeLabel(c)})\n\n${text}`);
  }
  if (!parts.length) throw new Error("No chapter text is indexed yet (the book may still be indexing, or need OCR).");
  onStage?.("Writing the overview…");
  // Keep the combine prompt bounded: trim each chapter summary when the book is long.
  const per = Math.max(600, Math.floor(60000 / parts.length));
  const body = parts.map((p) => (p.length > per ? p.slice(0, per) + "…" : p)).join("\n\n");
  const r = await collect([{ role: "user", content: `Book: "${book.title}". Chapter summaries:\n\n${body}` }], OVERVIEW_SYSTEM);
  await summaryApi.save({ book_id: book.id, scope: "book", title: `Overview — ${book.title}`, text: r.text, model: r.model });
  return r.text;
}
