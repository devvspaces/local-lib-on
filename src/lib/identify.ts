// "Identify with AI": work out what a document is (book, paper, article…) from its first pages, find a DOI /
// ISBN / arXiv id, and fetch authoritative metadata from Crossref / Open Library / Google Books.
// Order: regex identifiers (free, instant) → LLM reading of the first pages (only when needed and a key is set)
// → online lookup. Nothing is written until the user confirms the before/after preview.
import { api, primaryFile, type Book, type BookPatch } from "@/lib/api";
import { llm, streamChat } from "@/lib/assistant";
import { lookupCrossrefTitle, lookupDOI, lookupMetadata, sniffIdentifiers, titleSimilarity, type LookupResult } from "@/lib/metadataLookup";
import { applyOnline, extractForIdentify, toJpegBase64 } from "@/lib/enrich";
import { askConfirm } from "@/components/ui/prompt";
import { toast, toastError } from "@/components/ui/toast";
import { runTask } from "@/lib/tasks";

export interface AiGuess { type?: string; title?: string; subtitle?: string; authors?: string[]; year?: number; doi?: string; isbn?: string; arxiv?: string; publisher?: string; venue?: string }

export interface IdentifyDeps {
  ask?: (prompt: string) => Promise<string>; // LLM; undefined when no AI is configured
  lookupDOI: (doi: string) => Promise<LookupResult | null>;
  lookupCrossrefTitle: (title: string, author?: string) => Promise<LookupResult | null>;
  lookupMetadata: typeof lookupMetadata;
  onStage?: (stage: string) => void;
}

export interface IdentifyResult { patch: BookPatch; coverUrl?: string; via: string; guess?: AiGuess }

export const IDENTIFY_PROMPT = (name: string, text: string) => `Identify this document from its file name and the text of its first pages.
Reply with ONLY a JSON object, no prose, using these keys (omit any you can't determine; never guess an identifier you don't see or know with certainty):
{"type": "book|article|thesis|report|chapter|document", "title": "", "subtitle": "", "authors": ["Full Name"], "year": 2003, "doi": "", "isbn": "", "arxiv": "", "publisher": "", "venue": "journal or conference"}

File name: ${name}

First pages:
"""
${text.slice(0, 6000)}
"""`;

