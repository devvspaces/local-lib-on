import { useCallback, useEffect, useRef } from "react";
import { api, type Locator, type ReaderSettings } from "@/lib/api";
import type { LocationInfo } from "./types";

/**
 * Remembers where you stopped: debounced progress saves, flush on hide/close,
 * plus reading-session logging (time read, start→end percent) for stats.
 */
export function useReaderSession(bookId: number, active: boolean) {
  const last = useRef<{ locator: Locator; percent: number } | null>(null);
  const pendingSettings = useRef<ReaderSettings | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const session = useRef<{ start: Date; startPct: number; activeMs: number; since: number | null; pages: Set<number> } | null>(null);

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    if (!last.current && !pendingSettings.current) return;
    api.saveProgress({
      book_id: bookId,
      locator: last.current?.locator ?? null,
      percent: last.current?.percent ?? 0,
      settings: pendingSettings.current,
    }).catch(console.error);
    pendingSettings.current = null;
  }, [bookId]);

  const onLocation = useCallback((l: LocationInfo) => {
    last.current = { locator: l.locator, percent: l.percent };
    if (!session.current) session.current = { start: new Date(), startPct: l.percent, activeMs: 0, since: Date.now(), pages: new Set() };
    if (l.page) session.current.pages.add(l.page);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 800);
  }, [flush]);

  const saveSettings = useCallback((s: ReaderSettings) => {
    pendingSettings.current = s;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 500);
  }, [flush]);

  const endSession = useCallback(() => {
    const s = session.current;
    if (!s) return;
    const ms = s.activeMs + (s.since ? Date.now() - s.since : 0);
    session.current = null;
    if (ms > 5000) api.logSession(bookId, s.start.toISOString(), Math.round(ms / 1000), s.startPct, last.current?.percent ?? s.startPct, Math.max(0, s.pages.size - 1)).catch(() => {});
  }, [bookId]);

  // Pause the clock when tab inactive / window hidden; idle > 5 min also pauses.
  useEffect(() => {
    const s = session.current;
    if (!s) return;
    if (active && !document.hidden) s.since ??= Date.now();
    else if (s.since) { s.activeMs += Date.now() - s.since; s.since = null; }
  }, [active]);

  useEffect(() => {
    const vis = () => {
      const s = session.current;
      if (document.hidden) { flush(); if (s?.since) { s.activeMs += Date.now() - s.since; s.since = null; } }
      else if (s && active) s.since = Date.now();
    };
    const unload = () => { flush(); endSession(); };
    document.addEventListener("visibilitychange", vis);
    window.addEventListener("beforeunload", unload);
    return () => {
      document.removeEventListener("visibilitychange", vis);
      window.removeEventListener("beforeunload", unload);
      unload();
    };
  }, [flush, endSession, active]);

  return { onLocation, saveSettings, flush };
}
