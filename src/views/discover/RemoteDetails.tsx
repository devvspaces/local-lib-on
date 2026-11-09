import { useEffect, useState } from "react";
import { BookOpen, BookmarkPlus, Download, ExternalLink, Loader2, User, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { providers, type RemoteBook } from "@/lib/providers";
import { formatBytes } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { toast, toastAction, toastError } from "@/components/ui/toast";
import { useApp } from "@/store/app";
import { AccessBadge, RemoteCover } from "./RemoteCard";

export function RemoteDetails({ book, localId, onClose, onAuthor }: { book: RemoteBook; localId?: number | null; onClose: () => void; onAuthor: (provider: string, id: string, name: string) => void }) {
  const [b, setB] = useState<RemoteBook>(book);
  const [loading, setLoading] = useState(true);
  const [queuing, setQueuing] = useState<string | null>(null);
  const openBook = useApp((s) => s.openBook);

  useEffect(() => {
    setB(book);
    setLoading(true);
    providers.details(book.provider, book.id).then((d) => setB({ ...book, ...d, cover_url: d.cover_url ?? book.cover_url })).catch(() => {}).finally(() => setLoading(false));
  }, [book]);

  return (
    <aside className="flex w-96 shrink-0 flex-col overflow-y-auto border-l bg-card custom-scrollbar">
      <div className="flex justify-end p-2"><button onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-secondary cursor-pointer" aria-label="Close"><X className="h-4 w-4" /></button></div>
      <div className="px-5 pb-6">
        <div className="mx-auto aspect-[2/3] w-36 overflow-hidden rounded-md shadow-md"><RemoteCover b={b} /></div>
        <h2 className="mt-4 text-center font-serif text-lg font-semibold leading-snug" data-selectable>{b.title}</h2>
        {b.subtitle && <p className="text-center text-sm text-muted-foreground">{b.subtitle}</p>}
        <div className="mt-1 flex flex-wrap justify-center gap-x-2 text-sm">
          {b.authors.map((a) => (
            a.id ? <button key={a.name} onClick={() => onAuthor(b.provider, a.id!, a.name)} className="flex items-center gap-1 text-primary hover:underline cursor-pointer"><User className="h-3 w-3" />{a.name}</button> : <span key={a.name}>{a.name}</span>
          ))}
        </div>
        <div className="mt-2 flex justify-center gap-2 text-xs text-muted-foreground"><AccessBadge b={b} />{b.year && <span>{b.year}</span>}{b.language && <span>{b.language}</span>}{b.edition_count ? <span>{b.edition_count} editions</span> : null}</div>

        {localId ? (
          <Button className="mt-4 w-full" size="sm" onClick={() => openBook(localId, b.title)}><BookOpen /> Open from library</Button>
        ) : null}

        <div className="mt-4">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Download</p>
          {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          {!loading && b.files.length === 0 && (
            <p className="text-xs text-muted-foreground">{b.access === "borrow" ? "This edition is only available to borrow on the provider's website." : "No free file is available for this record."}</p>
          )}
          <div className="space-y-1">
            {b.files.map((f) => (
              <button
                key={f.url}
                disabled={queuing === f.url}
                onClick={async () => {
                  setQueuing(f.url);
                  try { await providers.download(b, f); toastAction("Downloading", `${b.title} (${f.format.toUpperCase()})`, { label: "Open Downloads", onClick: () => useApp.getState().setView("downloads") }); }
                  catch (e) { toastError("Download failed", e); } finally { setQueuing(null); }
                }}
                className="flex w-full disabled:cursor-wait disabled:opacity-60 items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-[13px] hover:border-primary/50 hover:bg-accent cursor-pointer"
              >
                {queuing === f.url ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> : <Download className="h-3.5 w-3.5 text-primary" />}
                <span className="font-mono text-xs font-semibold uppercase">{f.format}</span>
                <span className="flex-1 truncate text-xs text-muted-foreground">{f.label}</span>
                {f.size ? <span className="text-xs tabular-nums text-muted-foreground">{formatBytes(f.size)}</span> : null}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3 flex gap-2">
          {!localId && <Button variant="outline" size="sm" className="flex-1" onClick={async () => { await providers.saveReference(b); toast("Saved as a reference", "Its details are in your library, with no file. Download it any time and the file attaches to the same entry."); }}><BookmarkPlus /> Save reference</Button>}
          {b.web_url && <Button variant="outline" size="sm" onClick={() => openUrl(b.web_url!)}><ExternalLink /> Website</Button>}
        </div>

        {b.description && <p className="mt-4 border-t pt-3 text-[13px] leading-relaxed text-muted-foreground" data-selectable>{b.description.replace(/<[^>]+>/g, "")}</p>}
        {b.subjects.length > 0 && <div className="mt-3 flex flex-wrap gap-1">{b.subjects.map((s) => <span key={s} className="rounded bg-secondary px-1.5 py-0.5 text-[11px]">{s}</span>)}</div>}
        {(b.isbn || b.doi) && <p className="mt-3 text-xs text-muted-foreground" data-selectable>{b.isbn && `ISBN ${b.isbn}`} {b.doi && `DOI ${b.doi}`}</p>}
      </div>
    </aside>
  );
}
