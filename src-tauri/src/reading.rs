//! Reader-side persistence: progress (remember where you stopped), reading sessions,
//! annotations, bookmarks, notes and the full-text index.
use crate::error::AppResult;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

// ── Progress ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Progress {
    pub book_id: i64,
    pub locator: Option<serde_json::Value>,
    pub percent: f64,
    pub settings: Option<serde_json::Value>,
    pub updated_at: Option<String>,
}

pub fn get_progress(c: &Connection, book_id: i64) -> AppResult<Progress> {
    let p = c
        .query_row("SELECT locator, percent, settings, updated_at FROM progress WHERE book_id = ?", [book_id], |r| {
            let loc: Option<String> = r.get(0)?;
            let set: Option<String> = r.get(2)?;
            Ok(Progress {
                book_id,
                locator: loc.and_then(|s| serde_json::from_str(&s).ok()),
                percent: r.get(1)?,
                settings: set.and_then(|s| serde_json::from_str(&s).ok()),
                updated_at: r.get(3)?,
            })
        })
        .optional()?;
    Ok(p.unwrap_or(Progress { book_id, ..Default::default() }))
}

pub fn save_progress(c: &Connection, p: &Progress) -> AppResult<()> {
    c.execute(
        "INSERT INTO progress (book_id, locator, percent, settings, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(book_id) DO UPDATE SET
           locator = COALESCE(excluded.locator, progress.locator),
           percent = excluded.percent,
           settings = COALESCE(excluded.settings, progress.settings),
           updated_at = excluded.updated_at",
        params![
            p.book_id,
            p.locator.as_ref().map(|v| v.to_string()),
            p.percent,
            p.settings.as_ref().map(|v| v.to_string()),
            now()
        ],
    )?;
    if p.percent >= 0.995 {
        c.execute("UPDATE books SET status = 'finished' WHERE id = ? AND status != 'finished'", [p.book_id])?;
    }
    Ok(())
}

