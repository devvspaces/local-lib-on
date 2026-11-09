import { describe, expect, it } from "vitest";
import { isJunkAuthor, sniffIdentifiers, titleSimilarity } from "./metadataLookup";

describe("sniffIdentifiers", () => {
  it("reads a copyright page", () => {
    const t = `Fundamentals of Software Architecture, Second Edition by Mark Richards and Neal Ford
Copyright © 2025 Mark Richards and Neal Ford. All rights reserved.
Published by O’Reilly Media, Inc., 1005 Gravenstein Highway North, Sebastopol, CA 95472.
ISBN: 978-1-098-17551-1
978-1-098-17547-4 [LSI]`;
    const s = sniffIdentifiers(t);
    expect(s.isbns).toEqual(["9781098175511", "9781098175474"]);
    expect(s.edition).toBe("Second Edition");
    expect(s.publisher).toBe("O'Reilly");
    expect(s.place).toBe("Sebastopol");
    expect(s.year).toBe(2025);
  });
  it("rejects invalid ISBN checksums", () => {
    expect(sniffIdentifiers("ISBN 978-1-098-17551-2").isbns).toEqual([]);
  });
});

describe("helpers", () => {
  it("filters junk authors", () => {
    expect(isJunkAuthor("Windows User")).toBe(true);
    expect(isJunkAuthor("Microsoft Office User")).toBe(true);
    expect(isJunkAuthor("Neal Ford")).toBe(false);
  });
  it("scores titles", () => {
    expect(titleSimilarity("Fundamentals of Software Architecture: A Modern Engineering Approach", "Fundamentals of software architecture")).toBe(1);
    expect(titleSimilarity("Kubernetes in Action", "Kubernetes Patterns")).toBeLessThan(0.85);
  });
});