/** Pull the first JSON object out of a model reply (tolerates ```json fences and surrounding prose). */
export function parseGuess(reply: string): AiGuess | null {
  const m = reply.replace(/```(?:json)?/gi, "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    return {
      type: s(j.type), title: s(j.title), subtitle: s(j.subtitle), publisher: s(j.publisher), venue: s(j.venue),
      authors: Array.isArray(j.authors) ? j.authors.map(String).filter(Boolean) : undefined,
      year: Number(j.year) > 1400 && Number(j.year) < 2100 ? Number(j.year) : undefined,
      doi: s(j.doi)?.replace(/^https?:\/\/(dx\.)?doi\.org\//, "").match(/^10\.\d{4,9}\/\S+$/)?.[0],
      isbn: s(j.isbn)?.replace(/[-\s]/g, ""), arxiv: s(j.arxiv)?.match(/\d{4}\.\d{4,5}/)?.[0],
    };
  } catch { return null; }
}

const ITEM_TYPES = ["book", "article", "thesis", "report", "chapter", "document"] as const;

/** Core logic (pure apart from the injected lookups) — unit tested. */
export async function identify(input: { text: string; fileName: string; embedded: BookPatch }, deps: IdentifyDeps): Promise<IdentifyResult | null> {
  const sn = sniffIdentifiers(input.text);
  const doi = input.embedded.doi ?? sn.doi;
  // 1. An identifier printed in the document is the strongest signal — no AI needed.
  const stage = deps.onStage ?? (() => {});
  if (doi || sn.isbns.length || input.embedded.isbn) stage("Looking up the identifier printed in it…");
  if (doi) { const r = await deps.lookupDOI(doi).catch(() => null); if (r?.title) return { patch: r, coverUrl: r.coverUrl, via: `DOI ${doi}` }; }
  if (sn.isbns.length || input.embedded.isbn) {
    const r = await deps.lookupMetadata({ isbn: input.embedded.isbn ?? sn.isbn, isbns: sn.isbns }).catch(() => null);
    if (r?.title) return { patch: r, coverUrl: r.coverUrl, via: `ISBN ${r.isbn ?? sn.isbn}` };
  }
  // 2. Ask the model what this is.
  let guess: AiGuess | null = null;
  if (deps.ask) stage("Asking AI what this document is…");
  if (deps.ask) guess = parseGuess(await deps.ask(IDENTIFY_PROMPT(input.fileName, input.text)).catch(() => ""));
  const title = guess?.title ?? input.embedded.title;
  const author = guess?.authors?.[0] ?? input.embedded.authors?.[0];
  // 3. Resolve the guess online. A model-supplied DOI is only trusted if its record has the same title.
  if (guess || input.embedded.title) stage(guess?.doi ? `Checking DOI ${guess.doi}…` : guess?.isbn ? `Checking ISBN ${guess.isbn}…` : "Searching Crossref / Open Library…");
  if (guess?.doi) {
    const r = await deps.lookupDOI(guess.doi).catch(() => null);
    if (r?.title && (!title || titleSimilarity(r.title, title) >= 0.8)) return { patch: r, coverUrl: r.coverUrl, via: `DOI ${guess.doi}`, guess };
  }
  if (guess?.isbn) {
    const r = await deps.lookupMetadata({ isbn: guess.isbn }).catch(() => null);
    if (r?.title && (!title || titleSimilarity(r.title, title) >= 0.6)) return { patch: r, coverUrl: r.coverUrl, via: `ISBN ${guess.isbn}`, guess };
  }
  if (title) {
    const isPaper = guess?.type ? guess.type !== "book" : !!sn.arxiv;
    const r = isPaper
      ? (await deps.lookupCrossrefTitle(title, author).catch(() => null)) ?? (await deps.lookupMetadata({ title, author }).catch(() => null))
      : (await deps.lookupMetadata({ title, author }).catch(() => null)) ?? (await deps.lookupCrossrefTitle(title, author).catch(() => null));
    if (r?.title && titleSimilarity(r.title, title) >= 0.85) return { patch: r, coverUrl: r.coverUrl, via: r.metadata_source ?? "title search", guess: guess ?? undefined };
  }
  // 4. No online record — the model's reading is still far better than a filename.
  if (guess?.title) {
    const t = ITEM_TYPES.find((x) => x === guess!.type);
    return {
      patch: { title: guess.title, subtitle: guess.subtitle, authors: guess.authors, year: guess.year, publisher: guess.publisher ?? guess.venue, isbn: guess.isbn, item_type: t, metadata_source: "AI" },
      via: "AI reading (no online record found)", guess,
    };
  }
  return null;
}

/** One full LLM reply as a string (Quick-mode chat endpoint, no tools). */
function askLlm(prompt: string) {
  return new Promise<string>((resolve, reject) => {
    let out = "";
    streamChat([{ role: "user", content: prompt }], (t) => { out += t; }, (r) => (r.error ? reject(new Error(r.error)) : resolve(out)),
      "You extract bibliographic metadata. Reply with JSON only.").catch(reject);
  });
}

const FIELDS: [keyof BookPatch, string][] = [["title", "Title"], ["subtitle", "Subtitle"], ["authors", "Authors"], ["year", "Year"], ["publisher", "Publisher"], ["doi", "DOI"], ["isbn", "ISBN"], ["item_type", "Type"]];
const show = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v === undefined || v === null ? "" : String(v));

/** UI entry point: identify, preview the changes, apply on confirm. Returns true if the book was updated. */
export async function identifyAndApply(book: Book): Promise<boolean> {
  const f = primaryFile(book);
  if (!f) { toastError("Nothing to read", "This entry has no file. Download or attach one first."); return false; }
  type Found = { r: IdentifyResult | null; hasKey: boolean };
  // The search is a visible task (spinner + stage); it ends before the confirm dialog opens.
  const found = await runTask<Found | null>(`identify:${book.id}`, "Identifying with AI", async (update) => {
    update({ detail: "Reading the first pages…" });
    const cfg = await llm.getConfig().catch(() => null);
    const ex = await extractForIdentify(book);
    if (!ex) throw new Error(`Could not read the file ${f.path}`);
    const hasKey = !!(cfg?.has_key || cfg?.provider === "openai");
    const r = await identify(
      { text: ex.text, fileName: f.path.split("/").pop() ?? "", embedded: ex.patch },
      { ask: hasKey ? askLlm : undefined, lookupDOI, lookupCrossrefTitle, lookupMetadata, onStage: (d) => update({ detail: d }) },
    );
    return { r, hasKey };
  }, { doneText: () => null, errorTitle: "Identify failed" });
  if (!found) return false; // already running, or failed (shown in the task toast)
  try {
    const { r, hasKey } = found;
    if (!r) { toastError("Couldn't identify it", hasKey ? "No identifier or matching record found." : "No identifier found. Add an AI key in Settings → AI so it can read the pages."); return false; }
    const patch: BookPatch = {};
    applyOnline(patch, r.patch);
    const rows = FIELDS.map(([k, label]) => ({ label, before: show((book as unknown as Record<string, unknown>)[k]), after: show(patch[k]) }))
      .filter((x) => x.after && x.after !== x.before);
    if (!rows.length && !(r.coverUrl && !book.cover_path)) { toast("Already up to date", `Matched via ${r.via}`); return false; }
    const ok = await askConfirm({ title: "Apply these details?", description: `Found via ${r.via}.`, rows, okLabel: "Apply" });
    if (!ok) return false;
    await runTask(`identify-apply:${book.id}`, "Saving details", async () => {
      await api.updateBook(book.id, { ...patch, only_missing: false });
      if (r.coverUrl) { const b64 = await toJpegBase64(r.coverUrl).catch(() => null); if (b64) await api.saveCover(book.id, b64); }
    }, { doneText: () => patch.title ?? book.title, rethrow: true });
    return true;
  } catch (e) { toastError("Identify failed", e); return false; }
}

/** Background variant for items saved from the browser with weak metadata: applies only results verified by an
 *  identifier or an online record (never an AI-only guess) and says so in a toast. */
export async function autoIdentify(bookId: number) {
  try {
    const book = await api.getBook(bookId);
    const f = primaryFile(book);
    if (!f) return;
    const cfg = await llm.getConfig().catch(() => null);
    const ex = await extractForIdentify(book);
    if (!ex) return;
    const r = await identify({ text: ex.text, fileName: f.path.split("/").pop() ?? "", embedded: ex.patch },
      { ask: cfg?.has_key ? askLlm : undefined, lookupDOI, lookupCrossrefTitle, lookupMetadata });
    if (!r || r.patch.metadata_source === "AI") { toast("Check this item's details", `${book.title}: use Identify with AI from its menu.`); return; }
    const patch: BookPatch = {};
    applyOnline(patch, r.patch);
    await api.updateBook(book.id, { ...patch, only_missing: false });
    if (r.coverUrl && !book.cover_path) { const b64 = await toJpegBase64(r.coverUrl).catch(() => null); if (b64) await api.saveCover(book.id, b64); }
    toast("Details found", `${patch.title ?? book.title} (via ${r.via})`, "success");
  } catch (e) { console.warn("[identify] auto failed", e); }
}

/** A title that is really a file name or URL (what browser saves often produce). */
export const weakTitle = (t?: string | null) => !t || /^https?:\/\//i.test(t) || /\.(pdf|epub|djvu?)$/i.test(t) || /^[\w-]+$/.test(t.trim());
