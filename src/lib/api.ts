// Typed wrappers around Tauri commands. Rust structs live in src-tauri/src/{library/models.rs,reading.rs}.
import { invoke, convertFileSrc } from "@tauri-apps/api/core";

export interface BookFile { id: number; path: string; format: BookFormat; size: number; missing: boolean }
export interface Tag { id: number; name: string; color: string | null }
export interface TagWithCount extends Tag { count: number }
export interface Identifier { scheme: string; value: string }
export type BookFormat = "pdf" | "epub" | "mobi" | "azw3" | "fb2" | "cbz" | "txt" | "md" | "docx" | "odt" | "djvu";
export type ReadStatus = "unread" | "reading" | "finished";

export interface Book {
  id: number;
  title: string;
  subtitle: string | null;
  authors: string[];
  year: number | null;
  language: string | null;
  publisher: string | null;
  isbn: string | null;
  doi: string | null;
  series: string | null;
  series_index: number | null;
  description: string | null;
  edition: string | null;
  place: string | null;
  num_pages: number | null;
  item_type: "book" | "article" | "thesis" | "report" | "chapter" | "document";
  short_title: string | null;
  metadata_source: string | null;
  cover_path: string | null;
  rating: number | null;
  status: ReadStatus;
  favorite: boolean;
  added_at: string;
  last_opened_at: string | null;
  percent: number;
  files: BookFile[];
  tags: Tag[];
  collection_ids: number[];
  identifiers: Identifier[];
  enriched: boolean;
}

export interface LibraryFilter {
  text?: string;
  collection_id?: number;
  tag_ids?: number[];
  formats?: string[];
  status?: ReadStatus;
  favorite?: boolean;
  author?: string;
  missing?: boolean;
  sort?: "added" | "title" | "author" | "year" | "opened" | "progress";
  desc?: boolean;
}

export type BookPatch = Partial<Omit<Book, "id" | "files" | "tags" | "collection_ids" | "identifiers" | "percent" | "added_at" | "enriched" | "cover_path" | "last_opened_at">> & {
  only_missing?: boolean;
  isbns?: string[];
};

export interface Collection { id: number; parent_id: number | null; name: string; count: number }
export interface SavedSearch { id: number; name: string; filter: LibraryFilter }
export interface ScanReport { scanned: number; added: number; moved: number; missing: number; errors: string[] }

export interface Progress {
  book_id: number;
  locator: Locator | null;
  percent: number;
  settings: ReaderSettings | null;
  updated_at?: string | null;
}
export type Locator = { page: number; offset?: number } | { cfi: string };

export interface ReaderSettings {
  zoom?: number | "fit-width" | "fit-page";
  viewMode?: "continuous" | "single" | "facing" | "presentation";
  rotation?: number;
  crop?: CropBox | null;
  reflow?: boolean;
  pdfTheme?: "normal" | "dark" | "sepia";
  font?: { family?: string; size?: number; lineHeight?: number; margin?: number; justify?: boolean };
  flow?: "paginated" | "scrolled";
}
/** Fractions (0..1) of the page box to trim. `odd`/`even` override for facing layouts. */
export interface CropBox { top: number; right: number; bottom: number; left: number; odd?: Omit<CropBox, "odd" | "even">; even?: Omit<CropBox, "odd" | "even"> }

export type AnnotationKind =
  | "highlight" | "underline" | "strike" | "squiggly"
  | "note" | "text" | "ink" | "line" | "arrow" | "rect" | "ellipse" | "stamp" | "area";

/** PDF anchors use page coords in PDF points (unscaled, unrotated). Reflowable anchors use EPUB CFI. */
export type AnnotationAnchor =
  | { page: number; rects: [number, number, number, number][]; paths?: [number, number][][]; points?: [number, number][] }
  | { cfi: string };

export interface Annotation {
  id: string;
  book_id: number;
  kind: AnnotationKind;
  color: string | null;
  anchor: AnnotationAnchor;
  page_label: string | null;
  text: string | null;
  comment: string | null;
  tags: string[];
  style: { opacity?: number; width?: number; image?: string; stamp?: string } | null;
  created_at: string;
  updated_at: string;
}

export interface Bookmark { id: string; book_id: number; locator: Locator; label: string | null; created_at: string }
export interface Note { id: string; book_id: number | null; title: string; body: string; created_at: string; updated_at: string }
export interface FtsHit { book_id: number; title: string; loc: string; snippet: string }
export interface ReadingStats { total_seconds: number; today_seconds: number; books_finished: number; streak_days: number }

