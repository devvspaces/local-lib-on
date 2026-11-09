import { describe, expect, it } from "vitest";
import { autoCloze, cardFromAnnotation, cardsFromMarkdown, clozeBack, clozeFront, makeCloze } from "./cards";
import type { Annotation } from "./api";

describe("cloze", () => {
  it("makes and renders clozes", () => {
    const c = makeCloze("Raft elects a leader using randomized timeouts", "randomized timeouts")!;
    expect(c).toBe("Raft elects a leader using {{c1::randomized timeouts}}");
    expect(clozeFront(c)).toBe("Raft elects a leader using […]");
    expect(clozeBack(c)).toBe("Raft elects a leader using **randomized timeouts**");
    expect(autoCloze("The protocol was designed by Leslie Lamport in 1989")).toContain("{{c1::Lamport}}");
  });
  it("builds cards from annotations and Q/A notes", () => {
    const a = { id: "x", kind: "highlight", text: "Quorum reads require overlapping majorities", comment: "Why do quorums overlap?", page_label: "12" } as Annotation;
    expect(cardFromAnnotation(a, "DDIA")).toEqual({ front: "Why do quorums overlap?", back: "Quorum reads require overlapping majorities\n\n— DDIA, p. 12" });
    expect(cardsFromMarkdown("Q: What is CAP?\nA: Consistency, availability, partition tolerance.\n\nQ: Two?\nA: Yes")).toHaveLength(2);
  });
});
