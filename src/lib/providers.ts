import { invoke } from "@tauri-apps/api/core";

export interface AuthorRef { name: string; id: string | null }
export interface RemoteFile { url: string; format: string; size: number | null; label: string | null }
export interface RemoteBook {
  provider: string; id: string; title: string; subtitle: string | null; authors: AuthorRef[]; year: number | null; language: string | null;
  publisher: string | null; description: string | null; cover_url: string | null; subjects: string[]; isbn: string | null; doi: string | null;
  web_url: string | null; files: RemoteFile[]; access: "public" | "borrow" | "none"; edition_count: number | null;
}
export interface Query { text?: string; title?: string; author?: string; subject?: string; language?: string; downloadable?: boolean; page?: number }
export interface SearchPage { items: RemoteBook[]; total: number | null; page: number; has_more: boolean }
export interface AuthorPage { id: string; name: string; bio: string | null; photo_url: string | null; birth_date: string | null; death_date: string | null; books: RemoteBook[] }
export interface FulltextHit { book: RemoteBook; snippets: string[] }
export interface ProviderMeta { id: string; name: string; description: string; search: boolean; fulltext: boolean; authors: boolean; download: boolean; builtin: boolean }
export interface SyncItem { book: RemoteBook; status: "in_library" | "missing" | "ignored"; local_book_id: number | null; matched_by: string | null }
export interface SyncResult { items: SyncItem[]; missing: number; in_library: number; ran_at: string }
export interface SavedQuery { id: number; name: string; provider: string; query: Query; last_run: string | null; last_result: SyncResult | null }
export interface OpdsCatalog { id: string; name: string; url: string; username?: string | null; password?: string | null }
export interface GithubSource { id: string; name: string; repo: string; branch?: string | null; path?: string | null; kind: "repo" | "list" }
export interface GithubConfig { sources: GithubSource[]; token: string | null }
export interface DownloadItem { id: string; provider: string; remote_id: string; url: string; title: string; format: string; dest: string | null; status: "queued" | "downloading" | "paused" | "completed" | "failed" | "cancelled"; bytes: number; total: number | null; error: string | null; book_id: number | null; created_at: string }
export interface DownloadProgress { id: string; status: DownloadItem["status"]; bytes: number; total: number | null; error: string | null; book_id: number | null }

const q0 = (q: Query) => ({ downloadable: false, page: 1, ...q });

export const providers = {
  list: () => invoke<ProviderMeta[]>("list_providers"),
  search: (provider: string, query: Query) => invoke<SearchPage>("provider_search", { provider, query: q0(query) }),
  details: (provider: string, id: string) => invoke<RemoteBook>("provider_details", { provider, id }),
  author: (provider: string, id: string) => invoke<AuthorPage>("provider_author", { provider, id }),
  fulltext: (provider: string, query: string, page = 1) => invoke<FulltextHit[]>("provider_fulltext", { provider, query, page }),
  match: (books: RemoteBook[]) => invoke<SyncResult>("match_remote", { books }),
  saveReference: (book: RemoteBook) => invoke<number>("save_remote_reference", { book }),

  listOpds: () => invoke<OpdsCatalog[]>("list_opds_catalogs"),
  saveOpds: (catalogs: OpdsCatalog[]) => invoke<void>("save_opds_catalogs", { catalogs }),

  getGithub: () => invoke<GithubConfig>("get_github_config"),
  saveGithub: (config: GithubConfig) => invoke<void>("save_github_config", { config }),

  download: (book: RemoteBook, file: RemoteFile) => invoke<string>("enqueue_download", { book, file }),
  downloads: () => invoke<DownloadItem[]>("list_downloads"),
  cancel: (id: string, pause = false) => invoke<void>("cancel_download", { id, pause }),
  resume: (id: string) => invoke<void>("resume_download", { id }),
  clearDownloads: () => invoke<void>("clear_downloads"),
  getDownloadDir: () => invoke<string>("get_download_dir"),
  setDownloadDir: (path: string) => invoke<void>("set_download_dir", { path }),

  syncQueries: () => invoke<SavedQuery[]>("list_sync_queries"),
  saveSyncQuery: (name: string, provider: string, query: Query, id?: number) => invoke<number>("save_sync_query", { id: id ?? null, name, provider, query: q0(query) }),
  deleteSyncQuery: (id: number) => invoke<void>("delete_sync_query", { id }),
  runSync: (id: number, maxPages = 5) => invoke<SyncResult>("run_sync_query", { id, maxPages }),
  setIgnored: (provider: string, remoteId: string, ignored: boolean) => invoke<void>("set_sync_ignored", { provider, remoteId, ignored }),
};

/** Best file to download by preference: EPUB > PDF > AZW3 > MOBI > TXT. */
export function bestFile(b: RemoteBook, prefer: string[] = ["epub", "pdf", "azw3", "mobi", "fb2", "txt"]) {
  return [...b.files].sort((x, y) => (prefer.indexOf(x.format) + 99) % 99 - (prefer.indexOf(y.format) + 99) % 99)[0];
}

/** Download the best file; resolves details first when a search result has no file list. */
export async function downloadBest(b: RemoteBook) {
  let book = b;
  if (!book.files.length) book = await providers.details(b.provider, b.id);
  const f = bestFile(book);
  if (!f) throw new Error(book.access === "borrow" ? "Only available to borrow on the provider's website" : "No downloadable file");
  return providers.download(book, f);
}
