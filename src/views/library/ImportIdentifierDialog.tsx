import { useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { lookupDOI, lookupISBN, sniffIdentifiers } from "@/lib/metadataLookup";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast, toastError } from "@/components/ui/toast";
import { useApp } from "@/store/app";
import { fetchArxiv } from "@/lib/arxiv";

/** Zotero-style "Add item by identifier": ISBN, DOI, arXiv id or URL → reference entry (+ PDF for arXiv). */
export function ImportIdentifierDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const bump = useApp((s) => s.bumpLibrary);

  const go = async () => {
    const v = value.trim();
    if (!v) return;
    setBusy(true);
    try {
      const ids = sniffIdentifiers(v.startsWith("10.") || v.includes("doi.org") ? v : `ISBN ${v} ${v}`);
      const arxivId = v.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i)?.[1] ?? v.match(/^(?:arXiv:)?(\d{4}\.\d{4,5})(v\d+)?$/i)?.[1];
      let meta = null;
      let identifier: [string, string] | null = null;
      if (arxivId) {
        meta = await fetchArxiv(arxivId);
        identifier = ["arxiv", arxivId];
      } else if (ids.doi || v.includes("doi.org")) {
        const doi = ids.doi ?? v.replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
        meta = await lookupDOI(doi);
        identifier = ["doi", doi.toLowerCase()];
      } else if (/^[\dXx-]{10,17}$/.test(v)) {
        meta = await lookupISBN(v);
      }
      if (!meta?.title) {
        toast("Nothing found", "Paste an ISBN, DOI, arXiv ID or a doi.org / arxiv.org URL.");
        return;
      }
      const id = await api.createBook(meta, identifier ? [identifier] : []);
      toast("Added to library", meta.title + (arxivId ? " — open it in Discover to download the PDF." : ""), "success");
      bump();
      setValue("");
      onClose();
      void id;
    } catch (e) {
      toastError("Lookup failed", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Add by identifier" description="ISBN, DOI, arXiv ID, or a doi.org / arxiv.org link. Creates a library entry with full metadata, ready to cite.">
        <form onSubmit={(e) => { e.preventDefault(); go(); }} className="flex gap-2">
          <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="978-0-13-468599-1  ·  10.1145/3292500  ·  2106.09685" />
          <Button type="submit" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : "Add"}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
