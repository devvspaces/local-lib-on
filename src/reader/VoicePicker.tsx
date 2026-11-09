import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, Download, Loader2, Play, Trash2 } from "lucide-react";
import { neuralApi, sample, useTts, voices, type VoicePack } from "./tts";
import { cn } from "@/lib/utils";
import { toastError } from "@/components/ui/toast";

/** Natural offline voices (Kokoro / Piper via sherpa-onnx) + system voices. */
export function VoicePicker({ compact = false }: { compact?: boolean }) {
  const { voiceURI, neural, rate } = useTts();
  const [packs, setPacks] = useState<VoicePack[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [sys, setSys] = useState<SpeechSynthesisVoice[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => neuralApi.voices().then(setPacks).catch(() => {});
  useEffect(() => {
    load();
    const upd = () => setSys(voices());
    upd();
    speechSynthesis.addEventListener("voiceschanged", upd);
    let un: (() => void) | undefined, dead = false;
    listen<{ id: string; bytes: number; total: number | null; done: boolean }>("tts_install_progress", (e) => {
      const p = e.payload;
      setProgress((m) => ({ ...m, [p.id]: p.done ? 1 : p.total ? p.bytes / p.total : 0 }));
      if (p.done) load();
    }).then((f) => (dead ? f() : (un = f)));
    return () => { speechSynthesis.removeEventListener("voiceschanged", upd); dead = true; un?.(); };
  }, []);

  const install = async (id: string) => {
    setProgress((m) => ({ ...m, [id]: 0 }));
    try { await neuralApi.install(id); await load(); }
    catch (e) { toastError("Voice download failed", e); }
    finally { setProgress((m) => { const n = { ...m }; delete n[id]; return n; }); }
  };
  const premium = sys.filter((v) => /premium|enhanced|siri/i.test(v.name) || /premium|enhanced/i.test(v.voiceURI));
  const others = sys.filter((v) => !premium.includes(v)).filter((v) => v.lang.startsWith("en") || !compact);

  return (
    <div className="space-y-2 text-[13px]" onKeyDown={(e) => e.stopPropagation()}>
      <div>
        <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Natural voices · offline</p>
        {packs.map((p) => (
          <div key={p.id} className="rounded-md px-1 py-1">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{p.name}</p>
                <p className="truncate text-[11px] text-muted-foreground">{p.note} · {p.size_mb} MB</p>
              </div>
              {p.installed ? (
                <button onClick={async () => { await neuralApi.uninstall(p.id); if (neural?.pack === p.id) useTts.setState({ neural: null }); load(); }} className="text-muted-foreground hover:text-destructive cursor-pointer" title="Remove voice"><Trash2 className="h-3.5 w-3.5" /></button>
              ) : progress[p.id] !== undefined ? (
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />{Math.round(progress[p.id] * 100)}%</span>
              ) : (
                <button onClick={() => install(p.id)} className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] hover:bg-secondary cursor-pointer"><Download className="h-3 w-3" /> Get</button>
              )}
            </div>
            {p.installed && (
              <div className="mt-1 flex flex-wrap gap-1">
                {(p.speakers.length ? p.speakers : [{ sid: 0, name: "Default" }]).map((s) => {
                  const on = neural?.pack === p.id && neural.sid === s.sid;
                  return (
                    <span key={s.sid} className={cn("flex items-center rounded-full border text-[11px]", on && "border-primary bg-accent text-accent-foreground")}>
                      <button onClick={() => useTts.setState({ neural: { pack: p.id, sid: s.sid } })} className="flex items-center gap-1 py-0.5 pl-2 pr-1 cursor-pointer">{on && <Check className="h-3 w-3" />}{s.name}</button>
                      <button disabled={busy === `${p.id}:${s.sid}`} onClick={async () => { setBusy(`${p.id}:${s.sid}`); await sample(p.id, s.sid).catch((e) => toastError("Couldn't play sample", e)); setBusy(null); }} className="py-0.5 pl-0.5 pr-1.5 text-muted-foreground hover:text-foreground cursor-pointer" aria-label="Play sample">
                        {busy === `${p.id}:${s.sid}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="border-t pt-2">
        <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">System voices</p>
        <button onClick={() => useTts.setState({ neural: null, voiceURI: null })} className={cn("block w-full rounded px-2 py-1 text-left hover:bg-secondary cursor-pointer", !neural && !voiceURI && "bg-accent")}>System default</button>
        {[...premium, ...others].slice(0, compact ? 14 : 200).map((v) => (
          <button key={v.voiceURI} onClick={() => useTts.setState({ neural: null, voiceURI: v.voiceURI })} className={cn("flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-secondary cursor-pointer", !neural && voiceURI === v.voiceURI && "bg-accent")}>
            <span className="flex-1 truncate">{v.name}</span>
            {premium.includes(v) && <span className="rounded bg-primary/15 px-1 text-[10px] text-primary">premium</span>}
            <span className="text-[10px] text-muted-foreground">{v.lang}</span>
          </button>
        ))}
        {!premium.length && <p className="px-2 pt-1 text-[11px] text-muted-foreground">Tip: download macOS Premium voices in System Settings → Accessibility → Spoken Content → System voice → Manage Voices. They appear here after a restart.</p>}
      </div>
      <p className="px-1 text-[11px] text-muted-foreground">Speed {rate}× applies to both kinds of voices.</p>
    </div>
  );
}
