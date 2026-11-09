//! Download queue (ported from coursera-dl-gui's downloader): bounded concurrency, HTTP Range resume,
//! throttled progress events, then auto-import into the library with the provider's metadata.
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::library::models::BookPatch;
use crate::library::{scan, store};
use crate::providers::{RemoteBook, RemoteFile};
use futures_util::StreamExt;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio::sync::Semaphore;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadItem {
    pub id: String,
    pub provider: String,
    pub remote_id: String,
    pub url: String,
    pub title: String,
    pub format: String,
    pub dest: Option<String>,
    pub status: String,
    pub bytes: i64,
    pub total: Option<i64>,
    pub error: Option<String>,
    pub book_id: Option<i64>,
    pub created_at: String,
}

#[derive(Clone, Serialize)]
struct ProgressEvent<'a> {
    id: &'a str,
    status: &'a str,
    bytes: i64,
    total: Option<i64>,
    error: Option<&'a str>,
    book_id: Option<i64>,
}

#[derive(Clone)]
pub struct Downloader {
    sem: Arc<Semaphore>,
    cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    client: reqwest::Client,
}

pub fn sanitize_name(s: &str) -> String {
    let cleaned: String = s.chars().map(|c| if r#"/\:*?"<>|"#.contains(c) || c.is_control() { ' ' } else { c }).collect();
    let mut out = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if out.len() > 150 {
        out = out.chars().take(150).collect();
    }
    out.trim_end_matches('.').to_string()
}

pub fn file_name_for(b: &RemoteBook, format: &str) -> String {
    let author = b.authors.first().map(|a| a.name.as_str()).unwrap_or("");
    let year = b.year.map(|y| format!(" ({y})")).unwrap_or_default();
    let base = if author.is_empty() { format!("{}{year}", b.title) } else { format!("{author} - {}{year}", b.title) };
    format!("{}.{format}", sanitize_name(&base))
}

/// Avoid clobbering a different existing file: "name (2).pdf".
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    if !p.exists() {
        return p;
    }
    let (stem, ext) = name.rsplit_once('.').unwrap_or((name, ""));
    (2..).map(|i| dir.join(format!("{stem} ({i}).{ext}"))).find(|p| !p.exists()).unwrap()
}

pub fn download_dir(db: &Db) -> PathBuf {
    db.with(|c| Ok(c.query_row("SELECT value FROM kv WHERE key = 'download_dir'", [], |r| r.get::<_, String>(0)).optional()?))
        .ok()
        .flatten()
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("Books").join("Local Lib"))
}

impl Downloader {
    pub fn new() -> Self {
        Self { sem: Arc::new(Semaphore::new(3)), cancels: Default::default(), client: crate::providers::http() }
    }

    pub fn enqueue(&self, app: &AppHandle, db: &Db, book: &RemoteBook, file: &RemoteFile) -> AppResult<String> {
        let id = uuid::Uuid::new_v4().to_string();
        let dir = download_dir(db);
        std::fs::create_dir_all(&dir)?;
        let dest = unique_path(&dir, &file_name_for(book, &file.format));
        db.with(|c| {
            c.execute(
                "INSERT INTO downloads (id, provider, remote_id, url, title, format, dest, status, total, meta) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)",
                params![id, book.provider, book.id, file.url, book.title, file.format, dest.to_string_lossy(), file.size.map(|s| s as i64), serde_json::to_string(book)?],
            )?;
            Ok(())
        })?;
        self.spawn(app.clone(), db.clone(), id.clone());
        Ok(id)
    }

    pub fn resume(&self, app: &AppHandle, db: &Db, id: &str) -> AppResult<()> {
        db.with(|c| Ok(c.execute("UPDATE downloads SET status = 'queued', error = NULL WHERE id = ? AND status IN ('failed','cancelled','paused','queued','downloading')", [id])?))?;
        self.spawn(app.clone(), db.clone(), id.to_string());
        Ok(())
    }

    pub fn cancel(&self, db: &Db, id: &str, status: &str) -> AppResult<()> {
        if let Some(f) = self.cancels.lock().unwrap().get(id) {
            f.store(true, Ordering::SeqCst);
        }
        db.with(|c| Ok(c.execute("UPDATE downloads SET status = ? WHERE id = ? AND status IN ('queued','downloading')", params![status, id])?))?;
        Ok(())
    }

