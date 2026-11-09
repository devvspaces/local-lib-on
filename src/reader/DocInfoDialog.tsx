import type { Book } from "@/lib/api";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { formatBytes } from "@/lib/utils";

export function DocInfoDialog({ open, onClose, book, meta, pageCount }: { open: boolean; onClose: () => void; book: Book; meta: Record<string, unknown>; pageCount?: number }) {
  const rows = Object.entries(meta).filter(([, v]) => v !== null && v !== undefined && v !== "" && typeof v !== "object");
  const f = book.files[0];
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Document information" description={f?.path}>
        <table className="w-full text-[13px]" data-selectable>
          <tbody>
            {[["Format", f?.format.toUpperCase()], ["Size", formatBytes(f?.size)], ["Pages", pageCount], ...rows].map(([k, v]) => v !== undefined && (
              <tr key={String(k)} className="border-b last:border-0"><td className="w-40 py-1.5 pr-3 align-top text-muted-foreground">{String(k)}</td><td className="break-all py-1.5">{String(v)}</td></tr>
            ))}
          </tbody>
        </table>
      </DialogContent>
    </Dialog>
  );
}
