import { describe, expect, it } from "vitest";
import { isTaskRunning, runTask, useTasks } from "./tasks";

describe("runTask", () => {
  it("shows a running task, ignores duplicates and finishes", async () => {
    let release!: (v: number) => void;
    const p = runTask("t1", "Working", (u) => { u({ detail: "step 1" }); return new Promise<number>((r) => (release = r)); }, { doneText: (v) => `got ${v}` });
    expect(isTaskRunning("t1")).toBe(true);
    expect(useTasks.getState().tasks.find((t) => t.id === "t1")?.detail).toBe("step 1");
    expect(await runTask("t1", "Working", async () => 2)).toBeUndefined(); // duplicate click
    release(7);
    expect(await p).toBe(7);
    const t = useTasks.getState().tasks.find((x) => x.id === "t1");
    expect(t?.status).toBe("done");
    expect(t?.result).toBe("got 7");
  });

  it("reports errors without throwing", async () => {
    const v = await runTask("t2", "Fetch", async () => { throw new Error("offline"); });
    expect(v).toBeUndefined();
    const t = useTasks.getState().tasks.find((x) => x.id === "t2");
    expect(t?.status).toBe("error");
    expect(t?.result).toBe("offline");
  });

  it("removes the toast when doneText returns null (caller takes over)", async () => {
    await runTask("t3", "Identify", async () => 1, { doneText: () => null });
    expect(useTasks.getState().tasks.some((x) => x.id === "t3")).toBe(false);
  });
});