    /// Re-queue downloads interrupted by an app quit.
    pub fn restore(&self, app: &AppHandle, db: &Db) {
        let ids: Vec<String> = db
            .with(|c| Ok(c.prepare("SELECT id FROM downloads WHERE status IN ('queued','downloading')")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?))
            .unwrap_or_default();
        for id in ids {
            self.spawn(app.clone(), db.clone(), id);
        }
    }

    fn spawn(&self, app: AppHandle, db: Db, id: String) {
        let me = self.clone();
        let flag = Arc::new(AtomicBool::new(false));
        self.cancels.lock().unwrap().insert(id.clone(), flag.clone());
        tauri::async_runtime::spawn(async move {
            let _permit = me.sem.acquire().await;
            if flag.load(Ordering::SeqCst) {
                return;
            }
            let res = me.run(&app, &db, &id, &flag).await;
            if let Err(e) = res {
                let msg = e.to_string();
                let cancelled = flag.load(Ordering::SeqCst);
                let status = if cancelled {
                    db.with(|c| Ok(c.query_row("SELECT status FROM downloads WHERE id = ?", [&id], |r| r.get::<_, String>(0))?)).unwrap_or_else(|_| "cancelled".into())
                } else {
                    "failed".into()
                };
                let _ = db.with(|c| Ok(c.execute("UPDATE downloads SET status = ?, error = ? WHERE id = ?", params![status, if cancelled { None } else { Some(&msg) }, id])?));
                let _ = app.emit("download_progress", ProgressEvent { id: &id, status: &status, bytes: 0, total: None, error: Some(&msg), book_id: None });
            }
            me.cancels.lock().unwrap().remove(&id);
        });
    }

    async fn run(&self, app: &AppHandle, db: &Db, id: &str, cancel: &AtomicBool) -> AppResult<()> {
        let (url, dest, meta): (String, String, String) = db.with(|c| {
            Ok(c.query_row("SELECT url, dest, meta FROM downloads WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?)
        })?;
        let book: RemoteBook = serde_json::from_str(&meta)?;
        let part = PathBuf::from(format!("{dest}.part"));
        let existing = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);

        db.with(|c| Ok(c.execute("UPDATE downloads SET status = 'downloading' WHERE id = ?", [id])?))?;
        let mut req = self.client.get(&url).timeout(Duration::from_secs(60 * 60));
        if existing > 0 {
            req = req.header("Range", format!("bytes={existing}-"));
        }
        let resp = req.send().await?;
        let status = resp.status();
        if status.as_u16() == 416 {
            // Already complete.
        } else if !status.is_success() {
            return Err(AppError::other(format!("HTTP {status} for {url}")));
        }
        let resumed = status.as_u16() == 206;
        let ctype = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        if ctype.starts_with("text/html") {
            return Err(AppError::other("server returned a web page instead of a file (the item may require login or borrowing)"));
        }
        let total = resp.content_length().map(|l| l as i64 + if resumed { existing as i64 } else { 0 });
        let mut file = tokio::fs::OpenOptions::new().create(true).write(true).append(resumed).truncate(!resumed).open(&part).await?;
        let mut done: i64 = if resumed { existing as i64 } else { 0 };
        let mut last = Instant::now();
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            if cancel.load(Ordering::SeqCst) {
                file.flush().await?;
                return Err(AppError::other("cancelled"));
            }
            let chunk = chunk?;
            file.write_all(&chunk).await?;
            done += chunk.len() as i64;
            if last.elapsed() >= Duration::from_millis(150) {
                last = Instant::now();
                let _ = app.emit("download_progress", ProgressEvent { id, status: "downloading", bytes: done, total, error: None, book_id: None });
                let _ = db.with(|c| Ok(c.execute("UPDATE downloads SET bytes = ?, total = ? WHERE id = ?", params![done, total, id])?));
            }
        }
        file.flush().await?;
        drop(file);
        tokio::fs::rename(&part, &dest).await?;

        // Import into library + apply provider metadata + identifiers + cover.
        let path = PathBuf::from(&dest);
        let _ = app.asset_protocol_scope().allow_file(&path);
        let book_id = match scan::import_file(db, &path)? {
            Some(scan::ImportOutcome::Added(i) | scan::ImportOutcome::Moved(i) | scan::ImportOutcome::Duplicate(i) | scan::ImportOutcome::Unchanged(i)) => Some(i),
            None => None,
        };
        if let Some(bid) = book_id {
            db.with(|c| {
                store::update_book(c, bid, &patch_from_remote(&book))?;
                // Only skip the background metadata lookup when the provider gave us the essentials; thin sources
                // (e.g. a PDF in a GitHub repo) get the full Crossref / Open Library / cover pass automatically.
                if !thin_metadata(&book) {
                    c.execute("INSERT OR IGNORE INTO kv (key, value) VALUES ('enriched:' || ?, '1')", [bid])?;
                }
                store::add_identifier(c, bid, &book.provider, &book.id)?;
                // A "Save reference" entry for this same item becomes this book (notes, collections, tags move over).
                store::merge_reference_duplicates(c)?;
                Ok(())
            })?;
            if let Some(cover) = &book.cover_url {
                if let Ok(r) = self.client.get(cover).send().await.and_then(|r| r.error_for_status()) {
                    if let Ok(bytes) = r.bytes().await {
                        let dir = app.state::<crate::AppState>().data_dir.join("covers");
                        let _ = std::fs::create_dir_all(&dir);
                        let p = dir.join(format!("{bid}.jpg"));
                        if std::fs::write(&p, &bytes).is_ok() {
                            let _ = db.with(|c| store::set_cover(c, bid, &p.to_string_lossy()));
                        }
                    }
                }
            }
        }
        db.with(|c| Ok(c.execute("UPDATE downloads SET status = 'completed', bytes = ?, total = ?, book_id = ? WHERE id = ?", params![done, total.or(Some(done)), book_id, id])?))?;
        let _ = app.emit("download_progress", ProgressEvent { id, status: "completed", bytes: done, total: total.or(Some(done)), error: None, book_id });
        let _ = app.emit("library_changed", ());
        if thin_metadata(&book) { let _ = app.emit("enrich_requested", ()); }
        Ok(())
    }
}

