import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Bell, BellRing, Plus, Trash2 } from "lucide-react";
import { api, type Book } from "@/lib/api";
import { tracker, GOAL_LABEL, fmtDuration, fmtMinutes, isTimeGoal, timeLeft, type DetailedStats, type Goal, type GoalKind, type Schedule } from "@/lib/tracker";
import { useApp } from "@/store/app";
import { Button } from "@/components/ui/button";
import { toast, toastError } from "@/components/ui/toast";
import { askConfirm } from "@/components/ui/prompt";
import { StudyPlansSection } from "./StudyPlan";

// Sequential ramp: one hue (the app accent), light → dark. Step 0 = no reading.
const RAMP_LIGHT = ["var(--secondary)", "#f3d3c2", "#e6a483", "#cf7448", "#a8482a"];
const RAMP_DARK = ["var(--secondary)", "#4a2c1f", "#7a3f25", "#b85a32", "#e8895c"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function Heatmap({ days }: { days: DetailedStats["days"] }) {
  const dark = document.documentElement.classList.contains("dark");
  const ramp = dark ? RAMP_DARK : RAMP_LIGHT;
  const [hover, setHover] = useState<{ x: number; y: number; date: string; s: number } | null>(null);
  const map = useMemo(() => new Map(days.map((d) => [d.date, d.seconds])), [days]);
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - 7 * 52 - ((today.getDay() + 6) % 7));
  const cells: { date: string; s: number; col: number; row: number }[] = [];
  for (let d = new Date(start), i = 0; d <= today; d.setDate(d.getDate() + 1), i++) {
    const key = d.toLocaleDateString("en-CA");
    cells.push({ date: key, s: map.get(key) ?? 0, col: Math.floor(i / 7), row: i % 7 });
  }
  const step = (s: number) => (s === 0 ? 0 : s < 600 ? 1 : s < 1800 ? 2 : s < 3600 ? 3 : 4);
  const C = 12, G = 3;
  const w = (cells[cells.length - 1]?.col ?? 0) * (C + G) + C + 28;
  return (
    <div className="relative">
      <svg width={w} height={7 * (C + G) + 4} role="img" aria-label="Reading activity over the last year">
        {[0, 2, 4].map((r) => <text key={r} x={0} y={r * (C + G) + C - 2} fontSize={9} fill="var(--muted-foreground)">{DAYS[r]}</text>)}
        {cells.map((c) => (
          <rect
            key={c.date}
            x={28 + c.col * (C + G)}
            y={c.row * (C + G)}
            width={C}
            height={C}
            rx={2}
            fill={ramp[step(c.s)]}
            onMouseEnter={(e) => setHover({ x: e.clientX, y: e.clientY, date: c.date, s: c.s })}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </svg>
      <div className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">
        Less {ramp.map((c, i) => <span key={i} className="h-2.5 w-2.5 rounded-sm" style={{ background: c }} />)} More
        <span className="ml-2">(&lt;10 min · &lt;30 · &lt;60 · 60+)</span>
      </div>
      {hover && (
        <div className="pointer-events-none fixed z-50 rounded-md border bg-popover px-2 py-1 text-xs shadow" style={{ left: hover.x + 10, top: hover.y - 34 }}>
          <span className="font-medium">{new Date(hover.date + "T12:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</span>
          <span className="ml-2 text-muted-foreground">{hover.s ? fmtDuration(hover.s) : "No reading"}</span>
        </div>
      )}
    </div>
  );
}

/** Minutes-valued input with a minutes / hours unit switch. Calls onCommit with minutes (0 = off). */
function DurationInput({ minutes, onCommit, live, min = 0, className }: { minutes?: number | null; onCommit: (m: number) => void; live?: boolean; min?: number; className?: string }) {
  const [unit, setUnit] = useState<"min" | "h">(minutes && minutes >= 60 ? "h" : "min");
  const [text, setText] = useState(minutes ? String(unit === "h" ? +(minutes / 60).toFixed(2) : minutes) : "");
  const toMinutes = (t: string, u = unit) => Math.max(0, Math.round((Number(t) || 0) * (u === "h" ? 60 : 1)));
  const commit = (t = text, u = unit) => { const m = toMinutes(t, u); onCommit(m && m < min ? min : m); };
  return (
    <span className={`flex items-center gap-1 ${className ?? ""}`}>
      <input type="number" min={0} step={unit === "h" ? 0.25 : 5} value={text} placeholder="off"
        onChange={(e) => { setText(e.target.value); if (live) commit(e.target.value); }} onBlur={() => !live && commit()}
        className="h-8 w-full min-w-0 rounded-md border bg-background px-2 text-[13px] text-foreground" />
      <select value={unit} aria-label="Unit"
        onChange={(e) => {
          const u = e.target.value as "min" | "h";
          const m = toMinutes(text);
          const t = m ? String(u === "h" ? +(m / 60).toFixed(2) : m) : "";
          setUnit(u); setText(t);
        }}
        className="h-8 rounded-md border bg-background px-1 text-xs text-foreground">
        <option value="min">min</option><option value="h">hours</option>
      </select>
    </span>
  );
}

function GoalBar({ g }: { g: DetailedStats["goals"][number] }) {
  const pct = Math.min(1, g.current / Math.max(1, g.target));
  const fmt = (n: number) => (isTimeGoal(g.kind) ? fmtMinutes(n) : String(n));
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-baseline justify-between">
        <p className="text-[13px] font-medium">{GOAL_LABEL[g.kind]}</p>
        <p className="text-[13px] tabular-nums"><span className="font-semibold">{fmt(g.current)}</span><span className="text-muted-foreground"> / {fmt(g.target)}</span></p>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuenow={g.current} aria-valuemax={g.target}>
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct * 100}%` }} />
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">{pct >= 1 ? "Goal met ✓" : `${fmt(g.target - g.current)} to go`}</p>
    </div>
  );
}

export function StatsView() {
  const [stats, setStats] = useState<DetailedStats | null>(null);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [books, setBooks] = useState<Book[]>([]);
  const [nudge, setNudge] = useState("20:30");
  const [hoverBook, setHoverBook] = useState<number | null>(null);
  const openBook = useApp((s) => s.openBook);

  const load = () => {
    tracker.stats().then(setStats);
    tracker.goals().then(setGoals);
    tracker.schedules().then(setSchedules);
  };
  useEffect(() => {
    load();
    api.listBooks({ sort: "opened" }).then(setBooks);
    tracker.getKv("nudge_time").then((v) => v && setNudge(v));
  }, []);

  const maxBook = Math.max(1, ...(stats?.books.map((b) => b.seconds) ?? [1]));
  const setGoal = async (kind: GoalKind, target: number) => {
    const existing = goals.find((g) => g.kind === kind);
    if (!target) { if (existing) await tracker.deleteGoal(existing.id); }
    else await tracker.saveGoal({ id: existing?.id ?? 0, kind, target, active: true });
    load();
  };
  const saveSchedule = async (s: Schedule) => { await tracker.saveSchedule(s); load(); };

  if (!stats) return null;
  return (
    <div className="h-full overflow-y-auto custom-scrollbar">
      <div className="mx-auto max-w-4xl space-y-8 px-6 py-8">
        <section className="grid grid-cols-2 gap-2 md:grid-cols-5">
          <Tile label="Today" value={fmtDuration(stats.today_seconds)} />
          <Tile label="This week" value={fmtDuration(stats.week_seconds)} />
          <Tile label="Streak" value={`${stats.current_streak} d`} sub={`Longest ${stats.longest_streak} d`} />
          <Tile label="Finished this year" value={String(stats.finished_this_year)} sub={`${stats.finished_total} all time`} />
          <Tile label="All time" value={fmtDuration(stats.total_seconds)} />
        </section>

        <section>
          <h2 className="mb-3 text-base font-semibold">Activity</h2>
          <div className="overflow-x-auto rounded-lg border bg-card p-4 custom-scrollbar"><Heatmap days={stats.days} /></div>
        </section>

        <StudyPlansSection />

        <section>
          <h2 className="mb-3 text-base font-semibold">Goals</h2>
          {stats.goals.length > 0 && <div className="mb-3 grid gap-2 md:grid-cols-2">{stats.goals.map((g) => <GoalBar key={g.kind} g={g} />)}</div>}
          <div className="grid gap-2 md:grid-cols-4">
            {(Object.keys(GOAL_LABEL) as GoalKind[]).map((k) => (
              <label key={k} className="rounded-lg border bg-card p-3 text-xs text-muted-foreground">
                {GOAL_LABEL[k]}
                {isTimeGoal(k)
                  ? <DurationInput key={goals.find((g) => g.kind === k)?.id ?? "new"} className="mt-1" minutes={goals.find((g) => g.kind === k)?.target} onCommit={(m) => setGoal(k, m)} />
                  : <input type="number" min={0} defaultValue={goals.find((g) => g.kind === k)?.target ?? ""} placeholder="off"
                      onBlur={(e) => setGoal(k, Number(e.target.value) || 0)}
                      className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-[13px] text-foreground" />}
              </label>
            ))}
          </div>
          <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            Evening reminder if the daily goal isn't met, at
            <input type="time" value={nudge} onChange={(e) => { setNudge(e.target.value); tracker.setKv("nudge_time", e.target.value); }} className="h-7 rounded-md border bg-background px-2 text-[13px] text-foreground" />
          </label>
        </section>

        <section>
          <div className="mb-3 flex items-center gap-2">
            <h2 className="text-base font-semibold">Reading schedule</h2>
            <Button size="xs" variant="outline" className="ml-auto" onClick={() => tracker.testNotification().then(() => toast("Test notification sent", "If nothing appeared, allow notifications for Local Lib in System Settings → Notifications.")).catch((e) => toastError("Notifications unavailable", e))}><BellRing /> Test notification</Button>
            <Button size="xs" onClick={() => saveSchedule({ id: 0, label: "", weekdays: 127, time: "21:00", book_id: null, minutes: 30, enabled: true })}><Plus /> Add</Button>
          </div>
          {!schedules.length && <p className="text-sm text-muted-foreground">Add reading times and you'll get a notification, e.g. weekdays at 21:00, 30 minutes with a specific book.</p>}
          <div className="space-y-2">
            {schedules.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2.5 text-[13px]">
                <Bell className="h-4 w-4 text-muted-foreground" />
                <input type="time" value={s.time} onChange={(e) => saveSchedule({ ...s, time: e.target.value })} className="h-7 rounded-md border bg-background px-2" />
                <div className="flex gap-0.5">
                  {DAYS.map((d, i) => (
                    <button key={d} onClick={() => saveSchedule({ ...s, weekdays: s.weekdays ^ (1 << i) })} aria-pressed={!!(s.weekdays & (1 << i))}
                      className={`h-7 w-9 rounded text-xs cursor-pointer ${s.weekdays & (1 << i) ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"}`}>{d}</button>
                  ))}
                </div>
                <DurationInput minutes={s.minutes} min={5} onCommit={(m) => m !== s.minutes && saveSchedule({ ...s, minutes: m || 30 })} className="w-32" />
                <select value={s.book_id ?? ""} onChange={(e) => saveSchedule({ ...s, book_id: e.target.value ? Number(e.target.value) : null })} className="h-7 max-w-56 rounded-md border bg-background px-1 text-xs">
                  <option value="">Any book</option>
                  {books.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
                </select>
                <label className="ml-auto flex items-center gap-1 text-xs"><input type="checkbox" checked={s.enabled} onChange={(e) => saveSchedule({ ...s, enabled: e.target.checked })} /> On</label>
                <button onClick={async () => { if (!(await askConfirm({ title: "Delete this reading time?", okLabel: "Delete", destructive: true }))) return; await tracker.deleteSchedule(s.id); load(); }} className="text-muted-foreground hover:text-destructive cursor-pointer" aria-label="Delete schedule"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-base font-semibold">Time per book</h2>
          {!stats.books.length && <p className="text-sm text-muted-foreground">Read for a few minutes and your sessions will appear here.</p>}
          <div className="space-y-1.5">
            {stats.books.map((b) => {
              const left = timeLeft(b.percent, b.sec_per_percent);
              return (
                <button key={b.book_id} onClick={() => openBook(b.book_id, b.title)} onMouseEnter={() => setHoverBook(b.book_id)} onMouseLeave={() => setHoverBook(null)}
                  className="grid w-full grid-cols-[minmax(0,14rem)_1fr_auto] items-center gap-3 rounded px-1 py-1 text-left text-[13px] hover:bg-secondary/60 cursor-pointer">
                  <span className="truncate">{b.title}</span>
                  <span className="h-3 rounded-r-[4px] bg-primary" style={{ width: `${(b.seconds / maxBook) * 100}%`, minWidth: 3, opacity: hoverBook === null || hoverBook === b.book_id ? 1 : 0.45 }} />
                  <span className="w-56 text-right text-xs tabular-nums text-muted-foreground">
                    {fmtDuration(b.seconds)} · {Math.round(b.percent * 100)}%{left ? ` · ~${fmtDuration(left)} left` : ""}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
