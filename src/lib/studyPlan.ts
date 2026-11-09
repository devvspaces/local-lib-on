// Study plans: split the remaining chapters of one or more books into daily reading assignments that fit a
// time budget, with periodic review days. Pure functions (unit tested); storage via plans_* commands.
import { invoke } from "@tauri-apps/api/core";

export interface PlanChapter { label: string; unit: "p" | "s"; from: number; to: number }
export interface PlanBook { book_id: number; title: string; chapters: PlanChapter[]; secPerUnit: number }
export interface PlanDay {
  date: string; // YYYY-MM-DD
  kind: "read" | "review";
  book_id?: number;
  unit?: "p" | "s";
  from?: number;
  to?: number;
  label: string;
  minutes: number;
  focus?: string;
  done_at?: string | null;
}
export interface PlanSettings { books: { book_id: number; title: string }[]; minutesPerDay?: number; targetDate?: string; weekdays: number; reviewEvery: number; startDate: string }
export interface StudyPlan { id: string; title: string; settings: PlanSettings; days: PlanDay[]; active: boolean; updated_at?: string }

export const plansApi = {
  list: () => invoke<StudyPlan[]>("plans_list"),
  save: (plan: Omit<StudyPlan, "id"> & { id?: string }) => invoke<string>("plans_save", { plan: { id: "", ...plan } }),
  remove: (id: string) => invoke<void>("plans_delete", { id }),
};

// ── Dates (local calendar days) ──
export const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parseDay = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s: string, n: number) => { const d = parseDay(s); d.setDate(d.getDate() + n); return isoDay(d); };
/** Bit 0 = Monday … bit 6 = Sunday (same as reading schedules). */
const weekdayBit = (s: string) => 1 << ((parseDay(s).getDay() + 6) % 7);
export function studyDates(start: string, weekdays: number, count: number): string[] {
  const out: string[] = [];
  const mask = weekdays & 127 || 127;
  for (let d = start; out.length < count; d = addDays(d, 1)) if (mask & weekdayBit(d)) out.push(d);
  return out;
}
export function studyDatesUntil(start: string, end: string, weekdays: number): string[] {
  const out: string[] = [];
  const mask = weekdays & 127 || 127;
  for (let d = start; d <= end && out.length < 3660; d = addDays(d, 1)) if (mask & weekdayBit(d)) out.push(d);
  return out;
}

/** Reading speed (seconds per page/section) from tracker stats, with sensible fallbacks. */
export function secondsPerUnit(secPerPercent: number | null | undefined, units: number, unit: "p" | "s") {
  if (secPerPercent && units > 0) return Math.min(1800, Math.max(20, (secPerPercent * 100) / units));
  return unit === "p" ? 120 : 600;
}

interface Piece { book_id: number; title: string; unit: "p" | "s"; from: number; to: number; label: string; minutes: number }

/** Chapters → pieces no longer than ~1.2× the budget (long chapters are split by pages/sections). */
export function toPieces(books: PlanBook[], budget: number): Piece[] {
  const out: Piece[] = [];
  for (const b of books) {
    for (const c of b.chapters) {
      const units = c.to - c.from + 1;
      const minutes = (units * b.secPerUnit) / 60;
      if (minutes <= budget * 1.2 || units <= 1) { out.push({ book_id: b.book_id, title: b.title, unit: c.unit, from: c.from, to: c.to, label: c.label, minutes }); continue; }
      const parts = Math.ceil(minutes / budget);
      const per = Math.ceil(units / parts);
      for (let i = 0, a = c.from; a <= c.to; i++, a += per) {
        const z = Math.min(c.to, a + per - 1);
        out.push({ book_id: b.book_id, title: b.title, unit: c.unit, from: a, to: z, label: `${c.label} (${i + 1}/${parts})`, minutes: ((z - a + 1) * b.secPerUnit) / 60 });
      }
    }
  }
  return out;
}

const rangeText = (unit: "p" | "s", from: number, to: number) => (unit === "p" ? `pp. ${from}–${to}` : `sections ${from + 1}–${to + 1}`);

/** Greedy daily packing: fill each study day up to the budget (never more than +20%), at least one piece per day. */
export function packDays(pieces: Piece[], budget: number): Piece[][] {
  const days: Piece[][] = [];
  let cur: Piece[] = [];
  let t = 0;
  for (const p of pieces) {
    const sameBook = !cur.length || cur[cur.length - 1].book_id === p.book_id;
    if (cur.length && (!sameBook || t + p.minutes > budget * 1.2 || t >= budget * 0.85)) { days.push(cur); cur = []; t = 0; }
    cur.push(p);
    t += p.minutes;
  }
  if (cur.length) days.push(cur);
  return days;
}

/** Build the plan days. With a target date the daily budget is derived from it; otherwise `minutesPerDay`. */
export function buildPlan(books: PlanBook[], s: Omit<PlanSettings, "books">): { days: PlanDay[]; budget: number } {
  const total = books.reduce((n, b) => n + b.chapters.reduce((m, c) => m + ((c.to - c.from + 1) * b.secPerUnit) / 60, 0), 0);
  let budget = Math.max(10, s.minutesPerDay ?? 30);
  if (s.targetDate) {
    const avail = studyDatesUntil(s.startDate, s.targetDate, s.weekdays).length;
    const readDays = Math.max(1, avail - (s.reviewEvery > 1 ? Math.floor(avail / s.reviewEvery) : 0));
    budget = Math.max(10, Math.ceil(total / readDays));
  }
  const packed = packDays(toPieces(books, budget), budget);
  const days: Omit<PlanDay, "date">[] = [];
  for (const [i, group] of packed.entries()) {
    if (s.reviewEvery > 1 && i > 0 && i % (s.reviewEvery - 1) === 0) {
      days.push({ kind: "review", label: "Review: flashcards and notes from recent chapters", minutes: 15 });
    }
    const first = group[0], last = group[group.length - 1];
    const labels = group.map((g) => g.label);
    days.push({
      kind: "read", book_id: first.book_id, unit: first.unit, from: first.from, to: last.to,
      label: `${labels.length > 2 ? `${labels[0]} → ${labels[labels.length - 1]}` : labels.join(" · ")} (${rangeText(first.unit, first.from, last.to)})`,
      minutes: Math.round(group.reduce((n, g) => n + g.minutes, 0)),
    });
  }
  const dates = studyDates(s.startDate, s.weekdays, days.length);
  return { days: days.map((d, i) => ({ ...d, date: dates[i], done_at: null })), budget };
}

/** Move unfinished days that fell behind onto the next study dates from `today`, keeping their order. */
export function rollForward(days: PlanDay[], today: string, weekdays: number): PlanDay[] {
  const done = days.filter((d) => d.done_at);
  const open = days.filter((d) => !d.done_at);
  const dates = studyDates(today, weekdays, open.length);
  return [...done, ...open.map((d, i) => ({ ...d, date: dates[i] }))].sort((a, b) => a.date.localeCompare(b.date) || Number(!!b.done_at) - Number(!!a.done_at));
}

export const behind = (days: PlanDay[], today: string) => days.some((d) => !d.done_at && d.date < today);
export const todayItems = (days: PlanDay[], today: string) => days.filter((d) => d.date === today);
export const progress = (days: PlanDay[]) => { const r = days.filter((d) => d.kind === "read"); return r.length ? r.filter((d) => d.done_at).length / r.length : 0; };
