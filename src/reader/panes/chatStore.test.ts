import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/tracker", () => ({ tracker: { getKv: vi.fn(), setKv: vi.fn() } }));
import { compactHistory, parseChat, serializeChat } from "./chatStore";

const hist = [
  { role: "user", content: [{ type: "text", text: "q1" }] },
  { role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(1000), signature: "s" }, { type: "text", text: "a1" }] },
  { role: "user", content: [{ type: "text", text: "q2" }] },
  { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s2" }, { type: "text", text: "a2" }] },
];

describe("assistant chat persistence", () => {
  it("drops thinking from completed turns only", () => {
    const h = compactHistory(hist) as { content: { type: string }[] }[];
    expect(h[1].content.map((b) => b.type)).toEqual(["text"]);
    expect(h[3].content[0].type).toBe("thinking");
  });
  it("round-trips, clears streaming flags and caps turns", () => {
    const turns = Array.from({ length: 30 }, (_, i) => ({ user: `q${i}`, streaming: i === 29 }));
    const c = parseChat<{ user: string; streaming?: boolean }>(serializeChat(turns, { provider: "anthropic:m", messages: hist }, "book", "research"))!;
    expect(c.turns).toHaveLength(20);
    expect(c.turns[19]).toMatchObject({ user: "q29", streaming: false });
    expect(c.history.provider).toBe("anthropic:m");
    expect(parseChat("garbage")).toBeNull();
    expect(parseChat("")).toBeNull();
  });
});
