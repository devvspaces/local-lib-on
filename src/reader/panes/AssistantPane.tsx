import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Layers, Library, Loader2, NotebookPen, Search, Send, Settings2, Sparkles, Square, BookOpen, Trash2, Zap } from "lucide-react";
import { api, type Book } from "@/lib/api";
import {
  AGENT_SYSTEM, agentContext, buildContext, linkAgentCitations, linkCitations, llm, locLabel, numberSources, providerName, streamAgent, streamChat,
  type ChatMessage, type LlmConfig, type Proposal, type Source, type ToolRow,
} from "@/lib/assistant";
import { renderMarkdown } from "@/lib/markdown";
import { notebookBus } from "../notebookBus";
import { useApp } from "@/store/app";
import { cardsApi, cardsFromMarkdown } from "@/lib/cards";
import { cn } from "@/lib/utils";
import { chatStore, serializeChat } from "./chatStore";
import { toast, toastError } from "@/components/ui/toast";

const handledRequests = new Set<number>();

export interface AssistantRequest { prompt: string; selection?: string; nonce: number }

interface Turn {
  user: string;
  answer: string;
  sources: Source[];
  tools: ToolRow[];
  proposals: (Proposal & { saved?: boolean })[];
  error?: string | null;
  model?: string | null;
  stop?: string | null;
  streaming?: boolean;
  mode: "research" | "quick";
}

/**
 * Research assistant beside the text.
 * - Research mode (default): the model uses tools — searches your library, reads pages, checks your highlights,
 *   opens pages — and cites as [book:page]. Notes/cards it proposes are only saved when you confirm.
 * - Quick mode: one-shot answer grounded in retrieved passages with [n] citations.
 */
