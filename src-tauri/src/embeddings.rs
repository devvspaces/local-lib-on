//! Semantic search: chunk indexed book text, embed it with the user's provider (Gemini or any
//! OpenAI-compatible /embeddings endpoint such as Ollama `nomic-embed-text`), and rank by cosine
//! similarity fused with BM25 (reciprocal-rank fusion).
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::llm;
use crate::reading::{self, Passage};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbedConfig {
    pub enabled: bool,
    /// "gemini" | "openai"
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub base_url: Option<String>,
}

/// Gemini embeddings are requested at this size (default would be 3,072 → 4× the storage for little gain).
pub const GEMINI_DIMS: usize = 768;

impl EmbedConfig {
    /// Identifies the vector space stored chunks belong to; changing provider/model/size re-embeds.
    pub fn key(&self) -> String {
        if self.provider == "gemini" { format!("gemini:{}@{GEMINI_DIMS}", self.model.trim_start_matches("models/")) } else { format!("{}:{}", self.provider, self.model) }
    }
}

// ── Background worker state (live status + wake-up) ──
#[derive(Debug, Clone, Default, Serialize)]
pub struct Live { pub current_book: Option<String>, pub last_error: Option<String>, pub retry_in: Option<u64> }
static LIVE: std::sync::Mutex<Live> = std::sync::Mutex::new(Live { current_book: None, last_error: None, retry_in: None });
static WAKE: std::sync::OnceLock<tokio::sync::Notify> = std::sync::OnceLock::new();
pub fn wake_notify() -> &'static tokio::sync::Notify { WAKE.get_or_init(tokio::sync::Notify::new) }
/// Wake the worker early (config saved, key added…).
pub fn wake() { wake_notify().notify_waiters(); }
pub fn set_live(f: impl FnOnce(&mut Live)) { if let Ok(mut l) = LIVE.lock() { f(&mut l); } }
pub fn live() -> Live { LIVE.lock().map(|l| l.clone()).unwrap_or_default() }

/// Sleep, but return early when woken.
pub async fn nap(secs: u64) {
    tokio::select! { _ = tokio::time::sleep(std::time::Duration::from_secs(secs)) => {}, _ = wake_notify().notified() => {} }
}

/// Is this a rate-limit / overload error worth retrying, and after how long? Reads Gemini's `retryDelay`.
pub fn retry_delay(err: &str) -> Option<u64> {
    let e = err.to_ascii_lowercase();
    if !(e.contains("429") || e.contains("resource_exhausted") || e.contains("503") || e.contains("rate") || e.contains("overloaded") || e.contains("unavailable")) { return None; }
    let secs = err.split("retryDelay").nth(1)
        .and_then(|t| t.chars().skip_while(|c| !c.is_ascii_digit()).take_while(|c| c.is_ascii_digit()).collect::<String>().parse::<u64>().ok());
    Some(secs.unwrap_or(30).clamp(5, 300))
}

impl Default for EmbedConfig {
    fn default() -> Self { Self { enabled: false, provider: "openai".into(), model: "nomic-embed-text".into(), base_url: Some("http://localhost:11434/v1".into()) } }
}

pub fn chunk_text(text: &str, size: usize) -> Vec<String> {
    let clean = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.len() <= size { return if clean.trim().is_empty() { vec![] } else { vec![clean] }; }
    let mut out = vec![];
    let mut cur = String::new();
    for sentence in clean.split_inclusive(&['.', '!', '?'][..]) {
        if cur.len() + sentence.len() > size && !cur.is_empty() {
            out.push(cur.trim().to_string());
            // ~15% overlap keeps ideas that straddle a boundary findable.
            let tail: String = cur.chars().rev().take(size / 7).collect::<Vec<_>>().into_iter().rev().collect();
            cur = tail;
        }
        cur.push_str(sentence);
        while cur.len() > size * 2 {
            let cut = cur.char_indices().nth(size).map(|(i, _)| i).unwrap_or(cur.len());
            out.push(cur[..cut].trim().to_string());
            cur = cur[cut..].to_string();
        }
    }
    if !cur.trim().is_empty() { out.push(cur.trim().to_string()); }
    out
}

pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let (mut dot, mut na, mut nb) = (0f32, 0f32, 0f32);
    for (x, y) in a.iter().zip(b) { dot += x * y; na += x * x; nb += y * y; }
    if na == 0.0 || nb == 0.0 { 0.0 } else { dot / (na.sqrt() * nb.sqrt()) }
}

