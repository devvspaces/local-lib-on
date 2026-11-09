// Broadcasts the main reader's page so a linked side-by-side reader can follow (translations, editions).
type Ev = { source: string; page: number; delta: number };
const subs = new Set<(e: Ev) => void>();
export const linkBus = {
  emit: (e: Ev) => subs.forEach((f) => f(e)),
  on: (f: (e: Ev) => void) => { subs.add(f); return () => { subs.delete(f); }; },
};