export function AssistantPane({ book, currentLoc, request }: { book: Book; currentLoc?: string | null; request?: AssistantRequest | null }) {
  const [cfg, setCfg] = useState<LlmConfig | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [scope, setScope] = useState<"book" | "library">("book");
  const [mode, setMode] = useState<"research" | "quick">("research");
  const [titles, setTitles] = useState<Map<number, string>>(new Map([[book.id, book.title]]));
  const history = useRef<{ provider: string; messages: unknown[] }>({ provider: "", messages: [] });
  const cancel = useRef<(() => void) | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const { openBook, setView } = useApp();
  const busy = turns.some((t) => t.streaming);

  // Restore this book's chat; save it after every completed turn.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    chatStore.load<Turn>(book.id).then((c) => {
      if (!alive) return;
      if (c && !turnsRef.current.length) {
        setTurns(c.turns);
        history.current = c.history;
        if (c.scope === "book" || c.scope === "library") setScope(c.scope);
        if (c.mode === "research" || c.mode === "quick") setMode(c.mode);
      }
      setLoaded(true);
    });
    return () => { alive = false; };
  }, [book.id]);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  useEffect(() => {
    if (!loaded || busy || !turns.length) return;
    chatStore.save(book.id, serializeChat(turns, history.current, scope, mode));
  }, [loaded, busy, turns, scope, mode, book.id]);
  // Each request (e.g. "Explain with AI") is handled exactly once — not again on a dev double-mount, a remount,
  // or when another book opens with the pane still showing.
  useEffect(() => {
    if (!loaded || !request || handledRequests.has(request.nonce)) return; // wait for the saved chat first
    handledRequests.add(request.nonce);
    const s = useApp.getState();
    if (s.sidePane?.ask?.nonce === request.nonce) s.setSidePane({ ...s.sidePane, ask: undefined });
    ask(request.prompt, request.selection);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [request?.nonce, loaded]);

  useEffect(() => { llm.getConfig().then(setCfg); }, []);
  useEffect(() => { api.listBooks({}).then((bs) => setTitles(new Map(bs.map((b) => [b.id, b.title])))); }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [turns]);

  const patch = (idx: number, f: (t: Turn) => Turn) => setTurns((ts) => ts.map((x, i) => (i === idx ? f(x) : x)));

  const askQuick = async (idx: number, question: string, selection?: string) => {
    const bookId = scope === "book" ? book.id : null;
    const [passages, pageText] = await Promise.all([
      llm.retrieve(`${question} ${selection ?? ""}`, bookId, scope === "book" ? 6 : 10).catch(() => []),
      scope === "book" && currentLoc ? llm.unitText(book.id, currentLoc).catch(() => null) : Promise.resolve(null),
    ]);
    const current = pageText && currentLoc ? { book_id: book.id, title: book.title, loc: currentLoc, text: pageText } : null;
    const sources = numberSources(passages, current);
    patch(idx, (t) => ({ ...t, sources }));
    const prior: ChatMessage[] = turns.flatMap((t) => (t.error ? [] : [{ role: "user" as const, content: t.user }, { role: "assistant" as const, content: t.answer }]));
    cancel.current = await streamChat(
      [...prior, { role: "user", content: buildContext({ question, sources, selection }) }],
      (t) => patch(idx, (x) => ({ ...x, answer: x.answer + t })),
      (r) => patch(idx, (x) => ({ ...x, streaming: false, error: r.error, model: r.model, stop: r.stop_reason })),
    );
  };

  const askResearch = async (idx: number, question: string, selection?: string) => {
    // Provider-native history can't be replayed on a different provider or model.
    const key = cfg ? `${cfg.provider}:${cfg.model}` : "";
    if (history.current.provider !== key) history.current = { provider: key, messages: [] };
    const page = currentLoc ? locLabel(currentLoc) : null;
    const user = agentContext({ bookId: book.id, title: book.title, page, selection, library: scope === "library" }) + question;
    cancel.current = await streamAgent(
      { system: AGENT_SYSTEM, history: history.current.messages, user },
      {
        text: (t) => patch(idx, (x) => ({ ...x, answer: x.answer + t })),
        tool: (r) => patch(idx, (x) => ({ ...x, tools: [...x.tools, r] })),
        toolResult: (r) => patch(idx, (x) => ({ ...x, tools: x.tools.map((t) => (t.call_id === r.call_id ? { ...t, ...r } : t)) })),
        proposal: (p) => patch(idx, (x) => ({ ...x, proposals: [...x.proposals, p] })),
        done: (d) => {
          if (!d.error) history.current = { provider: key, messages: d.history };
          // Local models without tool support → answer in Quick mode instead.
          if (d.error && /tool|function/i.test(d.error) && cfg?.provider === "openai") {
            patch(idx, (x) => ({ ...x, mode: "quick", tools: [], answer: "" }));
            askQuick(idx, question, selection);
            return;
          }
          patch(idx, (x) => ({ ...x, streaming: false, error: d.error, model: d.model, stop: d.stop_reason }));
        },
      },
    );
  };

  const ask = async (question: string, selection?: string) => {
    if (!question.trim() || busy) return;
    const idx = turns.length;
    setTurns((ts) => [...ts, { user: selection ? `${question}\n\n> ${selection.slice(0, 300)}${selection.length > 300 ? "…" : ""}` : question, answer: "", sources: [], tools: [], proposals: [], streaming: true, mode }]);
    setInput("");
    if (mode === "research") await askResearch(idx, question, selection);
    else await askQuick(idx, question, selection);
  };

  const onAnswerClick = (e: React.MouseEvent, t: Turn) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    const open = href.match(/^open:\/\/(\d+)\/([ps])(\d+)/);
    const cite = href.match(/^cite:\/\/(\d+)/);
    if (open) {
      const id = Number(open[1]);
      openBook(id, titles.get(id) ?? "Book", open[2] === "p" ? { page: Number(open[3]) } : { loc: `s${open[3]}` });
    } else if (cite) {
      const s = t.sources.find((x) => x.n === Number(cite[1]));
      if (s) openBook(s.book_id, s.title, s.loc.startsWith("p") ? { page: Number(s.loc.slice(1)) } : { loc: s.loc });
    } else if (/^https?:/.test(href)) import("@tauri-apps/plugin-opener").then((o) => o.openUrl(href));
  };

  const saveProposal = async (idx: number, pi: number, p: Proposal) => {
    try {
      if (p.kind === "note") {
        await api.upsertNote({ book_id: p.payload.book_id || null, title: p.payload.title ?? "Note", body: p.payload.markdown ?? "" });
        toast("Note saved", p.payload.title);
      } else {
        for (const c of p.payload.cards ?? []) await cardsApi.upsert({ ...c, book_id: p.payload.book_id || null });
        toast(`Saved ${p.payload.cards?.length ?? 0} flashcards`, "Review them in the Review tab");
      }
      patch(idx, (x) => ({ ...x, proposals: x.proposals.map((q, j) => (j === pi ? { ...q, saved: true } : q)) }));
    } catch (e) { toastError("Could not save", e); }
  };

  if (cfg && !cfg.has_key && cfg.provider !== "openai") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm">
        <p className="font-medium">Connect an AI provider</p>
        <p className="text-muted-foreground">Add an Anthropic or Google Gemini (AI Studio) API key, or point to a local model (Ollama / LM Studio), in Settings → AI. Your key is stored in the macOS Keychain.</p>
        <button onClick={() => setView("settings")} className="flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-primary-foreground cursor-pointer"><Settings2 className="h-4 w-4" /> Open settings</button>
      </div>
    );
  }

  const QUICK = ["Summarize this page", "Where does the author first define the main idea of this chapter?", "What do my highlights in this book say about the core argument?", "Make flashcards for this page"];
  const render = (t: Turn) => {
    const html = renderMarkdown(t.answer || (t.streaming && !t.tools.length ? "…" : ""));
    return t.mode === "research" ? linkAgentCitations(html, (id) => titles.get(id)) : linkCitations(html, t.sources);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-1 text-xs">
        <button onClick={() => setScope("book")} className={cn("flex items-center gap-1 rounded px-2 py-0.5 cursor-pointer", scope === "book" ? "bg-accent text-accent-foreground" : "text-muted-foreground")}><BookOpen className="h-3 w-3" /> This book</button>
        <button onClick={() => setScope("library")} className={cn("flex items-center gap-1 rounded px-2 py-0.5 cursor-pointer", scope === "library" ? "bg-accent text-accent-foreground" : "text-muted-foreground")}><Library className="h-3 w-3" /> Whole library</button>
        <div className="mx-1 h-4 w-px bg-border" />
        <button onClick={() => setMode("research")} title="Uses tools: searches, reads pages, opens pages, proposes notes" className={cn("flex items-center gap-1 rounded px-2 py-0.5 cursor-pointer", mode === "research" ? "bg-accent text-accent-foreground" : "text-muted-foreground")}><Sparkles className="h-3 w-3" /> Research</button>
        <button onClick={() => setMode("quick")} title="One-shot answer from retrieved passages" className={cn("flex items-center gap-1 rounded px-2 py-0.5 cursor-pointer", mode === "quick" ? "bg-accent text-accent-foreground" : "text-muted-foreground")}><Zap className="h-3 w-3" /> Quick</button>
        <span className="ml-auto truncate text-[10px] text-muted-foreground">{cfg?.model}</span>
        {turns.length > 0 && <button onClick={() => { setTurns([]); history.current = { provider: "", messages: [] }; chatStore.clear(book.id); }} title="New chat (clears this conversation)" className="rounded p-1 text-muted-foreground hover:bg-secondary cursor-pointer" aria-label="New chat"><Trash2 className="h-3 w-3" /></button>}
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-3 custom-scrollbar">
        {!turns.length && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {mode === "research"
                ? "Ask anything about your books. The assistant searches and reads the relevant pages itself, cites them (click to jump), and can open pages or propose notes and flashcards."
                : "Quick answers grounded in passages retrieved from your books."}{" "}
              Only the passages it reads, your selection and your question are sent to {cfg ? providerName(cfg) : "the provider"}.
            </p>
            {QUICK.map((q) => <button key={q} onClick={() => ask(q)} className="block w-full rounded-md border px-2.5 py-1.5 text-left text-[13px] hover:bg-secondary cursor-pointer">{q}</button>)}
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className="space-y-1.5">
            <div className="ml-6 whitespace-pre-wrap rounded-lg bg-accent px-3 py-2 text-[13px] text-accent-foreground" data-selectable>{t.user}</div>
            {t.tools.length > 0 && (
              <details className="rounded-md border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground" open={t.streaming}>
                <summary className="flex cursor-pointer list-none items-center gap-1"><ChevronRight className="h-3 w-3" /><Search className="h-3 w-3" /> {t.tools.length} step{t.tools.length > 1 ? "s" : ""}</summary>
                <ul className="mt-1 space-y-0.5 pl-4">
                  {t.tools.map((r) => (
                    <li key={r.call_id} className="flex items-center gap-1">
                      {r.summary ? (r.ok ? <Check className="h-3 w-3 text-primary" /> : <span className="text-destructive">!</span>) : <Loader2 className="h-3 w-3 animate-spin" />}
                      <span>{r.summary ?? r.name.replace(/_/g, " ")}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {t.error ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive" data-selectable>{t.error}</p>
            ) : (
              <div className="md-preview" onClick={(e) => onAnswerClick(e, t)} dangerouslySetInnerHTML={{ __html: render(t) }} />
            )}
            {t.stop === "refusal" && <p className="text-xs text-muted-foreground">The model declined this request.</p>}
            {t.stop === "max_tokens" && <p className="text-xs text-muted-foreground">The answer was cut off (length limit). Ask it to continue.</p>}
            {t.proposals.map((p, pi) => (
              <div key={pi} className="rounded-md border border-primary/30 bg-accent/40 p-2 text-[12px]">
                <p className="mb-1 font-medium">{p.kind === "note" ? `Proposed note: ${p.payload.title}` : `Proposed ${p.payload.cards?.length ?? 0} flashcards`}</p>
                {p.kind === "note" ? (
                  <div className="md-preview max-h-40 overflow-y-auto text-[12px] custom-scrollbar" dangerouslySetInnerHTML={{ __html: renderMarkdown(p.payload.markdown ?? "") }} />
                ) : (
                  <ul className="max-h-40 list-disc space-y-0.5 overflow-y-auto pl-4 custom-scrollbar">{p.payload.cards?.map((c, ci) => <li key={ci}><b>{c.front}</b> — {c.back}</li>)}</ul>
                )}
                <div className="mt-1.5 flex gap-1">
                  {p.saved ? <span className="flex items-center gap-1 text-primary"><Check className="h-3 w-3" /> Saved</span> : (
                    <button onClick={() => saveProposal(i, pi, p)} className="rounded bg-primary px-2 py-0.5 text-primary-foreground cursor-pointer">Save</button>
                  )}
                </div>
              </div>
            ))}
            {!t.streaming && !t.error && t.answer && (
              <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                {t.mode === "quick" && t.sources.slice(0, 8).map((s) => (
                  <button key={s.n} onClick={() => openBook(s.book_id, s.title, s.loc.startsWith("p") ? { page: Number(s.loc.slice(1)) } : { loc: s.loc })} className="rounded border px-1.5 py-0.5 hover:bg-secondary cursor-pointer" title={s.title}>
                    {s.n}. {s.title.slice(0, 24)}{s.title.length > 24 ? "…" : ""} {locLabel(s.loc)}
                  </button>
                ))}
                {cardsFromMarkdown(t.answer).length > 0 && (
                  <button onClick={async () => { const qa = cardsFromMarkdown(t.answer); for (const c of qa) await cardsApi.upsert({ ...c, book_id: book.id }); toast(`Saved ${qa.length} flashcards`, "Review them in the Review tab"); }} className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-secondary cursor-pointer"><Layers className="h-3 w-3" /> Save {cardsFromMarkdown(t.answer).length} cards</button>
                )}
                <button onClick={() => { notebookBus.emit({ type: "insert", markdown: `\n**Q:** ${t.user}\n\n${t.answer}\n` }); toast("Saved to notebook"); }} className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-secondary cursor-pointer"><NotebookPen className="h-3 w-3" /> Save to notebook</button>
              </div>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <form onSubmit={(e) => { e.preventDefault(); ask(input); }} className="flex items-end gap-1.5 border-t p-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(input); } }}
          rows={2}
          placeholder={scope === "book" ? `Ask about “${book.title}”…` : "Ask across your library…"}
          className="min-h-0 flex-1 resize-none rounded-md border bg-background p-2 text-[13px] outline-none focus:ring-2 focus:ring-ring"
        />
        {busy ? (
          <button type="button" onClick={() => cancel.current?.()} className="rounded-md border p-2 cursor-pointer" aria-label="Stop"><Square className="h-4 w-4" /></button>
        ) : (
          <button type="submit" disabled={!input.trim()} className="rounded-md bg-primary p-2 text-primary-foreground disabled:opacity-40 cursor-pointer" aria-label="Send"><Send className="h-4 w-4" /></button>
        )}
      </form>
    </div>
  );
}