/// Reciprocal-rank fusion of several ranked lists of keys.
pub fn rrf<K: std::hash::Hash + Eq + Clone>(lists: &[Vec<K>], k: f32) -> Vec<K> {
    let mut score: HashMap<K, f32> = HashMap::new();
    for l in lists { for (r, key) in l.iter().enumerate() { *score.entry(key.clone()).or_default() += 1.0 / (k + r as f32 + 1.0); } }
    let mut v: Vec<(K, f32)> = score.into_iter().collect();
    v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    v.into_iter().map(|x| x.0).collect()
}

fn to_blob(v: &[f32]) -> Vec<u8> { v.iter().flat_map(|f| f.to_le_bytes()).collect() }
fn from_blob(b: &[u8]) -> Vec<f32> { b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect() }

pub async fn embed(cfg: &EmbedConfig, texts: &[String], query: bool) -> AppResult<Vec<Vec<f32>>> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(120)).build().unwrap();
    match cfg.provider.as_str() {
        "gemini" => {
            let key = llm::get_key("gemini").ok_or_else(|| AppError::other("Save a Gemini API key in Settings → AI to use Gemini embeddings."))?;
            let model = cfg.model.trim_start_matches("models/");
            let task = if query { "RETRIEVAL_QUERY" } else { "RETRIEVAL_DOCUMENT" };
            let body = json!({"requests": texts.iter().map(|t| json!({"model": format!("models/{model}"), "content": {"parts": [{"text": t}]}, "taskType": task, "outputDimensionality": GEMINI_DIMS})).collect::<Vec<_>>()});
            let r = client.post(format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:batchEmbedContents")).header("x-goog-api-key", key).json(&body).send().await?;
            if !r.status().is_success() { return Err(AppError::other(format!("Gemini embeddings {}: {}", r.status(), r.text().await.unwrap_or_default()))); }
            let j: serde_json::Value = r.json().await?;
            Ok(j["embeddings"].as_array().into_iter().flatten().map(|e| e["values"].as_array().into_iter().flatten().filter_map(|x| x.as_f64()).map(|x| x as f32).collect()).collect())
        }
        _ => {
            let base = cfg.base_url.clone().filter(|b| !b.is_empty()).unwrap_or_else(|| "https://api.openai.com/v1".into());
            let mut req = client.post(format!("{}/embeddings", base.trim_end_matches('/'))).json(&json!({"model": cfg.model, "input": texts}));
            if let Some(k) = llm::get_key("openai") { req = req.bearer_auth(k); }
            let r = req.send().await?;
            if !r.status().is_success() { return Err(AppError::other(format!("{base} embeddings {}: {}", r.status(), r.text().await.unwrap_or_default()))); }
            let j: serde_json::Value = r.json().await?;
            let mut data: Vec<(i64, Vec<f32>)> = j["data"].as_array().into_iter().flatten().map(|d| (d["index"].as_i64().unwrap_or(0), d["embedding"].as_array().into_iter().flatten().filter_map(|x| x.as_f64()).map(|x| x as f32).collect())).collect();
            data.sort_by_key(|d| d.0);
            Ok(data.into_iter().map(|d| d.1).collect())
        }
    }
}

/// Embed one not-yet-embedded book (all of its indexed units). Returns the book id done, if any.
pub async fn index_next_book(db: &Db, cfg: &EmbedConfig) -> AppResult<Option<i64>> {
    index_next_book_with(db, cfg, |texts| { let cfg = cfg.clone(); async move { embed(&cfg, &texts, false).await } }, |s| nap(s)).await
}

