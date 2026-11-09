import { describe, expect, it } from "vitest";
import { splitSentences } from "./tts";

describe("splitSentences", () => {
  it("splits on sentence ends, not abbreviations or decimals", () => {
    const s = splitSentences("Dr. Smith measured 3.5 cm. It grew, e.g. by a lot! Did it? Yes. J. R. R. Tolkien wrote it.");
    expect(s).toEqual(["Dr. Smith measured 3.5 cm.", "It grew, e.g. by a lot!", "Did it? Yes.", "J. R. R. Tolkien wrote it."]);
  });
  it("joins hyphenated line breaks", () => {
    expect(splitSentences("A distri-\nbuted system. Next.")[0]).toBe("A distributed system.");
  });
});
