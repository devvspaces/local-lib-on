import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { cslApi, popularStyles, prettyStyle } from "@/lib/csl";

/** Search 2,800+ CSL styles; remembers the last choice. */
export function StylePicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [all, setAll] = useState<string[] | null>(null);
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { cslApi.styles().then((s) => setAll(s.map((x) => x.id))).catch((e) => setErr(String(e))); }, []);
  const list = useMemo(() => {
    const pool = all ?? popularStyles();
    const t = q.trim().toLowerCase();
    const hits = t ? pool.filter((id) => id.includes(t.replace(/\s+/g, "-")) || prettyStyle(id).toLowerCase().includes(t)) : popularStyles().filter((p) => pool.includes(p) || !all);
    return hits.slice(0, 60);
  }, [all, q]);
  return (
    <div className="space-y-1.5">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={all ? `Search ${all.length.toLocaleString()} citation styles…` : "Loading styles…"} className="h-8 w-full rounded-md border bg-background px-2 text-[13px] outline-none focus:ring-2 focus:ring-ring" />
      {err && <p className="text-xs text-muted-foreground">Offline: showing common styles only.</p>}
      <div className="max-h-48 overflow-y-auto rounded-md border custom-scrollbar">
        {!all && !err && <Loader2 className="m-2 h-4 w-4 animate-spin text-muted-foreground" />}
        {list.map((id) => (
          <button key={id} onClick={() => { onChange(id); try { localStorage.setItem("local-lib-csl", id); } catch { /* ignore */ } }} className={`block w-full truncate px-2 py-1 text-left text-[13px] hover:bg-secondary cursor-pointer ${value === id ? "bg-accent text-accent-foreground" : ""}`} title={id}>
            {prettyStyle(id)}
          </button>
        ))}
      </div>
    </div>
  );
}

export const lastStyle = () => { try { return localStorage.getItem("local-lib-csl") ?? "apa"; } catch { return "apa"; } };
