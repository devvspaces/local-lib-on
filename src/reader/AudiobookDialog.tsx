// Audiobook export: pick chapters, a natural voice and speed → M4B with chapter markers (rendered in the
// background; progress shows in the Downloads tab).
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Headphones, Loader2 } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast, toastError } from "@/components/ui/toast";
import { useApp } from "@/store/app";
import type { Book } from "@/lib/api";
import { neuralApi, useTts, type VoicePack } from "./tts";
import type { ChapterRange } from "./chapters";
import { useAudiobooks } from "@/lib/audiobookJobs";

export const audiobookApi = {
  start: (job: { book_id: number; voice: string; sid: number; speed: number; out_path: string; chapters: { title: string; from: number; to: number }[] }) => invoke<string>("audiobook_start", { job }),
  cancel: () => invoke<void>("audiobook_cancel"),
  canEncode: () => invoke<boolean>("audiobook_can_encode"),
  estimate: (bookId: number, chapters: { title: string; from: number; to: number }[], speed: number) => invoke<[number, number]>("audiobook_estimate", { bookId, chapters, speed }),
};

export const fmtHms = (s: number) => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h} h ${m} min` : `${Math.max(1, m)} min`; };

export function AudiobookDialog({ open, onClose, book, chapters, current }: { open: boolean; onClose: () => void; book: Book; chapters: ChapterRange[]; current?: string | null }) {
  const [packs, setPacks] = useState<VoicePack[]>([]);
  const [canEncode, setCanEncode] = useState(true);
  useEffect(() => { if (open) audiobookApi.canEncode().then(setCanEncode).catch(() => {}); }, [open]);
  const neural = useTts((s) => s.neural);
  const [voice, setVoice] = useState<{ pack: string; sid: number } | null>(neural);
  const [speed, setSpeed] = useState(1);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [est, setEst] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const setView = useApp((s) => s.setView);

  useEffect(() => { if (open) neuralApi.voices().then((v) => { const inst = v.filter((x) => x.installed); setPacks(inst); if (!voice && inst[0]) setVoice({ pack: inst[0].id, sid: inst[0].speakers[0]?.sid ?? 0 }); }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open]);
  // Default selection: the chapter being read, else everything.
  useEffect(() => {
    if (!open) return;
    const i = current ? chapters.findIndex((c) => c.label.trim() === current.trim()) : -1;
    setSel(new Set(i >= 0 ? [i] : chapters.map((_, j) => j)));
  }, [open, chapters, current]);

  const picked = useMemo(() => chapters.filter((_, i) => sel.has(i)).map((c) => ({ title: c.label, from: c.from, to: c.to })), [chapters, sel]);
  useEffect(() => {
    if (!open || !picked.length) { setEst(null); return; }
    const t = setTimeout(() => audiobookApi.estimate(book.id, picked, speed).then(([, secs]) => setEst(secs)).catch(() => setEst(null)), 250);
    return () => clearTimeout(t);
  }, [open, book.id, picked, speed]);

  const pack = packs.find((p) => p.id === voice?.pack);
  const renderFactor = pack?.family === "kokoro" ? 0.6 : 0.15; // rough CPU time per second of audio
  const start = async () => {
    if (!voice || !picked.length) return;
    const { save } = await import("@tauri-apps/plugin-dialog");
    const name = book.title.replace(/[\\/:*?"<>|]/g, "").slice(0, 80);
    const suffix = picked.length === 1 && chapters.length > 1 ? ` - ${picked[0].title.replace(/[\\/:*?"<>|]/g, "").slice(0, 60)}` : "";
    const out = await save({ defaultPath: `${name}${suffix}.m4b`, filters: [{ name: "Audiobook", extensions: ["m4b"] }] });
    if (!out) return;
    setBusy(true);
    try {
      const id = await audiobookApi.start({ book_id: book.id, voice: voice.pack, sid: voice.sid, speed, out_path: out, chapters: picked });
      useAudiobooks.getState().add({ id, title: book.title, status: "preparing", stage: "Starting…", chapter: 0, chapters: picked.length, percent: 0, eta_seconds: null, audio_seconds: 0, outputs: [], error: null });
      toast("Making your audiobook", "Follow progress in the Downloads tab.", "success");
      onClose();
      setView("downloads");
    } catch (e) { toastError("Couldn't start the audiobook", e); } finally { setBusy(false); }
  };

  const all = sel.size === chapters.length;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Export as audiobook" description="Read by a natural voice on this Mac, saved as an M4B with chapter markers for Apple Books, QuickTime or any podcast/audiobook app." className="max-w-xl">
        {!canEncode ? (
          <p className="text-sm text-muted-foreground">Audiobook export needs <b>ffmpeg</b> on this computer. Install it (Windows: <code>winget install ffmpeg</code>; Linux: your package manager), then open this again.</p>
        ) : !packs.length ? (
          <p className="text-sm text-muted-foreground">Download a natural voice first in Settings → Reading &amp; voices (Piper is fastest; Kokoro sounds most natural).</p>
        ) : (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-[80px_1fr] items-center gap-2">
              <span className="text-muted-foreground">Voice</span>
              <select value={voice ? `${voice.pack}|${voice.sid}` : ""} onChange={(e) => { const [p, s] = e.target.value.split("|"); setVoice({ pack: p, sid: Number(s) }); }} className="h-8 rounded-md border bg-background px-2 text-[13px]">
                {packs.flatMap((p) => (p.speakers.length ? p.speakers : [{ sid: 0, name: p.name }]).map((s) => <option key={`${p.id}|${s.sid}`} value={`${p.id}|${s.sid}`}>{p.speakers.length > 1 ? `${p.name} · ${s.name}` : p.name}</option>))}
              </select>
              <span className="text-muted-foreground">Speed</span>
              <div className="flex items-center gap-2"><input type="range" min={0.7} max={1.6} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="flex-1" /><span className="w-10 tabular-nums">{speed.toFixed(2)}×</span></div>
            </div>
            <div>
              <div className="mb-1 flex items-center gap-2">
                <span className="font-medium">Chapters</span>
                <button onClick={() => setSel(all ? new Set() : new Set(chapters.map((_, i) => i)))} className="ml-auto text-xs text-primary hover:underline cursor-pointer">{all ? "Select none" : "Whole book"}</button>
              </div>
              <div className="max-h-56 overflow-y-auto rounded-md border custom-scrollbar">
                {chapters.map((c, i) => (
                  <label key={i} className="flex items-center gap-2 border-b px-2 py-1 text-[13px] last:border-0" style={{ paddingLeft: 8 + c.depth * 14 }}>
                    <input type="checkbox" checked={sel.has(i)} onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(i); else n.delete(i); setSel(n); }} />
                    <span className="flex-1 truncate">{c.label}</span>
                    <span className="text-[11px] tabular-nums text-muted-foreground">{c.kind === "p" ? `pp. ${c.from}–${c.to}` : ""}</span>
                  </label>
                ))}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {est === null ? "…" : est === 0 ? "No indexed text in these chapters yet (the book may still be indexing, or need OCR)." : <>About <b className="text-foreground">{fmtHms(est)}</b> of audio · rendering takes roughly {fmtHms(est * renderFactor)} on this Mac. You can keep reading meanwhile.</>}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
              <Button size="sm" onClick={start} disabled={busy || !voice || !picked.length || est === 0}>{busy ? <Loader2 className="animate-spin" /> : <Headphones />} Make audiobook</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
