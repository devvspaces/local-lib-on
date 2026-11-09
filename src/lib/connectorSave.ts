// Handles items sent by the browser extension (or the Zotero Connector in compat mode):
// resolve metadata from identifiers, then download the open-access PDF or save a reference entry.
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { api, type BookPatch } from "@/lib/api";
import { lookupDOI, lookupISBN } from "@/lib/metadataLookup";
import { providers, type RemoteBook } from "@/lib/providers";
import { toast } from "@/components/ui/toast";
import { autoIdentify, weakTitle } from "@/lib/identify";

export interface SaveRequest {
  url?: string | null; title?: string | null; authors: string[]; doi?: string | null; isbn?: string | null; arxiv?: string | null;
  pdf_url?: string | null; year?: number | null; publisher?: string | null; abstract_text?: string | null; collection_id?: number | null; source: string;
}
export interface ConnectorConfig { enabled: boolean; zotero_mode: boolean; token: string; port: number; cite_shortcut?: string | null; auto_paste: boolean }

export const connectorApi = {
  get: () => invoke<ConnectorConfig>("get_connector_config"),
  save: (config: ConnectorConfig, regenerateToken = false) => invoke<ConnectorConfig>("save_connector_config", { config, regenerateToken }),
  openCite: () => invoke<void>("show_cite_palette"),
};

const pendingCollections = new Map<string, number>(); // download id → collection
const pendingIdentify = new Set<string>(); // download ids whose metadata needs identifying after import

async function handle(req: SaveRequest) {
  let meta: BookPatch = { title: req.title ?? undefined, authors: req.authors?.length ? req.authors : undefined, year: req.year ?? undefined, publisher: req.publisher ?? undefined, description: req.abstract_text ?? undefined, doi: req.doi ?? undefined, isbn: req.isbn ?? undefined };
  const ids: [string, string][] = [];
  let pdf = req.pdf_url ?? null;
  try {
    if (req.arxiv) {
      const b = await providers.details("arxiv", req.arxiv);
      meta = { ...meta, title: b.title, authors: b.authors.map((a) => a.name), year: b.year ?? undefined, description: b.description ?? undefined, doi: b.doi ?? meta.doi, publisher: "arXiv" };
      pdf ??= b.files[0]?.url ?? null;
      ids.push(["arxiv", req.arxiv]);
    } else if (req.doi) {
      const m = await lookupDOI(req.doi);
      if (m) meta = { ...meta, ...Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined && v !== null && v !== "")) };
      ids.push(["doi", req.doi.toLowerCase()]);
    } else if (req.isbn) {
      const m = await lookupISBN(req.isbn);
      if (m) { const { coverUrl: _c, subjects: _s, ...f } = m; meta = { ...meta, ...f }; }
    }
  } catch { /* keep page metadata */ }
  if (!meta.title) meta.title = req.url ?? "Untitled";

  if (pdf) {
    const remote: RemoteBook = {
      provider: req.arxiv ? "arxiv" : "web", id: req.arxiv ?? req.doi ?? pdf, title: meta.title!, subtitle: null,
      authors: (meta.authors ?? []).map((n) => ({ name: n, id: null })), year: meta.year ?? null, language: null, publisher: meta.publisher ?? null,
      description: meta.description ?? null, cover_url: null, subjects: [], isbn: meta.isbn ?? null, doi: meta.doi ?? null, web_url: req.url ?? null,
      files: [{ url: pdf, format: "pdf", size: null, label: "PDF" }], access: "public", edition_count: null,
    };
    const id = await providers.download(remote, remote.files[0]);
    if (req.collection_id) pendingCollections.set(id, req.collection_id);
    // No identifier resolved → the page title / file name is all we have; identify from the PDF once it lands.
    if (!req.arxiv && !(req.doi && meta.metadata_source) && (weakTitle(meta.title) || !meta.authors?.length)) pendingIdentify.add(id);
    toast("Saving from browser", `${meta.title} — downloading PDF`);
  } else {
    const id = await api.createBook(meta, ids);
    if (req.collection_id) await api.setBookCollection([id], req.collection_id, true);
    toast("Saved from browser", meta.title!, "success");
  }
}

/** Mount once (main window). */
export function listenForConnectorSaves() {
  const uns: Promise<() => void>[] = [
    listen<SaveRequest>("connector_save", (e) => { handle(e.payload).catch((err) => toast("Could not save from browser", String(err), "error")); }),
    listen<{ id: string; status: string; book_id: number | null }>("download_progress", (e) => {
      const col = pendingCollections.get(e.payload.id);
      if (col && e.payload.status === "completed" && e.payload.book_id) { pendingCollections.delete(e.payload.id); api.setBookCollection([e.payload.book_id], col, true); }
      if (pendingIdentify.has(e.payload.id) && e.payload.status === "completed" && e.payload.book_id) { pendingIdentify.delete(e.payload.id); autoIdentify(e.payload.book_id); }
    }),
    listen<string>("connector_error", (e) => toast("Browser connector", e.payload, "error")),
  ];
  return () => uns.forEach((p) => p.then((f) => f()));
}
