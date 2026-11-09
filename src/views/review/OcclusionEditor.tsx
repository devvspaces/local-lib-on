// Image-occlusion editor: draw boxes over the labels of a diagram; each box becomes a flashcard.
import { useRef, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { create } from "zustand";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast, toastError } from "@/components/ui/toast";
import { cardsApi, occlusionCards, saveCardImage } from "@/lib/cards";
import { api } from "@/lib/api";

export const useOcclusion = create<{ req: { png: string; w: number; h: number; page: number; bookId: number; title: string } | null }>(() => ({ req: null }));

type Rect = [number, number, number, number];

export function OcclusionEditor() {
  const req = useOcclusion((s) => s.req);
  const [masks, setMasks] = useState<Rect[]>([]);
  const [draft, setDraft] = useState<Rect | null>(null);
  const [mode, setMode] = useState<"one" | "all">("one");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const start = useRef<[number, number] | null>(null);
  if (!req) return null;
  const close = () => { useOcclusion.setState({ req: null }); setMasks([]); setDraft(null); };

  const pos = (e: React.PointerEvent): [number, number] => {
    const r = box.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  const rectOf = (a: [number, number], b: [number, number]): Rect => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])];

  const save = async () => {
    if (!masks.length) return;
    setBusy(true);
    try {
      const image = await saveCardImage(req.png);
      const title = req.title || (await api.getBook(req.bookId).then((b) => b.title).catch(() => "Diagram"));
      const cards = occlusionCards({ image, w: req.w, h: req.h, masks, mode, page: req.page }, `${title} · p. ${req.page}`);
      for (const c of cards) await cardsApi.upsert({ front: c.front, book_id: req.bookId, kind: "occlusion", media: c.media });
      toast(`Created ${cards.length} occlusion card${cards.length === 1 ? "" : "s"}`, "Study them in the Review tab.", "success");
      close();
    } catch (e) { toastError("Couldn't save the cards", e); } finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent title="Image occlusion cards" description="Drag boxes over the labels you want to learn. Each box becomes one card." className="max-w-3xl">
        <div
          ref={box}
          className="relative mx-auto max-h-[60vh] w-fit cursor-crosshair select-none overflow-hidden rounded border bg-white touch-none"
          onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); start.current = pos(e); setDraft(null); }}
          onPointerMove={(e) => { if (start.current) setDraft(rectOf(start.current, pos(e))); }}
          onPointerUp={(e) => { if (start.current) { const r = rectOf(start.current, pos(e)); if (r[2] > 0.01 && r[3] > 0.01) setMasks((m) => [...m, r]); } start.current = null; setDraft(null); }}
        >
          <img src={req.png} alt={`Diagram from page ${req.page}`} className="block max-h-[60vh] max-w-full" draggable={false} />
          {masks.map((m, i) => (
            <div key={i} className="absolute flex items-center justify-center border-2 border-primary bg-primary/70 text-xs font-bold text-primary-foreground" style={{ left: `${m[0] * 100}%`, top: `${m[1] * 100}%`, width: `${m[2] * 100}%`, height: `${m[3] * 100}%` }}>
              {i + 1}
              <button onPointerDown={(e) => e.stopPropagation()} onClick={() => setMasks(masks.filter((_, j) => j !== i))} className="absolute -right-2 -top-2 rounded-full bg-background p-0.5 text-foreground shadow cursor-pointer" aria-label={`Remove box ${i + 1}`}><Trash2 className="h-3 w-3" /></button>
            </div>
          ))}
          {draft && <div className="absolute border-2 border-dashed border-primary bg-primary/30" style={{ left: `${draft[0] * 100}%`, top: `${draft[1] * 100}%`, width: `${draft[2] * 100}%`, height: `${draft[3] * 100}%` }} />}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-1.5"><input type="radio" checked={mode === "one"} onChange={() => setMode("one")} /> Hide one, guess one</label>
          <label className="flex items-center gap-1.5"><input type="radio" checked={mode === "all"} onChange={() => setMode("all")} /> Hide all, guess one</label>
          <span className="ml-auto text-xs text-muted-foreground">{masks.length} box{masks.length === 1 ? "" : "es"}</span>
          <Button variant="outline" size="sm" onClick={close}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={!masks.length || busy}>{busy && <Loader2 className="animate-spin" />} Create {masks.length || ""} card{masks.length === 1 ? "" : "s"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