/// Resumable: chunks already stored for this book/model are kept and skipped (pieces are produced in a fixed
/// order and each batch is committed atomically), so a rate limit or restart continues where it stopped.
/// Rate limits are retried in place with the provider's suggested delay.
pub async fn index_next_book_with<E, EF, S, SF>(db: &Db, cfg: &EmbedConfig, embed_fn: E, sleep: S) -> AppResult<Option<i64>>
where E: Fn(Vec<String>) -> EF, EF: std::future::Future<Output = AppResult<Vec<Vec<f32>>>>, S: Fn(u64) -> SF, SF: std::future::Future<Output = ()> {
    let model = cfg.key();
    let next: Option<(i64, String)> = db.with(|c| Ok(c.query_row(
        "SELECT s.book_id, b.title FROM fts_state s JOIN books b ON b.id = s.book_id WHERE s.units > 0 AND NOT EXISTS (SELECT 1 FROM chunk_state cs WHERE cs.book_id = s.book_id AND cs.model = ?)
         ORDER BY b.last_opened_at DESC NULLS LAST LIMIT 1", [&model], |r| Ok((r.get(0)?, r.get(1)?))).optional()?))?;
    let Some((book, title)) = next else { set_live(|l| l.current_book = None); return Ok(None) };
    set_live(|l| l.current_book = Some(title));
    let units: Vec<(String, String)> = db.with(|c| Ok(c.prepare("SELECT loc, text FROM fts_pages WHERE book_id = ? ORDER BY rowid")?.query_map([book], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?))?;
    let mut pieces: Vec<(String, String)> = vec![];
    for (loc, text) in units { for ch in chunk_text(&text, 1200) { pieces.push((loc.clone(), ch)); } }
    let done: usize = db.with(|c| Ok(c.query_row("SELECT count(*) FROM chunks WHERE book_id = ? AND model = ?", params![book, model], |r| r.get::<_, i64>(0))?))? as usize;
    let mut backoff = 0u64;
    for batch in pieces[done.min(pieces.len())..].chunks(32) {
        let texts: Vec<String> = batch.iter().map(|p| p.1.clone()).collect();
        let vecs = loop {
            match embed_fn(texts.clone()).await {
                Ok(v) => { set_live(|l| { l.last_error = None; l.retry_in = None; }); break v; }
                Err(e) => {
                    let msg = e.to_string();
                    let Some(base) = retry_delay(&msg) else { return Err(e) };
                    backoff = if backoff == 0 { base } else { (backoff * 2).min(300).max(base) };
                    set_live(|l| { l.last_error = Some(format!("Rate limited by the provider, retrying in {backoff} s")); l.retry_in = Some(backoff); });
                    sleep(backoff).await;
                }
            }
        };
        backoff = 0;
        if vecs.len() != batch.len() { return Err(AppError::other("embedding count mismatch")); }
        db.with(|c| {
            let tx = c.transaction()?;
            for ((loc, text), v) in batch.iter().zip(vecs.iter()) {
                tx.execute("INSERT INTO chunks (book_id, loc, text, model, dim, vec) VALUES (?, ?, ?, ?, ?, ?)", params![book, loc, text, model, v.len() as i64, to_blob(v)])?;
            }
            tx.commit()?;
            Ok(())
        })?;
        sleep(0).await;
    }
    db.with(|c| Ok(c.execute("INSERT OR REPLACE INTO chunk_state (book_id, model, done_at) VALUES (?, ?, datetime('now'))", params![book, model]).map(|_| ())?))?;
    Ok(Some(book))
}

#[derive(Debug, Clone, Serialize)]
pub struct EmbedStatus { pub books_done: i64, pub books_total: i64, pub chunks: i64, pub current_book: Option<String>, pub last_error: Option<String> }

/// Nearest chunks by cosine similarity (brute force — fine for personal libraries).
pub fn nearest(db: &Db, model: &str, q: &[f32], book: Option<i64>, k: usize) -> AppResult<Vec<(f32, Passage)>> {
    db.with(|c| {
        let mut st = c.prepare("SELECT ch.book_id, b.title, ch.loc, ch.text, ch.vec FROM chunks ch JOIN books b ON b.id = ch.book_id WHERE ch.model = ?1 AND (?2 IS NULL OR ch.book_id = ?2)")?;
        let mut scored: Vec<(f32, Passage)> = st.query_map(params![model, book], |r| {
            let blob: Vec<u8> = r.get(4)?;
            Ok((cosine(q, &from_blob(&blob)), Passage { book_id: r.get(0)?, title: r.get(1)?, loc: r.get(2)?, text: r.get(3)? }))
        })?.collect::<Result<_, _>>()?;
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(k);
        Ok(scored)
    })
}

/// BM25 + vector search fused with RRF. Falls back to BM25 when embeddings are off or fail.
pub async fn hybrid(db: &Db, cfg: &EmbedConfig, query: &str, book: Option<i64>, k: usize) -> AppResult<Vec<Passage>> {
    let lexical = db.with(|c| reading::retrieve(c, query, book, (k * 2) as i64))?;
    if !cfg.enabled { return Ok(lexical.into_iter().take(k).collect()); }
    let qv = match embed(cfg, &[query.to_string()], true).await { Ok(mut v) if !v.is_empty() => v.remove(0), _ => return Ok(lexical.into_iter().take(k).collect()) };
    let semantic = nearest(db, &cfg.key(), &qv, book, k * 2)?;
    let key = |p: &Passage| (p.book_id, p.loc.clone(), p.text.chars().take(40).collect::<String>());
    let mut by_key: HashMap<(i64, String, String), Passage> = HashMap::new();
    let l1: Vec<_> = lexical.into_iter().map(|p| { let k = key(&p); by_key.insert(k.clone(), p); k }).collect();
    let l2: Vec<_> = semantic.into_iter().map(|(_, p)| { let k = key(&p); by_key.entry(k.clone()).or_insert(p); k }).collect();
    Ok(rrf(&[l1, l2], 60.0).into_iter().take(k).filter_map(|k| by_key.remove(&k)).collect())
}

pub fn status(db: &Db, cfg: &EmbedConfig) -> AppResult<EmbedStatus> {
    let model = cfg.key();
    let live = live();
    db.with(|c| Ok(EmbedStatus {
        books_done: c.query_row("SELECT count(*) FROM chunk_state WHERE model = ?", [&model], |r| r.get(0))?,
        books_total: c.query_row("SELECT count(*) FROM fts_state WHERE units > 0", [], |r| r.get(0))?,
        chunks: c.query_row("SELECT count(*) FROM chunks WHERE model = ?", [&model], |r| r.get(0))?,
        current_book: live.current_book,
        last_error: live.last_error,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunking_cosine_rrf() {
        let text = "One. Two is longer. ".repeat(200);
        let ch = chunk_text(&text, 300);
        assert!(ch.len() > 5 && ch.iter().all(|c| c.len() <= 650), "{}", ch.iter().map(|c| c.len()).max().unwrap());
        assert!((cosine(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-6);
        assert!(cosine(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
        let fused = rrf(&[vec!["a", "b", "c"], vec!["c", "a", "d"]], 60.0);
        assert_eq!(fused[0], "a");
        assert_eq!(fused.len(), 4);
        let v = vec![0.25f32, -1.5, 3.0];
        assert_eq!(from_blob(&to_blob(&v)), v);
    }

    #[test]
    fn nearest_ranks_by_similarity() {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            let b = crate::library::store::insert_book(c, "B", &[], None)?;
            for (loc, v) in [("p1", [1.0f32, 0.0]), ("p2", [0.7, 0.7]), ("p3", [0.0, 1.0])] {
                c.execute("INSERT INTO chunks (book_id, loc, text, model, dim, vec) VALUES (?, ?, 't', 'm', 2, ?)", params![b, loc, to_blob(&v)])?;
            }
            Ok(())
        }).unwrap();
        let r = nearest(&db, "m", &[0.0, 1.0], None, 2).unwrap();
        assert_eq!(r[0].1.loc, "p3");
        assert_eq!(r[1].1.loc, "p2");
    }

    #[test]
    fn retry_delay_parsing() {
        let body = r#"Gemini embeddings 429 Too Many Requests: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"42s"}]}}"#;
        assert_eq!(retry_delay(body), Some(42));
        assert_eq!(retry_delay("Gemini embeddings 503 Service Unavailable: overloaded"), Some(30));
        assert_eq!(retry_delay("Gemini embeddings 400 Bad Request: API key not valid"), None);
    }

    #[tokio::test]
    async fn indexing_resumes_and_retries_rate_limits() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            let b = crate::library::store::insert_book(c, "Database Internals", &[], None)?;
            for p in 1..=80 { c.execute("INSERT INTO fts_pages (text, book_id, loc) VALUES (?, ?, ?)", params![format!("page {p} about latches and b-trees"), b, format!("p{p}")])?; }
            c.execute("INSERT INTO fts_state (book_id, indexed_at, units) VALUES (?, 'now', 80)", [b])?;
            Ok(())
        }).unwrap();
        let cfg = EmbedConfig { enabled: true, provider: "gemini".into(), model: "gemini-embedding-001".into(), base_url: None };
        let calls = AtomicUsize::new(0);
        let count = |db: &Db| db.with(|c| Ok(c.query_row("SELECT count(*) FROM chunks", [], |r| r.get::<_, i64>(0))?)).unwrap();
        // Run 1: batch 2 is rate-limited once (retried in place), batch 3 fails hard → stops with 64 chunks kept.
        let r = index_next_book_with(&db, &cfg, |t| {
            let n = calls.fetch_add(1, Ordering::SeqCst);
            async move {
                match n { 1 => Err(AppError::other("429 RESOURCE_EXHAUSTED retryDelay 7s")), 3 => Err(AppError::other("network down")), _ => Ok(t.iter().map(|_| vec![1.0, 0.0]).collect()) }
            }
        }, |_| async {}).await;
        assert!(r.is_err());
        assert_eq!(count(&db), 64, "two batches committed (one after a retry)");
        // Run 2: continues from chunk 64 instead of starting over.
        let seen = AtomicUsize::new(0);
        let r = index_next_book_with(&db, &cfg, |t| { seen.fetch_add(t.len(), Ordering::SeqCst); async move { Ok(t.iter().map(|_| vec![1.0, 0.0]).collect()) } }, |_| async {}).await.unwrap();
        assert!(r.is_some());
        assert_eq!(seen.load(Ordering::SeqCst), 16, "only the remaining 16 pieces are embedded");
        assert_eq!(count(&db), 80);
        assert_eq!(status(&db, &cfg).unwrap().books_done, 1);
    }
}
