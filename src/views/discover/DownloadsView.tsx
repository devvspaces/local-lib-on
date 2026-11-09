import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { BookOpen, FolderOpen, Pause, Play, RotateCcw, X } from "lucide-react";
import { providers, type DownloadItem, type DownloadProgress } from "@/lib/providers";
import { useApp } from "@/store/app";
import { formatBytes, cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useAudiobooks } from "@/lib/audiobookJobs";
import { audiobookApi, fmtHms } from "@/reader/AudiobookDialog";
import { Headphones } from "lucide-react";

export function DownloadsView() {
  const [items, setItems] = useState<DownloadItem[]>([]);
  const [dir, setDir] = useState("");
  const openBook = useApp((s) => s.openBook);
  const { jobs, dismiss } = useAudiobooks();
  const load = () => providers.downloads().then(setItems);

  useEffect(() => {
    load();
    providers.getDownloadDir().then(setDir);
    let un: (() => void) | undefined, dead = false;
    listen<DownloadProgress>("download_progress", (e) => {
      const p = e.payload;
      setItems((list) => {
        if (!list.some((i) => i.id === p.id)) { load(); return list; }
        return list.map((i) => (i.id === p.id ? { ...i, status: p.status, bytes: p.bytes || i.bytes, total: p.total ?? i.total, error: p.error, book_id: p.book_id ?? i.book_id } : i));
      });
    }).then((f) => (dead ? f() : (un = f)));
    const t = setInterval(load, 5000);
    return () => { dead = true; un?.(); clearInterval(t); };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <h1 className="text-[15px] font-semibold">Downloads</h1>
        <span className="truncate text-xs text-muted-foreground" title={dir}>→ {dir}</span>
        <Button size="xs" variant="ghost" onClick={async () => { const d = await openDialog({ directory: true }); if (typeof d === "string") { await providers.setDownloadDir(d); setDir(d); } }}>Change…</Button>
        <Button size="xs" variant="outline" className="ml-auto" onClick={async () => { await providers.clearDownloads(); load(); }}>Clear finished</Button>
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {jobs.length > 0 && (
          <div className="divide-y border-b">
            {jobs.map((j) => {
              const active = j.status === "preparing" || j.status === "rendering" || j.status === "encoding";
              return (
                <div key={j.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="flex w-12 justify-center rounded bg-secondary py-0.5"><Headphones className="h-3.5 w-3.5" /></span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium">{j.title || "Audiobook"}</p>
                    <div className="mt-1 flex items-center gap-2">
                      <div className="h-1 flex-1 overflow-hidden rounded-full bg-secondary"><div className={cn("h-full rounded-full", j.status === "error" ? "bg-destructive" : "bg-primary", (j.status === "preparing" || j.status === "encoding") && "w-1/3 animate-pulse")} style={j.status === "preparing" || j.status === "encoding" ? undefined : { width: `${Math.round((j.status === "done" ? 1 : j.percent) * 100)}%` }} /></div>
                      <span className="w-60 text-right text-[11px] tabular-nums text-muted-foreground">
                        {j.status === "preparing" ? (j.stage ?? "Preparing…") : j.status === "rendering" ? `Chapter ${j.chapter}/${j.chapters} · ${fmtHms(j.audio_seconds)} recorded${j.eta_seconds ? ` · ~${fmtHms(j.eta_seconds)} left` : ""}`
                          : j.status === "encoding" ? "Encoding M4B…" : j.status === "done" ? `Done · ${j.outputs.length} file${j.outputs.length === 1 ? "" : "s"}` : j.status}
                      </span>
                    </div>
                    {j.error && j.status === "error" && <p className="mt-0.5 truncate text-[11px] text-destructive" title={j.error}>{j.error}</p>}
                  </div>
                  {active
                    ? <Button size="xs" variant="ghost" onClick={() => audiobookApi.cancel()}><X /> Cancel</Button>
                    : <>
                        {j.outputs[0] && <Button size="xs" variant="ghost" onClick={() => revealItemInDir(j.outputs[0])}><FolderOpen /> Show</Button>}
                        <button onClick={() => dismiss(j.id)} className="rounded p-1 text-muted-foreground hover:bg-secondary cursor-pointer" aria-label="Dismiss"><X className="h-3.5 w-3.5" /></button>
                      </>}
                </div>
              );
            })}
          </div>
        )}
        {!items.length && !jobs.length && <p className="p-10 text-center text-sm text-muted-foreground">No downloads yet. Find free books in Discover.</p>}
        <div className="divide-y">
          {items.map((i) => {
            const pct = i.total ? Math.min(100, (i.bytes / i.total) * 100) : null;
            return (
              <div key={i.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="w-12 rounded bg-secondary py-0.5 text-center font-mono text-[11px] uppercase">{i.format}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{i.title}</p>
                  <div className="mt-1 flex items-center gap-2">
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-secondary">
                      <div className={cn("h-full rounded-full", i.status === "failed" ? "bg-destructive" : "bg-primary", i.status === "downloading" && pct === null && "w-1/3 animate-pulse")} style={pct !== null ? { width: `${i.status === "completed" ? 100 : pct}%` } : undefined} />
                    </div>
                    <span className="w-44 text-right text-[11px] tabular-nums text-muted-foreground">
                      {i.status === "downloading" ? `${formatBytes(i.bytes)}${i.total ? ` / ${formatBytes(i.total)}` : ""}` : i.status}
                    </span>
                  </div>
                  {i.error && i.status === "failed" && <p className="mt-0.5 truncate text-[11px] text-destructive" title={i.error}>{i.error}</p>}
                </div>
                {i.status === "downloading" || i.status === "queued" ? (
                  <>
                    <Button size="icon-sm" variant="ghost" onClick={() => providers.cancel(i.id, true).then(load)} aria-label="Pause"><Pause /></Button>
                    <Button size="icon-sm" variant="ghost" onClick={() => providers.cancel(i.id).then(load)} aria-label="Cancel"><X /></Button>
                  </>
                ) : i.status === "completed" ? (
                  <>
                    {i.book_id && <Button size="icon-sm" variant="ghost" onClick={() => openBook(i.book_id!, i.title)} aria-label="Open"><BookOpen /></Button>}
                    {i.dest && <Button size="icon-sm" variant="ghost" onClick={() => revealItemInDir(i.dest!)} aria-label="Show in Finder"><FolderOpen /></Button>}
                  </>
                ) : (
                  <Button size="icon-sm" variant="ghost" onClick={() => providers.resume(i.id).then(load)} aria-label="Resume">{i.status === "paused" ? <Play /> : <RotateCcw />}</Button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
