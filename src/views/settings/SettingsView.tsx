import { useEffect, useState } from "react";
import { VoicePicker } from "@/reader/VoicePicker";
import { open as openDialog, save } from "@tauri-apps/plugin-dialog";
import { BookOpen, Cloud, Compass, Folder, FolderOpen, FolderPlus, Library, Loader2, Quote, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { listen } from "@tauri-apps/api/event";
import { sttApi, type SttModel } from "@/reader/voiceAsk";
import { api, type ReadingStats } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { toast, toastAction, toastError } from "@/components/ui/toast";
import { autoUpdateEnabled, checkForUpdates, installUpdate, setAutoUpdate, useUpdater } from "@/lib/updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useApp } from "@/store/app";
import { bibliography } from "@/views/export/exporters";
import { askConfirm, askForm } from "@/components/ui/prompt";

const fmtTime = (s: number) => (s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

type PageId = "library" | "reading" | "ai" | "sources" | "sync" | "browser";
const PAGES: { id: PageId; label: string; icon: typeof Folder; keywords: string }[] = [
  { id: "library", label: "Library", icon: Library, keywords: "folders watch rescan full-text search index export bibtex ris csl about version updates update check release" },
  { id: "reading", label: "Reading & voices", icon: BookOpen, keywords: "read aloud tts voices kokoro piper microphone voice questions speech recognition moonshine whisper audiobook ocr scanned vision tesseract languages reading stats" },
  { id: "ai", label: "AI", icon: Sparkles, keywords: "assistant anthropic claude gemini openai ollama model key embeddings semantic meaning" },
  { id: "sources", label: "Sources", icon: Compass, keywords: "opds catalogs providers github repositories awesome lists token" },
  { id: "sync", label: "Sync & backup", icon: Cloud, keywords: "sync backup restore dropbox onedrive google drive webdav folder encryption passphrase koreader readwise integrations" },
  { id: "browser", label: "Browser & citing", icon: Quote, keywords: "connector extension zotero cite palette shortcut token" },
];
const PAGE_KEY = "local-lib-settings-page";

export function SettingsView() {
  const [page, setPage] = useState<PageId>(() => { try { return (localStorage.getItem(PAGE_KEY) as PageId) || "library"; } catch { return "library"; } });
  const [find, setFind] = useState("");
  const go = (p: PageId) => { setPage(p); try { localStorage.setItem(PAGE_KEY, p); } catch { /* ignore */ } };
  const matches = find.trim() ? PAGES.filter((p) => `${p.label} ${p.keywords}`.toLowerCase().includes(find.trim().toLowerCase())) : PAGES;
  useEffect(() => { if (find.trim() && matches.length && !matches.some((m) => m.id === page)) go(matches[0].id); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [find]);

  return (
    <div className="flex h-full">
      <nav className="w-52 shrink-0 border-r bg-sidebar p-3" aria-label="Settings sections">
        <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a setting…" className="mb-3 h-8 w-full rounded-md border bg-background px-2 text-[13px] outline-none focus:border-primary" />
        {matches.map((p) => (
          <button key={p.id} onClick={() => go(p.id)} aria-current={page === p.id ? "page" : undefined}
            className={cn("flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] cursor-pointer", page === p.id ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : "text-muted-foreground hover:bg-secondary hover:text-foreground")}>
            <p.icon className="h-4 w-4" /> {p.label}
          </button>
        ))}
        {!matches.length && <p className="px-2 text-xs text-muted-foreground">No matching settings.</p>}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto custom-scrollbar">
        <div className="mx-auto max-w-5xl px-8 py-7">
          <h1 className="mb-6 text-xl font-semibold">{PAGES.find((p) => p.id === page)?.label}</h1>
          {page === "library" && (
            <div className="grid gap-x-10 gap-y-8 xl:grid-cols-2 [&>*]:min-w-0">
              <LibraryFoldersSection />
              <div className="space-y-8"><FtsSection /><ExportSection /><AboutSection /></div>
            </div>
          )}
          {page === "reading" && (
            <div className="grid gap-x-10 gap-y-8 xl:grid-cols-2 [&>*]:min-w-0">
              <ReadAloudSection />
              <div className="space-y-8"><OcrSection /><ReadingStatsSection /></div>
            </div>
          )}
          {page === "ai" && <div className="max-w-3xl"><AiSection /></div>}
          {page === "sources" && <div className="max-w-4xl space-y-10"><SourcesSection /><GithubSection /></div>}
          {page === "sync" && <div className="grid gap-x-10 gap-y-8 xl:grid-cols-2 [&>*]:min-w-0"><SyncSection /><IntegrationsSection /></div>}
          {page === "browser" && <div className="max-w-3xl"><ConnectorSection /></div>}
        </div>
      </div>
    </div>
  );
}

function LibraryFoldersSection() {
  const [folders, setFolders] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const bump = useApp((s) => s.bumpLibrary);
  const load = () => { api.listWatchFolders().then(setFolders); };
  useEffect(load, []);
  const add = async () => {
    const dir = await openDialog({ directory: true });
    if (typeof dir !== "string") return;
    setBusy(true);
    try { const r = await api.addWatchFolder(dir); toast("Folder added", `${r.added} new books`); load(); } catch (e) { toastError("Could not add folder", e); } finally { setBusy(false); }
  };
  return (
        <section>
      <h2 className="text-base font-semibold">Library folders</h2>
      <p className="mt-1 text-sm text-muted-foreground">Books are indexed where they are. Folders are watched, so new, moved and deleted files are picked up automatically.</p>
      <div className="mt-3 divide-y rounded-lg border bg-card">
        {folders.length === 0 && <p className="p-3 text-sm text-muted-foreground">No folders yet.</p>}
        {folders.map((f) => (
          <div key={f} className="flex items-center gap-2 px-3 py-2 text-[13px]">
            <Folder className="h-4 w-4 text-muted-foreground" />
            <span className="flex-1 truncate" title={f}>{f}</span>
            <button
              onClick={async () => {
                const r = await askForm({ title: "Stop watching this folder?", description: f, okLabel: "Stop watching", fields: [{ key: "remove", label: "Also remove its books from the library (files on disk are not deleted)", type: "checkbox", initial: false }] });
                if (!r) return;
                await api.removeWatchFolder(f, !!r.remove);
                load();
                bump();
              }}
              className="text-muted-foreground hover:text-destructive cursor-pointer" aria-label="Remove folder"
            ><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={add} disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <FolderPlus />} Add folder</Button>
        <Button size="sm" variant="outline" onClick={async () => { setBusy(true); const r = await api.rescan().finally(() => setBusy(false)); toast("Rescanned", `${r.added} new · ${r.moved} moved · ${r.missing} missing`); }}><RefreshCw /> Rescan now</Button>
      </div>
    </section>
  );
}

function ReadAloudSection() {
  return (
        <section>
      <h2 className="text-base font-semibold">Read aloud</h2>
      <p className="mt-1 text-sm text-muted-foreground">Natural voices run entirely on this Mac (Kokoro and Piper via sherpa-onnx). Nothing is sent anywhere. Download one, then pick it in the reader's voice menu.</p>
      <div className="mt-3 rounded-lg border bg-card p-3"><VoicePicker /></div>
      <VoiceInputBox />
    </section>
  );
}

/** Offline speech-recognition models for voice questions while listening. */
function VoiceInputBox() {
  const [models, setModels] = useState<SttModel[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const load = () => sttApi.models().then(setModels).catch(() => {});
  useEffect(() => {
    load();
    let un: (() => void) | undefined, dead = false;
    listen<{ id: string; bytes: number; total: number | null; done: boolean }>("stt_install_progress", (e) => {
      const p = e.payload;
      setProgress((m) => ({ ...m, [p.id]: p.done ? 1 : p.total ? p.bytes / p.total : 0 }));
    }).then((f) => (dead ? f() : (un = f)));
    return () => { dead = true; un?.(); };
  }, []);
  const install = async (id: string) => {
    setProgress((m) => ({ ...m, [id]: 0 }));
    try { await sttApi.install(id); toast("Voice questions ready", "Hold ⌥⇧Space while reading aloud to ask.", "success"); } catch (e) { toastError("Download failed", e); }
    setProgress((m) => { const n = { ...m }; delete n[id]; return n; });
    load();
  };
  return (
    <div className="mt-4">
      <p className="font-medium">Voice questions</p>
      <p className="mt-0.5 text-xs text-muted-foreground">While a book is read aloud, hold <kbd>⌥⇧Space</kbd> (or tap the 🎙 button) and ask a question. Reading pauses, the answer is spoken, then reading continues. Speech is recognised on this Mac; the answer uses your AI provider.</p>
      <div className="mt-2 divide-y rounded-lg border bg-card">
        {models.map((m) => (
          <div key={m.id} className="flex items-center gap-2 px-3 py-2 text-[13px]">
            <div className="min-w-0 flex-1"><p className="font-medium">{m.name}</p><p className="text-xs text-muted-foreground">{m.note} · {m.size_mb} MB</p></div>
            {m.id in progress
              ? <span className="w-24 text-right text-xs tabular-nums text-muted-foreground">{Math.round(progress[m.id] * 100)}%</span>
              : m.installed
                ? <Button size="xs" variant="ghost" onClick={async () => { if (await askConfirm({ title: `Remove ${m.name}?`, okLabel: "Remove", destructive: true })) { await sttApi.uninstall(m.id); load(); } }}>Remove</Button>
                : <Button size="xs" variant="outline" onClick={() => install(m.id)}>Get</Button>}
          </div>
        ))}
      </div>
    </div>
  );
}

function FtsSection() {
  const [fts, setFts] = useState(() => { try { return localStorage.getItem("local-lib-fts") !== "off"; } catch { return true; } });
  return (
        <section>
      <h2 className="text-base font-semibold">Full-text search</h2>
      <label className="mt-2 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={fts} onChange={(e) => { setFts(e.target.checked); try { localStorage.setItem("local-lib-fts", e.target.checked ? "on" : "off"); } catch { /* ignore */ } }} />
        Index book text in the background (restart to apply)
      </label>
    </section>
  );
}

function ReadingStatsSection() {
  const [stats, setStats] = useState<ReadingStats | null>(null);
  useEffect(() => { api.readingStats().then(setStats); }, []);
  return (
        <section>
      <h2 className="text-base font-semibold">Reading</h2>
      {stats && (
        <div className="mt-3 grid grid-cols-4 gap-2">
          {[["Today", fmtTime(stats.today_seconds)], ["All time", fmtTime(stats.total_seconds)], ["Finished", String(stats.books_finished)], ["Streak", `${stats.streak_days} d`]].map(([k, v]) => (
            <div key={k} className="rounded-lg border bg-card p-3"><p className="text-[11px] uppercase tracking-wide text-muted-foreground">{k}</p><p className="mt-1 text-lg font-semibold tabular-nums">{v}</p></div>
          ))}
        </div>
      )}
    </section>
  );
}

function ExportSection() {
  return (
        <section>
      <h2 className="text-base font-semibold">Export library</h2>
      <p className="mt-1 text-sm text-muted-foreground">Bibliography of every book, for Zotero, Mendeley, EndNote or LaTeX.</p>
      <div className="mt-3 flex gap-2">
        {(["bibtex", "ris", "csljson"] as const).map((f) => (
          <Button key={f} size="sm" variant="outline" onClick={async () => {
            const ext = { bibtex: "bib", ris: "ris", csljson: "json" }[f];
            const path = await save({ defaultPath: `library.${ext}` });
            if (!path) return;
            await api.writeTextFile(path, bibliography[f](await api.listBooks({})));
            toastAction("Exported", path, { label: "Show in Finder", onClick: () => import("@tauri-apps/plugin-opener").then((o) => o.revealItemInDir(path)) });
          }}>{f === "csljson" ? "CSL-JSON" : f.toUpperCase()}</Button>
        ))}
      </div>
    </section>
  );
}

function AboutSection() {
  const { version, checking, available, ready, checkedAt } = useUpdater();
  const [auto, setAuto] = useState(autoUpdateEnabled);
  return (
    <section>
      <h2 className="text-base font-semibold">About &amp; updates</h2>
      <div className="mt-3 space-y-2 rounded-lg border bg-card p-3 text-[13px]">
        <div className="flex items-center gap-2">
          <span className="font-medium">Local Lib {version || "…"}</span>
          {available && <span className="rounded-full bg-primary/15 px-2 text-xs text-primary">{available.version} available</span>}
          {ready && <span className="rounded-full bg-primary/15 px-2 text-xs text-primary">Restart to finish updating</span>}
          <span className="ml-auto flex gap-1.5">
            {available
              ? <Button size="xs" onClick={() => installUpdate()}>Update to {available.version}</Button>
              : ready
                ? <Button size="xs" onClick={() => relaunch()}>Restart now</Button>
                : <Button size="xs" variant="outline" loading={checking} onClick={() => checkForUpdates()}>Check for updates</Button>}
          </span>
        </div>
        {checkedAt && !available && !ready && <p className="text-xs text-muted-foreground">Checked {new Date(checkedAt).toLocaleTimeString()}: you have the latest version.</p>}
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={auto} onChange={(e) => { setAuto(e.target.checked); setAutoUpdate(e.target.checked); }} />
          Check for updates automatically (once a day, from GitHub Releases)
        </label>
        <button onClick={() => import("@tauri-apps/plugin-opener").then((o) => o.openUrl("https://github.com/devvspaces/local-lib-on/releases"))} className="text-xs text-primary hover:underline cursor-pointer">Release notes</button>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Local Lib keeps everything on this device: the library database, notes and annotations live in the app data folder; your book files are never modified.</p>
    </section>
  );
}

import { providers as prov, type GithubConfig, type GithubSource, type OpdsCatalog, type ProviderMeta } from "@/lib/providers";

const PRESETS: Omit<OpdsCatalog, "id">[] = [
  { name: "Standard Ebooks", url: "https://standardebooks.org/feeds/opds" },
  { name: "Feedbooks public domain", url: "https://catalog.feedbooks.com/catalog/public_domain.atom" },
  { name: "My Calibre server", url: "http://localhost:8080/opds" },
];

function SourcesSection() {
  const [cats, setCats] = useState<OpdsCatalog[]>([]);
  const [builtins, setBuiltins] = useState<ProviderMeta[]>([]);
  const [draft, setDraft] = useState<Omit<OpdsCatalog, "id">>({ name: "", url: "" });
  useEffect(() => { prov.listOpds().then(setCats); prov.list().then((l) => setBuiltins(l.filter((p) => p.builtin))); }, []);
  const persist = async (next: OpdsCatalog[]) => { await prov.saveOpds(next); setCats(next); };
  return (
    <section>
      <h2 className="text-base font-semibold">Sources</h2>
      <p className="mt-1 text-sm text-muted-foreground">Where Discover and Sync look for books. Add any OPDS catalog, such as Standard Ebooks or your own Calibre content server.</p>
      <div className="mt-3 divide-y rounded-lg border bg-card">
        {builtins.map((b) => (
          <div key={b.id} className="px-3 py-2 text-[13px]"><span className="font-medium">{b.name}</span> <span className="text-xs text-muted-foreground">built-in · {b.description}</span></div>
        ))}
        {cats.map((c) => (
          <div key={c.id} className="flex items-center gap-2 px-3 py-2 text-[13px]">
            <span className="font-medium">{c.name}</span>
            <span className="flex-1 truncate text-xs text-muted-foreground">{c.url}{c.username ? ` · ${c.username}` : ""}</span>
            <button onClick={() => persist(cats.filter((x) => x.id !== c.id))} className="text-muted-foreground hover:text-destructive cursor-pointer" aria-label="Remove source"><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
      </div>
      <form
        className="mt-3 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] [&>input]:min-w-0"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!draft.url.trim()) return;
          const id = (draft.name || new URL(draft.url).hostname).toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + Date.now().toString(36);
          await persist([...cats, { ...draft, id, name: draft.name || new URL(draft.url).hostname, username: draft.username || null, password: draft.password || null }]);
          setDraft({ name: "", url: "" });
          toast("Source added", "Pick it from the provider menu in Discover.");
        }}
      >
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Name" className="h-8 rounded-md border bg-background px-2 text-[13px]" />
        <input value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://…/opds" className="h-8 rounded-md border bg-background px-2 text-[13px]" />
        <input value={draft.username ?? ""} onChange={(e) => setDraft({ ...draft, username: e.target.value })} placeholder="User (optional)" className="h-8 rounded-md border bg-background px-2 text-[13px]" />
        <input type="password" value={draft.password ?? ""} onChange={(e) => setDraft({ ...draft, password: e.target.value })} placeholder="Password" className="h-8 rounded-md border bg-background px-2 text-[13px]" />
        <Button size="sm" type="submit">Add</Button>
      </form>
      <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
        <span className="text-muted-foreground">Presets:</span>
        {PRESETS.map((p) => <button key={p.name} onClick={() => setDraft(p)} className="rounded border px-2 py-0.5 hover:bg-secondary cursor-pointer">{p.name}</button>)}
      </div>
    </section>
  );
}

const GH_PRESETS: Omit<GithubSource, "id">[] = [
  { name: "Free Programming Books", repo: "EbookFoundation/free-programming-books", path: "books/free-programming-books-langs.md", kind: "list" },
  { name: "Free Programming Books (subjects)", repo: "EbookFoundation/free-programming-books", path: "books/free-programming-books-subjects.md", kind: "list" },
];

function GithubSection() {
  const [cfg, setCfg] = useState<GithubConfig>({ sources: [], token: null });
  const [draft, setDraft] = useState<Omit<GithubSource, "id">>({ name: "", repo: "", path: "", kind: "repo" });
  useEffect(() => { prov.getGithub().then(setCfg); }, []);
  const persist = async (next: GithubConfig) => { await prov.saveGithub(next); setCfg(next); };
  return (
    <section>
      <h2 className="text-base font-semibold">GitHub sources</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Add a repository that contains book files (PDF/EPUB…), or a reading list in Markdown such as free-programming-books. They show up in Discover and work with Sync.
      </p>
      <div className="mt-3 divide-y rounded-lg border bg-card">
        {cfg.sources.length === 0 && <p className="p-3 text-sm text-muted-foreground">No GitHub sources yet.</p>}
        {cfg.sources.map((s) => (
          <div key={s.id} className="flex items-center gap-2 px-3 py-2 text-[13px]">
            <span className="rounded bg-secondary px-1.5 text-[10px] uppercase">{s.kind}</span>
            <span className="font-medium">{s.name}</span>
            <span className="flex-1 truncate text-xs text-muted-foreground">{s.repo}{s.path ? ` / ${s.path}` : ""}{s.branch ? ` @ ${s.branch}` : ""}</span>
            <button onClick={() => persist({ ...cfg, sources: cfg.sources.filter((x) => x.id !== s.id) })} className="text-muted-foreground hover:text-destructive cursor-pointer" aria-label="Remove source"><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
      </div>
      <form
        className="mt-3 grid grid-cols-[110px_minmax(0,1fr)] gap-2 lg:grid-cols-[110px_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1fr)_auto] [&>input]:min-w-0"
        onSubmit={async (e) => {
          e.preventDefault();
          const repo = draft.repo.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
          if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { toast("Use owner/repo", "e.g. EbookFoundation/free-programming-books", "error"); return; }
          const id = repo.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + Date.now().toString(36);
          await persist({ ...cfg, sources: [...cfg.sources, { ...draft, repo, id, name: draft.name || repo, path: draft.path || null }] });
          setDraft({ name: "", repo: "", path: "", kind: "repo" });
          toast("GitHub source added", "Pick it from the provider menu in Discover.");
        }}
      >
        <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as GithubSource["kind"] })} className="h-8 rounded-md border bg-background px-2 text-[13px]">
          <option value="repo">Repo files</option><option value="list">Reading list</option>
        </select>
        <input value={draft.repo} onChange={(e) => setDraft({ ...draft, repo: e.target.value })} placeholder="owner/repo" className="h-8 rounded-md border bg-background px-2 text-[13px]" />
        <input value={draft.path ?? ""} onChange={(e) => setDraft({ ...draft, path: e.target.value })} placeholder={draft.kind === "list" ? "README.md or path/to/list.md" : "folder (optional)"} className="h-8 rounded-md border bg-background px-2 text-[13px]" />
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Name" className="h-8 rounded-md border bg-background px-2 text-[13px]" />
        <Button size="sm" type="submit">Add</Button>
      </form>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
        <span className="text-muted-foreground">Presets:</span>
        {GH_PRESETS.map((p) => <button key={p.name} onClick={() => setDraft(p)} className="rounded border px-2 py-0.5 hover:bg-secondary cursor-pointer">{p.name}</button>)}
      </div>
      <label className="mt-4 block text-xs text-muted-foreground">
        <span className="block">Personal access token (optional, raises the 60 requests/hour limit; public read-only scope is enough)</span>
        <input type="password" defaultValue={cfg.token ?? ""} onBlur={async (e) => { const t = e.target.value || null; if (t === (cfg.token ?? null)) return; await persist({ ...cfg, token: t }); toast(t ? "Token saved" : "Token removed"); }} placeholder="ghp_…" className="mt-1.5 h-8 w-full max-w-sm rounded-md border bg-background px-2 text-[13px]" />
      </label>
    </section>
  );
}

import { ANTHROPIC_MODELS, llm, streamChat, type LlmConfig } from "@/lib/assistant";

const OPENAI_PRESETS = [
  { label: "Ollama (local)", base_url: "http://localhost:11434/v1", model: "llama3.1" },
  { label: "LM Studio (local)", base_url: "http://localhost:1234/v1", model: "local-model" },
  { label: "OpenAI", base_url: "https://api.openai.com/v1", model: "" },
  { label: "OpenRouter", base_url: "https://openrouter.ai/api/v1", model: "" },
];

function AiSection() {
  const [cfg, setCfg] = useState<LlmConfig | null>(null);
  const [key, setKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  useEffect(() => { llm.getConfig().then(setCfg); }, []);
  const loadModels = async () => {
    setLoadingModels(true);
    try {
      const m = await llm.listModels();
      setModels(m);
      if (cfg && m.length && !m.some((x) => x.id === cfg.model)) await save({ ...cfg, model: m[0].id });
      if (!m.length) toast("No models found", "Check the key or endpoint.");
    } catch (e) { toastError("Could not load models", e); } finally { setLoadingModels(false); }
  };
  useEffect(() => { if (cfg?.provider === "gemini" && cfg.has_key && !models.length) loadModels(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [cfg?.provider, cfg?.has_key]);
  if (!cfg) return null;
  const save = async (next: LlmConfig, k?: string) => {
    await llm.saveConfig(next, k);
    setCfg(await llm.getConfig());
  };
  const test = async () => {
    setTesting(true);
    let text = "";
    await streamChat([{ role: "user", content: "Reply with exactly: OK" }], (t) => (text += t), (r) => {
      setTesting(false);
      if (r.error) toastError("Connection failed", r.error);
      else toast("Connected", `${r.model ?? cfg.model} replied: ${text.trim().slice(0, 40)}`, "success");
    }, "You are a connection test. Follow the instruction exactly.");
  };
  const input = "h-8 rounded-md border bg-background px-2 text-[13px]";
  return (
    <section>
      <h2 className="text-base font-semibold">AI assistant</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Bring your own model. The assistant answers questions about your books, citing the passages it used. Only the retrieved excerpts, your selection and your question are sent. Keys are stored in the macOS Keychain.
      </p>
      <div className="mt-3 space-y-3 rounded-lg border bg-card p-3 text-[13px]">
        <div className="flex flex-wrap gap-1">
          {(["anthropic", "gemini", "openai"] as const).map((p) => (
            <button key={p} onClick={() => { setModels([]); save({ ...cfg, provider: p, model: p === "anthropic" ? "claude-opus-5-5" : p === "gemini" ? "" : cfg.provider === "openai" ? cfg.model : "llama3.1", base_url: p === "openai" ? cfg.base_url ?? "http://localhost:11434/v1" : null }); }}
              className={`rounded-md border px-3 py-1 cursor-pointer ${cfg.provider === p ? "border-primary bg-accent" : "hover:bg-secondary"}`}>
              {p === "anthropic" ? "Anthropic (Claude)" : p === "gemini" ? "Google Gemini (AI Studio key)" : "OpenAI-compatible (Ollama, LM Studio, OpenAI…)"}
            </button>
          ))}
        </div>
        {cfg.provider === "gemini" ? (
          <div className="grid grid-cols-[110px_1fr_auto] items-center gap-2">
            <span className="text-muted-foreground">Model</span>
            <select value={cfg.model} onChange={(e) => save({ ...cfg, model: e.target.value })} className={input} disabled={!models.length}>
              {!models.length && <option value={cfg.model}>{cfg.model || (cfg.has_key ? "Load models →" : "Save your key first")}</option>}
              {models.map((m) => <option key={m.id} value={m.id}>{m.label} ({m.id})</option>)}
            </select>
            <Button size="xs" variant="outline" disabled={!cfg.has_key || loadingModels} onClick={loadModels}>{loadingModels ? <Loader2 className="animate-spin" /> : "Load models"}</Button>
            <span />
            <p className="col-span-2 text-xs text-muted-foreground">Create a free key at <button className="text-primary hover:underline cursor-pointer" onClick={() => import("@tauri-apps/plugin-opener").then((o) => o.openUrl("https://aistudio.google.com/apikey"))}>aistudio.google.com/apikey</button>, save it below, then load the models your key can use.</p>
          </div>
        ) : cfg.provider === "anthropic" ? (
          <div className="grid grid-cols-[110px_1fr] items-center gap-2">
            <span className="text-muted-foreground">Model</span>
            <select value={cfg.model} onChange={(e) => save({ ...cfg, model: e.target.value })} className={input}>
              {ANTHROPIC_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            <span className="text-muted-foreground">Effort</span>
            <select value={cfg.effort ?? "medium"} onChange={(e) => save({ ...cfg, effort: e.target.value })} className={input}>
              {["low", "medium", "high", "xhigh", "max"].map((x) => <option key={x} value={x}>{x}{x === "medium" ? " (default; balanced)" : x === "low" ? " (fastest, cheapest)" : ""}</option>)}
            </select>
            <span className="text-muted-foreground">Fallback</span>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={cfg.fallbacks} onChange={(e) => save({ ...cfg, fallbacks: e.target.checked })} /> If Claude declines a request, retry automatically on Anthropic's recommended fallback model</label>
          </div>
        ) : (
          <div className="grid grid-cols-[110px_1fr] items-center gap-2">
            <span className="text-muted-foreground">Base URL</span>
            <input defaultValue={cfg.base_url ?? ""} key={cfg.base_url ?? ""} onBlur={(e) => save({ ...cfg, base_url: e.target.value })} placeholder="http://localhost:11434/v1" className={input} />
            <span className="text-muted-foreground">Model</span>
            <input defaultValue={cfg.model} key={cfg.model} onBlur={(e) => save({ ...cfg, model: e.target.value })} placeholder="llama3.1, gpt-4o-mini, …" className={input} />
            <span className="text-muted-foreground">Presets</span>
            <div className="flex flex-wrap gap-1">{OPENAI_PRESETS.map((p) => <button key={p.label} onClick={() => save({ ...cfg, base_url: p.base_url, model: p.model || cfg.model })} className="rounded border px-2 py-0.5 text-xs hover:bg-secondary cursor-pointer">{p.label}</button>)}</div>
          </div>
        )}
        <div className="grid grid-cols-[110px_1fr_auto_auto] items-center gap-2">
          <span className="text-muted-foreground">API key</span>
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={cfg.has_key ? "•••••••• saved in Keychain" : cfg.provider === "anthropic" ? "sk-ant-…" : cfg.provider === "gemini" ? "AIza…" : "optional for local models"} className={input} />
          <Button size="sm" variant="outline" disabled={!key} onClick={async () => { await save(cfg, key); setKey(""); toast("Key saved", "Stored in the macOS Keychain"); }}>Save key</Button>
          {cfg.has_key && <Button size="sm" variant="ghost" onClick={async () => { await llm.clearKey(cfg.provider === "openai" ? "openai" : cfg.provider); setCfg(await llm.getConfig()); }}>Remove</Button>}
        </div>
        <EmbeddingsBox />
        <Button size="sm" onClick={test} disabled={testing || (cfg.provider === "gemini" && !cfg.model)}>{testing ? <Loader2 className="animate-spin" /> : null} Test connection</Button>
      </div>
    </section>
  );
}

import { connectorApi, type ConnectorConfig } from "@/lib/connectorSave";

function ConnectorSection() {
  const [c, setC] = useState<ConnectorConfig | null>(null);
  const [shortcut, setShortcut] = useState("");
  useEffect(() => { connectorApi.get().then((x) => { setC(x); setShortcut(x.cite_shortcut ?? ""); }); }, []);
  if (!c) return null;
  const save = async (next: ConnectorConfig, regen = false) => setC(await connectorApi.save(next, regen).catch((e) => { toastError("Could not apply", e); return c; }));
  return (
    <section>
      <h2 className="text-base font-semibold">Browser connector &amp; citing</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Save papers and books from your browser in one click. Install the extension from the <code>extension/</code> folder (see its README), then paste this token into it once.
      </p>
      <div className="mt-3 space-y-3 rounded-lg border bg-card p-3 text-[13px]">
        <label className="flex items-center gap-2"><input type="checkbox" checked={c.enabled} onChange={(e) => save({ ...c, enabled: e.target.checked })} /> Enable connector on 127.0.0.1:{c.port}</label>
        <div className="flex items-center gap-2">
          <span className="w-24 text-muted-foreground">Token</span>
          <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs" data-selectable>{c.token}</code>
          <Button size="xs" variant="outline" onClick={async () => { await navigator.clipboard.writeText(c.token); toast("Token copied"); }}>Copy</Button>
          <Button size="xs" variant="ghost" onClick={() => save(c, true)}>Regenerate</Button>
        </div>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5" checked={c.zotero_mode} onChange={(e) => save({ ...c, zotero_mode: e.target.checked })} />
          <span>Zotero-compatible mode: lets the official <b>Zotero Connector</b> extension save into Local Lib. <span className="text-muted-foreground">Uses Zotero's port 23119, so it only works while the Zotero app is closed.</span></span>
        </label>
        <div className="border-t pt-3">
          <p className="mb-2 font-medium">Cite while you write</p>
          <div className="flex items-center gap-2">
            <span className="w-24 text-muted-foreground">Hotkey</span>
            <input value={shortcut} onChange={(e) => setShortcut(e.target.value)} onBlur={() => save({ ...c, cite_shortcut: shortcut })} placeholder="Alt+Super+C" className="h-8 w-48 rounded-md border bg-background px-2 text-[13px]" />
            <span className="text-xs text-muted-foreground">Super = ⌘, Alt = ⌥</span>
            <Button size="xs" variant="outline" className="ml-auto" onClick={() => connectorApi.openCite()}>Open palette</Button>
          </div>
          <label className="mt-2 flex items-start gap-2">
            <input type="checkbox" className="mt-0.5" checked={c.auto_paste} onChange={(e) => save({ ...c, auto_paste: e.target.checked })} />
            <span>Paste the citation into the app I was writing in. <span className="text-muted-foreground">macOS will ask to allow Local Lib under Privacy &amp; Security → Accessibility. Otherwise the citation is just copied.</span></span>
          </label>
          <p className="mt-2 text-xs text-muted-foreground">Works in Word, Pages, Google Docs, Obsidian… Each citation is added to a bibliography basket; “Copy bibliography” in the palette pastes the full reference list in your chosen style.</p>
        </div>
      </div>
    </section>
  );
}

import type { EmbedStatus } from "@/lib/assistant";
import { syncApi, type SyncConfig, type SyncReport, type Target } from "@/lib/cloudsync";

function SyncSection() {
  const [c, setC] = useState<SyncConfig | null>(null);
  const [status, setStatus] = useState<SyncReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [backups, setBackups] = useState<string[] | null>(null);
  useEffect(() => { syncApi.get().then(setC); syncApi.status().then(setStatus); }, []);
  if (!c) return null;
  const save = async (next: SyncConfig) => { setC(next); await syncApi.save(next).catch((e) => toastError("Could not save", e)); };
  const kind = c.target?.kind ?? "folder";
  const run = async (what: "sync" | "backup") => {
    setBusy(what);
    try {
      if (what === "sync") { const r = await syncApi.now(); setStatus(r); toast("Synced", `${r.pulled_devices} device(s) · ${r.applied} updates · ${r.deleted} deletions${r.conflicts ? ` · ${r.conflicts} conflict copies` : ""}`, "success"); }
      else { const n = await syncApi.backup(); toast("Backup saved", n, "success"); setBackups(null); }
    } catch (e) { toastError(what === "sync" ? "Sync failed" : "Backup failed", e); } finally { setBusy(null); }
  };
  const field = "h-8 rounded-md border bg-background px-2 text-[13px]";
  const setTarget = (t: Target | null) => save({ ...c, target: t });
  return (
    <section>
      <h2 className="text-base font-semibold">Sync &amp; backup</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Keep notes, highlights, progress, collections, tags and flashcards in sync across your devices, and back up your library database. Point it at a folder that iCloud Drive, Dropbox, Google Drive or OneDrive syncs, or at a WebDAV server (Nextcloud, Synology…).
      </p>
      <div className="mt-3 space-y-3 rounded-lg border bg-card p-3 text-[13px]">
        <div className="flex flex-wrap gap-1">
          {(["folder", "dropbox", "onedrive", "gdrive", "webdav"] as const).map((k) => {
            const on = k === "folder" || k === "webdav" ? kind === k : c.target?.kind === "cloud" && c.target.cloud === k;
            const label = { folder: "Cloud folder", dropbox: "Dropbox", onedrive: "OneDrive", gdrive: "Google Drive", webdav: "WebDAV" }[k];
            return (
              <button key={k} onClick={() => setTarget(k === "folder" ? { kind: "folder", path: c.target?.kind === "folder" ? c.target.path : "" } : k === "webdav" ? { kind: "webdav", url: "", username: "", password: "" } : { kind: "cloud", cloud: k, client_id: c.target?.kind === "cloud" && c.target.cloud === k ? c.target.client_id : "", client_secret: null })}
                className={`rounded-md border px-3 py-1 cursor-pointer ${on ? "border-primary bg-accent" : "hover:bg-secondary"}`}>{label}</button>
            );
          })}
        </div>
        {c.target?.kind === "cloud" && <CloudAccount target={c.target} onChange={(t) => setTarget(t)} />}
        {kind === "cloud" ? null : kind === "folder" ? (
          <div className="flex items-center gap-2">
            <span className="w-24 text-muted-foreground">Folder</span>
            <span className="flex-1 truncate text-xs" title={c.target?.kind === "folder" ? c.target.path : ""}>{c.target?.kind === "folder" && c.target.path ? c.target.path : "Not set"}</span>
            <Button size="xs" variant="outline" onClick={async () => {
              const d = await openDialog({ directory: true, title: "Choose a folder inside iCloud Drive, Dropbox, Google Drive or OneDrive" });
              if (typeof d === "string") setTarget({ kind: "folder", path: d.endsWith("Local Lib") ? d : `${d}/Local Lib` });
            }}>Choose…</Button>
            {c.target?.kind === "folder" && c.target.path && <Button size="xs" variant="ghost" onClick={() => revealSyncFolder(c.target as Extract<Target, { kind: "folder" }>)}><FolderOpen /> Show in Finder</Button>}
          </div>
        ) : c.target?.kind === "webdav" && (
          <div className="grid grid-cols-[96px_1fr] items-center gap-2">
            <span className="text-muted-foreground">Server URL</span>
            <input defaultValue={c.target.url} onBlur={(e) => setTarget({ ...(c.target as Extract<Target, { kind: "webdav" }>), url: e.target.value.trim() })} placeholder="https://cloud.example.com/remote.php/dav/files/me/LocalLib" className={field} />
            <span className="text-muted-foreground">Username</span>
            <input defaultValue={c.target.username} onBlur={(e) => setTarget({ ...(c.target as Extract<Target, { kind: "webdav" }>), username: e.target.value })} className={field} />
            <span className="text-muted-foreground">Password</span>
            <input type="password" defaultValue={c.target.password} onBlur={(e) => setTarget({ ...(c.target as Extract<Target, { kind: "webdav" }>), password: e.target.value })} placeholder="app password (stored in Keychain)" className={field} />
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="w-24 text-muted-foreground">This device</span>
          <input defaultValue={c.device_name} onBlur={(e) => save({ ...c, device_name: e.target.value || "This Mac" })} className={`${field} w-48`} />
        </div>
        <label className="flex items-center gap-2"><input type="checkbox" checked={c.enabled} disabled={!c.target} onChange={(e) => save({ ...c, enabled: e.target.checked })} /> Sync automatically (on launch and every 10 minutes)</label>
        <EncryptionRow config={c} onDone={async () => setC(await syncApi.get())} />
        <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={c.sync_files} onChange={(e) => save({ ...c, sync_files: e.target.checked })} /> <span>Also sync book files <span className="text-muted-foreground">(each file is stored once by content; other devices download books they don't have into their Downloads folder)</span></span></label>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => run("sync")} disabled={!c.target || !!busy}>{busy === "sync" ? <Loader2 className="animate-spin" /> : <RefreshCw />} Sync now</Button>
          <span className="text-xs text-muted-foreground">
            {status ? (status.error ? <span className="text-destructive">Last sync failed: {status.error}</span> : `Last sync ${new Date(status.at).toLocaleString()} · ${status.applied} updates from ${status.pulled_devices} device(s)`) : "Never synced"}
          </span>
        </div>
        <div className="border-t pt-3">
          <p className="mb-2 font-medium">Backups</p>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2"><input type="checkbox" checked={c.backup_daily} onChange={(e) => save({ ...c, backup_daily: e.target.checked })} /> Daily backup</label>
            <label className="flex items-center gap-1 text-xs text-muted-foreground">keep last <input type="number" min={1} value={c.backup_keep} onChange={(e) => save({ ...c, backup_keep: Number(e.target.value) || 10 })} className="h-7 w-14 rounded border bg-background px-1 text-foreground" /></label>
            <Button size="xs" variant="outline" onClick={() => run("backup")} disabled={!c.target || !!busy}>{busy === "backup" ? <Loader2 className="animate-spin" /> : null} Back up now</Button>
            <Button size="xs" variant="ghost" disabled={!c.target} onClick={async () => setBackups(await syncApi.backups().catch((e) => { toastError("Could not list backups", e); return []; }))}>Restore…</Button>
            {c.target && <Button size="xs" variant="ghost" onClick={() => openSyncLocation(c.target!, "backups")}><FolderOpen /> {c.target.kind === "folder" ? "Show backups in Finder" : "Open in browser"}</Button>}
          </div>
          {backups && (
            <div className="mt-2 max-h-40 overflow-y-auto rounded-md border custom-scrollbar">
              {!backups.length && <p className="p-2 text-xs text-muted-foreground">No backups found.</p>}
              {backups.map((b) => (
                <div key={b} className="flex items-center gap-2 border-b px-2 py-1 text-xs last:border-0">
                  <span className="flex-1 font-mono">{b}</span>
                  <Button size="xs" variant="outline" onClick={async () => {
                    if (!(await askConfirm({ title: `Restore ${b}?`, description: "Your current library database is kept as a copy, and the app restarts. Book files are not touched.", okLabel: "Restore and restart", destructive: true }))) return;
                    await syncApi.restore(b).catch((e) => toastError("Restore failed", e));
                  }}>Restore</Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

import { OCR_LANGS, ocrPrefs, visionLanguages, type OcrEngine } from "@/lib/ocr";

function OcrSection() {
  const [p, setP] = useState(ocrPrefs.get());
  const [vision, setVision] = useState<string[]>([]);
  useEffect(() => { visionLanguages().then(setVision); }, []);
  const set = (x: Partial<typeof p>) => { ocrPrefs.set(x); setP({ ...p, ...x }); };
  return (
    <section>
      <h2 className="text-base font-semibold">OCR (scanned books)</h2>
      <p className="mt-1 text-sm text-muted-foreground">Makes image-only PDFs searchable and selectable. Everything runs on this Mac.</p>
      <div className="mt-3 grid grid-cols-[110px_1fr] items-center gap-2 rounded-lg border bg-card p-3 text-[13px]">
        <span className="text-muted-foreground">Engine</span>
        <select value={p.engine} onChange={(e) => set({ engine: e.target.value as OcrEngine })} className="h-8 rounded-md border bg-background px-2">
          <option value="auto">Auto: Apple Vision (fast, accurate) on macOS{vision.length ? ` · ${vision.length} languages` : ""}</option>
          <option value="tesseract">Tesseract (works everywhere, more languages)</option>
        </select>
        <span className="text-muted-foreground">Language</span>
        <select value={p.lang} onChange={(e) => set({ lang: e.target.value })} className="h-8 rounded-md border bg-background px-2">
          {OCR_LANGS.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
        <span />
        <p className="text-xs text-muted-foreground">Tesseract downloads other languages the first time they're used (a few MB each).</p>
      </div>
    </section>
  );
}

import { embedApi, type EmbedConfig } from "@/lib/assistant";

function EmbeddingsBox() {
  const [c, setC] = useState<EmbedConfig | null>(null);
  const [st, setSt] = useState<EmbedStatus | null>(null);
  useEffect(() => {
    embedApi.get().then(setC);
    const poll = () => embedApi.status().then(setSt).catch(() => {});
    poll();
    const t = setInterval(poll, 4000);
    return () => clearInterval(t);
  }, []);
  if (!c) return null;
  const save = async (n: EmbedConfig) => { setC(n); await embedApi.save(n); };
  const field = "h-8 rounded-md border bg-background px-2 text-[13px]";
  return (
    <div className="space-y-2 border-t pt-3">
      <p className="font-medium">Semantic search (embeddings)</p>
      <p className="text-xs text-muted-foreground">Optional. Lets search and the assistant find passages by meaning. Use a local model with Ollama (<code>ollama pull nomic-embed-text</code>, nothing leaves your Mac) or Gemini. Anthropic doesn't offer embeddings.</p>
      <div className="grid grid-cols-[110px_1fr] items-center gap-2">
        <span className="text-muted-foreground">Provider</span>
        <select value={c.provider} onChange={(e) => save({ ...c, provider: e.target.value as EmbedConfig["provider"], model: e.target.value === "gemini" ? "gemini-embedding-001" : "nomic-embed-text", base_url: e.target.value === "gemini" ? null : c.base_url ?? "http://localhost:11434/v1" })} className={field}>
          <option value="openai">Local / OpenAI-compatible (Ollama, LM Studio, OpenAI)</option>
          <option value="gemini">Google Gemini (uses your AI Studio key)</option>
        </select>
        {c.provider === "openai" && <><span className="text-muted-foreground">Base URL</span><input defaultValue={c.base_url ?? ""} onBlur={(e) => save({ ...c, base_url: e.target.value })} className={field} /></>}
        <span className="text-muted-foreground">Model</span>
        <input defaultValue={c.model} key={c.model} onBlur={(e) => save({ ...c, model: e.target.value.trim() })} className={field} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2"><input type="checkbox" checked={c.enabled} onChange={(e) => save({ ...c, enabled: e.target.checked })} /> Index my books in the background</label>
        <Button size="xs" variant="outline" onClick={async () => { try { const d = await embedApi.test(); toast("Embeddings work", `${d}-dimensional vectors`, "success"); } catch (e) { toastError("Embedding test failed", e); } }}>Test</Button>
      </div>
      {st && c.enabled && (
        <div className="space-y-0.5 text-xs text-muted-foreground" aria-live="polite">
          <p>{st.books_done} of {st.books_total} books done · {st.chunks.toLocaleString()} passages embedded{st.current_book ? <> · now: <span className="text-foreground">{st.current_book}</span></> : ""}</p>
          {st.books_total === 0 && <p>Books need full-text indexing first (Settings → Library → Full-text search).</p>}
          {st.last_error && <p className="text-destructive">{st.last_error}</p>}
        </div>
      )}
    </div>
  );
}

import { invoke as invokeCmd } from "@tauri-apps/api/core";
import type { CloudName } from "@/lib/cloudsync";

const CLOUD_HELP: Record<CloudName, string> = {
  dropbox: "Create an app at dropbox.com/developers (App folder access), add redirect http://127.0.0.1 and paste its App key.",
  onedrive: "Register an app in Azure (personal accounts, public client, redirect http://localhost) and paste its Application (client) ID.",
  gdrive: "Create an OAuth client of type “Desktop app” in Google Cloud Console (enable the Drive API) and paste its client ID and secret.",
};

function CloudAccount({ target, onChange }: { target: Extract<Target, { kind: "cloud" }>; onChange: (t: Target) => void }) {
  const [signed, setSigned] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { syncApi.cloudStatus(target.cloud).then(setSigned); }, [target.cloud]);
  const field = "h-8 rounded-md border bg-background px-2 text-[13px]";
  return (
    <div className="space-y-2 rounded-md border p-2">
      <p className="text-xs text-muted-foreground">{CLOUD_HELP[target.cloud]} Full steps are in <code>docs/cloud-setup.md</code>. Files go into a private “Local Lib” app folder.</p>
      <div className="grid grid-cols-[96px_1fr] items-center gap-2">
        <span className="text-muted-foreground">Client ID</span>
        <input defaultValue={target.client_id} key={target.cloud} onBlur={(e) => onChange({ ...target, client_id: e.target.value.trim() })} className={field} />
        {target.cloud === "gdrive" && <><span className="text-muted-foreground">Client secret</span><input type="password" defaultValue={target.client_secret ?? ""} onBlur={(e) => onChange({ ...target, client_secret: e.target.value.trim() })} placeholder="Desktop app clients have one; it isn't truly secret" className={field} /></>}
      </div>
      <div className="flex items-center gap-2">
        {signed ? (
          <><span className="text-xs text-primary">Signed in ✓</span><Button size="xs" variant="ghost" onClick={async () => { await syncApi.signOut(target.cloud); setSigned(false); }}>Sign out</Button></>
        ) : (
          <Button size="xs" disabled={!target.client_id || busy} onClick={async () => {
            setBusy(true);
            try { await syncApi.signIn(target.cloud, target.client_id, target.client_secret); setSigned(true); toast("Signed in", "Your browser can be closed."); }
            catch (e) { toastError("Sign-in failed", e); } finally { setBusy(false); }
          }}>{busy ? <Loader2 className="animate-spin" /> : null} Sign in with browser</Button>
        )}
      </div>
    </div>
  );
}

function EncryptionRow({ config, onDone }: { config: SyncConfig; onDone: () => void }) {
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="rounded-md border p-2">
      <p className="text-[13px] font-medium">End-to-end encryption {config.encrypted && <span className="text-primary">· on</span>}</p>
      <p className="mb-2 text-xs text-muted-foreground">Everything is encrypted on this device before upload (Argon2id + XChaCha20-Poly1305). The cloud only sees ciphertext. Use the same passphrase on each device. If you forget it, the synced copy can't be recovered.</p>
      <div className="flex items-center gap-2">
        <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={config.encrypted ? "Re-enter passphrase on this device" : "Choose a passphrase (8+ characters)"} className="h-8 flex-1 rounded-md border bg-background px-2 text-[13px]" />
        <Button size="xs" disabled={!config.target || pass.length < 8 || busy} onClick={async () => {
          setBusy(true);
          try { const created = await syncApi.setPassphrase(pass); setPass(""); toast(created ? "Encryption turned on" : "Unlocked", created ? "This location is now encrypted." : "This device can read the encrypted library."); onDone(); }
          catch (e) { toastError("Encryption", e); } finally { setBusy(false); }
        }}>{config.encrypted ? "Unlock" : "Turn on"}</Button>
      </div>
    </div>
  );
}

interface KoConfig { enabled: boolean; server: string; username: string; device: string }

function IntegrationsSection() {
  const [ko, setKo] = useState<KoConfig | null>(null);
  const [hasPw, setHasPw] = useState(false);
  const [hasRw, setHasRw] = useState(false);
  const [pw, setPw] = useState("");
  const [rw, setRw] = useState("");
  const load = () => invokeCmd<{ koreader: KoConfig; koreader_has_password: boolean; readwise_has_token: boolean }>("get_integrations").then((r) => { setKo({ ...r.koreader, server: r.koreader.server || "https://sync.koreader.rocks" }); setHasPw(r.koreader_has_password); setHasRw(r.readwise_has_token); });
  useEffect(() => { load(); }, []);
  if (!ko) return null;
  const field = "h-8 rounded-md border bg-background px-2 text-[13px]";
  return (
    <section>
      <h2 className="text-base font-semibold">Integrations</h2>
      <div className="mt-3 space-y-3 rounded-lg border bg-card p-3 text-[13px]">
        <div>
          <p className="font-medium">KOReader progress sync</p>
          <p className="mb-2 text-xs text-muted-foreground">Keeps your reading position in step with KOReader on an e-reader (same file on both). Uses KOReader's sync server, or your own.</p>
          <div className="grid grid-cols-[96px_1fr] items-center gap-2">
            <span className="text-muted-foreground">Server</span><input defaultValue={ko.server} onBlur={(e) => setKo({ ...ko, server: e.target.value.trim() })} className={field} />
            <span className="text-muted-foreground">Username</span><input defaultValue={ko.username} onBlur={(e) => setKo({ ...ko, username: e.target.value.trim() })} className={field} />
            <span className="text-muted-foreground">Password</span><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={hasPw ? "•••••• saved" : ""} className={field} />
          </div>
          <div className="mt-2 flex items-center gap-2">
            <label className="flex items-center gap-2"><input type="checkbox" checked={ko.enabled} onChange={(e) => setKo({ ...ko, enabled: e.target.checked })} /> Enabled</label>
            <Button size="xs" onClick={async () => { try { await invokeCmd("save_koreader", { config: ko, password: pw || null }); setPw(""); toast("KOReader sync saved", ko.enabled ? "Login verified" : undefined, "success"); load(); } catch (e) { toastError("KOReader sync", e); } }}>Save</Button>
          </div>
        </div>
        <div className="border-t pt-3">
          <p className="font-medium">Readwise</p>
          <p className="mb-2 text-xs text-muted-foreground">Send your highlights (with notes and tags) to Readwise. Already-sent highlights are skipped. Get a token at readwise.io/access_token.</p>
          <div className="flex items-center gap-2">
            <input type="password" value={rw} onChange={(e) => setRw(e.target.value)} placeholder={hasRw ? "•••••• token saved" : "Readwise access token"} className={`${field} flex-1`} />
            <Button size="xs" variant="outline" disabled={!rw} onClick={async () => { try { await invokeCmd("save_readwise_token", { token: rw }); setRw(""); setHasRw(true); toast("Readwise connected", undefined, "success"); } catch (e) { toastError("Readwise", e); } }}>Save</Button>
            <Button size="xs" disabled={!hasRw} onClick={async () => { try { const n = await invokeCmd<number>("readwise_export", { bookId: null }); toast(n ? `Sent ${n} highlights to Readwise` : "Nothing new to send"); } catch (e) { toastError("Readwise export", e); } }}>Send highlights</Button>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Reveal the sync folder (or a subfolder) in Finder; falls back to the parent when it doesn't exist yet. */
async function revealSyncFolder(t: Extract<Target, { kind: "folder" }>, sub?: string) {
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  const base = t.path.replace(/\/+$/, "");
  for (const p of [sub ? `${base}/${sub}` : null, base, base.slice(0, base.lastIndexOf("/"))]) {
    if (!p) continue;
    try { await revealItemInDir(p); return; } catch { /* try the next one */ }
  }
  toastError("Folder not found", "Run Sync now or Back up now once to create it.");
}

const CLOUD_WEB: Record<string, string> = {
  dropbox: "https://www.dropbox.com/home/Apps",
  onedrive: "https://onedrive.live.com/?id=root",
  gdrive: "https://drive.google.com/drive/search?q=%22Local%20Lib%22",
};
async function openSyncLocation(t: Target, sub?: string) {
  if (t.kind === "folder") return revealSyncFolder(t, sub);
  const url = t.kind === "webdav" ? t.url : CLOUD_WEB[t.cloud];
  if (url) (await import("@tauri-apps/plugin-opener")).openUrl(url);
}
