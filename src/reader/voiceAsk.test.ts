import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
import { forSpeech } from "./voiceAsk";

describe("voice answers", () => {
  it("strips markdown and citations before speaking", () => {
    expect(forSpeech("**Latch crabbing** acquires latches top-down [1, 2]. See [docs](https://x.y) — `code`.")).toBe("Latch crabbing acquires latches top-down. See docs — code.");
  });
});
