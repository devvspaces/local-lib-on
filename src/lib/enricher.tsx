import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { api } from "@/lib/api";
import { enrichBook } from "@/lib/enrich";
import { useApp } from "@/store/app";

import { runTask } from "@/lib/tasks";

// Callers of "Retrieve metadata" wait for their books to come through the queue.
const waiters = new Map<number, ((ok: boolean) => void)[]>();
const settle = (id: number, ok: boolean) => { waiters.get(id)?.forEach((f) => f(ok)); waiters.delete(id); };
const waitFor = (id: number) => new Promise<boolean>((r) => waiters.set(id, [...(waiters.get(id) ?? []), r]));

/** Re-run metadata/cover retrieval for these books as a visible task (spinner + progress until they're done). */
export async function retrieveMetadata(books: { id: number; title: string }[]) {
  if (!books.length) return;
  const key = books.length === 1 ? `enrich:${books[0].id}` : `enrich:${books.map((b) => b.id).join(",")}`;
  return runTask(key, books.length === 1 ? "Retrieving metadata" : `Retrieving metadata for ${books.length} books`, async (update) => {
    update({ detail: books.length === 1 ? books[0].title : "Queued…", progress: books.length > 1 ? 0 : undefined });
    const waits = books.map((b) => waitFor(b.id));
    await api.resetEnriched(books.map((b) => b.id));
    let n = 0, ok = 0;
    await Promise.all(waits.map((w) => w.then((r) => { n++; if (r) ok++; if (books.length > 1) update({ detail: `${n} of ${books.length}`, progress: n / books.length }); })));
    useApp.getState().bumpLibrary();
    return ok;
  }, { doneText: (ok) => (books.length === 1 ? (ok ? `${books[0].title} updated` : "Couldn't read this file") : `${ok} of ${books.length} updated`) });
}

export const useEnrichStatus = create<{ done: number; total: number; current: string | null }>(() => ({ done: 0, total: 0, current: null }));

/** Background "Retrieve metadata" for every book: covers + bibliographic data without opening books. */
export function BackgroundEnricher() {
  const { libraryVersion, bumpLibrary } = useApp();
  const running = useRef(false);
  const kick = useRef(0);

  useEffect(() => {
    let un: (() => void) | undefined, dead = false;
    listen("enrich_requested", () => { kick.current++; run(); }).then((f) => (dead ? f() : (un = f)));
    return () => { dead = true; un?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async () => {
    if (running.current) return;
    running.current = true;
    const startKick = kick.current;
    const failed = new Set<number>();
    let done = 0;
    try {
      while (true) {
        const ids = (await api.unenrichedBooks().catch(() => [])).filter((i) => !failed.has(i));
        if (!ids.length) break;
        useEnrichStatus.setState({ total: done + ids.length, done });
        const book = await api.getBook(ids[0]).catch(() => null);
        if (!book) { failed.add(ids[0]); settle(ids[0], false); continue; }
        useEnrichStatus.setState({ current: book.title });
        try {
          settle(book.id, await enrichBook(book));
        } catch (e) {
          settle(book.id, false);
          console.warn("[enricher]", book.title, e);
          await api.updateBook(book.id, { only_missing: true }).catch(() => {}); // mark attempted
          failed.add(book.id);
        }
        done++;
        if (done % 3 === 0) bumpLibrary();
        await new Promise((r) => setTimeout(r, 150));
      }
    } finally {
      running.current = false;
      useEnrichStatus.setState({ done, total: done, current: null });
      if (done) bumpLibrary();
      // A request that arrived after the last queue check would otherwise wait for the next library change.
      if (kick.current !== startKick) setTimeout(run, 0);
    }
  };

  useEffect(() => {
    const t = setTimeout(run, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryVersion]);
  return null;
}
