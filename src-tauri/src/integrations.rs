//! KOReader progress sync (kosync protocol) and Readwise highlight export.
use crate::db::Db;
use crate::error::{AppError, AppResult};
use md5::{Digest, Md5};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

// ── KOReader ───────────────────────────────────────────────

/// KOReader's "partial MD5" document id: MD5 over 1 KiB samples at offsets 0, 1024·4^0, 1024·4^1 … 1024·4^10,
/// stopping at end of file. Lets Local Lib and KOReader recognise the same file without hashing all of it.
pub fn partial_md5(path: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Md5::new();
    let mut buf = vec![0u8; 1024];
    for i in -1i32..=10 {
        let offset: u64 = if i < 0 { 0 } else { 1024u64 << (2 * i as u64) };
        f.seek(SeekFrom::Start(offset))?;
        let n = f.read(&mut buf)?;
        if n == 0 { break; }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KoConfig {
    pub enabled: bool,
    #[serde(default = "default_server")]
    pub server: String,
    pub username: String,
    #[serde(default)]
    pub device: String,
}
fn default_server() -> String { "https://sync.koreader.rocks".into() }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KoProgress { pub percentage: f64, pub progress: String, pub device: String, pub timestamp: i64 }

fn md5_hex(s: &str) -> String { Md5::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect() }

/// The kosync "key" is md5(password); we keep that (not the password) in the Keychain.
pub fn store_password(password: &str) -> AppResult<()> { crate::llm::set_key("koreader", Some(&md5_hex(password))) }

fn ko(cfg: &KoConfig, method: reqwest::Method, path: &str) -> AppResult<reqwest::RequestBuilder> {
    let key = crate::llm::get_key("koreader").ok_or_else(|| AppError::other("Enter your KOReader sync password in Settings → Integrations."))?;
    Ok(crate::providers::http()
        .request(method, format!("{}{}", cfg.server.trim_end_matches('/'), path))
        .header("Accept", "application/vnd.koreader.v1+json")
        .header("x-auth-user", &cfg.username)
        .header("x-auth-key", key))
}

pub async fn ko_check(cfg: &KoConfig) -> AppResult<()> {
    let r = ko(cfg, reqwest::Method::GET, "/users/auth")?.send().await?;
    if r.status().is_success() { Ok(()) } else { Err(AppError::other(format!("KOReader sync login failed ({})", r.status()))) }
}

pub async fn ko_push(cfg: &KoConfig, document: &str, percentage: f64, progress: &str, device_id: &str) -> AppResult<()> {
    let body = json!({"document": document, "progress": progress, "percentage": (percentage * 10000.0).round() / 10000.0, "device": if cfg.device.is_empty() { "Local Lib" } else { &cfg.device }, "device_id": device_id});
    ko(cfg, reqwest::Method::PUT, "/syncs/progress")?.json(&body).send().await?.error_for_status()?;
    Ok(())
}

pub async fn ko_pull(cfg: &KoConfig, document: &str) -> AppResult<Option<KoProgress>> {
    let r = ko(cfg, reqwest::Method::GET, &format!("/syncs/progress/{document}"))?.send().await?;
    if !r.status().is_success() { return Ok(None); }
    let j: Value = r.json().await.unwrap_or(Value::Null);
    let Some(p) = j["percentage"].as_f64() else { return Ok(None) };
    Ok(Some(KoProgress {
        percentage: p,
        progress: j["progress"].as_str().map(String::from).or_else(|| j["progress"].as_i64().map(|x| x.to_string())).unwrap_or_default(),
        device: j["device"].as_str().unwrap_or("").to_string(),
        timestamp: j["timestamp"].as_i64().unwrap_or(0),
    }))
}

/// Document id for a library book's primary file (cached in kv).
pub fn ko_document(db: &Db, book_id: i64) -> AppResult<String> {
    if let Some(d) = db.with(|c| Ok(c.query_row("SELECT value FROM kv WHERE key = 'kodoc:' || ?", [book_id], |r| r.get::<_, String>(0)).optional()?))? { return Ok(d); }
    let path: String = db.with(|c| Ok(c.query_row("SELECT path FROM files WHERE book_id = ? AND missing = 0 ORDER BY id LIMIT 1", [book_id], |r| r.get(0)).optional()?))?
        .ok_or_else(|| AppError::other("book has no local file"))?;
    let d = partial_md5(Path::new(&path))?;
    db.with(|c| Ok(c.execute("INSERT OR REPLACE INTO kv (key, value) VALUES ('kodoc:' || ?, ?)", params![book_id, d]).map(|_| ())?))?;
    Ok(d)
}

// ── Readwise ───────────────────────────────────────────────

pub fn readwise_payload(db: &Db, book_id: Option<i64>) -> AppResult<(Vec<String>, Value)> {
    let rows: Vec<(String, String, String, Option<String>, Option<String>, Option<String>, String, String)> = db.with(|c| Ok(c.prepare(
        "SELECT a.id, b.title, b.authors, a.text, a.comment, a.page_label, a.tags, a.created_at FROM annotations a JOIN books b ON b.id = a.book_id
         WHERE (?1 IS NULL OR a.book_id = ?1) AND a.text IS NOT NULL AND trim(a.text) != ''
           AND NOT EXISTS (SELECT 1 FROM kv WHERE kv.key = 'readwise:' || a.id)")?
        .query_map([book_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)))?
        .collect::<Result<_, _>>()?))?;
    let mut ids = vec![];
    let highlights: Vec<Value> = rows.into_iter().map(|(id, title, authors, text, comment, page, tags, at)| {
        ids.push(id);
        let authors: Vec<String> = serde_json::from_str(&authors).unwrap_or_default();
        let tags: Vec<String> = serde_json::from_str(&tags).unwrap_or_default();
        let note = [comment.unwrap_or_default(), tags.iter().map(|t| format!(".{}", t.replace(' ', "-"))).collect::<Vec<_>>().join(" ")].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join("\n");
        let mut h = json!({"text": text.unwrap_or_default().chars().take(8000).collect::<String>(), "title": title, "author": authors.join(", "), "source_type": "local_lib", "category": "books", "highlighted_at": at});
        if !note.is_empty() { h["note"] = json!(note); }
        if let Some(p) = page.and_then(|p| p.parse::<i64>().ok()) { h["location"] = json!(p); h["location_type"] = json!("page"); }
        h
    }).collect();
    Ok((ids, json!({"highlights": highlights})))
}

pub async fn readwise_export(db: &Db, book_id: Option<i64>) -> AppResult<usize> {
    let token = crate::llm::get_key("readwise").ok_or_else(|| AppError::other("Add your Readwise access token in Settings → Integrations."))?;
    let (ids, payload) = readwise_payload(db, book_id)?;
    if ids.is_empty() { return Ok(0); }
    let r = crate::providers::http().post("https://readwise.io/api/v2/highlights/").header("Authorization", format!("Token {token}")).json(&payload).send().await?;
    if !r.status().is_success() { return Err(AppError::other(format!("Readwise {}: {}", r.status(), r.text().await.unwrap_or_default()))); }
    db.with(|c| {
        let tx = c.transaction()?;
        for id in &ids { tx.execute("INSERT OR REPLACE INTO kv (key, value) VALUES ('readwise:' || ?, '1')", [id])?; }
        tx.commit()?;
        Ok(())
    })?;
    Ok(ids.len())
}

pub async fn readwise_check(token: &str) -> AppResult<()> {
    let r = crate::providers::http().get("https://readwise.io/api/v2/auth/").header("Authorization", format!("Token {token}")).send().await?;
    if r.status().as_u16() == 204 || r.status().is_success() { Ok(()) } else { Err(AppError::other("Readwise rejected that token")) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_md5_samples() {
        let dir = tempfile::tempdir().unwrap();
        // Small file: only offset 0 and 1024 are inside → md5(first 1024) ‖ md5-continue(rest).
        let p = dir.path().join("a.bin");
        let data: Vec<u8> = (0..3000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&p, &data).unwrap();
        let mut h = Md5::new();
        h.update(&data[0..1024]);
        h.update(&data[1024..2048]);
        let expect: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(partial_md5(&p).unwrap(), expect);
        // Offsets grow ×4 (4096 is past EOF here, so sampling stops).
        assert_eq!(md5_hex("abc"), "900150983cd24fb0d6963f7d28e17f72");
    }

    #[test]
    fn readwise_mapping_skips_exported() {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            let b = crate::library::store::insert_book(c, "Deep Work", &["Cal Newport".into()], None)?;
            for (id, text) in [("a1", "Focus is a skill"), ("a2", "Shallow work"), ("a3", "")] {
                c.execute("INSERT INTO annotations (id, book_id, kind, anchor, page_label, text, comment, tags) VALUES (?, ?, 'highlight', '{}', '12', ?, 'key idea', '[\"focus\"]')", params![id, b, text])?;
            }
            c.execute("INSERT INTO kv (key, value) VALUES ('readwise:a2', '1')", [])?;
            Ok(())
        }).unwrap();
        let (ids, p) = readwise_payload(&db, None).unwrap();
        assert_eq!(ids, vec!["a1"], "already-exported and empty highlights skipped");
        let h = &p["highlights"][0];
        assert_eq!(h["title"], "Deep Work");
        assert_eq!(h["author"], "Cal Newport");
        assert_eq!(h["location"], 12);
        assert_eq!(h["note"], "key idea\n.focus");
    }
}