/// Provider metadata too sparse to trust as final (no cover or no authors).
pub fn thin_metadata(b: &RemoteBook) -> bool { b.cover_url.is_none() || b.authors.is_empty() }

pub fn patch_from_remote(b: &RemoteBook) -> BookPatch {
    BookPatch {
        title: Some(b.title.clone()),
        subtitle: b.subtitle.clone(),
        authors: Some(b.authors.iter().map(|a| a.name.clone()).collect()),
        year: b.year,
        language: b.language.clone(),
        publisher: b.publisher.clone(),
        isbn: b.isbn.clone(),
        doi: b.doi.clone(),
        description: b.description.clone(),
        only_missing: false,
        ..Default::default()
    }
}

pub fn list(db: &Db) -> AppResult<Vec<DownloadItem>> {
    db.with(|c| {
        Ok(c.prepare("SELECT id, provider, remote_id, url, title, format, dest, status, bytes, total, error, book_id, created_at FROM downloads ORDER BY created_at DESC LIMIT 500")?
            .query_map([], |r| {
                Ok(DownloadItem {
                    id: r.get(0)?, provider: r.get(1)?, remote_id: r.get(2)?, url: r.get(3)?, title: r.get(4)?, format: r.get(5)?, dest: r.get(6)?,
                    status: r.get(7)?, bytes: r.get(8)?, total: r.get(9)?, error: r.get(10)?, book_id: r.get(11)?, created_at: r.get(12)?,
                })
            })?
            .collect::<Result<_, _>>()?)
    })
}

pub fn clear_finished(db: &Db) -> AppResult<()> {
    db.with(|c| Ok(c.execute("DELETE FROM downloads WHERE status IN ('completed','cancelled','failed')", []).map(|_| ())?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::AuthorRef;

    #[test]
    fn names() {
        let b = RemoteBook { title: "What/Is: Life?".into(), authors: vec![AuthorRef { name: "Erwin Schrödinger".into(), id: None }], year: Some(1944), ..Default::default() };
        assert_eq!(file_name_for(&b, "epub"), "Erwin Schrödinger - What Is Life (1944).epub");
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.pdf"), b"x").unwrap();
        assert_eq!(unique_path(dir.path(), "a.pdf").file_name().unwrap(), "a (2).pdf");
    }
}
