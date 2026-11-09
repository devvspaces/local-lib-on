import { invoke } from "@tauri-apps/api/core";

export type GoalKind = "daily_minutes" | "weekly_minutes" | "yearly_books" | "daily_pages" | "daily_reviews";
export interface Goal { id: number; kind: GoalKind; target: number; active: boolean }
export interface Schedule { id: number; label: string; weekdays: number; time: string; book_id: number | null; minutes: number; enabled: boolean }
export interface DetailedStats {
  days: { date: string; seconds: number }[];
  books: { book_id: number; title: string; seconds: number; percent: number; sessions: number; sec_per_percent: number | null }[];
  today_seconds: number; week_seconds: number; total_seconds: number; finished_this_year: number; finished_total: number;
  current_streak: number; longest_streak: number;
  goals: { kind: GoalKind; target: number; current: number }[];
}

export const tracker = {
  stats: () => invoke<DetailedStats>("detailed_stats"),
  goals: () => invoke<Goal[]>("list_goals"),
  saveGoal: (goal: Goal) => invoke<number>("save_goal", { goal }),
  deleteGoal: (id: number) => invoke<void>("delete_goal", { id }),
  schedules: () => invoke<Schedule[]>("list_schedules"),
  saveSchedule: (schedule: Schedule) => invoke<number>("save_schedule", { schedule }),
  deleteSchedule: (id: number) => invoke<void>("delete_schedule", { id }),
  getKv: (key: string) => invoke<string | null>("get_kv", { key }),
  setKv: (key: string, value: string) => invoke<void>("set_kv", { key, value }),
  testNotification: () => invoke<void>("test_notification"),
};

export const GOAL_LABEL: Record<GoalKind, string> = {
  daily_minutes: "Reading time per day",
  weekly_minutes: "Reading time per week",
  yearly_books: "Books this year",
  daily_pages: "Pages per day",
  daily_reviews: "Flashcard reviews per day",
};

export const fmtDuration = (s: number) => {
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ""}`.trim();
};

/** Estimated time left from this book's own pace (seconds per 1% read). */
export const timeLeft = (percent: number, secPerPercent: number | null) =>
  secPerPercent && percent < 1 ? Math.round((1 - percent) * 100 * secPerPercent) : null;

/** Goal kinds whose target is a duration (stored in minutes). */
export const isTimeGoal = (k: GoalKind) => k === "daily_minutes" || k === "weekly_minutes";
/** 90 → "1 h 30 min", 45 → "45 min", 120 → "2 h". */
export function fmtMinutes(m: number) {
  const h = Math.floor(m / 60), r = Math.round(m % 60);
  return h ? (r ? `${h} h ${r} min` : `${h} h`) : `${r} min`;
}
