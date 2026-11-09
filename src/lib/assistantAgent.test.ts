import { describe, expect, it } from "vitest";
import { AGENT_SYSTEM, agentContext, linkAgentCitations } from "./assistant";

describe("agent helpers", () => {
  it("links book:page citations", () => {
    const h = linkAgentCitations("<p>Quorums overlap [12:p.40] and logs [3:s.2].</p>", (id) => (id === 12 ? "DDIA" : undefined));
    expect(h).toContain('href="open://12/p40"');
    expect(h).toContain('title="DDIA, p. 40"');
    expect(h).toContain('href="open://3/s2"');
  });
  it("puts reading context in the user turn and keeps the system prompt fixed", () => {
    // Thinking blocks are bound to the system prompt — it must not vary with page/selection.
    expect(typeof AGENT_SYSTEM).toBe("string");
    expect(AGENT_SYSTEM).not.toContain("book_id 7");
    const a = agentContext({ bookId: 7, title: "SRE", page: "p. 12", selection: "error budgets" });
    const b = agentContext({ bookId: 7, title: "SRE", page: "p. 40" });
    expect(a).toContain("book_id 7");
    expect(a).toContain("error budgets");
    expect(a).not.toEqual(b);
    expect(agentContext({})).toBe("");
  });
});