export const api = {
  listBooks: (filter: LibraryFilter = {}) => invoke<Book[]>("list_books", { filter }),
  getBook: (id: number) => invoke<Book>("get_book", { id }),
  updateBook: (id: number, patch: BookPatch) => invoke<Book>("update_book", { id, patch }),
  createBook: (patch: BookPatch, identifiers: [string, string][] = []) => invoke<number>("create_book", { patch, identifiers }),
  deleteBook: (id: number, deleteFiles: boolean) => invoke<void>("delete_book", { id, deleteFiles }),
  listWatchFolders: () => invoke<string[]>("list_watch_folders"),
  addWatchFolder: (path: string) => invoke<ScanReport>("add_watch_folder", { path }),
  removeWatchFolder: (path: string, removeBooks: boolean) => invoke<void>("remove_watch_folder", { path, removeBooks }),
  rescan: () => invoke<ScanReport>("rescan_library"),
  importFiles: (paths: string[]) => invoke<number[]>("import_files", { paths }),
  saveCover: (id: number, base64Jpeg: string) => invoke<string>("save_cover", { id, base64Jpeg }),
  markOpened: (id: number) => invoke<void>("mark_opened", { id }),
  unenrichedBooks: () => invoke<number[]>("unenriched_books"),
  resetEnriched: (ids: number[]) => invoke<void>("reset_enriched", { ids }),

  listCollections: () => invoke<Collection[]>("list_collections"),
  createCollection: (name: string, parentId?: number | null) => invoke<number>("create_collection", { name, parentId: parentId ?? null }),
  renameCollection: (id: number, name: string) => invoke<void>("rename_collection", { id, name }),
  moveCollection: (id: number, parentId: number | null) => invoke<void>("move_collection", { id, parentId }),
  deleteCollection: (id: number) => invoke<void>("delete_collection", { id }),
  setBookCollection: (bookIds: number[], collectionId: number, member: boolean) => invoke<void>("set_book_collection", { bookIds, collectionId, member }),

  listTags: () => invoke<TagWithCount[]>("list_tags"),
  upsertTag: (name: string, color?: string | null) => invoke<number>("upsert_tag", { name, color: color ?? null }),
  updateTag: (id: number, name: string, color: string | null) => invoke<void>("update_tag", { id, name, color }),
  deleteTag: (id: number) => invoke<void>("delete_tag", { id }),
  setBookTag: (bookIds: number[], tagId: number, on: boolean) => invoke<void>("set_book_tag", { bookIds, tagId, on }),

  listSavedSearches: () => invoke<SavedSearch[]>("list_saved_searches"),
  saveSearch: (name: string, filter: LibraryFilter, id?: number) => invoke<number>("save_search", { id: id ?? null, name, filter }),
  deleteSavedSearch: (id: number) => invoke<void>("delete_saved_search", { id }),
  listAuthors: () => invoke<{ name: string; count: number }[]>("list_authors"),

  getProgress: (bookId: number) => invoke<Progress>("get_progress", { bookId }),
  saveProgress: (progress: Progress) => invoke<void>("save_progress", { progress }),
  logSession: (bookId: number, startedAt: string, seconds: number, startPercent: number, endPercent: number, pages?: number) =>
    invoke<void>("log_reading_session", { bookId, startedAt, seconds, startPercent, endPercent, pages: pages ?? null }),
  readingStats: () => invoke<ReadingStats>("reading_stats"),

  listAnnotations: (bookId?: number) => invoke<Annotation[]>("list_annotations", { bookId: bookId ?? null }),
  upsertAnnotation: (annotation: Partial<Annotation> & Pick<Annotation, "book_id" | "kind" | "anchor">) =>
    invoke<Annotation>("upsert_annotation", {
      annotation: { id: "", color: null, page_label: null, text: null, comment: null, tags: [], style: null, created_at: "", updated_at: "", ...annotation },
    }),
  deleteAnnotation: (id: string) => invoke<void>("delete_annotation", { id }),

  listBookmarks: (bookId: number) => invoke<Bookmark[]>("list_bookmarks", { bookId }),
  upsertBookmark: (b: Partial<Bookmark> & Pick<Bookmark, "book_id" | "locator">) =>
    invoke<string>("upsert_bookmark", { bookmark: { id: "", label: null, created_at: "", ...b } }),
  deleteBookmark: (id: string) => invoke<void>("delete_bookmark", { id }),

  listNotes: (bookId: number | null, all = false) => invoke<Note[]>("list_notes", { bookId, all }),
  upsertNote: (n: Partial<Note>) => invoke<Note>("upsert_note", { note: { id: "", book_id: null, title: "", body: "", created_at: "", updated_at: "", ...n } }),
  deleteNote: (id: string) => invoke<void>("delete_note", { id }),

  indexBookText: (bookId: number, units: { loc: string; text: string }[], replace: boolean) => invoke<void>("index_book_text", { bookId, units, replace }),
  unindexedBooks: () => invoke<number[]>("unindexed_books"),
  searchFulltext: (query: string, bookId?: number, limit?: number) => invoke<FtsHit[]>("search_fulltext", { query, bookId: bookId ?? null, limit: limit ?? null }),

  writeTextFile: (path: string, contents: string) => invoke<void>("write_text_file", { path, contents }),
  writeBinaryFile: (path: string, base64Data: string) => invoke<void>("write_binary_file", { path, base64Data }),
};

export const fileUrl = (path: string) => convertFileSrc(path);
export const coverUrl = (b: Pick<Book, "cover_path" | "added_at">) => (b.cover_path ? `${convertFileSrc(b.cover_path)}?v=${encodeURIComponent(b.added_at)}` : null);

export function primaryFile(b: Book): BookFile | undefined {
  const order: BookFormat[] = ["epub", "pdf", "djvu", "azw3", "mobi", "fb2", "docx", "odt", "cbz", "md", "txt"];
  const present = b.files.filter((f) => !f.missing);
  return [...present].sort((x, y) => order.indexOf(x.format) - order.indexOf(y.format))[0] ?? b.files[0];
}
