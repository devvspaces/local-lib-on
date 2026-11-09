import { BookOpen, Library, NotebookPen, Search, Settings as SettingsIcon, X, Sun, Moon, Monitor, Compass, RefreshCcw, Download, BarChart3, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { useApp, type AppView } from "@/store/app";
import { useTheme } from "@/components/ThemeProvider";
import { useLibraryEvents } from "@/hooks/useLibraryEvents";
import { Toaster } from "@/components/ui/toast";
import { PromptHost } from "@/components/ui/prompt";
import { OcclusionEditor } from "@/views/review/OcclusionEditor";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LibraryView } from "@/views/library/LibraryView";
import { ReaderHost } from "@/reader/ReaderHost";
import { NotebookView } from "@/views/notebook/NotebookView";
import { SearchView } from "@/views/search/SearchView";
import { SettingsView } from "@/views/settings/SettingsView";
import { BackgroundIndexer } from "@/lib/indexer";
import { BackgroundEnricher, useEnrichStatus } from "@/lib/enricher";
import { DiscoverView } from "@/views/discover/DiscoverView";
import { SyncView } from "@/views/discover/SyncView";
import { DownloadsView } from "@/views/discover/DownloadsView";
import { StatsView } from "@/views/stats/StatsView";
import { ReviewView } from "@/views/review/ReviewView";
import { cardsApi } from "@/lib/cards";
import { listenForConnectorSaves } from "@/lib/connectorSave";
import { listenAudiobooks } from "@/lib/audiobookJobs";
import { startUpdateChecks } from "@/lib/updater";
import { useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { api } from "@/lib/api";

const NAV: { id: AppView; label: string; icon: typeof Library }[] = [
  { id: "library", label: "Library", icon: Library },
  { id: "search", label: "Search", icon: Search },
  { id: "discover", label: "Discover", icon: Compass },
  { id: "sync", label: "Sync", icon: RefreshCcw },
  { id: "downloads", label: "Downloads", icon: Download },
  { id: "notebook", label: "Notebook", icon: NotebookPen },
  { id: "review", label: "Review", icon: Layers },
  { id: "stats", label: "Reading", icon: BarChart3 },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];

export function Layout() {
  useLibraryEvents();
  const { view, setView, tabs, activeTab, setActiveTab, closeTab } = useApp();
  const { theme, setTheme } = useTheme();
  const openBook = useApp((s) => s.openBook);
  const [dueCards, setDueCards] = useState(0);
  useEffect(() => listenForConnectorSaves(), []);
  useEffect(() => listenAudiobooks(), []);
  useEffect(() => startUpdateChecks(), []);
  useEffect(() => {
    const tick = () => cardsApi.counts().then((c) => setDueCards(c.due + c.new)).catch(() => {});
    tick();
    const t = setInterval(tick, 60000);
    return () => clearInterval(t);
  }, [view]);
  // The assistant's open_page tool → jump the reader there.
  useEffect(() => {
    let un: (() => void) | undefined, dead = false;
    listen<{ book_id: number; page: number }>("assistant_open", async (e) => {
      const b = await api.getBook(e.payload.book_id).catch(() => null);
      if (b) openBook(b.id, b.title, { page: e.payload.page });
    }).then((f) => (dead ? f() : (un = f)));
    return () => { dead = true; un?.(); };
  }, [openBook]);
  // Reading reminder → open the scheduled book.
  useEffect(() => {
    let un: (() => void) | undefined, dead = false;
    listen<{ book_id: number | null }>("reading_reminder", async (e) => {
      if (e.payload.book_id) { const b = await api.getBook(e.payload.book_id); openBook(b.id, b.title); }
    }).then((f) => (dead ? f() : (un = f)));
    return () => { dead = true; un?.(); };
  }, [openBook]);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      {/* Top bar: app nav + open-book tabs */}
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-sidebar-border bg-sidebar pl-20 pr-2" data-tauri-drag-region>
        <nav className="flex items-center gap-0.5">
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => setView(n.id)}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium cursor-pointer transition-colors",
                view === n.id ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              )}
            >
              <n.icon className="h-3.5 w-3.5" />
              {n.label}
              {n.id === "review" && dueCards > 0 && <span className="rounded-full bg-primary px-1.5 text-[10px] leading-4 text-primary-foreground">{dueCards}</span>}
            </button>
          ))}
        </nav>
        <div className="mx-2 h-5 w-px bg-border" />
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto custom-scrollbar" data-tauri-drag-region>
          {tabs.map((t) => (
            <div
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              onAuxClick={(e) => e.button === 1 && closeTab(t.key)}
              className={cn(
                "group flex h-7 max-w-56 shrink-0 cursor-pointer items-center gap-1.5 rounded-md pl-2 pr-1 text-[13px]",
                view === "reader" && activeTab === t.key ? "bg-card shadow-sm border text-foreground" : "text-muted-foreground hover:bg-secondary"
              )}
              title={t.title}
            >
              <BookOpen className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{t.title}</span>
              <button
                onClick={(e) => (e.stopPropagation(), closeTab(t.key))}
                className="rounded p-0.5 opacity-50 hover:bg-secondary hover:opacity-100 cursor-pointer"
                aria-label="Close tab"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-0.5 rounded-md border bg-secondary/50 p-0.5">
          {([["light", Sun], ["dark", Moon], ["system", Monitor]] as const).map(([t, Icon]) => (
            <button key={t} onClick={() => setTheme(t)} aria-label={`${t} theme`} className={cn("rounded p-1 cursor-pointer", theme === t ? "bg-background text-foreground" : "text-muted-foreground hover:text-foreground")}>
              <Icon className="h-3 w-3" />
            </button>
          ))}
        </div>
      </header>

      <main className="relative min-h-0 flex-1">
        <ErrorBoundary label={`the ${view} view`} resetKey={view}>
        <div className={cn("absolute inset-0", view !== "library" && "hidden")}><LibraryView /></div>
        {/* Reader stays mounted so tabs keep their state while browsing the library */}
        <div className={cn("absolute inset-0", view !== "reader" && "hidden")}><ReaderHost /></div>
        {view === "search" && <div className="absolute inset-0"><SearchView /></div>}
        <div className={cn("absolute inset-0", view !== "discover" && "hidden")}><DiscoverView /></div>
        {view === "sync" && <div className="absolute inset-0"><SyncView /></div>}
        {view === "downloads" && <div className="absolute inset-0"><DownloadsView /></div>}
        {view === "review" && <div className="absolute inset-0"><ReviewView /></div>}
        {view === "stats" && <div className="absolute inset-0"><StatsView /></div>}
        {view === "notebook" && <div className="absolute inset-0"><NotebookView /></div>}
        {view === "settings" && <div className="absolute inset-0"><SettingsView /></div>}
        </ErrorBoundary>
      </main>
      <BackgroundIndexer />
      <BackgroundEnricher />
      <EnrichBadge />
      <Toaster />
      <PromptHost />
      <OcclusionEditor />
    </div>
  );
}

function EnrichBadge() {
  const { done, total, current } = useEnrichStatus();
  if (!current) return null;
  return (
    <div className="pointer-events-none fixed bottom-3 left-3 z-40 max-w-xs truncate rounded-md border bg-popover px-2.5 py-1 text-[11px] text-muted-foreground shadow">
      Retrieving metadata {done + 1}/{total} · {current}
    </div>
  );
}
