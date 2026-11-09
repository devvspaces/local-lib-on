import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { _pending, askConfirm, askText } from "./prompt";

describe("in-app dialogs", () => {
  it("queue requests as promises", () => {
    const before = _pending();
    void askText({ title: "New collection" });
    void askConfirm({ title: "Delete?" });
    expect(_pending()).toBe(before + 2);
  });

  it("no code calls window.prompt / window.confirm (they don't work in the Tauri webview)", () => {
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)) {
          readFileSync(p, "utf8").split("\n").forEach((l, i) => { if (/(^|[^\w.])(window\.)?(prompt|confirm)\(/.test(l)) bad.push(`${p}:${i + 1}`); });
        }
      }
    };
    walk(join(__dirname, "../.."));
    expect(bad).toEqual([]);
  });
});
