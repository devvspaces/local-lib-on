import { coverUrl, type Book } from "@/lib/api";
import { cn } from "@/lib/utils";

const PALETTE = ["#7c4a2d", "#2d5a7c", "#4a7c2d", "#6b2d7c", "#7c2d3f", "#2d7c6b", "#5a5a2d"];

/** Cover image, or a generated typographic cover while metadata enrichment hasn't rendered one. */
export function BookCover({ book, className }: { book: Book; className?: string }) {
  const url = coverUrl(book);
  const fmt = book.files[0]?.format?.toUpperCase();
  if (url) {
    return <img src={url} alt="" loading="lazy" draggable={false} className={cn("h-full w-full object-cover", className)} />;
  }
  const bg = PALETTE[book.id % PALETTE.length];
  return (
    <div className={cn("flex h-full w-full flex-col justify-between p-3 text-white", className)} style={{ background: `linear-gradient(160deg, ${bg}, #1b1a18)` }}>
      <span className="text-[10px] font-mono opacity-70">{fmt}</span>
      <div>
        <p className="line-clamp-4 font-serif text-[13px] font-semibold leading-tight">{book.title}</p>
        {book.authors[0] && <p className="mt-1 line-clamp-1 text-[11px] opacity-75">{book.authors[0]}</p>}
      </div>
    </div>
  );
}
