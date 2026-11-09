import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { behind, buildPlan, packDays, rollForward, secondsPerUnit, studyDates, toPieces, type PlanBook } from "./studyPlan";

const book = (secPerUnit = 120): PlanBook => ({
  book_id: 7, title: "DDIA", secPerUnit,
  chapters: [
    { label: "Ch 1", unit: "p", from: 1, to: 10 },   // 20 min
    { label: "Ch 2", unit: "p", from: 11, to: 20 },  // 20 min
    { label: "Ch 3", unit: "p", from: 21, to: 60 },  // 80 min → split
    { label: "Ch 4", unit: "p", from: 61, to: 70 },  // 20 min
  ],
});

describe("study plan", () => {
  it("only uses the chosen weekdays (bit 0 = Monday)", () => {
    // 2026-11-09 is a Monday. Mon/Wed/Fri = 0b10101.
    expect(studyDates("2026-11-09", 0b0010101, 4)).toEqual(["2026-11-09", "2026-11-11", "2026-11-13", "2026-11-16"]);
  });
  it("splits long chapters and packs days within budget", () => {
    const pieces = toPieces([book()], 30);
    expect(pieces.filter((p) => p.label.startsWith("Ch 3"))).toHaveLength(3);
    for (const day of packDays(pieces, 30)) expect(day.reduce((n, p) => n + p.minutes, 0)).toBeLessThanOrEqual(36);
  });
  it("respects chapter boundaries and adds review days", () => {
    const { days } = buildPlan([book()], { minutesPerDay: 40, weekdays: 127, reviewEvery: 4, startDate: "2026-11-09" });
    const reads = days.filter((d) => d.kind === "read");
    expect(reads[0]).toMatchObject({ from: 1, to: 20, minutes: 40 });
    expect(reads.every((d, i) => i === 0 || d.from! === reads[i - 1].to! + 1)).toBe(true);
    expect(reads[reads.length - 1].to).toBe(70);
    expect(days.some((d) => d.kind === "review")).toBe(true);
    expect(days.map((d) => d.date)).toEqual([...days.map((d) => d.date)].sort());
  });
  it("derives the daily budget from a target date", () => {
    const { budget, days } = buildPlan([book()], { targetDate: "2026-11-12", weekdays: 127, reviewEvery: 0, startDate: "2026-11-09" });
    expect(budget).toBe(35); // 140 min over 4 days
    expect(days[days.length - 1].date <= "2026-11-13").toBe(true);
  });
  it("rolls missed days forward", () => {
    const { days } = buildPlan([book()], { minutesPerDay: 40, weekdays: 127, reviewEvery: 0, startDate: "2026-11-09" });
    days[0].done_at = "2026-11-09T20:00:00Z";
    expect(behind(days, "2026-11-12")).toBe(true);
    const r = rollForward(days, "2026-11-12", 127);
    expect(r[0].date).toBe("2026-11-09");
    expect(r[1]).toMatchObject({ date: "2026-11-12", from: days[1].from });
    expect(behind(r, "2026-11-12")).toBe(false);
  });
  it("estimates speed from history or falls back", () => {
    expect(secondsPerUnit(600, 300, "p")).toBe(200);
    expect(secondsPerUnit(null, 300, "p")).toBe(120);
  });
});
