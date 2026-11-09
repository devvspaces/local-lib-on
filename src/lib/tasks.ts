// Visible background tasks: anything a click starts that takes more than a moment shows a sticky spinner toast
// (with stage text / progress) until it finishes, and can't be started twice at once.
import { create } from "zustand";

export interface Task { id: string; title: string; detail?: string; progress?: number; status: "running" | "done" | "error"; result?: string }
export interface TaskUpdate { detail?: string; progress?: number; title?: string }

export const useTasks = create<{ tasks: Task[] }>(() => ({ tasks: [] }));

const patch = (id: string, p: Partial<Task>) => useTasks.setState((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...p } : t)) }));
export const dismissTask = (id: string) => useTasks.setState((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
export const isTaskRunning = (id: string) => useTasks.getState().tasks.some((t) => t.id === id && t.status === "running");

/** Run `fn` as a visible task. Returns its value, or `undefined` if a task with this id is already running
 *  (the duplicate click is ignored). `fn` may return `{ done: "message" }`-style text via `opts.doneText`.
 *  Errors are shown in the toast and re-thrown only when `opts.rethrow` is set. */
export async function runTask<T>(
  id: string,
  title: string,
  fn: (update: (u: TaskUpdate) => void) => Promise<T>,
  opts: { doneText?: (v: T) => string | null; errorTitle?: string; rethrow?: boolean; linger?: number } = {},
): Promise<T | undefined> {
  if (isTaskRunning(id)) return undefined;
  useTasks.setState((s) => ({ tasks: [...s.tasks.filter((t) => t.id !== id), { id, title, status: "running" }] }));
  const finish = (p: Partial<Task>, ms: number) => {
    patch(id, p);
    setTimeout(() => { if (useTasks.getState().tasks.find((t) => t.id === id)?.status !== "running") dismissTask(id); }, ms);
  };
  try {
    const v = await fn((u) => patch(id, u));
    const text = opts.doneText ? opts.doneText(v) : null;
    if (text === null && opts.doneText) dismissTask(id); // caller shows its own UI (e.g. a confirm dialog)
    else finish({ status: "done", result: text ?? undefined, progress: undefined }, opts.linger ?? 3000);
    return v;
  } catch (e) {
    finish({ status: "error", title: opts.errorTitle ?? `${title} failed`, result: String(e).replace(/^Error: /, ""), progress: undefined }, 7000);
    if (opts.rethrow) throw e;
    return undefined;
  }
}

/** For buttons: true while the task is running (spin + disable). */
export const useTaskRunning = (id: string) => useTasks((s) => s.tasks.some((t) => t.id === id && t.status === "running"));
