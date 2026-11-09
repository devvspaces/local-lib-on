import { BookCheck, Download, Loader2 } from "lucide-react";
import type { RemoteBook } from "@/lib/providers";
import { cn } from "@/lib/utils";

export function RemoteCover({ b, className }: { b: RemoteBook; className?: string }) {
  if (b.cover_url) return <img src={b.cover_url} alt="" loading="lazy" className={cn("h-full w-full object-cover", className)} />;
  return (
    <div className={cn("flex h-full w-full flex-col justify-end bg-gradient-to-b from-stone-500 to-stone-800 p-2 text-white", className)}>
      <p className="line-clamp-4 font-serif text-[12px] font-semibold leading-tight">{b.title}</p>
    </div>
  );
}

export function AccessBadge({ b }: { b: RemoteBook }) {
  const map = { public: ["Free", "bg-emerald-600/15 text-emerald-700 dark:text-emerald-400"], borrow: ["Borrow", "bg-sky-600/15 text-sky-700 dark:text-sky-400"], none: ["Metadata", "bg-secondary text-muted-foreground"] } as const;
  const [l, c] = map[b.access] ?? map.none;
  return <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", c)}>{l}</span>;
}

export function RemoteCard({ b, inLibrary, busy, onOpen, onDownload }: { b: RemoteBook; inLibrary?: boolean; busy?: boolean; onOpen: () => void; onDownload: () => void }) {
  return (
    <div className="group cursor-pointer" onClick={onOpen}>
      <div className="relative aspect-[2/3] overflow-hidden rounded-md bg-secondary shadow-sm group-hover:shadow-md">
        <RemoteCover b={b} />
        {inLibrary && <span className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground"><BookCheck className="h-3 w-3" /> In library</span>}
        {b.access === "public" && !inLibrary && (
          <button onClick={(e) => { e.stopPropagation(); onDownload(); }} className="absolute bottom-1.5 right-1.5 rounded-full bg-black/70 p-1.5 text-white opacity-0 transition-opacity group-hover:opacity-100 cursor-pointer" aria-label="Download">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
      <p className="mt-2 line-clamp-2 text-[13px] font-medium leading-tight">{b.title}</p>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">{b.authors.map((a) => a.name).join(", ") || " "}</p>
      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground"><AccessBadge b={b} />{b.year && <span>{b.year}</span>}</div>
    </div>
  );
}
