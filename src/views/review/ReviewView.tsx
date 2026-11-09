import { useCallback, useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { BookOpen, Download, RotateCcw, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { cardsApi, clozeBack, clozeFront, isCloze, Rating, toAnkiTSV, NEW_PER_DAY, type Grade, type StoredCard } from "@/lib/cards";
import { renderMarkdown } from "@/lib/markdown";
import { useApp } from "@/store/app";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { askConfirm } from "@/components/ui/prompt";
import { OcclusionView } from "./OcclusionView";

const BUTTONS: { g: Grade; label: string; key: string; cls: string }[] = [
  { g: Rating.Again, label: "Again", key: "1", cls: "border-destructive/40 hover:bg-destructive/10" },
  { g: Rating.Hard, label: "Hard", key: "2", cls: "hover:bg-secondary" },
  { g: Rating.Good, label: "Good", key: "3", cls: "border-primary/50 hover:bg-accent" },
  { g: Rating.Easy, label: "Easy", key: "4", cls: "hover:bg-secondary" },
];

/** Spaced-repetition review of cards made from highlights and notes. */
export function ReviewView() {
  const [queue, setQueue] = useState<StoredCard[] | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState(0);
  const [started, setStarted] = useState(Date.now());
  const [all, setAll] = useState<StoredCard[]>([]);
  const [tab, setTab] = useState<"review" | "browse">("review");
  const [newLimit, setNewLimit] = useState(NEW_PER_DAY());
  const { openBook, view } = useApp();

  const load = useCallback(() => { cardsApi.due().then((q) => { setQueue(q); setRevealed(false); setStarted(Date.now()); }); cardsApi.list().then(setAll); }, []);
  useEffect(() => { if (view === "review") load(); }, [view, load]);

  const card = queue?.[0];
  const rate = useCallback(async (g: Grade) => {
    if (!card) return;
    const next = await cardsApi.review(card, g, Math.round((Date.now() - started) / 1000));
    setDone((d) => d + 1);
    // "Again" within the session: requeue at the end if it's due again within 10 minutes.
    const again = new Date(next.due).getTime() - Date.now() < 10 * 60 * 1000;
    setQueue((q) => { const rest = (q ?? []).slice(1); return again ? [...rest, { ...card, fsrs: next, is_new: false }] : rest; });
    setRevealed(false);
    setStarted(Date.now());
  }, [card, started]);

  useEffect(() => {
    if (tab !== "review") return;
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); setRevealed(true); return; }
      const b = BUTTONS.find((x) => x.key === e.key);
      if (b && revealed) rate(b.g);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [revealed, rate, tab]);

  const front = card ? (isCloze(card.front) ? clozeFront(card.front) : card.front) : "";
  const back = card ? (isCloze(card.front) ? `${clozeBack(card.front)}${card.back ? `\n\n${card.back}` : ""}` : card.back) : "";
  const intervals = card ? cardsApi.preview(card) : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <div className="flex rounded-md border p-0.5 text-[13px]">
          {(["review", "browse"] as const).map((t) => <button key={t} onClick={() => setTab(t)} className={cn("rounded px-3 py-0.5 capitalize cursor-pointer", tab === t && "bg-accent text-accent-foreground")}>{t}</button>)}
        </div>
        <span className="text-xs text-muted-foreground">{queue ? `${queue.length} left today · ${done} reviewed` : ""} · {all.length} cards</span>
        <label className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">New per day
          <input type="number" min={0} value={newLimit} onChange={(e) => { const v = Number(e.target.value) || 0; setNewLimit(v); try { localStorage.setItem("local-lib-new-cards", String(v)); } catch { /* ignore */ } }} className="h-7 w-14 rounded border bg-background px-1 text-foreground" />
        </label>
        <Button size="xs" variant="outline" onClick={async () => {
          const path = await save({ defaultPath: "local-lib-cards.txt", filters: [{ name: "Anki text", extensions: ["txt", "tsv"] }] });
          if (path) { await api.writeTextFile(path, toAnkiTSV(all)); toast("Exported for Anki", path, "success"); }
        }}><Download /> Anki</Button>
      </div>

      {tab === "review" ? (
        <div className="flex flex-1 items-center justify-center overflow-y-auto p-6">
          {!queue ? null : !card ? (
            <div className="text-center">
              <p className="text-lg font-semibold">{done ? "All done for now 🎉" : all.length ? "Nothing due right now" : "No flashcards yet"}</p>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                {all.length ? "Come back later; cards reappear when they're due." : "Open a book, click a highlight, and choose “Make flashcard”, or make cards from every highlight in the Annotations panel."}
              </p>
              {done > 0 && <Button size="sm" variant="outline" className="mt-3" onClick={load}><RotateCcw /> Check again</Button>}
            </div>
          ) : (
            <div className="w-full max-w-2xl">
              <div className="rounded-xl border bg-card p-8 shadow-sm">
                {card.kind === "occlusion" && card.media ? (
                  <>
                    <p className="mb-3 text-sm text-muted-foreground">{revealed ? "Answer revealed" : "What's under the orange box?"}</p>
                    <OcclusionView media={card.media} revealed={revealed} />
                    {revealed && card.back && <div className="md-preview mt-4 border-t pt-4 text-[15px]" dangerouslySetInnerHTML={{ __html: renderMarkdown(card.back) }} />}
                  </>
                ) : (
                  <>
                    <div className="md-preview text-[17px] font-serif" dangerouslySetInnerHTML={{ __html: renderMarkdown(front) }} />
                    {revealed && <div className="md-preview mt-6 border-t pt-6 text-[15px]" dangerouslySetInnerHTML={{ __html: renderMarkdown(back || "*(no back)*") }} />}
                  </>
                )}
              </div>
              <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                {card.book_id && (
                  <button onClick={async () => {
                    const page = card.page_label && /^\d+$/.test(card.page_label) ? Number(card.page_label) : undefined;
                    const b = await api.getBook(card.book_id!);
                    openBook(b.id, b.title, page ? { page } : undefined);
                  }} className="flex items-center gap-1 hover:text-foreground cursor-pointer"><BookOpen className="h-3.5 w-3.5" /> {card.book_title}{card.page_label ? `, p. ${card.page_label}` : ""}</button>
                )}
                {card.is_new && <span className="rounded bg-accent px-1.5 text-accent-foreground">new</span>}
              </div>
              <div className="mt-5 flex justify-center gap-2">
                {!revealed ? (
                  <Button onClick={() => setRevealed(true)}>Show answer <span className="ml-1 text-xs opacity-70">Space</span></Button>
                ) : (
                  BUTTONS.map((b) => (
                    <button key={b.g} onClick={() => rate(b.g)} className={cn("flex w-24 flex-col items-center rounded-lg border px-3 py-2 text-sm cursor-pointer", b.cls)}>
                      <span className="font-medium">{b.label}</span>
                      <span className="text-[11px] text-muted-foreground">{intervals?.[b.g]} · {b.key}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto custom-scrollbar">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-background text-left text-xs text-muted-foreground"><tr className="border-b"><th className="px-4 py-2">Front</th><th className="px-2 py-2">Book</th><th className="px-2 py-2">Due</th><th /></tr></thead>
            <tbody>
              {all.map((c) => (
                <tr key={c.id} className="border-b border-border/50">
                  <td className="max-w-0 truncate px-4 py-1.5" style={{ width: "55%" }}>{c.kind === "occlusion" && c.media ? <span className="flex items-center gap-2"><OcclusionView media={c.media} revealed={false} thumb /> {c.front}</span> : isCloze(c.front) ? clozeFront(c.front) : c.front}</td>
                  <td className="max-w-0 truncate px-2 py-1.5 text-muted-foreground">{c.book_title}</td>
                  <td className="px-2 py-1.5 tabular-nums text-muted-foreground">{c.is_new ? "new" : new Date(c.due).toLocaleDateString()}</td>
                  <td className="px-2"><button onClick={async () => { if (!(await askConfirm({ title: "Delete this card?", description: c.front.slice(0, 160), okLabel: "Delete", destructive: true }))) return; await cardsApi.remove(c.id); setAll((a) => a.filter((x) => x.id !== c.id)); }} className="text-muted-foreground hover:text-destructive cursor-pointer" aria-label="Delete card"><Trash2 className="h-3.5 w-3.5" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
