// Study plans on the Reading tab: today's assignment, plan overview and the "New plan" dialog.
import { useEffect, useMemo, useState } from "react";
import { BookOpen, CalendarCheck, Check, Loader2, Plus, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { api, type Book } from "@/lib/api";
import { tracker, fmtMinutes } from "@/lib/tracker";
import { useApp } from "@/store/app";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { askConfirm } from "@/components/ui/prompt";
import { toast, toastError } from "@/components/ui/toast";
import { llm, streamChat, summaryApi } from "@/lib/assistant";
import { behind, buildPlan, isoDay, plansApi, progress, rollForward, secondsPerUnit, todayItems, type PlanBook, type PlanChapter, type PlanDay, type StudyPlan } from "@/lib/studyPlan";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const fmtDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

/** Chapters for a book: cached from the reader's table of contents, else ~20-page blocks. */
async function planChapters(b: Book): Promise<PlanChapter[]> {
  const raw = await tracker.getKv(`chapters:${b.id}`).catch(() => null);
  if (raw) { try { const c = JSON.parse(raw) as PlanChapter[]; if (c.length) return c; } catch { /* fall through */ } }
  const n = b.num_pages ?? 0;
  if (!n) return [];
  const out: PlanChapter[] = [];
  for (let a = 1; a <= n; a += 20) out.push({ label: `Pages ${a}–${Math.min(n, a + 19)}`, unit: "p", from: a, to: Math.min(n, a + 19) });
  return out;
}

/** Remaining chapters from the reader's current position. */
function remaining(chs: PlanChapter[], percent: number): PlanChapter[] {
  if (!chs.length || percent <= 0.01) return chs;
  const last = chs[chs.length - 1].to, first = chs[0].from;
  const at = first + Math.floor(percent * (last - first));
  return chs.filter((c) => c.to >= at);
}

function openDay(d: PlanDay, books: Map<number, Book>, openBook: ReturnType<typeof useApp.getState>["openBook"]) {
  if (d.book_id == null || d.from == null) return;
  const b = books.get(d.book_id);
  openBook(d.book_id, b?.title ?? "Book", d.unit === "p" ? { page: d.from } : { loc: `s${d.from}` });
}

/** "Today" card — used on the Reading tab and the library home. */
export function TodayPlanCard({ compact }: { compact?: boolean }) {
  const [plans, setPlans] = useState<StudyPlan[]>([]);
  const [books, setBooks] = useState<Map<number, Book>>(new Map());
  const { openBook, libraryVersion } = useApp();
  const load = () => plansApi.list().then((p) => setPlans(p.filter((x) => x.active))).catch(() => {});
  useEffect(() => { load(); api.listBooks({}).then((bs) => setBooks(new Map(bs.map((b) => [b.id, b])))); }, [libraryVersion]);
  const today = isoDay(new Date());
  const items = plans.flatMap((p) => todayItems(p.days, today).map((d) => ({ p, d })));
  const late = plans.filter((p) => behind(p.days, today));
  if (!items.length && !late.length) return null;
  const markDone = async (p: StudyPlan, d: PlanDay) => {
    const days = p.days.map((x) => (x === d ? { ...x, done_at: x.done_at ? null : new Date().toISOString() } : x));
    await plansApi.save({ ...p, days });
    load();
  };
  return (
    <div className={compact ? "px-5 pt-4" : ""}>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Today's study</h2>
      <div className="flex flex-wrap gap-2">
        {items.map(({ p, d }, i) => (
          <div key={`${p.id}:${i}`} className="flex min-w-72 max-w-md flex-1 items-center gap-3 rounded-lg border bg-card p-2.5">
            <CalendarCheck className={d.done_at ? "h-5 w-5 text-primary" : "h-5 w-5 text-muted-foreground"} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold">{d.kind === "review" ? "Review day" : books.get(d.book_id!)?.title ?? p.title}</p>
              <p className="truncate text-xs text-muted-foreground" title={d.label}>{d.label} · ~{fmtMinutes(d.minutes)}</p>
              {d.focus && <p className="mt-0.5 line-clamp-2 text-xs">{d.focus}</p>}
            </div>
            {d.kind === "read" && !d.done_at && <Button size="xs" onClick={() => openDay(d, books, openBook)}><BookOpen /> Start</Button>}
            {d.kind === "review" && !d.done_at && <Button size="xs" onClick={() => useApp.getState().setView("review")}>Review</Button>}
            <Button size="xs" variant={d.done_at ? "secondary" : "outline"} onClick={() => markDone(p, d)} aria-pressed={!!d.done_at}><Check /> {d.done_at ? "Done" : "Mark done"}</Button>
          </div>
        ))}
        {late.map((p) => (
          <div key={`late-${p.id}`} className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
            “{p.title}” is behind schedule.
            <Button size="xs" variant="outline" onClick={async () => { await plansApi.save({ ...p, days: rollForward(p.days, today, p.settings.weekdays) }); load(); toast("Plan moved forward", "Unfinished days now start today."); }}><RotateCcw /> Re-plan from today</Button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Reading tab section: plans list + new plan. */
export function StudyPlansSection() {
  const [plans, setPlans] = useState<StudyPlan[]>([]);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [books, setBooks] = useState<Map<number, Book>>(new Map());
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const openBook = useApp((s) => s.openBook);
  const load = () => plansApi.list().then(setPlans).catch(() => {});
  useEffect(() => { load(); api.listBooks({}).then((bs) => setBooks(new Map(bs.map((b) => [b.id, b])))); }, []);

  const addFocus = async (p: StudyPlan) => {
    setAiBusy(p.id);
    try {
      const reads = p.days.filter((d) => d.kind === "read" && !d.done_at);
      const sums = new Map<string, string>();
      for (const b of p.settings.books) for (const s of await summaryApi.list(b.book_id).catch(() => [])) sums.set(`${b.book_id}:${s.title}`, s.text.slice(0, 600));
      const lines = reads.map((d, i) => {
        const hint = [...sums.entries()].filter(([k]) => k.startsWith(`${d.book_id}:`) && d.label.includes(k.split(":").slice(1).join(":"))).map(([, v]) => v)[0];
        return `${i + 1}. ${books.get(d.book_id!)?.title ?? ""}: ${d.label}${hint ? `\n   Summary: ${hint.replace(/\s+/g, " ")}` : ""}`;
      }).join("\n");
      const reply = await new Promise<string>((res, rej) => {
        let out = "";
        streamChat([{ role: "user", content: `Study plan days:\n${lines}\n\nFor each numbered day, write one short line: what to focus on, then 2 guiding questions. Reply as a JSON array of strings, one per day, same order, nothing else.` }],
          (t) => { out += t; }, (r) => (r.error ? rej(new Error(r.error)) : res(out)), "You help a reader plan focused study sessions. Be brief and concrete.").catch(rej);
      });
      const arr = JSON.parse(reply.replace(/```(?:json)?/g, "").match(/\[[\s\S]*\]/)?.[0] ?? "[]") as string[];
      let k = 0;
      const days = p.days.map((d) => (d.kind === "read" && !d.done_at ? { ...d, focus: arr[k++] ?? d.focus } : d));
      await plansApi.save({ ...p, days });
      load();
      toast("Focus notes added", `${Math.min(arr.length, reads.length)} days`);
    } catch (e) { toastError("Couldn't add focus notes", e); } finally { setAiBusy(null); }
  };

  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-base font-semibold">Study plans</h2>
        <Button size="xs" className="ml-auto" onClick={() => setCreating(true)}><Plus /> New plan</Button>
      </div>
      <TodayPlanCard />
      {!plans.length && <p className="text-sm text-muted-foreground">Pick a book and a finish date (or minutes a day). You'll get a daily assignment that follows the chapters, with review days for your flashcards.</p>}
      <div className="mt-3 space-y-2">
        {plans.map((p) => {
          const pct = Math.round(progress(p.days) * 100);
          const last = p.days[p.days.length - 1]?.date;
          return (
            <div key={p.id} className="rounded-lg border bg-card">
              <div className="flex items-center gap-2 p-2.5 text-[13px]">
                <button onClick={() => setOpen(open === p.id ? null : p.id)} className="min-w-0 flex-1 text-left cursor-pointer">
                  <p className="truncate font-semibold">{p.title}</p>
                  <p className="text-xs text-muted-foreground">{pct}% done · ends {last ? fmtDate(last) : "—"} · {p.days.filter((d) => d.kind === "read").length} sessions</p>
                </button>
                <div className="h-1.5 w-24 overflow-hidden rounded-full bg-secondary"><div className="h-full bg-primary" style={{ width: `${pct}%` }} /></div>
                <Button size="xs" variant="ghost" disabled={!!aiBusy} onClick={() => addFocus(p)} title="Add a focus line and guiding questions to each day (AI)">{aiBusy === p.id ? <Loader2 className="animate-spin" /> : <Sparkles />}</Button>
                <button onClick={async () => { if (await askConfirm({ title: `Delete plan “${p.title}”?`, okLabel: "Delete", destructive: true })) { await plansApi.remove(p.id); load(); } }} className="rounded p-1 text-muted-foreground hover:text-destructive cursor-pointer" aria-label="Delete plan"><Trash2 className="h-4 w-4" /></button>
              </div>
              {open === p.id && (
                <div className="max-h-72 overflow-y-auto border-t text-xs custom-scrollbar">
                  {p.days.map((d, i) => (
                    <div key={i} className="flex items-start gap-2 border-b px-3 py-1.5 last:border-0">
                      <span className="w-24 shrink-0 tabular-nums text-muted-foreground">{fmtDate(d.date)}</span>
                      <div className="min-w-0 flex-1">
                        <p className={d.done_at ? "line-through text-muted-foreground" : ""}>{d.kind === "review" ? "Review day" : `${books.get(d.book_id!)?.title ?? ""}: ${d.label}`}</p>
                        {d.focus && <p className="text-muted-foreground">{d.focus}</p>}
                      </div>
                      <span className="shrink-0 text-muted-foreground">{fmtMinutes(d.minutes)}</span>
                      {d.kind === "read" && <button onClick={() => openDay(d, books, openBook)} className="shrink-0 text-primary hover:underline cursor-pointer">Open</button>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {creating && <NewPlanDialog onClose={() => setCreating(false)} onSaved={() => { setCreating(false); load(); }} />}
    </section>
  );
}

function NewPlanDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [all, setAll] = useState<Book[]>([]);
  const [picked, setPicked] = useState<Book[]>([]);
  const [mode, setMode] = useState<"date" | "minutes">("date");
  const [target, setTarget] = useState(() => { const d = new Date(); d.setDate(d.getDate() + 14); return isoDay(d); });
  const [minutes, setMinutes] = useState(30);
  const [weekdays, setWeekdays] = useState(127);
  const [reviewEvery, setReviewEvery] = useState(4);
  const [planBooks, setPlanBooks] = useState<PlanBook[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listBooks({ sort: "opened" }).then((bs) => setAll(bs.filter((b) => b.files.length && b.status !== "finished")));
    tracker.goals().then((g) => { const daily = g.find((x) => x.kind === "daily_minutes"); if (daily) { setMinutes(daily.target); } }).catch(() => {});
  }, []);
  useEffect(() => {
    let alive = true;
    (async () => {
      const stats = await tracker.stats().catch(() => null);
      const out: PlanBook[] = [];
      for (const b of picked) {
        const chs = remaining(await planChapters(b), b.percent);
        const units = chs.length ? chs[chs.length - 1].to - chs[0].from + 1 : 0;
        const totalUnits = b.num_pages ?? units;
        const spp = stats?.books.find((x) => x.book_id === b.id)?.sec_per_percent ?? null;
        out.push({ book_id: b.id, title: b.title, chapters: chs, secPerUnit: secondsPerUnit(spp, totalUnits, chs[0]?.unit ?? "p") });
      }
      if (alive) setPlanBooks(out);
    })();
    return () => { alive = false; };
  }, [picked]);

  const startDate = isoDay(new Date());
  const preview = useMemo(() => planBooks.some((b) => b.chapters.length)
    ? buildPlan(planBooks.filter((b) => b.chapters.length), { minutesPerDay: mode === "minutes" ? minutes : undefined, targetDate: mode === "date" ? target : undefined, weekdays, reviewEvery, startDate })
    : null, [planBooks, mode, minutes, target, weekdays, reviewEvery, startDate]);

  const save = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      await plansApi.save({
        title: picked.length === 1 ? picked[0].title : `${picked[0].title} + ${picked.length - 1} more`,
        settings: { books: picked.map((b) => ({ book_id: b.id, title: b.title })), minutesPerDay: mode === "minutes" ? minutes : undefined, targetDate: mode === "date" ? target : undefined, weekdays, reviewEvery, startDate },
        days: preview.days, active: true,
      });
      toast("Study plan created", "Today's assignment is on the Reading tab and the library home.", "success");
      onSaved();
    } catch (e) { toastError("Couldn't save the plan", e); } finally { setBusy(false); }
  };

  const field = "h-8 rounded-md border bg-background px-2 text-[13px]";
  const missingToc = planBooks.filter((b) => b.chapters[0]?.label.startsWith("Pages "));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="New study plan" description="Daily reading that follows the chapters, sized to your time." className="max-w-xl">
        <div className="space-y-4 text-sm">
          <div>
            <p className="mb-1 font-medium">Books (in order)</p>
            <div className="flex flex-wrap gap-1">
              {picked.map((b) => <span key={b.id} className="flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs">{b.title}<button onClick={() => setPicked(picked.filter((x) => x.id !== b.id))} className="cursor-pointer" aria-label={`Remove ${b.title}`}>×</button></span>)}
            </div>
            <select value="" onChange={(e) => { const b = all.find((x) => x.id === Number(e.target.value)); if (b && !picked.some((x) => x.id === b.id)) setPicked([...picked, b]); }} className={`${field} mt-1 w-full`}>
              <option value="">Add a book…</option>
              {all.map((b) => <option key={b.id} value={b.id}>{b.title}{b.percent > 0.01 ? ` (${Math.round(b.percent * 100)}% read)` : ""}</option>)}
            </select>
            {missingToc.length > 0 && <p className="mt-1 text-xs text-muted-foreground">Open {missingToc.map((b) => `“${b.title}”`).join(", ")} once so the plan can follow its chapters (using page blocks for now).</p>}
          </div>
          <div className="grid grid-cols-[110px_1fr] items-center gap-2">
            <span className="text-muted-foreground">Pace</span>
            <div className="flex items-center gap-2">
              <select value={mode} onChange={(e) => setMode(e.target.value as "date" | "minutes")} className={field}><option value="date">Finish by</option><option value="minutes">Minutes a day</option></select>
              {mode === "date" ? <input type="date" value={target} min={startDate} onChange={(e) => setTarget(e.target.value)} className={field} /> : <input type="number" min={10} step={5} value={minutes} onChange={(e) => setMinutes(Number(e.target.value) || 30)} className={`${field} w-20`} />}
            </div>
            <span className="text-muted-foreground">Days</span>
            <div className="flex gap-0.5">{DAYS.map((d, i) => <button key={d} onClick={() => setWeekdays(weekdays ^ (1 << i))} aria-pressed={!!(weekdays & (1 << i))} className={`h-7 w-10 rounded text-xs cursor-pointer ${weekdays & (1 << i) ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"}`}>{d}</button>)}</div>
            <span className="text-muted-foreground">Review days</span>
            <select value={reviewEvery} onChange={(e) => setReviewEvery(Number(e.target.value))} className={field}><option value={0}>None</option><option value={3}>Every 3rd day</option><option value={4}>Every 4th day</option><option value={6}>Every 6th day</option></select>
          </div>
          {preview && (
            <div className="rounded-md bg-secondary/60 p-2.5 text-xs">
              <p><b>{preview.days.filter((d) => d.kind === "read").length}</b> reading sessions of about <b>{fmtMinutes(preview.budget)}</b>, finishing <b>{fmtDate(preview.days[preview.days.length - 1].date)}</b>.</p>
              <p className="mt-1 text-muted-foreground">First: {preview.days[0].label}</p>
              {mode === "date" && preview.budget > 120 && <p className="mt-1 text-destructive">That's a lot each day. Consider a later date.</p>}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={save} disabled={!preview || busy}>{busy ? <Loader2 className="animate-spin" /> : <Check />} Create plan</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
