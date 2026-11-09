mod agent;
mod backup;
mod cards;
mod cloud;
mod cloudsync;
mod storage;
mod connector;
mod crypto;
mod csl;
mod db;
mod downloads;
mod embeddings;
mod error;
mod integrations;
mod library;
mod llm;
mod ocr;
mod ocr_vision;
mod providers;
mod reading;
mod sync;
mod tracker;
mod tts;
mod audiobook;
mod stt;

use db::Db;
use error::{AppError, AppResult};
use library::models::*;
use library::{scan, store};
use reading::*;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct AppState {
    pub db: Db,
    pub data_dir: PathBuf,
    pub watcher: library::watcher::LibraryWatcher,
    pub providers: providers::Registry,
    pub downloader: downloads::Downloader,
    pub llm: llm::Llm,
    pub connector: connector::Connector,
    pub tts: tts::Tts,
    pub stt: stt::Stt,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct ConnectorConfig {
    pub enabled: bool,
    pub zotero_mode: bool,
    pub token: String,
    pub port: u16,
    #[serde(default)]
    pub cite_shortcut: Option<String>,
    #[serde(default)]
    pub auto_paste: bool,
}

fn connector_config(db: &Db) -> ConnectorConfig {
    let mut c: ConnectorConfig = kv_get(db, "connector").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(ConnectorConfig {
        enabled: true, zotero_mode: false, token: String::new(), port: connector::PORT, cite_shortcut: Some("Alt+Super+C".into()), auto_paste: false,
    });
    if c.token.is_empty() {
        c.token = uuid::Uuid::new_v4().simple().to_string();
        let _ = kv_set(db, "connector", &serde_json::to_string(&c).unwrap_or_default());
    }
    c.port = connector::PORT;
    c
}

fn start_connector(app: &AppHandle, state: &AppState) {
    let cfg = connector_config(&state.db);
    if !cfg.enabled {
        state.connector.stop();
        return;
    }
    let db = state.db.clone();
    let cols = std::sync::Arc::new(move || {
        serde_json::to_value(db.with(|c| store::list_collections(c)).unwrap_or_default()).unwrap_or_default()
    });
    state.connector.start(app.clone(), cfg.token, cfg.zotero_mode, cols);
}

fn kv_get(db: &Db, key: &str) -> Option<String> {
    db.with(|c| {
        use rusqlite::OptionalExtension;
        Ok(c.query_row("SELECT value FROM kv WHERE key = ?", [key], |r| r.get::<_, String>(0)).optional()?)
    })
    .ok()
    .flatten()
}

fn kv_set(db: &Db, key: &str, value: &str) -> AppResult<()> {
    db.with(|c| Ok(c.execute("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]).map(|_| ())?))
}

fn github_sources(db: &Db) -> Vec<providers::github::Source> {
    kv_get(db, "github_sources").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn opds_catalogs(db: &Db) -> Vec<providers::opds::Catalog> {
    db.with(|c| {
        use rusqlite::OptionalExtension;
        Ok(c.query_row("SELECT value FROM kv WHERE key = 'opds_catalogs'", [], |r| r.get::<_, String>(0)).optional()?)
    })
    .ok()
    .flatten()
    .and_then(|s| serde_json::from_str(&s).ok())
    .unwrap_or_default()
}

impl AppState {
    fn covers_dir(&self) -> PathBuf {
        self.data_dir.join("covers")
    }
}

/// Let the webview stream files from a folder through the asset protocol (pattern from coursera-dl-gui).
fn allow_asset_dir(app: &AppHandle, dir: &Path) {
    if let Err(e) = app.asset_protocol_scope().allow_directory(dir, true) {
        eprintln!("[Assets] cannot allow {}: {e}", dir.display());
    }
}

fn allow_book_paths(app: &AppHandle, db: &Db) {
    for f in scan::watch_folders(db).unwrap_or_default() {
        allow_asset_dir(app, &f);
    }
    // Files imported individually (outside watch folders).
    let files: Vec<String> = db
        .with(|c| Ok(c.prepare("SELECT path FROM files")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?))
        .unwrap_or_default();
    for p in files {
        let _ = app.asset_protocol_scope().allow_file(&p);
    }
}

// ── Library commands ───────────────────────────────────────

#[tauri::command]
fn list_books(state: State<AppState>, filter: LibraryFilter) -> AppResult<Vec<Book>> {
    state.db.with(|c| store::list_books(c, &filter))
}

#[tauri::command]
fn get_book(state: State<AppState>, id: i64) -> AppResult<Book> {
    state.db.with(|c| store::get_book(c, id))
}

#[tauri::command]
fn update_book(app: AppHandle, state: State<AppState>, id: i64, patch: BookPatch) -> AppResult<Book> {
    let b = state.db.with(|c| {
        store::update_book(c, id, &patch)?;
        store::get_book(c, id)
    })?;
    let _ = app.emit("library_changed", ());
    Ok(b)
}

/// Reference-only entry (no file yet): add-by-identifier and Discover "save to library".
#[tauri::command]
fn create_book(app: AppHandle, state: State<AppState>, patch: BookPatch, identifiers: Vec<(String, String)>) -> AppResult<i64> {
    let id = state.db.with(|c| {
        let title = patch.title.clone().unwrap_or_else(|| "Untitled".into());
        let id = store::insert_book(c, &title, patch.authors.as_deref().unwrap_or(&[]), patch.year)?;
        store::update_book(c, id, &BookPatch { only_missing: false, ..patch.clone() })?;
        c.execute("INSERT OR IGNORE INTO kv (key, value) VALUES ('enriched:' || ?, '1')", [id])?;
        for (scheme, value) in &identifiers {
            store::add_identifier(c, id, scheme, value)?;
        }
        Ok(id)
    })?;
    let _ = app.emit("library_changed", ());
    Ok(id)
}

#[tauri::command]
fn delete_book(app: AppHandle, state: State<AppState>, id: i64, delete_files: bool) -> AppResult<()> {
    let paths = state.db.with(|c| store::delete_book(c, id))?;
    if delete_files {
        for p in paths {
            let _ = std::fs::remove_file(p);
        }
    }
    let _ = std::fs::remove_file(state.covers_dir().join(format!("{id}.jpg")));
    let _ = app.emit("library_changed", ());
    Ok(())
}

#[tauri::command]
fn list_watch_folders(state: State<AppState>) -> AppResult<Vec<PathBuf>> {
    scan::watch_folders(&state.db)
}

#[tauri::command]
async fn add_watch_folder(app: AppHandle, path: String) -> AppResult<ScanReport> {
    let state = app.state::<AppState>();
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err(AppError::NotFound(path));
    }
    state.db.with(|c| Ok(c.execute("INSERT OR IGNORE INTO watch_folders (path) VALUES (?)", [&path])?))?;
    allow_asset_dir(&app, &p);
    state.watcher.restart(app.clone(), state.db.clone());
    rescan_library(app.clone()).await
}

#[tauri::command]
fn remove_watch_folder(app: AppHandle, state: State<AppState>, path: String, remove_books: bool) -> AppResult<()> {
    state.db.with(|c| {
        c.execute("DELETE FROM watch_folders WHERE path = ?", [&path])?;
        if remove_books {
            let prefix = format!("{}%", path.trim_end_matches('/'));
            c.execute(
                "DELETE FROM books WHERE id IN (SELECT book_id FROM files WHERE path LIKE ?)
                   AND NOT EXISTS (SELECT 1 FROM files f2 WHERE f2.book_id = books.id AND f2.path NOT LIKE ?)",
                [&prefix, &prefix],
            )?;
        }
        Ok(())
    })?;
    state.watcher.restart(app.clone(), state.db.clone());
    let _ = app.emit("library_changed", ());
    Ok(())
}

#[tauri::command]
async fn rescan_library(app: AppHandle) -> AppResult<ScanReport> {
    let db = app.state::<AppState>().db.clone();
    let report = tauri::async_runtime::spawn_blocking(move || scan::scan_all(&db))
        .await
        .map_err(|e| AppError::other(e.to_string()))??;
    let _ = app.emit("library_changed", ());
    Ok(report)
}

#[tauri::command]
async fn import_files(app: AppHandle, paths: Vec<String>) -> AppResult<Vec<i64>> {
    let db = app.state::<AppState>().db.clone();
    let app2 = app.clone();
    let ids = tauri::async_runtime::spawn_blocking(move || -> AppResult<Vec<i64>> {
        let mut ids = vec![];
        for p in paths {
            let path = PathBuf::from(&p);
            let found: Vec<PathBuf> = if path.is_dir() {
                walkdir::WalkDir::new(&path).into_iter().filter_map(|e| e.ok()).map(|e| e.into_path()).collect()
            } else {
                vec![path]
            };
            for f in found {
                if let Some(o) = scan::import_file(&db, &f)? {
                    let _ = app2.asset_protocol_scope().allow_file(&f);
                    ids.push(match o {
                        scan::ImportOutcome::Added(i) | scan::ImportOutcome::Moved(i) | scan::ImportOutcome::Duplicate(i) | scan::ImportOutcome::Unchanged(i) => i,
                    });
                }
            }
        }
        Ok(ids)
    })
    .await
    .map_err(|e| AppError::other(e.to_string()))??;
    let _ = app.emit("library_changed", ());
    Ok(ids)
}

#[tauri::command]
fn save_cover(state: State<AppState>, id: i64, base64_jpeg: String) -> AppResult<String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_jpeg.split(',').last().unwrap_or(""))
        .map_err(|e| AppError::other(e.to_string()))?;
    let dir = state.covers_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{id}.jpg"));
    std::fs::write(&path, bytes)?;
    let s = path.to_string_lossy().to_string();
    state.db.with(|c| store::set_cover(c, id, &s))?;
    Ok(s)
}

#[tauri::command]
fn unenriched_books(state: State<AppState>) -> AppResult<Vec<i64>> {
    state.db.with(|c| store::unenriched(c))
}

/// "Retrieve metadata" again: clears the enriched flag so the background enricher re-processes these books.
#[tauri::command]
fn reset_enriched(app: AppHandle, state: State<AppState>, ids: Vec<i64>) -> AppResult<()> {
    state.db.with(|c| store::reset_enriched(c, &ids))?;
    let _ = app.emit("enrich_requested", ());
    Ok(())
}

#[tauri::command]
fn mark_opened(state: State<AppState>, id: i64) -> AppResult<()> {
    state.db.with(|c| store::touch_opened(c, id))
}

#[tauri::command]
fn list_collections(state: State<AppState>) -> AppResult<Vec<Collection>> {
    state.db.with(|c| store::list_collections(c))
}

#[tauri::command]
fn create_collection(state: State<AppState>, name: String, parent_id: Option<i64>) -> AppResult<i64> {
    state.db.with(|c| store::create_collection(c, &name, parent_id))
}

#[tauri::command]
fn rename_collection(state: State<AppState>, id: i64, name: String) -> AppResult<()> {
    state.db.with(|c| store::rename_collection(c, id, &name))
}

#[tauri::command]
fn move_collection(state: State<AppState>, id: i64, parent_id: Option<i64>) -> AppResult<()> {
    state.db.with(|c| store::move_collection(c, id, parent_id))
}

#[tauri::command]
fn delete_collection(state: State<AppState>, id: i64) -> AppResult<()> {
    state.db.with(|c| store::delete_collection(c, id))
}

#[tauri::command]
fn set_book_collection(app: AppHandle, state: State<AppState>, book_ids: Vec<i64>, collection_id: i64, member: bool) -> AppResult<()> {
    state.db.with(|c| store::set_book_collection(c, &book_ids, collection_id, member))?;
    let _ = app.emit("library_changed", ());
    Ok(())
}

#[derive(serde::Serialize)]
struct TagWithCount {
    #[serde(flatten)]
    tag: Tag,
    count: i64,
}

#[tauri::command]
fn list_tags(state: State<AppState>) -> AppResult<Vec<TagWithCount>> {
    Ok(state.db.with(|c| store::list_tags(c))?.into_iter().map(|(tag, count)| TagWithCount { tag, count }).collect())
}

#[tauri::command]
fn upsert_tag(state: State<AppState>, name: String, color: Option<String>) -> AppResult<i64> {
    state.db.with(|c| store::upsert_tag(c, &name, color.as_deref()))
}

#[tauri::command]
fn update_tag(state: State<AppState>, id: i64, name: String, color: Option<String>) -> AppResult<()> {
    state.db.with(|c| store::update_tag(c, id, &name, color.as_deref()))
}

#[tauri::command]
fn delete_tag(app: AppHandle, state: State<AppState>, id: i64) -> AppResult<()> {
    state.db.with(|c| store::delete_tag(c, id))?;
    let _ = app.emit("library_changed", ());
    Ok(())
}

#[tauri::command]
fn set_book_tag(app: AppHandle, state: State<AppState>, book_ids: Vec<i64>, tag_id: i64, on: bool) -> AppResult<()> {
    state.db.with(|c| store::set_book_tag(c, &book_ids, tag_id, on))?;
    let _ = app.emit("library_changed", ());
    Ok(())
}

#[tauri::command]
fn list_saved_searches(state: State<AppState>) -> AppResult<Vec<SavedSearch>> {
    state.db.with(|c| store::list_saved_searches(c))
}

#[tauri::command]
fn save_search(state: State<AppState>, id: Option<i64>, name: String, filter: LibraryFilter) -> AppResult<i64> {
    state.db.with(|c| store::save_search(c, id, &name, &filter))
}

#[tauri::command]
fn delete_saved_search(state: State<AppState>, id: i64) -> AppResult<()> {
    state.db.with(|c| store::delete_saved_search(c, id))
}

#[derive(serde::Serialize)]
struct AuthorCount {
    name: String,
    count: i64,
}

#[tauri::command]
fn list_authors(state: State<AppState>) -> AppResult<Vec<AuthorCount>> {
    Ok(state.db.with(|c| store::list_authors(c))?.into_iter().map(|(name, count)| AuthorCount { name, count }).collect())
}

// ── Reading commands ───────────────────────────────────────

#[tauri::command]
fn get_progress(state: State<AppState>, book_id: i64) -> AppResult<Progress> {
    state.db.with(|c| reading::get_progress(c, book_id))
}

#[tauri::command]
fn save_progress(state: State<AppState>, progress: Progress) -> AppResult<()> {
    state.db.with(|c| reading::save_progress(c, &progress))
}

#[tauri::command]
fn log_reading_session(state: State<AppState>, book_id: i64, started_at: String, seconds: i64, start_percent: f64, end_percent: f64, pages: Option<i64>) -> AppResult<()> {
    state.db.with(|c| reading::log_session(c, book_id, &started_at, seconds, start_percent, end_percent, pages))
}

#[tauri::command]
fn reading_stats(state: State<AppState>) -> AppResult<ReadingStats> {
    state.db.with(|c| reading::stats(c))
}

#[tauri::command]
fn list_annotations(state: State<AppState>, book_id: Option<i64>) -> AppResult<Vec<Annotation>> {
    state.db.with(|c| reading::list_annotations(c, book_id))
}

#[tauri::command]
fn upsert_annotation(state: State<AppState>, annotation: Annotation) -> AppResult<Annotation> {
    state.db.with(|c| reading::upsert_annotation(c, &annotation))
}

#[tauri::command]
fn delete_annotation(state: State<AppState>, id: String) -> AppResult<()> {
    state.db.with(|c| reading::delete_annotation(c, &id))
}

#[tauri::command]
fn list_bookmarks(state: State<AppState>, book_id: i64) -> AppResult<Vec<Bookmark>> {
    state.db.with(|c| reading::list_bookmarks(c, book_id))
}

#[tauri::command]
fn upsert_bookmark(state: State<AppState>, bookmark: Bookmark) -> AppResult<String> {
    state.db.with(|c| reading::upsert_bookmark(c, &bookmark))
}

#[tauri::command]
fn delete_bookmark(state: State<AppState>, id: String) -> AppResult<()> {
    state.db.with(|c| reading::delete_bookmark(c, &id))
}

#[tauri::command]
fn list_notes(state: State<AppState>, book_id: Option<i64>, all: bool) -> AppResult<Vec<Note>> {
    state.db.with(|c| reading::list_notes(c, book_id, all))
}

#[tauri::command]
fn upsert_note(state: State<AppState>, note: Note) -> AppResult<Note> {
    state.db.with(|c| reading::upsert_note(c, &note))
}

#[tauri::command]
fn delete_note(state: State<AppState>, id: String) -> AppResult<()> {
    state.db.with(|c| reading::delete_note(c, &id))
}

#[tauri::command]
fn index_book_text(state: State<AppState>, book_id: i64, units: Vec<IndexUnit>, replace: bool) -> AppResult<()> {
    state.db.with(|c| reading::index_book(c, book_id, &units, replace))
}

#[tauri::command]
fn unindexed_books(state: State<AppState>) -> AppResult<Vec<i64>> {
    state.db.with(|c| reading::unindexed_books(c))
}

#[tauri::command]
fn search_fulltext(state: State<AppState>, query: String, book_id: Option<i64>, limit: Option<i64>) -> AppResult<Vec<FtsHit>> {
    state.db.with(|c| reading::search_fulltext(c, &query, book_id, limit.unwrap_or(100)))
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> AppResult<()> {
    std::fs::write(path, contents)?;
    Ok(())
}

#[tauri::command]
fn write_binary_file(path: String, base64_data: String) -> AppResult<()> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(base64_data).map_err(|e| AppError::other(e.to_string()))?;
    std::fs::write(path, bytes)?;
    Ok(())
}

// ── Providers / discover ───────────────────────────────────

use providers::{AuthorPage, FulltextHit, ProviderMeta, Query, RemoteBook, RemoteFile, SearchPage};

#[tauri::command]
fn list_providers(state: State<'_, AppState>) -> Vec<ProviderMeta> {
    state.providers.list()
}

#[tauri::command]
async fn provider_search(state: State<'_, AppState>, provider: String, query: Query) -> AppResult<SearchPage> {
    let p = state.providers.get(&provider)?;
    p.search(&query).await
}

#[tauri::command]
async fn provider_details(state: State<'_, AppState>, provider: String, id: String) -> AppResult<RemoteBook> {
    let p = state.providers.get(&provider)?;
    p.details(&id).await
}

#[tauri::command]
async fn provider_author(state: State<'_, AppState>, provider: String, id: String) -> AppResult<AuthorPage> {
    let p = state.providers.get(&provider)?;
    p.author(&id).await
}

#[tauri::command]
async fn provider_fulltext(state: State<'_, AppState>, provider: String, query: String, page: Option<u32>) -> AppResult<Vec<FulltextHit>> {
    let p = state.providers.get(&provider)?;
    p.fulltext(&query, page.unwrap_or(1)).await
}

/// Match a set of remote results against the library (for "in library" badges in Discover).
#[tauri::command]
fn match_remote(state: State<'_, AppState>, books: Vec<RemoteBook>) -> AppResult<sync::SyncResult> {
    state.db.with(|c| sync::diff(c, books))
}

#[tauri::command]
fn list_opds_catalogs(state: State<'_, AppState>) -> Vec<providers::opds::Catalog> {
    opds_catalogs(&state.db)
}

#[tauri::command]
fn save_opds_catalogs(app: AppHandle, state: State<'_, AppState>, catalogs: Vec<providers::opds::Catalog>) -> AppResult<()> {
    let json = serde_json::to_string(&catalogs)?;
    state.db.with(|c| Ok(c.execute("INSERT INTO kv (key, value) VALUES ('opds_catalogs', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [json])?))?;
    state.providers.set_opds(catalogs);
    let _ = app.emit("providers_changed", ());
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize)]
struct GithubConfig {
    sources: Vec<providers::github::Source>,
    token: Option<String>,
}

#[tauri::command]
fn get_github_config(state: State<'_, AppState>) -> GithubConfig {
    GithubConfig { sources: github_sources(&state.db), token: kv_get(&state.db, "github_token") }
}

#[tauri::command]
fn save_github_config(app: AppHandle, state: State<'_, AppState>, config: GithubConfig) -> AppResult<()> {
    kv_set(&state.db, "github_sources", &serde_json::to_string(&config.sources)?)?;
    kv_set(&state.db, "github_token", config.token.as_deref().unwrap_or(""))?;
    state.providers.set_github(config.sources, config.token);
    let _ = app.emit("providers_changed", ());
    Ok(())
}

#[tauri::command]
async fn opds_browse(url: String, username: Option<String>, password: Option<String>) -> AppResult<providers::opds::Feed> {
    let cat = providers::opds::Catalog { id: "browse".into(), name: "browse".into(), url: url.clone(), username, password };
    providers::opds::Opds::new(providers::http(), cat).feed(None).await
}

/// Save a remote record as a library entry without downloading (reference / wishlist).
#[tauri::command]
fn save_remote_reference(app: AppHandle, state: State<'_, AppState>, book: RemoteBook) -> AppResult<i64> {
    let id = state.db.with(|c| {
        let patch = downloads::patch_from_remote(&book);
        let id = store::insert_book(c, &book.title, &patch.authors.clone().unwrap_or_default(), book.year)?;
        store::update_book(c, id, &patch)?;
        c.execute("INSERT OR IGNORE INTO kv (key, value) VALUES ('enriched:' || ?, '1')", [id])?;
        store::add_identifier(c, id, &book.provider, &book.id)?;
        Ok(id)
    })?;
    let _ = app.emit("library_changed", ());
    Ok(id)
}

// ── Downloads ──────────────────────────────────────────────

#[tauri::command]
fn enqueue_download(app: AppHandle, state: State<'_, AppState>, book: RemoteBook, file: RemoteFile) -> AppResult<String> {
    state.downloader.enqueue(&app, &state.db, &book, &file)
}

#[tauri::command]
fn list_downloads(state: State<'_, AppState>) -> AppResult<Vec<downloads::DownloadItem>> {
    downloads::list(&state.db)
}

#[tauri::command]
fn cancel_download(state: State<'_, AppState>, id: String, pause: bool) -> AppResult<()> {
    state.downloader.cancel(&state.db, &id, if pause { "paused" } else { "cancelled" })
}

#[tauri::command]
fn resume_download(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.downloader.resume(&app, &state.db, &id)
}

#[tauri::command]
fn clear_downloads(state: State<'_, AppState>) -> AppResult<()> {
    downloads::clear_finished(&state.db)
}

#[tauri::command]
fn get_download_dir(state: State<'_, AppState>) -> String {
    downloads::download_dir(&state.db).to_string_lossy().to_string()
}

#[tauri::command]
fn set_download_dir(app: AppHandle, state: State<'_, AppState>, path: String) -> AppResult<()> {
    state.db.with(|c| Ok(c.execute("INSERT INTO kv (key, value) VALUES ('download_dir', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [&path])?))?;
    allow_asset_dir(&app, Path::new(&path));
    Ok(())
}

// ── Sync ───────────────────────────────────────────────────

#[tauri::command]
fn list_sync_queries(state: State<'_, AppState>) -> AppResult<Vec<sync::SavedQuery>> {
    sync::list(&state.db)
}

#[tauri::command]
fn save_sync_query(state: State<'_, AppState>, id: Option<i64>, name: String, provider: String, query: Query) -> AppResult<i64> {
    sync::save(&state.db, id, &name, &provider, &query)
}

#[tauri::command]
fn delete_sync_query(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    state.db.with(|c| Ok(c.execute("DELETE FROM saved_queries WHERE id = ?", [id]).map(|_| ())?))
}

#[tauri::command]
async fn run_sync_query(state: State<'_, AppState>, id: i64, max_pages: Option<u32>) -> AppResult<sync::SyncResult> {
    sync::run(&state.db, &state.providers, id, max_pages.unwrap_or(5)).await
}

#[tauri::command]
fn set_sync_ignored(state: State<'_, AppState>, provider: String, remote_id: String, ignored: bool) -> AppResult<()> {
    state.db.with(|c| {
        if ignored {
            c.execute("INSERT OR IGNORE INTO sync_ignored (provider, remote_id) VALUES (?, ?)", [&provider, &remote_id])?;
        } else {
            c.execute("DELETE FROM sync_ignored WHERE provider = ? AND remote_id = ?", [&provider, &remote_id])?;
        }
        Ok(())
    })
}

// ── Goals, schedules, stats ────────────────────────────────

#[tauri::command]
fn detailed_stats(state: State<'_, AppState>) -> AppResult<tracker::DetailedStats> {
    state.db.with(|c| tracker::detailed(c))
}
#[tauri::command]
fn list_goals(state: State<'_, AppState>) -> AppResult<Vec<tracker::Goal>> {
    state.db.with(|c| tracker::list_goals(c))
}
#[tauri::command]
fn save_goal(state: State<'_, AppState>, goal: tracker::Goal) -> AppResult<i64> {
    state.db.with(|c| tracker::save_goal(c, &goal))
}
#[tauri::command]
fn delete_goal(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    state.db.with(|c| Ok(c.execute("DELETE FROM goals WHERE id = ?", [id]).map(|_| ())?))
}
#[tauri::command]
fn list_schedules(state: State<'_, AppState>) -> AppResult<Vec<tracker::Schedule>> {
    state.db.with(|c| tracker::list_schedules(c))
}
#[tauri::command]
fn save_schedule(state: State<'_, AppState>, schedule: tracker::Schedule) -> AppResult<i64> {
    state.db.with(|c| tracker::save_schedule(c, &schedule))
}
#[tauri::command]
fn delete_schedule(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    state.db.with(|c| Ok(c.execute("DELETE FROM schedules WHERE id = ?", [id]).map(|_| ())?))
}
#[tauri::command]
fn get_kv(state: State<'_, AppState>, key: String) -> Option<String> {
    kv_get(&state.db, &key)
}
#[tauri::command]
fn set_kv(state: State<'_, AppState>, key: String, value: String) -> AppResult<()> {
    kv_set(&state.db, &key, &value)
}
#[tauri::command]
fn test_notification(app: AppHandle) -> AppResult<()> {
    use tauri_plugin_notification::NotificationExt;
    app.notification().builder().title("Local Lib").body("Notifications are working.").show().map_err(|e| AppError::other(e.to_string()))
}

// ── LLM assistant ──────────────────────────────────────────

#[tauri::command]
fn llm_get_config(state: State<'_, AppState>) -> llm::LlmConfig {
    let mut c: llm::LlmConfig = kv_get(&state.db, "llm_config").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    c.has_key = llm::get_key(&key_slot(&c.provider)).is_some();
    c
}

#[tauri::command]
fn llm_save_config(state: State<'_, AppState>, config: llm::LlmConfig, api_key: Option<String>) -> AppResult<()> {
    kv_set(&state.db, "llm_config", &serde_json::to_string(&config)?)?;
    if let Some(k) = api_key {
        llm::set_key(&key_slot(&config.provider), Some(&k))?;
    }
    Ok(())
}

fn key_slot(provider: &str) -> String {
    match provider { "anthropic" | "gemini" => provider.to_string(), _ => "openai".into() }
}

#[tauri::command]
async fn llm_list_models(state: State<'_, AppState>) -> AppResult<Vec<llm::ModelInfo>> {
    let cfg: llm::LlmConfig = kv_get(&state.db, "llm_config").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    llm::list_models(&cfg).await
}

#[tauri::command]
fn llm_clear_key(provider: String) -> AppResult<()> {
    llm::set_key(&provider, None)
}

#[tauri::command]
fn llm_chat(app: AppHandle, state: State<'_, AppState>, request_id: String, system: String, messages: Vec<llm::ChatMessage>) -> AppResult<()> {
    let cfg = llm_get_config(state.clone());
    state.llm.chat(app, cfg, request_id, system, messages);
    Ok(())
}

/// Tool-using assistant turn. `history` is the opaque provider-native conversation returned by the previous turn.
#[tauri::command]
fn llm_agent(app: AppHandle, state: State<'_, AppState>, request_id: String, system: String, history: Vec<serde_json::Value>, user: String) -> AppResult<()> {
    let cfg = llm_get_config(state.clone());
    let embed = embed_config(&state.db);
    let db = state.db.clone();
    let flag = state.llm.register(&request_id);
    let llm = state.llm.clone();
    tauri::async_runtime::spawn(async move {
        let done = agent::run(app.clone(), db, cfg, embed, request_id.clone(), system, history, user, &flag).await;
        let _ = app.emit("llm_agent_done", done);
        llm.unregister(&request_id);
    });
    Ok(())
}

fn embed_config(db: &Db) -> embeddings::EmbedConfig {
    kv_get(db, "embed_config").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

#[tauri::command]
fn get_embed_config(state: State<'_, AppState>) -> embeddings::EmbedConfig {
    embed_config(&state.db)
}

#[tauri::command]
fn save_embed_config(app: AppHandle, state: State<'_, AppState>, config: embeddings::EmbedConfig) -> AppResult<()> {
    kv_set(&state.db, "embed_config", &serde_json::to_string(&config)?)?;
    embeddings::set_live(|l| { l.last_error = None; l.retry_in = None; });
    if config.enabled { start_embed_worker(app); embeddings::wake(); }
    Ok(())
}

#[tauri::command]
fn embed_status(state: State<'_, AppState>) -> AppResult<embeddings::EmbedStatus> {
    embeddings::status(&state.db, &embed_config(&state.db))
}

/// Test the embedding provider with one short text.
#[tauri::command]
async fn embed_test(state: State<'_, AppState>) -> AppResult<usize> {
    let v = embeddings::embed(&embed_config(&state.db), &["hello world".into()], true).await?;
    Ok(v.first().map(|x| x.len()).unwrap_or(0))
}

#[tauri::command]
async fn semantic_search(state: State<'_, AppState>, query: String, book_id: Option<i64>, k: Option<usize>) -> AppResult<Vec<reading::Passage>> {
    embeddings::hybrid(&state.db, &embed_config(&state.db), &query, book_id, k.unwrap_or(30)).await
}

static EMBED_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Background: embed one book at a time while enabled.
fn start_embed_worker(app: AppHandle) {
    use std::sync::atomic::Ordering;
    if EMBED_RUNNING.swap(true, Ordering::SeqCst) { return; }
    tauri::async_runtime::spawn(async move {
        loop {
            let (db, cfg) = { let st = app.state::<AppState>(); (st.db.clone(), embed_config(&st.db)) };
            if !cfg.enabled { break; }
            match embeddings::index_next_book(&db, &cfg).await {
                Ok(Some(_)) => { let _ = app.emit("embed_progress", embeddings::status(&db, &cfg).ok()); }
                Ok(None) => embeddings::nap(120).await,
                Err(e) => {
                    eprintln!("[Embeddings] {e}");
                    embeddings::set_live(|l| { l.last_error = Some(e.to_string()); l.current_book = None; });
                    let _ = app.emit("embed_error", e.to_string());
                    embeddings::nap(60).await; // woken early when settings change
                }
            }
        }
        EMBED_RUNNING.store(false, Ordering::SeqCst);
    });
}

// ── Summaries ──────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize)]
struct Summary { book_id: i64, scope: String, title: String, text: String, model: Option<String>, #[serde(default)] created_at: String }

#[tauri::command]
fn list_summaries(state: State<'_, AppState>, book_id: Option<i64>) -> AppResult<Vec<Summary>> {
    state.db.with(|c| Ok(c.prepare("SELECT book_id, scope, title, text, model, created_at FROM summaries WHERE (?1 IS NULL OR book_id = ?1) ORDER BY book_id, created_at")?
        .query_map([book_id], |r| Ok(Summary { book_id: r.get(0)?, scope: r.get(1)?, title: r.get(2)?, text: r.get(3)?, model: r.get(4)?, created_at: r.get(5)? }))?
        .collect::<Result<_, _>>()?))
}

#[tauri::command]
fn save_summary(state: State<'_, AppState>, summary: Summary) -> AppResult<()> {
    state.db.with(|c| Ok(c.execute(
        "INSERT INTO summaries (book_id, scope, title, text, model) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(book_id, scope) DO UPDATE SET title = excluded.title, text = excluded.text, model = excluded.model, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        rusqlite::params![summary.book_id, summary.scope, summary.title, summary.text, summary.model]).map(|_| ())?))
}

#[tauri::command]
fn delete_summary(state: State<'_, AppState>, book_id: i64, scope: String) -> AppResult<()> {
    state.db.with(|c| Ok(c.execute("DELETE FROM summaries WHERE book_id = ? AND scope = ?", rusqlite::params![book_id, scope]).map(|_| ())?))
}

/// Text of a page range (for chapter summaries).
#[tauri::command]
fn range_text(state: State<'_, AppState>, book_id: i64, from: i64, to: i64) -> AppResult<Vec<(String, String)>> {
    state.db.with(|c| {
        let mut out = vec![];
        for n in from..=to.min(from + 400) {
            for p in ["p", "s"] {
                if let Some(t) = reading::unit_text(c, book_id, &format!("{p}{n}"))? { out.push((format!("{p}{n}"), t)); break; }
            }
        }
        Ok(out)
    })
}

#[tauri::command]
fn llm_cancel(state: State<'_, AppState>, request_id: String) {
    state.llm.cancel(&request_id);
}

#[tauri::command]
fn retrieve_passages(state: State<'_, AppState>, question: String, book_id: Option<i64>, k: Option<i64>) -> AppResult<Vec<reading::Passage>> {
    state.db.with(|c| reading::retrieve(c, &question, book_id, k.unwrap_or(8)))
}

#[tauri::command]
fn unit_text(state: State<'_, AppState>, book_id: i64, loc: String) -> AppResult<Option<String>> {
    state.db.with(|c| reading::unit_text(c, book_id, &loc))
}

// ── Flashcards ─────────────────────────────────────────────

#[tauri::command]
fn card_upsert(state: State<'_, AppState>, card: cards::Card) -> AppResult<String> {
    state.db.with(|c| cards::upsert(c, &card))
}
#[tauri::command]
fn cards_due(state: State<'_, AppState>, now: String, book_id: Option<i64>, new_limit: Option<i64>) -> AppResult<Vec<cards::Card>> {
    state.db.with(|c| cards::due(c, &now, book_id, new_limit.unwrap_or(20), 200))
}
#[tauri::command]
fn cards_list(state: State<'_, AppState>, book_id: Option<i64>) -> AppResult<Vec<cards::Card>> {
    state.db.with(|c| cards::list(c, book_id))
}
#[tauri::command]
fn cards_counts(state: State<'_, AppState>, now: String, new_limit: Option<i64>) -> AppResult<cards::CardCounts> {
    state.db.with(|c| cards::counts(c, &now, new_limit.unwrap_or(20)))
}
#[tauri::command]
fn card_review(state: State<'_, AppState>, id: String, rating: i64, fsrs: serde_json::Value, due: String, seconds: Option<i64>) -> AppResult<()> {
    state.db.with(|c| cards::review(c, &id, rating, &fsrs, &due, seconds))
}
#[tauri::command]
fn card_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.db.with(|c| cards::delete(c, &id))
}

// ── Natural TTS ────────────────────────────────────────────

#[tauri::command]
fn audiobook_start(app: AppHandle, job: audiobook::Job) -> AppResult<String> {
    let st = app.state::<AppState>();
    let (db, engine, root, tmp) = (st.db.clone(), st.tts.clone(), st.data_dir.join("tts"), st.data_dir.join("tmp"));
    audiobook::start(app.clone(), db, engine, root, tmp, job)
}

#[tauri::command]
fn stt_models(state: State<'_, AppState>) -> Vec<stt::SttModel> { stt::list(&state.data_dir.join("stt")) }

#[tauri::command]
async fn stt_install(app: AppHandle, id: String) -> AppResult<()> {
    let root = app.state::<AppState>().data_dir.join("stt");
    stt::install(&app, &root, &id).await
}

#[tauri::command]
fn stt_uninstall(state: State<'_, AppState>, id: String) -> AppResult<()> { stt::uninstall(&state.data_dir.join("stt"), &id, &state.stt) }

#[tauri::command]
fn stt_record_start(app: AppHandle) -> AppResult<()> { stt::record_start(app) }

/// Stop the microphone and transcribe what was said.
#[tauri::command]
async fn stt_record_stop(app: AppHandle, model: String) -> AppResult<String> {
    let samples = tauri::async_runtime::spawn_blocking(stt::record_stop).await.map_err(|e| AppError::other(e.to_string()))??;
    if samples.len() < 16000 / 4 { return Ok(String::new()); }
    let st = app.state::<AppState>();
    let (stt, root) = (st.stt.clone(), st.data_dir.join("stt"));
    tauri::async_runtime::spawn_blocking(move || stt.transcribe(&root, &model, &samples, 16000)).await.map_err(|e| AppError::other(e.to_string()))?
}

/// Transcribe 16 kHz mono 16-bit PCM (base64) with the given model.
#[tauri::command]
async fn stt_transcribe(app: AppHandle, model: String, pcm: String) -> AppResult<String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(pcm).map_err(|e| AppError::other(e.to_string()))?;
    let st = app.state::<AppState>();
    let (stt, root) = (st.stt.clone(), st.data_dir.join("stt"));
    tauri::async_runtime::spawn_blocking(move || stt.transcribe(&root, &model, &stt::pcm16_to_f32(&bytes), 16000))
        .await.map_err(|e| AppError::other(e.to_string()))?
}

#[tauri::command]
fn card_media_save(state: State<'_, AppState>, png_base64: String) -> AppResult<String> {
    use base64::Engine;
    let b = base64::engine::general_purpose::STANDARD.decode(png_base64.trim_start_matches("data:image/png;base64,")).map_err(|e| AppError::other(e.to_string()))?;
    cards::save_media(&state.data_dir.join("card-media"), &b)
}

#[derive(serde::Serialize, serde::Deserialize)]
struct StudyPlan { #[serde(default)] id: String, title: String, settings: serde_json::Value, days: serde_json::Value, #[serde(default = "yes")] active: bool, #[serde(default)] updated_at: String }
fn yes() -> bool { true }

#[tauri::command]
fn plans_list(state: State<'_, AppState>) -> AppResult<Vec<StudyPlan>> {
    state.db.with(|c| Ok(c.prepare("SELECT id, title, settings, days, active, updated_at FROM study_plans ORDER BY active DESC, created_at DESC")?
        .query_map([], |r| Ok(StudyPlan {
            id: r.get(0)?, title: r.get(1)?,
            settings: serde_json::from_str(&r.get::<_, String>(2)?).unwrap_or_default(),
            days: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or_default(),
            active: r.get::<_, i64>(4)? != 0, updated_at: r.get(5)?,
        }))?.collect::<Result<_, _>>()?))
}

#[tauri::command]
fn plans_save(state: State<'_, AppState>, plan: StudyPlan) -> AppResult<String> {
    let id = if plan.id.is_empty() { uuid::Uuid::new_v4().to_string() } else { plan.id.clone() };
    state.db.with(|c| Ok(c.execute(
        "INSERT INTO study_plans (id, title, settings, days, active) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, settings=excluded.settings, days=excluded.days, active=excluded.active, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        rusqlite::params![id, plan.title, plan.settings.to_string(), plan.days.to_string(), plan.active as i64]).map(|_| ())?))?;
    Ok(id)
}

#[tauri::command]
fn plans_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.db.with(|c| Ok(c.execute("DELETE FROM study_plans WHERE id = ?", [id]).map(|_| ())?))
}

#[tauri::command]
fn audiobook_cancel() { audiobook::cancel(); }

#[tauri::command]
fn audiobook_can_encode() -> bool { audiobook::can_encode() }

#[tauri::command]
fn audiobook_estimate(state: State<'_, AppState>, book_id: i64, chapters: Vec<audiobook::ChapterSpec>, speed: f32) -> AppResult<(usize, u64)> {
    audiobook::estimate(&state.db, book_id, &chapters, speed)
}

#[tauri::command]
fn tts_voices(state: State<'_, AppState>) -> Vec<tts::VoicePack> {
    tts::list(&state.data_dir.join("tts"))
}

#[tauri::command]
async fn tts_install(app: AppHandle, id: String) -> AppResult<()> {
    let root = app.state::<AppState>().data_dir.join("tts");
    tts::install(&app, &root, &id).await
}

#[tauri::command]
fn tts_uninstall(state: State<'_, AppState>, id: String) -> AppResult<()> {
    tts::uninstall(&state.data_dir.join("tts"), &id, &state.tts)
}

/// Returns base64 WAV.
#[tauri::command]
async fn tts_synth(app: AppHandle, voice: String, sid: i32, text: String, speed: f32) -> AppResult<String> {
    use base64::Engine;
    let st = app.state::<AppState>();
    let (tts, root) = (st.tts.clone(), st.data_dir.join("tts"));
    let wav = tauri::async_runtime::spawn_blocking(move || tts.synth(&root, &voice, sid, &text, speed))
        .await
        .map_err(|e| AppError::other(e.to_string()))??;
    Ok(base64::engine::general_purpose::STANDARD.encode(wav))
}

// ── Sync & backup ──────────────────────────────────────────

fn sync_config(db: &Db) -> cloudsync::SyncConfig {
    let mut c: cloudsync::SyncConfig = kv_get(db, "sync_config").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    // WebDAV password lives in the keychain.
    if let Some(storage::Target::Webdav { password, .. }) = c.target.as_mut() {
        *password = llm::get_key("webdav").unwrap_or_default();
    }
    c
}

#[tauri::command]
fn get_sync_config(state: State<'_, AppState>) -> cloudsync::SyncConfig {
    let mut c = sync_config(&state.db);
    if let Some(storage::Target::Webdav { password, .. }) = c.target.as_mut() {
        if !password.is_empty() { *password = "••••••••".into(); }
    }
    c
}

#[tauri::command]
fn save_sync_config(state: State<'_, AppState>, config: cloudsync::SyncConfig) -> AppResult<()> {
    let mut c = config;
    if let Some(storage::Target::Webdav { password, .. }) = c.target.as_mut() {
        if !password.is_empty() && password != "••••••••" { llm::set_key("webdav", Some(password))?; }
        password.clear();
    }
    kv_set(&state.db, "sync_config", &serde_json::to_string(&c)?)
}

#[tauri::command]
fn sync_status(state: State<'_, AppState>) -> Option<serde_json::Value> {
    kv_get(&state.db, "sync_status").and_then(|s| serde_json::from_str(&s).ok())
}

/// Target + encryption key (when enabled) → Store.
fn sync_store(cfg: &cloudsync::SyncConfig) -> AppResult<storage::Store> {
    let target = cfg.target.clone().ok_or_else(|| AppError::other("Choose a sync location first."))?;
    let key = if cfg.encrypted {
        Some(llm::get_key("sync-key").and_then(|h| crypto::key_from_hex(&h)).ok_or_else(|| AppError::other("Encryption is on but this device has no key yet. Enter the passphrase in Settings → Sync & backup."))?)
    } else { None };
    Ok(storage::Store { target, key })
}

/// Browser sign-in for Dropbox / OneDrive / Google Drive (PKCE, loopback redirect).
#[tauri::command]
async fn cloud_sign_in(app: AppHandle, cloud: cloud::Cloud, client_id: String, client_secret: Option<String>) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    if client_id.trim().is_empty() { return Err(AppError::other("Enter your app's client ID first (see the setup guide).")); }
    let opener = app.clone();
    cloud::sign_in(cloud, client_id.trim().to_string(), client_secret, move |url| { let _ = opener.opener().open_url(url, None::<&str>); }).await
}

#[tauri::command]
fn cloud_status(cloud: cloud::Cloud) -> bool {
    cloud::signed_in(cloud)
}

#[tauri::command]
fn cloud_sign_out(cloud: cloud::Cloud) -> AppResult<()> {
    cloud::sign_out(cloud)
}

// ── Integrations: KOReader + Readwise ──────────────────────

fn ko_config(db: &Db) -> integrations::KoConfig {
    kv_get(db, "koreader").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

#[tauri::command]
fn get_integrations(state: State<'_, AppState>) -> serde_json::Value {
    serde_json::json!({
        "koreader": ko_config(&state.db),
        "koreader_has_password": llm::get_key("koreader").is_some(),
        "readwise_has_token": llm::get_key("readwise").is_some(),
    })
}

#[tauri::command]
async fn save_koreader(state: State<'_, AppState>, config: integrations::KoConfig, password: Option<String>) -> AppResult<()> {
    if let Some(p) = password.filter(|p| !p.is_empty()) { integrations::store_password(&p)?; }
    kv_set(&state.db, "koreader", &serde_json::to_string(&config)?)?;
    if config.enabled { integrations::ko_check(&config).await?; }
    Ok(())
}

#[tauri::command]
async fn koreader_push(state: State<'_, AppState>, book_id: i64, percentage: f64, progress: String) -> AppResult<()> {
    let cfg = ko_config(&state.db);
    if !cfg.enabled { return Ok(()); }
    let doc = integrations::ko_document(&state.db, book_id)?;
    let dev = state.db.with(|c| cloudsync::device_id(c))?;
    integrations::ko_push(&cfg, &doc, percentage, &progress, &dev).await
}

#[tauri::command]
async fn koreader_pull(state: State<'_, AppState>, book_id: i64) -> AppResult<Option<integrations::KoProgress>> {
    let cfg = ko_config(&state.db);
    if !cfg.enabled { return Ok(None); }
    let doc = integrations::ko_document(&state.db, book_id)?;
    integrations::ko_pull(&cfg, &doc).await
}

#[tauri::command]
async fn save_readwise_token(token: String) -> AppResult<()> {
    integrations::readwise_check(token.trim()).await?;
    llm::set_key("readwise", Some(token.trim()))
}

#[tauri::command]
async fn readwise_export(state: State<'_, AppState>, book_id: Option<i64>) -> AppResult<usize> {
    integrations::readwise_export(&state.db, book_id).await
}

/// Turn on encryption with a passphrase: creates sync/crypto.json on a fresh target, or unlocks an existing one.
#[tauri::command]
async fn set_sync_passphrase(state: State<'_, AppState>, passphrase: String) -> AppResult<bool> {
    let mut cfg = sync_config(&state.db);
    let target = cfg.target.clone().ok_or_else(|| AppError::other("Choose a sync location first."))?;
    if passphrase.chars().count() < 8 { return Err(AppError::other("Use at least 8 characters.")); }
    let existing = target.get("sync/crypto.json").await?;
    let (key, created) = match existing {
        Some(bytes) => (crypto::unlock(&serde_json::from_slice(&bytes)?, &passphrase)?, false),
        None => {
            // Refuse to silently encrypt over an existing unencrypted library.
            if !target.list("sync/devices").await?.is_empty() {
                return Err(AppError::other("This location already has unencrypted sync data. Choose an empty folder for encrypted sync."));
            }
            let (h, key) = crypto::new_header(&passphrase)?;
            target.put("sync/crypto.json", serde_json::to_vec_pretty(&h)?).await?;
            (key, true)
        }
    };
    llm::set_key("sync-key", Some(&crypto::key_to_hex(&key)))?;
    cfg.encrypted = true;
    kv_set(&state.db, "sync_config", &serde_json::to_string(&cfg)?)?;
    Ok(created)
}

async fn do_sync(app: &AppHandle) -> AppResult<cloudsync::SyncReport> {
    let state = app.state::<AppState>();
    let cfg = sync_config(&state.db);
    let target = sync_store(&cfg)?;
    let res = cloudsync::run(&state.db, &target, &cfg, &downloads::download_dir(&state.db), Some(&state.data_dir.join("card-media"))).await;
    let report = match &res {
        Ok(r) => r.clone(),
        Err(e) => cloudsync::SyncReport { at: chrono::Utc::now().to_rfc3339(), error: Some(e.to_string()), ..Default::default() },
    };
    let _ = kv_set(&state.db, "sync_status", &serde_json::to_string(&report).unwrap_or_default());
    if report.applied + report.deleted + report.files_down > 0 {
        let _ = app.emit("library_changed", ());
    }
    let _ = app.emit("sync_status", &report);
    res
}

#[tauri::command]
async fn sync_now(app: AppHandle) -> AppResult<cloudsync::SyncReport> {
    do_sync(&app).await
}

#[tauri::command]
async fn backup_now(app: AppHandle) -> AppResult<String> {
    let state = app.state::<AppState>();
    let cfg = sync_config(&state.db);
    let target = sync_store(&cfg)?;
    let name = backup::backup(&state.db, &state.data_dir, &target, cfg.backup_keep.max(1)).await?;
    kv_set(&state.db, "last_backup", &chrono::Local::now().date_naive().to_string())?;
    Ok(name)
}

#[tauri::command]
async fn list_backups(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    let cfg = sync_config(&state.db);
    let target = sync_store(&cfg)?;
    backup::list(&target).await
}

#[tauri::command]
async fn restore_backup(app: AppHandle, name: String) -> AppResult<()> {
    let state = app.state::<AppState>();
    let cfg = sync_config(&state.db);
    let target = sync_store(&cfg)?;
    backup::stage_restore(&target, &name, &state.data_dir).await?;
    app.restart();
}

/// Background: sync every 10 minutes (when enabled) and a daily backup (when enabled).
fn start_sync_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        loop {
            let (cfg, last_backup) = {
                let st = app.state::<AppState>();
                (sync_config(&st.db), kv_get(&st.db, "last_backup"))
            };
            if cfg.enabled && cfg.target.is_some() {
                if let Err(e) = do_sync(&app).await { eprintln!("[Sync] {e}"); }
            }
            let today = chrono::Local::now().date_naive().to_string();
            if cfg.backup_daily && cfg.target.is_some() && last_backup.as_deref() != Some(today.as_str()) {
                if let Err(e) = backup_now(app.clone()).await { eprintln!("[Backup] {e}"); }
            }
            tokio::time::sleep(std::time::Duration::from_secs(600)).await;
        }
    });
}

// ── Connector + cite palette ───────────────────────────────

#[tauri::command]
fn get_connector_config(state: State<'_, AppState>) -> ConnectorConfig {
    connector_config(&state.db)
}

#[tauri::command]
fn save_connector_config(app: AppHandle, state: State<'_, AppState>, config: ConnectorConfig, regenerate_token: bool) -> AppResult<ConnectorConfig> {
    let mut c = config;
    if regenerate_token { c.token = uuid::Uuid::new_v4().simple().to_string(); }
    kv_set(&state.db, "connector", &serde_json::to_string(&c)?)?;
    start_connector(&app, &state);
    register_cite_shortcut(&app, &c);
    Ok(c)
}

fn register_cite_shortcut(app: &AppHandle, cfg: &ConnectorConfig) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let Some(sc) = cfg.cite_shortcut.clone().filter(|s| !s.is_empty()) else { return };
    let app2 = app.clone();
    if let Err(e) = gs.on_shortcut(sc.as_str(), move |_app, _sc, ev| {
        if ev.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
            open_cite_window(&app2);
        }
    }) {
        eprintln!("[Cite] shortcut {sc} failed: {e}");
    }
}

fn open_cite_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("cite") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.emit("cite_open", ());
        return;
    }
    let _ = tauri::WebviewWindowBuilder::new(app, "cite", tauri::WebviewUrl::App("index.html#cite".into()))
        .title("Cite")
        .inner_size(560.0, 420.0)
        .always_on_top(true)
        .resizable(true)
        .center()
        .build();
}

#[tauri::command]
fn show_cite_palette(app: AppHandle) {
    open_cite_window(&app);
}

/// Hide the palette and (optionally) paste into the app that was frontmost (macOS, needs Accessibility permission).
#[tauri::command]
fn cite_done(app: AppHandle, paste: bool) -> AppResult<()> {
    if let Some(w) = app.get_webview_window("cite") {
        let _ = w.hide();
    }
    #[cfg(target_os = "macos")]
    if paste {
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(250));
            let _ = std::process::Command::new("osascript").args(["-e", "tell application \"System Events\" to keystroke \"v\" using command down"]).status();
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = paste;
    Ok(())
}

#[tauri::command]
async fn csl_list_styles(state: State<'_, AppState>) -> AppResult<Vec<csl::StyleInfo>> {
    csl::list_styles(&state.data_dir.join("csl")).await
}

#[tauri::command]
async fn csl_get(state: State<'_, AppState>, kind: String, id: String) -> AppResult<String> {
    csl::get(&state.data_dir.join("csl"), &kind, &id).await
}

#[tauri::command]
async fn ocr_vision(png_base64: String, languages: Vec<String>, fast: Option<bool>) -> AppResult<Vec<ocr_vision::VisionWord>> {
    use base64::Engine;
    let png = base64::engine::general_purpose::STANDARD.decode(png_base64.split(',').last().unwrap_or("")).map_err(|e| AppError::other(e.to_string()))?;
    tauri::async_runtime::spawn_blocking(move || ocr_vision::recognize(&png, &languages, fast.unwrap_or(false)))
        .await
        .map_err(|e| AppError::other(e.to_string()))?
        .map_err(AppError::other)
}

/// Download a Tesseract language pack (traineddata.gz) into app data; returns its folder for tesseract.js `langPath`.
#[tauri::command]
async fn tesseract_lang(app: AppHandle, lang: String) -> AppResult<String> {
    if !lang.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') || lang.len() > 16 {
        return Err(AppError::other("invalid language code"));
    }
    let dir = app.state::<AppState>().data_dir.join("tesseract");
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(format!("{lang}.traineddata.gz"));
    if !file.exists() {
        let url = format!("https://cdn.jsdelivr.net/npm/@tesseract.js-data/{lang}/4.0.0_best_int/{lang}.traineddata.gz");
        let bytes = providers::http().get(url).timeout(std::time::Duration::from_secs(600)).send().await?.error_for_status()?.bytes().await?;
        std::fs::write(&file, &bytes)?;
    }
    allow_asset_dir(&app, &dir);
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn ocr_vision_languages() -> Vec<String> {
    ocr_vision::languages()
}

#[tauri::command]
fn save_ocr_page(state: State<'_, AppState>, book_id: i64, page: ocr::OcrPage) -> AppResult<()> {
    state.db.with(|c| ocr::save_page(c, book_id, &page))
}
#[tauri::command]
fn get_ocr_pages(state: State<'_, AppState>, book_id: i64) -> AppResult<Vec<ocr::OcrPage>> {
    state.db.with(|c| ocr::pages(c, book_id))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir().expect("no app data dir");
            backup::apply_pending_restore(&data_dir);
            let db = Db::open(&data_dir.join("library.sqlite3")).expect("failed to open database");
            // One-time-ish cleanup: fold "Save reference" entries into a later download of the same item.
            if let Ok(n) = db.with(|c| library::store::merge_reference_duplicates(c)) { if n > 0 { eprintln!("merged {n} reference duplicate(s)"); } }
            let state = AppState {
                db: db.clone(),
                data_dir: data_dir.clone(),
                watcher: library::watcher::LibraryWatcher::new(),
                providers: {
                    let r = providers::Registry::new(opds_catalogs(&db));
                    r.set_github(github_sources(&db), kv_get(&db, "github_token"));
                    r
                },
                downloader: downloads::Downloader::new(),
                llm: llm::Llm::default(),
                connector: connector::Connector::default(),
                tts: tts::Tts::default(),
                stt: stt::Stt::default(),
            };
            allow_asset_dir(app.handle(), &state.covers_dir());
            allow_asset_dir(app.handle(), &downloads::download_dir(&db));
            state.downloader.restore(app.handle(), &db);
            tracker::start(app.handle().clone(), db.clone());
            start_connector(app.handle(), &state);
            register_cite_shortcut(app.handle(), &connector_config(&db));
            start_sync_loop(app.handle().clone());
            if embed_config(&db).enabled { start_embed_worker(app.handle().clone()); }
            allow_book_paths(app.handle(), &db);
            state.watcher.restart(app.handle().clone(), db);
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_books, get_book, update_book, create_book, delete_book,
            list_watch_folders, add_watch_folder, remove_watch_folder, rescan_library, import_files,
            save_cover, mark_opened, unenriched_books, reset_enriched,
            list_collections, create_collection, rename_collection, move_collection, delete_collection, set_book_collection,
            list_tags, upsert_tag, update_tag, delete_tag, set_book_tag,
            list_saved_searches, save_search, delete_saved_search, list_authors,
            get_progress, save_progress, log_reading_session, reading_stats,
            list_annotations, upsert_annotation, delete_annotation,
            list_bookmarks, upsert_bookmark, delete_bookmark,
            list_notes, upsert_note, delete_note,
            index_book_text, unindexed_books, search_fulltext,
            write_text_file, write_binary_file,
            list_providers, provider_search, provider_details, provider_author, provider_fulltext, match_remote,
            list_opds_catalogs, save_opds_catalogs, get_github_config, save_github_config, opds_browse, save_remote_reference,
            enqueue_download, list_downloads, cancel_download, resume_download, clear_downloads, get_download_dir, set_download_dir,
            list_sync_queries, save_sync_query, delete_sync_query, run_sync_query, set_sync_ignored,
            detailed_stats, list_goals, save_goal, delete_goal, list_schedules, save_schedule, delete_schedule, get_kv, set_kv, test_notification, save_ocr_page, get_ocr_pages, ocr_vision, ocr_vision_languages, tesseract_lang, csl_list_styles, csl_get, tts_voices, tts_install, tts_uninstall, tts_synth, get_sync_config, save_sync_config, set_sync_passphrase, cloud_sign_in, cloud_status, cloud_sign_out, get_integrations, save_koreader, koreader_push, koreader_pull, save_readwise_token, readwise_export, sync_status, sync_now, backup_now, list_backups, restore_backup, get_connector_config, save_connector_config, show_cite_palette, cite_done,
            card_upsert, cards_due, cards_list, cards_counts, card_review, card_delete,
            llm_get_config, llm_save_config, llm_clear_key, llm_list_models, llm_agent, get_embed_config, save_embed_config, embed_status, embed_test, semantic_search, list_summaries, save_summary,
            delete_summary, range_text, audiobook_start, audiobook_cancel, audiobook_estimate, audiobook_can_encode, stt_models, stt_install, stt_uninstall, stt_transcribe, stt_record_start, stt_record_stop, card_media_save, plans_list, plans_save, plans_delete, llm_chat, llm_cancel, retrieve_passages, unit_text,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
