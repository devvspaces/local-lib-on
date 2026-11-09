import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { occlusionCards, visibleMasks, type OcclusionMedia } from "./cards";

const base = { image: "a".repeat(64) + ".png", w: 400, h: 300, masks: [[0.1, 0.1, 0.2, 0.1], [0.5, 0.5, 0.2, 0.1], [0.7, 0.2, 0.1, 0.1]] as OcclusionMedia["masks"], mode: "one" as const };

describe("image occlusion", () => {
  it("makes one card per mask with the right target", () => {
    const cards = occlusionCards(base, "Database Internals · p. 42");
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.media.target)).toEqual([0, 1, 2]);
    expect(cards[1].front).toBe("Database Internals · p. 42 · label 2 of 3");
    expect(JSON.parse(JSON.stringify(cards[2].media))).toEqual({ ...base, target: 2 });
  });
  it("hide-one shows only the target box; hide-all hides every box until reveal", () => {
    const one = { ...base, target: 1 };
    expect(visibleMasks(one, false).map((m) => [m.i, m.hidden])).toEqual([[1, true]]);
    expect(visibleMasks(one, true).map((m) => [m.i, m.hidden])).toEqual([[1, false]]);
    const all = { ...base, target: 1, mode: "all" as const };
    expect(visibleMasks(all, false).map((m) => m.i)).toEqual([0, 1, 2]);
    expect(visibleMasks(all, true).filter((m) => m.hidden).map((m) => m.i)).toEqual([0, 2]);
  });
});
