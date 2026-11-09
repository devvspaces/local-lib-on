import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { LibraryFilter } from "@/lib/api";

export type AppView = "library" | "reader" | "discover" | "sync" | "downloads" | "stats" | "review" | "notebook" | "search" | "settings";

export interface ReaderTab {
  key: string; // unique per open tab
  bookId: number;
  title: string;
  /** Jump target requested by search results / annotation links. Consumed by the reader. */
  jump?: { page?: number; cfi?: string; loc?: string; query?: string; nonce: number };
}

export type PaneKind = "notebook" | "lookup" | "book" | "annotations" | "assistant";

interface AppStore {
  view: AppView;
  setView: (v: AppView) => void;

  filter: LibraryFilter;
  setFilter: (f: LibraryFilter) => void;
  patchFilter: (f: Partial<LibraryFilter>) => void;
  libraryLayout: "grid" | "list";
  setLibraryLayout: (l: "grid" | "list") => void;

  tabs: ReaderTab[];
  activeTab: string | null;
  openBook: (bookId: number, title: string, jump?: Omit<NonNullable<ReaderTab["jump"]>, "nonce">) => void;
  closeTab: (key: string) => void;
  setActiveTab: (key: string) => void;

  /** Right split pane in the reader. */
  /** bookId = book the pane belongs to; refBookId = second book shown side-by-side; linked = synced paging. */
  sidePane: { kind: PaneKind; bookId?: number; lookup?: string; refBookId?: number; linked?: boolean; ask?: { prompt: string; selection?: string; nonce: number } } | null;
  /** Which reader receives keyboard shortcuts (tab key or "side"). */
  focusedReader: string | null;
  setFocusedReader: (k: string | null) => void;
  setSidePane: (p: AppStore["sidePane"]) => void;

  libraryVersion: number;
  bumpLibrary: () => void;
}

export const useApp = create<AppStore>()(
  persist(
    (set, get) => ({
      view: "library",
      setView: (view) => set({ view }),

      filter: { sort: "added" },
      setFilter: (filter) => set({ filter }),
      patchFilter: (f) => set({ filter: { ...get().filter, ...f } }),
      libraryLayout: "grid",
      setLibraryLayout: (libraryLayout) => set({ libraryLayout }),

      tabs: [],
      activeTab: null,
      openBook: (bookId, title, jump) => {
        const existing = get().tabs.find((t) => t.bookId === bookId);
        const j = jump ? { ...jump, nonce: Date.now() } : undefined;
        if (existing) {
          set({
            tabs: get().tabs.map((t) => (t.key === existing.key ? { ...t, jump: j ?? t.jump } : t)),
            activeTab: existing.key,
            view: "reader",
          });
          return;
        }
        const key = `${bookId}-${Date.now()}`;
        set({ tabs: [...get().tabs, { key, bookId, title, jump: j }], activeTab: key, view: "reader" });
      },
      closeTab: (key) => {
        const tabs = get().tabs.filter((t) => t.key !== key);
        const activeTab = get().activeTab === key ? tabs[tabs.length - 1]?.key ?? null : get().activeTab;
        set({ tabs, activeTab, view: tabs.length ? get().view : "library" });
      },
      setActiveTab: (activeTab) => set({ activeTab, view: "reader" }),

      sidePane: null,
      setSidePane: (sidePane) => set({ sidePane }),
      focusedReader: null,
      setFocusedReader: (focusedReader) => set({ focusedReader }),

      libraryVersion: 0,
      bumpLibrary: () => set({ libraryVersion: get().libraryVersion + 1 }),
    }),
    {
      name: "local-lib-ui",
      partialize: (s) => ({ filter: s.filter, libraryLayout: s.libraryLayout, tabs: s.tabs.map(({ jump, ...t }) => t), activeTab: s.activeTab, sidePane: s.sidePane && { ...s.sidePane, ask: undefined } }),
    }
  )
);
