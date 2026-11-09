// Tiny event bus so any reader surface can push content into the open notebook pane.
type Ev = { type: "insert"; markdown: string };
const subs = new Set<(e: Ev) => void>();
export const notebookBus = {
  emit: (e: Ev) => subs.forEach((f) => f(e)),
  on: (f: (e: Ev) => void) => { subs.add(f); return () => { subs.delete(f); }; },
};