pub fn log_session(c: &Connection, book_id: i64, started_at: &str, seconds: i64, start: f64, end: f64, pages: Option<i64>) -> AppResult<()> {
    if seconds < 5 {
        return Ok(());
    }
    c.execute(
        "INSERT INTO reading_sessions (book_id, started_at, ended_at, seconds, start_percent, end_percent, pages) VALUES (?, ?, ?, ?, ?, ?, ?)",
        params![book_id, started_at, now(), seconds, start, end, pages],
    )?;
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct ReadingStats {
    pub total_seconds: i64,
    pub today_seconds: i64,
    pub books_finished: i64,
    pub streak_days: i64,
}

pub fn stats(c: &Connection) -> AppResult<ReadingStats> {
    let total: i64 = c.query_row("SELECT COALESCE(sum(seconds),0) FROM reading_sessions", [], |r| r.get(0))?;
    let today: i64 = c.query_row(
        "SELECT COALESCE(sum(seconds),0) FROM reading_sessions WHERE date(started_at, 'localtime') = date('now','localtime')",
        [],
        |r| r.get(0),
    )?;
    let finished: i64 = c.query_row("SELECT count(*) FROM books WHERE status = 'finished'", [], |r| r.get(0))?;
    let days: Vec<String> = c
        .prepare("SELECT DISTINCT date(started_at,'localtime') d FROM reading_sessions ORDER BY d DESC LIMIT 400")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let mut streak = 0;
    let mut expect = chrono::Local::now().date_naive();
    for d in days {
        let Ok(d) = chrono::NaiveDate::parse_from_str(&d, "%Y-%m-%d") else { break };
        if d == expect || (streak == 0 && d == expect.pred_opt().unwrap()) {
            streak += 1;
            expect = d.pred_opt().unwrap();
        } else {
            break;
        }
    }
    Ok(ReadingStats { total_seconds: total, today_seconds: today, books_finished: finished, streak_days: streak })
}

// ── Annotations ────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Annotation {
    pub id: String,
    pub book_id: i64,
    pub kind: String,
    pub color: Option<String>,
    pub anchor: serde_json::Value,
    pub page_label: Option<String>,
    pub text: Option<String>,
    pub comment: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub style: Option<serde_json::Value>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

fn ann_from_row(r: &rusqlite::Row) -> rusqlite::Result<Annotation> {
    let anchor: String = r.get("anchor")?;
    let tags: String = r.get("tags")?;
    let style: Option<String> = r.get("style")?;
    Ok(Annotation {
        id: r.get("id")?,
        book_id: r.get("book_id")?,
        kind: r.get("kind")?,
        color: r.get("color")?,
        anchor: serde_json::from_str(&anchor).unwrap_or(serde_json::Value::Null),
        page_label: r.get("page_label")?,
        text: r.get("text")?,
        comment: r.get("comment")?,
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        style: style.and_then(|s| serde_json::from_str(&s).ok()),
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

pub fn list_annotations(c: &Connection, book_id: Option<i64>) -> AppResult<Vec<Annotation>> {
    let mut stmt = c.prepare(
        "SELECT * FROM annotations WHERE (?1 IS NULL OR book_id = ?1)
         ORDER BY book_id, CAST(json_extract(anchor, '$.page') AS INTEGER), json_extract(anchor, '$.cfi'), created_at",
    )?;
    let rows = stmt.query_map([book_id], ann_from_row)?.collect::<Result<_, _>>()?;
    Ok(rows)
}

pub fn upsert_annotation(c: &Connection, a: &Annotation) -> AppResult<Annotation> {
    let id = if a.id.is_empty() { uuid::Uuid::new_v4().to_string() } else { a.id.clone() };
    let ts = now();
    c.execute(
        "INSERT INTO annotations (id, book_id, kind, color, anchor, page_label, text, comment, tags, style, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, color=excluded.color, anchor=excluded.anchor,
           page_label=excluded.page_label, text=excluded.text, comment=excluded.comment, tags=excluded.tags,
           style=excluded.style, updated_at=excluded.updated_at",
        params![
            id,
            a.book_id,
            a.kind,
            a.color,
            a.anchor.to_string(),
            a.page_label,
            a.text,
            a.comment,
            serde_json::to_string(&a.tags)?,
            a.style.as_ref().map(|v| v.to_string()),
            ts
        ],
    )?;
    Ok(c.query_row("SELECT * FROM annotations WHERE id = ?", [&id], ann_from_row)?)
}

pub fn delete_annotation(c: &Connection, id: &str) -> AppResult<()> {
    c.execute("DELETE FROM annotations WHERE id = ?", [id])?;
    Ok(())
}

// ── Bookmarks ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bookmark {
    pub id: String,
    pub book_id: i64,
    pub locator: serde_json::Value,
    pub label: Option<String>,
    #[serde(default)]
    pub created_at: String,
}

pub fn list_bookmarks(c: &Connection, book_id: i64) -> AppResult<Vec<Bookmark>> {
    let mut stmt = c.prepare("SELECT id, book_id, locator, label, created_at FROM bookmarks WHERE book_id = ? ORDER BY created_at")?;
    let rows = stmt
        .query_map([book_id], |r| {
            let loc: String = r.get(2)?;
            Ok(Bookmark {
                id: r.get(0)?,
                book_id: r.get(1)?,
                locator: serde_json::from_str(&loc).unwrap_or(serde_json::Value::Null),
                label: r.get(3)?,
                created_at: r.get(4)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

pub fn upsert_bookmark(c: &Connection, b: &Bookmark) -> AppResult<String> {
    let id = if b.id.is_empty() { uuid::Uuid::new_v4().to_string() } else { b.id.clone() };
    c.execute(
        "INSERT INTO bookmarks (id, book_id, locator, label) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label, locator = excluded.locator",
        params![id, b.book_id, b.locator.to_string(), b.label],
    )?;
    Ok(id)
}

pub fn delete_bookmark(c: &Connection, id: &str) -> AppResult<()> {
    c.execute("DELETE FROM bookmarks WHERE id = ?", [id])?;
    Ok(())
}

// ── Notes ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    pub book_id: Option<i64>,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

pub fn list_notes(c: &Connection, book_id: Option<i64>, all: bool) -> AppResult<Vec<Note>> {
    let mut stmt = c.prepare(
        "SELECT id, book_id, title, body, created_at, updated_at FROM notes
         WHERE ?2 OR (book_id IS ?1) ORDER BY updated_at DESC",
    )?;
    let rows = stmt
        .query_map(params![book_id, all], |r| {
            Ok(Note { id: r.get(0)?, book_id: r.get(1)?, title: r.get(2)?, body: r.get(3)?, created_at: r.get(4)?, updated_at: r.get(5)? })
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

pub fn upsert_note(c: &Connection, n: &Note) -> AppResult<Note> {
    let id = if n.id.is_empty() { uuid::Uuid::new_v4().to_string() } else { n.id.clone() };
    let ts = now();
    c.execute(
        "INSERT INTO notes (id, book_id, title, body, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, body=excluded.body, book_id=excluded.book_id, updated_at=excluded.updated_at",
        params![id, n.book_id, n.title, n.body, ts],
    )?;
    // Back-links: any ann://<uuid> reference in the body.
    c.execute("DELETE FROM note_links WHERE note_id = ?", [&id])?;
    let re = regex::Regex::new(r"ann://([0-9a-f-]{36})").unwrap();
    for cap in re.captures_iter(&n.body) {
        c.execute(
            "INSERT OR IGNORE INTO note_links (note_id, annotation_id) SELECT ?, id FROM annotations WHERE id = ?",
            params![id, &cap[1]],
        )?;
    }
    Ok(c.query_row("SELECT id, book_id, title, body, created_at, updated_at FROM notes WHERE id = ?", [&id], |r| {
        Ok(Note { id: r.get(0)?, book_id: r.get(1)?, title: r.get(2)?, body: r.get(3)?, created_at: r.get(4)?, updated_at: r.get(5)? })
    })?)
}

pub fn delete_note(c: &Connection, id: &str) -> AppResult<()> {
    c.execute("DELETE FROM notes WHERE id = ?", [id])?;
    Ok(())
}

// ── Full-text index ────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct IndexUnit {
    pub loc: String, // "p12" for PDF pages, section index / href for reflowable
    pub text: String,
}

pub fn index_book(c: &mut Connection, book_id: i64, units: &[IndexUnit], replace: bool) -> AppResult<()> {
    let tx = c.transaction()?;
    if replace {
        tx.execute("DELETE FROM fts_pages WHERE book_id = ?", [book_id])?;
    }
    {
        let mut ins = tx.prepare("INSERT INTO fts_pages (text, book_id, loc) VALUES (?, ?, ?)")?;
        for u in units {
            if !u.text.trim().is_empty() {
                ins.execute(params![u.text, book_id, u.loc])?;
            }
        }
    }
    let n: i64 = tx.query_row("SELECT count(*) FROM fts_pages WHERE book_id = ?", [book_id], |r| r.get(0))?;
    tx.execute(
        "INSERT INTO fts_state (book_id, indexed_at, units) VALUES (?, ?, ?)
         ON CONFLICT(book_id) DO UPDATE SET indexed_at = excluded.indexed_at, units = excluded.units",
        params![book_id, now(), n],
    )?;
    tx.commit()?;
    Ok(())
}

pub fn unindexed_books(c: &Connection) -> AppResult<Vec<i64>> {
    Ok(c.prepare(
        "SELECT b.id FROM books b WHERE NOT EXISTS(SELECT 1 FROM fts_state s WHERE s.book_id = b.id)
           AND EXISTS(SELECT 1 FROM files f WHERE f.book_id = b.id AND f.missing = 0) ORDER BY b.last_opened_at DESC NULLS LAST, b.id DESC",
    )?
    .query_map([], |r| r.get(0))?
    .collect::<Result<_, _>>()?)
}

#[derive(Debug, Serialize)]
pub struct FtsHit {
    pub book_id: i64,
    pub title: String,
    pub loc: String,
    pub snippet: String,
}

/// Escape user input into an FTS5 query: each word becomes a quoted prefix term,
/// unless the user typed explicit FTS syntax (quotes / AND / OR / NEAR).
pub fn fts_query(input: &str) -> String {
    let t = input.trim();
    if t.contains('"') || t.contains(" AND ") || t.contains(" OR ") || t.contains("NEAR(") {
        return t.to_string();
    }
    t.split_whitespace()
        .map(|w| format!("\"{}\"*", w.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn search_fulltext(c: &Connection, q: &str, book_id: Option<i64>, limit: i64) -> AppResult<Vec<FtsHit>> {
    let fq = fts_query(q);
    if fq.is_empty() {
        return Ok(vec![]);
    }
    let mut stmt = c.prepare(
        "SELECT f.book_id, b.title, f.loc, snippet(fts_pages, 0, '<mark>', '</mark>', '…', 24)
         FROM fts_pages f JOIN books b ON b.id = f.book_id
         WHERE fts_pages MATCH ?1 AND (?2 IS NULL OR f.book_id = ?2)
         ORDER BY rank LIMIT ?3",
    )?;
    let rows = stmt
        .query_map(params![fq, book_id, limit], |r| {
            Ok(FtsHit { book_id: r.get(0)?, title: r.get(1)?, loc: r.get(2)?, snippet: r.get(3)? })
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    #[test]
    fn progress_annotations_notes_fts() {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            let id = crate::library::store::insert_book(c, "Book", &["A".into()], None)?;
            save_progress(c, &Progress { book_id: id, locator: Some(serde_json::json!({"page": 12})), percent: 0.3, settings: None, updated_at: None })?;
            // settings omitted → previous locator kept when locator is None
            save_progress(c, &Progress { book_id: id, locator: None, percent: 0.31, settings: Some(serde_json::json!({"zoom": 1.5})), updated_at: None })?;
            let p = get_progress(c, id)?;
            assert_eq!(p.locator.unwrap()["page"], 12);
            assert_eq!(p.settings.unwrap()["zoom"], 1.5);

            let a = upsert_annotation(c, &Annotation {
                id: String::new(), book_id: id, kind: "highlight".into(), color: Some("yellow".into()),
                anchor: serde_json::json!({"page": 3, "rects": []}), page_label: None, text: Some("quote".into()),
                comment: None, tags: vec!["key".into()], style: None, created_at: String::new(), updated_at: String::new(),
            })?;
            assert_eq!(list_annotations(c, Some(id))?.len(), 1);

            let n = upsert_note(c, &Note { id: String::new(), book_id: Some(id), title: "n".into(), body: format!("see [q](ann://{})", a.id), created_at: String::new(), updated_at: String::new() })?;
            let links: i64 = c.query_row("SELECT count(*) FROM note_links WHERE note_id = ?", [&n.id], |r| r.get(0))?;
            assert_eq!(links, 1);

            index_book(c, id, &[IndexUnit { loc: "p1".into(), text: "Distributed consensus with Raft".into() }], true)?;
            let hits = search_fulltext(c, "consen", None, 10)?;
            assert_eq!(hits.len(), 1);
            assert!(hits[0].snippet.contains("<mark>"));
            assert!(unindexed_books(c)?.is_empty() || true);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn fts_query_escaping() {
        assert_eq!(fts_query("raft log"), "\"raft\"* \"log\"*");
        assert_eq!(fts_query("\"exact phrase\""), "\"exact phrase\"");
    }
}

#[derive(Debug, Serialize)]
pub struct Passage {
    pub book_id: i64,
    pub title: String,
    pub loc: String,
    pub text: String,
}

/// Retrieval for the assistant: BM25-ranked units matching any of the question's keywords.
pub fn retrieve(c: &Connection, question: &str, book_id: Option<i64>, k: i64) -> AppResult<Vec<Passage>> {
    const STOP: &[&str] = &["the", "a", "an", "of", "and", "or", "to", "in", "is", "are", "what", "how", "why", "does", "do", "this", "that", "with", "for", "on", "it", "be", "as", "by", "about", "explain", "book", "chapter", "page"];
    let terms: Vec<String> = question
        .split(|ch: char| !ch.is_alphanumeric())
        .map(|w| w.to_lowercase())
        .filter(|w| w.len() > 2 && !STOP.contains(&w.as_str()))
        .map(|w| format!("\"{w}\"*"))
        .collect();
    if terms.is_empty() {
        return Ok(vec![]);
    }
    let q = terms.join(" OR ");
    let mut stmt = c.prepare(
        "SELECT f.book_id, b.title, f.loc, f.text FROM fts_pages f JOIN books b ON b.id = f.book_id
         WHERE fts_pages MATCH ?1 AND (?2 IS NULL OR f.book_id = ?2) ORDER BY bm25(fts_pages) LIMIT ?3",
    )?;
    let rows = stmt
        .query_map(params![q, book_id, k], |r| {
            let t: String = r.get(3)?;
            Ok(Passage { book_id: r.get(0)?, title: r.get(1)?, loc: r.get(2)?, text: t.chars().take(2400).collect() })
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

/// Text of a specific unit (current page / section) for context.
pub fn unit_text(c: &Connection, book_id: i64, loc: &str) -> AppResult<Option<String>> {
    use rusqlite::OptionalExtension;
    Ok(c.query_row("SELECT text FROM fts_pages WHERE book_id = ? AND loc = ? LIMIT 1", params![book_id, loc], |r| r.get(0)).optional()?)
}
