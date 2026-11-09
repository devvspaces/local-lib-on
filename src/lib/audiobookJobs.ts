// App-wide audiobook job state (fed by the Rust `audiobook_progress` event), shown in the Downloads tab.
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";

export interface AudiobookProgress {
  id: string; title: string; status: "preparing" | "rendering" | "encoding" | "done" | "error" | "cancelled"; stage?: string | null;
  chapter: number; chapters: number; percent: number; eta_seconds: number | null; audio_seconds: number; outputs: string[]; error: string | null;
}

export const useAudiobooks = create<{ jobs: AudiobookProgress[]; dismiss: (id: string) => void; add: (j: AudiobookProgress) => void }>((set) => ({
  jobs: [],
  // Shown the moment the job is accepted, before the first progress event arrives.
  add: (j) => set((s) => (s.jobs.some((x) => x.id === j.id) ? s : { jobs: [j, ...s.jobs] })),
  dismiss: (id) => set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) })),
}));

/** Mount once (Layout). */
export function listenAudiobooks() {
  const p = listen<AudiobookProgress>("audiobook_progress", (e) => {
    useAudiobooks.setState((s) => {
      const i = s.jobs.findIndex((j) => j.id === e.payload.id);
      const p = { ...e.payload, title: e.payload.title || (i >= 0 ? s.jobs[i].title : "") };
      return { jobs: i < 0 ? [p, ...s.jobs] : s.jobs.map((j, k) => (k === i ? p : j)) };
    });
  });
  return () => { p.then((f) => f()); };
}
