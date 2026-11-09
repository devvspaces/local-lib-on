import { useEffect, useState } from "react";
import { ExternalLink, Loader2, Search, Volume2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import DOMPurify from "dompurify";

interface Def { pos: string; defs: string[] }

/** Dictionary (Wiktionary) + encyclopedia (Wikipedia) lookup, side-by-side with the text. */
export function LookupPane({ initial }: { initial?: string }) {
  const [q, setQ] = useState(initial ?? "");
  const [term, setTerm] = useState(initial ?? "");
  const [defs, setDefs] = useState<Def[] | null>(null);
  const [wiki, setWiki] = useState<{ title: string; extract: string; url: string; thumb?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (initial) { setQ(initial); setTerm(initial); } }, [initial]);

  useEffect(() => {
    const t = term.trim();
    if (!t) return;
    let alive = true;
    setBusy(true);
    setDefs(null);
    setWiki(null);
    const word = t.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, "");
    Promise.allSettled([
      fetch(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t)}`).then((r) => (r.ok ? r.json() : null)),
    ]).then(([d, w]) => {
      if (!alive) return;
      if (d.status === "fulfilled" && d.value?.en) {
        setDefs(d.value.en.map((e: { partOfSpeech: string; definitions: { definition: string }[] }) => ({
          pos: e.partOfSpeech,
          defs: e.definitions.map((x) => DOMPurify.sanitize(x.definition, { ALLOWED_TAGS: ["i", "b", "em", "strong"] })).filter(Boolean).slice(0, 6),
        })));
      } else setDefs([]);
      if (w.status === "fulfilled" && w.value?.extract && w.value.type !== "disambiguation") {
        setWiki({ title: w.value.title, extract: w.value.extract, url: w.value.content_urls?.desktop?.page, thumb: w.value.thumbnail?.source });
      }
      setBusy(false);
    });
    return () => { alive = false; };
  }, [term]);

  return (
    <div className="flex h-full flex-col">
      <form onSubmit={(e) => { e.preventDefault(); setTerm(q); }} className="relative m-2">
        <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Look up a word or topic" className="h-8 w-full rounded-md border bg-background pl-7 pr-2 text-[13px] outline-none focus:ring-2 focus:ring-ring" />
      </form>
      <div className="flex-1 overflow-y-auto px-3 pb-6 text-[13px] custom-scrollbar" data-selectable>
        {busy && <Loader2 className="mx-auto mt-6 h-4 w-4 animate-spin text-muted-foreground" />}
        {!term && <p className="text-xs text-muted-foreground">Select a word in the book and choose “Look up”.</p>}
        {term && !busy && (
          <>
            <div className="flex items-center gap-2">
              <h3 className="font-serif text-xl font-semibold">{term}</h3>
              <button onClick={() => speechSynthesis.speak(new SpeechSynthesisUtterance(term))} className="text-muted-foreground hover:text-foreground cursor-pointer" aria-label="Pronounce"><Volume2 className="h-4 w-4" /></button>
            </div>
            {defs?.map((d, i) => (
              <div key={i} className="mt-3">
                <p className="text-xs font-semibold italic text-muted-foreground">{d.pos}</p>
                <ol className="mt-1 list-decimal space-y-1 pl-5">{d.defs.map((x, j) => <li key={j} dangerouslySetInnerHTML={{ __html: x }} />)}</ol>
              </div>
            ))}
            {defs?.length === 0 && <p className="mt-2 text-xs text-muted-foreground">No dictionary entry.</p>}
            {wiki && (
              <div className="mt-5 border-t pt-3">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Wikipedia</p>
                {wiki.thumb && <img src={wiki.thumb} alt="" className="float-right ml-2 mb-1 w-20 rounded" />}
                <p className="font-semibold">{wiki.title}</p>
                <p className="mt-1 leading-relaxed">{wiki.extract}</p>
                {wiki.url && <button onClick={() => openUrl(wiki.url)} className="mt-2 flex items-center gap-1 text-xs text-primary hover:underline cursor-pointer">Open article <ExternalLink className="h-3 w-3" /></button>}
              </div>
            )}
            <div className="mt-5 flex gap-3 border-t pt-3 text-xs">
              <button onClick={() => openUrl(`dict://${encodeURIComponent(term)}`)} className="text-primary hover:underline cursor-pointer">macOS Dictionary</button>
              <button onClick={() => openUrl(`https://en.wiktionary.org/wiki/${encodeURIComponent(term)}`)} className="text-primary hover:underline cursor-pointer">Wiktionary</button>
              <button onClick={() => openUrl(`https://scholar.google.com/scholar?q=${encodeURIComponent(term)}`)} className="text-primary hover:underline cursor-pointer">Scholar</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
