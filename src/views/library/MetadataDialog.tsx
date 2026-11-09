import { useEffect, useState } from "react";
import { Loader2, Sparkles, Wand2 } from "lucide-react";
import { identifyAndApply } from "@/lib/identify";
import { api, type Book, type BookPatch } from "@/lib/api";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast, toastError } from "@/components/ui/toast";
import { lookupMetadata } from "@/lib/metadataLookup";
import { useApp } from "@/store/app";

const F = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="block">
    <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
    {children}
  </label>
);

export function MetadataDialog({ book, onClose }: { book: Book | null; onClose: () => void }) {
  const [p, setP] = useState<BookPatch>({});
  const [busy, setBusy] = useState(false);
  const bump = useApp((s) => s.bumpLibrary);

  useEffect(() => {
    if (book) {
      setP({
        title: book.title, subtitle: book.subtitle, authors: book.authors, year: book.year, language: book.language,
        publisher: book.publisher, isbn: book.isbn, doi: book.doi, series: book.series, series_index: book.series_index,
        description: book.description, edition: book.edition, place: book.place, num_pages: book.num_pages, item_type: book.item_type,
      });
    }
  }, [book]);

  if (!book) return null;
  const set = (k: keyof BookPatch) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setP({ ...p, [k]: e.target.value });

  const fetchOnline = async () => {
    setBusy(true);
    try {
      const m = await lookupMetadata({ isbn: p.isbn ?? undefined, isbns: book.identifiers.filter((i) => i.scheme === "isbn").map((i) => i.value), doi: p.doi ?? undefined, title: p.title ?? undefined, author: p.authors?.[0] });
      if (!m) { toast("No match found", "Try adding an ISBN or DOI."); return; }
      setP((cur) => ({ ...cur, ...Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined && v !== null && v !== "")) }));
      toast("Metadata found", `${m.title ?? ""} — review and save.`);
    } catch (e) {
      toastError("Lookup failed", e);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    try {
      await api.updateBook(book.id, {
        ...p,
        metadata_source: "manual",
        year: p.year ? Number(p.year) : undefined,
        series_index: p.series_index ? Number(p.series_index) : undefined,
        authors: typeof p.authors === "string" ? (p.authors as unknown as string).split(/[;,]/).map((s) => s.trim()).filter(Boolean) : p.authors,
      });
      bump();
      onClose();
    } catch (e) {
      toastError("Could not save", e);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Edit metadata" description={book.files[0]?.path} className="max-w-2xl">
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2"><F label="Title"><Input value={p.title ?? ""} onChange={set("title")} /></F></div>
          <div className="col-span-2"><F label="Subtitle"><Input value={p.subtitle ?? ""} onChange={set("subtitle")} /></F></div>
          <div className="col-span-2">
            <F label="Authors (comma-separated)">
              <Input value={Array.isArray(p.authors) ? p.authors.join(", ") : (p.authors as unknown as string) ?? ""} onChange={(e) => setP({ ...p, authors: e.target.value as unknown as string[] })} />
            </F>
          </div>
          <F label="Year"><Input value={p.year ?? ""} onChange={set("year")} inputMode="numeric" /></F>
          <F label="Language"><Input value={p.language ?? ""} onChange={set("language")} /></F>
          <F label="Publisher"><Input value={p.publisher ?? ""} onChange={set("publisher")} /></F>
          <F label="ISBN"><Input value={p.isbn ?? ""} onChange={set("isbn")} /></F>
          <F label="DOI"><Input value={p.doi ?? ""} onChange={set("doi")} /></F>
          <F label="Edition"><Input value={p.edition ?? ""} onChange={set("edition")} /></F>
          <F label="Place"><Input value={p.place ?? ""} onChange={set("place")} /></F>
          <F label="Pages"><Input value={p.num_pages ?? ""} onChange={(e) => setP({ ...p, num_pages: Number(e.target.value) || undefined })} inputMode="numeric" /></F>
          <F label="Item type">
            <select value={p.item_type ?? "book"} onChange={(e) => setP({ ...p, item_type: e.target.value as BookPatch["item_type"] })} className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm">
              {["book", "article", "chapter", "thesis", "report", "document"].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </F>
          <div className="grid grid-cols-[1fr_80px] gap-2">
            <F label="Series"><Input value={p.series ?? ""} onChange={set("series")} /></F>
            <F label="#"><Input value={p.series_index ?? ""} onChange={set("series_index")} /></F>
          </div>
          <div className="col-span-2">
            <F label="Description">
              <textarea value={p.description ?? ""} onChange={set("description")} rows={4} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
            </F>
          </div>
        </div>
        <div className="mt-5 flex items-center justify-between">
          <Button variant="outline" size="sm" onClick={fetchOnline} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Wand2 />} Fetch from Open Library / Crossref
          </Button>
          {book.files.length > 0 && (
            <Button variant="ghost" size="sm" title="Reads the first pages, finds the DOI / ISBN and fetches the full record" onClick={() => { const b = book; onClose(); identifyAndApply(b).then((ok) => ok && useApp.getState().bumpLibrary()); }}>
              <Sparkles /> Identify with AI
            </Button>
          )}
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={save}>Save</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
